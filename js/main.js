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

  // ---- Recompress already-saved photos (retroactive version of the new-upload downscaling) ----
  // Andrew's real catalog already had photos stored at full original resolution from before that
  // fix existed -- this is the one-time migration for that existing data, run on demand rather
  // than automatically on load (touching every image silently on every visit would be surprising,
  // and isn't needed once a catalog's photos are already small).
  document.getElementById('btnRecompressPhotos').addEventListener('click', async () => {
    if (!confirm('Re-compress every already-saved photo to a smaller size? Recommended if the app has felt slow or a save has failed -- large original photos are the likely cause. This can take a moment for a big catalog, and photos that are already small are left alone.')) {
      return;
    }
    let imagesProcessed = 0;
    let swatchesTouched = 0;
    let skippedAlreadySmall = 0;
    // A dataUrl under ~200KB is already close to what downscaleImageDataUrl itself produces --
    // skip it rather than re-compressing an already-small (possibly already-JPEG) image, since
    // JPEG re-encoding loses a little quality each time it's applied.
    const ALREADY_SMALL_THRESHOLD = 200_000;
    async function recompressField(value) {
      if (!value || value.length < ALREADY_SMALL_THRESHOLD) {
        if (value) skippedAlreadySmall++;
        return { value, changed: false };
      }
      imagesProcessed++;
      return { value: await downscaleImageDataUrl(value), changed: true };
    }
    for (const it of appState.itemTypes) {
      for (const sw of it.palette) {
        const image = await recompressField(sw.image);
        const sideImage = await recompressField(sw.sideImage);
        const backImage = await recompressField(sw.backImage);
        if (image.changed || sideImage.changed || backImage.changed) {
          sw.image = image.value;
          sw.sideImage = sideImage.value;
          sw.backImage = backImage.value;
          // The cached predominant color was sampled from the old (larger) image -- resample from
          // the new one so it stays accurate rather than silently going stale.
          sw.avgColor = sw.image ? await computeAverageColorFromDataUrl(sw.image) : null;
          swatchesTouched++;
        }
      }
    }
    // 3D image panels (project.imagePanels) were the one remaining place a photo was stored at
    // full original size -- they're part of every project snapshot the grid's undo stack copies
    // and every save, so they matter just as much as swatch photos.
    for (const proj of appState.projects) {
      for (const panel of (proj.imagePanels || [])) {
        const image = await recompressField(panel.dataUrl);
        if (image.changed) {
          panel.dataUrl = image.value;
          swatchesTouched++;
        }
      }
    }
    saveState(appState);
    ItemTypes.refresh();
    Cases.refresh();
    Grid.refresh();
    Viewer3D.refresh();
    alert(imagesProcessed > 0
      ? `Recompressed ${imagesProcessed} photo${imagesProcessed === 1 ? '' : 's'} across ${swatchesTouched} swatch${swatchesTouched === 1 ? '' : 'es'}/panel${swatchesTouched === 1 ? '' : 's'}. ${skippedAlreadySmall} photo${skippedAlreadySmall === 1 ? '' : 's'} ${skippedAlreadySmall === 1 ? 'was' : 'were'} already small enough and left alone.`
      : `Nothing to recompress -- every photo (${skippedAlreadySmall}) is already a small size.`);
  });

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
