/**
 * BPMDetector
 * -----------
 * Real-time tempo (beats-per-minute) estimation from a live microphone stream.
 *
 * How it works:
 *   1. The microphone stream is routed through a low-pass filter so that the
 *      kick drum / bass line (which carry the beat) dominate the signal.
 *   2. A ScriptProcessor computes the short-term energy (RMS) of every audio
 *      block. The rectified frame-to-frame *increase* in energy — an "onset
 *      strength" envelope — is stored in a rolling buffer.
 *   3. The autocorrelation of that envelope is computed over the lag range that
 *      corresponds to the allowed BPM window. The lag with the strongest
 *      correlation is the beat period; BPM = 60 * envRate / lag.
 *   4. Estimates are median-smoothed over time for a stable read-out, and a
 *      lightweight adaptive-threshold detector fires beat "flashes" for the UI.
 *
 * The whole thing runs client-side with the Web Audio API — no libraries.
 */
class BPMDetector {
  constructor(options = {}) {
    this.minBPM = options.minBPM ?? 60;
    this.maxBPM = options.maxBPM ?? 180;

    // Callbacks
    this.onBpm = options.onBpm ?? (() => {});
    this.onBeat = options.onBeat ?? (() => {});
    this.onLevel = options.onLevel ?? (() => {});
    this.onError = options.onError ?? (() => {});

    // Metronome click on each detected beat
    this.clickEnabled = options.click ?? false;
    this.clickVolume = options.clickVolume ?? 0.3;

    // Audio graph nodes
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.filter = null;
    this.processor = null;

    this.running = false;

    // Onset-strength envelope ring buffer
    this.envBufferSeconds = 8;
    this.envSampleRate = 0;
    this.envBuffer = null;
    this.envWrite = 0;
    this.envFilled = 0;
    this.lastEnergy = 0;

    // Adaptive beat detection (for the visual flash)
    this.recentEnergy = [];
    this.recentEnergyMax = 0;
    this.lastBeatTime = 0;

    // BPM smoothing
    this.bpmHistory = [];
    this.analyzeTimer = null;
  }

