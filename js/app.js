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
  const downbeatBtn = el('downbeat-btn');
  const timesig = el('timesig');
  const timesigHint = el('timesig-hint');

  let detector = null;
  let listening = false;
  let suggestedBeats = 0;

  const METER_LABELS = { 2: '2/4', 3: '3/4', 4: '4/4', 6: '6/8' };

  // Restore the saved time signature.
  try {
    const savedSig = localStorage.getItem('bpm.timesig');
    if (savedSig) timesig.value = savedSig;
  } catch (_) { /* storage may be unavailable */ }

  timesig.addEventListener('change', () => {
    const beats = parseInt(timesig.value, 10) || 4;
    if (detector) detector.setBeatsPerBar(beats);
    try { localStorage.setItem('bpm.timesig', String(beats)); } catch (_) {}
    // Hide the hint if it now matches the manual choice.
    if (suggestedBeats === beats) timesigHint.hidden = true;
  });

  timesigHint.addEventListener('click', () => {
    if (!suggestedBeats) return;
    timesig.value = String(suggestedBeats);
    timesig.dispatchEvent(new Event('change'));
    timesigHint.hidden = true;
  });

  // The "set the 1" control only makes sense while the metronome is clicking.
  function updateDownbeatBtn() {
    downbeatBtn.disabled = !(listening && clickToggle.checked);
  }

  // Restore the saved metronome-click preference.
  try {
    clickToggle.checked = localStorage.getItem('bpm.click') === '1';
  } catch (_) { /* storage may be unavailable */ }

  clickToggle.addEventListener('change', () => {
    if (detector) detector.setClick(clickToggle.checked);
    try { localStorage.setItem('bpm.click', clickToggle.checked ? '1' : '0'); } catch (_) {}
    updateDownbeatBtn();
  });

  downbeatBtn.addEventListener('click', () => {
    if (!detector) return;
    detector.resyncDownbeat();
    downbeatBtn.classList.remove('flash');
    void downbeatBtn.offsetWidth;
    downbeatBtn.classList.add('flash');
    setTimeout(() => downbeatBtn.classList.remove('flash'), 160);
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
      beatsPerBar: parseInt(timesig.value, 10) || 4,
      onMeter: (beats) => {
        const label = METER_LABELS[beats];
        if (!label) return;
        suggestedBeats = beats;
        const current = parseInt(timesig.value, 10) || 4;
        if (beats === current) {
          timesigHint.textContent = `Auto-guess: ${label} ✓ (matches)`;
          timesigHint.hidden = false;
        } else {
          timesigHint.textContent = `Auto-guess: ${label} · tap to use`;
          timesigHint.hidden = false;
        }
      },
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
      updateDownbeatBtn();
    } catch (_) {
      listening = false;
      toggleBtn.classList.remove('active');
      toggleLabel.textContent = 'Start';
      updateDownbeatBtn();
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
    updateDownbeatBtn();
    timesigHint.hidden = true;
    suggestedBeats = 0;
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
