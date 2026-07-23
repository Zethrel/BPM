# 🎵 BPM Counter

A phone-friendly web app that detects the **tempo (beats per minute)** of any
song in real time using your device's microphone. Point your phone at a
speaker, tap **Start**, and it reads the BPM.

It's a **Progressive Web App (PWA)** — it runs in any modern mobile browser
(iOS Safari, Android Chrome), works offline after the first load, and can be
installed to your home screen like a native app. No app store, no accounts,
and **all audio processing happens on-device** — nothing is recorded or
uploaded.

## Features

- 🎤 **Live BPM detection** from the microphone
- 🥁 **Metronome click** on every detected beat (toggleable; preference is saved)
- 👆 **Tap tempo** fallback for when there's no music playing (or tap the
  spacebar on desktop)
- 📊 Real-time input-level and confidence meters
- 💓 Visual beat pulse
- 📲 Installable & offline-capable (PWA)
- 🔒 Fully client-side — audio never leaves the device

## How it works

The tempo is estimated with a classic, dependency-free DSP pipeline
(`js/bpm-detector.js`):

1. **Low-pass filter** — the mic signal is filtered to ~150 Hz so the kick
   drum and bass line (which carry the beat) dominate.
2. **Onset envelope** — the short-term energy (RMS) of each audio block is
   measured, and the frame-to-frame *rise* in energy forms an "onset strength"
   signal stored in a rolling 8-second buffer.
3. **Autocorrelation** — the envelope is autocorrelated over the lag range that
   corresponds to 60–180 BPM. The strongest lag is the beat period, and
   `BPM = 60 × envelopeRate ÷ lag`.
4. **Smoothing** — successive estimates are median-smoothed for a stable
   read-out, and obvious octave errors (half/double tempo) are folded back into
   range.

## Running it

Because the microphone requires a **secure context**, serve the folder over
`https://` or `http://localhost` (opening `index.html` directly via `file://`
won't grant mic access).

```bash
# any static file server works, e.g.:
python3 -m http.server 8000
# then open http://localhost:8000 on your computer
```

To try it on your **phone**, host the folder anywhere that serves HTTPS
(GitHub Pages, Netlify, Vercel, or your LAN with a self-signed cert) and open
the URL on the device. Grant microphone permission when prompted.

### Deploy to GitHub Pages

This is a fully static site, so GitHub Pages works out of the box: enable Pages
for the repository (Settings → Pages → deploy from branch) and the app will be
served over HTTPS.

## Project structure

```
index.html              App shell / UI
css/style.css           Styles (dark, mobile-first)
js/bpm-detector.js      Microphone capture + tempo estimation engine
js/app.js               UI wiring, tap-tempo, service-worker registration
manifest.webmanifest    PWA manifest
service-worker.js       Offline caching
icons/                  App icons (SVG)
```

## Notes & limitations

- Works best with music that has a clear, steady beat. Very sparse, rubato, or
  purely ambient tracks are hard to track (as they are for people, too).
- Give it a few seconds — the estimate stabilises once enough audio is
  buffered.
- Background/ambient noise reduces confidence; get the mic reasonably close to
  the source.
