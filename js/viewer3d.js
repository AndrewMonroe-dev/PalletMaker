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

  // Render-on-demand: the loop below runs every frame but only pays for an actual GPU render
  // (with shadows, this scene is not cheap) when something visual actually changed since the
  // last one -- a static, unmoved view costs nothing per frame instead of a full render at 60fps
  // forever. markDirty() is the one thing every camera/light/scene/drag mutation needs to call.
  let needsRender = true;
  function markDirty() { needsRender = true; }

  let azimuth = Math.PI / 4;
  let elevation = Math.PI / 6;
  let radius = 100;
  let orbitTargetX = 0; // world-space XZ offset of the orbit pivot, shifted by cursor-centered zoom
  let orbitTargetZ = 0;

  // ---- Lighting ----
  let dirLight = null;
  let lightAzimuth = 45; // degrees, matches the sliders' default values in index.html
  let lightElevation = 55;

  // ---- Second, optional directional light -- off by default so existing projects render
  // identically until the user opts in. Deliberately never casts a shadow: a second shadow-casting
  // light doubles the shadow-map render cost and two overlapping shadow directions from the same
  // object reads as visually confusing (which one is "the" shadow) rather than more realistic --
  // this is meant as a fill/rim light, not a second key light. ----
  let dirLight2 = null;
  let light2Enabled = false;
  let lightAzimuth2 = 225;
  let lightElevation2 = 40;
  let lightIntensity2 = 0.7;

  // ---- Image panel selection/manipulation state ----
  const MIN_PANEL_SIZE = 1; // inches
  let panelMeshMap = {};       // panel id -> its plane mesh, rebuilt every buildScene()
  let selectedPanelId = null;  // ephemeral view state, not persisted
  let selectionOutline = null; // wireframe around the selected panel
  let handleMeshes = null;     // { resize, rotate, depth } handles for the selected panel
  let dragOp3d = null;         // in-progress orbit/move/resize/rotate drag
  const DEPTH_HANDLE_COLOR = 0x22d3ee;      // cyan, at rest
  const DEPTH_HANDLE_HOVER_COLOR = 0xe6b422; // gold, hovered or actively being dragged -- same
                                              // gold token used for multi-select elsewhere in the app
  let depthHandleHovered = false; // so mousemove only touches the material/cursor on a real state change
  let viewerContainerEl = null; // the 3D canvas's container, for cursor styling

  // ---- Stack selection/rotation state (highlight + rotate cases directly in the 3D view) ----
  let stackMeshMap = {};              // three.js object id -> box mesh, rebuilt every buildScene()
  let stackBoxesByStackId = {};       // stack id -> [box mesh, ...], for live-repositioning during rotate
  let selectedStackIds3D = new Set(); // ungrouped stacks multi-selected, awaiting Group Selected
  let selectedGroupId3D = null;       // an existing (or freshly grouped) group selected for rotation
  let stackHighlights = [];           // wireframe outlines around the current selection
  let groupRotateHandle3D = null;     // sphere shown above a selected group's center

  // ---- Pallet footprint marker state (move/rotate directly in the 3D view) ----
  let palletHitMeshMap = {};      // pallet id -> invisible flat hit-test plane, rebuilt every buildScene()
  let palletVisualMap = {};       // pallet id -> { fill, outline } meshes, kept in sync with the hit plane
  let selectedPalletId3D = null;  // ephemeral, mirrors Grid's selectedPalletId but local to this view
  let palletRotateHandle3D = null;

  function init(appState) {
    state = appState;
    document.getElementById('viewer3dAddImage').addEventListener('change', handleAddImage);
    document.getElementById('viewer3dExportBtn').addEventListener('click', handleExportImage);
    document.getElementById('viewer3dPrintBtn').addEventListener('click', handlePrintImage);
    document.getElementById('viewer3dArBtn').addEventListener('click', handleViewInAr);
    document.getElementById('arModalCloseBtn').addEventListener('click', () => {
      document.getElementById('arModal').classList.add('hidden');
    });
    document.getElementById('viewer3dLightAzimuth').addEventListener('input', (e) => {
      lightAzimuth = parseFloat(e.target.value) || 0;
      updateLightPosition();
    });
    document.getElementById('viewer3dLightElevation').addEventListener('input', (e) => {
      lightElevation = parseFloat(e.target.value) || 0;
      updateLightPosition();
    });
    document.getElementById('viewer3dLight2Enabled').addEventListener('change', (e) => {
      light2Enabled = e.target.checked;
      document.getElementById('viewer3dLight2Controls').classList.toggle('hidden', !light2Enabled);
      if (dirLight2) dirLight2.visible = light2Enabled;
      markDirty();
    });
    document.getElementById('viewer3dLight2Azimuth').addEventListener('input', (e) => {
      lightAzimuth2 = parseFloat(e.target.value) || 0;
      updateLight2Position();
    });
    document.getElementById('viewer3dLight2Elevation').addEventListener('input', (e) => {
      lightElevation2 = parseFloat(e.target.value) || 0;
      updateLight2Position();
    });
    document.getElementById('viewer3dLight2Intensity').addEventListener('input', (e) => {
      lightIntensity2 = (parseFloat(e.target.value) || 0) / 100;
      if (dirLight2) dirLight2.intensity = lightIntensity2;
      markDirty();
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
    markDirty();
  }

  function bindCanvasInteraction() {
    const container = document.getElementById('viewer3dCanvas');
    viewerContainerEl = container;

    container.addEventListener('mousedown', (e) => {
      if (!project || !renderer) return;

      // One raycast against EVERY interactive object at once, dispatching on whichever is
      // physically closest to the camera. The previous version tested each kind in a fixed
      // priority order (handles, then panels, then pallet markers, then cases) regardless of
      // depth -- so a case sitting on top of a pallet marker started a pallet drag when clicked,
      // because the marker's hit plane was checked first even though the case was in front of it.
      // Same class of bug as the 2D grid's marker z-order fix, just in 3D.
      const candidates = [];
      if (handleMeshes) {
        candidates.push({ obj: handleMeshes.resize, kind: 'resize' });
        candidates.push({ obj: handleMeshes.rotate, kind: 'rotate' });
        candidates.push({ obj: handleMeshes.depth, kind: 'depth' });
      }
      if (groupRotateHandle3D) candidates.push({ obj: groupRotateHandle3D, kind: 'group-rotate' });
      if (palletRotateHandle3D) candidates.push({ obj: palletRotateHandle3D, kind: 'pallet-rotate' });
      Object.values(panelMeshMap).forEach(obj => candidates.push({ obj, kind: 'panel' }));
      Object.values(palletHitMeshMap).forEach(obj => candidates.push({ obj, kind: 'pallet' }));
      Object.values(stackMeshMap).forEach(obj => candidates.push({ obj, kind: 'stack' }));

      const hit = raycastObjects(e, candidates.map(c => c.obj));
      if (!hit) { startOrbitDrag(e); return; }
      const kind = candidates.find(c => c.obj === hit.object).kind;

      if (kind === 'resize') startResizeDrag(e);
      else if (kind === 'rotate') startRotateDrag(e);
      else if (kind === 'depth') startDepthDrag(e);
      else if (kind === 'group-rotate') startGroupRotateDrag3D(e);
      else if (kind === 'pallet-rotate') startPalletRotateDrag3D(e);
      else if (kind === 'panel') {
        // Shift+drag the image itself moves depth only -- no small handle to hunt for. Plain drag
        // keeps doing x/height exactly as before.
        if (e.shiftKey) startDepthDrag(e, hit.object.userData.panelId);
        else startMoveDrag(e, hit.object.userData.panelId);
      }
      else if (kind === 'pallet') startPalletMoveDrag3D(e, hit.object.userData.palletId);
      else if (kind === 'stack') startStackInteractionDrag3D(e, hit.object.userData.stackId);
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragOp3d) { updateDepthHandleHover(e); return; }
      markDirty(); // every drag type below repositions something visual
      if (dragOp3d.type === 'orbit') doOrbitDrag(e);
      else if (dragOp3d.type === 'move') doMoveDrag(e);
      else if (dragOp3d.type === 'resize') doResizeDrag(e);
      else if (dragOp3d.type === 'rotate') doRotateDrag(e);
      else if (dragOp3d.type === 'depth') doDepthDrag(e);
      else if (dragOp3d.type === 'group-rotate') doGroupRotateDrag3D(e);
      else if (dragOp3d.type === 'group-move') doGroupMoveDrag3D(e);
      else if (dragOp3d.type === 'pallet-move') doPalletMoveDrag3D(e);
      else if (dragOp3d.type === 'pallet-rotate') doPalletRotateDrag3D(e);
    });

    window.addEventListener('mouseup', (e) => {
      if (!dragOp3d) return;
      const op = dragOp3d;
      dragOp3d = null;
      // Whatever branch below runs, re-evaluate hover state against wherever the mouse actually
      // ended up -- otherwise a depth drag (or a plain click that deselected the panel) can leave
      // the handle/cursor stuck in their mid-drag gold/grabbing state.
      try {
        handleMouseUpOp(op, e);
      } finally {
        updateDepthHandleHover(e);
      }
    });

    function handleMouseUpOp(op, e) {
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
          if (selectedPalletId3D) {
            selectedPalletId3D = null;
            removePalletRotateHandle3D();
            renderSelectionPanel3D();
            changed = true;
          }
          if (changed) markDirty();
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
      if (op.type === 'pallet-move') {
        finishPalletMoveDrag3D(op);
        return;
      }
      if (op.type === 'pallet-rotate') {
        finishPalletRotateDrag3D(op);
        return;
      }
      if (op.moved) {
        saveState(state);
        refresh();
      }
    }

    container.addEventListener('wheel', (e) => {
      if (!project || !camera) return;
      e.preventDefault();
      // Zoom toward the point under the cursor rather than the fixed orbit pivot: find where the
      // cursor ray hits the pivot-height plane (using the camera as it is *before* this zoom step),
      // then nudge the pivot itself toward that point by the same fraction the radius is about to
      // shrink -- so that point stays roughly under the cursor after the radius change, instead of
      // the view zooming in/out around the floor's center regardless of where you're pointing.
      const targetY = orbitTargetY();
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -targetY);
      const cursorPoint = raycastPlane(e, plane);
      const oldRadius = radius;
      const newRadius = Math.max(20, radius + e.deltaY * 0.5);
      if (cursorPoint && oldRadius > 0) {
        const factor = 1 - (newRadius / oldRadius);
        orbitTargetX += (cursorPoint.x - orbitTargetX) * factor;
        orbitTargetZ += (cursorPoint.z - orbitTargetZ) * factor;
      }
      radius = newRadius;
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

  // ---- Depth drag: Shift+drag the panel itself (or drag the cyan handle when selected). Plain
  // body-dragging a panel raycasts against the panel's OWN plane (a plane of constant depth), so
  // it can only ever change x/height -- depth can never move that way no matter how you drag. This
  // raycasts against a horizontal floor-parallel plane instead (same convention stacks already
  // use), and only ever applies the resulting Z component -- x is deliberately left alone so this
  // does one thing (depth) without fighting the plain drag's x control. ----

  function startDepthDrag(e, panelId) {
    const targetId = panelId || selectedPanelId;
    const panel = findPanel(targetId);
    if (!panel) return;
    if (selectedPanelId !== targetId) {
      selectedPanelId = targetId;
      rebuildSelectionVisuals();
    }
    const center = panelWorldCenter(panel);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -center.y);
    dragOp3d = {
      type: 'depth', panelId: panel.id, plane,
      startPoint: raycastPlane(e, plane),
      startPanelY: panel.y,
      moved: false
    };
    // Stays gold with a "grabbing" cursor for the whole drag, regardless of where the cursor
    // wanders off to mid-drag (it's dragging a floor-parallel plane, not tracking the cone itself).
    if (handleMeshes) handleMeshes.depth.material.color.setHex(DEPTH_HANDLE_HOVER_COLOR);
    if (viewerContainerEl) viewerContainerEl.style.cursor = 'grabbing';
  }

  function doDepthDrag(e) {
    const panel = findPanel(dragOp3d.panelId);
    const point = raycastPlane(e, dragOp3d.plane);
    if (!panel || !point || !dragOp3d.startPoint) return;
    const deltaZ = point.z - dragOp3d.startPoint.z;
    if (Math.abs(deltaZ) > 0.05) dragOp3d.moved = true;
    panel.y = dragOp3d.startPanelY + deltaZ;
    liveUpdatePanelTransform(panel);
  }

  // Hover-only feedback (no drag in progress): turns the depth handle gold and the cursor to a
  // grab hand the instant the pointer is actually over it, so it's obvious when a click will grab
  // it instead of starting an orbit drag. Cheap to call every idle mousemove -- one raycast against
  // a single small mesh, and it no-ops unless the hovered state actually changed.
  function updateDepthHandleHover(e) {
    if (!handleMeshes || !renderer || !camera) {
      if (depthHandleHovered) { depthHandleHovered = false; if (viewerContainerEl) viewerContainerEl.style.cursor = 'default'; }
      return;
    }
    const hit = raycastObjects(e, [handleMeshes.depth]);
    if (hit && !depthHandleHovered) {
      depthHandleHovered = true;
      handleMeshes.depth.material.color.setHex(DEPTH_HANDLE_HOVER_COLOR);
      if (viewerContainerEl) viewerContainerEl.style.cursor = 'grab';
      markDirty();
    } else if (!hit && depthHandleHovered) {
      depthHandleHovered = false;
      handleMeshes.depth.material.color.setHex(DEPTH_HANDLE_COLOR);
      if (viewerContainerEl) viewerContainerEl.style.cursor = 'default';
      markDirty();
    }
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
    markDirty();
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
      scene.remove(handleMeshes.depth);
      handleMeshes = null;
    }
    // A rebuilt depth handle always starts at its resting cyan color -- reset the hover flag so
    // the next mousemove re-applies gold if the cursor genuinely is still sitting on it (it's a
    // brand new mesh instance every rebuild, not the one the flag was last set against).
    depthHandleHovered = false;
    if (viewerContainerEl) viewerContainerEl.style.cursor = 'default';
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
    // Cyan, sticking straight out of the panel's own face -- pull it toward or away from you to
    // change depth. Distinct color from resize (blue)/rotate (green) and from a cone shape so it
    // reads as "push/pull" rather than another sphere handle to confuse with the other two. Sized
    // noticeably bigger than the resize/rotate spheres -- it was too easy to miss/undershoot.
    const depthHandle = new THREE.Mesh(
      new THREE.ConeGeometry(1.1, 2.6, 12),
      new THREE.MeshBasicMaterial({ color: DEPTH_HANDLE_COLOR })
    );
    handleMeshes = { resize: resizeHandle, rotate: rotateHandle, depth: depthHandle };
    scene.add(resizeHandle);
    scene.add(rotateHandle);
    scene.add(depthHandle);
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
    handleMeshes.depth.position.copy(
      center.clone().add(normal.clone().multiplyScalar(2))
    );
    // Point the cone along the panel's own normal (its default +Y axis rotated to align with it),
    // reinforcing the push/pull direction visually.
    handleMeshes.depth.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
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

  const HIGHLIGHT_BLUE = 0x3b82f6; // a selected group
  const HIGHLIGHT_GOLD = 0xe6b422; // shift+click multi-select, about to be grouped (matches the grid)

  function addStackHighlight3D(stack, worldCenterGrid, angleDeg, color = HIGHLIGHT_BLUE) {
    const totalHeight = computeStackTotalHeight(stack) || 1;
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(stack.footprintW, totalHeight, stack.footprintD));
    const isGold = color === HIGHLIGHT_GOLD;
    const material = new THREE.LineBasicMaterial({ color, transparent: isGold });
    const mesh = new THREE.LineSegments(geo, material);
    mesh.position.set(toSceneX(worldCenterGrid.x), totalHeight / 2, toSceneZ(worldCenterGrid.y));
    mesh.rotation.y = -(angleDeg * Math.PI) / 180;
    if (isGold) mesh.userData.shimmer = true;
    scene.add(mesh);
    stackHighlights.push(mesh);
  }

  // Pulses gold multi-select highlights the same way the grid's CSS gold-shimmer keyframes do
  // (ShelfIntelligence's Bota shimmer: 2.4s ease-in-out, dim<->bright) -- opacity + a gold<->pale
  // gold color lerp standing in for the glow intensity a box-shadow can't express in WebGL.
  const SHIMMER_PERIOD_MS = 2400;
  const SHIMMER_BASE = new THREE.Color(HIGHLIGHT_GOLD);
  const SHIMMER_BRIGHT = new THREE.Color(0xfff3c0);
  function tickShimmer() {
    let any = false;
    for (const mesh of stackHighlights) {
      if (!mesh.userData.shimmer) continue;
      any = true;
      const phase = (performance.now() % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS; // 0..1
      const pulse = (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2; // eases like the CSS 0%/50%/100%
      mesh.material.opacity = 0.55 + pulse * 0.45;
      mesh.material.color.copy(SHIMMER_BASE).lerp(SHIMMER_BRIGHT, pulse * 0.6);
    }
    return any;
  }

  // The angle a stack's own boxes are turned to face. An ungrouped stack is always axis-aligned
  // on the floor (0) unless its facing has been reversed (180); a grouped stack turns with its
  // group AND keeps its own reversal on top of that -- grouping used to silently lose the flip.
  // Deliberately separate from the angle used to POSITION things (see addStackMeshes): a 180
  // turn about a box's own center leaves its footprint identical, so it's safe to apply to the
  // box alone without moving anything else.
  function stackFacingAngle(stack, positionAngle) {
    return positionAngle + (stack.facingFlipped ? 180 : 0);
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
          addStackHighlight3D(stack, { x: stack.x + stack.footprintW / 2, y: stack.y + stack.footprintD / 2 }, 0, HIGHLIGHT_GOLD);
        }
      });
    }

    renderSelectionPanel3D();
    markDirty();
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
      const stack = findStack(stackId);
      const boxes = stackBoxesByStackId[stackId] || [];
      boxes.forEach(box => {
        // Each box remembers its own offset from the stack's center (a topper sits off-center)
        // so the live preview keeps toppers riding in place instead of collapsing every box
        // onto the stack center until the drag commits.
        const off = box.userData.localOffset || { x: 0, y: 0 };
        const a = (angle * Math.PI) / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        box.position.x = toSceneX(worldCenter.x + off.x * cos - off.y * sin);
        box.position.z = toSceneZ(worldCenter.y + off.x * sin + off.y * cos);
        box.rotation.y = -(stackFacingAngle(stack || {}, angle) * Math.PI) / 180;
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
    const a = (group.angle * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    previewMembers.forEach(({ stackId, worldCenter }) => {
      const boxes = stackBoxesByStackId[stackId] || [];
      boxes.forEach(box => {
        const off = box.userData.localOffset || { x: 0, y: 0 };
        box.position.x = toSceneX(worldCenter.x + off.x * cos - off.y * sin);
        box.position.z = toSceneZ(worldCenter.y + off.x * sin + off.y * cos);
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

  // ---- Pallet footprint marker interaction (mirrors the group move/rotate pattern above, but
  // simpler -- a pallet marker is a single flat object with no members and no collision check). ----

  function findPallet3D(palletId) {
    return (project.pallets || []).find(p => p.id === palletId) || null;
  }

  function palletMeshRotationY(pallet) {
    return -(pallet.angle * Math.PI) / 180;
  }

  function palletWorldCenter(pallet) {
    return new THREE.Vector3(toSceneX(pallet.centerX), 0.03, toSceneZ(pallet.centerY));
  }

  function startPalletMoveDrag3D(e, palletId) {
    const pallet = findPallet3D(palletId);
    if (!pallet) return;
    if (selectedPalletId3D !== palletId) {
      selectedPalletId3D = palletId;
      rebuildPalletSelectionVisuals3D();
    }
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    dragOp3d = {
      type: 'pallet-move',
      palletId,
      plane: floorPlane,
      startWorldPoint: raycastPlane(e, floorPlane),
      startCenterX: pallet.centerX,
      startCenterY: pallet.centerY,
      previewCenterX: pallet.centerX,
      previewCenterY: pallet.centerY,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false
    };
  }

  function doPalletMoveDrag3D(e) {
    const pallet = findPallet3D(dragOp3d.palletId);
    const point = raycastPlane(e, dragOp3d.plane);
    if (!pallet || !point || !dragOp3d.startWorldPoint) return;

    if (Math.abs(e.clientX - dragOp3d.startClientX) > 3 || Math.abs(e.clientY - dragOp3d.startClientY) > 3) {
      dragOp3d.moved = true;
    }

    const deltaX = point.x - dragOp3d.startWorldPoint.x;
    const deltaZ = point.z - dragOp3d.startWorldPoint.z;
    dragOp3d.previewCenterX = dragOp3d.startCenterX + deltaX;
    dragOp3d.previewCenterY = dragOp3d.startCenterY + deltaZ;

    liveUpdatePalletTransform(pallet.id, dragOp3d.previewCenterX, dragOp3d.previewCenterY, pallet.angle);
  }

  function finishPalletMoveDrag3D(op) {
    if (!op.moved) return;
    Grid.movePallet(op.palletId, op.previewCenterX, op.previewCenterY);
    refresh();
  }

  function startPalletRotateDrag3D(e) {
    if (!selectedPalletId3D) return;
    const pallet = findPallet3D(selectedPalletId3D);
    if (!pallet) return;
    dragOp3d = {
      type: 'pallet-rotate',
      palletId: pallet.id,
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      previewAngle: pallet.angle,
      moved: false,
      startClientX: e.clientX,
      startClientY: e.clientY
    };
  }

  function doPalletRotateDrag3D(e) {
    const pallet = findPallet3D(dragOp3d.palletId);
    const point = raycastPlane(e, dragOp3d.plane);
    if (!pallet || !point) return;

    const centerX = toSceneX(pallet.centerX);
    const centerZ = toSceneZ(pallet.centerY);
    const dx = point.x - centerX;
    const dz = point.z - centerZ;
    if (Math.hypot(dx, dz) < 0.01) return;

    const angle = -((Math.atan2(dx, dz) * 180) / Math.PI);
    if (Math.abs(e.clientX - dragOp3d.startClientX) > 3 || Math.abs(e.clientY - dragOp3d.startClientY) > 3) {
      dragOp3d.moved = true;
    }
    dragOp3d.previewAngle = angle;

    liveUpdatePalletTransform(pallet.id, pallet.centerX, pallet.centerY, angle);
  }

  function finishPalletRotateDrag3D(op) {
    if (!op.moved) return;
    Grid.setPalletAngle(op.palletId, op.previewAngle);
    refresh();
  }

  // Repositions/rotates the pallet's live meshes (and its handle, if selected) without touching
  // persisted data -- same "preview during drag, one real commit on mouseup" pattern as groups.
  // The fill/outline/hit geometries all have the "lie flat on the floor" tilt baked into the
  // geometry itself (see buildPalletVisuals3D), so mesh.rotation.y is free to be the marker's own
  // spin around the vertical axis -- same convention as an image panel's rotationY.
  function liveUpdatePalletTransform(palletId, centerX, centerY, angleDeg) {
    const visuals = palletVisualMap[palletId];
    const rotY = -(angleDeg * Math.PI) / 180;
    const pos = new THREE.Vector3(toSceneX(centerX), 0.03, toSceneZ(centerY));
    if (visuals) {
      [visuals.fill, visuals.outline].forEach(mesh => {
        mesh.position.copy(pos);
        mesh.rotation.y = rotY;
      });
    }
    const hitMesh = palletHitMeshMap[palletId];
    if (hitMesh) { hitMesh.position.copy(pos); hitMesh.rotation.y = rotY; }
    if (palletId === selectedPalletId3D && palletRotateHandle3D) {
      palletRotateHandle3D.position.set(pos.x, 3, pos.z);
    }
  }

  function removePalletRotateHandle3D() {
    if (palletRotateHandle3D) { scene.remove(palletRotateHandle3D); palletRotateHandle3D = null; }
  }

  function rebuildPalletSelectionVisuals3D() {
    removePalletRotateHandle3D();
    if (selectedPalletId3D) {
      const pallet = findPallet3D(selectedPalletId3D);
      if (!pallet) {
        selectedPalletId3D = null;
      } else {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(1.2, 12, 12),
          new THREE.MeshBasicMaterial({ color: 0x22c55e })
        );
        const center = palletWorldCenter(pallet);
        mesh.position.set(center.x, 3, center.z);
        scene.add(mesh);
        palletRotateHandle3D = mesh;
      }
    }
    renderSelectionPanel3D();
    markDirty();
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
        <div class="form-actions">
          <button type="button" id="viewer3dFlipGroupBtn" class="btn-secondary">Face the other direction</button>
        </div>
        <div class="form-actions">
          <button type="button" id="viewer3dUngroupBtn" class="btn-secondary">Ungroup</button>
        </div>
      `;
      document.getElementById('viewer3dGroupAngle').addEventListener('change', (e) => {
        const ok = Grid.setGroupAngle(group.id, parseFloat(e.target.value) || 0);
        if (!ok) alert('That rotation would overlap something else or leave the floor. Reverted.');
        saveState(state);
        refresh();
      });
      document.getElementById('viewer3dFlipGroupBtn').addEventListener('click', () => {
        // A straight +180 to the group's own angle -- same reasoning as the single-stack "face
        // the other direction" flip: rotating a rigid cluster exactly 180 around its own center
        // leaves its bounding-box footprint identical, so it can't introduce a new collision.
        const ok = Grid.setGroupAngle(group.id, group.angle + 180);
        if (!ok) alert('That rotation would overlap something else or leave the floor. Reverted.');
        saveState(state);
        refresh();
      });
      document.getElementById('viewer3dUngroupBtn').addEventListener('click', () => {
        // Same reasoning as grid.js's handleUngroup: positions don't actually move, but losing
        // the group's highlight the instant it splits reads as the boxes having jumped. Carry the
        // members into this view's own multi-select set so they keep a gold outline across the
        // split (grid.js's own multiSelectIds is set independently, inside handleUngroup itself).
        selectedStackIds3D = new Set(group.memberIds);
        Grid.ungroupStacks(group.id);
        selectedGroupId3D = null;
        refresh();
      });
      return;
    }

    if (selectedPalletId3D) {
      const pallet = findPallet3D(selectedPalletId3D);
      if (!pallet) { panel.innerHTML = '<p class="empty-state">Click a case in the 3D view to select it.</p>'; return; }
      panel.innerHTML = `
        <div class="sel-row"><span>Pallet footprint</span><strong>${Grid.PALLET_W}"x${Grid.PALLET_D}"</strong></div>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-dim);">
          Orientation (degrees)
          <input type="number" id="viewer3dPalletAngle" step="1" value="${Math.round(pallet.angle)}">
        </label>
        <p class="empty-state">Drag the marker to move it. Drag the green handle above it to rotate freely.</p>
        <div class="form-actions">
          <button type="button" id="viewer3dDuplicatePalletBtn" class="btn-secondary">Duplicate</button>
          <button type="button" id="viewer3dDeletePalletBtn" class="btn-danger">Delete</button>
        </div>
      `;
      document.getElementById('viewer3dPalletAngle').addEventListener('change', (e) => {
        Grid.setPalletAngle(pallet.id, parseFloat(e.target.value) || 0);
        refresh();
      });
      document.getElementById('viewer3dDuplicatePalletBtn').addEventListener('click', () => {
        Grid.handleDuplicatePallet(pallet.id);
        refresh();
      });
      document.getElementById('viewer3dDeletePalletBtn').addEventListener('click', () => {
        // If the confirm() inside this is cancelled, project.pallets is unchanged and
        // addPalletsToScene()'s own stale-selection check (on refresh) leaves selectedPalletId3D
        // alone -- no need to special-case the cancel path here.
        Grid.handleDeletePallet(pallet.id);
        refresh();
      });
      return;
    }

    if (selectedStackIds3D.size > 0) {
      // Facing only makes sense for a single ungrouped stack -- a group already has its own free
      // rotation via the drag handle, and "which way does this one face" isn't well-defined for a
      // multi-stack selection that hasn't been grouped yet.
      let facingHtml = '';
      const onlyStack = selectedStackIds3D.size === 1 ? findStack(Array.from(selectedStackIds3D)[0]) : null;
      if (onlyStack) {
        facingHtml = `
          <div class="form-actions">
            <button type="button" id="viewer3dFlipFacingBtn" class="btn-secondary${onlyStack.facingFlipped ? ' active' : ''}">
              ${onlyStack.facingFlipped ? 'Facing reversed — flip back' : 'Face the other direction'}
            </button>
          </div>
        `;
      }
      panel.innerHTML = `
        <p class="empty-state">${selectedStackIds3D.size} stack(s) selected. Shift+click to add or remove more.</p>
        ${facingHtml}
        <div class="form-actions">
          <button type="button" id="viewer3dGroupSelectedBtn" class="btn-primary" ${selectedStackIds3D.size < 2 ? 'disabled' : ''}>Group Selected (${selectedStackIds3D.size})</button>
        </div>
      `;
      if (onlyStack) {
        document.getElementById('viewer3dFlipFacingBtn').addEventListener('click', () => {
          onlyStack.facingFlipped = !onlyStack.facingFlipped;
          saveState(state);
          refresh();
        });
      }
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

  // Frees every geometry/material/texture in a scene before it's discarded. Three.js does NOT do
  // this automatically -- dropping a reference to a Scene just makes it eligible for JS garbage
  // collection, but every buffer it already uploaded to the GPU (geometry, material, and any
  // texture -- item photos included) stays resident in VRAM/driver memory until explicitly
  // disposed. buildScene() used to rebuild the entire scene AND create a brand-new
  // WebGLRenderer/canvas/WebGL-context on every single call (every visit to this tab, every
  // project switch while on it) without ever disposing the previous one's contents -- a real,
  // unbounded leak over a long session that's consistent with a machine needing a hard restart to
  // recover, even a powerful GPU: browsers cap the number of *live* WebGL contexts a page can hold
  // (commonly parseInt in the teens) and force-lose the oldest once exceeded, and the per-frame
  // resources leaked before that point still pin real GPU/driver memory the whole time.
  function disposeSceneContents(oldScene) {
    if (!oldScene) return;
    oldScene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((mat) => {
          Object.keys(mat).forEach((key) => {
            const value = mat[key];
            // Swatch photo textures live in textureCache and are reused across rebuilds -- only
            // dispose textures that aren't cached (image panels, one-offs).
            if (value && value.isTexture && !cachedTextures.has(value)) value.dispose();
          });
          mat.dispose();
        });
      }
      // The shadow-casting light's shadow map is a full 1536x1536 GPU render target allocated by
      // the renderer the first time it draws that light. It is NOT reachable through
      // geometry/material and was silently leaked on every scene rebuild (each rebuild creates a
      // brand-new DirectionalLight) -- ~9MB of VRAM per refresh, and refresh() runs after every
      // 3D drag commit, panel field edit, and tab visit. This is the leak the earlier
      // renderer-reuse fix missed.
      if (obj.isLight && obj.shadow && obj.shadow.map) {
        obj.shadow.map.dispose();
        obj.shadow.map = null;
      }
    });
  }

  // ---- Swatch texture cache ----
  // A rebuild used to call TextureLoader.load() for every box's front/side/back photo -- decoding
  // the same data URL once per box, per rebuild (50 boxes of one SKU = 50 decodes of one photo,
  // every time anything changed). Keyed by the data URL string itself so identical photos share
  // one GPU texture; pruned to what the current build actually references so a deleted swatch's
  // texture doesn't linger forever.
  const textureCache = new Map(); // dataUrl -> THREE.Texture
  const cachedTextures = new Set(); // the same textures, for a fast "is this one cached" check
  let texturesUsedThisBuild = new Set();

  // One promise per cached texture, settled when its photo has decoded (or failed). The spec
  // sheet snapshot awaits these -- rendering before they settle paints every photo face black.
  const textureReady = new Map(); // dataUrl -> Promise

  function getCachedTexture(dataUrl) {
    let tex = textureCache.get(dataUrl);
    if (!tex) {
      // Render-on-demand means a texture finishing its async decode has to explicitly request a
      // repaint -- without markDirty here, photo faces stayed blank until the next orbit/drag
      // happened to trigger a frame.
      let settle;
      textureReady.set(dataUrl, new Promise(resolve => { settle = resolve; }));
      tex = new THREE.TextureLoader().load(dataUrl, () => { markDirty(); settle(); }, undefined, () => settle());
      textureCache.set(dataUrl, tex);
      cachedTextures.add(tex);
    }
    texturesUsedThisBuild.add(dataUrl);
    return tex;
  }

  function pruneTextureCache() {
    textureCache.forEach((tex, dataUrl) => {
      if (!texturesUsedThisBuild.has(dataUrl)) {
        tex.dispose();
        cachedTextures.delete(tex);
        textureCache.delete(dataUrl);
        textureReady.delete(dataUrl);
      }
    });
    texturesUsedThisBuild = new Set();
  }

  function buildScene() {
    const container = document.getElementById('viewer3dCanvas');
    const width = container.clientWidth || 700;
    const height = container.clientHeight || 500;

    // The renderer (and the WebGL context/canvas it owns) is created exactly once and reused for
    // every subsequent rebuild -- see disposeSceneContents' comment above for why recreating it
    // every time was a real leak. Only the Scene itself (lights, floor, meshes) gets rebuilt fresh.
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      container.innerHTML = '';
      container.appendChild(renderer.domElement);
    }
    renderer.setSize(width, height);

    disposeSceneContents(scene);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c0f);

    // The camera object survives rebuilds; only its aspect is refreshed. Recreating it (and
    // resetting radius/orbit target -- see the end of this function) on every refresh() meant
    // the view jumped back to the default zoom/pan after every drag commit and every field edit.
    if (!camera) camera = new THREE.PerspectiveCamera(45, width / height, 1, 5000);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

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

    dirLight2 = new THREE.DirectionalLight(0xffffff, lightIntensity2);
    dirLight2.castShadow = false; // fill light only -- see the state comment above for why
    dirLight2.visible = light2Enabled;
    scene.add(dirLight2);
    updateLight2Position();

    const floorGeo = new THREE.PlaneGeometry(project.footprintWidth, project.footprintDepth);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x1d2026, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    scene.add(buildFloorGrid());

    addStacksToScene();
    addImagePanelsToScene();
    addPalletsToScene();
    pruneTextureCache();

    // Selection is ephemeral view state that survives a scene rebuild, but the group/stacks it
    // points at might not (e.g. the group was deleted from the 2D grid) -- validate before
    // rebuilding the highlight/handle visuals against the freshly-built scene.
    if (selectedGroupId3D && !project.groups.some(g => g.id === selectedGroupId3D)) selectedGroupId3D = null;
    selectedStackIds3D.forEach(id => { if (!findStack(id)) selectedStackIds3D.delete(id); });
    rebuildSelectionVisuals3D();

    // Only reset the view when looking at a different project (or one whose floor size changed)
    // -- otherwise the user's current zoom/pan/orbit is exactly what they want to keep.
    const viewKey = `${project.id}:${project.footprintWidth}x${project.footprintDepth}`;
    if (viewKey !== lastViewKey) {
      lastViewKey = viewKey;
      radius = maxDim * 1.4 + 40;
      orbitTargetX = 0;
      orbitTargetZ = 0;
    }
    updateCameraPosition();
  }

  let lastViewKey = null;

  // Grid lines that actually correspond to the floor: sized exactly to the floor's own width and
  // depth (not a square of the larger dimension centered at the origin, which hung past the short
  // edge and never lined up with the floor's corners), spaced every 6 inches from the floor's
  // top-left corner so every line coincides with one of the 2D grid's 1-inch lines, and lifted a
  // hair above the floor plane so it doesn't z-fight/flicker against it.
  function buildFloorGrid() {
    const w = project.footprintWidth;
    const d = project.footprintDepth;
    const spacing = 6;
    const y = 0.02;
    const points = [];
    for (let x = 0; x <= w + 1e-6; x += spacing) {
      points.push(toSceneX(x), y, toSceneZ(0), toSceneX(x), y, toSceneZ(d));
    }
    for (let z = 0; z <= d + 1e-6; z += spacing) {
      points.push(toSceneX(0), y, toSceneZ(z), toSceneX(w), y, toSceneZ(z));
    }
    // Always close the far edges even when the floor size isn't a multiple of the spacing.
    points.push(toSceneX(w), y, toSceneZ(0), toSceneX(w), y, toSceneZ(d));
    points.push(toSceneX(0), y, toSceneZ(d), toSceneX(w), y, toSceneZ(d));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x3a3e48, transparent: true, opacity: 0.8 }));
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

  // positionAngle is the angle everything is LAID OUT at (0 for a loose stack, the group's angle
  // for a grouped one) -- it drives where toppers sit relative to the base. Every box (base and
  // toppers alike) additionally turns in place by the stack's facing flip (see stackFacingAngle).
  // Passing the flip in as the layout angle, as this used to, spun the toppers 180 degrees AROUND
  // the case center, so units on top of a reversed case showed up on the opposite side from where
  // the 2D grid (which never moves toppers for a flip) had them.
  function addStackMeshes(stack, centerGridX, centerGridY, positionAngle) {
    const faceAngle = stackFacingAngle(stack, positionAngle);
    const baseHeight = addItemColumn(stack.id, stack.items, centerGridX, centerGridY, faceAngle, 0, stack.footprintW, stack.footprintD, { x: 0, y: 0 }, false);

    // Toppers sit on top of the base column, offset within the stack's own footprint and rotated
    // rigidly with it -- same transform used for their 2D counterpart in grid.js. Tagged with the
    // PARENT stack's id (not a separate topper id) so clicking a topper box selects/rotates the
    // whole stack it rides on, matching how toppers have no independent rotation in the data model.
    (stack.toppers || []).forEach(topper => {
      const offsetX = topper.dx + topper.footprintW / 2 - stack.footprintW / 2;
      const offsetY = topper.dy + topper.footprintD / 2 - stack.footprintD / 2;
      const a = (positionAngle * Math.PI) / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      const topperCenterX = centerGridX + offsetX * cos - offsetY * sin;
      const topperCenterY = centerGridY + offsetX * sin + offsetY * cos;
      // Toppers keep their 2D spot on the case (laid out by positionAngle) but each one turns in
      // place with the case's facing, so a reversed case's units show their photo front the same
      // way the case does.
      addItemColumn(stack.id, topper.items, topperCenterX, topperCenterY, faceAngle, baseHeight, topper.footprintW, topper.footprintD, { x: offsetX, y: offsetY }, true);
    });
  }

  // Renders one vertically-stacked column of items (a stack's base, or a topper's own pile)
  // starting at startHeight, each box at its own real footprint centered on the column. Returns
  // the height the column reached, so a caller can stack something else on top of it. Every box
  // is tagged with its owning stack's id (for click-to-select/highlight/rotate in the 3D view) and
  // recorded in stackBoxesByStackId (for live-repositioning it during a rotate drag), along with
  // its un-rotated offset from the stack's center so that live preview can keep toppers in place.
  function addItemColumn(stackId, items, centerGridX, centerGridY, angleDeg, startHeight, fallbackW, fallbackD, localOffset, isTopper) {
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
      box.userData.localOffset = localOffset || { x: 0, y: 0 };
      box.userData.isTopper = !!isTopper;
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
    // The front photo's cached predominant color (sampled once at upload, storage.js) is the
    // fallback for every face without its own image -- top/bottom always, side/back if the swatch
    // didn't upload one. Reading the cached value replaces a per-box, per-rebuild canvas resample
    // of the decoded photo that ran once for every single box on the floor.
    const color = sw ? ((sw.image && sw.avgColor) || sw.color) : '#888888';
    const flatMat = new THREE.MeshStandardMaterial({ color });

    // Plain stretch to fill the entire face -- BoxGeometry's default UV mapping already covers
    // each face 0..1, so the image fills every pixel with no cropping, at the cost of distorting
    // its aspect ratio if the face's own proportions differ from the photo's. Same tradeoff
    // applies to the optional side/back images below.
    const frontMat = (sw && sw.image)
      ? new THREE.MeshStandardMaterial({ map: getCachedTexture(sw.image) })
      : flatMat;
    const sideMat = (sw && sw.sideImage)
      ? new THREE.MeshStandardMaterial({ map: getCachedTexture(sw.sideImage) })
      : flatMat;
    const backMat = (sw && sw.backImage)
      ? new THREE.MeshStandardMaterial({ map: getCachedTexture(sw.backImage) })
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

  function addImagePanelsToScene() {
    panelMeshMap = {};
    (project.imagePanels || []).forEach(panel => {
      const texture = new THREE.TextureLoader().load(panel.dataUrl, () => markDirty());
      // Mirrors the image via UV repeat/offset rather than negating the mesh's scale -- scaling
      // the mesh itself would also flip the winding order (messing with the DoubleSide backface)
      // and would have to be un-done everywhere else that reads panel.width/height as plain
      // positive sizes (resize handle, selection outline, drag math). Flipping the texture mapping
      // instead keeps every one of those untouched.
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.x = panel.flipH ? -1 : 1;
      texture.repeat.y = panel.flipV ? -1 : 1;
      texture.offset.x = panel.flipH ? 1 : 0;
      texture.offset.y = panel.flipV ? 1 : 0;
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

  // Pallet footprint markers: a flat, mostly-transparent white square lying on the floor. The
  // "lie flat" tilt is baked into each geometry (geo.rotateX) rather than applied via mesh.rotation
  // -- see liveUpdatePalletTransform's comment -- so mesh.rotation.y alone can drive the marker's
  // own orientation the same way an image panel's rotationY does.
  function addPalletsToScene() {
    palletHitMeshMap = {};
    palletVisualMap = {};

    (project.pallets || []).filter(p => p.visible).forEach(pallet => {
      const w = Grid.PALLET_W, d = Grid.PALLET_D;
      const rotY = palletMeshRotationY(pallet);
      const center = palletWorldCenter(pallet);

      const fillGeo = new THREE.PlaneGeometry(w, d);
      fillGeo.rotateX(-Math.PI / 2);
      const fillMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.08,
        side: THREE.DoubleSide, depthWrite: false
      });
      const fill = new THREE.Mesh(fillGeo, fillMat);
      fill.position.copy(center);
      fill.rotation.y = rotY;
      fill.userData.palletId = pallet.id;
      scene.add(fill);

      const outlineGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, d));
      outlineGeo.rotateX(-Math.PI / 2);
      const outline = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
      outline.position.copy(center);
      outline.rotation.y = rotY;
      scene.add(outline);

      // A separate, slightly larger invisible plane for raycasting -- the thin LineSegments
      // outline above is unreliable to click precisely, so hit-testing goes through this instead
      // (also used by the fill mesh's own userData.palletId as a fallback, but this is what's
      // actually passed to raycastObjects).
      const hitGeo = new THREE.PlaneGeometry(w, d);
      hitGeo.rotateX(-Math.PI / 2);
      const hitMesh = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      hitMesh.position.copy(center);
      hitMesh.rotation.y = rotY;
      hitMesh.userData.palletId = pallet.id;
      scene.add(hitMesh);

      palletVisualMap[pallet.id] = { fill, outline };
      palletHitMeshMap[pallet.id] = hitMesh;
    });

    if (selectedPalletId3D && !palletHitMeshMap[selectedPalletId3D]) selectedPalletId3D = null;
    rebuildPalletSelectionVisuals3D();
  }

  // Fixed pivot height (unrelated to cursor-centered zoom, which only ever shifts the XZ position).
  function orbitTargetY() {
    return project ? Math.max(project.footprintWidth, project.footprintDepth) / 6 : 0;
  }

  function updateCameraPosition() {
    if (!camera || !project) return;
    const targetY = orbitTargetY();
    camera.position.set(
      orbitTargetX + radius * Math.sin(azimuth) * Math.cos(elevation),
      targetY + radius * Math.sin(elevation),
      orbitTargetZ + radius * Math.cos(azimuth) * Math.cos(elevation)
    );
    camera.lookAt(orbitTargetX, targetY, orbitTargetZ);
    markDirty();
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
    markDirty();
  }

  // Same spherical positioning as updateLightPosition, for the optional second light.
  function updateLight2Position() {
    if (!dirLight2 || !project) return;
    const maxDim = Math.max(project.footprintWidth, project.footprintDepth);
    const dist = maxDim * 1.5 + 60;
    const targetY = maxDim / 6;
    const azRad = (lightAzimuth2 * Math.PI) / 180;
    const elRad = (lightElevation2 * Math.PI) / 180;
    dirLight2.position.set(
      dist * Math.sin(azRad) * Math.cos(elRad),
      targetY + dist * Math.sin(elRad),
      dist * Math.cos(azRad) * Math.cos(elRad)
    );
    dirLight2.target.position.set(0, targetY, 0);
    dirLight2.target.updateMatrixWorld();
    markDirty();
  }

  function startRenderLoop() {
    if (animFrameId) return;
    needsRender = true; // always paint at least once when the loop (re)starts
    const loop = () => {
      if (tickShimmer()) needsRender = true; // keep rendering while any gold highlight is pulsing
      if (needsRender && renderer && scene && camera) {
        renderer.render(scene, camera);
        needsRender = false;
      }
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
    reader.onload = async (evt) => {
      // Downscaled before it's ever stored, same as every swatch photo -- this was the one
      // remaining upload path that kept a full-resolution original, and every one of those
      // rode along inside every project save and (until snapshotProject was fixed) every undo
      // snapshot the grid took.
      const dataUrl = await downscaleImageDataUrl(evt.target.result);
      const panel = {
        id: uid('panel'),
        dataUrl,
        x: project.footprintWidth / 2,
        y: project.footprintDepth,
        heightOffGround: 0,
        width: 12,
        height: 12,
        rotationY: 0,
        flipH: false,
        flipV: false
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

      const flipRow = document.createElement('div');
      flipRow.className = 'viewer3d-panel-flip-row';
      [['flipH', 'Flip Horizontal'], ['flipV', 'Flip Vertical']].forEach(([key, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-secondary';
        btn.classList.toggle('active', !!panel[key]);
        btn.textContent = label;
        btn.addEventListener('click', () => {
          panel[key] = !panel[key];
          saveState(state);
          refresh();
        });
        flipRow.appendChild(btn);
      });
      card.appendChild(flipRow);

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

  // Reuses Grid.computeTally() (single source of truth: everything ships as whole cases, loose
  // units on the floor only count as their own line once they don't add up to one more full
  // case) rather than re-deriving totals here from raw placed items -- this used to duplicate
  // that logic and diverge from it once the case/loose-unit conversion was added there.
  function computeTotals() {
    let totalCost = 0, totalRevenue = 0, totalCases = 0, totalLooseUnits = 0;
    Grid.computeTally().forEach(r => {
      totalCost += r.cost;
      totalRevenue += r.revenue;
      totalCases += r.cases;
      totalLooseUnits += r.looseUnits;
    });
    return { totalCost, totalRevenue, totalCases, totalLooseUnits };
  }

  function renderTallySummary() {
    const el = document.getElementById('viewer3dTallySummary');
    const t = computeTotals();
    el.innerHTML = `
      <div>Total cases: <strong>${t.totalCases}</strong></div>
      <div>Loose units (not a full case): <strong>${t.totalLooseUnits}</strong></div>
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

  // ---- AR export ----

  const IN_TO_M = 0.0254; // glTF/USDZ (and the ARKit/ARCore viewers that consume them) assume
                           // 1 unit = 1 meter, but every mesh in this scene is built in inches.

  // The AR export is built entirely fresh from PROJECT DATA using THREE_AR (three@0.160, loaded
  // separately -- see index.html) rather than cloning meshes from the live interactive `scene`
  // (three@0.128, the UMD build this whole file otherwise runs on). Two reasons, both confirmed
  // live, not theoretical: (1) r0.128's bundled USDZExporter produced a structurally valid but
  // visually broken file -- real iPhone Quick Look rendered every case as flat gray, no texture,
  // because it lacks fixes for documented real-device texture-UV bugs (and proper AR-anchoring
  // scene metadata) that 0.160's exporter has. (2) handing r0.128-constructed Mesh/Texture
  // instances to 0.160's exporters is itself risky -- newer three.js internals (e.g. Texture.source)
  // don't exist on older objects, so reusing live meshes across versions would just trade one
  // breakage for another. Rebuilding from data sidesteps that: it depends only on plain data
  // (project.stacks/groups/imagePanels, swatch colors/images) and the handful of pure-math helpers
  // already in this file (toSceneX/toSceneZ/getItemFootprint/getItemHeight/etc.), none of which
  // are tied to either three.js instance.

  function loadArTexture(dataUrl) {
    if (!dataUrl) return Promise.resolve(null);
    return new Promise((resolve) => {
      new THREE_AR.TextureLoader().load(dataUrl, resolve, undefined, () => resolve(null));
    });
  }

  // Bakes the inches-to-meters conversion into an object's OWN local position/scale (not a
  // parent-level scale on the scene) -- confirmed live (by unzipping an exported .usdz, which is
  // just a zip archive holding a plain-text model.usda, and reading the raw coordinates) that
  // USDZExporter ignores a parent Object3D's transform entirely and only ever bakes each
  // individual mesh's own local matrix.
  function scaleForAr(object) {
    object.position.multiplyScalar(IN_TO_M);
    object.scale.multiplyScalar(IN_TO_M);
    // Mutating position/scale alone doesn't recompute .matrix or .matrixWorld -- those normally
    // only get (re)computed during a renderer.render() traversal, which this orphan export scene
    // never gets. USDZExporter specifically reads object.matrixWorld (confirmed against its own
    // source), so without forcing this recompute the change above silently has zero effect on the
    // exported file.
    object.updateMatrixWorld(true);
    return object;
  }

  // One box mesh for the AR export -- same "front photo if the swatch has one, otherwise its flat
  // color" idea as the live buildBoxMesh, but collapsed to a single material covering every face
  // (AR here is about checking real-world scale/fit, not per-face photorealism, and USDZExporter
  // only supports one material per mesh at all).
  async function buildArBoxMesh(width, height, depth, sw) {
    const mat = new THREE_AR.MeshStandardMaterial({ color: sw ? sw.color : 0x888888 });
    if (sw && sw.image) {
      const tex = await loadArTexture(sw.image);
      // MeshStandardMaterial's color is a MULTIPLICATIVE tint over the map, not just a fallback
      // for when there's no texture -- leaving it at the swatch's own base color (a saturated
      // default red for a never-recolored swatch) tinted every photo red once a map was added.
      // The live buildBoxMesh avoids this by never setting a color at all when there's a map
      // (defaults to white); reset explicitly here since this material was already constructed
      // with the swatch color above, for the no-photo fallback case.
      if (tex) { mat.map = tex; mat.color.set(0xffffff); }
    }
    const mesh = new THREE_AR.Mesh(new THREE_AR.BoxGeometry(width, height, depth), mat);
    return mesh;
  }

  // Mirrors addItemColumn's stacking math (grid.js/viewer3d.js's live version), adding each box
  // straight into the export scene as it goes.
  async function buildArItemColumn(exportScene, items, centerGridX, centerGridY, angleDeg, startHeight, fallbackW, fallbackD) {
    let yCursor = startHeight;
    for (const item of items) {
      const itemHeight = getItemHeight(item);
      const footprint = getItemFootprint(item) || { w: fallbackW, d: fallbackD };
      const sw = Grid.resolveSwatch(item.itemTypeId, item.swatchId);
      const mesh = await buildArBoxMesh(footprint.w, itemHeight, footprint.d, sw);
      mesh.position.set(toSceneX(centerGridX), yCursor + itemHeight / 2, toSceneZ(centerGridY));
      mesh.rotation.y = -(angleDeg * Math.PI) / 180;
      exportScene.add(scaleForAr(mesh));
      yCursor += itemHeight;
    }
    return yCursor;
  }

  // Mirrors addStackMeshes: the base column, then any toppers riding on top of it, offset within
  // the stack's own footprint and rotated rigidly with it -- same transform as everywhere else
  // toppers are positioned in this file.
  async function buildArStackMeshes(exportScene, stack, centerGridX, centerGridY, positionAngle) {
    // Same position-vs-facing split as the live addStackMeshes.
    const faceAngle = stackFacingAngle(stack, positionAngle);
    const baseHeight = await buildArItemColumn(exportScene, stack.items, centerGridX, centerGridY, faceAngle, 0, stack.footprintW, stack.footprintD);
    for (const topper of (stack.toppers || [])) {
      const offsetX = topper.dx + topper.footprintW / 2 - stack.footprintW / 2;
      const offsetY = topper.dy + topper.footprintD / 2 - stack.footprintD / 2;
      const a = (positionAngle * Math.PI) / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      const topperCenterX = centerGridX + offsetX * cos - offsetY * sin;
      const topperCenterY = centerGridY + offsetX * sin + offsetY * cos;
      await buildArItemColumn(exportScene, topper.items, topperCenterX, topperCenterY, faceAngle, baseHeight, topper.footprintW, topper.footprintD);
    }
  }

  async function buildArImagePanel(panel) {
    const mat = new THREE_AR.MeshStandardMaterial({ color: 0xffffff, side: THREE_AR.DoubleSide });
    const tex = await loadArTexture(panel.dataUrl);
    if (tex) {
      // Same UV-mirror trick as the live Flip Horizontal/Vertical panel controls.
      tex.wrapS = THREE_AR.RepeatWrapping;
      tex.wrapT = THREE_AR.RepeatWrapping;
      tex.repeat.x = panel.flipH ? -1 : 1;
      tex.repeat.y = panel.flipV ? -1 : 1;
      tex.offset.x = panel.flipH ? 1 : 0;
      tex.offset.y = panel.flipV ? 1 : 0;
      mat.map = tex;
    }
    const mesh = new THREE_AR.Mesh(new THREE_AR.PlaneGeometry(panel.width, panel.height), mat);
    mesh.position.set(toSceneX(panel.x), panel.heightOffGround + panel.height / 2, toSceneZ(panel.y));
    mesh.rotation.y = -(panel.rotationY * Math.PI) / 180;
    return mesh;
  }

  async function buildArExportScene() {
    if (!project) return null;
    const exportScene = new THREE_AR.Scene();

    const floor = new THREE_AR.Mesh(
      new THREE_AR.PlaneGeometry(project.footprintWidth, project.footprintDepth),
      new THREE_AR.MeshStandardMaterial({ color: 0x1d2026, side: THREE_AR.DoubleSide })
    );
    floor.rotation.x = -Math.PI / 2;
    exportScene.add(scaleForAr(floor));

    for (const stack of project.stacks.filter(s => !s.groupId)) {
      await buildArStackMeshes(exportScene, stack, stack.x + stack.footprintW / 2, stack.y + stack.footprintD / 2, 0);
    }
    for (const group of project.groups) {
      for (const { stack, worldCenter } of Grid.getGroupMembers(group)) {
        await buildArStackMeshes(exportScene, stack, worldCenter.x, worldCenter.y, group.angle);
      }
    }
    for (const panel of (project.imagePanels || [])) {
      const mesh = await buildArImagePanel(panel);
      exportScene.add(scaleForAr(mesh));
    }

    return exportScene;
  }

  function exportGlb(exportScene) {
    return new Promise((resolve, reject) => {
      const exporter = new GLTFExporter();
      exporter.parse(
        exportScene,
        (result) => resolve(new Blob([result], { type: 'model/gltf-binary' })),
        (err) => reject(err),
        { binary: true }
      );
    });
  }

  function exportUsdz(exportScene) {
    return new Promise((resolve, reject) => {
      const exporter = new USDZExporter();
      // quickLookCompatible works around documented, still-open Apple bugs (FB10036297,
      // FB11442287) in how real iPhone Quick Look interprets texture UV repeat/offset -- without
      // it, textures can render subtly misaligned on-device even though they look correct in any
      // spec-compliant USD viewer (including the desktop preview here).
      exporter.parse(exportScene, { quickLookCompatible: true })
        .then(result => resolve(new Blob([result], { type: 'model/vnd.usdz+zip' })))
        .catch(reject);
    });
  }

  async function handleViewInAr() {
    if (!project) return;
    if (typeof THREE_AR === 'undefined' || typeof GLTFExporter === 'undefined' || typeof USDZExporter === 'undefined' || !customElements.get('model-viewer')) {
      alert('The AR export libraries failed to load (check your internet connection) and try again.');
      return;
    }

    const noteEl = document.getElementById('arExportNote');
    noteEl.style.display = 'block';
    noteEl.textContent = 'Building 3D model...';
    const btn = document.getElementById('viewer3dArBtn');
    btn.disabled = true;

    try {
      const exportScene = await buildArExportScene();
      if (!exportScene) return;

      // Both formats are built up front (not lazily per-platform) since there's no reliable way
      // from inside the browser to know in advance whether the phone that opens this modal is an
      // iPhone (needs ios-src="*.usdz" for Quick Look) or Android (needs src="*.glb" for Scene
      // Viewer/WebXR) -- model-viewer itself picks the right one at AR-launch time.
      const [glbBlob, usdzBlob] = await Promise.all([exportGlb(exportScene), exportUsdz(exportScene)]);

      const mv = document.getElementById('arModelViewer');
      if (mv.dataset.glbUrl) URL.revokeObjectURL(mv.dataset.glbUrl);
      if (mv.dataset.usdzUrl) URL.revokeObjectURL(mv.dataset.usdzUrl);
      const glbUrl = URL.createObjectURL(glbBlob);
      const usdzUrl = URL.createObjectURL(usdzBlob);
      mv.dataset.glbUrl = glbUrl;
      mv.dataset.usdzUrl = usdzUrl;
      mv.setAttribute('src', glbUrl);
      mv.setAttribute('ios-src', usdzUrl);

      noteEl.textContent = '';
      noteEl.style.display = 'none';
      document.getElementById('arModal').classList.remove('hidden');
    } catch (err) {
      console.error(err);
      alert('Building the AR model failed: ' + (err && err.message ? err.message : err));
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Spec sheet support ----
  // Lets grid.js pull a stack's real-world height and a reference 3D image without the 3D tab
  // ever having been opened this session -- both needed for the combined build spec sheet, which
  // lives on the Grid tab.

  function getStackHeight(stack) {
    return computeStackTotalHeight(stack);
  }

  // Renders one fresh frame straight from project data and returns it as a PNG data URL, building
  // the scene first if it doesn't exist yet (or belongs to a different project) -- same lazy
  // buildScene() the 3D tab itself uses on first visit, just without starting the continuous
  // render loop, so this never leaves background rendering running the way visiting the tab does.
  //
  // The shot is always the same regardless of how the user last left the 3D tab: straight on from
  // the front (azimuth 0 is +Z, the side the product photos face), slightly above, key light also
  // from the front so the faces are fully lit, framed on the placed cases rather than the whole
  // floor, at print resolution. Every view/light setting it touches is put back afterwards.
  // Waits for a set of promises, but never longer than ms -- a photo whose decode callback never
  // fires (corrupt data, browser quirk) must not be able to hang the caller forever.
  function settleWithTimeout(promises, ms) {
    return Promise.race([
      Promise.all(promises),
      new Promise(resolve => setTimeout(resolve, ms))
    ]);
  }

  async function captureSnapshot() {
    if (typeof THREE === 'undefined') return null;
    project = Grid.getActiveProject();
    if (!project) return null;
    try {
      buildScene();
    } catch (e) {
      console.error('Spec sheet: building the 3D scene failed.', e);
      return null;
    }
    // Photo faces are async textures; on a fresh session none have decoded yet at this point.
    // Bounded so one stuck photo can't hang the whole spec sheet indefinitely.
    await settleWithTimeout(Array.from(textureReady.values()), 4000);

    if (!renderer || !scene || !camera || !dirLight) return null;
    const saved = { azimuth, elevation, radius, orbitTargetX, orbitTargetZ, lightAzimuth, lightElevation, intensity: dirLight.intensity };
    const savedSize = new THREE.Vector2();
    renderer.getSize(savedSize);

    // Every mutation below is restored in `finally` -- a thrown error partway through (a bad
    // project shape, a WebGL error) must never leave the live 3D tab's camera/light/renderer
    // stuck at spec-sheet framing, which is what made the app look frozen: the camera/renderer
    // stayed set to the still frame's size/angle while the interactive render loop kept running.
    try {
      // Frame what's actually on the floor. Grouped stacks live at their group-rotated centers.
      const centers = [];
      project.stacks.filter(s => !s.groupId).forEach(s => centers.push({ x: s.x + s.footprintW / 2, y: s.y + s.footprintD / 2, r: Math.max(s.footprintW, s.footprintD) / 2, h: computeStackTotalHeight(s) }));
      project.groups.forEach(g => Grid.getGroupMembers(g).forEach(({ stack, worldCenter }) => centers.push({ x: worldCenter.x, y: worldCenter.y, r: Math.max(stack.footprintW, stack.footprintD) / 2, h: computeStackTotalHeight(stack) })));
      let extent = Math.max(project.footprintWidth, project.footprintDepth);
      let cx = project.footprintWidth / 2, cy = project.footprintDepth / 2, tallest = 20;
      if (centers.length) {
        const minX = Math.min(...centers.map(c => c.x - c.r)), maxX = Math.max(...centers.map(c => c.x + c.r));
        const minY = Math.min(...centers.map(c => c.y - c.r)), maxY = Math.max(...centers.map(c => c.y + c.r));
        cx = (minX + maxX) / 2; cy = (minY + maxY) / 2;
        tallest = Math.max(...centers.map(c => c.h));
        extent = Math.max(maxX - minX, maxY - minY, tallest);
      }

      azimuth = 0;
      elevation = Math.PI / 9; // 20 degrees above: front-on, with just enough top to read depth
      orbitTargetX = toSceneX(cx);
      orbitTargetZ = toSceneZ(cy);
      // Height counts double in the extent: at a 20-degree elevation the vertical span of the
      // display is what runs out of frame first, not its width.
      extent = Math.max(extent, tallest * 2);
      radius = extent * 1.2 + 30;
      // Key light nearly level with the camera so it lands on the fronts, not the tops.
      lightAzimuth = 0;
      lightElevation = 15;
      dirLight.intensity = 1.5;

      const W = 1600, H = 1000;
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      updateLightPosition();
      updateCameraPosition();
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    } catch (e) {
      console.error('Spec sheet: rendering the 3D snapshot failed.', e);
      return null;
    } finally {
      ({ azimuth, elevation, radius, orbitTargetX, orbitTargetZ, lightAzimuth, lightElevation } = saved);
      dirLight.intensity = saved.intensity;
      renderer.setSize(savedSize.x, savedSize.y, false);
      camera.aspect = savedSize.x / savedSize.y;
      camera.updateProjectionMatrix();
      updateLightPosition();
      updateCameraPosition();
      markDirty();
    }
  }

  return { init, refresh, stopRenderLoop, getStackHeight, captureSnapshot };
})();
