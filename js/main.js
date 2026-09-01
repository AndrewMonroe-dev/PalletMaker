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
      if (btn.dataset.tab === 'viewer3d') Viewer3D.refresh();
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
    if (document.visibilityState === 'hidden') saveState(appState);
  });
  window.addEventListener('pagehide', () => saveState(appState));
})();
