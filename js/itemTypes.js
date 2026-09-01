/* Item Type manager: CRUD for item types (dimensions, pricing, palette). */

const ItemTypes = (() => {
  let state = null;
  let selectedId = null;
  let editingSwatches = []; // staged swatches while the form is open
  let editingId = null; // null while creating, set while editing an existing item type

  function init(appState) {
    state = appState;
    renderList();
    bindStaticListeners();
    showEmptyDetail();
  }

  // For after something else (a full backup restore) replaces state.itemTypes wholesale --
  // re-renders against the new data without re-binding listeners a second time. The old selection
  // may point at a row that no longer exists, so just drop back to the empty state rather than try
  // to preserve it.
  function refresh() {
    showEmptyDetail();
  }

  function bindStaticListeners() {
    document.getElementById('btnAddItemType').addEventListener('click', openNewForm);
    document.getElementById('btnCancelForm').addEventListener('click', () => {
      hideForm();
      if (selectedId) showDetailFor(selectedId); else showEmptyDetail();
    });
    document.getElementById('itemTypeForm').addEventListener('submit', handleSubmit);
    document.getElementById('btnDuplicateItemType').addEventListener('click', handleDuplicate);
    document.getElementById('btnDeleteItemType').addEventListener('click', handleDelete);
    document.getElementById('btnAddSwatch').addEventListener('click', handleAddSwatch);

    ['fCostPerCase', 'fUnitsPerCase', 'fMargin'].forEach(id => {
      document.getElementById(id).addEventListener('input', updateComputedFields);
    });

    bindPhotoDropZone();
  }

  // Dropping one or more image files onto the list creates one new item type per image, each
  // pre-filled with that photo as its front swatch and placeholder dimensions/pricing -- click
  // each one afterward to fill in its real name, size, and cost. Distinct from the app's own
  // internal drag-and-drop (grid placement, which carries an "application/json" payload, not
  // Files) -- this only reacts to real OS files being dragged in from outside the browser.
  function bindPhotoDropZone() {
    const listEl = document.getElementById('itemTypeList');
    listEl.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      listEl.classList.add('drag-over-files');
    });
    listEl.addEventListener('dragleave', (e) => {
      if (!listEl.contains(e.relatedTarget)) listEl.classList.remove('drag-over-files');
    });
    listEl.addEventListener('drop', (e) => {
      if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      listEl.classList.remove('drag-over-files');
      handlePhotoDrop(Array.from(e.dataTransfer.files));
    });
  }

  async function handlePhotoDrop(files) {
    const images = files.filter(f => f.type.startsWith('image/'));
    if (images.length === 0) return;

    for (const file of images) {
      const dataUrl = await readFileAsDataUrl(file);
      const name = file.name.replace(/\.[^./\\]+$/, '') || 'New Item';
      state.itemTypes.push({
        id: uid('item'),
        name,
        // Placeholder dimensions/pricing -- structurally valid so nothing downstream breaks, but
        // deliberately obvious/wrong so it's clear each one still needs its real numbers filled
        // in. 1x1x1 rather than 0 so it renders as a real (if tiny) box if placed before editing.
        width: 1, height: 1, depth: 1,
        unitsPerCase: 1, costPerCase: 0, marginPct: 30,
        palette: [{ id: uid('swatch'), name: 'Main', color: '#8b1e2b', image: dataUrl, sideImage: null, backImage: null }]
      });
    }

    saveState(state);
    renderList();
    alert(`Added ${images.length} new item type${images.length > 1 ? 's' : ''} from the dropped photo${images.length > 1 ? 's' : ''}. Click each one to set its real name, dimensions, and pricing.`);
  }

  function renderList() {
    const listEl = document.getElementById('itemTypeList');
    if (state.itemTypes.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No item types yet. Click + to add one.</p>';
      return;
    }
    listEl.innerHTML = '';
    state.itemTypes.forEach(it => {
      const row = document.createElement('div');
      row.className = 'item-type-row' + (it.id === selectedId ? ' selected' : '');
      row.dataset.id = it.id;

      const preview = document.createElement('div');
      preview.className = 'swatch-preview';
      const firstSwatch = it.palette[0];
      if (firstSwatch) {
        preview.style.background = firstSwatch.image
          ? `url(${firstSwatch.image}) center/cover`
          : firstSwatch.color;
      }

      const name = document.createElement('div');
      name.className = 'row-name';
      name.textContent = it.name;

      const dims = document.createElement('div');
      dims.className = 'row-dims';
      dims.textContent = `${it.width}"x${it.height}"x${it.depth}"`;

      row.appendChild(preview);
      row.appendChild(name);
      row.appendChild(dims);
      row.addEventListener('click', () => showDetailFor(it.id));
      listEl.appendChild(row);
    });
  }

  function showEmptyDetail() {
    selectedId = null;
    document.getElementById('itemTypeDetailEmpty').classList.remove('hidden');
    hideForm();
    renderList();
  }

  function showDetailFor(id) {
    selectedId = id;
    renderList();
    const item = state.itemTypes.find(i => i.id === id);
    if (!item) return showEmptyDetail();
    document.getElementById('itemTypeDetailEmpty').classList.add('hidden');
    populateForm(item);
    showForm();
    document.getElementById('formTitle').textContent = 'Edit Item Type';
    document.getElementById('btnDuplicateItemType').classList.remove('hidden');
    document.getElementById('btnDeleteItemType').classList.remove('hidden');
    editingId = id;
  }

  function openNewForm() {
    selectedId = null;
    renderList();
    editingId = null;
    editingSwatches = [];
    document.getElementById('itemTypeForm').reset();
    document.getElementById('formTitle').textContent = 'New Item Type';
    document.getElementById('btnDuplicateItemType').classList.add('hidden');
    document.getElementById('btnDeleteItemType').classList.add('hidden');
    document.getElementById('itemTypeDetailEmpty').classList.add('hidden');
    renderSwatchEditor();
    updateComputedFields();
    showForm();
  }

  // Clones the item type currently open in the form -- same dimensions, pricing, and palette
  // (photos/colors included, with fresh swatch ids so editing the copy's swatches later can't
  // collide with the original's) -- as a fast starting point for a same-photo, different-size
  // variant. Opens the clone directly in the (unsaved) edit form so the name and dimensions are
  // right there to change; nothing is written to state until Save is clicked, same as any other
  // edit.
  function handleDuplicate() {
    if (!editingId) return;
    const original = state.itemTypes.find(i => i.id === editingId);
    if (!original) return;

    editingId = null; // Save will create a new record instead of overwriting the original
    selectedId = null;
    renderList();
    document.getElementById('itemTypeDetailEmpty').classList.add('hidden');
    document.getElementById('fName').value = `${original.name} (copy)`;
    document.getElementById('fWidth').value = original.width;
    document.getElementById('fHeight').value = original.height;
    document.getElementById('fDepth').value = original.depth;
    document.getElementById('fUnitsPerCase').value = original.unitsPerCase;
    document.getElementById('fCostPerCase').value = original.costPerCase;
    document.getElementById('fMargin').value = original.marginPct;
    editingSwatches = original.palette.map(s => ({ ...s, id: uid('swatch') }));
    renderSwatchEditor();
    updateComputedFields();
    document.getElementById('formTitle').textContent = 'New Item Type (duplicated)';
    document.getElementById('btnDuplicateItemType').classList.add('hidden');
    document.getElementById('btnDeleteItemType').classList.add('hidden');
    showForm();
  }

  function showForm() { document.getElementById('itemTypeForm').classList.remove('hidden'); }
  function hideForm() { document.getElementById('itemTypeForm').classList.add('hidden'); }

  function populateForm(item) {
    document.getElementById('fName').value = item.name;
    document.getElementById('fWidth').value = item.width;
    document.getElementById('fHeight').value = item.height;
    document.getElementById('fDepth').value = item.depth;
    document.getElementById('fUnitsPerCase').value = item.unitsPerCase;
    document.getElementById('fCostPerCase').value = item.costPerCase;
    document.getElementById('fMargin').value = item.marginPct;
    editingSwatches = item.palette.map(s => ({ ...s }));
    renderSwatchEditor();
    updateComputedFields();
  }

  function computeCostPerUnit() {
    const cost = parseFloat(document.getElementById('fCostPerCase').value) || 0;
    const units = parseFloat(document.getElementById('fUnitsPerCase').value) || 0;
    return units > 0 ? cost / units : 0;
  }

  function computeRetailPerUnit(costPerUnit) {
    const margin = parseFloat(document.getElementById('fMargin').value) || 0;
    const marginFraction = Math.min(Math.max(margin, 0), 99.99) / 100;
    return marginFraction < 1 ? costPerUnit / (1 - marginFraction) : 0;
  }

  function updateComputedFields() {
    const costPerUnit = computeCostPerUnit();
    const retailPerUnit = computeRetailPerUnit(costPerUnit);
    document.getElementById('calcCostPerUnit').textContent = `$${costPerUnit.toFixed(2)}`;
    document.getElementById('calcRetailPerUnit').textContent = `$${retailPerUnit.toFixed(2)}`;
  }

  function renderSwatchEditor() {
    const listEl = document.getElementById('paletteSwatchList');
    if (editingSwatches.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No swatches yet. Add one below.</p>';
      return;
    }
    listEl.innerHTML = '';
    editingSwatches.forEach((sw, idx) => {
      const card = document.createElement('div');
      card.className = 'swatch-card';

      const colorEl = document.createElement('div');
      colorEl.className = 'swatch-color';
      colorEl.style.background = sw.image ? `url(${sw.image}) center/cover` : sw.color;

      const nameEl = document.createElement('div');
      nameEl.className = 'swatch-name';
      nameEl.textContent = sw.name;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'swatch-remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        editingSwatches.splice(idx, 1);
        renderSwatchEditor();
      });

      card.appendChild(colorEl);
      card.appendChild(nameEl);
      card.appendChild(removeBtn);
      listEl.appendChild(card);
    });
  }

  async function handleAddSwatch() {
    const nameInput = document.getElementById('fNewSwatchName');
    const colorInput = document.getElementById('fNewSwatchColor');
    const imageInput = document.getElementById('fNewSwatchImage');
    const sideImageInput = document.getElementById('fNewSwatchSideImage');
    const backImageInput = document.getElementById('fNewSwatchBackImage');

    const name = nameInput.value.trim();
    if (!name) {
      alert('Give the swatch a name first.');
      return;
    }

    const [image, sideImage, backImage] = await Promise.all([
      readFileAsDataUrl(imageInput.files[0]),
      readFileAsDataUrl(sideImageInput.files[0]),
      readFileAsDataUrl(backImageInput.files[0])
    ]);

    editingSwatches.push({
      id: uid('swatch'),
      name,
      color: colorInput.value,
      image, sideImage, backImage
    });
    renderSwatchEditor();
    nameInput.value = '';
    imageInput.value = '';
    sideImageInput.value = '';
    backImageInput.value = '';
  }

  function handleSubmit(e) {
    e.preventDefault();

    const form = document.getElementById('itemTypeForm');
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    if (editingSwatches.length === 0) {
      alert('Add at least one palette swatch before saving.');
      return;
    }

    const record = {
      id: editingId || uid('item'),
      name: document.getElementById('fName').value.trim(),
      width: parseFloat(document.getElementById('fWidth').value),
      height: parseFloat(document.getElementById('fHeight').value),
      depth: parseFloat(document.getElementById('fDepth').value),
      unitsPerCase: parseInt(document.getElementById('fUnitsPerCase').value, 10),
      costPerCase: parseFloat(document.getElementById('fCostPerCase').value),
      marginPct: parseFloat(document.getElementById('fMargin').value),
      palette: editingSwatches.map(s => ({ ...s }))
    };

    if (editingId) {
      const idx = state.itemTypes.findIndex(i => i.id === editingId);
      state.itemTypes[idx] = record;
    } else {
      state.itemTypes.push(record);
    }

    saveState(state);
    selectedId = record.id;
    editingId = record.id;
    renderList();
    document.getElementById('formTitle').textContent = 'Edit Item Type';
    document.getElementById('btnDeleteItemType').classList.remove('hidden');
  }

  function handleDelete() {
    if (!editingId) return;
    const item = state.itemTypes.find(i => i.id === editingId);
    if (!item) return;
    if (!confirm(`Delete item type "${item.name}"? This cannot be undone.`)) return;
    state.itemTypes = state.itemTypes.filter(i => i.id !== editingId);
    saveState(state);
    showEmptyDetail();
  }

  function getItemType(id) {
    return state.itemTypes.find(i => i.id === id);
  }

  function getAll() {
    return state.itemTypes;
  }

  // Lets other tabs (e.g. Cases) add a new palette color to an item type without navigating
  // away to the Item Types tab first.
  function addSwatchToItemType(itemTypeId, { name, color, image, sideImage, backImage }) {
    const item = getItemType(itemTypeId);
    if (!item) return null;
    const swatch = {
      id: uid('swatch'), name, color,
      image: image || null,
      sideImage: sideImage || null,
      backImage: backImage || null
    };
    item.palette.push(swatch);
    saveState(state);
    renderList();
    return swatch;
  }

  return { init, refresh, getItemType, getAll, addSwatchToItemType };
})();
