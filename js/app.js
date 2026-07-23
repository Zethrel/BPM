/* global BPMDetector */
(() => {
  'use strict';

  const el = (id) => document.getElementById(id);

  const bpmValue = el('bpm-value');
  const bpmSub = el('bpm-sub');
  const toggleBtn = el('toggle-btn');
  const toggleLabel = el('toggle-label');
  const statusEl = el('status');
  const pulse = el('pulse');
  const levelBar = el('level-bar');
  const confBar = el('conf-bar');
  const tapBtn = el('tap-btn');
  const tapBpm = el('tap-bpm');
  const clickToggle = el('click-toggle');

  let detector = null;
  let listening = false;

  // Restore the saved metronome-click preference.
  try {
    clickToggle.checked = localStorage.getItem('bpm.click') === '1';
  } catch (_) { /* storage may be unavailable */ }

  clickToggle.addEventListener('change', () => {
    if (detector) detector.setClick(clickToggle.checked);
    try { localStorage.setItem('bpm.click', clickToggle.checked ? '1' : '0'); } catch (_) {}
  });

  // ---- Live detection ------------------------------------------------------

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function flashBeat(isDownbeat) {
    pulse.classList.remove('beat', 'downbeat');
    // Force reflow so the animation can retrigger.
    void pulse.offsetWidth;
    pulse.classList.add('beat');
    if (isDownbeat) pulse.classList.add('downbeat');
  }

  async function startListening() {
    if (!BPMDetector.isSupported()) {
      setStatus('This browser can’t access the microphone. Try Chrome or Safari.');
      return;
    }

    detector = new BPMDetector({
      minBPM: 60,
      maxBPM: 180,
      click: clickToggle.checked,
      onBpm: (bpm, info) => {
        bpmValue.textContent = bpm;
        bpmSub.textContent = 'beats per minute';
        const pct = Math.round((info.confidence || 0) * 100);
        confBar.style.width = pct + '%';
        confBar.parentElement.setAttribute('aria-valuenow', String(pct));
      },
      onBeat: flashBeat,
      onLevel: (rms) => {
        const pct = Math.min(100, Math.round(rms * 400));
        levelBar.style.width = pct + '%';
      },
      onError: (err) => {
        if (err && err.name === 'NotAllowedError') {
          setStatus('Microphone permission denied. Enable it in your browser settings.');
        } else {
          setStatus('Could not start the microphone: ' + (err.message || err.name || err));
        }
      },
    });

    try {
      setStatus('Requesting microphone…');
      await detector.start();
      listening = true;
      toggleBtn.classList.add('active');
      toggleLabel.textContent = 'Stop';
      bpmSub.textContent = 'listening…';
      setStatus('Listening — play a song near the microphone.');
    } catch (_) {
      listening = false;
      toggleBtn.classList.remove('active');
      toggleLabel.textContent = 'Start';
    }
  }

  function stopListening() {
    if (detector) {
      detector.stop();
      detector = null;
    }
    listening = false;
    toggleBtn.classList.remove('active');
    toggleLabel.textContent = 'Start';
    bpmSub.textContent = 'tap start to begin';
    levelBar.style.width = '0%';
    confBar.style.width = '0%';
    setStatus('Stopped.');
  }

  toggleBtn.addEventListener('click', () => {
    if (listening) stopListening();
    else startListening();
  });

  // ---- Tap tempo (manual fallback) -----------------------------------------

  let tapTimes = [];
  let tapResetTimer = null;

  function registerTap() {
    const now = performance.now();
    // Reset if it's been a while since the last tap.
    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) {
      tapTimes = [];
    }
    tapTimes.push(now);
    if (tapTimes.length > 8) tapTimes.shift();

    if (tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < tapTimes.length; i++) {
        intervals.push(tapTimes[i] - tapTimes[i - 1]);
      }
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round(60000 / avg);
      tapBpm.textContent = bpm + ' BPM';
    } else {
      tapBpm.textContent = 'keep tapping…';
    }

    tapBtn.classList.remove('tapped');
    void tapBtn.offsetWidth;
    tapBtn.classList.add('tapped');

    clearTimeout(tapResetTimer);
    tapResetTimer = setTimeout(() => {
      tapTimes = [];
    }, 3000);
  }

  tapBtn.addEventListener('click', registerTap);
  // Let the spacebar drive tap tempo for desktop testing.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && document.activeElement !== toggleBtn) {
      e.preventDefault();
      registerTap();
    }
  });

  // Stop cleanly if the page is hidden/backgrounded.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && listening) stopListening();
  });

  // ---- Service worker (installable PWA) ------------------------------------

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {
        /* offline support is best-effort */
      });
    });
  }
})();