  /** Whether the browser can capture microphone audio at all. */
  static isSupported() {
    return !!(
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext)
    );
  }

  async start() {
    if (this.running) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // We want the raw sound of the room, not a cleaned-up voice call.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    } catch (err) {
      this.onError(err);
      throw err;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioCtx();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.source = this.audioContext.createMediaStreamSource(this.stream);

    // Low-pass to isolate the beat-carrying low end (kick / bass ~40-150 Hz).
    this.filter = this.audioContext.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 150;
    this.filter.Q.value = 1;

    const bufferSize = 512;
    this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    this.envSampleRate = this.audioContext.sampleRate / bufferSize;

    const envLen = Math.ceil(this.envSampleRate * this.envBufferSeconds);
    this.envBuffer = new Float32Array(envLen);
    this.envWrite = 0;
    this.envFilled = 0;
    this.lastEnergy = 0;
    this.recentEnergy = [];
    this.recentEnergyMax = 0;
    this.lastBeatTime = 0;
    this.bpmHistory = [];

    this.processor.onaudioprocess = (e) => this._processBlock(e);

    // Wire the graph. The ScriptProcessor must reach a destination to fire on
    // some browsers, so we route it through a muted gain node.
    this.source.connect(this.filter);
    this.filter.connect(this.processor);
    const mute = this.audioContext.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(this.audioContext.destination);

    this.running = true;
    this.analyzeTimer = setInterval(() => this._analyze(), 500);
  }

  _processBlock(event) {
    const input = event.inputBuffer.getChannelData(0);
    const n = input.length;

    let sumSquares = 0;
    for (let i = 0; i < n; i++) {
      sumSquares += input[i] * input[i];
    }
    const rms = Math.sqrt(sumSquares / n);

    // Onset strength: only the *rise* in energy marks a new beat.
    const flux = Math.max(0, rms - this.lastEnergy);
    this.lastEnergy = rms;

    this.envBuffer[this.envWrite] = flux;
    this.envWrite = (this.envWrite + 1) % this.envBuffer.length;
    if (this.envFilled < this.envBuffer.length) this.envFilled++;

    this._detectBeatFlash(rms);
    this.onLevel(rms);
  }

  /** Simple adaptive-threshold onset for the visual pulse (not used for BPM). */
  _detectBeatFlash(rms) {
    const history = this.recentEnergy;
    history.push(rms);
    // Keep roughly the last ~0.7s of blocks.
    const maxHistory = Math.max(8, Math.round(this.envSampleRate * 0.7));
    if (history.length > maxHistory) history.shift();

    let avg = 0;
    for (let i = 0; i < history.length; i++) avg += history[i];
    avg /= history.length;

    this.recentEnergyMax = Math.max(this.recentEnergyMax * 0.999, rms);
    const floor = this.recentEnergyMax * 0.06; // ignore near-silence

    const now = performance.now();
    const sinceLast = now - this.lastBeatTime;

    if (rms > avg * 1.35 && rms > floor && sinceLast > 180) {
      this.lastBeatTime = now;
      this.onBeat();
      if (this.clickEnabled) this._playClick();
    }
  }

  /** Enable/disable the metronome click at runtime. */
  setClick(enabled) {
    this.clickEnabled = !!enabled;
  }

  /** Synthesize a short percussive click through the live AudioContext. */
  _playClick() {
    const ctx = this.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1600, now);

    // Fast attack, quick exponential decay — a tight metronome "tick".
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(this.clickVolume, now + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.06);
    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (_) {}
    };
  }

  _analyze() {
    // Need at least a few seconds of signal for a trustworthy estimate.
    if (this.envFilled < this.envSampleRate * 3) return;

    const n = this.envFilled;
    const buf = new Float32Array(n);
    const len = this.envBuffer.length;
    const start = (this.envWrite - n + len * 2) % len;
    for (let i = 0; i < n; i++) {
      buf[i] = this.envBuffer[(start + i) % len];
    }

    // Remove the DC component so the autocorrelation reflects periodicity, not
    // overall loudness.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += buf[i];
    mean /= n;
    for (let i = 0; i < n; i++) buf[i] -= mean;

    const fs = this.envSampleRate;
    const lagMin = Math.floor((60 / this.maxBPM) * fs);
    const lagMax = Math.min(n - 1, Math.ceil((60 / this.minBPM) * fs));

    let globalMax = -Infinity;
    let acfSum = 0;
    let acfCount = 0;
    const acf = new Float32Array(lagMax + 2);

    for (let lag = lagMin; lag <= lagMax; lag++) {
      let sum = 0;
      const limit = n - lag;
      for (let i = 0; i < limit; i++) {
        sum += buf[i] * buf[i + lag];
      }
      sum /= limit; // normalise by overlap so all multiples of the period peak equally
      acf[lag] = sum;
      acfSum += sum;
      acfCount++;
      if (sum > globalMax) globalMax = sum;
    }

    if (globalMax <= 0) return;

    // A perfectly periodic beat correlates at the period *and every multiple of
    // it*, so the raw maximum is often a half/third-tempo harmonic. Choose the
    // fundamental: the smallest-lag local maximum that is close to the global
    // peak.
    const threshold = globalMax * 0.75;
    let bestLag = -1;
    for (let lag = lagMin + 1; lag < lagMax; lag++) {
      if (acf[lag] >= threshold && acf[lag] > acf[lag - 1] && acf[lag] >= acf[lag + 1]) {
        bestLag = lag;
        break;
      }
    }
    if (bestLag < 0) {
      // Fallback to the global argmax.
      let bv = -Infinity;
      for (let lag = lagMin; lag <= lagMax; lag++) {
        if (acf[lag] > bv) { bv = acf[lag]; bestLag = lag; }
      }
    }
    if (bestLag <= 0) return;

    // Parabolic interpolation around the peak for sub-lag precision (matters at
    // high tempo, where a single lag step spans several BPM).
    let refinedLag = bestLag;
    if (bestLag > lagMin && bestLag < lagMax) {
      const a = acf[bestLag - 1];
      const b = acf[bestLag];
      const c = acf[bestLag + 1];
      const denom = a - 2 * b + c;
      if (denom !== 0) {
        const delta = (0.5 * (a - c)) / denom;
        if (Math.abs(delta) < 1) refinedLag = bestLag + delta;
      }
    }

    let bpm = (60 * fs) / refinedLag;
    bpm = this._foldOctave(bpm);

    // Confidence: how much the winning lag stands out from the average.
    const acfMean = acfCount ? acfSum / acfCount : 0;
    const bestVal = acf[bestLag];
    const spread = bestVal - acfMean;
    let confidence = 0;
    if (bestVal > 0 && spread > 0) {
      confidence = Math.max(0, Math.min(1, spread / (Math.abs(bestVal) + 1e-9)));
    }

    // Median-smooth the BPM over recent estimates for a stable read-out.
    this.bpmHistory.push(bpm);
    if (this.bpmHistory.length > 8) this.bpmHistory.shift();
    const sorted = [...this.bpmHistory].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    this.onBpm(Math.round(median), {
      instantaneous: bpm,
      confidence,
    });
  }

  /** Fold obvious octave errors back into the allowed BPM window. */
  _foldOctave(bpm) {
    let out = bpm;
    while (out < this.minBPM && out * 2 <= this.maxBPM) out *= 2;
    while (out > this.maxBPM && out / 2 >= this.minBPM) out /= 2;
    return out;
  }

  stop() {
    this.running = false;
    if (this.analyzeTimer) {
      clearInterval(this.analyzeTimer);
      this.analyzeTimer = null;
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try { this.processor.disconnect(); } catch (_) {}
    }
    if (this.filter) try { this.filter.disconnect(); } catch (_) {}
    if (this.source) try { this.source.disconnect(); } catch (_) {}
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (_) {}
    }
    this.audioContext = null;
    this.bpmHistory = [];
  }
}

// Export for module contexts while remaining a global for the plain <script> tag.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BPMDetector;
}
