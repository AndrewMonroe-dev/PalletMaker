/* Top-down grid: drag cases/units onto a real-world-scale floor, snap to 1in, block on true
   overlap. A dropped item that fully covers a same-footprint target merges into its base column
   (e.g. another case of the same size). A dropped item smaller than its target becomes a
   "topper" -- an independently-positioned item resting on that stack's top surface, so several
   units can sit side by side on top of one case. Also supports grouping several stacks and freely
   rotating the group as a rigid unit (collision-checked via oriented-rectangle math). Toppers are
   one level deep only -- a topper can't have its own toppers. */

const Grid = (() => {
  const SNAP_IN = 1;
  const PX_PER_IN_MAX = 40; // ceiling so a small floor doesn't get absurdly huge cells
  const MERGE_OVERLAP_FRACTION = 0.8; // how much of the footprint must overlap to count as "landed on it" and merge
  const EDGE_SNAP_TOLERANCE_PX = 14; // screen pixels, not inches -- see edgeSnapToleranceIn() below
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 0.25;
  const PALLET_W = 48; // standard grocery pallet footprint, inches -- fixed, not user-editable
  const PALLET_D = 40;

  // A 1x1 transparent gif, used as a blank native drag image -- the snapped live preview drawn on
  // the canvas during dragover is the only "where will this land" indicator; the cursor itself
  // doesn't need its own second box.
  const BLANK_DRAG_IMAGE = new Image();
  BLANK_DRAG_IMAGE.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  let state = null;
  let project = null;
  let scale = 1; // px per inch
  let zoomLevel = 1; // user-controlled multiplier on top of the auto-fit scale; resets per project switch

  let selectedStackId = null;      // single ungrouped stack selected
  let selectedTopper = null;       // { stackId, topperId } selected
  let multiSelectIds = new Set();  // ungrouped stack ids selected for grouping
  let multiSelectTopperKeys = new Set(); // "stackId:topperId" keys for toppers selected for grouping
  let selectedGroupId = null;      // a group selected
  let selectedPalletId = null;     // a pallet footprint marker selected

  let dragOp = null; // in-progress group move/rotate drag state
  let creatingNew = false; // true while the "create/import a project" form is forced open

  let dragPreviewPayload = null; // the palette item currently being dragged over the canvas, if any
  let dragPreviewEl = null;      // the live size/position ghost box tracking it

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
    document.getElementById('btnPrintGrid').addEventListener('click', handlePrintGrid);
    document.getElementById('btnZoomIn').addEventListener('click', () => setZoom(zoomLevel + ZOOM_STEP));
    document.getElementById('btnZoomOut').addEventListener('click', () => setZoom(zoomLevel - ZOOM_STEP));
    document.getElementById('btnZoomReset').addEventListener('click', () => setZoom(1));
    document.getElementById('btnAddPallet').addEventListener('click', handleAddPallet);
    // Ctrl/Cmd+wheel over the canvas zooms the grid instead of the whole page, matching the
    // browser's own page-zoom gesture so it reads as familiar rather than a bespoke control.
    document.querySelector('.grid-canvas-wrap').addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoomAtPoint(zoomLevel + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), e.clientX, e.clientY);
    }, { passive: false });
    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    // A mouseup that lands outside the browser window (released over the taskbar, another app,
    // or after an alt-tab mid-drag) never reaches this page, which left dragOp stuck: the next
    // mouse movement anywhere kept dragging the item, and the 4-second autosave could then
    // persist a half-dragged, un-snapped position. Losing window focus is the reliable signal
    // that a drag can't be completed -- revert it cleanly instead.
    window.addEventListener('blur', cancelActiveDrag);
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

  // A snapshot is taken on EVERY mousedown on the floor (startStackMove/startGroupMove/etc. stash
  // a "before" copy in case the drag turns into a real commit) and on every mutation. A naive
  // JSON deep copy of the whole project included every image panel's full base64 photo -- a few
  // panels at phone-photo size meant megabytes of string copying per click, and up to 50 of
  // those copies held in the undo stack at once. That's a real, growing memory/CPU cost over a
  // long session and a strong candidate for "the grid stops working after a while." The photo
  // strings are immutable, so the snapshot only needs to deep-copy the layout data and can share
  // each panel's dataUrl by reference.
  function snapshotProject() {
    if (!project) return null;
    const panels = project.imagePanels || [];
    const copy = JSON.parse(JSON.stringify({ ...project, imagePanels: [] }));
    copy.imagePanels = panels.map(p => ({ ...p }));
    return copy;
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
    selectedTopper = null;
    selectedPalletId = null;
    multiSelectIds.clear(); multiSelectTopperKeys.clear();
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
    ensureToppersField(project);
    ensurePalletsField(project);
  }

  // Projects saved before pallet markers existed have no `pallets` array.
  function ensurePalletsField(proj) {
    if (!proj) return;
    if (!proj.pallets) proj.pallets = [];
  }

  // Projects saved before toppers existed have no `toppers` array on their stacks.
  function ensureToppersField(proj) {
    if (!proj) return;
    (proj.stacks || []).forEach(s => { if (!s.toppers) s.toppers = []; });
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
      imagePanels: [],
      pallets: []
    };
    state.projects.push(newProject);
    state.activeProjectId = newProject.id;
    project = newProject;
    creatingNew = false;
    selectedStackId = null;
    selectedGroupId = null;
    selectedTopper = null;
    selectedPalletId = null;
    multiSelectIds.clear(); multiSelectTopperKeys.clear();
    clearHistory();
    zoomLevel = 1;
    saveState(state);
    render();
  }

  function handleSwitchProject(e) {
    state.activeProjectId = e.target.value || null;
    loadActiveProject();
    creatingNew = false;
    selectedStackId = null;
    selectedGroupId = null;
    selectedTopper = null;
    selectedPalletId = null;
    multiSelectIds.clear(); multiSelectTopperKeys.clear();
    clearHistory();
    zoomLevel = 1;
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
    selectedTopper = null;
    selectedPalletId = null;
    multiSelectIds.clear(); multiSelectTopperKeys.clear();
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
        ensureToppersField(imported);
        ensurePalletsField(imported);
        state.projects.push(imported);
        state.activeProjectId = imported.id;
        loadActiveProject();
        creatingNew = false;
        selectedStackId = null;
        selectedGroupId = null;
    selectedTopper = null;
        selectedPalletId = null;
        multiSelectIds.clear(); multiSelectTopperKeys.clear();
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

    document.getElementById('btnPrintGrid').classList.toggle('hidden', !project);
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

    resyncActiveProjectFootprints();

    document.getElementById('gridProjectName').textContent = project.name;
    document.getElementById('gridProjectDims').textContent =
      `${project.footprintWidth}"W x ${project.footprintDepth}"D floor`;

    renderPalette();
    renderPalletList();
    renderCanvas();
    renderSelection();
    renderTally();
  }

  function renderPalletList() {
    const listEl = document.getElementById('gridPalletList');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (project.pallets.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No pallet markers yet.</p>';
      return;
    }

    project.pallets.forEach((pallet, i) => {
      const row = document.createElement('div');
      row.className = 'palette-chip' + (pallet.id === selectedPalletId ? ' selected' : '');
      row.style.cursor = 'pointer';

      const showCheckbox = document.createElement('input');
      showCheckbox.type = 'checkbox';
      showCheckbox.checked = pallet.visible;
      showCheckbox.title = 'Show this pallet marker on the floor';
      showCheckbox.addEventListener('click', (e) => e.stopPropagation());
      showCheckbox.addEventListener('change', () => setPalletVisible(pallet.id, showCheckbox.checked));

      const text = document.createElement('div');
      text.className = 'chip-text';
      text.innerHTML = `<span class="chip-name">Pallet ${i + 1}</span><span class="chip-sub">${PALLET_W}"x${PALLET_D}", ${Math.round(pallet.angle)}&deg;</span>`;

      row.appendChild(showCheckbox);
      row.appendChild(text);
      row.addEventListener('click', () => {
        selectedPalletId = pallet.id;
        selectedStackId = null;
        selectedGroupId = null;
        selectedTopper = null;
        multiSelectIds.clear(); multiSelectTopperKeys.clear();
        render();
      });
      listEl.appendChild(row);
    });
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
      preview.style.background = getSwatchFlatColor(payload.swatch);
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
      // Custom drag data (application/json) can't be read back during dragover -- browsers only
      // expose it on drop, for security. Stash it here instead so the live size/position preview
      // knows what's being dragged while it's still in the air.
      dragPreviewPayload = payload;

      // The browser's default drag image is a screenshot of the whole chip -- swatch, name, and
      // dimensions text. A same-size colored box following the cursor turned out to be its own
      // problem too: once it's over the canvas, the live snapped drop preview (updateDragPreview)
      // renders right next to it, and two boxes on screen at once reads as confusing rather than
      // helpful. Blank the drag image out entirely instead -- the snapped preview on the canvas is
      // the single source of truth for where/how big it'll land.
      e.dataTransfer.setDragImage(BLANK_DRAG_IMAGE, 0, 0);
    });
    chip.addEventListener('dragend', () => {
      dragPreviewPayload = null;
      removeDragPreview();
      // Safety net for the same repaint-suppression quirk renderAfterDrop() already works around:
      // on some browsers/machines a single requestAnimationFrame right after 'drop' can still land
      // before the native drag session has actually finished tearing down, so the deferred render
      // silently gets swallowed too -- this recurred after the initial single-rAF fix. 'dragend' is
      // the one event guaranteed to fire only once the whole drag session (source and target side)
      // is fully over, so re-rendering here as well guarantees the drop becomes visible regardless
      // of how long that teardown actually takes. A no-op re-render if renderAfterDrop() already
      // painted first.
      if (project) render();
    });

    return chip;
  }


  function setZoom(level) {
    zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
    if (project) renderCanvas();
    const levelEl = document.getElementById('gridZoomLevel');
    if (levelEl) levelEl.textContent = `${Math.round(zoomLevel * 100)}%`;
  }

  // Same as setZoom, but keeps the world point under (clientX, clientY) visually fixed on screen
  // instead of zooming around the wrap's top-left / whatever happens to be scrolled into view --
  // captures the mouse's offset into the (pre-zoom) canvas and the wrap's own scroll container,
  // then after the resize adjusts scrollLeft/scrollTop by exactly how far that same world point
  // moved on screen, so it lands back under the cursor.
  function setZoomAtPoint(level, clientX, clientY) {
    const wrap = document.querySelector('.grid-canvas-wrap');
    const canvas = document.getElementById('gridCanvas');
    if (!project || !wrap || !canvas) { setZoom(level); return; }

    const oldScale = scale;
    const canvasRectBefore = canvas.getBoundingClientRect();
    const worldX = (clientX - canvasRectBefore.left) / oldScale;
    const worldY = (clientY - canvasRectBefore.top) / oldScale;

    setZoom(level);

    const canvasRectAfter = canvas.getBoundingClientRect();
    const actualScreenX = canvasRectAfter.left + worldX * scale;
    const actualScreenY = canvasRectAfter.top + worldY * scale;
    wrap.scrollLeft += actualScreenX - clientX;
    wrap.scrollTop += actualScreenY - clientY;
  }

  function computeScale() {
    const wrap = document.querySelector('.grid-canvas-wrap');
    const availableWidth = Math.max(300, (wrap ? wrap.clientWidth : 800) - 32);
    const availableHeight = Math.max(300, window.innerHeight * 0.7);
    const w = project.footprintWidth;
    const d = project.footprintDepth;
    const fitScale = Math.min(availableWidth / w, availableHeight / d, PX_PER_IN_MAX);
    scale = fitScale * zoomLevel;
    return scale;
  }

  function renderCanvas() {
    const canvas = document.getElementById('gridCanvas');
    computeScale();
    canvas.style.width = `${project.footprintWidth * scale}px`;
    canvas.style.height = `${project.footprintDepth * scale}px`;
    canvas.style.backgroundSize = `${scale}px ${scale}px`;
    const levelEl = document.getElementById('gridZoomLevel');
    if (levelEl) levelEl.textContent = `${Math.round(zoomLevel * 100)}%`;

    canvas.innerHTML = '';
    dragPreviewEl = null; // the node above was just destroyed along with everything else
    canvas.ondragover = (e) => {
      e.preventDefault();
      updateDragPreview(e);
    };
    canvas.ondragleave = (e) => {
      // dragleave also fires when moving from the canvas onto one of its own child elements
      // (a stack box, the preview itself) -- only treat it as "left the canvas" when the related
      // target genuinely isn't inside it anymore.
      if (!e.relatedTarget || !canvas.contains(e.relatedTarget)) removeDragPreview();
    };
    canvas.ondrop = handleDrop;

    // Pallet markers render FIRST, before any stack/group -- both sit at the same z-index (0), and
    // with no z-index set, later DOM order wins hit-testing/paint order for overlapping elements.
    // A marker appended last (as it briefly was) sat on top of every case underneath it, silently
    // swallowing every click/drag meant for that case -- move, multi-select for grouping, and
    // ungroup all looked "broken" because the pointer event never reached the stack at all.
    // Rendering markers first means any real stack/topper/group painted after it wins the overlap.
    project.pallets.filter(p => p.visible).forEach(pallet => {
      canvas.appendChild(buildPalletEl(pallet));
      const handle = buildPalletRotateHandleEl(pallet);
      if (handle) canvas.appendChild(handle);
    });

    const ungroupedStacks = project.stacks.filter(s => !s.groupId);
    document.getElementById('gridHint').classList.toggle(
      'hidden', project.stacks.length > 0 || project.groups.length > 0
    );

    ungroupedStacks.forEach(stack => {
      canvas.appendChild(buildStackEl(stack));
      stack.toppers.forEach(topper => canvas.appendChild(buildTopperEl(stack, topper)));
      // Appended last (after this stack's own toppers) so it paints on top of them in DOM order,
      // matching its z-index -- see buildStackGrabHandleEl's comment.
      const grabHandle = buildStackGrabHandleEl(stack);
      if (grabHandle) canvas.appendChild(grabHandle);
    });

    project.groups.forEach(group => {
      const members = getGroupMembers(group);
      members.forEach(({ stack, worldCenter }) => {
        canvas.appendChild(buildGroupMemberEl(group, stack, worldCenter));
        stack.toppers.forEach(topper => canvas.appendChild(buildGroupTopperEl(group, stack, worldCenter, topper)));
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
    el.dataset.stackId = stack.id;
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
        selectedTopper = null;
        selectedPalletId = null;
        multiSelectIds.clear(); multiSelectTopperKeys.clear();
      }
      render();
    });

    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      addDuplicateTopItem(stack.items);
    });

    return el;
  }

  // A stack with one or more toppers can end up with its own base fully covered on screen -- three
  // toppers packed onto a case can leave no exposed pixel of the case itself to click. Without this,
  // there was no way to select or drag that case at all short of first dragging every topper off it.
  // A small handle pinned to the base's top-left corner, painted above every topper (higher
  // z-index), gives a guaranteed-clickable spot for the base regardless of topper coverage.
  function buildStackGrabHandleEl(stack) {
    if (!stack.toppers.length) return null;
    const el = document.createElement('div');
    el.className = 'stack-grab-handle';
    el.dataset.stackId = stack.id;
    el.style.left = `${stack.x * scale - 6}px`;
    el.style.top = `${stack.y * scale - 6}px`;
    el.title = 'Grab the case underneath -- drag to move it (and everything on top of it), or click to select it.';

    el.addEventListener('mousedown', (e) => {
      if (e.shiftKey) return;
      startStackMove(e, stack);
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey) {
        toggleMultiSelect(stack.id);
      } else {
        selectedStackId = stack.id;
        selectedGroupId = null;
        selectedTopper = null;
        selectedPalletId = null;
        multiSelectIds.clear(); multiSelectTopperKeys.clear();
      }
      render();
    });

    return el;
  }

  // Double-clicking a stack/topper adds one more of whatever item is currently on top of it --
  // the same result as dragging that same case/unit from the palette and dropping it there.
  function addDuplicateTopItem(items) {
    pushUndo(snapshotProject());
    items.push({ ...items[items.length - 1] });
    saveState(state);
    render();
  }

  // A topper's box on the 2D floor: positioned within its parent stack's rectangle at the
  // topper's local offset, rendered smaller with its own border so it visibly reads as sitting on
  // top rather than as part of the base. Draggable via startTopperMove, same resolution rules as
  // a fresh palette drop (see commitTopperMove).
  function buildTopperEl(stack, topper) {
    const el = document.createElement('div');
    const isMultiSelected = multiSelectTopperKeys.has(topperKey(stack.id, topper.id));
    el.className = 'grid-stack grid-topper'
      + (isTopperSelected(stack.id, topper.id) ? ' selected' : '')
      + (isMultiSelected ? ' selected' : '');
    el.dataset.parentStackId = stack.id;
    el.dataset.topperId = topper.id;
    el.style.left = `${(stack.x + topper.dx) * scale}px`;
    el.style.top = `${(stack.y + topper.dy) * scale}px`;
    el.style.width = `${topper.footprintW * scale}px`;
    el.style.height = `${topper.footprintD * scale}px`;

    applySwatchBackground(el, topper.items[topper.items.length - 1]);

    const badge = document.createElement('span');
    badge.className = 'stack-badge';
    badge.textContent = topper.items.length > 1 ? `x${topper.items.length}` : '1';
    el.appendChild(badge);

    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.shiftKey) return; // shift+click is for multi-select, not moving
      startTopperMove(e, stack, topper);
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey) {
        toggleTopperMultiSelect(stack.id, topper.id);
      } else {
        selectedTopper = { stackId: stack.id, topperId: topper.id };
        selectedStackId = null;
        selectedGroupId = null;
        selectedPalletId = null;
        multiSelectIds.clear(); multiSelectTopperKeys.clear();
      }
      render();
    });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      addDuplicateTopItem(topper.items);
    });

    return el;
  }

  // Placing a case on the grid is a flat-colored box now, not its actual photo -- decoding and
  // painting a full-resolution image for every dropped box (potentially dozens at once, each
  // re-painted on every render()) was the real cost behind Andrew's reported ~5s render lag on a
  // drop. `swatch.avgColor` is a predominant-color sample cached once at swatch-creation time
  // (itemTypes.js/cases.js, via storage.js's computeAverageColorFromDataUrl) -- reading it here is
  // just a property lookup, no decode cost at all. Swatches created before this change won't have
  // it yet; those get a one-time async backfill below rather than falling back to the image.
  const avgColorBackfillPending = new Set();
  function getGridBackground(sw) {
    if (!sw.image) return sw.color;
    if (sw.avgColor) return sw.avgColor;
    if (!avgColorBackfillPending.has(sw.id)) {
      avgColorBackfillPending.add(sw.id);
      computeAverageColorFromDataUrl(sw.image).then(avgColor => {
        avgColorBackfillPending.delete(sw.id);
        if (avgColor) {
          sw.avgColor = avgColor;
          saveState(state);
          // Never re-render mid-drag: render() tears down the canvas, including the element
          // currently being dragged, so it would stop following the mouse until mouseup.
          if (!dragOp) render();
        }
      });
    }
    // Instant placeholder while the backfill above resolves -- still zero decode cost, just not
    // yet the real predominant color for this one swatch's first render after upgrading.
    return sw.color;
  }

  function isTopperSelected(stackId, topperId) {
    return !!selectedTopper && selectedTopper.stackId === stackId && selectedTopper.topperId === topperId;
  }

  function applySwatchBackground(el, topItem) {
    const sw = resolveSwatch(topItem.itemTypeId, topItem.swatchId);
    if (sw) {
      el.style.background = getGridBackground(sw);
      // The `background` shorthand above resets background-origin back to its default
      // (padding-box), silently undoing the CSS rule that makes the image reach the box's real
      // border -- set it explicitly every time so this can't regress if padding ever comes back.
      el.style.backgroundOrigin = 'border-box';
    } else {
      // Item type or swatch was deleted after this was placed -- show a visible "missing"
      // pattern instead of leaving the box invisible against the canvas.
      el.style.background = 'repeating-linear-gradient(45deg, #7a2f2f, #7a2f2f 6px, #3a1414 6px, #3a1414 12px)';
      el.title = 'This item\'s type or color was deleted -- remove it from the floor.';
    }
  }

  function toggleMultiSelect(stackId) {
    selectedStackId = null;
    selectedGroupId = null;
    selectedTopper = null;
    selectedPalletId = null;
    if (multiSelectIds.has(stackId)) multiSelectIds.delete(stackId);
    else multiSelectIds.add(stackId);
  }

  function topperKey(stackId, topperId) {
    return `${stackId}:${topperId}`;
  }

  function toggleTopperMultiSelect(stackId, topperId) {
    selectedStackId = null;
    selectedGroupId = null;
    selectedTopper = null;
    selectedPalletId = null;
    const key = topperKey(stackId, topperId);
    if (multiSelectTopperKeys.has(key)) multiSelectTopperKeys.delete(key);
    else multiSelectTopperKeys.add(key);
  }

  function resolveSwatch(itemTypeId, swatchId) {
    const it = ItemTypes.getItemType(itemTypeId);
    if (!it) return null;
    return it.palette.find(s => s.id === swatchId) || null;
  }

  function handleDrop(e) {
    e.preventDefault();
    removeDragPreview();
    const raw = e.dataTransfer.getData('application/json');
    if (!raw) return;
    const payload = JSON.parse(raw);

    const canvas = document.getElementById('gridCanvas');
    const rect = canvas.getBoundingClientRect();
    const dropXIn = (e.clientX - rect.left) / scale;
    const dropYIn = (e.clientY - rect.top) / scale;

    const footprintW = payload.footprintW;
    const footprintD = payload.footprintD;

    const newItem = {
      kind: payload.kind,
      itemTypeId: payload.itemTypeId,
      swatchId: payload.swatchId,
      caseId: payload.caseId || null
    };

    // Try landing on a stackable target (base column or topper) using the raw grid-snapped drop
    // point first, BEFORE any floor-level neighbor-edge-snapping -- that snap is meant to butt a
    // floor item flush against its neighbors, but a drop point near the far edge of a big target
    // (e.g. a case) would otherwise get pulled clean off of it and onto the floor beside it.
    const rawX = snap(dropXIn);
    const rawY = snap(dropYIn);
    const placement = resolvePlacement(footprintW, footprintD, rawX, rawY, null);

    if (placement && placement.blocked) {
      alert(placement.reason);
      return;
    }

    const { x, y } = placement
      ? { x: rawX, y: rawY }
      : snapToNeighborEdges(rawX, rawY, footprintW, footprintD, null);

    if (!placement && (x < 0 || y < 0 || x + footprintW > project.footprintWidth || y + footprintD > project.footprintDepth)) {
      alert('That placement goes outside the floor footprint.');
      return;
    }

    if (placement && placement.mode === 'base') {
      pushUndo(snapshotProject());
      placement.targetStack.items.push(newItem);
      saveState(state);
      renderAfterDrop();
      return;
    }

    if (placement && placement.mode === 'merge-topper') {
      pushUndo(snapshotProject());
      placement.topper.items.push(newItem);
      saveState(state);
      renderAfterDrop();
      return;
    }

    if (placement && placement.mode === 'new-topper') {
      pushUndo(snapshotProject());
      placement.targetStack.toppers.push({
        id: uid('topper'),
        dx: placement.localX,
        dy: placement.localY,
        footprintW, footprintD,
        items: [newItem]
      });
      saveState(state);
      renderAfterDrop();
      return;
    }

    const droppedCorners = aabbCorners(x, y, footprintW, footprintD);
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
      toppers: [],
      groupId: null
    });
    saveState(state);
    renderAfterDrop();
  }

  // Some browsers defer repainting the page under an active native HTML5 drag until the whole
  // drag/drop session (including the 'dragend' event still pending on the source element) has
  // fully torn down -- a plain synchronous render() call made from inside 'drop' can end up
  // silently not painted until something else forces a reflow (e.g. switching tabs). saveState()
  // above already runs synchronously so the data itself is never at risk; only the visual update
  // is deferred one frame, right after the browser's own drag cleanup, so it reliably paints.
  function renderAfterDrop() {
    // A single requestAnimationFrame turned out to not always be enough -- reported recurring on a
    // real machine even after the original fix. Nesting a second rAF inside the first pushes the
    // render to the start of a LATER frame rather than just "sometime this frame," which is more
    // reliable at landing after the browser's own drag-session paint suppression has actually
    // lifted. The dragend handler above is a second, independent safety net on top of this.
    requestAnimationFrame(() => requestAnimationFrame(() => render()));
  }

  // Live ghost box shown while dragging a palette item over the canvas, sized to the item's real
  // footprint and positioned exactly where it would land -- same resolution order as handleDrop
  // (stackable target first, then floor edge-snap), so what you see is what you'll get on drop.
  function updateDragPreview(e) {
    if (!dragPreviewPayload || !project) return;

    const canvas = document.getElementById('gridCanvas');
    const rect = canvas.getBoundingClientRect();
    const dropXIn = (e.clientX - rect.left) / scale;
    const dropYIn = (e.clientY - rect.top) / scale;
    const footprintW = dragPreviewPayload.footprintW;
    const footprintD = dragPreviewPayload.footprintD;

    const rawX = snap(dropXIn);
    const rawY = snap(dropYIn);
    const placement = resolvePlacement(footprintW, footprintD, rawX, rawY, null);

    let x, y, w, d, valid;
    if (placement && placement.mode === 'base') {
      // Merging into an existing base column -- highlight the whole target it'll absorb into.
      ({ x, y, footprintW: w, footprintD: d } = placement.targetStack);
      valid = true;
    } else if (placement && placement.mode === 'merge-topper') {
      x = placement.targetStack.x + placement.topper.dx;
      y = placement.targetStack.y + placement.topper.dy;
      w = placement.topper.footprintW;
      d = placement.topper.footprintD;
      valid = true;
    } else if (placement && placement.mode === 'new-topper') {
      x = placement.targetStack.x + placement.localX;
      y = placement.targetStack.y + placement.localY;
      w = footprintW;
      d = footprintD;
      valid = true;
    } else if (placement && placement.blocked) {
      x = rawX;
      y = rawY;
      w = footprintW;
      d = footprintD;
      valid = false;
    } else {
      const snapped = snapToNeighborEdges(rawX, rawY, footprintW, footprintD, null);
      x = snapped.x;
      y = snapped.y;
      w = footprintW;
      d = footprintD;
      valid = !(x < 0 || y < 0 || x + w > project.footprintWidth || y + d > project.footprintDepth) &&
        !collidesWithAnything(aabbCorners(x, y, w, d), { excludeStackId: null, excludeGroupId: null });
    }

    if (!dragPreviewEl) {
      dragPreviewEl = document.createElement('div');
      dragPreviewEl.className = 'grid-drag-preview';
      canvas.appendChild(dragPreviewEl);
    }
    dragPreviewEl.style.left = `${x * scale}px`;
    dragPreviewEl.style.top = `${y * scale}px`;
    dragPreviewEl.style.width = `${w * scale}px`;
    dragPreviewEl.style.height = `${d * scale}px`;
    dragPreviewEl.classList.toggle('invalid', !valid);
  }

  function removeDragPreview() {
    if (dragPreviewEl) {
      dragPreviewEl.remove();
      dragPreviewEl = null;
    }
  }

  // COLLISION_EPSILON absorbs floating-point drift (e.g. 4 * 3.4 doesn't land on the exact same
  // bit pattern as 2 + 13.6) so two rects meant to sit exactly flush -- computed via different
  // arithmetic paths -- don't get flagged as overlapping by a sub-thousandth-inch sliver.
  const COLLISION_EPSILON = 1e-6;

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w - COLLISION_EPSILON && a.x + a.w > b.x + COLLISION_EPSILON &&
      a.y < b.y + b.d - COLLISION_EPSILON && a.y + a.d > b.y + COLLISION_EPSILON;
  }

  // ---- Live footprint resync ----
  // Every stack/topper stores its own footprintW/D so merge/edge-snap checks have something to
  // compare without re-deriving it constantly -- but that's only ever a snapshot from whenever
  // the item was placed. Editing an item type's or case's real width/depth afterward (a normal
  // part of dialing in real-world measurements) left every already-placed stack of that type
  // stuck with the old size forever, next to new ones using the corrected size -- a real,
  // visible misalignment in both the grid and the 3D viewer, since both render straight off
  // these stored fields (the 3D viewer's own per-box size was already computed live via
  // getItemFootprint() there, but its box CENTER used this same stale stack.footprintW/D, so it
  // rendered at the right size in the wrong place). Re-synced from the live item type/case data
  // every time the active project is touched, so both views self-heal automatically.
  function computeItemFootprint(item) {
    if (item.kind === 'case') {
      const c = Cases.getCase(item.caseId);
      const it = c ? ItemTypes.getItemType(c.itemTypeId) : null;
      return (c && it) ? { w: c.cols * it.width, d: c.layers * it.depth } : null;
    }
    const it = ItemTypes.getItemType(item.itemTypeId);
    return it ? { w: it.width, d: it.depth } : null;
  }

  function resyncActiveProjectFootprints() {
    if (!project) return;
    project.stacks.forEach(stack => {
      const live = stack.items.length ? computeItemFootprint(stack.items[0]) : null;
      if (live && (Math.abs(live.w - stack.footprintW) > 0.001 || Math.abs(live.d - stack.footprintD) > 0.001)) {
        stack.footprintW = live.w;
        stack.footprintD = live.d;
      }
      stack.toppers.forEach(topper => {
        const liveTopper = topper.items.length ? computeItemFootprint(topper.items[0]) : null;
        if (liveTopper && (Math.abs(liveTopper.w - topper.footprintW) > 0.001 || Math.abs(liveTopper.d - topper.footprintD) > 0.001)) {
          topper.footprintW = liveTopper.w;
          topper.footprintD = liveTopper.d;
        }
        // Keep the topper resting fully on its (possibly resized) parent's surface rather than
        // hanging off an edge that just moved.
        topper.dx = clamp(topper.dx, 0, Math.max(0, stack.footprintW - topper.footprintW));
        topper.dy = clamp(topper.dy, 0, Math.max(0, stack.footprintD - topper.footprintD));
      });
    });
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // A dropped/moved footprint can stack onto a target only if it's no bigger than the target in
  // either dimension -- a case can't balance on top of a single unit, but a unit (or a smaller
  // case) can sit on top of a bigger case.
  function isStackable(dropped, target) {
    return dropped.w <= target.w + 0.01 && dropped.d <= target.d + 0.01;
  }

  // "Landed on it" (should merge into a stack) vs. "just grazing it" (should be blocked as a
  // collision, or succeed as an independent adjacent placement if there's no overlap at all).
  // Denominator is always the dropped item's own footprint -- since a stackable item is always
  // the same size or smaller than its target, "mostly within the target" is what matters.
  function isMergeableOverlap(a, b) {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y));
    const area = a.w * a.d;
    if (area <= 0) return false;
    return (ix * iy) / area >= MERGE_OVERLAP_FRACTION;
  }

  // Resolves what placing a footprintW x footprintD item at global (x,y) should do: merge into a
  // same-footprint target's base column, merge into (or create) a topper resting on a bigger
  // target's top surface, or (if no stackable target underlies it) return null so the caller
  // falls back to plain floor placement. excludeStackId lets a stack being dragged ignore itself.
  function resolvePlacement(footprintW, footprintD, x, y, excludeStackId) {
    const droppedRect = { x, y, w: footprintW, d: footprintD };
    const droppedCenter = { x: x + footprintW / 2, y: y + footprintD / 2 };

    const targetStack = project.stacks.find(s => {
      if (s.groupId || s.id === excludeStackId) return false;
      if (!isStackable({ w: footprintW, d: footprintD }, { w: s.footprintW, d: s.footprintD })) return false;

      const sameFootprint = Math.abs(s.footprintW - footprintW) < 0.01 && Math.abs(s.footprintD - footprintD) < 0.01;
      if (sameFootprint) {
        return isMergeableOverlap(droppedRect, { x: s.x, y: s.y, w: s.footprintW, d: s.footprintD });
      }
      // A genuinely smaller item can't be reliably tested by area-overlap of its raw (unclamped)
      // drop rect -- it may hang off whichever edge of the target it was dropped near. Its center
      // landing within the target's footprint is what "aimed at this target" actually means; the
      // final position gets clamped to fit inside afterward.
      return droppedCenter.x >= s.x && droppedCenter.x <= s.x + s.footprintW &&
        droppedCenter.y >= s.y && droppedCenter.y <= s.y + s.footprintD;
    });
    if (!targetStack) return null;

    const fullCoverage = Math.abs(targetStack.footprintW - footprintW) < 0.01 &&
      Math.abs(targetStack.footprintD - footprintD) < 0.01;

    if (fullCoverage) {
      if (targetStack.toppers.length > 0) {
        return { blocked: true, reason: 'That stack already has units placed on top of it -- remove them first, or drop somewhere else.' };
      }
      return { targetStack, mode: 'base' };
    }

    let localX = clamp(snap(x - targetStack.x), 0, targetStack.footprintW - footprintW);
    let localY = clamp(snap(y - targetStack.y), 0, targetStack.footprintD - footprintD);
    ({ x: localX, y: localY } = snapTopperToSiblingEdges(targetStack, localX, localY, footprintW, footprintD));

    const localRect = { x: localX, y: localY, w: footprintW, d: footprintD };

    const existingTopper = targetStack.toppers.find(t =>
      Math.abs(t.footprintW - footprintW) < 0.01 && Math.abs(t.footprintD - footprintD) < 0.01 &&
      isMergeableOverlap(localRect, { x: t.dx, y: t.dy, w: t.footprintW, d: t.footprintD })
    );
    if (existingTopper) return { targetStack, mode: 'merge-topper', topper: existingTopper };

    const collidesTopper = targetStack.toppers.some(t =>
      rectsOverlap(localRect, { x: t.dx, y: t.dy, w: t.footprintW, d: t.footprintD })
    );
    if (collidesTopper) {
      return { blocked: true, reason: 'That overlaps a unit already placed on top of this stack.' };
    }

    return { targetStack, mode: 'new-topper', localX, localY };
  }

  // Local-coordinate version of snapToNeighborEdges, scoped to one stack's top surface: snaps a
  // new topper flush against sibling toppers already up there, or flush against the surface's own
  // edges, so units can be butted up against each other precisely instead of needing a pixel-
  // perfect drop.
  function snapTopperToSiblingEdges(targetStack, x, y, w, d) {
    const rects = targetStack.toppers.map(t => ({ x: t.dx, y: t.dy, w: t.footprintW, d: t.footprintD }));
    const tol = edgeSnapToleranceIn();
    const maxX = targetStack.footprintW - w;
    const maxY = targetStack.footprintD - d;

    // Prefer a full corner snap against a sibling topper -- see snapToNeighborEdges's identical
    // rule for why: without it, toppers placed side by side only glue their touching edge
    // together and leave the other axis wherever the mouse landed.
    let bestCorner = null;
    rects.forEach(r => {
      const c = tryCornerSnap(x, y, w, d, r, tol);
      if (c && (!bestCorner || c.dist < bestCorner.dist)) bestCorner = c;
    });
    if (bestCorner) return { x: clamp(bestCorner.x, 0, maxX), y: clamp(bestCorner.y, 0, maxY) };

    // X and Y snapping are tracked independently -- see snapToNeighborEdges for why a shared
    // "closest wins" candidate is wrong (an item already flush on one axis has distance 0 there,
    // which would always beat a genuinely useful snap on the other axis).
    let bestX = null;
    let bestY = null;

    rects.forEach(r => {
      const vOverlap = Math.min(y + d, r.y + r.d) - Math.max(y, r.y);
      if (vOverlap > 0) {
        const dRight = Math.abs(x - (r.x + r.w));
        if (dRight <= edgeSnapToleranceIn() && (!bestX || dRight < bestX.dist)) bestX = { dist: dRight, value: r.x + r.w };
        const dLeft = Math.abs((x + w) - r.x);
        if (dLeft <= edgeSnapToleranceIn() && (!bestX || dLeft < bestX.dist)) bestX = { dist: dLeft, value: r.x - w };
      }
      const hOverlap = Math.min(x + w, r.x + r.w) - Math.max(x, r.x);
      if (hOverlap > 0) {
        const dBelow = Math.abs(y - (r.y + r.d));
        if (dBelow <= edgeSnapToleranceIn() && (!bestY || dBelow < bestY.dist)) bestY = { dist: dBelow, value: r.y + r.d };
        const dAbove = Math.abs((y + d) - r.y);
        if (dAbove <= edgeSnapToleranceIn() && (!bestY || dAbove < bestY.dist)) bestY = { dist: dAbove, value: r.y - d };
      }
    });

    // Also snap flush against the surface's own edges.
    if (Math.abs(x) <= edgeSnapToleranceIn() && (!bestX || Math.abs(x) < bestX.dist)) bestX = { dist: Math.abs(x), value: 0 };
    if (Math.abs(x - maxX) <= edgeSnapToleranceIn() && (!bestX || Math.abs(x - maxX) < bestX.dist)) bestX = { dist: Math.abs(x - maxX), value: maxX };
    if (Math.abs(y) <= edgeSnapToleranceIn() && (!bestY || Math.abs(y) < bestY.dist)) bestY = { dist: Math.abs(y), value: 0 };
    if (Math.abs(y - maxY) <= edgeSnapToleranceIn() && (!bestY || Math.abs(y - maxY) < bestY.dist)) bestY = { dist: Math.abs(y - maxY), value: maxY };

    // bestX/bestY are already the exact flush coordinate -- re-snapping to the 1in grid would
    // reopen the gap just closed (or push it into a slight overlap) whenever real item dimensions
    // aren't whole inches. Still clamp for float-precision safety at the surface's own edges.
    return {
      x: clamp(bestX ? bestX.value : x, 0, maxX),
      y: clamp(bestY ? bestY.value : y, 0, maxY)
    };
  }

  function snap(value) {
    return Math.max(0, Math.round(value / SNAP_IN) * SNAP_IN);
  }

  // A fixed real-world-inch snap tolerance gets brutally hard to hit once zoomed out (2in can be
  // a couple of screen pixels), and pointlessly loose once zoomed way in -- expressing it as a
  // fixed number of screen pixels and converting through the current scale keeps "close enough to
  // snap" equally easy to land at any zoom level. Floored at 0.25in so a print-quality zoom-in
  // doesn't turn a near-flush drop into a rejected snap either.
  function edgeSnapToleranceIn() {
    return Math.max(0.25, EDGE_SNAP_TOLERANCE_PX / scale);
  }

  // Axis-aligned rects of everything currently on the floor (ungrouped stacks, plus members of
  // any group that isn't meaningfully rotated), for edge-snapping. Ignores rotated groups --
  // snapping flush against an angled neighbor isn't a well-defined single position.
  function collectAxisAlignedRects(opts) {
    const excludeStackId = (typeof opts === 'string' || opts === null) ? opts : (opts && opts.excludeStackId) || null;
    const excludeGroupId = (opts && typeof opts === 'object' && opts.excludeGroupId) || null;
    const list = [];
    project.stacks.filter(s => !s.groupId && s.id !== excludeStackId).forEach(s => {
      list.push({ x: s.x, y: s.y, w: s.footprintW, d: s.footprintD });
    });
    project.groups.filter(g => g.id !== excludeGroupId).forEach(g => {
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

  // Checks one neighbor rect for a full corner snap: a touching side edge (left/right of it) AND
  // an aligned leading/trailing edge (front/back flush with it) both within tolerance at once --
  // i.e. "you're dropping this to continue a flush row/column with that neighbor," not just
  // "you're near its edge somewhere." Returns the single best-matching corner for this neighbor,
  // or null if none of the 8 side+align combinations both qualify.
  function tryCornerSnap(x, y, w, d, r, tol) {
    const dRight = Math.abs(x - (r.x + r.w));
    const dLeft = Math.abs((x + w) - r.x);
    const dFront = Math.abs(y - r.y);
    const dBack = Math.abs((y + d) - (r.y + r.d));
    const dBelow = Math.abs(y - (r.y + r.d));
    const dAbove = Math.abs((y + d) - r.y);
    const dLeftAlign = Math.abs(x - r.x);
    const dRightAlign = Math.abs((x + w) - (r.x + r.w));

    const combos = [];
    if (dRight <= tol && dFront <= tol) combos.push({ dist: dRight + dFront, x: r.x + r.w, y: r.y });
    if (dRight <= tol && dBack <= tol) combos.push({ dist: dRight + dBack, x: r.x + r.w, y: r.y + r.d - d });
    if (dLeft <= tol && dFront <= tol) combos.push({ dist: dLeft + dFront, x: r.x - w, y: r.y });
    if (dLeft <= tol && dBack <= tol) combos.push({ dist: dLeft + dBack, x: r.x - w, y: r.y + r.d - d });
    if (dBelow <= tol && dLeftAlign <= tol) combos.push({ dist: dBelow + dLeftAlign, x: r.x, y: r.y + r.d });
    if (dBelow <= tol && dRightAlign <= tol) combos.push({ dist: dBelow + dRightAlign, x: r.x + r.w - w, y: r.y + r.d });
    if (dAbove <= tol && dLeftAlign <= tol) combos.push({ dist: dAbove + dLeftAlign, x: r.x, y: r.y - d });
    if (dAbove <= tol && dRightAlign <= tol) combos.push({ dist: dAbove + dRightAlign, x: r.x + r.w - w, y: r.y - d });

    return combos.reduce((best, c) => (!best || c.dist < best.dist) ? c : best, null);
  }

  // If (x,y) is close to sitting flush against a neighbor's edge but not exactly on it, snap it
  // there -- turns "aimed close but missed by an inch" into a clean adjacent placement instead
  // of a rejected near-overlap or an awkward gap.
  // excludeStackId can be a plain stack id (legacy call sites) or an opts object
  // { excludeStackId, excludeGroupId } -- the latter lets a group's own move exclude every one of
  // its own members at once instead of just one stack id.
  function snapToNeighborEdges(x, y, w, d, excludeStackId) {
    const rects = collectAxisAlignedRects(excludeStackId);
    const tol = edgeSnapToleranceIn();

    // Prefer a full corner snap (the touching edge AND the leading/trailing edge both close to
    // one neighbor at once) -- this is what actually produces a flush row or column. Without it,
    // placing cases side by side only ever glues the touching edge together and leaves each
    // box's front/back wherever the mouse happened to drop it, so a "flush row" ends up visibly
    // staggered even though every pair looks edge-to-edge individually.
    let bestCorner = null;
    rects.forEach(r => {
      const c = tryCornerSnap(x, y, w, d, r, tol);
      if (c && (!bestCorner || c.dist < bestCorner.dist)) bestCorner = c;
    });
    if (bestCorner) return { x: bestCorner.x, y: bestCorner.y };

    // Fall back to snapping just one axis to a neighbor whose OTHER axis already overlaps (e.g.
    // stacking directly behind another case in the same column) -- X and Y are tracked
    // independently here (not one shared "closest wins" candidate) because an item already flush
    // on one axis has distance 0 there, which would otherwise always beat a genuinely useful snap
    // on the other axis and silently discard it.
    let bestX = null;
    let bestY = null;

    rects.forEach(r => {
      const vOverlap = Math.min(y + d, r.y + r.d) - Math.max(y, r.y);
      if (vOverlap > 0) {
        const dRight = Math.abs(x - (r.x + r.w));
        if (dRight <= tol && (!bestX || dRight < bestX.dist)) {
          bestX = { dist: dRight, value: r.x + r.w };
        }
        const dLeft = Math.abs((x + w) - r.x);
        if (dLeft <= tol && (!bestX || dLeft < bestX.dist)) {
          bestX = { dist: dLeft, value: r.x - w };
        }
      }
      const hOverlap = Math.min(x + w, r.x + r.w) - Math.max(x, r.x);
      if (hOverlap > 0) {
        const dBelow = Math.abs(y - (r.y + r.d));
        if (dBelow <= tol && (!bestY || dBelow < bestY.dist)) {
          bestY = { dist: dBelow, value: r.y + r.d };
        }
        const dAbove = Math.abs((y + d) - r.y);
        if (dAbove <= tol && (!bestY || dAbove < bestY.dist)) {
          bestY = { dist: dAbove, value: r.y - d };
        }
      }
    });

    // bestX/bestY are already the exact flush-against-the-neighbor coordinate -- re-snapping to
    // the 1in grid here would reintroduce the gap (or overlap) this function exists to close,
    // whenever real item dimensions aren't whole inches.
    return {
      x: bestX ? bestX.value : x,
      y: bestY ? bestY.value : y
    };
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
      // See COLLISION_EPSILON above -- two rects meant to sit exactly flush shouldn't register
      // as colliding over a sub-thousandth-inch of float drift.
      return pa.max > pb.min + COLLISION_EPSILON && pb.max > pa.min + COLLISION_EPSILON;
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
    if (multiSelectIds.size + multiSelectTopperKeys.size < 2) return;
    pushUndo(snapshotProject());
    const ids = popSelectedToppersToStacks(Array.from(multiSelectIds));
    const groupId = groupStackIds(ids, { skipUndo: true });
    if (!groupId) return;
    multiSelectIds.clear(); multiSelectTopperKeys.clear();
    selectedGroupId = groupId;
    selectedPalletId = null;
    render();
  }

  // A selected topper has no independent floor position of its own (only dx/dy local to its
  // parent case) -- grouping treats it like any other selected item by first popping it off its
  // parent onto the floor as its own standalone stack (same footprint/items, same real-world
  // position it already occupied), same outcome as dragging it onto open floor. Returns the full
  // list of stack ids to group: the original selected stack ids plus one new id per popped topper.
  function popSelectedToppersToStacks(stackIds) {
    const ids = stackIds.slice();
    multiSelectTopperKeys.forEach(key => {
      const [stackId, topperId] = key.split(':');
      const parent = project.stacks.find(s => s.id === stackId);
      if (!parent) return;
      const idx = parent.toppers.findIndex(t => t.id === topperId);
      if (idx === -1) return;
      const topper = parent.toppers[idx];
      parent.toppers.splice(idx, 1);
      const newStack = {
        id: uid('stack'),
        x: parent.x + topper.dx,
        y: parent.y + topper.dy,
        footprintW: topper.footprintW,
        footprintD: topper.footprintD,
        items: topper.items,
        toppers: [],
        groupId: null
      };
      project.stacks.push(newStack);
      ids.push(newStack.id);
    });
    return ids;
  }

  // Creates a group from the given (ungrouped) stack ids -- the shared mutation both the 2D
  // grid's "Group Selected" button and the 3D viewer's equivalent call into, so there's one
  // source of truth for what grouping actually does. Returns the new group's id, or null if
  // fewer than 2 valid ungrouped stacks were given.
  function groupStackIds(stackIds, opts) {
    const memberStacks = project.stacks.filter(s => stackIds.includes(s.id) && !s.groupId);
    if (memberStacks.length < 2) return null;

    // grid.js's own multi-select flow may have already popped selected toppers into standalone
    // stacks and pushed one undo entry covering that plus this grouping, as a single user action.
    if (!opts || !opts.skipUndo) pushUndo(snapshotProject());

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
    });

    const group = {
      id: uid('group'),
      centerX, centerY, angle: 0,
      memberIds: memberStacks.map(s => s.id),
      members
    };

    memberStacks.forEach(s => { s.groupId = group.id; });
    project.groups.push(group);

    saveState(state);
    return group.id;
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

  // Returns true/false so callers (the 2D angle field, the 3D rotate handle) can tell the user
  // when a rotation was rejected instead of it just silently not sticking.
  function setGroupAngle(groupId, angle) {
    const group = project.groups.find(g => g.id === groupId);
    if (!group) return false;
    const normalized = ((angle % 360) + 360) % 360;
    const before = snapshotProject();
    const ok = tryApplyGroupTransform(group, group.centerX, group.centerY, normalized);
    if (ok) pushUndo(before);
    return ok;
  }

  // Same shape as setGroupAngle, but for repositioning the group instead -- used by the 3D
  // viewer's drag-to-move (the 2D grid has its own equivalent drag path in commitStackMove /
  // startGroupMove already). Returns true/false so the caller can tell the user when a move was
  // rejected.
  function moveGroup(groupId, centerX, centerY) {
    const group = project.groups.find(g => g.id === groupId);
    if (!group) return false;
    const before = snapshotProject();
    const snapped = snapGroupPosition(group, centerX, centerY);
    const ok = tryApplyGroupTransform(group, snapped.centerX, snapped.centerY, group.angle);
    if (ok) pushUndo(before);
    return ok;
  }

  // Same transform as getGroupMembers, but for a hypothetical center rather than the group's own
  // persisted centerX/centerY -- lets snapping evaluate "what would the bounding box be if I
  // committed here" without mutating the real group first.
  function getGroupMembersAt(group, centerX, centerY) {
    const a = (group.angle * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    return group.memberIds.map(memberId => {
      const m = group.members[memberId];
      const stack = project.stacks.find(s => s.id === memberId);
      if (!stack) return null;
      return {
        stack,
        worldCenter: { x: centerX + m.dx * cos - m.dy * sin, y: centerY + m.dx * sin + m.dy * cos }
      };
    }).filter(Boolean);
  }

  // Groups never had any snapping at all -- a plain stack/topper gets both a 1in grid snap and
  // edge/corner snapping against its neighbors (see snapToNeighborEdges above), but a group move
  // went straight from raw mouse pixels to a collision check, so lining a multi-case group up flush
  // against another stack required pixel-perfect mouse placement. This gives a group move the same
  // treatment: snap the group's own bounding box's raw corner to the 1in grid, then to a flush
  // neighbor edge if one's close, then translate that correction back onto the group's center.
  // Edge/corner snapping only applies when the group itself is axis-aligned (angle at/near a
  // multiple of 90) -- same reasoning as collectAxisAlignedRects skipping rotated neighbors: "flush
  // against this edge" isn't a single well-defined position once the shape being placed is at an
  // arbitrary angle.
  function snapGroupPosition(group, centerX, centerY) {
    const snappedCenterX = snap(centerX);
    const snappedCenterY = snap(centerY);

    const angleNorm = ((group.angle % 360) + 360) % 360;
    const nearestQuarterTurn = Math.round(angleNorm / 90) * 90;
    const isAxisAligned = Math.abs(angleNorm - nearestQuarterTurn) < 0.5;
    if (!isAxisAligned) return { centerX: snappedCenterX, centerY: snappedCenterY };

    const members = getGroupMembersAt(group, snappedCenterX, snappedCenterY);
    if (!members.length) return { centerX: snappedCenterX, centerY: snappedCenterY };

    const bbox = groupBoundingBox(group, members);
    const w = bbox.maxX - bbox.minX;
    const d = bbox.maxY - bbox.minY;
    const snappedCorner = snapToNeighborEdges(bbox.minX, bbox.minY, w, d, { excludeGroupId: group.id });

    return {
      centerX: snappedCenterX + (snappedCorner.x - bbox.minX),
      centerY: snappedCenterY + (snappedCorner.y - bbox.minY)
    };
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

  // ---- Pallet footprint markers ----
  // A pallet marker is a pure visual guide (fixed 48"x40", the standard grocery pallet footprint)
  // -- never part of collision-checking, never blocks or gets blocked by a case/unit. It moves and
  // rotates freely anywhere on (or off) the floor, same drag/rotate-handle interaction as a group,
  // just with no overlap or bounds check on commit.

  function findPallet(palletId) {
    return project.pallets.find(p => p.id === palletId) || null;
  }

  function handleAddPallet() {
    pushUndo(snapshotProject());
    const pallet = {
      id: uid('pallet'),
      centerX: project.footprintWidth / 2,
      centerY: project.footprintDepth / 2,
      angle: 0,
      visible: true
    };
    project.pallets.push(pallet);
    selectedPalletId = pallet.id;
    selectedStackId = null;
    selectedGroupId = null;
    selectedTopper = null;
    multiSelectIds.clear(); multiSelectTopperKeys.clear();
    saveState(state);
    render();
  }

  function handleDuplicatePallet(palletId) {
    const pallet = findPallet(palletId);
    if (!pallet) return;
    pushUndo(snapshotProject());
    const copy = {
      id: uid('pallet'),
      centerX: pallet.centerX + 6,
      centerY: pallet.centerY + 6,
      angle: pallet.angle,
      visible: pallet.visible
    };
    project.pallets.push(copy);
    selectedPalletId = copy.id;
    saveState(state);
    render();
  }

  function handleDeletePallet(palletId) {
    if (!confirm('Delete this pallet marker?')) return;
    pushUndo(snapshotProject());
    project.pallets = project.pallets.filter(p => p.id !== palletId);
    if (selectedPalletId === palletId) selectedPalletId = null;
    saveState(state);
    render();
  }

  function setPalletVisible(palletId, visible) {
    const pallet = findPallet(palletId);
    if (!pallet) return;
    pushUndo(snapshotProject());
    pallet.visible = visible;
    saveState(state);
    render();
  }

  // Same shape as moveGroup/setGroupAngle -- a single real, undo-tracked commit, exposed so the 3D
  // viewer can drive the same persisted data instead of keeping its own parallel copy. No
  // collision/bounds check (a pallet marker is a guide, not a physical object), so these always
  // succeed.
  function movePallet(palletId, centerX, centerY) {
    const pallet = findPallet(palletId);
    if (!pallet) return false;
    const before = snapshotProject();
    pallet.centerX = centerX;
    pallet.centerY = centerY;
    pushUndo(before);
    saveState(state);
    render();
    return true;
  }

  function setPalletAngle(palletId, angle) {
    const pallet = findPallet(palletId);
    if (!pallet) return false;
    const before = snapshotProject();
    pallet.angle = ((angle % 360) + 360) % 360;
    pushUndo(before);
    saveState(state);
    render();
    return true;
  }

  function buildPalletEl(pallet) {
    const el = document.createElement('div');
    el.className = 'grid-pallet' + (pallet.id === selectedPalletId ? ' selected' : '');
    el.dataset.palletId = pallet.id;
    positionGroupMemberEl(el, { footprintW: PALLET_W, footprintD: PALLET_D },
      { x: pallet.centerX, y: pallet.centerY }, pallet.angle);

    el.addEventListener('mousedown', (e) => startPalletMove(e, pallet));
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedPalletId = pallet.id;
      selectedStackId = null;
      selectedGroupId = null;
      selectedTopper = null;
      multiSelectIds.clear(); multiSelectTopperKeys.clear();
      render();
    });

    return el;
  }

  function buildPalletRotateHandleEl(pallet) {
    if (pallet.id !== selectedPalletId) return null;
    const halfDiag = Math.hypot(PALLET_W, PALLET_D) / 2;
    const handle = document.createElement('div');
    handle.className = 'group-rotate-handle';
    handle.style.left = `${pallet.centerX * scale - 8}px`;
    handle.style.top = `${(pallet.centerY - halfDiag) * scale - 28}px`;
    handle.title = 'Drag to rotate the pallet marker';
    handle.addEventListener('mousedown', (e) => startPalletRotate(e, pallet));
    return handle;
  }

  function startPalletMove(e, pallet) {
    e.preventDefault();
    e.stopPropagation();
    dragOp = {
      type: 'pallet-move',
      palletId: pallet.id,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startCenterX: pallet.centerX,
      startCenterY: pallet.centerY,
      beforeSnapshot: snapshotProject(),
      el: document.getElementById('gridCanvas').querySelector(`.grid-pallet[data-pallet-id="${pallet.id}"]`),
      handleEl: document.getElementById('gridCanvas').querySelector('.group-rotate-handle')
    };
  }

  function startPalletRotate(e, pallet) {
    e.preventDefault();
    e.stopPropagation();
    const canvas = document.getElementById('gridCanvas');
    const rect = canvas.getBoundingClientRect();
    dragOp = {
      type: 'pallet-rotate',
      palletId: pallet.id,
      canvasLeft: rect.left,
      canvasTop: rect.top,
      startAngle: pallet.angle,
      beforeSnapshot: snapshotProject(),
      el: canvas.querySelector(`.grid-pallet[data-pallet-id="${pallet.id}"]`),
      handleEl: canvas.querySelector('.group-rotate-handle')
    };
  }

  function liveRepositionPallet(pallet) {
    if (dragOp && dragOp.el) {
      positionGroupMemberEl(dragOp.el, { footprintW: PALLET_W, footprintD: PALLET_D },
        { x: pallet.centerX, y: pallet.centerY }, pallet.angle);
    }
    if (dragOp && dragOp.handleEl) {
      const halfDiag = Math.hypot(PALLET_W, PALLET_D) / 2;
      dragOp.handleEl.style.left = `${pallet.centerX * scale - 8}px`;
      dragOp.handleEl.style.top = `${(pallet.centerY - halfDiag) * scale - 28}px`;
    }
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
      selectedPalletId = null;
      multiSelectIds.clear(); multiSelectTopperKeys.clear();
      render();
    });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      addDuplicateTopItem(stack.items);
    });

    return el;
  }

  // A topper riding on a group member: rotates and translates rigidly with its parent stack. Its
  // world center is the stack's world center plus the topper's own local offset (relative to the
  // stack's center), rotated by the group's angle.
  function buildGroupTopperEl(group, stack, stackWorldCenter, topper) {
    const offsetX = topper.dx + topper.footprintW / 2 - stack.footprintW / 2;
    const offsetY = topper.dy + topper.footprintD / 2 - stack.footprintD / 2;
    const a = (group.angle * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const worldCenter = {
      x: stackWorldCenter.x + offsetX * cos - offsetY * sin,
      y: stackWorldCenter.y + offsetX * sin + offsetY * cos
    };

    const el = document.createElement('div');
    el.className = 'grid-stack grid-topper' + (isTopperSelected(stack.id, topper.id) ? ' selected' : '');
    positionGroupMemberEl(el, { footprintW: topper.footprintW, footprintD: topper.footprintD }, worldCenter, group.angle);

    applySwatchBackground(el, topper.items[topper.items.length - 1]);

    const badge = document.createElement('span');
    badge.className = 'stack-badge';
    badge.textContent = topper.items.length > 1 ? `x${topper.items.length}` : '1';
    el.appendChild(badge);

    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedTopper = { stackId: stack.id, topperId: topper.id };
      selectedStackId = null;
      selectedGroupId = null;
      selectedPalletId = null;
      multiSelectIds.clear(); multiSelectTopperKeys.clear();
      render();
    });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      addDuplicateTopItem(topper.items);
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
    // Toppers ride passively on their parent stack's x/y (see commitStackMove's final position and
    // buildTopperEl's `stack.x + topper.dx`) -- the data was already correct at drop time, but
    // their DOM elements were never touched during the drag itself, only on the full re-render
    // after mouseup. That made a case with units on top look like it wasn't dragging the units at
    // all (they visually stayed put until the drop), even though the end position was always
    // right. Collect them here so handlePointerMove can reposition them live, same as the base.
    const canvas = document.getElementById('gridCanvas');
    const topperEls = Array.from(canvas.querySelectorAll(`.grid-topper[data-parent-stack-id="${stack.id}"]`))
      .map(el => ({ el, topperId: el.dataset.topperId }));
    // The drag can be started from the base stack's own element OR its grab handle (see
    // buildStackGrabHandleEl) -- resolve the real base element explicitly rather than trusting
    // e.currentTarget, since a handle-initiated drag needs to move the base, not the handle.
    const baseEl = canvas.querySelector(`.grid-stack[data-stack-id="${stack.id}"]:not(.grid-topper)`);
    const grabHandleEl = canvas.querySelector(`.stack-grab-handle[data-stack-id="${stack.id}"]`);
    dragOp = {
      type: 'stack-move',
      stackId: stack.id,
      el: baseEl || e.currentTarget,
      grabHandleEl,
      topperEls,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startX: stack.x,
      startY: stack.y,
      beforeSnapshot: snapshotProject()
    };
  }

  // A placed unit (topper) can be picked up and dropped anywhere -- same resolution as a fresh
  // palette drop (resolvePlacement below): back onto its own case at a new spot, onto a different
  // stackable case as a topper there, or onto open floor as its own new standalone stack.
  function startTopperMove(e, stack, topper) {
    e.preventDefault();
    e.stopPropagation();
    const startWorldX = stack.x + topper.dx;
    const startWorldY = stack.y + topper.dy;
    dragOp = {
      type: 'topper-move',
      originStackId: stack.id,
      topperId: topper.id,
      el: e.currentTarget,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startWorldX, startWorldY,
      worldX: startWorldX, worldY: startWorldY,
      beforeSnapshot: snapshotProject()
    };
  }

  function commitStackMove(stack, op) {
    const rawX = snap(stack.x);
    const rawY = snap(stack.y);

    // Same ordering as handleDrop: try landing on a stackable target using the raw drop point
    // before floor-level neighbor-edge-snapping can pull it off that target.
    const placement = stack.toppers.length === 0
      ? resolvePlacement(stack.footprintW, stack.footprintD, rawX, rawY, stack.id)
      : null;

    const { x, y } = placement
      ? { x: rawX, y: rawY }
      : snapToNeighborEdges(rawX, rawY, stack.footprintW, stack.footprintD, stack.id);

    if (!placement && (x < 0 || y < 0 || x + stack.footprintW > project.footprintWidth || y + stack.footprintD > project.footprintDepth)) {
      stack.x = op.startX;
      stack.y = op.startY;
      alert('That placement goes outside the floor footprint. Reverted.');
      render();
      return;
    }

    if (placement && placement.blocked) {
      stack.x = op.startX;
      stack.y = op.startY;
      alert(placement.reason);
      render();
      return;
    }

    if (placement && placement.mode === 'base') {
      // Dropping onto a same-footprint stack merges into it, same as a fresh drag-drop from
      // the palette would -- lets you consolidate stacks by dragging one onto another.
      placement.targetStack.items.push(...stack.items);
      project.stacks = project.stacks.filter(s => s.id !== stack.id);
      if (selectedStackId === stack.id) selectedStackId = placement.targetStack.id;
      pushUndo(op.beforeSnapshot);
      saveState(state);
      render();
      return;
    }

    if (placement && placement.mode === 'merge-topper') {
      placement.topper.items.push(...stack.items);
      project.stacks = project.stacks.filter(s => s.id !== stack.id);
      selectedTopper = { stackId: placement.targetStack.id, topperId: placement.topper.id };
      if (selectedStackId === stack.id) selectedStackId = null;
      pushUndo(op.beforeSnapshot);
      saveState(state);
      render();
      return;
    }

    if (placement && placement.mode === 'new-topper') {
      placement.targetStack.toppers.push({
        id: uid('topper'),
        dx: placement.localX,
        dy: placement.localY,
        footprintW: stack.footprintW, footprintD: stack.footprintD,
        items: stack.items
      });
      project.stacks = project.stacks.filter(s => s.id !== stack.id);
      const newTopper = placement.targetStack.toppers[placement.targetStack.toppers.length - 1];
      selectedTopper = { stackId: placement.targetStack.id, topperId: newTopper.id };
      if (selectedStackId === stack.id) selectedStackId = null;
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

  function commitTopperMove(op) {
    const originStack = project.stacks.find(s => s.id === op.originStackId);
    if (!originStack) return;
    const topperIdx = originStack.toppers.findIndex(t => t.id === op.topperId);
    if (topperIdx === -1) return;
    const topper = originStack.toppers[topperIdx];

    // Pulled out up front so resolving a target against its own former parent (re-landing on the
    // same case at a new spot) doesn't see it as a stale sibling of itself.
    originStack.toppers.splice(topperIdx, 1);

    function revert(message) {
      originStack.toppers.splice(topperIdx, 0, topper);
      if (message) alert(message);
      render();
    }

    const rawX = snap(op.worldX);
    const rawY = snap(op.worldY);
    const placement = resolvePlacement(topper.footprintW, topper.footprintD, rawX, rawY, null);

    if (placement && placement.blocked) {
      revert(placement.reason);
      return;
    }

    const { x, y } = placement
      ? { x: rawX, y: rawY }
      : snapToNeighborEdges(rawX, rawY, topper.footprintW, topper.footprintD, null);

    if (!placement && (x < 0 || y < 0 || x + topper.footprintW > project.footprintWidth || y + topper.footprintD > project.footprintDepth)) {
      revert('That placement goes outside the floor footprint. Reverted.');
      return;
    }

    if (!placement) {
      const droppedCorners = aabbCorners(x, y, topper.footprintW, topper.footprintD);
      if (collidesWithAnything(droppedCorners, { excludeStackId: null, excludeGroupId: null })) {
        revert('That overlaps an existing stack or group. Reverted.');
        return;
      }
    }

    const wasSelected = !!selectedTopper && selectedTopper.stackId === op.originStackId && selectedTopper.topperId === op.topperId;
    if (wasSelected) selectedTopper = null;

    if (placement && placement.mode === 'base') {
      // Lands fully covering a same-footprint case -- merges straight into its base column, same
      // as dragging a fresh matching item from the palette would.
      placement.targetStack.items.push(...topper.items);
      if (wasSelected) selectedStackId = placement.targetStack.id;
    } else if (placement && placement.mode === 'merge-topper') {
      placement.topper.items.push(...topper.items);
      if (wasSelected) selectedTopper = { stackId: placement.targetStack.id, topperId: placement.topper.id };
    } else if (placement && placement.mode === 'new-topper') {
      placement.targetStack.toppers.push({
        id: uid('topper'),
        dx: placement.localX,
        dy: placement.localY,
        footprintW: topper.footprintW, footprintD: topper.footprintD,
        items: topper.items
      });
      const newTopper = placement.targetStack.toppers[placement.targetStack.toppers.length - 1];
      if (wasSelected) selectedTopper = { stackId: placement.targetStack.id, topperId: newTopper.id };
    } else {
      // No stackable target under the drop point -- becomes its own standalone floor stack.
      const newStack = {
        id: uid('stack'),
        x, y,
        footprintW: topper.footprintW,
        footprintD: topper.footprintD,
        items: topper.items,
        toppers: [],
        groupId: null
      };
      project.stacks.push(newStack);
      if (wasSelected) selectedStackId = newStack.id;
    }

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
      if (dragOp.grabHandleEl) {
        dragOp.grabHandleEl.style.left = `${stack.x * scale - 6}px`;
        dragOp.grabHandleEl.style.top = `${stack.y * scale - 6}px`;
      }
      // Toppers ride along at the same live delta -- see startStackMove's comment.
      if (dragOp.topperEls && dragOp.topperEls.length) {
        dragOp.topperEls.forEach(({ el, topperId }) => {
          const topper = stack.toppers.find(t => t.id === topperId);
          if (!topper || !el) return;
          el.style.left = `${(stack.x + topper.dx) * scale}px`;
          el.style.top = `${(stack.y + topper.dy) * scale}px`;
        });
      }
      return;
    }

    if (dragOp.type === 'topper-move') {
      const dxPx = e.clientX - dragOp.startMouseX;
      const dyPx = e.clientY - dragOp.startMouseY;
      dragOp.worldX = dragOp.startWorldX + dxPx / scale;
      dragOp.worldY = dragOp.startWorldY + dyPx / scale;
      if (dragOp.el) {
        dragOp.el.style.left = `${dragOp.worldX * scale}px`;
        dragOp.el.style.top = `${dragOp.worldY * scale}px`;
      }
      return;
    }

    if (dragOp.type === 'pallet-move') {
      const pallet = findPallet(dragOp.palletId);
      if (!pallet) { dragOp = null; return; }
      const dxPx = e.clientX - dragOp.startMouseX;
      const dyPx = e.clientY - dragOp.startMouseY;
      pallet.centerX = dragOp.startCenterX + dxPx / scale;
      pallet.centerY = dragOp.startCenterY + dyPx / scale;
      liveRepositionPallet(pallet);
      return;
    }

    if (dragOp.type === 'pallet-rotate') {
      const pallet = findPallet(dragOp.palletId);
      if (!pallet) { dragOp = null; return; }
      const cx = dragOp.canvasLeft + pallet.centerX * scale;
      const cy = dragOp.canvasTop + pallet.centerY * scale;
      const angleRad = Math.atan2(e.clientY - cy, e.clientX - cx);
      pallet.angle = ((angleRad * 180) / Math.PI + 360) % 360;
      liveRepositionPallet(pallet);
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

  // Abandons an in-progress drag and puts the data back exactly where it started (the "before"
  // snapshot every drag type already carries), then re-renders so the DOM matches.
  function cancelActiveDrag() {
    if (!dragOp || !project) { dragOp = null; return; }
    const op = dragOp;
    dragOp = null;
    if (op.beforeSnapshot) {
      const idx = state.projects.findIndex(p => p.id === op.beforeSnapshot.id);
      if (idx !== -1) {
        state.projects[idx] = op.beforeSnapshot;
        project = op.beforeSnapshot;
      }
    }
    render();
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

    if (dragOp.type === 'topper-move') {
      const op = dragOp;
      dragOp = null;
      const moved = Math.abs(op.worldX - op.startWorldX) > 0.05 || Math.abs(op.worldY - op.startWorldY) > 0.05;
      if (!moved) return;
      commitTopperMove(op);
      return;
    }

    if (dragOp.type === 'pallet-move' || dragOp.type === 'pallet-rotate') {
      const op = dragOp;
      dragOp = null;
      const pallet = findPallet(op.palletId);
      if (!pallet) return;
      const moved = op.type === 'pallet-move' &&
        (Math.abs(pallet.centerX - op.startCenterX) > 0.05 || Math.abs(pallet.centerY - op.startCenterY) > 0.05);
      const rotated = op.type === 'pallet-rotate' && Math.abs(pallet.angle - op.startAngle) > 0.5;
      if (!moved && !rotated) {
        if (op.startCenterX !== undefined) pallet.centerX = op.startCenterX;
        if (op.startCenterY !== undefined) pallet.centerY = op.startCenterY;
        if (op.startAngle !== undefined) pallet.angle = op.startAngle;
        return;
      }
      pushUndo(op.beforeSnapshot);
      saveState(state);
      render();
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

    // Only a real move gets the snap treatment -- during a pure rotate, centerX/centerY are
    // untouched, and snapping them here could nudge the group's position as a surprising side
    // effect of just dialing in an angle.
    const target = op.type === 'move'
      ? snapGroupPosition(group, group.centerX, group.centerY)
      : { centerX: group.centerX, centerY: group.centerY };
    const ok = tryApplyGroupTransform(group, target.centerX, target.centerY, group.angle);
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

    if (multiSelectIds.size + multiSelectTopperKeys.size >= 1) {
      renderMultiSelectPanel(panel);
      return;
    }

    if (selectedGroupId) {
      renderGroupPanel(panel, selectedGroupId);
      return;
    }

    if (selectedPalletId) {
      const pallet = findPallet(selectedPalletId);
      if (pallet) { renderPalletPanel(panel, pallet); return; }
      selectedPalletId = null;
    }

    if (selectedTopper) {
      const stack = project.stacks.find(s => s.id === selectedTopper.stackId);
      const topper = stack && stack.toppers.find(t => t.id === selectedTopper.topperId);
      if (stack && topper) {
        renderTopperPanel(panel, stack, topper);
        return;
      }
      selectedTopper = null;
    }

    const stack = project.stacks.find(s => s.id === selectedStackId && !s.groupId);
    if (!stack) {
      panel.innerHTML = '<p class="empty-state">Click a stack or placed unit on the floor to manage it. Shift+click several (stacks or units) to group them.</p>';
      return;
    }

    renderStackPanel(panel, stack);
  }

  function renderMultiSelectPanel(panel) {
    const wrap = document.createElement('div');
    wrap.className = 'selection-detail';
    const totalSelected = multiSelectIds.size + multiSelectTopperKeys.size;
    const info = document.createElement('p');
    info.className = 'empty-state';
    info.textContent = `${totalSelected} item(s) selected. Shift+click to add or remove more.`;
    wrap.appendChild(info);

    const btnRow = document.createElement('div');
    btnRow.className = 'form-actions';
    const groupBtn = document.createElement('button');
    groupBtn.type = 'button';
    groupBtn.className = 'btn-primary';
    groupBtn.textContent = `Group Selected (${totalSelected})`;
    groupBtn.disabled = totalSelected < 2;
    groupBtn.addEventListener('click', handleGroupSelected);
    btnRow.appendChild(groupBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn-secondary';
    clearBtn.textContent = 'Clear selection';
    clearBtn.addEventListener('click', () => { multiSelectIds.clear(); multiSelectTopperKeys.clear(); render(); });
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

    // A straight +180 to the group's own angle -- same reasoning as the single-stack "face the
    // other direction" flip: rotating a rigid cluster exactly 180 around its own center leaves its
    // bounding-box footprint identical, so it can never introduce a new collision/out-of-bounds
    // case that the current (already-valid) angle didn't already have.
    const flipBtn = document.createElement('button');
    flipBtn.type = 'button';
    flipBtn.className = 'btn-secondary';
    flipBtn.textContent = 'Face the other direction';
    flipBtn.addEventListener('click', () => setGroupAngle(group.id, group.angle + 180));

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

    btnRow.appendChild(flipBtn);
    btnRow.appendChild(ungroupBtn);
    btnRow.appendChild(deleteBtn);
    detail.appendChild(btnRow);

    panel.appendChild(detail);
  }

  function renderPalletPanel(panel, pallet) {
    const detail = document.createElement('div');
    detail.className = 'selection-detail';

    const sizeRow = document.createElement('div');
    sizeRow.className = 'sel-row';
    sizeRow.innerHTML = `<span>Pallet footprint</span><strong>${PALLET_W}"x${PALLET_D}"</strong>`;
    detail.appendChild(sizeRow);

    const visibleLabel = document.createElement('label');
    visibleLabel.style.display = 'flex';
    visibleLabel.style.alignItems = 'center';
    visibleLabel.style.gap = '6px';
    visibleLabel.style.fontSize = '0.85rem';
    visibleLabel.style.color = 'var(--text-dim)';
    const visibleCheckbox = document.createElement('input');
    visibleCheckbox.type = 'checkbox';
    visibleCheckbox.checked = pallet.visible;
    visibleCheckbox.addEventListener('change', () => setPalletVisible(pallet.id, visibleCheckbox.checked));
    visibleLabel.appendChild(visibleCheckbox);
    visibleLabel.appendChild(document.createTextNode('Visible'));
    detail.appendChild(visibleLabel);

    const angleLabel = document.createElement('label');
    angleLabel.textContent = 'Orientation (degrees)';
    angleLabel.style.display = 'flex';
    angleLabel.style.flexDirection = 'column';
    angleLabel.style.gap = '4px';
    angleLabel.style.fontSize = '0.85rem';
    angleLabel.style.color = 'var(--text-dim)';

    const angleInput = document.createElement('input');
    angleInput.type = 'number';
    angleInput.step = '1';
    angleInput.value = Math.round(pallet.angle);
    angleInput.addEventListener('change', () => {
      setPalletAngle(pallet.id, parseFloat(angleInput.value) || 0);
    });
    angleLabel.appendChild(angleInput);
    detail.appendChild(angleLabel);

    const hint = document.createElement('p');
    hint.className = 'empty-state';
    hint.textContent = 'Drag the outline to move it. Drag the small handle above it to rotate freely.';
    detail.appendChild(hint);

    const btnRow = document.createElement('div');
    btnRow.className = 'form-actions';

    const dupBtn = document.createElement('button');
    dupBtn.type = 'button';
    dupBtn.className = 'btn-secondary';
    dupBtn.textContent = 'Duplicate';
    dupBtn.addEventListener('click', () => handleDuplicatePallet(pallet.id));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => handleDeletePallet(pallet.id));

    btnRow.appendChild(dupBtn);
    btnRow.appendChild(deleteBtn);
    detail.appendChild(btnRow);

    panel.appendChild(detail);
  }

  function renderStackPanel(panel, stack) {
    const detail = document.createElement('div');
    detail.className = 'selection-detail';

    const posRow = document.createElement('div');
    posRow.className = 'sel-row';
    posRow.innerHTML = `<span>Position</span><strong>${stack.x.toFixed(1)}", ${stack.y.toFixed(1)}"</strong>`;

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

    const hasToppers = stack.toppers.length > 0;

    const btnRow = document.createElement('div');
    btnRow.className = 'form-actions';

    const removeTopBtn = document.createElement('button');
    removeTopBtn.type = 'button';
    removeTopBtn.className = 'btn-secondary';
    removeTopBtn.textContent = 'Remove top item';
    removeTopBtn.disabled = hasToppers && stack.items.length === 1;
    removeTopBtn.title = removeTopBtn.disabled ? 'Remove the units on top of this stack first.' : '';
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
      const msg = hasToppers
        ? 'This will also remove everything stacked on top of it. Continue?'
        : 'Remove this entire stack from the floor?';
      if (!confirm(msg)) return;
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

    if (hasToppers) {
      const toppersHeader = document.createElement('div');
      toppersHeader.className = 'sel-row';
      toppersHeader.innerHTML = `<span>On top of this stack</span><strong>${stack.toppers.length} item(s)</strong>`;
      detail.appendChild(toppersHeader);

      const toppersList = document.createElement('div');
      toppersList.className = 'selection-items';
      stack.toppers.forEach(topper => {
        const topItem = topper.items[topper.items.length - 1];
        const it = ItemTypes.getItemType(topItem.itemTypeId);
        const sw = resolveSwatch(topItem.itemTypeId, topItem.swatchId);
        const label = topItem.kind === 'case'
          ? (Cases.getCase(topItem.caseId) || {}).name || 'Case'
          : `${it ? it.name : '?'} - ${sw ? sw.name : '?'} (unit)`;
        const row = document.createElement('div');
        row.className = 'sel-item-row';
        row.style.cursor = 'pointer';
        row.innerHTML = `<span>${label}${topper.items.length > 1 ? ` x${topper.items.length}` : ''}</span>`;
        row.addEventListener('click', () => {
          selectedTopper = { stackId: stack.id, topperId: topper.id };
          selectedStackId = null;
          selectedPalletId = null;
          render();
        });
        toppersList.appendChild(row);
      });
      detail.appendChild(toppersList);
    }

    detail.appendChild(btnRow);
    panel.appendChild(detail);
  }

  function renderTopperPanel(panel, stack, topper) {
    const detail = document.createElement('div');
    detail.className = 'selection-detail';

    const parentRow = document.createElement('div');
    parentRow.className = 'sel-row';
    parentRow.innerHTML = `<span>Resting on</span><strong>${stack.footprintW.toFixed(1)}"x${stack.footprintD.toFixed(1)}" stack</strong>`;

    const dimRow = document.createElement('div');
    dimRow.className = 'sel-row';
    dimRow.innerHTML = `<span>Footprint</span><strong>${topper.footprintW.toFixed(1)}"x${topper.footprintD.toFixed(1)}"</strong>`;

    const countRow = document.createElement('div');
    countRow.className = 'sel-row';
    countRow.innerHTML = `<span>Items stacked</span><strong>${topper.items.length}</strong>`;

    const itemsList = document.createElement('div');
    itemsList.className = 'selection-items';
    topper.items.forEach((item, idx) => {
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
      topper.items.pop();
      if (topper.items.length === 0) {
        stack.toppers = stack.toppers.filter(t => t.id !== topper.id);
        selectedTopper = null;
      }
      saveState(state);
      render();
    });

    const deleteTopperBtn = document.createElement('button');
    deleteTopperBtn.type = 'button';
    deleteTopperBtn.className = 'btn-danger';
    deleteTopperBtn.textContent = 'Remove from stack';
    deleteTopperBtn.addEventListener('click', () => {
      if (!confirm('Remove this item from the top of the stack?')) return;
      pushUndo(snapshotProject());
      stack.toppers = stack.toppers.filter(t => t.id !== topper.id);
      selectedTopper = null;
      saveState(state);
      render();
    });

    btnRow.appendChild(removeTopBtn);
    btnRow.appendChild(deleteTopperBtn);

    detail.appendChild(parentRow);
    detail.appendChild(dimRow);
    detail.appendChild(countRow);
    detail.appendChild(itemsList);
    detail.appendChild(btnRow);
    panel.appendChild(detail);
  }

  // ---- Tally ----

  // Every placed item across the floor -- each stack's base column plus everything resting on
  // top of it as a topper.
  function getAllPlacedItems() {
    const items = [];
    project.stacks.forEach(stack => {
      items.push(...stack.items);
      (stack.toppers || []).forEach(topper => items.push(...topper.items));
    });
    return items;
  }

  // Everything ships as whole cases -- units on the floor are just cases someone broke open, not
  // a separate SKU-level concept. So tally by ITEM (item type + swatch), not by which specific
  // Case entity or loose-unit placement produced each one: total up every unit that item
  // contributed (a placed case's full rows*cols*layers, or 1 per loose unit), then convert that
  // total back into whole cases using the item type's own units-per-case. Only a genuine leftover
  // -- units placed that don't add up to one more full case -- gets shown separately; an exact
  // multiple (e.g. two loose 6-packs of a 12-unit case) silently becomes another whole case.
  function computeTally() {
    const bySku = {};

    function ensureRow(key, label) {
      if (!bySku[key]) bySku[key] = { label, totalUnits: 0, unitsPerCase: 0, cost: 0, revenue: 0, missing: 0, missingIsCase: false };
      return bySku[key];
    }

    getAllPlacedItems().forEach(item => {
      if (item.kind === 'case') {
        const c = Cases.getCase(item.caseId);
        const it = c ? ItemTypes.getItemType(c.itemTypeId) : null;
        if (!c || !it) {
          const row = ensureRow(`missing-case-${item.caseId}`, '(deleted case)');
          row.missing += 1;
          row.missingIsCase = true;
          return;
        }
        const sw = it.palette.find(s => s.id === c.swatchId);
        const row = ensureRow(`sku-${it.id}-${c.swatchId}`, `${it.name} - ${sw ? sw.name : '?'}`);
        row.unitsPerCase = it.unitsPerCase;
        const unitsInCase = c.rows * c.cols * c.layers;
        const costPerUnit = it.unitsPerCase > 0 ? it.costPerCase / it.unitsPerCase : 0;
        const marginFraction = Math.min(Math.max(it.marginPct, 0), 99.99) / 100;
        const retailPerUnit = marginFraction < 1 ? costPerUnit / (1 - marginFraction) : 0;
        row.totalUnits += unitsInCase;
        row.cost += costPerUnit * unitsInCase;
        row.revenue += retailPerUnit * unitsInCase;
      } else {
        const it = ItemTypes.getItemType(item.itemTypeId);
        if (!it) {
          const row = ensureRow(`missing-item-${item.itemTypeId}`, '(deleted item type)');
          row.missing += 1;
          row.missingIsCase = false;
          return;
        }
        const sw = it.palette.find(s => s.id === item.swatchId);
        const row = ensureRow(`sku-${it.id}-${item.swatchId}`, `${it.name} - ${sw ? sw.name : '?'}`);
        row.unitsPerCase = it.unitsPerCase;
        const costPerUnit = it.unitsPerCase > 0 ? it.costPerCase / it.unitsPerCase : 0;
        const marginFraction = Math.min(Math.max(it.marginPct, 0), 99.99) / 100;
        const retailPerUnit = marginFraction < 1 ? costPerUnit / (1 - marginFraction) : 0;
        row.totalUnits += 1;
        row.cost += costPerUnit;
        row.revenue += retailPerUnit;
      }
    });

    return Object.values(bySku).map(row => {
      // A deleted case/item-type reference has no unit type to convert against -- keep it as a
      // flat count under whichever column it was originally placed as, same as before.
      if (row.missing) {
        return { label: row.label, cases: row.missingIsCase ? row.missing : 0, looseUnits: row.missingIsCase ? 0 : row.missing, cost: row.cost, revenue: row.revenue };
      }
      let cases = 0, looseUnits = row.totalUnits;
      if (row.unitsPerCase > 0) {
        cases = Math.floor(row.totalUnits / row.unitsPerCase);
        looseUnits = row.totalUnits % row.unitsPerCase;
      }
      return { label: row.label, cases, looseUnits, cost: row.cost, revenue: row.revenue };
    });
  }

  function renderTally() {
    const panel = document.getElementById('gridTallyPanel');
    const rows = computeTally();

    if (rows.length === 0) {
      panel.innerHTML = '<p class="empty-state">Nothing placed on the floor yet.</p>';
      return;
    }

    let totalCost = 0, totalRevenue = 0, totalCases = 0, totalLooseUnits = 0;

    const table = document.createElement('table');
    table.className = 'tally-table';
    table.innerHTML = `
      <thead>
        <tr><th>Item</th><th>Cases</th><th>Loose units</th><th>Cost</th><th>Revenue</th></tr>
      </thead>
      <tbody></tbody>
      <tfoot>
        <tr><td>Total</td><td id="tallyTotalCases"></td><td id="tallyTotalLooseUnits"></td><td id="tallyTotalCost"></td><td id="tallyTotalRevenue"></td></tr>
      </tfoot>
    `;

    const tbody = table.querySelector('tbody');
    rows.forEach(r => {
      totalCost += r.cost;
      totalRevenue += r.revenue;
      totalCases += r.cases;
      totalLooseUnits += r.looseUnits;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.label}</td>
        <td>${r.cases}</td>
        <td>${r.looseUnits > 0 ? r.looseUnits : '—'}</td>
        <td>$${r.cost.toFixed(2)}</td>
        <td>$${r.revenue.toFixed(2)}</td>
      `;
      tbody.appendChild(tr);
    });

    table.querySelector('#tallyTotalCases').textContent = totalCases;
    table.querySelector('#tallyTotalLooseUnits').textContent = totalLooseUnits > 0 ? totalLooseUnits : '—';
    table.querySelector('#tallyTotalCost').textContent = `$${totalCost.toFixed(2)}`;
    table.querySelector('#tallyTotalRevenue').textContent = `$${totalRevenue.toFixed(2)}`;

    panel.innerHTML = '';
    panel.appendChild(table);
  }

  // ---- Print ----

  // Prints the current top-down floor layout with the item tally alongside it on the right, so
  // the printout doubles as a pick list -- "every item in the display, how many of each."
  function handlePrintGrid() {
    if (!project) return;

    const canvas = document.getElementById('gridCanvas');
    const canvasClone = canvas.cloneNode(true);
    canvasClone.querySelectorAll('.grid-drag-preview').forEach(el => el.remove());
    canvasClone.removeAttribute('id'); // avoid a duplicate #gridCanvas id in the new document

    const title = `${project.name || 'Pallet'} - Floor Plan`;
    const tallyHtml = buildTallyTableHtml(computeTally());

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Your browser blocked the print window. Allow pop-ups for this site and try again.');
      return;
    }

    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${new URL('css/style.css', window.location.href).href}">
<style>
  html, body { margin: 0; background: var(--bg, #14161a); }
  body { padding: 24px; display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
  h1 { font-size: 1.1rem; margin: 0 0 12px; color: var(--text, #e8e9ec); }
  .print-tally-wrap { min-width: 320px; }
  .print-tally-empty { color: var(--text-dim); font-size: 0.85rem; }
  @media print {
    body { padding: 0; }
  }
</style>
</head>
<body>
  <div>
    <h1>${escapeHtml(title)} -- ${project.footprintWidth}"W x ${project.footprintDepth}"D</h1>
    <div class="grid-canvas" style="position:relative;flex-shrink:0;width:${canvas.style.width};height:${canvas.style.height};">${canvasClone.innerHTML}</div>
  </div>
  <div class="print-tally-wrap">
    <h1>Items in this display</h1>
    ${tallyHtml}
  </div>
  <script>
    const link = document.querySelector('link[rel="stylesheet"]');
    const go = () => { window.focus(); window.print(); };
    if (link.sheet) go(); else link.addEventListener('load', go);
  <\/script>
</body>
</html>`);
    printWindow.document.close();
  }

  function refresh() {
    // If something outside Grid's own handlers replaced state.projects wholesale (a full backup
    // restore), the previously-loaded project object may no longer be part of it, or
    // activeProjectId may now point elsewhere -- re-derive from current state before rendering
    // rather than trusting a possibly-stale reference. Only resets selection/undo history when
    // the project actually changed underneath it, so a normal tab switch (the common case) stays
    // exactly as cheap and non-disruptive as before.
    const freshProject = state.projects.find(p => p.id === state.activeProjectId) || null;
    if (freshProject !== project) {
      loadActiveProject();
      selectedStackId = null;
      selectedGroupId = null;
      selectedTopper = null;
      selectedPalletId = null;
      multiSelectIds.clear(); multiSelectTopperKeys.clear();
      clearHistory();
    }
    render();
  }

  function getActiveProject() {
    resyncActiveProjectFootprints();
    return project;
  }

  return {
    init, refresh, getActiveProject, getGroupMembers, resolveSwatch, computeTally,
    groupStacks: groupStackIds, setGroupAngle, moveGroup, ungroupStacks: handleUngroup,
    PALLET_W, PALLET_D, movePallet, setPalletAngle, handleDuplicatePallet, handleDeletePallet
  };
})();
