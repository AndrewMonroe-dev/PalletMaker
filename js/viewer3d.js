/* 3D viewer: renders the active project's stacks/groups at real-world scale using Three.js.
   Front face (largest grid-Y / bottom edge of the floor) shows the item's swatch image if it has
   one; every other face shows the swatch's flat color. Supports orbit drag/zoom, placeable image
   panels, and exporting the current view as a PNG. */

const Viewer3D = (() => {
  let state = null;
  let project = null;

  let renderer = null;
  let scene = null;
  let camera = null;
  let animFrameId = null;

  let azimuth = Math.PI / 4;
  let elevation = Math.PI / 6;
  let radius = 100;
  let isDragging = false;
  let lastX = 0, lastY = 0;

  function init(appState) {
    state = appState;
    document.getElementById('viewer3dAddImage').addEventListener('change', handleAddImage);
    document.getElementById('viewer3dExportBtn').addEventListener('click', handleExportImage);
    bindCanvasInteraction();
  }

  function bindCanvasInteraction() {
    const container = document.getElementById('viewer3dCanvas');
    container.addEventListener('mousedown', (e) => {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      azimuth -= dx * 0.01;
      elevation = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, elevation + dy * 0.01));
      updateCameraPosition();
    });
    window.addEventListener('mouseup', () => { isDragging = false; });
    container.addEventListener('wheel', (e) => {
      if (!project) return;
      e.preventDefault();
      radius = Math.max(20, radius + e.deltaY * 0.5);
      updateCameraPosition();
    }, { passive: false });
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
    const height = 500;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c0f);

    camera = new THREE.PerspectiveCamera(45, width / height, 1, 5000);

    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(1, 2, 1);
    scene.add(dirLight);

    const maxDim = Math.max(project.footprintWidth, project.footprintDepth);

    const floorGeo = new THREE.PlaneGeometry(project.footprintWidth, project.footprintDepth);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x1d2026, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const divisions = Math.max(1, Math.round(maxDim / 6));
    scene.add(new THREE.GridHelper(maxDim, divisions, 0x444444, 0x2a2d35));

    addStacksToScene();
    addImagePanelsToScene();

    radius = maxDim * 1.4 + 40;
    updateCameraPosition();
  }

  function toSceneX(gridX) { return gridX - project.footprintWidth / 2; }
  function toSceneZ(gridY) { return gridY - project.footprintDepth / 2; }

  function addStacksToScene() {
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
    let yCursor = 0;
    stack.items.forEach(item => {
      const itemHeight = getItemHeight(item);
      const sw = Grid.resolveSwatch(item.itemTypeId, item.swatchId);
      const box = buildBoxMesh(stack.footprintW, itemHeight, stack.footprintD, sw);
      box.position.set(toSceneX(centerGridX), yCursor + itemHeight / 2, toSceneZ(centerGridY));
      box.rotation.y = -(angleDeg * Math.PI) / 180;
      scene.add(box);
      yCursor += itemHeight;
    });
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

  function buildBoxMesh(width, height, depth, sw) {
    const color = sw ? sw.color : '#888888';
    const flatMat = new THREE.MeshStandardMaterial({ color });
    let frontMat = flatMat;
    if (sw && sw.image) {
      const texture = new THREE.TextureLoader().load(sw.image);
      frontMat = new THREE.MeshStandardMaterial({ map: texture });
    }
    // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z. Front (largest grid-Y) maps to +Z.
    const materials = [flatMat, flatMat, flatMat, flatMat, frontMat, flatMat];
    const geo = new THREE.BoxGeometry(width, height, depth);
    return new THREE.Mesh(geo, materials);
  }

  function addImagePanelsToScene() {
    (project.imagePanels || []).forEach(panel => {
      const texture = new THREE.TextureLoader().load(panel.dataUrl);
      const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true });
      const geo = new THREE.PlaneGeometry(panel.width, panel.height);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(toSceneX(panel.x), panel.heightOffGround + panel.height / 2, toSceneZ(panel.y));
      mesh.rotation.y = -(panel.rotationY * Math.PI) / 180;
      scene.add(mesh);
    });
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
      project.imagePanels.push({
        id: uid('panel'),
        dataUrl: evt.target.result,
        x: project.footprintWidth / 2,
        y: project.footprintDepth,
        heightOffGround: 0,
        width: 12,
        height: 12,
        rotationY: 0
      });
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

  function computeTotals() {
    let totalCost = 0, totalRevenue = 0, totalCases = 0, totalUnits = 0;

    project.stacks.forEach(stack => {
      stack.items.forEach(item => {
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

  return { init, refresh };
})();
