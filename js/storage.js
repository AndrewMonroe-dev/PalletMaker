/* Persistence layer: everything lives in localStorage, keyed under one root object. */

const STORAGE_KEY = 'palletmaker_state_v1';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch (e) {
    console.error('Failed to load PalletMaker state, starting fresh.', e);
    return defaultState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  // Mirror out to a real file on disk too, if the user has connected one (fileSync.js) -- a
  // silent no-op when unsupported/not connected, so this is safe to call from every existing
  // saveState() call site with no other changes needed.
  if (typeof FileSync !== 'undefined') FileSync.write(state);
}

function defaultState() {
  return {
    itemTypes: [],
    cases: [],
    projects: [],
    activeProjectId: null
  };
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Reads a File as a data URL, resolving null for a missing/empty file input (an optional image
// field left blank) instead of rejecting.
function readFileAsDataUrl(file) {
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Renders Grid.computeTally()'s rows as an HTML table string -- shared by the grid print and the
// 3D viewer print, so both list "every item in the display, how many of each" the same way.
function buildTallyTableHtml(rows) {
  if (!rows || rows.length === 0) {
    return '<p class="print-tally-empty">Nothing placed yet.</p>';
  }

  let totalCost = 0;
  let totalRevenue = 0;
  const bodyRows = rows.map(r => {
    totalCost += r.cost;
    totalRevenue += r.revenue;
    return `<tr>
      <td>${escapeHtml(r.label)}</td>
      <td>${r.isCase ? 'Case' : 'Unit'}</td>
      <td>${r.count}</td>
      <td>$${r.cost.toFixed(2)}</td>
      <td>$${r.revenue.toFixed(2)}</td>
    </tr>`;
  }).join('');

  return `<table class="tally-table">
    <thead><tr><th>Item</th><th>Type</th><th>Count</th><th>Cost</th><th>Revenue</th></tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot><tr><td colspan="3">Total</td><td>$${totalCost.toFixed(2)}</td><td>$${totalRevenue.toFixed(2)}</td></tr></tfoot>
  </table>`;
}
