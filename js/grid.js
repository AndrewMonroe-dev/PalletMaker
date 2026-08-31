/* Top-down grid: drag cases/units onto a real-world-scale floor, stack by exact footprint match,
   snap to 1in, block on true overlap. Also supports grouping several stacks and freely rotating
   the group as a rigid unit (collision-checked via oriented-rectangle math, not axis-aligned boxes). */

const Grid = (() => {
  const SNAP_IN = 1;
  const PX_PER_IN_MAX = 40; // ceiling so a small floor doesn't get absurdly huge cells
  const MERGE_OVERLAP_FRACTION = 0.8; // how much of the footprint must overlap to count as "landed on it" and merge

  let state = null;
  let project = null;
  let scale = 1; // px per inch

  let selectedStackId = null;      // single ungrouped stack selected
  let multiSelectIds = new Set();  // ungrouped stack ids selected for grouping
  let selectedGroupId = null;      // a group selected

  let dragOp = null; // in-progress group move/rotate drag state
  let creatingNew = false; // true while the "create/import a project" form is forced open

  let undoStack = []; // per-active-project, in-memory only (not persisted, doesn't survive reload)
  let redoStack = [];
  const UNDO_LIMIT = 50;

  function init(appState) {
    state = appState;
    bindStaticListeners();
    loadActiveProject();
    clearHistory();
    render();
  }

  function bindStaticListeners() {
    document.getElementById('projectForm').addEventListener('submit', handleCreateProject);
    document.getElementById('btnCancelProjectForm').addEventListener('click', () => {
      creatingNew = false;
      render();
    });
    document.getElementById('projectSwitcher').addEventListener('change', handleSwitchProject);
    document.getElementById('btnNewProject').addEventListener('click', () => {
      creatingNew = true;
      document.getElementById('projectForm').reset();
      render();
    });
    document.getElementById('btnDeleteProject').addEventListener('click', handleDeleteProject);
    document.getElementById('btnExportProject').addEventListener('click', handleExportProject);
    document.getElementById('btnImportProject').addEventListener('change', handleImportProject);
    document.getElementById('btnUndo').addEventListener('click', undo);
    document.getElementById('btnRedo').addEventListener('click', redo);
    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    });
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (project && !creatingNew) renderCanvas();
      }, 150);
    });
  }

  // ---- Undo/redo (per active project, in-memory only) ----

  function snapshotProject() {
    return project ? JSON.parse(JSON.stringify(project)) : null;
  }

  function pushUndo(snap) {
    if (!snap) return;
    undoStack.push(snap);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
  }

  function clearHistory() {
    undoStack = [];
    redoStack = [];
  }

  function applyProjectSnapshot(snap) {
    const idx = state.projects.findIndex(p => p.id === snap.id);
    if (idx === -1) return;
    state.projects[idx] = snap;
    project = snap;
    selectedStackId = null;
    selectedGroupId = null;
    multiSelectIds.clear();
    saveState(state);
    render();
  }

  function undo() {
    if (!project || undoStack.length === 0) return;
    const prev = undoStack.pop();
    redoStack.push(snapshotProject());
    applyProjectSnapshot(prev);
  }

  function redo() {
    if (!project || redoStack.length === 0) return;
    const next = redoStack.pop();
    undoStack.push(snapshotProject());
    applyProjectSnapshot(next);
  }

  function loadActiveProject() {
    project = state.projects.find(p => p.id === state.activeProjectId) || null;
    if (project && !project.groups) project.groups = [];
    if (project && !project.imagePanels) project.imagePanels = [];
  }

  function handleCreateProject(e) {
    e.preventDefault();

    const form = document.getElementById('projectForm');
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const name = document.getElementById('pName').value.trim();
    const width = parseFloat(document.getElementById('pWidth').value);
    const depth = parseFloat(document.getElementById('pDepth').value);

    const newProject = {
      id: uid('project'),
      name,
      footprintWidth: width,
      footprintDepth: depth,
      stacks: [],
      groups: [],
      imagePanels: []
    };
    state.projects.push(newProject);
    state.activeProjectId = newProject.id;
    project = newProject;
    creatingNew = false;
    selectedStackId = null;
    selectedGroupId = null;
    multiSelectIds.clear();
    clearHistory();
    saveState(state);
    render();
  }

  function handleSwitchProject(e) {
    state.activeProjectId = e.target.value || null;
    loadActiveProject();
    creatingNew = false;
    selectedStackId = null;
    selectedGroupId = null;
    multiSelectIds.clear();
    clearHistory();
    saveState(state);
    render();
  }

  function handleDeleteProject() {
    if (!project) return;
    if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
    state.projects = state.projects.filter(p => p.id !== project.id);
    state.activeProjectId = null;
    project = null;
    selectedStackId = null;
    selectedGroupId = null;
    multiSelectIds.clear();
    clearHistory();
    saveState(state);
    render();
  }

  function handleExportProject() {
    if (!project) return;
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/[^a-z0-9\-_]+/gi, '_') || 'project'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleImportProject(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        if (!imported.footprintWidth || !imported.footprintDepth || !Array.isArray(imported.stacks)) {
          throw new Error('Not a recognizable PalletMaker project file.');
        }
        imported.id = uid('project');
        imported.groups = imported.groups || [];
        imported.imagePanels = imported.imagePanels || [];
        state.projects.push(imported);
        state.activeProjectId = imported.id;
        loadActiveProject();
        creatingNew = false;
        selectedStackId = null;
        selectedGroupId = null;
        multiSelectIds.clear();
        clearHistory();
        saveState(state);
        render();
      } catch (err) {
        alert(`Could not import that file: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function renderProjectToolbar() {
    const switcher = document.getElementById('projectSwitcher');
    switcher.innerHTML = '<option value="">-- No project --</option>';
    state.projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      switcher.appendChild(opt);
    });
    switcher.value = project ? project.id : '';

    document.getElementById('btnDeleteProject').classList.toggle('hidden', !project);
    document.getElementById('btnExportProject').classList.toggle('hidden', !project);
    document.getElementById('btnImportProjectLabel').classList.remove('hidden');
    document.getElementById('btnCancelProjectForm').classList.toggle('hidden', !project || !creatingNew);

    const undoBtn = document.getElementById('btnUndo');
    const redoBtn = document.getElementById('btnRedo');
    undoBtn.classList.toggle('hidden', !project);
    redoBtn.classList.toggle('hidden', !project);
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function render() {
    const noProjectEl = document.getElementById('gridNoProject');
    const workspaceEl = document.getElementById('gridWorkspace');

    renderProjectToolbar();

    if (!project || creatingNew) {
      noProjectEl.classList.remove('hidden');
      workspaceEl.classList.add('hidden');
      return;
    }

    noProjectEl.classList.add('hidden');
    workspaceEl.classList.remove('hidden');

    document.getElementById('gridProjectName').textContent = project.name;
    document.getElementById('gridProjectDims').textContent =
      `${project.footprintWidth}"W x ${project.footprintDepth}"D floor`;

    renderPalette();
    renderCanvas();
    renderSelection();
    renderTally();
  }

  function renderPalette() {
    const listEl = document.getElementById('gridPaletteList');
    listEl.innerHTML = '';

    ItemTypes.getAll().forEach(it => {
      it.palette.forEach(sw => {
        const chip = buildChip({
          kind: 'unit',
          itemTypeId: it.id,
          swatchId: sw.id,
          footprintW: it.width,
          footprintD: it.depth,
          swatch: sw,
          name: `${it.name} - ${sw.name}`,
          sub: 'unit'
        });
        listEl.appendChild(chip);
      });
    });

    Cases.getAll().forEach(c => {
      const it = ItemTypes.getItemType(c.itemTypeId);
      if (!it) return;
      const sw = it.palette.find(s => s.id === c.swatchId);
      const footprintW = c.cols * it.width;
      const footprintD = c.layers * it.depth;
      const chip = buildChip({
        kind: 'case',
        caseId: c.id,
        itemTypeId: it.id,
        swatchId: c.swatchId,
        footprintW, footprintD,
        swatch: sw,
        name: c.name,
        sub: `case, ${c.rows}x${c.cols}x${c.layers}`
      });
      listEl.appendChild(chip);
    });

    if (listEl.children.length === 0) {
      listEl.innerHTML = '<p class="empty-state">Create an item type or case first.</p>';
    }
  }

  function buildChip(payload) {
    const chip = document.createElement('div');
    chip.className = 'palette-chip';
    chip.draggable = true;

    const preview = document.createElement('div');
    preview.className = 'swatch-preview';
    if (payload.swatch) {
      preview.style.background = payload.swatch.image
        ? `url(${payload.swatch.image}) center/cover`
        : payload.swatch.color;
    }

    const text = document.createElement('div');
    text.className = 'chip-text';
    const nameEl = document.createElement('div');
    nameEl.className = 'chip-name';
    nameEl.textContent = payload.name;
    const subEl = document.createElement('div');
    subEl.className = 'chip-sub';
    subEl.textContent = `${payload.sub} - ${payload.footprintW.toFixed(1)}"x${payload.footprintD.toFixed(1)}"`;
    text.appendChild(nameEl);
    text.appendChild(subEl);

    chip.appendChild(preview);
    chip.appendChild(text);

    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/json', JSON.stringify(payload));
    });

    return chip;
  }

  function computeScale() {
    const wrap = document.querySelector('.grid-canvas-wrap');
    const availableWidth = Math.max(300, (wrap ? wrap.clientWidth : 800) - 32);
    const availableHeight = Math.max(300, window.innerHeight * 0.7);
    const w = project.footprintWidth;
    const d = project.footprintDepth;
    scale = Math.min(availableWidth / w, availableHeight / d, PX_PER_IN_MAX);
    return scale;
  }

  function renderCanvas() {
    const canvas = document.getElementById('gridCanvas');
    computeScale();
    canvas.style.width = `${project.footprintWidth * scale}px`;
    canvas.style.height = `${project.footprintDepth * scale}px`;
    canvas.style.backgroundSize = `${scale}px ${scale}px`;

    canvas.innerHTML = '';
    canvas.ondragover = (e) => e.preventDefault();
    canvas.ondrop = handleDrop;

    const ungroupedStacks = project.stacks.filter(s => !s.groupId);
    document.getElementById('gridHint').classList.toggle(
      'hidden', project.stacks.length > 0 || project.groups.length > 0
    );

    ungroupedStacks.forEach(stack => {
      canvas.appendChild(buildStackEl(stack));
    });

    project.groups.forEach(group => {
      const members = getGroupMembers(group);
      members.forEach(({ stack, worldCenter }) => {
        canvas.appendChild(buildGroupMemberEl(group, stack, worldCenter));
      });
      const handle = buildRotateHandleEl(group, members);
      if (handle) canvas.appendChild(handle);
    });
  }

  function buildStackEl(stack) {
    const el = document.createElement('div');
    const isMultiSelected = multiSelectIds.has(stack.id);
    el.className = 'grid-stack'
      + (stack.id === selectedStackId ? ' selected' : '')
      + (isMultiSelected ? ' selected' : '');
    el.style.left = `${stack.x * scale}px`;
    el.style.top = `${stack.y * scale}px`;
    el.style.width = `${stack.footprintW * scale}px`;
    el.style.height = `${stack.footprintD * scale}px`;

    applySwatchBackground(el, stack.items[stack.items.length - 1]);

    const badge = document.createElement('span');
    badge.className = 'stack-badge';
    badge.textContent = stack.items.length > 1 ? `x${stack.items.length}` : '1';
    el.appendChild(badge);

    el.addEventListener('mousedown', (e) => {
      if (e.shiftKey) return; // shift+click is for multi-select, not moving
      startStackMove(e, stack);
    });

    el.addEventListener('click', (e) => {
      if (e.shiftKey) {
        toggleMultiSelect(stack.id);
      } else {
        selectedStackId = stack.id;
        selectedGroupId = null;
        multiSelectIds.clear();
      }
      render();
    });

    return el;
  }

  function applySwatchBackground(el, topItem) {
    const sw = resolveSwatch(topItem.itemTypeId, topItem.swatchId);
    if (sw) {
      el.style.background = sw.image ? `url(${sw.image}) center/cover` : sw.color;
    }
  }

  function toggleMultiSelect(stackId) {
    selectedStackId = null;
    selectedGroupId = null;
    if (multiSelectIds.has(stackId)) multiSelectIds.delete(stackId);
    else multiSelectIds.add(stackId);
  }

  function resolveSwatch(itemTypeId, swatchId) {
    const it = ItemTypes.getItemType(itemTypeId);
    if (!it) return null;
    return it.palette.find(s => s.id === swatchId) || null;
  }

  function handleDrop(e) {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/json');
    if (!raw) return;
    const payload = JSON.parse(raw);

    const canvas = document.getElementById('gridCanvas');
    const rect = canvas.getBoundingClientRect();
    const dropXIn = (e.clientX - rect.left) / scale;
    const dropYIn = (e.clientY - rect.top) / scale;

    const footprintW = payload.footprintW;
    const footprintD = payload.footprintD;
    const { x, y } = snapToNeighborEdges(snap(dropXIn), snap(dropYIn), footprintW, footprintD, null);

    if (x < 0 || y < 0 || x + footprintW > project.footprintWidth || y + footprintD > project.footprintDepth) {
      alert('That placement goes outside the floor footprint.');
      return;
    }

    const newItem = {
      kind: payload.kind,
      itemTypeId: payload.itemTypeId,
      swatchId: payload.swatchId,
      caseId: payload.caseId || null
    };

    const droppedRect = { x, y, w: footprintW, d: footprintD };
    const droppedCorners = aabbCorners(x, y, footprintW, footprintD);

    const sameFootprintOverlap = project.stacks.find(s =>
      !s.groupId &&
      Math.abs(s.footprintW - footprintW) < 0.001 &&
      Math.abs(s.footprintD - footprintD) < 0.001 &&
      isMergeableOverlap(droppedRect, { x: s.x, y: s.y, w: s.footprintW, d: s.footprintD })
    );

    if (sameFootprintOverlap) {
      pushUndo(snapshotProject());
      sameFootprintOverlap.items.push(newItem);
      saveState(state);
      render();
      return;
    }

    if (collidesWithAnything(droppedCorners, { excludeStackId: null, excludeGroupId: null })) {
      alert('That overlaps an existing stack or group. Move it or pick a spot with room.');
      return;
    }

    pushUndo(snapshotProject());
    project.stacks.push({
      id: uid('stack'),
      x, y,
      footprintW, footprintD,
      items: [newItem],
      groupId: null
    });
    saveState(state);
    render();
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.d && a.y + a.d > b.y;
  }

  // "Landed on it" (should merge into a stack) vs. "just grazing it" (should be blocked as a
  // collision, or succeed as an independent adjacent placement if there's no overlap at all).
  // Same-footprint rects only, so either area works as the denominator.
  function isMergeableOverlap(a, b) {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y));
    const area = a.w * a.d;
    if (area <= 0) return false;
    return (ix * iy) / area >= MERGE_OVERLAP_FRACTION;
  }

  function snap(value) {
    return Math.max(0, Math.round(value / SNAP_IN) * SNAP_IN);
  }

  const EDGE_SNAP_TOLERANCE_IN = 2;

  // Axis-aligned rects of everything currently on the floor (ungrouped stacks, plus members of
  // any group that isn't meaningfully rotated), for edge-snapping. Ignores rotated groups --
  // snapping flush against an angled neighbor isn't a well-defined single position.
  function collectAxisAlignedRects(excludeStackId) {
    const list = [];
    project.stacks.filter(s => !s.groupId && s.id !== excludeStackId).forEach(s => {
      list.push({ x: s.x, y: s.y, w: s.footprintW, d: s.footprintD });
    });
    project.groups.forEach(g => {
      const angleNorm = ((g.angle % 360) + 360) % 360;
      if (angleNorm > 0.5 && angleNorm < 359.5) return;
      getGroupMembers(g).forEach(({ stack, worldCenter }) => {
        if (stack.id === excludeStackId) return;
        list.push({
          x: worldCenter.x - stack.footprintW / 2,
          y: worldCenter.y - stack.footprintD / 2,
          w: stack.footprintW,
          d: stack.footprintD
        });
      });
    });
    return list;
  }

  // If (x,y) is close to sitting flush against a neighbor's edge but not exactly on it, snap it
  // there -- turns "aimed close but missed by an inch" into a clean adjacent placement instead
  // of a rejected near-overlap or an awkward gap.
  function snapToNeighborEdges(x, y, w, d, excludeStackId) {
    const rects = collectAxisAlignedRects(excludeStackId);
    let best = null;

    rects.forEach(r => {
      const vOverlap = Math.min(y + d, r.y + r.d) - Math.max(y, r.y);
      if (vOverlap > 0) {
        const dRight = Math.abs(x - (r.x + r.w));
        if (dRight <= EDGE_SNAP_TOLERANCE_IN && (!best || dRight < best.dist)) {
          best = { dist: dRight, x: r.x + r.w, y };
        }
        const dLeft = Math.abs((x + w) - r.x);
        if (dLeft <= EDGE_SNAP_TOLERANCE_IN && (!best || dLeft < best.dist)) {
          best = { dist: dLeft, x: r.x - w, y };
        }
      }
      const hOverlap = Math.min(x + w, r.x + r.w) - Math.max(x, r.x);
      if (hOverlap > 0) {
        const dBelow = Math.abs(y - (r.y + r.d));
        if (dBelow <= EDGE_SNAP_TOLERANCE_IN && (!best || dBelow < best.dist)) {
          best = { dist: dBelow, x, y: r.y + r.d };
        }
        const dAbove = Math.abs((y + d) - r.y);
        if (dAbove <= EDGE_SNAP_TOLERANCE_IN && (!best || dAbove < best.dist)) {
          best = { dist: dAbove, x, y: r.y - d };
        }
      }
    });

    if (!best) return { x, y };
    return { x: snap(best.x), y: snap(best.y) };
  }

  // ---- Oriented rectangle geometry (used once anything is part of a rotated group) ----

  function rotatedCorners(cx, cy, halfW, halfD, angleDeg) {
    const a = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    return [
      [-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD]
    ].map(([dx, dy]) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }));
  }

  function aabbCorners(x, y, w, d) {
    return rotatedCorners(x + w / 2, y + d / 2, w / 2, d / 2, 0);
  }

  function axesOf(corners) {
    const axes = [];
    for (let i = 0; i < 2; i++) {
      const p1 = corners[i], p2 = corners[i + 1];
      const edge = { x: p2.x - p1.x, y: p2.y - p1.y };
      const len = Math.hypot(edge.x, edge.y) || 1;
      axes.push({ x: -edge.y / len, y: edge.x / len });
    }
    return axes;
  }

  function project1D(corners, axis) {
    let min = Infinity, max = -Infinity;
    corners.forEach(c => {
      const p = c.x * axis.x + c.y * axis.y;
      if (p < min) min = p;
      if (p > max) max = p;
    });
    return { min, max };
  }

  function obbOverlap(cornersA, cornersB) {
    const axes = [...axesOf(cornersA), ...axesOf(cornersB)];
    return axes.every(axis => {
      const pa = project1D(cornersA, axis);
      const pb = project1D(cornersB, axis);
      return pa.max > pb.min && pb.max > pa.min;
    });
  }

  function getGroupMembers(group) {
    const a = (group.angle * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    return group.memberIds.map(memberId => {
      const m = group.members[memberId];
      const stack = project.stacks.find(s => s.id === memberId);
      if (!stack) return null;
      const worldCenter = {
        x: group.centerX + m.dx * cos - m.dy * sin,
        y: group.centerY + m.dx * sin + m.dy * cos
      };
      return { stack, worldCenter, dx: m.dx, dy: m.dy };
    }).filter(Boolean);
  }

  function groupMemberCorners(group, member) {
    return rotatedCorners(
      member.worldCenter.x, member.worldCenter.y,
      member.stack.footprintW / 2, member.stack.footprintD / 2,
      group.angle
    );
  }

  function allOccupiedCorners(opts) {
    const excludeStackId = (opts && opts.excludeStackId) || null;
    const excludeGroupId = (opts && opts.excludeGroupId) || null;
    const list = [];

    project.stacks.filter(s => !s.groupId && s.id !== excludeStackId).forEach(s => {
      list.push(aabbCorners(s.x, s.y, s.footprintW, s.footprintD));
    });

    project.groups.filter(g => g.id !== excludeGroupId).forEach(g => {
      getGroupMembers(g).forEach(member => {
        list.push(groupMemberCorners(g, member));
      });
    });

    return list;
  }

  function collidesWithAnything(corners, opts) {
    return allOccupiedCorners(opts).some(other => obbOverlap(corners, other));
  }

  // ---- Grouping ----

  function handleGroupSelected() {
    if (multiSelectIds.size < 2) return;
    pushUndo(snapshotProject());
    const memberStacks = project.stacks.filter(s => multiSelectIds.has(s.id));

    const minX = Math.min(...memberStacks.map(s => s.x));
    const minY = Math.min(...memberStacks.map(s => s.y));
    const maxX = Math.max(...memberStacks.map(s => s.x + s.footprintW));
    const maxY = Math.max(...memberStacks.map(s => s.y + s.footprintD));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const members = {};
    memberStacks.forEach(s => {
      const stackCenterX = s.x + s.footprintW / 2;
      const stackCenterY = s.y + s.footprintD / 2;
      members[s.id] = { dx: stackCenterX - centerX, dy: stackCenterY - centerY };
      s.groupId = null; // set below once group id known
    });

    const group = {
      id: uid('group'),
      centerX, centerY, angle: 0,
      memberIds: memberStacks.map(s => s.id),
      members
    };

    memberStacks.forEach(s => { s.groupId = group.id; });
    project.groups.push(group);

    multiSelectIds.clear();
    selectedGroupId = group.id;
    saveState(state);
    render();
  }

  function handleUngroup(groupId) {
    const group = project.groups.find(g => g.id === groupId);
    if (!group) return;
    pushUndo(snapshotProject());

    getGroupMembers(group).forEach(({ stack, worldCenter }) => {
      // Flatten back to axis-aligned at the member's current visual center; rotation is a
      // group-only concept, so an ungrouped stack always renders square to the floor again.
      stack.x = snap(worldCenter.x - stack.footprintW / 2);
      stack.y = snap(worldCenter.y - stack.footprintD / 2);
      stack.groupId = null;
    });

    project.groups = project.groups.filter(g => g.id !== groupId);
    selectedGroupId = null;
    saveState(state);
    render();
  }

  function handleDeleteGroup(groupId) {
    if (!confirm('Delete this entire group and everything in it?')) return;
    pushUndo(snapshotProject());
    const memberIds = (project.groups.find(g => g.id === groupId) || {}).memberIds || [];
    project.stacks = project.stacks.filter(s => !memberIds.includes(s.id));
    project.groups = project.groups.filter(g => g.id !== groupId);
    selectedGroupId = null;
    saveState(state);
    render();
  }

  function setGroupAngle(groupId, angle) {
    const group = project.groups.find(g => g.id === groupId);
    if (!group) return;
    const normalized = ((angle % 360) + 360) % 360;
    const before = snapshotProject();
    const ok = tryApplyGroupTransform(group, group.centerX, group.centerY, normalized);
    if (ok) pushUndo(before);
  }

  function tryApplyGroupTransform(group, centerX, centerY, angle) {
    const prev = { centerX: group.centerX, centerY: group.centerY, angle: group.angle };
    group.centerX = centerX;
    group.centerY = centerY;
    group.angle = angle;

    const members = getGroupMembers(group);
    const outOfBounds = members.some(({ stack, worldCenter }) => {
      const corners = groupMemberCorners(group, { stack, worldCenter });
      return corners.some(c => c.x < 0 || c.y < 0 || c.x > project.footprintWidth || c.y > project.footprintDepth);
    });
    const collides = members.some(({ stack, worldCenter }) => {
      const corners = groupMemberCorners(group, { stack, worldCenter });
      return collidesWithAnything(corners, { excludeGroupId: group.id });
    });

    if (outOfBounds || collides) {
      group.centerX = prev.centerX;
      group.centerY = prev.centerY;
      group.angle = prev.angle;
      return false;
    }

    saveState(state);
    render();
    return true;
  }

  // ---- Group rendering ----

  function positionGroupMemberEl(el, stack, worldCenter, angle) {
    el.style.width = `${stack.footprintW * scale}px`;
    el.style.height = `${stack.footprintD * scale}px`;
    el.style.left = `${(worldCenter.x - stack.footprintW / 2) * scale}px`;
    el.style.top = `${(worldCenter.y - stack.footprintD / 2) * scale}px`;
    el.style.transform = `rotate(${angle}deg)`;
    el.style.transformOrigin = 'center';
  }

  function groupBoundingBox(group, members) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    members.forEach(({ stack, worldCenter }) => {
      groupMemberCorners(group, { stack, worldCenter }).forEach(c => {
        minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
        minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
      });
    });
    return { minX, minY, maxX, maxY };
  }

  function buildGroupMemberEl(group, stack, worldCenter) {
    const el = document.createElement('div');
    el.className = 'grid-stack' + (group.id === selectedGroupId ? ' selected' : '');
    el.dataset.stackId = stack.id;
    positionGroupMemberEl(el, stack, worldCenter, group.angle);

    applySwatchBackground(el, stack.items[stack.items.length - 1]);

    const badge = document.createElement('span');
    badge.className = 'stack-badge';
    badge.textContent = stack.items.length > 1 ? `x${stack.items.length}` : '1';
    el.appendChild(badge);

    el.addEventListener('mousedown', (e) => startGroupMove(e, group));
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedGroupId = group.id;
      selectedStackId = null;
      multiSelectIds.clear();
      render();
    });

    return el;
  }

  function buildRotateHandleEl(group, members) {
    if (group.id !== selectedGroupId || members.length === 0) return null;

    const { minX, minY, maxX } = groupBoundingBox(group, members);

    const handle = document.createElement('div');
    handle.className = 'group-rotate-handle';
    handle.style.left = `${((minX + maxX) / 2) * scale - 8}px`;
    handle.style.top = `${minY * scale - 28}px`;
    handle.title = 'Drag to rotate the group';
    handle.addEventListener('mousedown', (e) => startGroupRotate(e, group));
    return handle;
  }

  function startStackMove(e, stack) {
    e.preventDefault();
    e.stopPropagation();
    dragOp = {
      type: 'stack-move',
      stackId: stack.id,
      el: e.currentTarget,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startX: stack.x,
      startY: stack.y,
      beforeSnapshot: snapshotProject()
    };
  }

  function commitStackMove(stack, op) {
    const { x, y } = snapToNeighborEdges(
      snap(stack.x), snap(stack.y), stack.footprintW, stack.footprintD, stack.id
    );

    if (x < 0 || y < 0 || x + stack.footprintW > project.footprintWidth || y + stack.footprintD > project.footprintDepth) {
      stack.x = op.startX;
      stack.y = op.startY;
      alert('That placement goes outside the floor footprint. Reverted.');
      render();
      return;
    }

    const droppedRect = { x, y, w: stack.footprintW, d: stack.footprintD };

    const sameFootprintOverlap = project.stacks.find(s =>
      s.id !== stack.id && !s.groupId &&
      Math.abs(s.footprintW - stack.footprintW) < 0.001 &&
      Math.abs(s.footprintD - stack.footprintD) < 0.001 &&
      isMergeableOverlap(droppedRect, { x: s.x, y: s.y, w: s.footprintW, d: s.footprintD })
    );

    if (sameFootprintOverlap) {
      // Dropping onto a same-footprint stack merges into it, same as a fresh drag-drop from
      // the palette would -- lets you consolidate stacks by dragging one onto another.
      sameFootprintOverlap.items.push(...stack.items);
      project.stacks = project.stacks.filter(s => s.id !== stack.id);
      if (selectedStackId === stack.id) selectedStackId = sameFootprintOverlap.id;
      pushUndo(op.beforeSnapshot);
      saveState(state);
      render();
      return;
    }

    const droppedCorners = aabbCorners(x, y, stack.footprintW, stack.footprintD);
    if (collidesWithAnything(droppedCorners, { excludeStackId: stack.id, excludeGroupId: null })) {
      stack.x = op.startX;
      stack.y = op.startY;
      alert('That overlaps an existing stack or group. Reverted.');
      render();
      return;
    }

    stack.x = x;
    stack.y = y;
    pushUndo(op.beforeSnapshot);
    saveState(state);
    render();
  }

  function startGroupMove(e, group) {
    e.preventDefault();
    e.stopPropagation();
    dragOp = {
      type: 'move',
      groupId: group.id,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startCenterX: group.centerX,
      startCenterY: group.centerY,
      beforeSnapshot: snapshotProject(),
      memberEls: collectGroupMemberEls(group),
      handleEl: document.getElementById('gridCanvas').querySelector('.group-rotate-handle')
    };
  }

  function startGroupRotate(e, group) {
    e.preventDefault();
    e.stopPropagation();
    const canvas = document.getElementById('gridCanvas');
    const rect = canvas.getBoundingClientRect();
    dragOp = {
      type: 'rotate',
      groupId: group.id,
      canvasLeft: rect.left,
      canvasTop: rect.top,
      startAngle: group.angle,
      beforeSnapshot: snapshotProject(),
      memberEls: collectGroupMemberEls(group),
      handleEl: canvas.querySelector('.group-rotate-handle')
    };
  }

  function collectGroupMemberEls(group) {
    const canvas = document.getElementById('gridCanvas');
    const map = {};
    group.memberIds.forEach(stackId => {
      const el = canvas.querySelector(`.grid-stack[data-stack-id="${stackId}"]`);
      if (el) map[stackId] = el;
    });
    return map;
  }

  function liveRepositionGroup(group) {
    const members = getGroupMembers(group);
    members.forEach(({ stack, worldCenter }) => {
      const el = dragOp && dragOp.memberEls && dragOp.memberEls[stack.id];
      if (el) positionGroupMemberEl(el, stack, worldCenter, group.angle);
    });
    if (dragOp && dragOp.handleEl) {
      const { minX, minY, maxX } = groupBoundingBox(group, members);
      dragOp.handleEl.style.left = `${((minX + maxX) / 2) * scale - 8}px`;
      dragOp.handleEl.style.top = `${minY * scale - 28}px`;
    }
  }

  function handlePointerMove(e) {
    if (!dragOp || !project) return;

    if (dragOp.type === 'stack-move') {
      const stack = project.stacks.find(s => s.id === dragOp.stackId);
      if (!stack) { dragOp = null; return; }
      const dxPx = e.clientX - dragOp.startMouseX;
      const dyPx = e.clientY - dragOp.startMouseY;
      stack.x = dragOp.startX + dxPx / scale;
      stack.y = dragOp.startY + dyPx / scale;
      // Move the live element directly instead of tearing down/rebuilding the whole canvas on
      // every mousemove -- cheaper, and avoids replacing the element being dragged mid-drag.
      if (dragOp.el) {
        dragOp.el.style.left = `${stack.x * scale}px`;
        dragOp.el.style.top = `${stack.y * scale}px`;
      }
      return;
    }

    const group = project.groups.find(g => g.id === dragOp.groupId);
    if (!group) { dragOp = null; return; }

    if (dragOp.type === 'move') {
      const dxPx = e.clientX - dragOp.startMouseX;
      const dyPx = e.clientY - dragOp.startMouseY;
      group.centerX = dragOp.startCenterX + dxPx / scale;
      group.centerY = dragOp.startCenterY + dyPx / scale;
      liveRepositionGroup(group);
    } else if (dragOp.type === 'rotate') {
      const cx = dragOp.canvasLeft + group.centerX * scale;
      const cy = dragOp.canvasTop + group.centerY * scale;
      const angleRad = Math.atan2(e.clientY - cy, e.clientX - cx);
      group.angle = ((angleRad * 180) / Math.PI + 360) % 360;
      liveRepositionGroup(group);
    }
  }

  function handlePointerUp() {
    if (!dragOp || !project) { dragOp = null; return; }

    if (dragOp.type === 'stack-move') {
      const op = dragOp;
      dragOp = null;
      const stack = project.stacks.find(s => s.id === op.stackId);
      if (!stack) return;
      const moved = Math.abs(stack.x - op.startX) > 0.05 || Math.abs(stack.y - op.startY) > 0.05;
      if (!moved) {
        stack.x = op.startX;
        stack.y = op.startY;
        return;
      }
      commitStackMove(stack, op);
      return;
    }

    const group = project.groups.find(g => g.id === dragOp.groupId);
    const op = dragOp;
    dragOp = null;
    if (!group) return;

    // A plain click (mousedown+mouseup with no real drag) shouldn't count as a move/rotate --
    // no state actually changed, so committing here would pollute undo history and (since this
    // fires before the browser's own 'click' event) can race with the click listener that
    // handles selection.
    const moved = op.type === 'move' &&
      (Math.abs(group.centerX - op.startCenterX) > 0.05 || Math.abs(group.centerY - op.startCenterY) > 0.05);
    const rotated = op.type === 'rotate' && Math.abs(group.angle - op.startAngle) > 0.5;
    if (!moved && !rotated) {
      group.centerX = op.startCenterX !== undefined ? op.startCenterX : group.centerX;
      group.centerY = op.startCenterY !== undefined ? op.startCenterY : group.centerY;
      group.angle = op.startAngle !== undefined ? op.startAngle : group.angle;
      return;
    }

    const ok = tryApplyGroupTransform(group, group.centerX, group.centerY, group.angle);
    if (ok) {
      pushUndo(op.beforeSnapshot);
    } else {
      alert('That move/rotation would overlap something else or leave the floor. Reverted.');
    }
  }

  // ---- Selection panel ----

  function renderSelection() {
    const panel = document.getElementById('gridSelectionPanel');
    panel.innerHTML = '';

    if (multiSelectIds.size >= 1) {
      renderMultiSelectPanel(panel);
      return;
    }

    if (selectedGroupId) {
      renderGroupPanel(panel, selectedGroupId);
      return;
    }

    const stack = project.stacks.find(s => s.id === selectedStackId && !s.groupId);
    if (!stack) {
      panel.innerHTML = '<p class="empty-state">Click a stack on the floor to manage it. Shift+click multiple stacks to group them.</p>';
      return;
    }

    renderStackPanel(panel, stack);
  }

  function renderMultiSelectPanel(panel) {
    const wrap = document.createElement('div');
    wrap.className = 'selection-detail';
    const info = document.createElement('p');
    info.className = 'empty-state';
    info.textContent = `${multiSelectIds.size} stack(s) selected. Shift+click to add or remove more.`;
    wrap.appendChild(info);

    const btnRow = document.createElement('div');
    btnRow.className = 'form-actions';
    const groupBtn = document.createElement('button');
    groupBtn.type = 'button';
    groupBtn.className = 'btn-primary';
    groupBtn.textContent = `Group Selected (${multiSelectIds.size})`;
    groupBtn.disabled = multiSelectIds.size < 2;
    groupBtn.addEventListener('click', handleGroupSelected);
    btnRow.appendChild(groupBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn-secondary';
    clearBtn.textContent = 'Clear selection';
    clearBtn.addEventListener('click', () => { multiSelectIds.clear(); render(); });
    btnRow.appendChild(clearBtn);

    wrap.appendChild(btnRow);
    panel.appendChild(wrap);
  }

  function renderGroupPanel(panel, groupId) {
    const group = project.groups.find(g => g.id === groupId);
    if (!group) { panel.innerHTML = '<p class="empty-state">Click a stack on the floor to manage it.</p>'; return; }

    const detail = document.createElement('div');
    detail.className = 'selection-detail';

    const countRow = document.createElement('div');
    countRow.className = 'sel-row';
    countRow.innerHTML = `<span>Stacks in group</span><strong>${group.memberIds.length}</strong>`;
    detail.appendChild(countRow);

    const angleLabel = document.createElement('label');
    angleLabel.textContent = 'Angle (degrees)';
    angleLabel.style.display = 'flex';
    angleLabel.style.flexDirection = 'column';
    angleLabel.style.gap = '4px';
    angleLabel.style.fontSize = '0.85rem';
    angleLabel.style.color = 'var(--text-dim)';

    const angleInput = document.createElement('input');
    angleInput.type = 'number';
    angleInput.step = '1';
    angleInput.value = Math.round(group.angle);
    angleInput.addEventListener('change', () => {
      setGroupAngle(group.id, parseFloat(angleInput.value) || 0);
    });
    angleLabel.appendChild(angleInput);
    detail.appendChild(angleLabel);

    const hint = document.createElement('p');
    hint.className = 'empty-state';
    hint.textContent = 'Drag the group body to move it. Drag the small handle above it to rotate freely.';
    detail.appendChild(hint);

    const btnRow = document.createElement('div');
    btnRow.className = 'form-actions';

    const ungroupBtn = document.createElement('button');
    ungroupBtn.type = 'button';
    ungroupBtn.className = 'btn-secondary';
    ungroupBtn.textContent = 'Ungroup';
    ungroupBtn.addEventListener('click', () => handleUngroup(group.id));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-danger';
    deleteBtn.textContent = 'Delete group';
    deleteBtn.addEventListener('click', () => handleDeleteGroup(group.id));

    btnRow.appendChild(ungroupBtn);
    btnRow.appendChild(deleteBtn);
    detail.appendChild(btnRow);

    panel.appendChild(detail);
  }

  function renderStackPanel(panel, stack) {
    const detail = document.createElement('div');
    detail.className = 'selection-detail';

    const posRow = document.createElement('div');
    posRow.className = 'sel-row';
    posRow.innerHTML = `<span>Position</span><strong>${stack.x}", ${stack.y}"</strong>`;

    const dimRow = document.createElement('div');
    dimRow.className = 'sel-row';
    dimRow.innerHTML = `<span>Footprint</span><strong>${stack.footprintW.toFixed(1)}"x${stack.footprintD.toFixed(1)}"</strong>`;

    const countRow = document.createElement('div');
    countRow.className = 'sel-row';
    countRow.innerHTML = `<span>Items stacked</span><strong>${stack.items.length}</strong>`;

    const itemsList = document.createElement('div');
    itemsList.className = 'selection-items';
    stack.items.forEach((item, idx) => {
      const it = ItemTypes.getItemType(item.itemTypeId);
      const sw = resolveSwatch(item.itemTypeId, item.swatchId);
      const row = document.createElement('div');
      row.className = 'sel-item-row';
      const label = item.kind === 'case'
        ? (Cases.getCase(item.caseId) || {}).name || 'Case'
        : `${it ? it.name : '?'} - ${sw ? sw.name : '?'} (unit)`;
      row.innerHTML = `<span>${idx + 1}. ${label}</span>`;
      itemsList.appendChild(row);
    });

    const btnRow = document.createElement('div');
    btnRow.className = 'form-actions';

    const removeTopBtn = document.createElement('button');
    removeTopBtn.type = 'button';
    removeTopBtn.className = 'btn-secondary';
    removeTopBtn.textContent = 'Remove top item';
    removeTopBtn.addEventListener('click', () => {
      pushUndo(snapshotProject());
      stack.items.pop();
      if (stack.items.length === 0) {
        project.stacks = project.stacks.filter(s => s.id !== stack.id);
        selectedStackId = null;
      }
      saveState(state);
      render();
    });

    const deleteStackBtn = document.createElement('button');
    deleteStackBtn.type = 'button';
    deleteStackBtn.className = 'btn-danger';
    deleteStackBtn.textContent = 'Delete entire stack';
    deleteStackBtn.addEventListener('click', () => {
      if (!confirm('Remove this entire stack from the floor?')) return;
      pushUndo(snapshotProject());
      project.stacks = project.stacks.filter(s => s.id !== stack.id);
      selectedStackId = null;
      saveState(state);
      render();
    });

    btnRow.appendChild(removeTopBtn);
    btnRow.appendChild(deleteStackBtn);

    detail.appendChild(posRow);
    detail.appendChild(dimRow);
    detail.appendChild(countRow);
    detail.appendChild(itemsList);
    detail.appendChild(btnRow);
    panel.appendChild(detail);
  }

  // ---- Tally ----

  function computeTally() {
    const rows = {};

    project.stacks.forEach(stack => {
      stack.items.forEach(item => {
        let key, label, isCase, unitCost, unitRevenue;

        if (item.kind === 'case') {
          const c = Cases.getCase(item.caseId);
          const it = c ? ItemTypes.getItemType(c.itemTypeId) : null;
          if (!c || !it) {
            key = `missing-case-${item.caseId}`;
            label = '(deleted case)';
            isCase = true;
            unitCost = 0;
            unitRevenue = 0;
          } else {
            key = `case-${c.id}`;
            label = c.name;
            isCase = true;
            const costPerUnit = it.unitsPerCase > 0 ? it.costPerCase / it.unitsPerCase : 0;
            const marginFraction = Math.min(Math.max(it.marginPct, 0), 99.99) / 100;
            const retailPerUnit = marginFraction < 1 ? costPerUnit / (1 - marginFraction) : 0;
            const unitsInCase = c.rows * c.cols * c.layers;
            unitCost = costPerUnit * unitsInCase;
            unitRevenue = retailPerUnit * unitsInCase;
          }
        } else {
          const it = ItemTypes.getItemType(item.itemTypeId);
          const sw = it ? it.palette.find(s => s.id === item.swatchId) : null;
          if (!it) {
            key = `missing-item-${item.itemTypeId}`;
            label = '(deleted item type)';
            isCase = false;
            unitCost = 0;
            unitRevenue = 0;
          } else {
            key = `unit-${it.id}-${item.swatchId}`;
            label = `${it.name} - ${sw ? sw.name : '?'}`;
            isCase = false;
            const costPerUnit = it.unitsPerCase > 0 ? it.costPerCase / it.unitsPerCase : 0;
            const marginFraction = Math.min(Math.max(it.marginPct, 0), 99.99) / 100;
            const retailPerUnit = marginFraction < 1 ? costPerUnit / (1 - marginFraction) : 0;
            unitCost = costPerUnit;
            unitRevenue = retailPerUnit;
          }
        }

        if (!rows[key]) rows[key] = { label, isCase, count: 0, cost: 0, revenue: 0 };
        rows[key].count += 1;
        rows[key].cost += unitCost;
        rows[key].revenue += unitRevenue;
      });
    });

    return Object.values(rows);
  }

  function renderTally() {
    const panel = document.getElementById('gridTallyPanel');
    const rows = computeTally();

    if (rows.length === 0) {
      panel.innerHTML = '<p class="empty-state">Nothing placed on the floor yet.</p>';
      return;
    }

    let totalCost = 0, totalRevenue = 0;

    const table = document.createElement('table');
    table.className = 'tally-table';
    table.innerHTML = `
      <thead>
        <tr><th>Item</th><th>Type</th><th>Count</th><th>Cost</th><th>Revenue</th></tr>
      </thead>
      <tbody></tbody>
      <tfoot>
        <tr><td colspan="3">Total</td><td id="tallyTotalCost"></td><td id="tallyTotalRevenue"></td></tr>
      </tfoot>
    `;

    const tbody = table.querySelector('tbody');
    rows.forEach(r => {
      totalCost += r.cost;
      totalRevenue += r.revenue;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.label}</td>
        <td>${r.isCase ? 'Case' : 'Unit'}</td>
        <td>${r.count}</td>
        <td>$${r.cost.toFixed(2)}</td>
        <td>$${r.revenue.toFixed(2)}</td>
      `;
      tbody.appendChild(tr);
    });

    table.querySelector('#tallyTotalCost').textContent = `$${totalCost.toFixed(2)}`;
    table.querySelector('#tallyTotalRevenue').textContent = `$${totalRevenue.toFixed(2)}`;

    panel.innerHTML = '';
    panel.appendChild(table);
  }

  function refresh() {
    render();
  }

  function getActiveProject() {
    return project;
  }

  return { init, refresh, getActiveProject, getGroupMembers, resolveSwatch };
})();
