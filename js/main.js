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
