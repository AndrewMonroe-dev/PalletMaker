/* 3D viewer: renders the active project's stacks/groups at real-world scale using Three.js.
   Front face (largest grid-Y / bottom edge of the floor) shows the item's swatch image if it has
   one; every other face shows the swatch's flat color. Supports orbit drag/zoom, placeable image
   panels (draggable to move, with resize/rotate handles when selected), and exporting the current
   view as a PNG. */

const Viewer3D = (() => {
  let state = null;
  let project = null;

  let renderer = null;
  let scene = null;
  let camera = null;
  let animFrameId = null;
  const raycaster = new THREE.Raycaster();

  let azimuth = Math.PI / 4;
  let elevation = Math.PI / 6;
  let radius = 100;

  // ---- Lighting ----
  let dirLight = null;
  let lightAzimuth = 45; // degrees, matches the sliders' default values in index.html
  let lightElevation = 55;

  // ---- Image panel selection/manipulation state ----
  const MIN_PANEL_SIZE = 1; // inches
  let panelMeshMap = {};       // panel id -> its plane mesh, rebuilt every buildScene()
  let selectedPanelId = null;  // ephemeral view state, not persisted
  let selectionOutline = null; // wireframe around the selected panel
  let handleMeshes = null;     // { resize, rotate } spheres for the selected panel
  let dragOp3d = null;         // in-progress orbit/move/resize/rotate drag

  // ---- Stack selection/rotation state (highlight + rotate cases directly in the 3D view) ----
  let stackMeshMap = {};              // three.js object id -> box mesh, rebuilt every buildScene()
  let stackBoxesByStackId = {};       // stack id -> [box mesh, ...], for live-repositioning during rotate
  let selectedStackIds3D = new Set(); // ungrouped stacks multi-selected, awaiting Group Selected
  let selectedGroupId3D = null;       // an existing (or freshly grouped) group selected for rotation
  let stackHighlights = [];           // wireframe outlines around the current selection
  let groupRotateHandle3D = null;     // sphere shown above a selected group's center

  function init(appState) {
    state = appState;
    document.getElementById('viewer3dAddImage').addEventListener('change', handleAddImage);
    document.getElementById('viewer3dExportBtn').addEventListener('click', handleExportImage);
    document.getElementById('viewer3dPrintBtn').addEventListener('click', handlePrintImage);
    document.getElementById('viewer3dLightAzimuth').addEventListener('input', (e) => {
      lightAzimuth = parseFloat(e.target.value) || 0;
      updateLightPosition();
    });
    document.getElementById('viewer3dLightElevation').addEventListener('input', (e) => {
      lightElevation = parseFloat(e.target.value) || 0;
      updateLightPosition();
    });
    bindCanvasInteraction();
    bindWindowResize();
  }

  // The canvas now fills as much of the window as CSS allows (see #viewer3dCanvas's height:82vh),
  // so it needs to track window resizes, not just its size at the moment the scene was built.
  function bindWindowResize() {
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(handleWindowResize, 150);
    });
  }

  function handleWindowResize() {
    if (!project || !renderer || !camera) return;
    const container = document.getElementById('viewer3dCanvas');
    const width = container.clientWidth || 700;
    const height = container.clientHeight || 500;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }

  function bindCanvasInteraction() {
    const container = document.getElementById('viewer3dCanvas');

    container.addEventListener('mousedown', (e) => {
      if (!project || !renderer) return;

      // Handles (if a panel is selected) take priority over panel bodies, which take priority
      // over the empty-space orbit drag -- known simplification: this only hit-tests handles and
      // panel planes, not the item boxes in front of them, so a panel fully hidden behind a box
      // can still be grabbed through it.
      if (handleMeshes) {
        if (raycastObjects(e, [handleMeshes.resize])) { startResizeDrag(e); return; }
        if (raycastObjects(e, [handleMeshes.rotate])) { startRotateDrag(e); return; }
      }

      const panelHit = raycastObjects(e, Object.values(panelMeshMap));
      if (panelHit) {
        startMoveDrag(e, panelHit.object.userData.panelId);
        return;
      }

      if (groupRotateHandle3D && raycastObjects(e, [groupRotateHandle3D])) {
        startGroupRotateDrag3D(e);
        return;
      }

      const stackHit = raycastObjects(e, Object.values(stackMeshMap));
      if (stackHit) {
        startStackInteractionDrag3D(e, stackHit.object.userData.stackId);
        return;
      }

      startOrbitDrag(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragOp3d) return;
      if (dragOp3d.type === 'orbit') doOrbitDrag(e);
      else if (dragOp3d.type === 'move') doMoveDrag(e);
      else if (dragOp3d.type === 'resize') doResizeDrag(e);
      else if (dragOp3d.type === 'rotate') doRotateDrag(e);
      else if (dragOp3d.type === 'group-rotate') doGroupRotateDrag3D(e);
      else if (dragOp3d.type === 'group-move') doGroupMoveDrag3D(e);
    });

    window.addEventListener('mouseup', () => {
      if (!dragOp3d) return;
      const op = dragOp3d;
      dragOp3d = null;
      if (op.type === 'orbit') {
        // A plain click (no real drag) on empty space deselects -- lets you dismiss the handles
        // without hunting for a dedicated close button.
        if (!op.moved) {
          let changed = false;
          if (selectedPanelId) { selectedPanelId = null; removeSelectionVisuals(); changed = true; }
          if (selectedStackIds3D.size > 0 || selectedGroupId3D) {
            selectedStackIds3D.clear();
            selectedGroupId3D = null;
            removeStackHighlights3D();
            removeGroupRotateHandle3D();
            renderSelectionPanel3D();
            changed = true;
          }
        }
        return;
      }
      if (op.type === 'group-rotate') {
        finishGroupRotateDrag3D(op);
        return;
      }
      if (op.type === 'group-move') {
        finishGroupMoveDrag3D(op);
        return;
      }
      if (op.moved) {
        saveState(state);
        refresh();
      }
    });

    container.addEventListener('wheel', (e) => {
      if (!project) return;
      e.preventDefault();
      radius = Math.max(20, radius + e.deltaY * 0.5);
      updateCameraPosition();
    }, { passive: false });
  }

  // ---- Raycasting helpers ----

  function getMouseNDC(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  function raycastObjects(e, objects) {
    if (!objects.length) return null;
    raycaster.setFromCamera(getMouseNDC(e), camera);
    const hits = raycaster.intersectObjects(objects, false);
    return hits.length ? hits[0] : null;
  }

  function raycastPlane(e, plane) {
    raycaster.setFromCamera(getMouseNDC(e), camera);
    const point = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, point) ? point : null;
  }

  // ---- Panel geometry helpers (world-space position/orientation from grid-space panel data) ----

  function panelWorldCenter(panel) {
    return new THREE.Vector3(toSceneX(panel.x), panel.heightOffGround + panel.height / 2, toSceneZ(panel.y));
  }

  // The panel's own rotation, matching mesh.rotation.y = -(panel.rotationY * PI / 180) elsewhere.
  function panelMeshRotationY(panel) {
    return -(panel.rotationY * Math.PI) / 180;
  }

  // Direction the panel's front (originally +Z) faces after rotation -- used only to orient the
  // drag plane, so either of the two possible normal signs works equally well.
  function panelNormal(panel) {
    const theta = panelMeshRotationY(panel);
    return new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
  }

  // The panel's local +X (width) direction after rotation, for decomposing a resize drag.
  function panelRightVector(panel) {
    const theta = panelMeshRotationY(panel);
    return new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
  }

  function buildPanelPlane(panel) {
    return new THREE.Plane().setFromNormalAndCoplanarPoint(panelNormal(panel), panelWorldCenter(panel));
  }

  function findPanel(panelId) {
    return (project.imagePanels || []).find(p => p.id === panelId) || null;
  }

  // ---- Orbit drag (unchanged behavior, just refactored to share one drag-state machine) ----

  function startOrbitDrag(e) {
    dragOp3d = { type: 'orbit', startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
  }

  function doOrbitDrag(e) {
    const dx = e.clientX - dragOp3d.lastX;
    const dy = e.clientY - dragOp3d.lastY;
    dragOp3d.lastX = e.clientX;
    dragOp3d.lastY = e.clientY;
    if (Math.abs(e.clientX - dragOp3d.startX) > 3 || Math.abs(e.clientY - dragOp3d.startY) > 3) dragOp3d.moved = true;
    azimuth -= dx * 0.01;
    elevation = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, elevation + dy * 0.01));
    updateCameraPosition();
  }

  // ---- Move drag: click-and-drag a panel directly, raycast against its own plane so it slides
  // exactly along its mounted surface regardless of camera angle. ----

  function startMoveDrag(e, panelId) {
    const panel = findPanel(panelId);
    if (!panel) return;
    if (selectedPanelId !== panelId) {
      selectedPanelId = panelId;
      rebuildSelectionVisuals();
    }
    const plane = buildPanelPlane(panel);
    dragOp3d = {
      type: 'move', panelId, plane,
      startPoint: raycastPlane(e, plane),
      startPanelX: panel.x, startPanelY: panel.y, startHeightOffGround: panel.heightOffGround,
      moved: false
    };
  }

  function doMoveDrag(e) {
    const panel = findPanel(dragOp3d.panelId);
    const point = raycastPlane(e, dragOp3d.plane);
    if (!panel || !point || !dragOp3d.startPoint) return;
    const delta = point.clone().sub(dragOp3d.startPoint);
    if (delta.length() > 0.05) dragOp3d.moved = true;
    // toSceneX/toSceneZ are plain translations (no rotation), so a world-space delta maps
    // straight onto grid-space x/y regardless of the panel's own rotation.
    panel.x = dragOp3d.startPanelX + delta.x;
    panel.y = dragOp3d.startPanelY + delta.z;
    panel.heightOffGround = Math.max(0, dragOp3d.startHeightOffGround + delta.y);
    liveUpdatePanelTransform(panel);
  }

  // ---- Resize drag: the top-right handle. Width grows about the panel's own center (x/y stay
  // put); height grows upward from the mounted bottom edge (heightOffGround stays put). ----

  function startResizeDrag(e) {
    const panel = findPanel(selectedPanelId);
    if (!panel) return;
    const plane = buildPanelPlane(panel);
    dragOp3d = {
      type: 'resize', panelId: panel.id, plane,
      startPoint: raycastPlane(e, plane),
      startWidth: panel.width, startHeight: panel.height,
      right: panelRightVector(panel),
      moved: false
    };
  }

  function doResizeDrag(e) {
    const panel = findPanel(dragOp3d.panelId);
    const point = raycastPlane(e, dragOp3d.plane);
    if (!panel || !point || !dragOp3d.startPoint) return;
    const delta = point.clone().sub(dragOp3d.startPoint);
    if (delta.length() > 0.05) dragOp3d.moved = true;
    const rightDelta = delta.dot(dragOp3d.right);
    const upDelta = delta.y;
    panel.width = Math.max(MIN_PANEL_SIZE, dragOp3d.startWidth + 2 * rightDelta);
    panel.height = Math.max(MIN_PANEL_SIZE, dragOp3d.startHeight + upDelta);
    liveResizePanelMesh(panel);
  }

  // ---- Rotate drag: the green handle. Angle is the absolute bearing from the panel's center to
  // the cursor (projected onto a horizontal plane through the panel), same "point where you drag"
  // convention as the 2D grid's group rotate handle. ----

  function startRotateDrag(e) {
    const panel = findPanel(selectedPanelId);
    if (!panel) return;
    const centerY = panel.heightOffGround + panel.height / 2;
    dragOp3d = {
      type: 'rotate', panelId: panel.id,
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -centerY),
      moved: false, startRotationY: panel.rotationY,
      startClientX: e.clientX, startClientY: e.clientY
    };
  }

  function doRotateDrag(e) {
    const panel = findPanel(dragOp3d.panelId);
    const point = raycastPlane(e, dragOp3d.plane);
    if (!panel || !point) return;
    const center = panelWorldCenter(panel);
    const dx = point.x - center.x;
    const dz = point.z - center.z;
    if (Math.hypot(dx, dz) < 0.01) return;
    const newRotationY = -(Math.atan2(dx, dz) * 180) / Math.PI;
    // "Moved" has to be real cursor movement in screen space -- comparing the new absolute
    // bearing against the pre-drag rotation would compare two unrelated quantities (a compass
    // direction vs. a persisted angle) and could stay under threshold by coincidence even after a
    // large, real drag, silently dropping the commit on mouseup.
    if (Math.abs(e.clientX - dragOp3d.startClientX) > 3 || Math.abs(e.clientY - dragOp3d.startClientY) > 3) {
      dragOp3d.moved = true;
    }
    panel.rotationY = newRotationY;
    liveRotatePanelMesh(panel);
  }

  // ---- Live visual updates during a drag (cheap mesh mutation -- the real commit, including a
  // proper rebuilt PlaneGeometry for a resize, happens once on mouseup via refresh()). ----

  function liveUpdatePanelTransform(panel) {
    const mesh = panelMeshMap[panel.id];
    const center = panelWorldCenter(panel);
    if (mesh) mesh.position.copy(center);
    if (panel.id === selectedPanelId) {
      if (selectionOutline) selectionOutline.position.copy(center);
      updateHandlePositions(panel);
    }
  }

  function liveResizePanelMesh(panel) {
    const mesh = panelMeshMap[panel.id];
    const center = panelWorldCenter(panel);
    if (mesh) {
      mesh.scale.set(panel.width / mesh.geometry.parameters.width, panel.height / mesh.geometry.parameters.height, 1);
      mesh.position.copy(center);
    }
    if (panel.id === selectedPanelId) {
      if (selectionOutline) {
        selectionOutline.scale.copy(mesh ? mesh.scale : new THREE.Vector3(1, 1, 1));
        selectionOutline.position.copy(center);
      }
      updateHandlePositions(panel);
    }
  }

  function liveRotatePanelMesh(panel) {
    const mesh = panelMeshMap[panel.id];
    const rotY = panelMeshRotationY(panel);
    if (mesh) mesh.rotation.y = rotY;
    if (panel.id === selectedPanelId) {
      if (selectionOutline) selectionOutline.rotation.y = rotY;
      updateHandlePositions(panel);
    }
  }

  // ---- Selection visuals: a wireframe outline plus a resize handle (top-right corner) and a
  // rotate handle (floating just above the panel), rebuilt whenever selection changes. ----

  function rebuildSelectionVisuals() {
    removeSelectionVisuals();
    if (!selectedPanelId) return;
    const panel = findPanel(selectedPanelId);
    if (!panel) { selectedPanelId = null; return; }
    buildSelectionVisuals(panel);
  }

  function removeSelectionVisuals() {
    if (selectionOutline) { scene.remove(selectionOutline); selectionOutline = null; }
    if (handleMeshes) {
      scene.remove(handleMeshes.resize);
      scene.remove(handleMeshes.rotate);
      handleMeshes = null;
    }
  }

  function buildSelectionVisuals(panel) {
    const outlineGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(panel.width, panel.height));
    selectionOutline = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0x3b82f6 }));
    selectionOutline.position.copy(panelWorldCenter(panel));
    selectionOutline.rotation.y = panelMeshRotationY(panel);
    scene.add(selectionOutline);

    const resizeHandle = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x3b82f6 })
    );
    const rotateHandle = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x22c55e })
    );
    handleMeshes = { resize: resizeHandle, rotate: rotateHandle };
    scene.add(resizeHandle);
    scene.add(rotateHandle);
    updateHandlePositions(panel);
  }

  function updateHandlePositions(panel) {
    if (!handleMeshes) return;
    const center = panelWorldCenter(panel);
    const right = panelRightVector(panel);
    const normal = panelNormal(panel);
    const halfW = panel.width / 2;
    const halfH = panel.height / 2;

    handleMeshes.resize.position.copy(
      center.clone().add(right.clone().multiplyScalar(halfW)).add(new THREE.Vector3(0, halfH, 0))
    );
    handleMeshes.rotate.position.copy(
      center.clone().add(new THREE.Vector3(0, halfH + 2, 0)).add(normal.clone().multiplyScalar(0.5))
    );
  }

  // ---- Stack selection, highlighting, and group rotation directly in the 3D view ----
  // Selection lives in this module only (ephemeral, like the panel selection above); the actual
  // grouping and rotation always go through Grid's own group data (project.groups) via its public
  // API, so undo, collision-checking, and the 2D grid all stay perfectly in sync -- 3D never keeps
  // its own parallel copy of what's grouped or how it's rotated.

  function findStack(stackId) {
    return project.stacks.find(s => s.id === stackId) || null;
  }

  // A grouped stack starts a potential move drag immediately on mousedown (selecting the group
  // right away too, so highlight/handle show up even if the mouse never actually moves) -- mirrors
  // the 2D grid's own "mousedown always starts a potential drag; mouseup with no real movement is
  // just a click" pattern. An ungrouped stack has no move support in 3D yet (out of scope -- move
  // it via the 2D grid), so it's still a plain select/multi-select click.
  function startStackInteractionDrag3D(e, stackId) {
    const stack = findStack(stackId);
    if (!stack) return;

    if (stack.groupId) {
      const group = project.groups.find(g => g.id === stack.groupId);
      if (!group) return;

      if (selectedGroupId3D !== group.id) {
        selectedGroupId3D = group.id;
        selectedStackIds3D.clear();
        rebuildSelectionVisuals3D();
      }

      const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      dragOp3d = {
        type: 'group-move',
        groupId: group.id,
        plane: floorPlane,
        startWorldPoint: raycastPlane(e, floorPlane),
        startCenterX: group.centerX,
        startCenterY: group.centerY,
        previewCenterX: group.centerX,
        previewCenterY: group.centerY,
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false
      };
      return;
    }

    handleStackClick3D(stackId, e.shiftKey);
  }

  function handleStackClick3D(stackId, shiftKey) {
    const stack = findStack(stackId);
    if (!stack) return;

    selectedGroupId3D = null;
    if (shiftKey) {
      if (selectedStackIds3D.has(stackId)) selectedStackIds3D.delete(stackId);
      else selectedStackIds3D.add(stackId);
    } else {
      selectedStackIds3D = new Set([stackId]);
    }
    rebuildSelectionVisuals3D();
  }

  // Base-column height plus the tallest topper's own height (toppers start stacking right where
  // the base column ends), for sizing the highlight wireframe around a whole stack.
  function computeStackTotalHeight(stack) {
    const baseHeight = stack.items.reduce((sum, item) => sum + getItemHeight(item), 0);
    let maxTopperHeight = 0;
    (stack.toppers || []).forEach(t => {
      const th = t.items.reduce((sum, item) => sum + getItemHeight(item), 0);
      maxTopperHeight = Math.max(maxTopperHeight, th);
    });
    return baseHeight + maxTopperHeight;
  }

  function addStackHighlight3D(stack, worldCenterGrid, angleDeg) {
    const totalHeight = computeStackTotalHeight(stack) || 1;
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(stack.footprintW, totalHeight, stack.footprintD));
    const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x3b82f6 }));
    mesh.position.set(toSceneX(worldCenterGrid.x), totalHeight / 2, toSceneZ(worldCenterGrid.y));
    mesh.rotation.y = -(angleDeg * Math.PI) / 180;
    scene.add(mesh);
    stackHighlights.push(mesh);
  }

  function removeStackHighlights3D() {
    stackHighlights.forEach(m => scene.remove(m));
    stackHighlights = [];
  }

  function removeGroupRotateHandle3D() {
    if (groupRotateHandle3D) { scene.remove(groupRotateHandle3D); groupRotateHandle3D = null; }
  }

  function addGroupRotateHandle3D(group, members) {
    let maxHeight = 1;
    members.forEach(({ stack }) => { maxHeight = Math.max(maxHeight, computeStackTotalHeight(stack)); });
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.6, Math.min(stackHighlightRadius(group), 1.5)), 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x22c55e })
    );
    mesh.position.set(toSceneX(group.centerX), maxHeight + 3, toSceneZ(group.centerY));
    scene.add(mesh);
    groupRotateHandle3D = mesh;
  }

  // A small, size-aware radius for the rotate handle sphere so it doesn't look absurdly tiny on a
  // large group or absurdly huge on a small one.
  function stackHighlightRadius(group) {
    return Math.max(group.memberIds.length, 1) * 0.15 + 0.6;
  }

  function rebuildSelectionVisuals3D() {
    removeStackHighlights3D();
    removeGroupRotateHandle3D();

    if (selectedGroupId3D) {
      const group = project.groups.find(g => g.id === selectedGroupId3D);
      if (!group) {
        selectedGroupId3D = null;
      } else {
        const members = Grid.getGroupMembers(group);
        members.forEach(({ stack, worldCenter }) => addStackHighlight3D(stack, worldCenter, group.angle));
        addGroupRotateHandle3D(group, members);
      }
    } else {
      selectedStackIds3D.forEach(id => {
        const stack = findStack(id);
        if (stack) {
          addStackHighlight3D(stack, { x: stack.x + stack.footprintW / 2, y: stack.y + stack.footprintD / 2 }, 0);
        }
      });
    }

    renderSelectionPanel3D();
  }

  // Pure function mirroring Grid.getGroupMembers' transform math for a hypothetical center/angle,
  // without touching the group's real (persisted, undo-tracked) values -- used for the live
  // preview during a move or rotate drag so nothing is committed until mouseup.
  function computeGroupMemberWorldCentersAtTransform(group, centerX, centerY, angleDeg) {
    const a = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    return group.memberIds.map(stackId => {
      const m = group.members[stackId];
      return {
        stackId,
        worldCenter: {
          x: centerX + m.dx * cos - m.dy * sin,
          y: centerY + m.dx * sin + m.dy * cos
        }
      };
    });
  }

  function startGroupRotateDrag3D(e) {
    if (!selectedGroupId3D) return;
    const group = project.groups.find(g => g.id === selectedGroupId3D);
    if (!group) return;
    dragOp3d = {
      type: 'group-rotate',
      groupId: group.id,
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      previewAngle: group.angle,
      moved: false,
      startClientX: e.clientX,
      startClientY: e.clientY
    };
  }

  function doGroupRotateDrag3D(e) {
    const group = project.groups.find(g => g.id === dragOp3d.groupId);
    const point = raycastPlane(e, dragOp3d.plane);
    if (!group || !point) return;

    const centerX = toSceneX(group.centerX);
    const centerZ = toSceneZ(group.centerY);
    const dx = point.x - centerX;
    const dz = point.z - centerZ;
    if (Math.hypot(dx, dz) < 0.01) return;

    const angle = -((Math.atan2(dx, dz) * 180) / Math.PI);
    // See doRotateDrag's comment -- "moved" must be real cursor movement in screen space, not a
    // comparison between an absolute bearing and the group's pre-drag angle (unrelated
    // quantities, could stay under threshold by coincidence and silently drop the commit).
    if (Math.abs(e.clientX - dragOp3d.startClientX) > 3 || Math.abs(e.clientY - dragOp3d.startClientY) > 3) {
      dragOp3d.moved = true;
    }
    dragOp3d.previewAngle = angle;

    // Live-reposition the real box meshes (and the highlight/handle) at the preview angle --
    // visual only, group.angle itself is never touched until the drag commits on mouseup.
    const previewMembers = computeGroupMemberWorldCentersAtTransform(group, group.centerX, group.centerY, angle);
    previewMembers.forEach(({ stackId, worldCenter }) => {
      const boxes = stackBoxesByStackId[stackId] || [];
      boxes.forEach(box => {
        box.position.x = toSceneX(worldCenter.x);
        box.position.z = toSceneZ(worldCenter.y);
        box.rotation.y = -(angle * Math.PI) / 180;
      });
    });

    removeStackHighlights3D();
    const members = Grid.getGroupMembers(group).map(({ stack }, i) => ({
      stack,
      worldCenter: previewMembers[i].worldCenter
    }));
    members.forEach(({ stack, worldCenter }) => addStackHighlight3D(stack, worldCenter, angle));
    if (groupRotateHandle3D) {
      let maxHeight = 1;
      members.forEach(({ stack }) => { maxHeight = Math.max(maxHeight, computeStackTotalHeight(stack)); });
      groupRotateHandle3D.position.set(toSceneX(group.centerX), maxHeight + 3, toSceneZ(group.centerY));
    }
  }

  function finishGroupRotateDrag3D(op) {
    if (!op.moved) return;
    // The single real mutation: collision-checked, undo-tracked, and it snapshots the TRUE
    // pre-drag state itself -- nothing above ever touched the persisted group.angle.
    const ok = Grid.setGroupAngle(op.groupId, op.previewAngle);
    if (!ok) alert('That rotation would overlap something else or leave the floor. Reverted.');
    saveState(state);
    refresh();
  }

  // Dragging a selected group's body (any of its member boxes) translates it across the floor --
  // raycast against the floor plane so the group tracks the cursor's real ground position, same
  // "live visuals only, single real commit on mouseup" pattern as rotate.
  function doGroupMoveDrag3D(e) {
    const group = project.groups.find(g => g.id === dragOp3d.groupId);
    const point = raycastPlane(e, dragOp3d.plane);
    if (!group || !point || !dragOp3d.startWorldPoint) return;

    if (Math.abs(e.clientX - dragOp3d.startClientX) > 3 || Math.abs(e.clientY - dragOp3d.startClientY) > 3) {
      dragOp3d.moved = true;
    }

    // toSceneX/toSceneZ are pure translations (no rotation), so a world-space delta maps straight
    // onto grid-space centerX/Y regardless of the group's own rotation.
    const deltaX = point.x - dragOp3d.startWorldPoint.x;
    const deltaZ = point.z - dragOp3d.startWorldPoint.z;
    const newCenterX = dragOp3d.startCenterX + deltaX;
    const newCenterY = dragOp3d.startCenterY + deltaZ;
    dragOp3d.previewCenterX = newCenterX;
    dragOp3d.previewCenterY = newCenterY;

    const previewMembers = computeGroupMemberWorldCentersAtTransform(group, newCenterX, newCenterY, group.angle);
    previewMembers.forEach(({ stackId, worldCenter }) => {
      const boxes = stackBoxesByStackId[stackId] || [];
      boxes.forEach(box => {
        box.position.x = toSceneX(worldCenter.x);
        box.position.z = toSceneZ(worldCenter.y);
      });
    });

    removeStackHighlights3D();
    const members = Grid.getGroupMembers(group).map(({ stack }, i) => ({
      stack,
      worldCenter: previewMembers[i].worldCenter
    }));
    members.forEach(({ stack, worldCenter }) => addStackHighlight3D(stack, worldCenter, group.angle));
    if (groupRotateHandle3D) {
      let maxHeight = 1;
      members.forEach(({ stack }) => { maxHeight = Math.max(maxHeight, computeStackTotalHeight(stack)); });
      groupRotateHandle3D.position.set(toSceneX(newCenterX), maxHeight + 3, toSceneZ(newCenterY));
    }
  }

  function finishGroupMoveDrag3D(op) {
    if (!op.moved) return;
    const ok = Grid.moveGroup(op.groupId, op.previewCenterX, op.previewCenterY);
    if (!ok) alert('That move would overlap something else or leave the floor. Reverted.');
    saveState(state);
    refresh();
  }

  function handleGroupSelectedClick3D() {
    if (selectedStackIds3D.size < 2) return;
    const groupId = Grid.groupStacks(Array.from(selectedStackIds3D));
    if (!groupId) return;
    selectedStackIds3D.clear();
    selectedGroupId3D = groupId;
    refresh();
  }

  function renderSelectionPanel3D() {
    const panel = document.getElementById('viewer3dSelectionPanel');
    if (!panel) return;

    if (selectedGroupId3D) {
      const group = project.groups.find(g => g.id === selectedGroupId3D);
      if (!group) { panel.innerHTML = '<p class="empty-state">Click a case to select it.</p>'; return; }
      panel.innerHTML = `
        <div class="sel-row"><span>Stacks in group</span><strong>${group.memberIds.length}</strong></div>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-dim);">
          Angle (degrees)
          <input type="number" id="viewer3dGroupAngle" step="1" value="${Math.round(group.angle)}">
        </label>
        <p class="empty-state">Drag any case in the group to move it. Drag the green handle above it to rotate freely.</p>
      `;
      document.getElementById('viewer3dGroupAngle').addEventListener('change', (e) => {
        const ok = Grid.setGroupAngle(group.id, parseFloat(e.target.value) || 0);
        if (!ok) alert('That rotation would overlap something else or leave the floor. Reverted.');
        saveState(state);
        refresh();
      });
      return;
    }

    if (selectedStackIds3D.size > 0) {
      panel.innerHTML = `
        <p class="empty-state">${selectedStackIds3D.size} stack(s) selected. Shift+click to add or remove more.</p>
        <div class="form-actions">
          <button type="button" id="viewer3dGroupSelectedBtn" class="btn-primary" ${selectedStackIds3D.size < 2 ? 'disabled' : ''}>Group Selected (${selectedStackIds3D.size})</button>
        </div>
      `;
      document.getElementById('viewer3dGroupSelectedBtn').addEventListener('click', handleGroupSelectedClick3D);
      return;
    }

    panel.innerHTML = '<p class="empty-state">Click a case in the 3D view to select it. Shift+click to select several, then group them to rotate as one.</p>';
  }

  function refresh() {
    project = Grid.getActiveProject();
    const noProjectEl = document.getElementById('viewer3dNoProject');
    const workspaceEl = document.getElementById('viewer3dWorkspace');

    if (!project) {
      noProjectEl.classList.remove('hidden');
      workspaceEl.classList.add('hidden');
      stopRenderLoop();
      return;
    }

    noProjectEl.classList.add('hidden');
    workspaceEl.classList.remove('hidden');

    if (typeof THREE === 'undefined') {
      workspaceEl.innerHTML = '<p class="empty-state-large">Could not load the 3D library (Three.js). Check your internet connection and reload.</p>';
      return;
    }

    buildScene();
    renderPanelList();
    renderTallySummary();
    startRenderLoop();
  }

  function buildScene() {
    const container = document.getElementById('viewer3dCanvas');

    if (renderer) {
      renderer.dispose();
    }
    container.innerHTML = '';

    const width = container.clientWidth || 700;
    const height = container.clientHeight || 500;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c0f);

    camera = new THREE.PerspectiveCamera(45, width / height, 1, 5000);

    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const maxDim = Math.max(project.footprintWidth, project.footprintDepth);

    // Ambient is deliberately low relative to the directional light -- the floor's dark theme
    // color means a shadow only reads as visibly darker when the lit/shadowed contrast is strong;
    // too much ambient fill washes the shadow out to invisible against it.
    scene.add(new THREE.AmbientLight(0xffffff, 0.22));
    dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    dirLight.castShadow = true;
    // Shadow camera frustum sized to comfortably cover the whole floor from any light angle, and
    // far enough to reach the light's own distance (set by updateLightPosition below) plus a
    // margin -- both scale with the project's footprint, not a fixed guess.
    const shadowExtent = maxDim * 0.75;
    dirLight.shadow.camera.left = -shadowExtent;
    dirLight.shadow.camera.right = shadowExtent;
    dirLight.shadow.camera.top = shadowExtent;
    dirLight.shadow.camera.bottom = -shadowExtent;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = maxDim * 5 + 400;
    dirLight.shadow.mapSize.width = 1536;
    dirLight.shadow.mapSize.height = 1536;
    dirLight.shadow.bias = -0.0005;
    // Changing the shadow camera's frustum properties above doesn't take effect until its
    // projection matrix is recomputed -- without this it silently keeps THREE's tiny default
    // (+-5) frustum and the shadow map ends up not actually covering the scene.
    dirLight.shadow.camera.updateProjectionMatrix();
    scene.add(dirLight);
    updateLightPosition();

    const floorGeo = new THREE.PlaneGeometry(project.footprintWidth, project.footprintDepth);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x1d2026, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const divisions = Math.max(1, Math.round(maxDim / 6));
    scene.add(new THREE.GridHelper(maxDim, divisions, 0x444444, 0x2a2d35));

    addStacksToScene();
    addImagePanelsToScene();

    // Selection is ephemeral view state that survives a scene rebuild, but the group/stacks it
    // points at might not (e.g. the group was deleted from the 2D grid) -- validate before
    // rebuilding the highlight/handle visuals against the freshly-built scene.
    if (selectedGroupId3D && !project.groups.some(g => g.id === selectedGroupId3D)) selectedGroupId3D = null;
    selectedStackIds3D.forEach(id => { if (!findStack(id)) selectedStackIds3D.delete(id); });
    rebuildSelectionVisuals3D();

    radius = maxDim * 1.4 + 40;
    updateCameraPosition();
  }

  function toSceneX(gridX) { return gridX - project.footprintWidth / 2; }
  function toSceneZ(gridY) { return gridY - project.footprintDepth / 2; }

  function addStacksToScene() {
    stackMeshMap = {};
    stackBoxesByStackId = {};

    project.stacks.filter(s => !s.groupId).forEach(stack => {
      addStackMeshes(stack, stack.x + stack.footprintW / 2, stack.y + stack.footprintD / 2, 0);
    });

    project.groups.forEach(group => {
      Grid.getGroupMembers(group).forEach(({ stack, worldCenter }) => {
        addStackMeshes(stack, worldCenter.x, worldCenter.y, group.angle);
      });
    });
  }

  function addStackMeshes(stack, centerGridX, centerGridY, angleDeg) {
    const baseHeight = addItemColumn(stack.id, stack.items, centerGridX, centerGridY, angleDeg, 0, stack.footprintW, stack.footprintD);

    // Toppers sit on top of the base column, offset within the stack's own footprint and rotated
    // rigidly with it -- same transform used for their 2D counterpart in grid.js. Tagged with the
    // PARENT stack's id (not a separate topper id) so clicking a topper box selects/rotates the
    // whole stack it rides on, matching how toppers have no independent rotation in the data model.
    (stack.toppers || []).forEach(topper => {
      const offsetX = topper.dx + topper.footprintW / 2 - stack.footprintW / 2;
      const offsetY = topper.dy + topper.footprintD / 2 - stack.footprintD / 2;
      const a = (angleDeg * Math.PI) / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      const topperCenterX = centerGridX + offsetX * cos - offsetY * sin;
      const topperCenterY = centerGridY + offsetX * sin + offsetY * cos;
      addItemColumn(stack.id, topper.items, topperCenterX, topperCenterY, angleDeg, baseHeight, topper.footprintW, topper.footprintD);
    });
  }

  // Renders one vertically-stacked column of items (a stack's base, or a topper's own pile)
  // starting at startHeight, each box at its own real footprint centered on the column. Returns
  // the height the column reached, so a caller can stack something else on top of it. Every box
  // is tagged with its owning stack's id (for click-to-select/highlight/rotate in the 3D view) and
  // recorded in stackBoxesByStackId (for live-repositioning it during a rotate drag).
  function addItemColumn(stackId, items, centerGridX, centerGridY, angleDeg, startHeight, fallbackW, fallbackD) {
    let yCursor = startHeight;
    items.forEach(item => {
      const itemHeight = getItemHeight(item);
      // Each item renders at its own real footprint (centered on the column), not the column's
      // base footprint -- a unit stacked on a case should look like a unit, not stretch to the
      // case's width/depth. Falls back to the column's own footprint if the item's type/case was
      // since deleted (matches the "missing" handling elsewhere).
      const footprint = getItemFootprint(item) || { w: fallbackW, d: fallbackD };
      const sw = Grid.resolveSwatch(item.itemTypeId, item.swatchId);
      const box = buildBoxMesh(footprint.w, itemHeight, footprint.d, sw);
      box.position.set(toSceneX(centerGridX), yCursor + itemHeight / 2, toSceneZ(centerGridY));
      box.rotation.y = -(angleDeg * Math.PI) / 180;
      box.userData.stackId = stackId;
      stackMeshMap[box.id] = box;
      (stackBoxesByStackId[stackId] || (stackBoxesByStackId[stackId] = [])).push(box);
      scene.add(box);
      yCursor += itemHeight;
    });
    return yCursor;
  }

  function getItemHeight(item) {
    if (item.kind === 'case') {
      const c = Cases.getCase(item.caseId);
      const it = c ? ItemTypes.getItemType(c.itemTypeId) : null;
      return (c && it) ? c.rows * it.height : 1;
    }
    const it = ItemTypes.getItemType(item.itemTypeId);
    return it ? it.height : 1;
  }

  function getItemFootprint(item) {
    if (item.kind === 'case') {
      const c = Cases.getCase(item.caseId);
      const it = c ? ItemTypes.getItemType(c.itemTypeId) : null;
      return (c && it) ? { w: c.cols * it.width, d: c.layers * it.depth } : null;
    }
    const it = ItemTypes.getItemType(item.itemTypeId);
    return it ? { w: it.width, d: it.depth } : null;
  }

  function buildBoxMesh(width, height, depth, sw) {
    const color = sw ? sw.color : '#888888';
    const flatMat = new THREE.MeshStandardMaterial({ color });

    // Plain stretch to fill the entire face -- BoxGeometry's default UV mapping already covers
    // each face 0..1, so the image fills every pixel with no cropping, at the cost of distorting
    // its aspect ratio if the face's own proportions differ from the photo's. Same tradeoff
    // applies to the optional side/back images below.
    let frontMat = flatMat;
    if (sw && sw.image) {
      const texture = new THREE.TextureLoader().load(sw.image, (tex) => {
        // The front photo's average color is the fallback for every face that doesn't have its
        // own image -- top/bottom always, side/back if the swatch didn't upload one.
        const avgColor = computeAverageColor(tex.image);
        if (avgColor) flatMat.color.set(avgColor);
      });
      frontMat = new THREE.MeshStandardMaterial({ map: texture });
    }

    const sideMat = (sw && sw.sideImage)
      ? new THREE.MeshStandardMaterial({ map: new THREE.TextureLoader().load(sw.sideImage) })
      : flatMat;
    const backMat = (sw && sw.backImage)
      ? new THREE.MeshStandardMaterial({ map: new THREE.TextureLoader().load(sw.backImage) })
      : flatMat;

    // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z. Front (largest grid-Y) maps to +Z,
    // back maps to -Z, left/right sides share the one uploaded side image (+X/-X).
    const materials = [sideMat, sideMat, flatMat, flatMat, frontMat, backMat];
    const geo = new THREE.BoxGeometry(width, height, depth);
    const mesh = new THREE.Mesh(geo, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true; // a case sitting in another case's shadow should darken too
    return mesh;
  }

  // Samples the average color of an uploaded photo (via an offscreen canvas) so the box's
  // top/side/back faces read as "the color of the product" instead of a separately hand-picked
  // swatch color that may not actually match the photo.
  function computeAverageColor(img) {
    try {
      const size = 16;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
      }
      return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
    } catch (e) {
      return null;
    }
  }

  function addImagePanelsToScene() {
    panelMeshMap = {};
    (project.imagePanels || []).forEach(panel => {
      const texture = new THREE.TextureLoader().load(panel.dataUrl);
      const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true });
      const geo = new THREE.PlaneGeometry(panel.width, panel.height);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(panelWorldCenter(panel));
      mesh.rotation.y = panelMeshRotationY(panel);
      mesh.userData.panelId = panel.id;
      scene.add(mesh);
      panelMeshMap[panel.id] = mesh;
    });

    if (selectedPanelId && !panelMeshMap[selectedPanelId]) selectedPanelId = null;
    rebuildSelectionVisuals();
  }

  function updateCameraPosition() {
    if (!camera || !project) return;
    const targetY = Math.max(project.footprintWidth, project.footprintDepth) / 6;
    camera.position.set(
      radius * Math.sin(azimuth) * Math.cos(elevation),
      targetY + radius * Math.sin(elevation),
      radius * Math.cos(azimuth) * Math.cos(elevation)
    );
    camera.lookAt(0, targetY, 0);
  }

  // Positions the directional light on a sphere around the scene from lightAzimuth/lightElevation
  // (set by the Lighting sliders) -- same spherical setup as updateCameraPosition above, just
  // aimed at the light itself rather than the camera. Its shadow camera automatically tracks this
  // position every frame, so no frustum re-sizing is needed here.
  function updateLightPosition() {
    if (!dirLight || !project) return;
    const maxDim = Math.max(project.footprintWidth, project.footprintDepth);
    const dist = maxDim * 1.5 + 60;
    const targetY = maxDim / 6;
    const azRad = (lightAzimuth * Math.PI) / 180;
    const elRad = (lightElevation * Math.PI) / 180;
    dirLight.position.set(
      dist * Math.sin(azRad) * Math.cos(elRad),
      targetY + dist * Math.sin(elRad),
      dist * Math.cos(azRad) * Math.cos(elRad)
    );
    dirLight.target.position.set(0, targetY, 0);
    dirLight.target.updateMatrixWorld();
  }

  function startRenderLoop() {
    if (animFrameId) return;
    const loop = () => {
      if (renderer && scene && camera) renderer.render(scene, camera);
      animFrameId = requestAnimationFrame(loop);
    };
    animFrameId = requestAnimationFrame(loop);
  }

  function stopRenderLoop() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  // ---- Image panels ----

  function handleAddImage(e) {
    const file = e.target.files[0];
    if (!file || !project) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const panel = {
        id: uid('panel'),
        dataUrl: evt.target.result,
        x: project.footprintWidth / 2,
        y: project.footprintDepth,
        heightOffGround: 0,
        width: 12,
        height: 12,
        rotationY: 0
      };
      project.imagePanels.push(panel);
      selectedPanelId = panel.id; // select it immediately so its move/resize/rotate handles show up
      saveState(state);
      refresh();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function renderPanelList() {
    const listEl = document.getElementById('viewer3dPanelList');
    listEl.innerHTML = '';

    if (!project.imagePanels || project.imagePanels.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No image panels yet.</p>';
      return;
    }

    const fieldDefs = [
      ['X (in)', 'x'], ['Depth pos (in)', 'y'], ['Height off floor (in)', 'heightOffGround'],
      ['Width (in)', 'width'], ['Height (in)', 'height'], ['Rotation (deg)', 'rotationY']
    ];

    project.imagePanels.forEach(panel => {
      const card = document.createElement('div');
      card.className = 'viewer3d-panel-card';

      const img = document.createElement('img');
      img.src = panel.dataUrl;
      card.appendChild(img);

      const fields = document.createElement('div');
      fields.className = 'viewer3d-panel-fields';
      fieldDefs.forEach(([labelText, key]) => {
        const label = document.createElement('label');
        label.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.5';
        input.value = panel[key];
        input.addEventListener('change', () => {
          panel[key] = parseFloat(input.value) || 0;
          saveState(state);
          refresh();
        });
        label.appendChild(input);
        fields.appendChild(label);
      });
      card.appendChild(fields);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-danger';
      delBtn.textContent = 'Remove panel';
      delBtn.addEventListener('click', () => {
        project.imagePanels = project.imagePanels.filter(p => p.id !== panel.id);
        saveState(state);
        refresh();
      });
      card.appendChild(delBtn);

      listEl.appendChild(card);
    });
  }

  // ---- Cost/revenue summary ----

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

  function computeTotals() {
    let totalCost = 0, totalRevenue = 0, totalCases = 0, totalUnits = 0;

    getAllPlacedItems().forEach(item => {
      if (item.kind === 'case') {
          const c = Cases.getCase(item.caseId);
          const it = c ? ItemTypes.getItemType(c.itemTypeId) : null;
          if (c && it) {
            const costPerUnit = it.unitsPerCase > 0 ? it.costPerCase / it.unitsPerCase : 0;
            const marginFraction = Math.min(Math.max(it.marginPct, 0), 99.99) / 100;
            const retailPerUnit = marginFraction < 1 ? costPerUnit / (1 - marginFraction) : 0;
            const unitsInCase = c.rows * c.cols * c.layers;
            totalCost += costPerUnit * unitsInCase;
            totalRevenue += retailPerUnit * unitsInCase;
            totalCases += 1;
            totalUnits += unitsInCase;
          }
      } else {
        const it = ItemTypes.getItemType(item.itemTypeId);
        if (it) {
          const costPerUnit = it.unitsPerCase > 0 ? it.costPerCase / it.unitsPerCase : 0;
          const marginFraction = Math.min(Math.max(it.marginPct, 0), 99.99) / 100;
          const retailPerUnit = marginFraction < 1 ? costPerUnit / (1 - marginFraction) : 0;
          totalCost += costPerUnit;
          totalRevenue += retailPerUnit;
          totalUnits += 1;
        }
      }
    });

    return { totalCost, totalRevenue, totalCases, totalUnits };
  }

  function renderTallySummary() {
    const el = document.getElementById('viewer3dTallySummary');
    const t = computeTotals();
    el.innerHTML = `
      <div>Cases placed: <strong>${t.totalCases}</strong></div>
      <div>Units placed: <strong>${t.totalUnits}</strong></div>
      <div>Total cost: <strong>$${t.totalCost.toFixed(2)}</strong></div>
      <div>Total revenue: <strong>$${t.totalRevenue.toFixed(2)}</strong></div>
    `;
  }

  // ---- Export ----

  function handleExportImage() {
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${(project.name || 'pallet').replace(/[^a-z0-9\-_]+/gi, '_')}_3d.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Prints the current 3D view. A canvas can't be targeted by print CSS directly (and this page
  // has plenty of other on-screen chrome to exclude), so the rendered frame is captured as a PNG
  // and handed to a fresh, print-only document instead -- the browser's print dialog opens
  // automatically once that image has actually loaded.
  // Prints the current 3D render with the item tally alongside it on the right -- same "every
  // item in the display, how many of each" pick-list treatment as the grid's Print button.
  function handlePrintImage() {
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Your browser blocked the print window. Allow pop-ups for this site and try again.');
      return;
    }
    const title = `${project.name || 'Pallet'} - 3D View`;
    const tallyHtml = buildTallyTableHtml(Grid.computeTally());
    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${new URL('css/style.css', window.location.href).href}">
<style>
  html, body { margin: 0; background: var(--bg, #14161a); }
  body { padding: 24px; display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
  h1 { font-size: 1.1rem; margin: 0 0 12px; color: var(--text, #e8e9ec); }
  img { max-width: 900px; width: 100%; height: auto; border: 1px solid var(--border); }
  .print-tally-wrap { min-width: 320px; }
  .print-tally-empty { color: var(--text-dim); font-size: 0.85rem; }
  @media print {
    body { padding: 0; }
    img { max-width: 65%; }
  }
</style>
</head>
<body>
  <div>
    <h1>${escapeHtml(title)}</h1>
    <img src="${dataUrl}" alt="${escapeHtml(title)}">
  </div>
  <div class="print-tally-wrap">
    <h1>Items in this display</h1>
    ${tallyHtml}
  </div>
  <script>
    const link = document.querySelector('link[rel="stylesheet"]');
    const img = document.querySelector('img');
    let ready = 0;
    const go = () => { ready++; if (ready >= 2) { window.focus(); window.print(); } };
    if (link.sheet) go(); else link.addEventListener('load', go);
    if (img.complete) go(); else img.addEventListener('load', go);
  <\/script>
</body>
</html>`);
    printWindow.document.close();
  }

  return { init, refresh };
})();
