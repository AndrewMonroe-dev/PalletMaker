/* Auto-save to a real file on disk via the File System Access API (Chrome/Edge only).
   Andrew's ask: "save on my actual computer," not just this browser's localStorage -- a browser
   profile reset, a cleared site data setting, or switching machines all wipe localStorage with no
   trace. This writes the exact same JSON as "Backup All" to a real file he picks once, kept in
   sync automatically from then on (same save triggers as localStorage: every saveState() call,
   the periodic autosave tick, and tab-hide/pagehide).

   The file handle itself can't live in localStorage (not serializable), so it's kept in a tiny
   IndexedDB store instead -- the one browser storage API built to hold these handles across
   reloads. Permission to write to a previously-picked file is remembered by the browser per
   origin, but can lapse (e.g. site data cleared) -- queryPermission() checks silently on load;
   if it comes back anything but 'granted', UI falls back to a "Reconnect" prompt (permission
   re-grants require a real user gesture, so this can never be silently auto-recovered). */

const FileSync = (() => {
  const DB_NAME = 'palletmaker_filesync';
  const STORE_NAME = 'handles';
  const HANDLE_KEY = 'saveFileHandle';

  const supported = 'showSaveFilePicker' in window && 'indexedDB' in window;

  let fileHandle = null;
  let status = 'unsupported'; // 'unsupported' | 'disconnected' | 'needs-permission' | 'connected' | 'error'
  let onStatusChange = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function setStatus(s) {
    status = s;
    if (onStatusChange) onStatusChange(status, fileHandle ? fileHandle.name : null);
  }

  // Called once at boot: tries to pick back up a previously-chosen file without prompting.
  // queryPermission() alone never shows a browser dialog, so this is always safe to call silently.
  async function init(statusCallback) {
    onStatusChange = statusCallback;
    if (!supported) {
      setStatus('unsupported');
      return;
    }
    try {
      const handle = await idbGet(HANDLE_KEY);
      if (!handle) {
        setStatus('disconnected');
        return;
      }
      fileHandle = handle;
      const perm = await fileHandle.queryPermission({ mode: 'readwrite' });
      setStatus(perm === 'granted' ? 'connected' : 'needs-permission');
    } catch (e) {
      console.error('FileSync init failed', e);
      setStatus('disconnected');
    }
  }

  // User-gesture-only: opens the native save dialog to pick (or create) the file that'll be kept
  // in sync from now on.
  async function chooseFile() {
    if (!supported) return;
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'palletmaker_save.json',
        types: [{ description: 'PalletMaker save file', accept: { 'application/json': ['.json'] } }]
      });
      fileHandle = handle;
      await idbSet(HANDLE_KEY, handle);
      setStatus('connected');
    } catch (e) {
      if (e.name !== 'AbortError') console.error('FileSync chooseFile failed', e);
    }
  }

  // User-gesture-only: re-requests write permission on the already-chosen file after it lapsed.
  async function reconnect() {
    if (!fileHandle) return;
    try {
      const perm = await fileHandle.requestPermission({ mode: 'readwrite' });
      setStatus(perm === 'granted' ? 'connected' : 'needs-permission');
    } catch (e) {
      console.error('FileSync reconnect failed', e);
    }
  }

  async function forget() {
    fileHandle = null;
    await idbDelete(HANDLE_KEY);
    setStatus('disconnected');
  }

  // Mirrors whatever's in appState out to the connected file. Silent no-op if never connected or
  // permission has lapsed -- localStorage (via storage.js's own saveState) always remains the
  // primary, always-on save; this is strictly additive.
  async function write(state) {
    if (status !== 'connected' || !fileHandle) return;
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(state, null, 2));
      await writable.close();
    } catch (e) {
      console.error('FileSync write failed', e);
      setStatus('needs-permission');
    }
  }

  return { init, chooseFile, reconnect, forget, write, isSupported: () => supported };
})();
