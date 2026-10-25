// Launch intro: the pallet-stacking animation plays in the middle of the screen,
// then the finished stack shrinks into the header, left of the title, and rests
// there. Plays once per browser session. When it is skipped (reload, reduced
// motion) the header logo is drawn straight away on the finished frame.
// The overlay markup is in index.html and the look is in css/style.css, which
// also hides the overlay on its own if this file never runs.

(function () {
  const SEEN_KEY = 'pm-splash-seen';
  const HOLD_MS = 250;     // pause on the finished stack before it flies
  const FLY_MS = 700;      // matches the transition on .splash .logo-stage in style.css
  const GIVE_UP_MS = 4000; // if the animation never reports it finished, fly anyway
  // Crop of the 640 x 640 canvas around the pallet and cases, so the small header logo is not mostly margin.
  const VIEW_BOX = '50 100 540 520';

  const root = document.documentElement;
  const splash = document.getElementById('splash');
  const slot = document.getElementById('header-logo');

  function finish() {
    root.classList.add('logo-ready');
    if (splash) splash.remove();
  }

  function load(container, autoplay) {
    return lottie.loadAnimation({
      container: container,
      renderer: 'svg',
      loop: false,
      autoplay: autoplay,
      animationData: window.PALLET_INTRO,
      rendererSettings: { viewBoxSize: VIEW_BOX, preserveAspectRatio: 'xMidYMid meet' },
    });
  }

  function makeStage(parent) {
    const el = document.createElement('div');
    el.className = 'logo-stage';
    parent.appendChild(el);
    return el;
  }

  function showFinished(anim) {
    const last = () => anim.goToAndStop(Math.max(0, anim.totalFrames - 1), true);
    if (anim.isLoaded) last(); else anim.addEventListener('DOMLoaded', last);
  }

  function run() {
    if (typeof lottie === 'undefined' || !window.PALLET_INTRO || !slot) { finish(); return; }

    if (root.classList.contains('no-splash') || !splash) {
      showFinished(load(makeStage(slot), false));
      finish();
      return;
    }

    try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* private mode: it may replay, harmless */ }

    const stage = document.getElementById('logo-stage');
    const anim = load(stage, true);
    let flown = false;

    function fly() {
      if (flown) return;
      flown = true;
      const from = stage.getBoundingClientRect();
      const to = slot.getBoundingClientRect();
      if (!from.width || !to.width) { showFinished(load(makeStage(slot), false)); finish(); return; }
      const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
      const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
      splash.classList.add('flying');
      stage.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(' + (to.width / from.width) + ')';
      setTimeout(() => {
        // Hand over to a still copy in the header: the same finished frame, so nothing visibly jumps.
        showFinished(load(makeStage(slot), false));
        finish();
      }, FLY_MS + 80);
    }

    anim.addEventListener('complete', () => setTimeout(fly, HOLD_MS));
    setTimeout(fly, GIVE_UP_MS);
  }

  run();
})();
