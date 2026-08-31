/* Case builder: assembles units of one item type (one swatch) into a case via rows x cols x layers. */

const Cases = (() => {
  let state = null;
  let selectedId = null;
  let editingId = null;

  function init(appState) {
    state = appState;
    renderList();
    bindStaticListeners();
    showEmptyDetail();
  }

  function bindStaticListeners() {
    document.getElementById('btnAddCase').addEventListener('click', openNewForm);
    document.getElementById('btnCancelCaseForm').addEventListener('click', () => {
      hideForm();
      if (selectedId) showDetailFor(selectedId); else showEmptyDetail();
    });
    document.getElementById('caseForm').addEventListener('submit', handleSubmit);
    document.getElementById('btnDeleteCase').addEventListener('click', handleDelete);

    document.getElementById('cItemType').addEventListener('change', () => {
      populateSwatchOptions();
      updateComputedFields();
    });
    ['cRows', 'cCols', 'cLayers', 'cSwatch'].forEach(id => {
      document.getElementById(id).addEventListener('input', updateComputedFields);
    });
  }

  function renderList() {
    const listEl = document.getElementById('caseList');
    if (state.cases.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No cases yet. Click + to add one.</p>';
      return;
    }
    listEl.innerHTML = '';
    state.cases.forEach(c => {
      const itemType = ItemTypes.getItemType(c.itemTypeId);
      const swatch = itemType ? itemType.palette.find(s => s.id === c.swatchId) : null;

      const row = document.createElement('div');
      row.className = 'item-type-row' + (c.id === selectedId ? ' selected' : '');
      row.dataset.id = c.id;

      const preview = document.createElement('div');
      preview.className = 'swatch-preview';
      if (swatch) {
        preview.style.background = swatch.image ? `url(${swatch.image}) center/cover` : swatch.color;
      }

      const name = document.createElement('div');
      name.className = 'row-name';
      name.textContent = c.name;

      const dims = document.createElement('div');
      dims.className = 'row-dims';
      dims.textContent = itemType ? `${c.rows}x${c.cols}x${c.layers}` : '(missing item type)';

      row.appendChild(preview);
      row.appendChild(name);
      row.appendChild(dims);
      row.addEventListener('click', () => showDetailFor(c.id));
      listEl.appendChild(row);
    });
  }

  function showEmptyDetail() {
    selectedId = null;
    const itemTypesExist = ItemTypes.getAll().length > 0;
    document.getElementById('caseDetailEmptyMsg').textContent = itemTypesExist
      ? 'Select a case to view or edit it, or click + to create a new one.'
      : 'Create at least one item type first (Item Types tab), then come back here to build a case.';
    document.getElementById('caseDetailEmpty').classList.remove('hidden');
    hideForm();
    renderList();
  }

  function showDetailFor(id) {
    selectedId = id;
    renderList();
    const c = state.cases.find(x => x.id === id);
    if (!c) return showEmptyDetail();
    document.getElementById('caseDetailEmpty').classList.add('hidden');
    populateForm(c);
    showForm();
    document.getElementById('caseFormTitle').textContent = 'Edit Case';
    document.getElementById('btnDeleteCase').classList.remove('hidden');
    editingId = id;
  }

  function openNewForm() {
    if (ItemTypes.getAll().length === 0) {
      alert('Create at least one item type first, on the Item Types tab.');
      return;
    }
    selectedId = null;
    renderList();
    editingId = null;
    document.getElementById('caseForm').reset();
    document.getElementById('caseFormTitle').textContent = 'New Case';
    document.getElementById('btnDeleteCase').classList.add('hidden');
    document.getElementById('caseDetailEmpty').classList.add('hidden');
    populateItemTypeOptions();
    populateSwatchOptions();
    updateComputedFields();
    showForm();
  }

  function showForm() { document.getElementById('caseForm').classList.remove('hidden'); }
  function hideForm() { document.getElementById('caseForm').classList.add('hidden'); }

  function populateItemTypeOptions(selectedItemTypeId) {
    const select = document.getElementById('cItemType');
    select.innerHTML = '';
    ItemTypes.getAll().forEach(it => {
      const opt = document.createElement('option');
      opt.value = it.id;
      opt.textContent = it.name;
      select.appendChild(opt);
    });
    if (selectedItemTypeId) select.value = selectedItemTypeId;
  }

  function populateSwatchOptions(selectedSwatchId) {
    const itemTypeId = document.getElementById('cItemType').value;
    const itemType = ItemTypes.getItemType(itemTypeId);
    const select = document.getElementById('cSwatch');
    select.innerHTML = '';
    if (!itemType) return;
    itemType.palette.forEach(sw => {
      const opt = document.createElement('option');
      opt.value = sw.id;
      opt.textContent = sw.name;
      select.appendChild(opt);
    });
    if (selectedSwatchId) select.value = selectedSwatchId;
  }

  function populateForm(c) {
    populateItemTypeOptions(c.itemTypeId);
    populateSwatchOptions(c.swatchId);
    document.getElementById('cName').value = c.name;
    document.getElementById('cRows').value = c.rows;
    document.getElementById('cCols').value = c.cols;
    document.getElementById('cLayers').value = c.layers;
    updateComputedFields();
  }

  function updateComputedFields() {
    const itemType = ItemTypes.getItemType(document.getElementById('cItemType').value);
    const rows = parseInt(document.getElementById('cRows').value, 10) || 0;
    const cols = parseInt(document.getElementById('cCols').value, 10) || 0;
    const layers = parseInt(document.getElementById('cLayers').value, 10) || 0;
    const totalUnits = rows * cols * layers;

    document.getElementById('calcUnitCount').textContent = totalUnits;

    if (!itemType) {
      document.getElementById('calcExpectedUnitCount').textContent = '--';
      document.getElementById('calcCaseDims').textContent = '--';
      document.getElementById('calcCaseCost').textContent = '$0.00';
      document.getElementById('calcCaseRevenue').textContent = '$0.00';
      return;
    }

    document.getElementById('calcExpectedUnitCount').textContent = itemType.unitsPerCase;

    const matches = totalUnits === itemType.unitsPerCase;
    document.getElementById('caseUnitCountWarning').classList.toggle('hidden', matches);

    const width = (cols * itemType.width).toFixed(2);
    const height = (rows * itemType.height).toFixed(2);
    const depth = (layers * itemType.depth).toFixed(2);
    document.getElementById('calcCaseDims').textContent = `${width}"W x ${height}"H x ${depth}"D`;

    const costPerUnit = itemType.unitsPerCase > 0 ? itemType.costPerCase / itemType.unitsPerCase : 0;
    const marginFraction = Math.min(Math.max(itemType.marginPct, 0), 99.99) / 100;
    const retailPerUnit = marginFraction < 1 ? costPerUnit / (1 - marginFraction) : 0;

    document.getElementById('calcCaseCost').textContent = `$${(costPerUnit * totalUnits).toFixed(2)}`;
    document.getElementById('calcCaseRevenue').textContent = `$${(retailPerUnit * totalUnits).toFixed(2)}`;
  }

  function handleSubmit(e) {
    e.preventDefault();

    const form = document.getElementById('caseForm');
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const itemTypeId = document.getElementById('cItemType').value;
    const itemType = ItemTypes.getItemType(itemTypeId);
    const rows = parseInt(document.getElementById('cRows').value, 10);
    const cols = parseInt(document.getElementById('cCols').value, 10);
    const layers = parseInt(document.getElementById('cLayers').value, 10);
    const totalUnits = rows * cols * layers;

    if (!itemType) {
      alert('Select an item type.');
      return;
    }
    if (totalUnits !== itemType.unitsPerCase) {
      alert(`This arrangement totals ${totalUnits} units, but "${itemType.name}" is set to ${itemType.unitsPerCase} units per case. Adjust rows/columns/layers to match, or change the item type's units per case on the Item Types tab.`);
      return;
    }

    const record = {
      id: editingId || uid('case'),
      name: document.getElementById('cName').value.trim(),
      itemTypeId,
      swatchId: document.getElementById('cSwatch').value,
      rows, cols, layers
    };

    if (editingId) {
      const idx = state.cases.findIndex(c => c.id === editingId);
      state.cases[idx] = record;
    } else {
      state.cases.push(record);
    }

    saveState(state);
    selectedId = record.id;
    editingId = record.id;
    renderList();
    document.getElementById('caseFormTitle').textContent = 'Edit Case';
    document.getElementById('btnDeleteCase').classList.remove('hidden');
  }

  function handleDelete() {
    if (!editingId) return;
    const c = state.cases.find(x => x.id === editingId);
    if (!c) return;
    if (!confirm(`Delete case "${c.name}"? This cannot be undone.`)) return;
    state.cases = state.cases.filter(x => x.id !== editingId);
    saveState(state);
    showEmptyDetail();
  }

  function getCase(id) {
    return state.cases.find(c => c.id === id);
  }

  function getAll() {
    return state.cases;
  }

  function refreshForNewItemTypes() {
    // Called by ItemTypes when item types change, in case the cases list's dims text needs updating.
    renderList();
  }

  return { init, getCase, getAll, refreshForNewItemTypes };
})();
