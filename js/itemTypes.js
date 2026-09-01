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

  function bindStaticListeners() {
    document.getElementById('btnAddItemType').addEventListener('click', openNewForm);
    document.getElementById('btnCancelForm').addEventListener('click', () => {
      hideForm();
      if (selectedId) showDetailFor(selectedId); else showEmptyDetail();
    });
    document.getElementById('itemTypeForm').addEventListener('submit', handleSubmit);
    document.getElementById('btnDeleteItemType').addEventListener('click', handleDelete);
    document.getElementById('btnAddSwatch').addEventListener('click', handleAddSwatch);

    ['fCostPerCase', 'fUnitsPerCase', 'fMargin'].forEach(id => {
      document.getElementById(id).addEventListener('input', updateComputedFields);
    });
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
    document.getElementById('btnDeleteItemType').classList.add('hidden');
    document.getElementById('itemTypeDetailEmpty').classList.add('hidden');
    renderSwatchEditor();
    updateComputedFields();
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

  return { init, getItemType, getAll, addSwatchToItemType };
})();
