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

// Samples a photo's average color (16x16 offscreen canvas downsample) so it can be cached on a
// swatch as a cheap flat-color stand-in for its actual image -- viewer3d.js already did this same
// sampling per-mesh-build for its own fallback-face color; this is the same math, just taking a
// data URL directly (no live <img> element required) so it can run once at swatch-creation time
// and be persisted, instead of every render.
function computeAverageColorFromDataUrl(dataUrl) {
  return new Promise((resolve) => {
    if (!dataUrl) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
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
        resolve(`rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`);
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
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
