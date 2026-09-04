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

let quotaWarningShown = false; // avoid re-alerting on every periodic autosave tick once already told
let lastSavedJson = null; // the exact string last written, so an unchanged state isn't rewritten

function saveState(state) {
  const json = JSON.stringify(state);
  // The 4-second safety-net autosave (main.js) and the many explicit saveState() calls made this
  // rewrite the full state -- to localStorage AND to the connected file on disk -- even when
  // nothing had changed since the last write. Stringifying is unavoidable to know that, but the
  // storage write and the disk write (the expensive, I/O-bound parts) are skipped when the result
  // is byte-identical to what was last saved.
  if (json === lastSavedJson) return;
  try {
    localStorage.setItem(STORAGE_KEY, json);
    lastSavedJson = json;
  } catch (e) {
    // Real, previously-silent failure mode: localStorage typically caps around 5-10MB per origin,
    // and full-resolution uploaded photos can burn through that fast (several MB apiece). Before
    // this, a quota failure here threw uncaught and nothing after it ran -- the app would look like
    // it saved (no error visible anywhere) while actually not persisting a single byte, so a later
    // reload/crash lost everything back to whenever a save last genuinely fit. Now it's surfaced
    // clearly instead, once per session so it doesn't re-alert on every 4s autosave tick.
    console.error('Failed to save PalletMaker state to localStorage.', e);
    if (!quotaWarningShown) {
      quotaWarningShown = true;
      alert('PalletMaker could not save your work to this browser -- it likely ran out of local storage space. Connect "Save to Computer" (top of the page) so your work saves to a real file instead, or remove some photos to free up room.');
    }
  }
  // Mirror out to a real file on disk too, if the user has connected one (fileSync.js) -- a
  // silent no-op when unsupported/not connected, so this is safe to call from every existing
  // saveState() call site with no other changes needed. Runs even if the localStorage save above
  // failed -- a connected file is actually MORE likely to succeed in exactly that situation, since
  // it isn't bound by the same small per-origin quota.
  if (typeof FileSync !== 'undefined') FileSync.write(json);
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

// Re-encodes an uploaded photo down to a display-appropriate size before it ever gets stored --
// the real fix behind Andrew's reported lockup/reload with lost work. Full-resolution phone photos
// (often several MB apiece as base64) were being stored completely as-is on every item type, case
// swatch, and side/back image, with no cap -- every saveState() call does a synchronous
// JSON.stringify + localStorage.setItem of the ENTIRE app state, so a catalog with a couple dozen
// full-size photos could make every single edit take long enough to look like the tab froze, and
// could exceed localStorage's ~5-10MB per-origin quota outright (see saveState()'s new catch
// block above -- that failure was previously silent, compounding the data loss). Capping at 1000px
// on the longest side and re-encoding as JPEG cuts a typical multi-MB photo to tens of KB, with no
// visible quality loss at the sizes this app actually displays images (grid/3D box faces, print
// pages, small thumbnails). Transparent PNGs get a white backing fill first since JPEG has no alpha
// channel -- an acceptable trade-off for product photography, which is rarely transparent to begin
// with. Runs once at upload time, not on every render, so it's a one-time cost per photo.
function downscaleImageDataUrl(dataUrl, maxDim = 1000, quality = 0.85) {
  return new Promise((resolve) => {
    if (!dataUrl) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) {
        resolve(dataUrl); // fall back to the original rather than losing the image entirely
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
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

// Flat-color stand-in for a swatch's actual photo, for any small preview/thumbnail that doesn't
// need the real image -- item type/case list rows, palette chips, the swatch editor's mini cards.
// Andrew reported the whole tab crashing (not just freezing) on Edge, consistent with the browser
// running out of memory: even after the grid itself stopped rendering full photos (an earlier fix),
// every one of THESE small thumbnails was still a CSS background-image of the real, potentially
// full-resolution photo -- with dozens of item types/cases each carrying one, that's a lot of
// decoded bitmap data resident in memory simultaneously just to show tiny preview squares. Reusing
// the cached avgColor (same predominant-color sampling used for the grid) here too removes every
// remaining place in the app that decodes a full photo just to render a thumbnail. Falls back to
// the swatch's flat hand-picked color for old data that hasn't been through Recompress Photos yet
// -- still zero decode cost, just not yet the true predominant color for that one swatch.
function getSwatchFlatColor(sw) {
  if (!sw) return '#888888';
  return sw.avgColor || sw.color || '#888888';
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
  let totalCases = 0;
  let totalLooseUnits = 0;
  const bodyRows = rows.map(r => {
    totalCost += r.cost;
    totalRevenue += r.revenue;
    totalCases += r.cases;
    totalLooseUnits += r.looseUnits;
    return `<tr>
      <td>${escapeHtml(r.label)}</td>
      <td>${r.cases}</td>
      <td>${r.looseUnits > 0 ? r.looseUnits : '—'}</td>
      <td>$${r.cost.toFixed(2)}</td>
      <td>$${r.revenue.toFixed(2)}</td>
    </tr>`;
  }).join('');

  return `<table class="tally-table">
    <thead><tr><th>Item</th><th>Cases</th><th>Loose units</th><th>Cost</th><th>Revenue</th></tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot><tr><td>Total</td><td>${totalCases}</td><td>${totalLooseUnits > 0 ? totalLooseUnits : '—'}</td><td>$${totalCost.toFixed(2)}</td><td>$${totalRevenue.toFixed(2)}</td></tr></tfoot>
  </table>`;
}
