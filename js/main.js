/* App bootstrap and tab switching. */

(function () {
  const appState = loadState();

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'grid') Grid.refresh();
      if (btn.dataset.tab === 'viewer3d') {
        Viewer3D.refresh();
      } else {
        // The 3D viewer previously kept rendering a full WebGL scene (with shadows) at 60fps
        // forever in the background once visited, even while working in a completely different
        // tab -- a real, ongoing GPU/CPU cost for as long as the page stayed open. Stop it the
        // moment it's not the visible tab; Viewer3D.refresh() restarts it if the tab is revisited.
        Viewer3D.stopRenderLoop();
      }
    });
  });

  ItemTypes.init(appState);
  Cases.init(appState);
  Grid.init(appState);
  Viewer3D.init(appState);

  // ---- Save to a real file on this computer (Chrome/Edge only) ----
  // Additive to localStorage, never a replacement -- every save point below writes to both.
  const statusEl = document.getElementById('fileSyncStatus');
  const btnChoose = document.getElementById('btnChooseSaveFile');
  const btnReconnect = document.getElementById('btnReconnectSaveFile');

  function renderFileSyncStatus(status, fileName) {
    statusEl.classList.remove('hidden');
    btnChoose.classList.add('hidden');
    btnReconnect.classList.add('hidden');
    if (status === 'unsupported') {
      statusEl.textContent = 'File save: not supported in this browser (use Chrome or Edge)';
    } else if (status === 'disconnected') {
      statusEl.textContent = '';
      statusEl.classList.add('hidden');
      btnChoose.classList.remove('hidden');
    } else if (status === 'connected') {
      statusEl.textContent = `Saving to: ${fileName}`;
      statusEl.title = 'Every change is automatically written to this file on your computer.';
    } else if (status === 'needs-permission') {
      statusEl.textContent = `Not saving to ${fileName} -- permission needed`;
      btnReconnect.classList.remove('hidden');
    }
  }

  FileSync.init(renderFileSyncStatus).then(() => FileSync.write(appState));
  btnChoose.addEventListener('click', () => FileSync.chooseFile().then(() => FileSync.write(appState)));
  btnReconnect.addEventListener('click', () => FileSync.reconnect().then(() => FileSync.write(appState)));

  // ---- Full backup / restore (everything: item types, cases, every project) ----
  // Distinct from the Grid tab's own Export/Import JSON, which only covers the single active
  // project -- this is a complete snapshot of appState, so a lost/corrupted localStorage never
  // means losing everything with no way back.

  document.getElementById('btnExportAllData').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(appState, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `palletmaker_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btnImportAllData').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      let imported;
      try {
        imported = JSON.parse(evt.target.result);
      } catch (err) {
        alert(`Could not read that file: ${err.message}`);
        return;
      }
      if (!Array.isArray(imported.itemTypes) || !Array.isArray(imported.cases) || !Array.isArray(imported.projects)) {
        alert('Not a recognizable PalletMaker backup file.');
        return;
      }
      if (!confirm('This replaces everything currently in PalletMaker -- all item types, cases, and every project -- with the contents of this backup. This cannot be undone. Continue?')) {
        return;
      }
      // Mutate the existing appState object in place (not reassign it) -- every module holds its
      // own reference to this exact object, so this is what makes the swap visible to all of them
      // without needing to re-run their init() (which would re-bind every button/listener a
      // second time).
      appState.itemTypes = imported.itemTypes;
      appState.cases = imported.cases;
      appState.projects = imported.projects;
      appState.activeProjectId = imported.activeProjectId || null;
      saveState(appState);
      ItemTypes.refresh();
      Cases.refresh();
      Grid.refresh();
      Viewer3D.refresh();
      alert('Backup restored.');
    };
    reader.readAsText(file);
  });

  // Safety net: everything else already calls saveState() right after it mutates appState, but
  // if any interaction ever misses that (a thrown error mid-handler, a browser quirk around
  // native drag-and-drop, etc.) this periodic save -- plus one right before the page is hidden or
  // closed -- means a refresh can lose at most a few seconds of work instead of everything back to
  // the last successful explicit save.
  setInterval(() => saveState(appState), 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveState(appState);
      // Also pause the 3D render loop while the browser tab itself is in the background (e.g.
      // switched to a different app or browser tab) -- no point spending GPU on a frame nobody
      // can see. Coming back resumes it if the 3D Viewer is still the active in-app tab.
      Viewer3D.stopRenderLoop();
    } else if (document.querySelector('.tab-btn[data-tab="viewer3d"]').classList.contains('active')) {
      Viewer3D.refresh();
    }
  });
  window.addEventListener('pagehide', () => saveState(appState));
})();
