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
})();
