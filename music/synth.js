// synth.js - every sound of STILLRAIN, made live by Web Audio from the same tables the picture reads. No sound files.
//
// What it builds (window.FILM.music), section by section below:
//   1. envelopes: breakpoint curves written onto AudioParams, which can also be joined half-way after a seek
//   2. a DSP kit that renders the long buffers from seeded noise (noise, rain patter, glitter, the reverb impulse,
//      kalimba plucks), in a Web Worker while the film loads
//   3. the desk: one mixing graph per AudioContext (beds, buses, reverb, echo, compressor, limiter, soft clip)
//   4. 44 instruments: INST[kind] builds the oscillators, filters and envelopes of one note
//   5. an analysis of the rain field: how much rain falls near the ear, and which drops let go near it
//   6. the cue sheet: every sound of the film as { film time, instrument, arguments }
//   7. lanes: slow control curves over film time (wind, gust, rain beds, music level, reverb, echo, master)
//   8. a lookahead scheduler (film time -> AudioContext time), the public API and an offline renderer
//
// How it works: nothing is improvised at play time. The cue sheet and the lanes are computed once, as pure functions of
// the shared tables, so every sound has a fixed film time and a live run, a seek and an offline render all agree.
// A toll of film/events.js gets its sound at its t0 to the millisecond (check()). The plink of a drop letting go uses
// the same release math as the picture (tr = t0 + distance / 30 m/s + hold + 0.08 seed), so it is heard at the moment
// the picture lets the drop go. The rain bed is as loud as the amount of rain that math says is falling near the shot's
// subject (the 'ear').
//
// What it reads (never copies):
//   FILM.score   tempo, bars, shots            FILM.events.T   every toll: time, place, note, band, reach, hold
//   FILM.path    Pell, the hops, the heart drop H, the special drops, the fans, the field's centre
//   FILM.events.releaseTime / hitTau / fall / posAt   when each drop of the field lets go, how far it falls, when it lands
//   FILM.valley  ground height, places, cisterns      FILM.anim   clamp, lerp, sm (smoothstep), hash, named (seeded streams)
//   FILM.rain.sets (if present)   the picture's own drops;  FILM.life / FILM.crowd (if present)   birds, frogs, plops, laughs, stomps
//   The last three are optional (tools/build.py --skip can leave a module out); without one, a stand-in of the same shape is used.
//
// Harmony (film/BIBLE.md section 7): D Lydian split into WET (D E A, they bring rain) and DRY (F# G# B C#, they bring nothing).
//   1. the underscore plays a wet note only while rain visibly falls;  2. every diegetic wet note releases something;
//   3. bars 21-22 are silent but for wind, breath, one plip and the test hum.
//   The tonic D is withheld. Before 27.0 it is heard only as single in-world notes that each release a drop (the frog at
//   14.25, Pell's hum at 20.25). It first sounds as a chord at 27.0 (the drum and its overtone chord, the bowl answering),
//   arrives in full at 69.0 (the fall), and resolves last on the palm drop (90.3).
//
// API (main.js calls these):
//   FILM.music.start()            create / resume the AudioContext (inside a user gesture), play from the film's current time
//   FILM.music.pause(bool)        suspend / resume
//   FILM.music.seek(t)            cancel what is scheduled and schedule again from film time t
//   FILM.music.clock()            film time from the audio clock while playing (null before start / while not running)
//   FILM.music.mute()             toggle; returns true when now muted
//   FILM.music.offline(sr, from, dur, opts) -> Promise<AudioBuffer>  the same score rendered in an OfflineAudioContext
//                                  (opts.only 'beds' | 'mus' | 'sfx' for one stem, opts.kinds [...] for some instruments only)
// More: add(group, cues) (other modules' micro emitters; call it before start()), check() (every toll has its sound),
//   CUES (the cue sheet), lanes, rainAt(t), voice, state, stats, INST. Full tables in Korean: music/SOUND.md.
//
// How to hear it: open the built film and click. To render and measure it without a browser window:
//   node tools/listen.mjs --out build/sound.wav --clicks        (more options in tools/listen.mjs: stems, spectra, onsets)
// Units: times in seconds (film time unless it says context time), distances in metres, pitches as note names or Hz.
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim, S = F.score, P = F.path, EV = F.events, V = F.valley;
  const { clamp, lerp, sm } = A;
  // LEN 93 s, BEAT 0.75 s (80 bpm), BAR 3 s; E8 / E16 are an eighth and a sixteenth note in seconds
  const TAU = Math.PI * 2, LEN = S.LEN, BEAT = S.BEAT, BAR = S.BAR, E8 = BEAT / 2, E16 = BEAT / 4;
  const hz = n => S.hz(n);                                        // a note name ('F#4') or a MIDI number -> Hz
  const cents = (f, c) => f * Math.pow(2, c / 1200);              // f moved by c cents (100 cents = a semitone)
  const bt = (bar, beat = 0) => (bar - 1) * BAR + beat * BEAT;          // bars are 1-based here, like the bible's tables
  const H = (a, b = 0, c = 0) => A.hash(a, b, c);                // a seeded 0..1 hash: the only source of 'randomness'
  const qs = new URLSearchParams(location.search);
  // ?voice=ocarina swaps Pell's formant voice for a plainer ocarina tone (the fallback of film/BIBLE.md section 9, risk 5)
  let VOICE = qs.get('voice') === 'ocarina' ? 'ocarina' : 'formant';

  // ============================================================================================================
  // 1. Envelopes. pts = [[dt, value, curve]]: dt in seconds from the sound's start; the curve type belongs to the
  //    segment that ends at that point: 'l' linear (default), 'e' exponential, 's' step (hold, then jump).
  //    env() starts `off` seconds into the curve, so a sound joined in the middle on a seek starts at the right level.
  // ============================================================================================================
  // envAt: the curve's value at x seconds, the JS twin of what the Web Audio ramps draw. An exponential segment that
  // touches 0 cannot be exponential, so it falls back to linear here (Web Audio would hold, then jump).
  function envAt(pts, x) {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) { const b = pts[i]; if (x < b[0]) { const a = pts[i - 1], k = (x - a[0]) / Math.max(1e-9, b[0] - a[0]);
      if (b[2] === 's') return a[1]; if (b[2] === 'e' && a[1] > 0 && b[1] > 0) return a[1] * Math.pow(b[1] / a[1], k); return a[1] + (b[1] - a[1]) * k; } }
    return pts[pts.length - 1][1];
  }
  // env: write the curve onto an AudioParam. `when` is the context time of the curve's point `off`; points already
  // passed are skipped, the rest become ramps. Values are multiplied by `scale`. Exponential ramps cannot reach 0,
  // so their targets are floored at 1e-5 (-100 dB).
  function env(param, when, off, pts, scale = 1) {
    param.setValueAtTime(envAt(pts, off) * scale, when);
    for (const p of pts) { if (p[0] <= off) continue; const tt = when + p[0] - off, v = p[1] * scale;
      if (p[2] === 's') param.setValueAtTime(v, tt); else if (p[2] === 'e') param.exponentialRampToValueAtTime(Math.max(1e-5, v), tt); else param.linearRampToValueAtTime(v, tt); }
  }
  const pw = pts => t => envAt(pts, t);                       // a breakpoint curve as a plain function (used for lanes of film time)

  // ============================================================================================================
  // 2. Buffers, rendered from seeded noise (no Math.random). AudioBuffers are shared by the live and offline contexts.
  //    The DSP kit below is self-contained so it can also run in a worker made from its own source: the buffers are
  //    rendered off the main thread while the film loads, and anything not delivered yet is rendered here when needed.
  //    Same code, same seeds: the samples are identical either way.
  //    Each buffer is a list of Float32Array channels; the recipes take the sample rate `sr` (48 kHz in practice).
  // ============================================================================================================
  function DSPKIT() {
    // DSPKIT is sent to the worker as text (DSPKIT.toString()), so it may use nothing from outside its own body
    const TAU = Math.PI * 2, lerp = (a, b, k) => a + (b - a) * k, clamp = (x, a = 0, b = 1) => x < a ? a : x > b ? b : x;
    // seeded streams: the same mulberry32 + FNV-1a as FILM.anim.named (copied so the kit stands alone in a worker)
    const rng = seed => { let s = seed >>> 0; return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
    const named = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return rng(h >>> 0); };
    // a sine table, so the thousands of patter hits need no Math.sin per sample
    const SIN = new Float32Array(4096); for (let i = 0; i < 4096; i++) SIN[i] = Math.sin(TAU * i / 4096);
    // make a loop seamless: the channel was rendered m samples too long, and that extra tail is cross-faded into its head
    function loopify(ch, m) { const n = ch.length - m, o = new Float32Array(n); o.set(ch.subarray(0, n)); for (let i = 0; i < m; i++) { const k = i / m; o[i] = ch[i] * k + ch[n + i] * (1 - k); } return o; }
    // white noise, one seeded stream per channel
    function noiseBuf(sr, sec, seed) { const n = Math.floor(sr * sec); return [0, 1].map(c => { const r = named(seed + c), d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = r() * 2 - 1; return d; }); }
    // rain patter: a bed of filtered noise and thousands of tiny drop hits (each a short rising chirp, like a bubble).
    //   o.nlp   one-pole low-pass coefficient of the bed noise (small = dark)    o.noise  the bed's level
    //   o.rate  hits per second            o.f0..o.f1  hit pitch in Hz, spread evenly on a log scale
    //   o.dec0..o.dec1  hit decay time constant (s); a hit lasts 4.6 of them (-40 dB)
    //   o.amp   loudest hit (pow(r, 1.8) makes most hits quiet)    o.chirp  the pitch rises by this fraction over a hit
    // Hits pan at random, start with a 6-sample fade-in (no click) and wrap past the end, so nothing breaks at the loop point.
    function patter(sr, sec, seed, o) {
      const n = Math.floor(sr * sec), m = Math.floor(sr * .03), N = n + m, L = new Float32Array(N), R = new Float32Array(N), r = named(seed);
      let yl = 0, yr = 0; for (let i = 0; i < N; i++) { yl += o.nlp * ((r() * 2 - 1) - yl); yr += o.nlp * ((r() * 2 - 1) - yr); L[i] = yl * o.noise; R[i] = yr * o.noise; }
      const count = Math.floor(o.rate * sec);
      for (let k = 0; k < count; k++) { const at = Math.floor(r() * N), f = o.f0 * Math.pow(o.f1 / o.f0, r()), dec = lerp(o.dec0, o.dec1, r()), amp = o.amp * Math.pow(r(), 1.8) * (r() < .5 ? -1 : 1), pan = r();
        const len = Math.floor(dec * sr * 4.6), w = 4096 * f / sr, dw = w * o.chirp / len, kd = Math.exp(-1 / (dec * sr)), gl = amp * (1 - pan * .75), gr = amp * (.25 + pan * .75); let e = 1, ph = 0, ww = w;
        for (let j = 0, idx = at; j < len; j++, idx++) { if (idx >= N) idx -= N; const sv = SIN[(ph | 0) & 4095] * e * (j < 6 ? j / 6 : 1); ph += ww; ww += dw; e *= kd; L[idx] += sv * gl; R[idx] += sv * gr; } }
      return [loopify(L, m), loopify(R, m)];
    }
    // the 'bowl': a generated impulse response, 3.2 s of stereo noise decaying 60 dB, bright early and dark late (air),
    // with a few early reflections off the terrace walls. The valley is a bowl of terraces, hence the name.
    //   kg: the gain falls by e^-6.9 (= -60 dB) over `sec`.   a: a one-pole low-pass coefficient sliding from 0.82
    //   (bright) to 0.07 (dark) along the tail.   14 ms pre-delay, 8 ms fade-in, then four reflections per side
    //   ([ms, gain]), opposite in sign left and right for width.
    function bowl(sr, sec = 3.2) {
      const n = Math.floor(sr * sec), pre = Math.floor(.014 * sr);
      return [0, 1].map(c => { const d = new Float32Array(n), r = named('bowl' + c); let y = 0;
        let a = .82, g = 1; const kg = Math.exp(-6.9 / (sec * sr));
        for (let i = pre; i < n; i++) { const t = (i - pre) / sr; if (((i - pre) & 63) === 0) a = lerp(.82, .07, Math.pow(t / sec, .55)); y += a * ((r() * 2 - 1) - y); d[i] = y * g * (t < .008 ? t / .008 : 1); g *= kg; }
        for (const [ms, gg] of (c ? [[19, .42], [43, .3], [71, .2], [103, .12]] : [[24, .4], [37, .32], [61, .22], [92, .14]])) { const i = Math.floor(ms * .001 * sr); d[i] += gg * (c ? -1 : 1); d[i + 2] += gg * .5; }
        return d; });
    }
    // the kalimba: Karplus-Strong (a plucked delay line with an averaging loss filter) plus the tine's inharmonic ring.
    // The first millisecond fades in, so the pluck is crisp but never a click.
    //   Tuning: a loop of N samples plus the averaging filter's half-sample delay sounds at sr / (N + 0.5), never exactly f,
    //   so the buffer is played back at `rate` = f / that, which lands on f.
    //   dur: low notes ring longer (1.1-3.2 s). rho: the loss per trip round the loop, so the string falls 60 dB
    //   (6.91 = ln 1000) in half of dur. The pluck is low-passed noise plus a half-sine bump, Hann-windowed.
    //   Returns { data, rate }; the peak is normalised to 0.85 and the last 60 ms fade out.
    function ks(sr, f, seed) {
      const dur = clamp(3.4 - Math.log2(f / 220) * .8, 1.1, 3.2), n = Math.floor(sr * dur), out = new Float32Array(n);
      const N = Math.max(2, Math.round(sr / f - .5)), rate = f / (sr / (N + .5)), buf = new Float32Array(N), r = named('ks' + seed);
      let y = 0; for (let i = 0; i < N; i++) { y += .38 * ((r() * 2 - 1) - y); const win = .5 - .5 * Math.cos(TAU * i / N); buf[i] = (y * 2.2 + .55 * Math.sin(Math.PI * i / N)) * win; }
      const rho = Math.exp(-6.91 * (N + .5) / (dur * .5 * sr)); let idx = 0, pk = 1e-9;
      // the tine partial (6.27 f, 70 ms decay) as a decaying phasor (no sin/exp per sample); only where it stays under 0.42 sr
      const tine = f * 6.27 * rate < sr * .42, wt = TAU * 6.27 * f / sr, cw = Math.cos(wt), sw = Math.sin(wt), kt = Math.exp(-1 / (sr * .07)); let tx = .22, ty = 0;
      for (let i = 0; i < n; i++) { const a = buf[idx], j = idx + 1 === N ? 0 : idx + 1, b = buf[j]; out[i] = a; buf[idx] = rho * .5 * (a + b); idx = j;
        if (tine && i < sr * .6) { out[i] += ty * (i < 8 ? i / 8 : 1); const nx = (tx * cw - ty * sw) * kt; ty = (tx * sw + ty * cw) * kt; tx = nx; } }
      for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
      const fo = Math.floor(sr * .06), fi = Math.floor(sr * .001); for (let i = 0; i < n; i++) { out[i] *= .85 / pk; if (i < fi) out[i] *= i / fi; if (i > n - fo) out[i] *= (n - i) / fo; }
      return { data: out, rate };
    }
    // every long buffer has its own recipe -> [channels]. Where f0 and f1 are a hair apart, every hit rings one pitch:
    // 2637.02 Hz is E7 and 5274.04 Hz is E8, the mist's own note (chirp 0: a pure ring, no rise).
    //   noise     4 s of white noise: wind, gust, hiss, breath and every noise burst of the instruments
    //   patterH   heavy rain: big low splats, 260-1400 Hz, 260 hits/s       patterM   marble rain: small bright ticks, 1.5-6 kHz, 900/s
    //   glitter   tiny E7 rings (mist letting go; sparkle)                  glitter8  E8 rings (the bead strings; sparkle a.oct8)
    //   drizzle   sparse E7 rings for the mist bed                          bowl      the reverb's impulse response
    const RECIPES = {
      noise: sr => noiseBuf(sr, 4, 'synth-noise'),
      patterH: sr => patter(sr, 4, 'patterH', { nlp: .12, noise: .16, rate: 260, f0: 260, f1: 1400, dec0: .006, dec1: .02, amp: .55, chirp: .6 }),
      patterM: sr => patter(sr, 3, 'patterM', { nlp: .55, noise: .10, rate: 900, f0: 1500, f1: 6000, dec0: .002, dec1: .006, amp: .32, chirp: .4 }),
      glitter: sr => patter(sr, 2, 'glitter', { nlp: .9, noise: .012, rate: 34, f0: 2637.02, f1: 2637.03, dec0: .02, dec1: .06, amp: .5, chirp: 0 }),
      glitter8: sr => patter(sr, 3, 'glitter8', { nlp: .9, noise: .008, rate: 22, f0: 5274.04, f1: 5274.05, dec0: .012, dec1: .04, amp: .35, chirp: 0 }),
      drizzle: sr => patter(sr, 4, 'drizzle', { nlp: .9, noise: .004, rate: 7, f0: 2637.02, f1: 2637.03, dec0: .015, dec1: .04, amp: .5, chirp: 0 }),
      bowl: sr => bowl(sr),
    };
    return { RECIPES, ks };
  }
  // KIT: the kit on the main thread. BUFS: one buffer store per sample rate. KAL_COMMON: the dry kalimba notes of the
  // ostinato and the run, rendered ahead; any other kalimba note is rendered the first time it is played.
  const KIT = DSPKIT(), BUFS = new Map(), KAL_COMMON = ['F#4', 'G#4', 'B4', 'C#5', 'F#5', 'G#5', 'B5', 'C#6'];
  // Float32Array channels -> AudioBuffer
  function mk(sr, chans) { const b = new AudioBuffer({ length: chans[0].length, numberOfChannels: chans.length, sampleRate: sr }); chans.forEach((c, i) => b.copyToChannel(c, i)); return b; }
  // the soft-clip transfer curve for the WaveShaper at the end of the desk: straight (x -> x) up to |x| = 0.6, then a tanh
  // knee that bends toward 0.88; since the shaper clamps its input to +-1, the output never passes 0.85 (-1.4 dBFS)
  const SOFTCLIP = (() => { const N = 4097, c = new Float32Array(N), a = .6, top = .88; for (let i = 0; i < N; i++) { const x = i / (N - 1) * 2 - 1, m = Math.abs(x);
    c[i] = Math.sign(x) * (m < a ? m : a + (top - a) * Math.tanh((m - a) / (top - a))); } return c; })();
  const kalKey = note => typeof note === 'number' ? note.toFixed(2) : note;   // a note name, or a MIDI number as text
  // the buffer store for one sample rate: B[recipe] (AudioBuffers), B.ks (kalimba notes: { buf, rate }), B.kal(note)
  // (a kalimba note, rendered on first use), plus timings for stats (B.ms, B.timing) and how many came from the worker
  function bufBase(sr) {
    let B = BUFS.get(sr); if (B) return B;
    B = { ks: {}, ms: 0, timing: {}, fromWorker: 0 };
    B.kal = note => { const k = kalKey(note); if (!B.ks[k]) { const x = KIT.ks(sr, hz(note), k); B.ks[k] = { buf: mk(sr, [x.data]), rate: x.rate }; } return B.ks[k]; };
    BUFS.set(sr, B); return B;
  }
  // one buffer (or the common kalimba notes) on the main thread, unless the worker has already delivered it
  function bufStep(sr, key) { const B = bufBase(sr); if (key === 'ksCommon' ? KAL_COMMON.every(n => B.ks[n]) : B[key]) return B; const a = performance.now();
    if (key === 'ksCommon') KAL_COMMON.forEach(B.kal); else B[key] = mk(sr, KIT.RECIPES[key](sr));
    const d = performance.now() - a; B.timing[key] = Math.round(d); B.ms += d; return B; }
  const BUF_KEYS = [...Object.keys(KIT.RECIPES), 'ksCommon'];
  // every buffer for this sample rate, made now if still missing (makeDesk calls this, so start() never lacks one)
  function bufs(sr) { let B; for (const k of BUF_KEYS) B = bufStep(sr, k); return B; }
  // the worker: renders every buffer and the common kalimba notes for one sample rate off the main thread.
  // Its source is DSPKIT's own text plus a small message handler, loaded from a Blob URL (no extra file to ship).
  // The channels come back as transferred ArrayBuffers (no copy). Whatever arrives first, the worker or the main
  // thread, is kept; the other is dropped. worker: null (not tried yet), false (failed or unavailable), a Worker, 'done'.
  let worker = null;
  function warm(sr) {
    if (worker !== null || typeof Worker === 'undefined') return; worker = false;
    try {
      const src = 'const KIT = (' + DSPKIT.toString() + ')();\nonmessage = e => { const { key, sr, f, k } = e.data, t = performance.now();\n' +
        '  if (key === "kal") { const x = KIT.ks(sr, f, k); postMessage({ key, sr, k, ch: [x.data], rate: x.rate, ms: performance.now() - t }, [x.data.buffer]); return; }\n' +
        '  const ch = KIT.RECIPES[key](sr); postMessage({ key, sr, ch, ms: performance.now() - t }, ch.map(c => c.buffer)); };';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), w = new Worker(url); let left = 0;
      w.onmessage = e => { const { key, sr: r, ch, ms, k, rate } = e.data, B = bufBase(r);
        if (key === 'kal') { if (!B.ks[k]) { B.ks[k] = { buf: mk(r, ch), rate }; B.fromWorker++; } }
        else if (!B[key]) { B[key] = mk(r, ch); B.timing[key] = Math.round(ms); B.fromWorker++; }
        if (--left <= 0) { URL.revokeObjectURL(url); w.terminate(); worker = 'done'; stats.workerBuffers = B.fromWorker; } };
      w.onerror = e => { if (e && e.preventDefault) e.preventDefault(); worker = false; try { w.terminate(); } catch (x) { /* already gone */ } };
      worker = w;
      for (const key of Object.keys(KIT.RECIPES)) { w.postMessage({ key, sr }); left++; }
      for (const n of KAL_COMMON) { w.postMessage({ key: 'kal', sr, f: hz(n), k: kalKey(n) }); left++; }
    } catch (e) { worker = false; }
  }

  // ============================================================================================================
  // 3. The desk: a mixing graph on one AudioContext (live or offline) plus the helpers the instruments use.
  //    Voices are made into a 'generation' of buses; a seek fades the old generation out and starts a new one.
  //    D (the desk) holds: ctx, the buffers B, live (true for the real-time context), srcs (this generation's sources
  //    and their end times, so a seek can stop them), base / filmBase (context time = base + (film time - filmBase)),
  //    ci (the next cue to schedule), gen (the current generation's buses), kinds (only these instruments, or null).
  // ============================================================================================================
  function makeDesk(ctx, live, opts = {}) {
    const t0 = performance.now(), B = bufs(ctx.sampleRate), tB = performance.now(), D = { ctx, B, live, srcs: [], base: 0, filmBase: 0, ci: 0, gen: null, kinds: opts.kinds ? new Set(opts.kinds) : null };
    // node helpers. osc / buf / noise start and stop their source at the given context times and remember it (keep)
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const filt = (type, f, Q = .707, g = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; b.gain.value = g; return b; };
    const keep = (s, end) => { D.srcs.push([s, end]); return s; };
    const osc = (type, f, t0, t1) => { const o = ctx.createOscillator(); if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type); o.frequency.value = f; o.start(t0); o.stop(Math.max(t0 + .02, t1)); return keep(o, t1); };
    const buf = (b, t0, t1, rate = 1, offset = 0, loop = false) => { const s = ctx.createBufferSource(); s.buffer = b; s.loop = loop; s.playbackRate.value = rate; s.start(t0, loop ? offset % b.duration : Math.min(offset, b.duration - .001)); s.stop(Math.max(t0 + .02, t1)); return keep(s, t1); };
    // a looping slice of the noise buffer from a seeded offset, so two voices with different seeds never share their noise
    const noise = (t0, t1, seed = 0, name = 'noise') => buf(B[name], t0, t1, 1, H(seed, 31) * B[name].duration, true);
    // route a voice: o.bus 'm' (the underscore), 's' (the world, the default) or 'x' (the world, but past the 'sfx' lane, so
    // it is still heard when that lane cuts the world at 57.0); o.pan; o.rev reverb send; o.echo valley echo send
    // (sent only while the voice's own stem plays: the echo return bypasses the stem switches and would leak into a solo)
    const out = (node, o = {}) => { let n = node; const g = D.gen;
      if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = clamp(o.pan, -1, 1); n.connect(p); n = p; }
      const m = o.bus === 'm', x = o.bus === 'x'; n.connect(m ? g.m : x ? g.x : g.s);
      if (o.rev) { const r = gain(o.rev); n.connect(r); r.connect(m ? g.mr : x ? g.xr : g.sr); }
      if (o.echo && (!D.solo || D.solo === (m ? 'mus' : 'sfx'))) { const e = gain(o.echo); n.connect(e); e.connect(g.e); } return n; };
    Object.assign(D, { gain, filt, osc, buf, noise, out, keep });
    // Pell's voice source: a pulse of duty 0.35 as a band-limited periodic wave (its Fourier series, 47 harmonics:
    // a_k = 2 / (k pi) sin(k pi 0.35)), so it has the pulse's hollow colour without aliasing
    { const N = 48, re = new Float32Array(N), im = new Float32Array(N); for (let k = 1; k < N; k++) re[k] = 2 / (k * Math.PI) * Math.sin(k * Math.PI * .35); D.pulse35 = ctx.createPeriodicWave(re, im); }

    // ---- the mix:  voices -> generation buses -> stem levels (music | world | beds) -> mix -> high-pass 24 Hz
    //      -> compressor -> trim (+0.8 dB) -> limiter -> soft clip -> master lane -> mute -> speakers
    //      The compressor (-18 dB, 2.5:1, soft knee) glues the mix gently; the limiter and the clip only catch peaks.
    const mix = gain(1), hp = filt('highpass', 24, .7), comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 10; comp.ratio.value = 2.5; comp.attack.value = .006; comp.release.value = .3;
    const masterLane = gain(1), muteG = gain(live && muted ? 0 : 1), trim = gain(1.1);
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = .001; lim.release.value = .12;   // a fast 20:1 guard above -4 dBFS
    // the very last guard: a soft knee that is exactly linear below -4.4 dBFS and never lets a sample past -1.4 dBFS
    const clip = ctx.createWaveShaper(); clip.curve = SOFTCLIP; clip.oversample = 'none';
    mix.connect(hp); hp.connect(comp); comp.connect(trim); trim.connect(lim); lim.connect(clip); clip.connect(masterLane); masterLane.connect(muteG); muteG.connect(ctx.destination);
    // the bowl reverb: a convolver with the generated impulse; its return level follows the 'rev' lane (revRet)
    const revIn = gain(1), conv = ctx.createConvolver(); conv.normalize = true; conv.buffer = B.bowl; const revRet = gain(1), revLvl = gain(.62);
    revIn.connect(conv); conv.connect(revLvl); revLvl.connect(revRet); revRet.connect(mix);
    // valley echo: a 1.2 s delay band-limited to about 170 Hz - 1.5 kHz, with feedback 0.28 (the 'echoFb' lane, so the
    // repeats can be cut dead at 57); its return follows the 'echo' lane and also feeds the bowl
    const echoIn = gain(1), dl = ctx.createDelay(2.5); dl.delayTime.value = 1.2; const eLP = filt('lowpass', 1500, .5), eHP = filt('highpass', 170, .6), fb = gain(.28), echoOut = gain(.55), echoRev = gain(.3);
    echoIn.connect(dl); dl.connect(eLP); eLP.connect(eHP); eHP.connect(fb); fb.connect(dl); eHP.connect(echoOut); echoOut.connect(mix); echoOut.connect(echoRev); echoRev.connect(revIn);
    // stems (tools/listen.mjs --stem): 'beds' (wind, gust, rain), 'mus' (the underscore), 'sfx' (the world's sounds). Live: all on.
    // Each stem has an on/off gain (dry and reverb send) and, for mus and sfx, a level gain the lanes move (musLv, sfxLv ...).
    const solo = D.solo = opts.only || null, on = k => (!solo || solo === k ? 1 : 0);
    const bedsOut = gain(on('beds')), bedsRev = gain(on('beds')), musS = gain(on('mus')), sfxS = gain(on('sfx'));
    bedsOut.connect(mix); bedsRev.connect(revIn); musS.connect(mix); sfxS.connect(mix);
    const musRS = gain(on('mus')), sfxRS = gain(on('sfx')); musRS.connect(revIn); sfxRS.connect(revIn);
    const musLv = gain(1), musRevLv = gain(1), sfxLv = gain(1), sfxRevLv = gain(1); musLv.connect(musS); musRevLv.connect(musRS); sfxLv.connect(sfxS); sfxRevLv.connect(sfxRS);
    Object.assign(D, { mix, revIn, echoIn, musLv, musRevLv, sfxLv, sfxRevLv, muteG, sfxS, sfxRS });

    // ---- the beds: wind, gust, rain (persistent loops whose levels follow the lanes)
    //   bed(buffer, filter chain, start, rev): a looping buffer through the chain into a level gain (driven by a lane).
    //   `start` (0..1) is where in the loop it begins, so beds sharing the noise buffer are not in phase; rev is its
    //   reverb send. Beds belong to no generation: they run for the whole life of the context and a seek only moves
    //   their levels. (So the beds' texture depends on when the context started; only their levels follow film time.)
    const bed = (srcName, chain, start, rev) => { const s = ctx.createBufferSource(); s.buffer = B[srcName]; s.loop = true; s.start(ctx.currentTime, start * B[srcName].duration);
      let n = s; for (const c of chain) { n.connect(c); n = c; } const g = gain(0); n.connect(g); g.connect(bedsOut); if (rev) { const r = gain(rev); g.connect(r); r.connect(bedsRev); } return g; };
    // wind: band-passed noise whose centre wanders (the 'windF' lane); a thin whistle near 1.9-2.65 kHz; the gust: low-passed
    // noise that opens up as it blows (the 'gustF' lane); rain: one bed per band, plus a rumble under the heavy rain
    const windBP = filt('bandpass', 480, .55), whistleBP = filt('bandpass', 1900, 7), gustLP = filt('lowpass', 300, 1.4);
    const wind = bed('noise', [windBP, filt('highpass', 110, .6), filt('lowshelf', 300, .7, 1)], .1, .15), windHi = bed('noise', [whistleBP, filt('peaking', 2650, 6, 6)], .55, .3);
    const gust = bed('noise', [gustLP, filt('highpass', 75, .7)], .37, .1);
    const rainH = bed('patterH', [filt('lowpass', 4200, .6), filt('highpass', 120, .7)], .2, .18), rumble = bed('noise', [filt('lowpass', 150, .8), filt('lowpass', 150, .8)], .8, 0);
    // heavy rain is also a broad hiss (BIBLE.md: noise through a 1.5-6 kHz band) on the same lane as the splats
    const rainHiss = bed('noise', [filt('highpass', 1500, .6), filt('lowpass', 6000, .6), gain(.35)], .63, .12);
    const rainM = bed('patterM', [filt('highpass', 1500, .6), filt('lowpass', 6500, .6)], .4, .14);
    const rainS = bed('noise', [filt('highpass', 5200, .7), filt('lowpass', 11000, .6), gain(.1)], .45, .1), rainS8 = bed('drizzle', [filt('highpass', 2000, .7)], .3, .35);
    // lane name -> the AudioParams it drives (one lane may drive several: a level and its reverb send move together).
    // D.lanes pairs each with its points from buildLanes(); `i` is the next point to schedule.
    const T = { wind: [wind.gain], windF: [windBP.frequency], windHi: [windHi.gain], gust: [gust.gain], gustF: [gustLP.frequency], rainH: [rainH.gain, rainHiss.gain], rumble: [rumble.gain],
      rainM: [rainM.gain], rainS: [rainS.gain, rainS8.gain], mus: [musLv.gain, musRevLv.gain], sfx: [sfxLv.gain, sfxRevLv.gain], rev: [revRet.gain], echo: [echoOut.gain], echoFb: [fb.gain], master: [masterLane.gain] };
    D.lanes = Object.entries(PREP.lanes).filter(([k]) => T[k]).map(([k, pts]) => ({ k, pts, params: T[k], i: 0 }));
    D.buildMs = performance.now() - t0; D.parts = { buffers: Math.round(tB - t0), graph: Math.round(performance.now() - tB) };
    return D;
  }
  // a new generation of buses: m / mr music (dry / reverb send), s / sr world, x / xr world past the sfx lane, e echo send.
  // With `fade` they rise from 0 over 50 ms, so a seek never clicks.
  function newGen(D, fade) {
    const { ctx } = D, now = ctx.currentTime, g = { m: D.gain(1), mr: D.gain(1), s: D.gain(1), sr: D.gain(1), x: D.gain(1), xr: D.gain(1), e: D.gain(1) };
    g.m.connect(D.musLv); g.mr.connect(D.musRevLv); g.s.connect(D.sfxLv); g.sr.connect(D.sfxRevLv); g.x.connect(D.sfxS); g.xr.connect(D.sfxRS); g.e.connect(D.echoIn);
    if (fade) for (const k in g) { g[k].gain.setValueAtTime(0, now); g[k].gain.linearRampToValueAtTime(1, now + .05); }
    D.gen = g; D.srcs = [];
  }
  // the old generation: ramp its buses to 0 in 40 ms, stop its sources, and disconnect it once that is surely over
  function killGen(D) {
    const g = D.gen; if (!g) return; const now = D.ctx.currentTime;
    for (const k in g) { const p = g[k].gain; p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(0, now + .04); }
    for (const [s] of D.srcs) { try { s.stop(now + .06); } catch (e) { /* already stopped */ } }
    setTimeout(() => { for (const k in g) g[k].disconnect(); }, 400);
  }

  // ============================================================================================================
  // 4. Instruments: INST[kind](D, when, off, a). `when` is the context time the sound starts (or is joined, off > 0).
  //    Levels are nominal: the drum peaks near 0.6, a close plink near 0.2, quiet things far below.
  //    a: the cue's arguments. Common ones: n (note), f (Hz), v (level), pan (-1..1), rev / echo (send levels),
  //    bus ('m' music, default the world), seed (picks a noise slice), dur / end (seconds), dec (decay, s).
  //    Each call builds fresh nodes for one note; the nodes are dropped by the browser once their sources stop.
  //    Long sounds (voice, choir, pad, glass ...) can be joined `off` seconds late after a seek; short ones are skipped.
  // ============================================================================================================
  const INST = {};
  const short = (off, d = .03) => off > d;                     // a short sound joined more than d s late is simply not played
  // a tuned drum: sine with a pitch drop 2.2x -> 1x in 60 ms, a lowpassed noise burst, a felt thump.
  // Dun's drum (a.ring) also rings its own overtone chord (harmonics 2-5 of D2: D3 A3 D4 F#4): the bowl answering, the
  // film's first tonic chord. a.soft: the villagers' felt-covered drums (slower attack, duller, shorter).
  INST.drum = (D, w, off, a) => {
    if (short(off, .25)) return; const f = hz(a.n || 'D2'), v = a.v ?? 1, soft = !!a.soft, T = soft ? 1.5 : 2.8, end = w - off + T + .2;
    const bus = D.gain(1); D.out(bus, { pan: a.pan || 0, rev: a.rev ?? .3, echo: a.echo || 0 });
    const o = D.osc('sine', f, w, end); env(o.frequency, w, off, [[0, f * (soft ? 1.5 : 2.2)], [.06, f, 'e']]);
    const g = D.gain(); env(g.gain, w, off, [[0, 0], [soft ? .02 : .003, .6 * v], [.3, .4 * v, 'e'], [T, 1e-4, 'e']]); o.connect(g); g.connect(bus);
    // the hide's inharmonic modes (short) and, for the big drum, the harmonic ring. [ratio to f, level, decay s]
    const modes = [[1.59, .1, .35], [2.14, .06, .2], [2.3, .04, .15]].concat(a.ring ? [[2, .2, 1.8], [3, .09, 1.4], [4, .05, 1.0], [5, .035, .8]] : [[2, .08, .5]]);
    for (const [r, amp, d] of modes) { const m = D.osc('sine', f * r, w, end), mg = D.gain(); env(mg.gain, w, off, [[0, 0], [soft ? .02 : .004, amp * v], [d, 1e-4, 'e']]); m.connect(mg); mg.connect(bus); }
    const n = D.noise(w, w + .4, a.seed || 1), lp = D.filt('lowpass', soft ? 260 : 650, .8), ng = D.gain(); env(ng.gain, w, off, [[0, 0], [.002, (soft ? .18 : .45) * v], [.13, 1e-4, 'e']]); n.connect(lp); lp.connect(ng); ng.connect(bus);
    const th = D.osc('sine', 110, w, w + .3), tg = D.gain(); env(th.frequency, w, off, [[0, 120], [.05, 55, 'e']]); env(tg.gain, w, off, [[0, 0], [.004, .3 * v], [.12, 1e-4, 'e']]); th.connect(tg); tg.connect(bus);
  };
  // a struck free bar (mast chimes): partials 1, 2.756, 5.404, 8.933 (a free-free bar's modes), upper ones dying faster;
  // a 20 ms band-passed noise tick for the strike. Partials above 16 kHz are left out.
  INST.chime = (D, w, off, a) => {
    if (short(off, .5)) return; const f = cents(hz(a.n), a.det || 0), v = a.v ?? .5, dec = a.dec ?? 3.5, end = w - off + dec + .2;
    const bus = D.gain(1); D.out(bus, { pan: a.pan || 0, rev: a.rev ?? .5, echo: a.echo ?? .15, bus: a.bus });
    for (const [r, amp, d] of [[1, 1, dec], [2.756, .42, dec * .45], [5.404, .2, dec * .2], [8.933, .08, dec * .1]]) {
      if (f * r > 16000) continue; const o = D.osc('sine', f * r, w, end), g = D.gain(); env(g.gain, w, off, [[0, 0], [.002, amp * v * .3], [d, 1e-4, 'e']]); o.connect(g); g.connect(bus); }
    const n = D.noise(w, w + .1, a.seed || 2), bp = D.filt('bandpass', 3200, 2), ng = D.gain(); env(ng.gain, w, off, [[0, 0], [.001, .12 * v], [.02, 1e-4, 'e']]); n.connect(bp); bp.connect(ng); ng.connect(bus);
  };
  // handbell: 1, 1.19, 1.5, 2.0, 2.66. Pell's bell is 14 cents sharp and thin (a second fundamental 0.25 % higher,
  // which beats against the first about 3.3 times a second on E6)
  INST.hbell = (D, w, off, a) => {
    if (short(off, .3)) return; const f = cents(hz(a.n || 'E6'), a.cents || 0), v = a.v ?? .4, dec = a.dec ?? 2.0, end = w - off + dec + .2, thin = !!a.thin;
    const bus = D.gain(1); D.out(bus, { pan: a.pan || 0, rev: a.rev ?? .45, echo: a.echo ?? .08 });
    const parts = [[1, 1, dec], [1.19, .28, dec * .5], [1.5, .22, dec * .55], [2.0, .4, dec * .45], [2.66, thin ? .3 : .16, dec * .3]];
    if (thin) parts.push([1.0025, .45, dec * .8]);
    for (const [r, amp, d] of parts) { const o = D.osc('sine', f * r, w, end), g = D.gain(); env(g.gain, w, off, [[0, 0], [.0015, amp * v * .25], [d, 1e-4, 'e']]); o.connect(g); g.connect(bus); }
    const n = D.noise(w, w + .05, a.seed || 3), bp = D.filt('bandpass', 5200, 1.5), ng = D.gain(); env(ng.gain, w, off, [[0, 0], [.001, .1 * v], [.012, 1e-4, 'e']]); n.connect(bp); bp.connect(ng); ng.connect(bus);
  };
  // a toy bell slipping its mitten: a little cluster of small strikes ([delay s, level, cents] each, alternating sides)
  INST.jingle = (D, w, off, a) => { if (short(off)) return; [[0, 1, 0], [.07, .55, 6], [.15, .7, -5], [.26, .35, 3], [.4, .2, -2]].forEach(([dt, k, c], i) =>
    INST.hbell(D, w + dt, 0, { n: a.n || 'E6', v: (a.v ?? .3) * k, cents: c, dec: .55, pan: (a.pan || 0) + (i % 2 ? .1 : -.1), rev: .35, seed: 40 + i })); };
  // the bell cracking (57.0): the bell's partials pulled apart (each detuned by its own ratio and sagging 2.5 %), new
  // inharmonic partials, an 83 Hz square-wave buzz modulating them (the rattle of the split), a noise click of 80 ms and a
  // dull knock. It plays on bus 'x', so it survives the cut to silence that it causes.
  INST.crack = (D, w, off, a) => {
    if (short(off)) return; const f = cents(hz('E6'), 14), v = a.v ?? .6, end = w + .6;
    const bus = D.gain(1); D.out(bus, { pan: .05, rev: .1, bus: 'x' });
    const buzz = D.gain(1), lfo = D.osc('square', 83, w, end), lg = D.gain(.55); lfo.connect(lg); lg.connect(buzz.gain); buzz.connect(bus);
    [[1, .962, .3, .22], [1.19, 1.043, .2, .14], [1.5, 1.018, .18, .12], [2.0, .931, .25, .1], [2.66, 1.071, .14, .08], [1.37, 1, .16, .1], [1.83, 1, .14, .09], [2.29, 1, .12, .07], [3.41, 1, .08, .05]].forEach(([r, dt, amp, d]) => {
      const fr = f * r * dt, o = D.osc('sine', fr, w, end), g = D.gain(); env(o.frequency, w, 0, [[0, fr], [.09, fr * .975, 'e']]); env(g.gain, w, 0, [[0, 0], [.001, amp * v], [d, 1e-4, 'e']]); o.connect(g); g.connect(buzz); });
    const n = D.noise(w, w + .2, 9), bp = D.filt('bandpass', 3600, .6), ng = D.gain(); env(ng.gain, w, 0, [[0, 0], [.0008, .55 * v], [.08, 1e-4, 'e']]); n.connect(bp); bp.connect(ng); ng.connect(bus);
    const k = D.osc('sine', 230, w, w + .2), kg = D.gain(); env(k.frequency, w, 0, [[0, 230], [.05, 120, 'e']]); env(kg.gain, w, 0, [[0, 0], [.002, .35 * v], [.09, 1e-4, 'e']]); k.connect(kg); kg.connect(bus);
  };
  // a dead tick: the clapper on a bell that no longer rings (bus 'x', like the crack)
  INST.tick = (D, w, off, a) => { if (short(off)) return; const v = a.v ?? .2, bus = D.gain(1); D.out(bus, { pan: .05, bus: 'x' });
    const n = D.noise(w, w + .05, 11), bp = D.filt('bandpass', 1700, 2.5), ng = D.gain(); env(ng.gain, w, 0, [[0, 0], [.001, v], [.014, 1e-4, 'e']]); n.connect(bp); bp.connect(ng); ng.connect(bus);
    const o = D.osc('sine', 640, w, w + .06), g = D.gain(); env(g.gain, w, 0, [[0, 0], [.001, .3 * v], [.03, 1e-4, 'e']]); o.connect(g); g.connect(bus); };
  // a drop letting go: a sine falling 1.6f -> f in 25 ms, 120 ms decay; far ones are duller and wetter.
  // a.far 0..1 (distance / 30 m): longer decay, more reverb, and past 0.3 a low-pass closing from 9 kHz toward 1.8 kHz
  INST.plink = (D, w, off, a) => {
    if (short(off)) return; const f = hz(a.n), v = a.v ?? .15, far = a.far || 0, o = D.osc('sine', f * 1.6, w, w + .2), g = D.gain();
    env(o.frequency, w, 0, [[0, f * 1.6], [.025, f, 'e']]); env(g.gain, w, 0, [[0, 0], [.0015, v], [.12 + .05 * far, 1e-4, 'e']]); o.connect(g);
    let n = g; if (far > .3) { const lp = D.filt('lowpass', lerp(9000, 1800, far), .5); g.connect(lp); n = lp; }
    D.out(n, { pan: a.pan || 0, rev: .25 + .3 * far });
  };
  // a drop landing in water / on skin: a rising bubble chirp (0.8f -> 1.5f in 35 ms) and a high noise tick
  INST.plip = (D, w, off, a) => {
    if (short(off)) return; const f = a.f || 1150, v = a.v ?? .12, o = D.osc('sine', f, w, w + .15), g = D.gain();
    env(o.frequency, w, 0, [[0, f * .8], [.035, f * 1.5, 'e']]); env(g.gain, w, 0, [[0, 0], [.002, v], [.08, 1e-4, 'e']]); o.connect(g);
    const n = D.noise(w, w + .03, a.seed || 5), hp = D.filt('highpass', 2500, .7), ng = D.gain(); env(ng.gain, w, 0, [[0, 0], [.0006, .25 * v], [.008, 1e-4, 'e']]); n.connect(hp); hp.connect(ng); ng.connect(g);
    D.out(g, { pan: a.pan || 0, rev: a.rev ?? .35, echo: a.echo || 0 });
  };
  // a splash: a band-passed noise burst (around a.f) and, 15 ms later, a bubble plip a little over an octave lower
  INST.splash = (D, w, off, a) => { if (short(off)) return; const v = a.v ?? .1, n = D.noise(w, w + .25, a.seed || 6), bp = D.filt('bandpass', a.f || 2800, .7), g = D.gain();
    env(g.gain, w, 0, [[0, 0], [.003, v], [.09, v * .25, 'e'], [.2, 1e-4, 'e']]); n.connect(bp); bp.connect(g); D.out(g, { pan: a.pan || 0, rev: .25 });
    INST.plip(D, w + .015, 0, { f: (a.f || 2800) * .45, v: v * .6, pan: a.pan, seed: a.seed }); };
  // glitter: a slice of the glitter buffer (tiny E7 rings, or E8 with a.oct8) - mist letting go, drizzle trails, afterhang
  // sparkles. a.rate plays the slice faster or slower (and so higher or lower).
  INST.sparkle = (D, w, off, a) => { const dur = a.dur || .8; if (off > dur) return; const v = a.v ?? .05, rate = a.rate || 1;
    const s = D.buf(D.B[a.oct8 ? 'glitter8' : 'glitter'], w, w - off + dur + .05, rate, H(a.seed || 7, 3) * 3 + off, true), hp = D.filt('highpass', 1800, .7), g = D.gain();
    env(g.gain, w, off, [[0, 0], [.04, v], [dur * .45, v * .55], [dur, 0]]); s.connect(hp); hp.connect(g); D.out(g, { pan: a.pan || 0, rev: .45 }); };
  // a little glass rattle: the bead strings on the hoods shivering as a sound front passes (BIBLE.md M17, the clothing
  // meter). The E8 glitter buffer played 1.37x faster, high-passed at 4 kHz.
  INST.beads = (D, w, off, a) => { const dur = a.dur || .35; if (off > dur) return; const v = a.v ?? .04;
    const s = D.buf(D.B.glitter8, w, w - off + dur + .05, 1.37, H(a.seed || 8, 5) * 3 + off, true), hp = D.filt('highpass', 4000, .7), g = D.gain();
    env(g.gain, w, off, [[0, 0], [.015, v], [dur, 0]]); s.connect(hp); hp.connect(g); D.out(g, { pan: a.pan || 0, rev: .3 }); };

  // Pell's voice: saw + pulse(0.35) -> three parallel band-pass formants (+ a little of the direct source for body),
  // 5.5 Hz vibrato of 25 cents that waits 0.4 s after each onset, a scoop into the first note, breath noise 2-4 kHz,
  // a 120 ms attack. Vowels morph ('ah' 800/1150/2900 -> 'oh' 450/800/2830). F1 never sits under the pitch (formant tuning,
  // as sopranos do). mode 'hum': closed mouth, muffled. Fallback (BIBLE.md 9, risk 5): ?voice=ocarina -> a sine, its octave
  // at 0.15, and the breath.
  //   a.notes [[dt, note, vowel, glide s]]: each note starts dt s after the onset and glides into its pitch (default 0.1 s);
  //   a.end: when the last note ends; a.amp: an optional loudness curve (default a 120 ms rise, hold, 0.35 s fall).
  //   The curves built below: fP pitch (Hz), fms the three formant centres (each moves to the next vowel in 0.22 s),
  //   vib the vibrato depth in cents (it dips to 4 cents at each new note and grows back after 0.4 s).
  // VOW: vowel -> [[F1, F2, F3] Hz, [their levels]]
  const VOW = { ah: [[800, 1150, 2900], [1, .5, .16]], oh: [[450, 800, 2830], [1, .38, .1]], hum: [[300, 900, 2300], [1, .22, .05]],
    ee: [[400, 2600, 3400], [1, .35, .2]], ha: [[900, 1300, 2900], [1, .55, .2]] };
  INST.voice = (D, w, off, a) => {
    const end = a.end; if (off > end + .4) return; const t1 = w - off, stopAt = t1 + end + .6, hum = a.mode === 'hum', oca = !hum && (a.mode === 'ocarina' || VOICE === 'ocarina');
    const v = a.v ?? .4, fP = [], fms = [[], [], []], vib = [[0, 0]]; let pf = null, pv = null;
    for (const [dt, n, vow0, gl] of a.notes) { const f = hz(n), vow = hum ? 'hum' : (vow0 || 'ah');
      if (pf == null) fP.push([dt, cents(f, -40)], [dt + .09, f, 'e']); else fP.push([dt, pf], [dt + (gl ?? .1), f, 'e']);
      const fr = VOW[vow][0].map((x, k) => k === 0 ? Math.max(x, f * 1.08) : x);
      fr.forEach((x, k) => { if (pv) fms[k].push([dt, pv[k]]); fms[k].push([dt + (pv ? .22 : 0), x]); });
      const pk = (hum ? 10 : 25) * (a.vib ?? 1); if (pf != null) vib.push([dt - .08, pk]); vib.push([dt, pf == null ? 0 : 4], [dt + .4, pf == null ? 0 : 4], [dt + .9, pk]);
      pf = f; pv = fr; }
    vib.sort((x, y) => x[0] - y[0]);
    // the source: saw + pulse (or two sines an octave apart for the ocarina), both following the pitch curve; vibrato
    // (5.5 Hz) and a slow 0.73 Hz drift of a few cents go into their detune, so the voice never sits dead still
    const src = D.gain(1), o1 = D.osc(oca ? 'sine' : 'sawtooth', 440, w, stopAt), o2 = D.osc(oca ? 'sine' : D.pulse35, 440, w, stopAt);
    env(o1.frequency, w, off, fP); env(o2.frequency, w, off, fP, oca ? 2 : 1);
    const g1 = D.gain(oca ? 1 : .55), g2 = D.gain(oca ? .15 : .45); o1.connect(g1); o2.connect(g2); g1.connect(src); g2.connect(src);
    const lfo = D.osc('sine', 5.5, w, stopAt), vg = D.gain(0), drift = D.osc('sine', .73, w, stopAt), dg = D.gain(hum ? 3 : 5);
    lfo.connect(vg); drift.connect(dg); for (const o of [o1, o2]) { vg.connect(o.detune); dg.connect(o.detune); } env(vg.gain, w, off, vib);
    const sum = D.gain(1);
    if (oca) { const lp = D.filt('lowpass', 3200, .5), lg = D.gain(.4); src.connect(lp); lp.connect(lg); lg.connect(sum); }   // -8 dB: as loud as the formant voice
    else { const gk = VOW[hum ? 'hum' : 'ah'][1];
      // three band-pass formants (Q 8, 10, 12) that glide with the vowel curve, plus a little low-passed direct source
      for (let k = 0; k < 3; k++) { const bp = D.filt('bandpass', fms[k][0][1], [8, 10, 12][k]); env(bp.frequency, w, off, fms[k]); const g = D.gain(gk[k] * [2.2, 2.6, 3.4][k]); src.connect(bp); bp.connect(g); g.connect(sum); }
      const dlp = D.filt('lowpass', hum ? 700 : 1300, .6), dg2 = D.gain(hum ? .5 : .2); src.connect(dlp); dlp.connect(dg2); dg2.connect(sum); }
    let tail = sum; if (hum) { const lp = D.filt('lowpass', 1100, .5); sum.connect(lp); tail = lp; }
    const amp = D.gain(0); tail.connect(amp); env(amp.gain, w, off, a.amp || [[0, 0], [.12, 1], [end - .05, .9], [end + .3, 0]], v);
    // breath: a puff at the onset, then a thread under the tone
    const bn = D.noise(w, stopAt, a.seed || 12), bbp = D.filt('bandpass', 3000, .9), bg = D.gain(0); bn.connect(bbp); bbp.connect(bg); bg.connect(amp);
    env(bg.gain, w, off, [[0, 0], [.04, hum ? .1 : .5], [.25, hum ? .04 : .12], [end, hum ? .03 : .1], [end + .3, 0]], oca ? 1.6 : 1);
    D.out(amp, { pan: a.pan || 0, rev: a.rev ?? .35, echo: a.echo || 0 });
  };
  // laughter: the same voice, cut into syllables, breathy, pitch falling. a.syl syllables at a.rate per second, from
  // a.n0 down to a.n1, each with a breath puff just before its tone; a.child raises the formants 18 %.
  INST.laugh = (D, w, off, a) => {
    if (short(off, .05)) return; const n = a.syl || 5, rate = a.rate || 6.5, v = a.v ?? .2, f0 = hz(a.n0 || 'E5'), f1 = hz(a.n1 || 'C#5'), dur = n / rate + .2, end = w + dur + .2;
    const fr = VOW[a.vow || 'ha'][0].map(x => x * (a.child ? 1.18 : 1)), o = D.osc('sawtooth', f0, w, end), o2 = D.osc(D.pulse35, f0, w, end), src = D.gain(1);
    const fp = [[0, f0]]; for (let i = 0; i < n; i++) fp.push([i / rate + .02, lerp(f0, f1, i / Math.max(1, n - 1)) * (1 + .04 * (H(i, a.seed || 1) - .5))], [i / rate + .09, lerp(f0, f1, i / Math.max(1, n - 1)) * .96]);
    env(o.frequency, w, 0, fp); env(o2.frequency, w, 0, fp); const ga = D.gain(.5), gb = D.gain(.5); o.connect(ga); o2.connect(gb); ga.connect(src); gb.connect(src);
    const sum = D.gain(1); fr.forEach((x, k) => { const bp = D.filt('bandpass', x, [6, 8, 10][k]), g = D.gain([2, 1.4, .7][k]); src.connect(bp); bp.connect(g); g.connect(sum); });
    const amp = D.gain(0), pts = [[0, 0]], bpts = [[0, 0]];
    for (let i = 0; i < n; i++) { const s = i / rate, k = 1 - .35 * i / n; pts.push([s + .025, 0], [s + .045, k], [s + .1, k * .55], [s + .135, 0]); bpts.push([s, 0], [s + .015, .8 * k], [s + .05, .15], [s + .1, 0]); }
    env(amp.gain, w, 0, pts, v); sum.connect(amp);
    const bn = D.noise(w, end, a.seed || 13), bbp = D.filt('bandpass', 2400, .8), bg = D.gain(0); env(bg.gain, w, 0, bpts, v * .9); bn.connect(bbp); bbp.connect(bg);
    const o1 = D.out(amp, { pan: a.pan || 0, rev: .35, echo: a.echo || 0 }); D.out(bg, { pan: a.pan || 0, rev: .3 });
  };
  // a child's yip: one saw syllable through 'ee' formants raised 20 %, its pitch scooping up past the note and back
  INST.yip = (D, w, off, a) => { if (short(off)) return; const f = hz(a.n || 'B5'), v = a.v ?? .08, end = w + .4, o = D.osc('sawtooth', f, w, end), src = D.gain(1); o.connect(src);
    env(o.frequency, w, 0, [[0, f * .82], [.09, f * 1.1, 'e'], [.16, f * 1.02, 'e']]);
    const sum = D.gain(1); VOW.ee[0].forEach((x, k) => { const bp = D.filt('bandpass', x * 1.2, [6, 9, 10][k]), g = D.gain([2, 1.2, .6][k]); src.connect(bp); bp.connect(g); g.connect(sum); });
    const amp = D.gain(0); env(amp.gain, w, 0, [[0, 0], [.025, v], [.13, v * .7], [.2, 0]]); sum.connect(amp); D.out(amp, { pan: a.pan || 0, rev: .35 }); };
  // the choir: six detuned saws per note (-14 .. +14 cents, alternately left and right), low-passed at 1.8 kHz (1 kHz for
  // vow 'oo') with two vowel bumps, slow attack. Each saw gets 0.16 / sqrt(number of notes), so a bigger chord is not
  // much louder. a.nv: per-note levels; a.env: an optional loudness curve; a.att / a.rel: rise and release (s).
  INST.choir = (D, w, off, a) => {
    const dur = a.dur, rel = a.rel ?? 1.2; if (off > dur + rel) return; const stopAt = w - off + dur + rel + .1, v = a.v ?? .3, oo = a.vow === 'oo';
    const L = D.gain(1), R = D.gain(1), pl = D.ctx.createStereoPanner(), pr = D.ctx.createStereoPanner(); pl.pan.value = -.5; pr.pan.value = .5; L.connect(pl); R.connect(pr);
    const lp = D.filt('lowpass', a.cut || (oo ? 1000 : 1800), .5), k1 = D.filt('peaking', oo ? 380 : 750, 1.4, oo ? 4 : 5), k2 = D.filt('peaking', oo ? 800 : 1150, 2, 3);
    pl.connect(lp); pr.connect(lp); lp.connect(k1); k1.connect(k2);
    const amp = D.gain(0); k2.connect(amp); env(amp.gain, w, off, a.env || [[0, 0], [a.att ?? 1.5, 1], [dur, 1], [dur + rel, 0]], v);
    const per = .16 / Math.sqrt(a.notes.length), DET = [-14, -8, -3, 3, 8, 14];
    // two slow drifts (a few cents) wander through a third of the voices each, and the voices start a few ms apart,
    // so the ensemble breathes instead of beating in lockstep
    const d1 = D.osc('sine', .23, w, stopAt), d1g = D.gain(4), d2 = D.osc('sine', .31, w, stopAt), d2g = D.gain(-3.5); d1.connect(d1g); d2.connect(d2g);
    a.notes.forEach((n, i) => { const f = hz(n), nv = (a.nv && a.nv[i]) ?? 1; DET.forEach((d, j) => { const o = D.osc('sawtooth', cents(f, d + 1.5 * Math.sin(i * 3 + j)), w + .0037 * ((i * 6 + j) % 7), stopAt), g = D.gain(per * nv);
      if (j % 3 === 0) d1g.connect(o.detune); else if (j % 3 === 1) d2g.connect(o.detune); o.connect(g); g.connect(j % 2 ? R : L); }); });
    D.out(amp, { bus: 'm', rev: a.rev ?? .5 });
  };
  // the pad: two saws a few cents apart (-7 / +7, panned apart) and a triangle, a slow low-pass that breathes
  // (a.cut, or a.sweep: a curve of its cutoff in Hz)
  INST.pad = (D, w, off, a) => {
    const dur = a.dur, rel = a.rel ?? 1.5; if (off > dur + rel) return; const stopAt = w - off + dur + rel + .1, v = a.v ?? .2;
    const lp = D.filt('lowpass', a.cut || 700, .6); if (a.sweep) env(lp.frequency, w, off, a.sweep);
    const amp = D.gain(0); lp.connect(amp); env(amp.gain, w, off, a.env || [[0, 0], [a.att ?? 2.5, 1], [dur, 1], [dur + rel, 0]], v);
    const per = .2 / Math.sqrt(a.notes.length);
    a.notes.forEach((n, i) => { const f = hz(n), nv = (a.nv && a.nv[i]) ?? 1;
      [['sawtooth', -7, .5, -.35], ['sawtooth', 7, .5, .35], ['triangle', 0, .9, 0]].forEach(([ty, d, k, pan], j) => { const o = D.osc(ty, cents(f, d), w, stopAt), g = D.gain(per * nv * k);
        o.connect(g); if (pan) { const p = D.ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(lp); } else g.connect(lp); }); });
    D.out(amp, { bus: 'm', rev: a.rev ?? .55 });
  };
  // bowed glass: sine pairs about 0.7 Hz apart (a slow beat), a faint octave and twelfth; optional tremolo (the trembling drops).
  // Each note beats at its own rate (0.55, 0.7, 0.85 Hz ...) and the pair is unequal, so the chord shimmers instead of pumping.
  // a.trem { rate, depth }: curves of the tremolo speed (Hz) and depth (0..1). (The local `bt` here is that beat, not the
  // bar helper.)
  INST.glass = (D, w, off, a) => {
    const dur = a.dur, rel = a.rel ?? 1.5; if (off > dur + rel) return; const stopAt = w - off + dur + rel + .1, v = a.v ?? .12;
    const sum = D.gain(1), amp = D.gain(0); env(amp.gain, w, off, a.env || [[0, 0], [a.att ?? 2.5, 1], [dur, 1], [dur + rel, 0]], v);
    let tail = sum; if (a.trem) { const tg = D.gain(1), lfo = D.osc('sine', 6, w, stopAt), lg = D.gain(0); env(lfo.frequency, w, off, a.trem.rate); env(lg.gain, w, off, a.trem.depth); lfo.connect(lg); lg.connect(tg.gain); sum.connect(tg); tail = tg; }
    tail.connect(amp);
    a.notes.forEach((n, i) => { const f = hz(n), bt = .55 + .15 * (i % 3); [[f, .58], [f + bt, .42], [2 * f + bt * .5, .1], [3 * f, .03]].forEach(([fr, k]) => { const o = D.osc('sine', fr, w, stopAt), g = D.gain(k / Math.sqrt(a.notes.length)); o.connect(g); g.connect(sum); }); });
    D.out(amp, { bus: a.bus || 'm', rev: a.rev ?? .6, pan: a.pan || 0 });
  };
  // chime-reeds whistling in the wind: a sine (4.3 Hz, 7-cent vibrato) plus noise through a narrow band at the same pitch
  // and another at the octave, swelling irregularly
  INST.reed = (D, w, off, a) => {
    const dur = a.dur || 1.8; if (off > dur) return; const f = hz(a.n), v = a.v ?? .04, stopAt = w - off + dur + .1;
    const sum = D.gain(1), o = D.osc('sine', f, w, stopAt), og = D.gain(.45); o.connect(og); og.connect(sum);
    const vl = D.osc('sine', 4.3, w, stopAt), vg = D.gain(7); vl.connect(vg); vg.connect(o.detune);
    const n = D.noise(w, stopAt, a.seed || 14), b1 = D.filt('bandpass', f, 28), g1 = D.gain(3.2), b2 = D.filt('bandpass', 2 * f, 14), g2 = D.gain(.9); n.connect(b1); b1.connect(g1); g1.connect(sum); n.connect(b2); b2.connect(g2); g2.connect(sum);
    const amp = D.gain(0); sum.connect(amp); env(amp.gain, w, off, [[0, 0], [dur * .3, 1], [dur * .5, .6], [dur * .7, .85], [dur, 0]], v);
    D.out(amp, { pan: a.pan || 0, rev: .55 });
  };
  // kalimba pluck: the note's Karplus-Strong buffer (section 2) played at its tuning rate; a.lp low-passes it.
  // Defaults to the music bus.
  INST.kal = (D, w, off, a) => { if (short(off)) return; const k = D.B.kal(a.n), s = D.buf(k.buf, w, w + k.buf.duration / k.rate + .05, k.rate), g = D.gain(a.v ?? .2);
    s.connect(g); let n = g; if (a.lp) { const lp = D.filt('lowpass', a.lp, .6); g.connect(lp); n = lp; } D.out(n, { bus: a.bus || 'm', pan: a.pan || 0, rev: a.rev ?? .3, echo: a.echo || 0 }); };
  // music box: partials 1 and 4.2 (a comb tine) and a faint octave, fast decay, a tiny click. Music bus.
  INST.mbox = (D, w, off, a) => { if (short(off)) return; const f = hz(a.n), v = a.v ?? .12, bus = D.gain(1); D.out(bus, { bus: 'm', pan: a.pan || 0, rev: .5, echo: a.echo ?? .12 });
    for (const [r, amp, d] of [[1, 1, a.dec || 1.8], [4.2, .3, .25], [2, .06, .5]]) { const o = D.osc('sine', f * r, w, w + d + .1), g = D.gain(); env(g.gain, w, 0, [[0, 0], [.0015, amp * v], [d, 1e-4, 'e']]); o.connect(g); g.connect(bus); }
    const n = D.noise(w, w + .03, 15), hp = D.filt('bandpass', 3200, 1.2), ng = D.gain(); env(ng.gain, w, 0, [[0, 0], [.001, .08 * v], [.006, 1e-4, 'e']]); n.connect(hp); hp.connect(ng); ng.connect(bus); };
  // the dripfrog: FM with the carrier on D3 and a modulator at 1.5x; the index follows the throat-sac (BIBLE.md M8),
  // a throaty 26 Hz flutter on top.
  //   ip: the modulation depth over time, in Hz (modulator frequency x index). a.sac: the hero frog's slow swell over
  //   1.5 s (index 1.1 -> 3.7, as the sac grows); a.ip: a custom [[t, index]] curve (the chorus); default: 2.6 -> 1.6.
  INST.frog = (D, w, off, a) => {
    const dur = a.dur || .5; if (off > dur) return; const f = hz(a.n || 'D3'), v = a.v ?? .2, stopAt = w - off + dur + .2;
    const car = D.osc('sine', f, w, stopAt), mod = D.osc('sine', f * 1.5, w, stopAt), mg = D.gain(0); mod.connect(mg); mg.connect(car.frequency);
    const ip = a.ip ? a.ip.map(([x, k]) => [x, f * 1.5 * k]) : a.sac ? [0, .25, .5, .75, 1, 1.25, 1.5].map(x => [x, f * 1.5 * (1.1 + 2.6 * sm(0, 1.5, x))]).concat([[dur, f * 1.5 * 3.7]]) : [[0, f * 1.5 * 2.6], [dur, f * 1.5 * 1.6]];
    env(mg.gain, w, off, ip);
    const am = D.gain(.68), fl = D.osc('sine', a.flutter || 26, w, stopAt), fg = D.gain(.32); fl.connect(fg); fg.connect(am.gain); car.connect(am);
    const lp = D.filt('lowpass', 1400, .7), amp = D.gain(0); am.connect(lp); lp.connect(amp);
    env(amp.gain, w, off, a.amp || (a.sac ? [[0, 0], [.15, .55], [1.5, 1], [dur - .12, 1], [dur, 0]] : [[0, 0], [.04, 1], [dur * .7, .8], [dur, 0]]), v);
    D.out(amp, { pan: a.pan || 0, rev: .3, echo: a.echo || 0 });
  };
  // the frog swallowing its drop: a sine falling 400 -> 130 Hz in 70 ms
  INST.gulp = (D, w, off, a) => { if (short(off)) return; const v = a.v ?? .15, o = D.osc('sine', 380, w, w + .2), g = D.gain(); env(o.frequency, w, 0, [[0, 400], [.07, 130, 'e']]);
    env(g.gain, w, 0, [[0, 0], [.006, v], [.13, 1e-4, 'e']]); o.connect(g); D.out(g, { pan: a.pan || 0, rev: .2 }); };
  // Tock (Pell's bird): a wood click, then an E6 'tink' from his brass throat a.gap s later (a.tink false: the click only)
  INST.tock = (D, w, off, a) => { if (short(off)) return; const v = a.v ?? .12, bus = D.gain(1); D.out(bus, { pan: a.pan || 0, rev: .3 });
    const n = D.noise(w, w + .05, 16), bp = D.filt('bandpass', 1350, 3), ng = D.gain(); env(ng.gain, w, 0, [[0, 0], [.001, v * 1.4], [.016, 1e-4, 'e']]); n.connect(bp); bp.connect(ng); ng.connect(bus);
    const c = D.osc('sine', 780, w, w + .06), cg = D.gain(); env(cg.gain, w, 0, [[0, 0], [.001, v * .5], [.035, 1e-4, 'e']]); c.connect(cg); cg.connect(bus);
    if (a.tink !== false) { const t2 = w + (a.gap ?? .12), f = hz('E6'); for (const [r, k, d] of [[1, 1, .32], [2.76, .2, .1]]) { const o = D.osc('sine', f * r, t2, t2 + d + .05), g = D.gain(); env(g.gain, t2, 0, [[0, 0], [.002, v * k], [d, 1e-4, 'e']]); o.connect(g); g.connect(bus); } } };
  // Tock's trill on E6 (with the dry upper neighbour F#6 on every fourth note), a.rate notes per second, dying away
  INST.trill = (D, w, off, a) => {
    const dur = a.dur || 1.5; if (off > dur) return; const rate = a.rate || 13, v = a.v ?? .12, n = Math.floor(dur * rate), stopAt = w - off + dur + .3, E = hz('E6'), Fs = hz('F#6');
    const o = D.osc('sine', E, w, stopAt), o2 = D.osc('sine', E * 2.76, w, stopAt), g = D.gain(0), g2 = D.gain(.15); o.connect(g); o2.connect(g2); g2.connect(g);
    const fp = [[0, E]], gp = [[0, 0]]; for (let i = 0; i < n; i++) { const s = i / rate, f = i % 4 === 2 ? Fs : E, k = (1 - .55 * i / n) * (i % 2 ? .75 : 1); fp.push([s, f, 's']); gp.push([s + .004, k], [s + .06, k * .15, 'e'], [s + 1 / rate - .003, k * .08, 'e']); }
    gp.push([n / rate + .1, 0]); env(o.frequency, w, off, fp); env(o2.frequency, w, off, fp, 2.76); env(g.gain, w, off, gp, v);
    D.out(g, { pan: a.pan || .15, rev: .4, echo: .12 });
  };
  // a chimewing's wingbeat: a tiny FM bell on E7 (a.c: cents off), the modulation dying in 150 ms so it ends as a pure ring
  INST.wing = (D, w, off, a) => { if (short(off)) return; const f = cents(hz('E7'), a.c || 0), v = a.v ?? .05, o = D.osc('sine', f, w, w + .5), m = D.osc('sine', f * 2, w, w + .5), mg = D.gain(), g = D.gain();
    env(mg.gain, w, 0, [[0, f * 1.1], [.15, 1, 'e']]); m.connect(mg); mg.connect(o.frequency); env(g.gain, w, 0, [[0, 0], [.002, v], [.38, 1e-4, 'e']]); o.connect(g); D.out(g, { pan: a.pan || 0, rev: .45 }); };
  // felt whoosh (fans, whips, launches): noise through a band that sweeps a.f0 -> a.f1 (at a.peak of the length) and back;
  // a.pan0 -> a.pan1 moves it across the stereo field
  INST.whoosh = (D, w, off, a) => {
    const dur = a.dur || .8; if (off > dur) return; const v = a.v ?? .1, stopAt = w - off + dur + .05, n = D.noise(w, stopAt, a.seed || 17), bp = D.filt('bandpass', a.f0 || 300, a.q || 1.1), g = D.gain(0);
    env(bp.frequency, w, off, [[0, a.f0 || 300], [dur * (a.peak ?? .55), a.f1 || 800, 'e'], [dur, (a.f0 || 300) * .8, 'e']]); env(g.gain, w, off, [[0, 0], [dur * (a.peak ?? .55), v], [dur, 0]]);
    n.connect(bp); bp.connect(g); let o = g; if (a.pan0 != null) { const p = D.ctx.createStereoPanner(); env(p.pan, w, off, [[0, a.pan0], [dur, a.pan1]]); g.connect(p); o = p; }
    D.out(o, { pan: a.pan0 != null ? 0 : a.pan || 0, rev: a.rev ?? .2 });
  };
  // a felt curtain snapping in the gust: a double noise burst
  INST.flap = (D, w, off, a) => { if (short(off)) return; const v = a.v ?? .06, n = D.noise(w, w + .2, a.seed || 18), bp = D.filt('bandpass', a.f || 650, 1.3), g = D.gain();
    env(g.gain, w, 0, [[0, 0], [.008, v], [.03, v * .2], [.05, v * .75], [.11, 1e-4, 'e']]); n.connect(bp); bp.connect(g); D.out(g, { pan: a.pan || 0, rev: .3 }); };
  // step: a felt footfall (low noise and a 100 -> 52 Hz thump; a.squish adds the wet of moss).
  // tok: a hand or boot on a wooden rung (a C#6 knock).  tap: a felt-muffled drum skin.
  INST.step = (D, w, off, a) => { if (short(off)) return; const v = a.v ?? .06, bus = D.gain(1); D.out(bus, { pan: a.pan || 0, rev: .12 });
    const n = D.noise(w, w + .15, a.seed || 19), lp = D.filt('lowpass', a.f || 320, .7), ng = D.gain(); env(ng.gain, w, 0, [[0, 0], [.005, v], [.1, 1e-4, 'e']]); n.connect(lp); lp.connect(ng); ng.connect(bus);
    const o = D.osc('sine', 95, w, w + .12), g = D.gain(); env(o.frequency, w, 0, [[0, 100], [.06, 52, 'e']]); env(g.gain, w, 0, [[0, 0], [.004, v * .7], [.09, 1e-4, 'e']]); o.connect(g); g.connect(bus);
    if (a.squish) { const n2 = D.noise(w, w + .3, (a.seed || 19) + 1), bp = D.filt('bandpass', 850, 1.4), g2 = D.gain(); env(g2.gain, w, 0, [[0, 0], [.035, v * .8], [.22, 1e-4, 'e']]); n2.connect(bp); bp.connect(g2); g2.connect(bus); } };
  INST.tok = (D, w, off, a) => { if (short(off)) return; const v = a.v ?? .08, bus = D.gain(1); D.out(bus, { pan: a.pan || 0, rev: .25 });
    const n = D.noise(w, w + .05, a.seed || 20), bp = D.filt('bandpass', 2300, 5), ng = D.gain(); env(ng.gain, w, 0, [[0, 0], [.001, v], [.025, 1e-4, 'e']]); n.connect(bp); bp.connect(ng); ng.connect(bus);
    const o = D.osc('sine', hz('C#6'), w, w + .08), g = D.gain(); env(g.gain, w, 0, [[0, 0], [.001, v * .35], [.05, 1e-4, 'e']]); o.connect(g); g.connect(bus); };
  INST.tap = (D, w, off, a) => { if (short(off)) return; const v = a.v ?? .08, bus = D.gain(1); D.out(bus, { pan: a.pan || 0, rev: .2 });
    const n = D.noise(w, w + .2, a.seed || 21), lp = D.filt('lowpass', 170, .9), ng = D.gain(); env(ng.gain, w, 0, [[0, 0], [.004, v], [.13, 1e-4, 'e']]); n.connect(lp); lp.connect(ng); ng.connect(bus);
    const o = D.osc('sine', 92, w, w + .15), g = D.gain(); env(o.frequency, w, 0, [[0, 96], [.08, 68, 'e']]); env(g.gain, w, 0, [[0, 0], [.004, v * .5], [.1, 1e-4, 'e']]); o.connect(g); g.connect(bus); };
  // the jelly 'bloop' of a stepped drop: pitch wobbling like the drop's own squash (BIBLE.md M5), on a dry B3 centre
  INST.bloop = (D, w, off, a) => { if (short(off)) return; const f = a.f || hz('B3'), v = a.v ?? .14, end = w + .55, o = D.osc('sine', f, w, end), o2 = D.osc('triangle', f * 2, w, end), g = D.gain(), g2 = D.gain(.18);
    const fp = [[0, f * .6], [.07, f * 1.2, 'e'], [.17, f * .92, 'e'], [.28, f * 1.05, 'e'], [.4, f, 'e']]; env(o.frequency, w, 0, fp); env(o2.frequency, w, 0, fp, 2);
    env(g.gain, w, 0, [[0, 0], [.012, v], [.12, v * .55], [.48, 1e-4, 'e']]); o.connect(g); o2.connect(g2); g2.connect(g);
    const lp = D.filt('lowpass', 1300, .7); g.connect(lp); D.out(lp, { pan: a.pan || 0, rev: .3 }); };
  // breath: in (a.kind 'in': rising, brighter) or out (falling). Below: shush (a 'shh', noise with a peak near 4.3 kHz),
  // rustle (cloth or leaves, an uneven noise swell) and swish (a short rising band of noise).
  INST.breath = (D, w, off, a) => { const dur = a.dur || .8; if (off > dur) return; const v = a.v ?? .03, inh = a.kind === 'in', n = D.noise(w, w - off + dur + .05, a.seed || 22);
    const bp = D.filt('bandpass', inh ? 1500 : 1200, .7), hp = D.filt('highpass', 450, .7), g = D.gain(0); if (inh) env(bp.frequency, w, off, [[0, 1100], [dur, 2300, 'e']]);
    env(g.gain, w, off, inh ? [[0, 0], [dur * .85, v], [dur, 0]] : [[0, 0], [.12, v], [dur * .5, v * .6], [dur, 0]]); n.connect(bp); bp.connect(hp); hp.connect(g); D.out(g, { pan: a.pan || 0, rev: .15 }); };
  INST.shush = (D, w, off, a) => { const dur = a.dur || .5; if (off > dur) return; const v = a.v ?? .05, n = D.noise(w, w - off + dur + .05, a.seed || 23), hp = D.filt('highpass', 1900, .7), pk = D.filt('peaking', a.f || 4300, 1, 9), lp = D.filt('lowpass', 8000, .6), g = D.gain(0);
    env(g.gain, w, off, [[0, 0], [.07, v], [dur - .12, v * .8], [dur, 0]]); n.connect(hp); hp.connect(pk); pk.connect(lp); lp.connect(g); D.out(g, { pan: a.pan || 0, rev: .25 }); };
  INST.rustle = (D, w, off, a) => { const dur = a.dur || .4; if (off > dur) return; const v = a.v ?? .03, n = D.noise(w, w - off + dur + .05, a.seed || 24), bp = D.filt('bandpass', a.f || 1500, .8), g = D.gain(0);
    env(g.gain, w, off, [[0, 0], [dur * .15, v], [dur * .3, v * .4], [dur * .5, v * .8], [dur * .75, v * .3], [dur, 0]]); n.connect(bp); bp.connect(g); D.out(g, { pan: a.pan || 0, rev: .15 }); };
  INST.swish = (D, w, off, a) => { const dur = a.dur || .35; if (off > dur) return; const v = a.v ?? .03, n = D.noise(w, w - off + dur + .05, a.seed || 25), bp = D.filt('bandpass', 2200, 1.5), g = D.gain(0);
    env(bp.frequency, w, off, [[0, 2000], [dur, 4800, 'e']]); env(g.gain, w, off, [[0, 0], [dur * .35, v], [dur, 0]]); n.connect(bp); bp.connect(g); D.out(g, { pan: a.pan || 0, rev: .3 }); };
  // wings: a flutter of feathers (Tock), noise amplitude-modulated at a.rate wingbeats per second
  INST.flutter = (D, w, off, a) => { const dur = a.dur || .3; if (off > dur) return; const v = a.v ?? .03, end = w - off + dur + .05, n = D.noise(w, end, a.seed || 26), bp = D.filt('bandpass', 950, 1.2), am = D.gain(.5), lfo = D.osc('sine', a.rate || 17, w, end), lg = D.gain(.5), g = D.gain(0);
    lfo.connect(lg); lg.connect(am.gain); env(g.gain, w, off, [[0, 0], [.03, v], [dur - .05, v * .7], [dur, 0]]); n.connect(bp); bp.connect(am); am.connect(g); D.out(g, { pan: a.pan || 0, rev: .2 }); };
  // cistern glugs: a.n low bubbles (85-175 Hz, each rising), a little apart
  INST.glug = (D, w, off, a) => { if (short(off, .1)) return; const v = a.v ?? .1, bus = D.gain(1), lp = D.filt('lowpass', 700, .7); bus.connect(lp); D.out(lp, { pan: a.pan || 0, rev: .35 });
    for (let i = 0; i < (a.n || 4); i++) { const t = w + i * (.07 + .05 * H(i, a.seed || 1)), f = 85 + 90 * H(i, a.seed || 1, 2), o = D.osc('sine', f, t, t + .15), g = D.gain();
      env(o.frequency, t, 0, [[0, f], [.05, f * 1.7, 'e']]); env(g.gain, t, 0, [[0, 0], [.006, v * (1 - .15 * i)], [.1, 1e-4, 'e']]); o.connect(g); g.connect(bus); } };
  // a child stomping a puddle: a step, a splash and a late plip
  INST.stomp = (D, w, off, a) => { if (short(off)) return; const v = a.v ?? .1; INST.step(D, w, 0, { v, pan: a.pan, f: 260, seed: a.seed });
    INST.splash(D, w + .01, 0, { v: v * .9, f: 1700, pan: a.pan, seed: (a.seed || 0) + 3 }); INST.plip(D, w + .09, 0, { f: 1700, v: v * .3, pan: (a.pan || 0) + .2 }); };
  // Pell landing in the hush-cloth (73.0): a low sine sagging 66 -> 38 Hz and two low noise bursts
  INST.thud = (D, w, off, a) => { if (short(off)) return; const v = a.v ?? .4, bus = D.gain(1); D.out(bus, { rev: .2 });
    const o = D.osc('sine', 62, w, w + .6), g = D.gain(); env(o.frequency, w, 0, [[0, 66], [.25, 38, 'e']]); env(g.gain, w, 0, [[0, 0], [.012, v], [.5, 1e-4, 'e']]); o.connect(g); g.connect(bus);
    const n = D.noise(w, w + .5, 27), lp = D.filt('lowpass', 230, .8), ng = D.gain(); env(ng.gain, w, 0, [[0, 0], [.006, v * .8], [.22, 1e-4, 'e']]); n.connect(lp); lp.connect(ng); ng.connect(bus);
    const n2 = D.noise(w, w + .5, 28), bp = D.filt('bandpass', 380, 1), n2g = D.gain(); env(n2g.gain, w, 0, [[0, 0], [.03, v * .45], [.32, 1e-4, 'e']]); n2.connect(bp); bp.connect(n2g); n2g.connect(bus); };
  // a glissando of small bells (the sun breaking through): music-box notes a.gap s apart, sweeping left to right, fading
  INST.shimmer = (D, w, off, a) => { if (short(off, .1)) return; (a.notes || []).forEach((n, i) => INST.mbox(D, w + i * (a.gap || .055), 0, { n, v: (a.v ?? .05) * (1 - .4 * i / a.notes.length), pan: -.5 + i / a.notes.length, dec: 1.4, echo: 0 })); };
  // bass: a soft low note (sine + a triangle an octave up).  sub: a sustained sine + octave under the big D chords
  // (its octave gain is made at 0.2 and then set to 0.32; 0.32 is what sounds).  Both on the music bus.
  INST.bass = (D, w, off, a) => { const dur = a.dur || 1.5; if (off > dur + .5) return; const f = hz(a.n), v = a.v ?? .2, end = w - off + dur + .6, o = D.osc('sine', f, w, end), o2 = D.osc('triangle', f * 2, w, end), g = D.gain(0), g2 = D.gain(.22);
    o.connect(g); o2.connect(g2); g2.connect(g); env(g.gain, w, off, [[0, 0], [a.att ?? .03, v], [dur, v * .6, 'e'], [dur + .5, 0]]); D.out(g, { bus: 'm', rev: .15 }); };
  INST.sub = (D, w, off, a) => { const dur = a.dur, rel = a.rel ?? 1.5; if (off > dur + rel) return; const f = hz(a.n || 'D2'), v = a.v ?? .2, end = w - off + dur + rel + .1, o = D.osc('sine', f, w, end), o2 = D.osc('sine', f * 2, w, end), g = D.gain(0), g2 = D.gain(.2);
    o.connect(g); o2.connect(g2); g2.connect(g); g2.gain.value = .32; env(g.gain, w, off, [[0, 0], [a.att ?? .4, v], [dur, v], [dur + rel, 0]]); D.out(g, { bus: 'm', rev: .12 }); };
  // a low felt pulse under the run (a dry B1)
  INST.fpulse = (D, w, off, a) => { if (short(off)) return; const f = hz(a.n || 'B1'), v = a.v ?? .12, o = D.osc('sine', f, w, w + .5), o2 = D.osc('sine', f * 2, w, w + .3), g = D.gain(), g2 = D.gain(.35);
    o.connect(g); o2.connect(g2); g2.connect(g); env(g.gain, w, 0, [[0, 0], [.012, v], [.4, 1e-4, 'e']]); D.out(g, { bus: 'm', rev: .15 }); };
  // a flute-like melody line (the theme): legato, sine + soft octave and twelfth, delayed vibrato, a breathy chiff per note.
  //   a.notes [[dt, note]], a.acc per-note accents, a.end. Curves: fp pitch (a 70 ms slide between notes), ap loudness
  //   (a small dip before each note), vb vibrato depth in cents (none for 0.35 s, then up to 14), ch the chiff noise.
  INST.line = (D, w, off, a) => {
    const end = a.end; if (off > end + .5) return; const v = a.v ?? .1, stopAt = w - off + end + .6, fp = [], ap = [[0, 0]], vb = [[0, 0]], ch = [[0, 0]];
    a.notes.forEach(([dt, n], i) => { const f = hz(n); if (!i) fp.push([dt, f]); else fp.push([dt - .02, fp[fp.length - 1][1]], [dt + .05, f, 'e']);
      const acc = (a.acc && a.acc[i]) ?? 1, pacc = i ? ((a.acc && a.acc[i - 1]) ?? 1) : 0; if (i) ap.push([dt - .045, pacc], [dt, .62]); ap.push([dt + .05, acc]); vb.push([dt, 0], [dt + .35, 0], [dt + .7, 14]); ch.push([dt, 0], [dt + .012, 1], [dt + .06, .25]); });
    ap.push([end, .9], [end + .4, 0]); ch.push([end, .25], [end + .4, 0]);
    const o1 = D.osc('sine', 440, w, stopAt), o2 = D.osc('sine', 880, w, stopAt), o3 = D.osc('sine', 1320, w, stopAt);
    env(o1.frequency, w, off, fp); env(o2.frequency, w, off, fp, 2); env(o3.frequency, w, off, fp, 3);
    const lfo = D.osc('sine', 5.2, w, stopAt), lg = D.gain(0); lfo.connect(lg); for (const o of [o1, o2, o3]) lg.connect(o.detune); env(lg.gain, w, off, vb);
    const sum = D.gain(1), g2 = D.gain(.14), g3 = D.gain(.045); o1.connect(sum); o2.connect(g2); g2.connect(sum); o3.connect(g3); g3.connect(sum);
    const bn = D.noise(w, stopAt, 29), bp = D.filt('bandpass', 2600, 1), bg = D.gain(0); env(bg.gain, w, off, ch, .18); bn.connect(bp); bp.connect(bg); bg.connect(sum);
    const amp = D.gain(0); sum.connect(amp); env(amp.gain, w, off, ap, v); D.out(amp, { bus: 'm', pan: a.pan || 0, rev: .45, echo: .08 });
  };

  // ============================================================================================================
  // 5. The field as the ear counts it: drops of all three bands, when they let go (the events' own release math),
  //    where, and when they land. From it: the rain-bed lanes (10 Hz) and the release-plink cascades.
  //    The drops are film/rain.js's own (FILM.rain.sets) when that module is present, else a stand-in field of the
  //    same shape (rainDrops / fieldDrops below). Bands: 0 heavy (answers D), 1 marble (A), 2 mist (E).
  // ============================================================================================================
  // per shot: [the ear's position as a function of film time (the shot's subject), R in metres]. R is how far the ear
  // hears falling rain: a drop d metres away counts exp(-(d / R)^2), so wide shots (R 55-70 m) hear the whole field
  // and close shots (R 14 m) only the rain around the subject.
  const SUBJ = {
    s01: [() => P.special.macro.pos, 14], s02: [() => [10, 20, -70], 55], s03: [() => P.kid, 14], s04: [() => P.pellRoofSpot, 14],
    s05: [t => P.pell(t).pos, 26], s06: [() => V.places.tollTerrace.drum, 42], s07: [() => [70, 24, -45], 55], s08: [t => P.pell(t).pos, 24],
    s09: [t => P.pell(t).pos, 20], s10: [t => P.pell(t).pos, 20], s11: [t => P.pell(t).pos, 20], s12: [t => P.pell(t).pos, 22], s13: [t => P.pell(t).pos, 26],
    s14: [() => P.add(P.cloth.pos, [-20, 0, -15]), 70], s15: [() => P.cloth.pos, 34], s16: [() => P.cloth.pos, 34], s17: [() => V.places.spillway.bench, 26] };
  // per-shot trims of the rain bands [heavy, marble, mist] (the camera's distance and what the shot wants to hear)
  const RTRIM = { s05: [1, 1, 1], s06: [.9, 1, 1.1], s07: [.7, .7, .5], s12: [1, 1.1, 1], s13: [1.1, 1, 1], s14: [1.25, 1.15, 1], s15: [.9, .9, .8], s16: [.45, .45, .5], s17: [0, 0, 0] };   // s17 is hours later: the field's rain is long gone
  // The drops come from film/rain.js when it is present: its instance sets carry every drop's rest position, size, seed,
  // flags and its release time (rain.js works it out from FILM.events and keeps it). Every drop that lets go is checked
  // for plinks (is it near the ear when it goes?); one in `step` also feeds the rain bed, with a weight w that makes up
  // for the ones skipped, so the bed costs what the stand-in costs (WANT: the stand-in's drop count per band).
  // Layout read here (see film/rain.js): rest[k*3..] position (field-local if it drifts with the field),
  // info[k*4..] = band, radius, seed, flags; life[k*4..] = since, until, release time, hang. The mist set has no `life`
  // and packs info = release time, radius, seed, flags (all band 2).
  // Without rain.js, a stand-in field of the same shape (P.FIELD strata) is used and its release times come from the tolls.
  // Returns [{ local, drifting, band, seed, size (diameter, m), since, tr (release time), bed, w }] or null.
  function rainDrops(near) {
    const R = F.rain, sets = R && R.sets, DRIFT = (R && R.FLAGS && R.FLAGS.DRIFT) || 1; if (!sets || !sets.big || !sets.big.n) return null;
    const WANT = [2600, 3000, 3000], out = [];
    for (const name of ['big', 'marble', 'local', 'mist']) { const S = sets[name]; if (!S || !S.n || !S.rest || !S.info) continue;
      const packed = !S.life;   // the mist set packs [tr, r, seed, flags] per drop and is all band 2
      const bandOf = k => packed ? 2 : S.info[k * 4] | 0, trOf = k => packed ? S.info[k * 4] : S.life[k * 4 + 2];
      const cnt = [0, 0, 0]; for (let k = 0; k < S.n; k++) cnt[bandOf(k)]++;
      const step = cnt.map((c, b) => name === 'local' ? 1 : Math.max(1, Math.round(c / WANT[b])));
      for (let k = 0; k < S.n; k++) { const band = bandOf(k), tr = trOf(k); if (!(tr >= 0 && tr < LEN)) continue;
        const bed = name === 'local' || k % step[band] === 0, drifting = (S.info[k * 4 + 3] & DRIFT) ? 1 : 0;
        // the others only matter if they are close enough to plink (one in three is plenty: at most 60 per toll are played)
        if (!bed && (k % 3 || (near && !near(S.rest[k * 3], S.rest[k * 3 + 1], S.rest[k * 3 + 2], drifting, tr)))) continue;
        out.push({ local: [S.rest[k * 3], S.rest[k * 3 + 1], S.rest[k * 3 + 2]], drifting: (S.info[k * 4 + 3] & DRIFT) ? 1 : 0, band, seed: S.info[k * 4 + 2],
          size: 2 * S.info[k * 4 + 1], since: packed ? null : S.life[k * 4], tr, bed,
          w: name === 'local' ? 1 : step[band] * WANT[band] / Math.max(1, cnt[band]) }); } }
    return out.length > 200 ? out : null;
  }
  // rain.js's drops if it can be read, else the stand-in: 2600 heavy, 3000 marble, 3000 mist drops spread evenly over the
  // field's ellipse (sqrt for an even spread by area), at the band's heights, sizes skewed small; all drift with the field
  function fieldDrops(near) {
    try { const d = rainDrops(near); if (d) { stats.field = 'rain.js'; return d; } } catch (e) { console.warn('music: could not read rain.js drops, using a stand-in field: ' + e.message); }
    stats.field = 'stand-in';
    const r = A.named('synth-field'), FL = P.FIELD, out = [];
    for (const [band, n, [y0, y1], [s0, s1]] of [[0, 2600, FL.heavy, [.18, .45]], [1, 3000, FL.marble, [.02, .06]], [2, 3000, FL.mist, [.002, .008]]])
      for (let i = 0; i < n; i++) { const u = Math.sqrt(r()), ang = r() * TAU, y = lerp(y0, y1, r()); out.push({ local: [Math.cos(ang) * u * FL.rx, y, Math.sin(ang) * u * FL.rz], drifting: 1, band, seed: r(), size: lerp(s0, s1, Math.pow(r(), 1.5)) }); }
    return out;
  }
  // the same loop as FILM.events.releaseTime, but it also says which toll let the drop go: a toll of the drop's band whose
  // sound reaches it (within `reach` m) after the drop formed (`since`), and, for a sustained note, was held long enough
  function releaser(d) {
    let tr = 1e9, ev = null; const since = d.since ?? -1;
    for (const e of EV.T) { if (e.band !== d.band) continue; const p = EV.posAt(d.local, d.drifting, e.t0), dist = Math.hypot(p[0] - e.src[0], p[1] - e.src[1], p[2] - e.src[2]);
      if (dist > e.reach) continue; if (e.hold > 0 && e.dur < e.hold) continue; const ta = e.t0 + dist / EV.C_SOUND; if (ta < since) continue;
      const x = ta + e.hold + .08 * d.seed; if (x < tr) { tr = x; ev = e; } }
    return { tr, ev };
  }
  // analyse(): one pass over every drop, on a grid of 0.1 s bins (NB of them). Per band it adds up
  //   fall  how close each falling drop is to the ear, every bin from its release to its landing
  //   imp   landings near the ear          rel   releases near the ear
  // Drops that let go within 30 m of the ear are also grouped by the toll that released them, for the plinks.
  // Returns { NB, curve (per band, 0..1 per bin: how much rain the ear hears), groups, released, mismatch, drops, shot }.
  function analyse() {
    // the ear (subject), its hearing radius and the shot id for every bin
    const NB = Math.ceil(LEN * 10) + 2, sub = [], rad = [], shot = [];
    for (let b = 0; b < NB; b++) { const t = Math.min(LEN - .001, b / 10), sh = S.shotAt(t), sj = SUBJ[sh.id] || [() => [0, 20, 0], 40]; sub.push(sj[0](t)); rad.push(sj[1]); shot.push(sh.id); }
    const subAt = t => sub[clamp(Math.round(t * 10), 0, NB - 1)], radAt = t => rad[clamp(Math.round(t * 10), 0, NB - 1)];
    const fall = [0, 1, 2].map(() => new Float32Array(NB)), imp = [0, 1, 2].map(() => new Float32Array(NB)), rel = [0, 1, 2].map(() => new Float32Array(NB));
    const groups = {}; let released = 0, mismatch = 0;
    // a quick test for the rain.js drops that only plink: within 30 m of the ear when they let go (900 = 30^2)
    const near = (x, y, z, drifting, tr) => { const c = drifting ? P.fieldC(tr) : null, s0 = subAt(tr);
      return (c ? (x + c[0] - s0[0]) ** 2 + (y + c[1] - s0[1]) ** 2 + (z + c[2] - s0[2]) ** 2 : (x - s0[0]) ** 2 + (y - s0[1]) ** 2 + (z - s0[2]) ** 2) < 900; };
    const tA = performance.now(), drops = fieldDrops(near); stats.dropsMs = Math.round(performance.now() - tA);
    drops.forEach((d, i) => {
      // its release time: rain.js's stored one, or worked out here (a stand-in drop no toll reaches never falls)
      let tr, ev = null;
      if (d.tr != null) tr = d.tr; else { const r = releaser(d); tr = r.tr; ev = r.ev; if (!ev) return; }
      if (tr >= LEN) return;
      const p = EV.posAt(d.local, d.drifting, tr), s0 = subAt(tr), R0 = radAt(tr), dr = Math.hypot(p[0] - s0[0], p[1] - s0[1], p[2] - s0[2]);
      // release plinks: drops letting go within 30 m of the subject, grouped by the toll that let them go (a drop whose time
      // no toll explains, a story drop or an emitter's, has its own sound elsewhere)
      if (dr < 30) { if (!ev) { const r = releaser(d); if (r.ev && Math.abs(r.tr - tr) < .02) ev = r.ev; }
        if (ev) { const key = ev.id.replace(/\d+$/, ''); (groups[key] = groups[key] || []).push({ tr, d: dr, band: d.band, size: d.size, p, s: s0 }); } }
      if (d.bed === false) return;
      released++;
      // a spot check on every 97th drop: does its stored release time agree with FILM.events.releaseTime?
      // (stats.releaseMismatch should stay 0; the mist set stores no `since`, so it is not checked)
      if (i % 97 === 0 && d.since !== null && Math.abs(EV.releaseTime(d.local, d.drifting, d.band, d.seed, d.since ?? -1) - tr) > 1e-3) mismatch++;
      // th: when it lands (it falls dh metres to the ground). sw: its weight; a heavy drop counts by size (0.3 m = 1)
      const g = V.ground(p[0], p[2]), dh = Math.max(.1, p[1] - g), th = tr + EV.hitTau(dh, d.band), sw = (d.w ?? 1) * (d.band === 0 ? d.size / .3 : 1);
      rel[d.band][Math.round(tr * 10)] += (d.w ?? 1) * Math.exp(-((dr / R0) ** 2));
      // while it falls: how near the ear it is, every 0.1 s (slow marble and mist drops fall for many seconds: sampled every
      // 0.2 / 0.3 s and held, which the smoothing below cannot tell apart)
      const stride = d.band === 2 ? 3 : d.band === 1 ? 2 : 1, bEnd = Math.min(NB - 1, Math.floor(th * 10)), F = fall[d.band];
      for (let b = Math.ceil(tr * 10); b <= bEnd; b += stride) { const s = sub[b], y = p[1] - EV.fall(b / 10 - tr, d.band), R = rad[b];
        const v = sw * Math.exp(-((p[0] - s[0]) ** 2 + (y - s[1]) ** 2 + (p[2] - s[2]) ** 2) / (R * R)); if (v < 1e-6) continue; for (let j = b; j < b + stride && j <= bEnd; j++) F[j] += v; }
      // its landing, weighed by the distance from the landing spot to the ear
      if (th < LEN) { const s = subAt(th), R = radAt(th), d2 = (p[0] - s[0]) ** 2 + (g - s[1]) ** 2 + (p[2] - s[2]) ** 2; imp[d.band][Math.round(th * 10)] += sw * Math.exp(-d2 / (R * R)); }
    });
    // smooth: impacts ring for ~0.5 s, releases for ~0.8 s (a one-pole decay with that time constant)
    const decay = (a, tau) => { const k = Math.exp(-.1 / tau), o = new Float32Array(a.length); let y = 0; for (let i = 0; i < a.length; i++) { y = y * k + a[i]; o[i] = y; } return o; };
    // mix the three per band: heavy and marble rain is heard mostly while it falls (and lands); mist is heard mostly
    // as it lets go (a glittering hiss) and hardly at all as it drifts down
    const lvl = [0, 1, 2].map(b => { const im = decay(imp[b], .5), rl = decay(rel[b], .8); return Array.from(fall[b], (x, i) => b === 2 ? .3 * x + 2.0 * rl[i] + .5 * im[i] : x + .8 * im[i] + .3 * rl[i]); });
    // 0..1 with a soft ceiling: 1 - exp(-x / (0.3 max)), so 30 % of the band's peak already reads 0.63 and the loudest
    // moments do not dwarf the rest
    const curve = lvl.map(L => { let mx = 1e-6; for (const x of L) mx = Math.max(mx, x); const X0 = .3 * mx; return L.map(x => 1 - Math.exp(-x / X0)); });
    return { NB, curve, groups, released, mismatch, drops: drops.length, shot };
  }

  // ============================================================================================================
  // 6. The cue sheet: [{ t, k (instrument), a (args), d (how long it sounds), tolls ({id: film time}) }]
  //    t is film time (s). d tells a seek whether a cue is still sounding and must be joined in the middle.
  //    tolls marks the cue that voices a toll of FILM.events.T, so check() can prove every toll has its sound.
  //    The sheet is written bar by bar in film order (the form of film/BIBLE.md section 7), then the release plinks of
  //    the field and the other modules' emitters are added, and everything is sorted by time.
  // ============================================================================================================
  // PREP: the prepared { cues, lanes, an (the analysis) }, made once by prepare(). EXTRA: cue groups other modules gave add().
  let PREP = null; const EXTRA = {};
  function buildCues(an) {
    const C = []; const cue = (t, k, a = {}, d = .5, tolls) => { if (t >= -1 && t < LEN) C.push({ t, k, a, d, tolls }); };
    const T0 = id => { const e = EV.T.find(x => x.id === id); return e ? e.t0 : null; };   // a toll's time, or null if absent
    const has = g => !EXTRA[g];                                   // false when another module supplied this group via add()
    const pan = (i, s = .6) => (H(i, 77) * 2 - 1) * s;            // a seeded pan within +-s
    // ---- film/life.js, when present, says when the creatures sound: the chimewings' ringing windows (and where the birds
    //      are), the dripfrogs (the hero's catch, the chorus croaking every two beats), the tadpoles' plops. Without it,
    //      fixed times written below are used.
    //      earAt / panAt: the ear of the shot at time t, and a cheap pan from a point's offset to it along x - z.
    const LF = F.life, earAt = t => { const sj = SUBJ[S.shotAt(t).id]; return sj ? sj[0](t) : [0, 20, 0]; };
    const panAt = (p, t, w = 30) => { const e = earAt(t); return clamp(((p[0] - e[0]) - (p[2] - e[2])) / w, -.9, .9); };
    // WINGS: the ringing windows found by sampling life.js's birdRing every 0.05 s, for flock A (birds 0-39) and flock B (40-79)
    const WINGS = (() => { if (!LF || typeof LF.birdRing !== 'function' || typeof LF.bird !== 'function') return null; const out = [];
      for (const [i0, n] of [[0, 40], [40, 40]]) { let on = -1; for (let t = 0; t <= LEN; t += .05) { const r = !!LF.birdRing(i0, t); if (r && on < 0) on = t; if ((!r || t + .05 > LEN) && on >= 0) { out.push({ t0: on, t1: t, i0, n }); on = -1; } } }
      return out.length ? out : null; })();
    // a window of ringing wings: tiny E7 FM bells at irregular moments, panned where the birds are, every third with a
    // sparkle hiss
    //   (t0, t1) the window, birds i0 .. i0 + n - 1, seed, rings per second, level
    const wingWindow = (t0, t1, i0, n, seed, rate, v) => { let t = t0 + .02, k = 0;
      while (t < t1) { const i = i0 + Math.floor(H(k, seed, 1) * n), bp = LF && LF.bird ? LF.bird(i, t) : null, p = bp ? panAt(bp, t) : pan(k + seed, .85);
        cue(t, 'wing', { v: v * (.7 + .6 * H(k, seed, 2)), pan: p, c: (H(k, seed, 4) - .5) * 8 }, .4);
        if (k % 3 === 1) cue(t + .05, 'sparkle', { dur: .8, v: v * .28, pan: p, seed: seed + k }, .8);
        t += (.6 + .8 * H(k, seed, 3)) / rate; k++; } };

    // ---------------- bars 1-4, HUSH (0-12): a dry glass chime, wind, the dry pad; reeds; the chimewing flock
    //                  (8.4-10.9 from life.js's windows, 9.0 in the stand-in)
    cue(.75, 'chime', { n: 'B5', v: .075, dec: 3.2, rev: .7, echo: .2, pan: -.15, bus: 'm' }, 3.5);
    cue(3.0, 'pad', { notes: ['B1', 'F#2', 'C#3'], nv: [.55, .85, 1], dur: 9.0, att: 3.0, rel: 2.0, v: .12, cut: 520, sweep: [[0, 380], [5, 720], [9, 560], [11, 500]] }, 11);
    cue(6.6, 'reed', { n: 'F#5', dur: 2.3, v: .025, pan: -.45 }, 2.3); cue(8.15, 'reed', { n: 'C#6', dur: 1.9, v: .018, pan: .35 }, 1.9); cue(10.3, 'reed', { n: 'F#5', dur: 1.6, v: .02, pan: .1 }, 1.6);
    // the chimewings ring E7 (from life.js's own windows when present: flock A crosses the valley, scatters in the gust and
    // returns over the crowd at 82-86; flock B circles Pell among the drops at 49-52.6). Rings per second and level per window.
    if (has('chimewings') && WINGS) WINGS.forEach((g, j) => { const back = g.t0 > 75, gust = g.t0 > 30 && g.t0 < 45;
      wingWindow(g.t0, g.t1, g.i0, g.n, 300 + j * 50, g.i0 ? 6 : back ? 2.6 : gust ? 4 : 7, g.i0 ? .03 : back ? .022 : .045); });
    // without life.js: one pass of 20 rings from left to right at 9.0
    else if (has('chimewings')) { let t = 9.0; for (let i = 0; i < 20; i++) { const p = -.75 + 1.5 * i / 19; cue(t, 'wing', { v: .035 + .03 * H(i, 9), pan: p, c: (H(i, 4) - .5) * 8 }, .4);
      if (i % 3 === 1) cue(t + .05, 'sparkle', { dur: .9, v: .012, pan: p, seed: i }, .9); t += .07 + .14 * H(i, 2) + (i % 5 === 4 ? .2 : 0); } }
    // ---------------- bars 5-8, LIFE (12-24): the kalimba ostinato (dry), village sounds, the toy bell, the frog, Pell's hum
    cue(11.0, 'pad', { notes: ['B1', 'F#2', 'C#3', 'G#3'], nv: [.5, .8, 1, .85], dur: 13.2, att: 2.0, rel: 1.6, v: .08, cut: 600, sweep: [[0, 500], [6, 820], [13, 560]] }, 14.8);
    // the kalimba ostinato: two one-bar patterns of [eighth-note index, note, level], played with a few ms of seeded
    // timing slop; kal(bar, pattern, from, to, level) plays only the notes inside [from, to)
    const KA = [[0, 'F#4', .8], [2, 'B4', .55], [3, 'C#5', .6], [5, 'G#4', .5], [6, 'B4', .45]], KB = [[0, 'F#4', .7], [2, 'B4', .5], [3, 'C#5', .55], [4, 'G#4', .42], [6, 'F#5', .5], [7, 'C#5', .32]];
    const kal = (bar, pat, from = -1, to = 99, k = 1) => pat.forEach(([e, n, v], i) => { const t = bt(bar) + e * E8 + .008 * (H(bar, e) - .5); if (t >= from && t < to) cue(t, 'kal', { n, v: .16 * v * k * (.9 + .2 * H(bar, e, 1)), pan: pan(bar * 8 + e, .35) }, .1); });
    kal(5, KA); kal(6, KB); kal(7, KA, -1, 19.9, .85); kal(8, [[4, 'B4', .4], [6, 'C#5', .45], [7, 'G#4', .3]], 22.5, 99, .8);
    for (let i = 0; i < 12; i++) cue(12.15 + i * .47 + .1 * H(i, 3), 'step', { v: .03 + .02 * H(i, 5), pan: pan(i, .7), seed: i }, .1);   // villagers' felt boots
    cue(12.9, 'plip', { f: 980, v: .05, pan: .3, rev: .5 }, .1);                                     // a drop-picker's gourd
    if (T0('toybell') != null) { const t = T0('toybell'); cue(t, 'jingle', { n: 'E6', v: .22, pan: -.2 }, .6, { toybell: t }); cue(t + .12, 'sparkle', { dur: 1.1, v: .03, pan: -.2, seed: 3 }, 1.1); cue(t + .45, 'shush', { dur: .55, v: .03, pan: .15, f: 5200 }, .55); }
    if (T0('frog') != null) { const e = EV.T.find(x => x.id === 'frog'); cue(e.t0, 'frog', { n: e.note, dur: e.dur, v: .085, pan: .25, sac: true }, e.dur, { frog: e.t0 });
      const sp = P.special.frog, tr = EV.releaseTime(sp.pos, 0, 0, 0, sp.since ?? -1), land = LF && isFinite(LF.FROG_LAND) ? LF.FROG_LAND : tr + EV.hitTau(.3, 0);
      if (tr < LEN) { cue(tr, 'plink', { n: 'D5', v: .07, pan: .2 }, .1); cue(land, 'plip', { f: 1250, v: .03, pan: .25, rev: .2 }, .1); cue(land + .06, 'gulp', { v: .07, pan: .25 }, .1); } }
    cue(18.4, 'tap', { v: .05, pan: -.4 }, .1); cue(18.62, 'tap', { v: .04, pan: -.4, seed: 2 }, .1); cue(21.3, 'tap', { v: .035, pan: -.4, seed: 3 }, .1);   // Dun strapping on her drum
    // Tock's calls at fixed times (a module that animates him can replace them with FILM.music.add('tock', ...))
    if (has('tock')) { cue(18.85, 'flutter', { dur: .28, v: .02, pan: .3 }, .3); cue(19.85, 'tock', { v: .05, pan: .3 }, .4); cue(23.3, 'tock', { v: .045, pan: .32 }, .4); }
    // Pell's hum. Her line: F#4 G#4 B4, sliding down onto D4 at the toll's time (20.25); the D4, held 1.5 s, lets the
    // drop on her nose go: its plink, then its plip and a little splash when it lands on her
    if (T0('hum') != null) { const t = T0('hum'), o = t - 1.5;
      cue(o, 'voice', { mode: 'hum', notes: [[0, 'F#4'], [.375, 'G#4'], [.75, 'B4'], [1.5, 'D4', null, .22]], end: 1.5 + 1.8, v: .035, pan: .1, rev: .3,
        amp: [[0, 0], [.12, .8], [.7, 1], [1.4, .9], [1.75, 1], [3.1, .9], [3.3, 0]] }, 3.6, { hum: t });
      const sp = P.special.nose, tr = EV.releaseTime(sp.pos, 0, 0, 0, sp.since ?? -1); if (tr < LEN) { cue(tr, 'plink', { n: 'D5', v: .06, pan: .05 }, .1); const hit = tr + EV.hitTau(sp.pos[1] - (P.pellHead(22.4)[1] - .04), 0);
        cue(hit, 'plip', { f: 760, v: .06, pan: .05 }, .1); cue(hit, 'splash', { v: .025, f: 3400, seed: 4 }, .1); } }
    cue(22.6, 'shush', { dur: .7, v: .035, pan: -.35, f: 3800 }, .7);
    // ---------------- bars 9-12, THE TOLL (24-36): fans' felt whooshes in their own phase; the drum (first tonic), chimes, bells
    // the fans: sum the 18 fans' sweep phases from path.js every 20 ms and put a whoosh on each crest (0.45 s before it,
    // so the whoosh peaks with the sweep)
    { const pk = []; let prev = 0, rising = false; for (let t = 23.5; t < 35.5; t += .02) { const v = P.fans(t).reduce((s, f) => s + .5 + .5 * Math.sin(f.phase), 0) / 18 * P.FANS_ON(t);
        if (v < prev && rising && prev > .2) pk.push([t - .02, prev]); rising = v > prev; prev = v; }
      pk.forEach(([t, v], i) => cue(t - .45, 'whoosh', { dur: .85, peak: .53, v: .07 * v, f0: 220, f1: 650 + 80 * H(i, 1), q: .9, pan: pan(i, .3), seed: 40 + i }, .85)); }
    for (let i = 0; i < 8; i++) cue(24.15 + i * .34, 'step', { v: .018, pan: .2, seed: 60 + i }, .1);
    cue(23.5, 'pad', { notes: ['B1', 'F#2', 'C#3', 'F#3'], nv: [.55, .85, 1, .9], dur: 3.5, att: 2.4, rel: .06, v: .17, cut: 900, sweep: [[0, 500], [3.5, 1300]] }, 3.6);
    if (T0('drum') != null) { const t = T0('drum');
      cue(t, 'drum', { n: 'D2', v: .52, ring: true, echo: .32, rev: .35 }, 2, { drum: t });
      cue(t, 'pad', { notes: ['D2', 'A2', 'F#3', 'A3', 'E4'], nv: [1, .9, .8, .6, .35], dur: 3.0, att: .3, rel: .5, v: .2, cut: 1400, sweep: [[0, 2000], [3, 1000]] }, 3.5);
      cue(t + .35, 'beads', { dur: .4, v: .02, pan: .2 }, .4); }
    cue(29.8, 'pad', { notes: ['D2', 'A2', 'E3', 'F#3', 'C#4'], dur: 3.3, att: .6, rel: .5, v: .17, cut: 1100 }, 3.8);
    EV.T.filter(e => /^chime\d/.test(e.id)).forEach((e, i) => cue(e.t0, 'chime', { n: e.note, v: .28, pan: [-.55, 0, .55][i % 3], det: [-3, 1, 4][i % 3], seed: 50 + i }, 1, { [e.id]: e.t0 }));
    EV.T.filter(e => /^cupola\d/.test(e.id)).forEach((e, i) => cue(e.t0, 'hbell', { n: e.note, v: .32, pan: [-.6, -.2, .25, .6][i % 4], dec: 2.4, seed: 60 + i, echo: .12 }, 1, { [e.id]: e.t0 }));
    cue(32.8, 'pad', { notes: ['D2', 'A2', 'E3', 'G#3', 'B3'], dur: 3.2, att: .5, rel: 1.0, v: .16, cut: 1000 }, 4.2);
    [['D4', 33.75, .85], ['E4', 34.125, .7], ['A4', 34.5, .9]].forEach(([n, t, v], i) => { cue(t, 'kal', { n, v: .17 * v, pan: .1 }, .1); });   // the first wet fragment (rain is falling)
    cue(34.5, 'glass', { notes: ['A4'], dur: .9, att: .15, rel: 1.2, v: .05 }, 2.1);
    for (let i = 0; i < 5; i++) cue(33.55 + i * .21, 'swish', { dur: .4, v: .018, pan: -.6 + .3 * i, seed: 70 + i }, .4);   // cup-leaves swivelling
    cue(34.05, 'breath', { kind: 'out', dur: 1.0, v: .016, pan: -.1 }, 1); cue(34.75, 'frog', { n: 'D3', dur: .45, v: .05, pan: .5 }, .5);
    // tadpoles plopping into the cisterns (life.js's plops when present: 33.25-34.95 and from 75.7 on)
    const PLOPS = LF && Array.isArray(LF.plops) && LF.plops.length ? LF.plops.filter(x => isFinite(x.t)) : null;
    if (PLOPS) PLOPS.forEach((x, i) => { const c = V.cisterns[x.c]; cue(x.t, 'plip', { f: 560 + 260 * H(i, 41), v: .045 * (x.t > 70 ? .8 : 1), pan: c ? panAt(c.pos, x.t, 20) : pan(i + 400, .5), rev: .3 }, .1); });
    else { cue(35.1, 'plip', { f: 720, v: .05, pan: .4 }, .1); cue(35.38, 'plip', { f: 640, v: .04, pan: .45 }, .1); }
    // ---------------- bars 13-14, THE GUST (36-42): whip, curtains snapping in a chain, the dry cluster sinks, scattered rings
    cue(36.0, 'whoosh', { dur: .55, peak: .45, v: .2, f0: 500, f1: 2600, q: .7, pan0: -.8, pan1: .8, rev: .1, seed: 90 }, .55);
    for (let i = 0; i < 11; i++) cue(36.15 + i * .23 + .06 * H(i, 7), 'flap', { v: .06 * (1 - .06 * i), pan: pan(i + 30, .8), f: 560 + 200 * H(i, 3), seed: 80 + i }, .1);
    cue(36.0, 'pad', { notes: ['G#1', 'B1', 'C#2'], dur: 4.0, att: .9, rel: 1.6, v: .19, cut: 360, sweep: [[0, 420], [4, 260]] }, 5.6);
    if (has('chimewings') && !WINGS) [36.6, 36.85, 37.4, 37.75, 38.5, 39.1].forEach((t, i) => { cue(t, 'wing', { v: .03, pan: pan(i + 50, .9) }, .3); cue(t + .05, 'sparkle', { dur: .6, v: .008, pan: pan(i + 50, .9), seed: 20 + i }, .6); });
    cue(39.4, 'rustle', { dur: .35, v: .02, pan: .1 }, .4);   // Pell's grip on the staff
    // ---------------- bars 15-18, THE RUN (42-54): the pulse returns as a rising dry arpeggio (8ths, then 16ths); felt feet,
    // the hut roof, rung clicks, the jelly bloop of every stepped drop and the D plink 0.75 s later when it lets go
    // SC: the dry scale (B C# F# G#) the arpeggio climbs; the patterns below are indices into it
    const SC = ['B3', 'C#4', 'F#4', 'G#4', 'B4', 'C#5', 'F#5', 'G#5', 'B5', 'C#6', 'F#6'];
    [[15, [0, 1, 2, 3, 4, 5, 6, 7]], [16, [1, 2, 3, 4, 5, 6, 7, 8]]].forEach(([bar, idx]) => idx.forEach((k, j) => cue(bt(bar) + j * E8, 'kal', { n: SC[k], v: (j % 2 ? .14 : .19) * (bar === 16 ? 1.1 : 1), pan: -.3 + .6 * j / 7, lp: 5000 }, .1)));
    [[17, [0, 1, 2, 3, 4, 3, 2, 1, 2, 3, 4, 5, 6, 5, 4, 3]], [18, [2, 3, 4, 5, 6, 5, 4, 3, 4, 5, 6, 7, 8, 7, 6, 5]], [19, [4, 5, 6, 7, 8, 7, 6, 5, 6, 7, 8, 9, 10, 9, 8, 7]]].forEach(([bar, idx]) =>
      idx.forEach((k, j) => { const t = bt(bar) + j * E16; if (t < 57) cue(t, 'kal', { n: SC[k], v: (j % 4 ? .1 : .15) * (bar === 19 ? 1.15 : 1), pan: Math.sin(j * .7) * .4, lp: 6000 }, .1); }));
    for (let t = 42; t < 56.9; t += t < 48 ? 1.5 : .75) cue(t, 'fpulse', { v: t < 48 ? .1 : .085 }, .1);
    cue(48.0, 'glass', { notes: ['B3', 'F#4', 'C#5'], dur: 9.0, att: 4.5, rel: .012, v: .09, env: [[0, 0], [5, .8], [6, 1], [8.99, 1], [9.0, .02], [9.012, 0]] }, 9.1);
    cue(54.0, 'glass', { notes: ['G#5'], dur: 3.0, att: 1.5, rel: .012, v: .03, env: [[0, 0], [1.5, 1], [2.99, 1], [3.0, .02], [3.012, 0]] }, 3.1);
    // Pell's feet on the run and the rungs at fixed times (a module that animates her can replace them with
    // FILM.music.add('pellsteps', ...)); the drop landings come from path.js (P.hops: ts she lands, tr it lets go)
    if (has('pellsteps')) [42.0, 42.17, 42.35, 42.52, 42.69].forEach((t, i) => cue(t, 'step', { v: .06, pan: -.1 + .05 * i, seed: 100 + i }, .1));
    cue(42.72, 'whoosh', { dur: .3, peak: .4, v: .05, f0: 700, f1: 2400, q: .8, seed: 101 }, .3);
    cue(43.0, 'step', { v: .07, squish: true, pan: .05 }, .2); cue(43.45, 'whoosh', { dur: .32, peak: .4, v: .05, f0: 700, f1: 2600, q: .8, seed: 102 }, .3);
    cue(44.25, 'tok', { v: .09, pan: .1 }, .1); cue(44.27, 'step', { v: .05, pan: .1, seed: 103 }, .1);
    if (has('pellsteps')) [44.6, 44.85, 45.5, 45.75].forEach((t, i) => cue(t, 'tok', { v: .06 + .02 * (i % 2), pan: .1, seed: 104 + i }, .1)); cue(44.7, 'rustle', { dur: .25, v: .025 }, .3); cue(45.6, 'rustle', { dur: .25, v: .025, seed: 2 }, .3);
    cue(46.05, 'whoosh', { dur: .4, peak: .45, v: .06, f0: 600, f1: 2200, q: .8, seed: 103 }, .4);
    P.hops.forEach((d, i) => { cue(d.ts, 'bloop', { v: .12, f: hz('B3') * (1 + .06 * (H(i, 3) - .5)), pan: Math.sin(i * 1.1) * .3 }, .3);
      if (d.tr < LEN) cue(d.tr, 'plink', { n: d.r > .48 ? 'D4' : 'D5', v: .11, pan: Math.sin(i * 1.1 + 1) * .4 }, .1);
      if (i % 3 === 1) cue(d.ts + .1, 'flutter', { dur: .3, v: .018, pan: .4, seed: 30 + i }, .3); });
    cue(P.H.ts, 'bloop', { v: .15, f: hz('B3') * .9 }, .3);
    if (has('chimewings') && !WINGS) for (let i = 0; i < 7; i++) { const t = 49.8 + i * .16 + .1 * H(i, 6); cue(t, 'wing', { v: .028, pan: pan(i + 70, .9) }, .3); cue(t + .06, 'sparkle', { dur: .7, v: .007, pan: pan(i + 70, .9), seed: 40 + i }, .7); }
    [49.6, 51.1, 52.5].forEach((t, i) => cue(t, 'beads', { dur: .9, v: .012, pan: -.4 + .4 * i, seed: 50 + i }, .9));   // bead curtains parting
    // ---------------- bars 19-20, THE BELL (54-60): Pell's thin bell, faster and harder; the crack at 57.0 cuts everything
    //                  (the lanes hold the film silent until the wind returns at 59.5)
    cue(53.7, 'rustle', { dur: .3, v: .025, f: 1800, seed: 5 }, .3);
    EV.T.filter(e => /^bell\d/.test(e.id)).forEach((e, i) => { cue(e.t0, 'hbell', { n: e.note, cents: e.sharp || 14, v: .22 + .07 * i, thin: true, dec: 1.5, pan: .08, rev: .4, seed: 110 + i }, 1, { [e.id]: e.t0 });
      cue(e.t0 + .1, 'sparkle', { dur: .7, v: .01 + .002 * i, pan: .1, seed: 60 + i }, .7); });
    cue(57.0, 'crack', { v: .45 }, .3); cue(57.36, 'tick', { v: .1 }, .1);
    // ---------------- bars 21-22, MA (60-66): wind, her breath, one distant plip, the tiny test hum (64.5), the inhale
    cue(60.6, 'breath', { kind: 'out', dur: 1.3, v: .012 }, 1.3); cue(62.25, 'plip', { f: 900, v: .035, rev: .7, echo: .45, pan: -.3 }, .1);
    cue(63.0, 'breath', { kind: 'in', dur: .9, v: .01 }, .9); cue(63.85, 'breath', { kind: 'out', dur: 1.1, v: .01 }, 1.1);
    if (T0('testhum') != null) { const e = EV.T.find(x => x.id === 'testhum'); cue(e.t0, 'voice', { mode: 'hum', notes: [[0, e.note]], end: e.dur, v: .02, amp: [[0, 0], [.08, 1], [e.dur - .1, .8], [e.dur + .12, 0]], rev: .4 }, e.dur + .2, { testhum: e.t0 }); }
    cue(65.25, 'breath', { kind: 'in', dur: .55, v: .03 }, .6);
    // ---------------- bar 23, THE NOTE (66-69): Pell sings A4 'ah' lifting to D5 'oh' (vibrato after 0.4 s) over a dry choir.
    // One voice cue carries both tolls (voiceA 66.0, voiceD 67.5); D5 is held to the end of its toll (71.0).
    if (T0('voiceA') != null) { const ta = T0('voiceA'), td = T0('voiceD') ?? ta + 1.5, ed = EV.T.find(x => x.id === 'voiceD'), endD = td + (ed ? ed.dur : 3.5) - ta;
      cue(ta, 'voice', { notes: [[0, 'A4', 'ah'], [td - ta, 'D5', 'oh', .08]], end: endD, v: .135, pan: 0, rev: .4, echo: .18,
        amp: [[0, 0], [.12, .9], [.6, .85], [td - ta, .9], [td - ta + .5, .82], [3.0, .86], [endD - .1, .8], [endD + .35, 0]] }, endD + .4, { voiceA: ta, voiceD: td });
      cue(ta, 'whoosh', { dur: .5, peak: .08, v: .05, f0: 120, f1: 300, q: .6, rev: .4, seed: 120 }, .5);   // the shockwave of the first ring (felt more than heard)
      cue(ta + .06, 'beads', { dur: .5, v: .025 }, .5); cue(td, 'beads', { dur: 1.5, v: .02, seed: 3 }, 1.5); }
    // the dry choir under her note (B3 F#4 C#5); when she lifts to D5 its C#5 steps down to C#4, so the two never rub a semitone apart
    cue(66.0, 'choir', { notes: ['B3', 'F#4'], dur: 3.0, att: 2.2, rel: .45, v: .13, vow: 'ah' }, 3.5);
    cue(66.0, 'choir', { notes: ['C#5'], dur: 2.1, v: .092, vow: 'ah', env: [[0, 0], [1.4, .9], [1.45, .9], [2.1, 0]] }, 2.2);
    cue(67.35, 'choir', { notes: ['C#4'], dur: 1.65, att: .6, rel: .45, v: .092, vow: 'ah' }, 2.1);
    cue(67.5, 'glass', { notes: ['F#5', 'C#6'], dur: 1.5, att: 1.2, rel: .08, v: .05, trem: { rate: [[0, 6], [1.5, 16, 'e']], depth: [[0, .2], [1.5, .9]] } }, 1.6);
    if (has('tock')) cue(68.75, 'tock', { v: .03, tink: false, pan: .2 }, .1);
    // ---------------- bars 24-25, THE FALL and THE CURTAIN (69-75): the first full wet tutti; Tock's trill; villagers' felt drums.
    // P.H is the heart drop: it lets go at 69.0 (P.H.tr) and its D4 plink opens the fall.
    if (T0('tock') != null) { const e = EV.T.find(x => x.id === 'tock'); cue(e.t0, 'trill', { dur: 1.6, v: .07, pan: .2 }, 1.6, { tock: e.t0 }); }
    cue(69.0, 'choir', { notes: ['D3', 'A3', 'E4', 'F#4', 'D5'], nv: [1, .9, .8, .7, .55], dur: 6.0, att: .35, rel: 1.6, v: .21, vow: 'ah' }, 7.6);
    cue(69.0, 'sub', { n: 'D2', dur: 6.0, att: .25, rel: 1.5, v: .025 }, 7.5);
    cue(69.0, 'drum', { n: 'D2', v: .25, soft: true, rev: .5 }, 1.5);
    cue(P.H.tr, 'plink', { n: 'D4', v: .14 }, .1);
    [72.0, 73.5].forEach((t, j) => [[0, 'D2', -.4], [.025, 'D3', .3], [.05, 'D2', .55]].forEach(([dt, n, p], i) => cue(t + dt, 'drum', { n, v: .13 - .02 * i, soft: true, pan: p, rev: .35, seed: 130 + j * 3 + i }, 1.5)));
    cue(73.0, 'thud', { v: .22 }, .5);
    for (let i = 0; i < 14; i++) cue(72.05 + i * .2 + .12 * H(i, 8), 'splash', { v: .03 + .03 * H(i, 9), pan: pan(i + 90, .9), f: 2200 + 1800 * H(i, 1), seed: 140 + i }, .2);
    // ---------------- bars 26-27, GREEN FLOOD (75-81): the choir holds D; sprouts pop down the terraces (dry plucks:
    //                  nine waves of three, half a second apart)
    cue(74.4, 'choir', { notes: ['D3', 'A3', 'D4', 'E4'], nv: [1, .85, .7, .4], dur: 6.6, att: 1.2, rel: 1.4, v: .14, vow: 'oo' }, 8);
    cue(74.5, 'sub', { n: 'D2', dur: 6.5, att: 1.0, rel: 1.2, v: .02 }, 7.7);
    cue(75.2, 'rustle', { dur: .5, v: .02, f: 1100 }, .5); cue(75.8, 'flutter', { dur: .3, v: .03, rate: 22, pan: .25 }, .3); cue(75.85, 'sparkle', { dur: .4, v: .012, pan: .3, seed: 9 }, .4);
    { const POP = ['F#5', 'G#5', 'B5', 'C#6']; for (let k = 9; k >= 1; k--) { const t0 = 75.5 + .5 * (9 - k); for (let j = 0; j < 3; j++) { const i = k * 3 + j;
      cue(t0 + j * (.09 + .07 * H(i, 1)), 'kal', { n: POP[Math.floor(H(i, 2) * 4)], v: .07 + .04 * H(i, 3), pan: pan(i + 110, .8), lp: 7000, rev: .4 }, .1); } } }
    [76.2, 76.9, 77.6, 78.3, 79.0].forEach((t, i) => cue(t, 'glug', { v: .07, n: 3 + (i % 3), pan: -.5 + .25 * i, seed: i + 1 }, .4));
    if (!PLOPS) { cue(77.05, 'plip', { f: 680, v: .04, pan: .3 }, .1); cue(78.6, 'plip', { f: 600, v: .035, pan: -.2 }, .1); }
    // ---------------- bars 28-29, NOISE ALLOWED (81-87): the full theme in D Lydian; frogs, children, laughter.
    // The theme D5 E5 F#5 A5 | G#5 F#5 E5 D5 on the flute line, doubled an octave up by the music box; under it four
    // chords (Dadd9, E/D, Bm11, Dmaj9) on the choir, each with a bass note and a kalimba arpeggio of it an octave up.
    cue(81.0, 'line', { notes: [[0, 'D5'], [.75, 'E5'], [1.5, 'F#5'], [2.25, 'A5'], [3.0, 'G#5'], [3.75, 'F#5'], [4.5, 'E5'], [5.25, 'D5']], acc: [1, .85, .9, 1, .95, .85, .85, 1], end: 6.2, v: .075 }, 6.7);
    [[0, 'D5'], [.75, 'E5'], [1.5, 'F#5'], [2.25, 'A5'], [3.0, 'G#5'], [3.75, 'F#5'], [4.5, 'E5'], [5.25, 'D5']].forEach(([dt, n], i) => cue(81.0 + dt, 'mbox', { n: S.midi(n) + 12, v: .03, pan: .25, dec: 1.2, echo: 0 }, .1));
    [[81.0, ['D3', 'A3', 'E4', 'F#4'], 'D2'], [82.5, ['D3', 'B3', 'E4', 'G#4'], 'D2'], [84.0, ['B2', 'F#3', 'A3', 'D4', 'E4'], 'B1'], [85.5, ['D3', 'A3', 'C#4', 'E4', 'F#4'], 'D2']].forEach(([t, ch, b], i) => {
      cue(t - .15, 'choir', { notes: ch, dur: 1.6, att: .3, rel: i === 3 ? 1.8 : .5, v: .08, vow: 'oo' }, 2.4); cue(t, 'bass', { n: b, dur: 1.4, v: .035 }, 1.9);
      ch.slice(0, 4).forEach((n, j) => cue(t + .375 + j * E8, 'kal', { n: S.midi(n) + 12, v: .06, pan: -.3 + .2 * j, rev: .35 }, .1)); });
    // S16's ear: beside the hush-cloth, looking east along the crowd. near(list, pos, n): the n items closest to it.
    const CR = F.crowd, ear = P.add(P.cloth.pos, [-6, 1.2, -2]);
    const near = (list, pos, n) => list.map(x => ({ x, d: Math.hypot(pos(x)[0] - ear[0], pos(x)[2] - ear[2]) })).sort((a, b) => a.d - b.d).slice(0, n);
    const panOf = p => clamp(((p[0] - ear[0]) - (p[2] - ear[2])) / 16, -.85, .85);
    // the dripfrog chorus: life.js's chorus frogs swell every 1.5 s (two beats) from their own phase; heard by distance
    const CHORUS = LF && Array.isArray(LF.frogs) ? LF.frogs.map((f, i) => ({ f, i })).filter(x => x.f.chorus && x.f.pos) : [];
    if (has('frogs') && CHORUS.length) CHORUS.forEach(({ f, i }) => { const d = Math.hypot(f.pos[0] - ear[0], f.pos[2] - ear[2]), k = 1 / (1 + d / 6);
      for (let t = 81 - 1.5 * (f.seed || 0); t < 87.2; t += 1.5) { if (t < 80.7) continue; cue(t, 'frog', { n: 'D3', dur: .85, v: .05 * k * (t < 81.2 ? .5 : 1), pan: panOf(f.pos), flutter: 22 + 8 * (f.seed || 0),
        amp: [[0, 0], [.1, .45], [.42, 1], [.7, .55], [.85, 0]], ip: [[0, 1.2], [.45, 3.1], [.85, 1.5]] }, .9); } });
    else if (has('frogs')) [81.2, 81.6, 82.1, 82.9, 83.45, 84.4, 85.1, 85.9, 86.45].forEach((t, i) => cue(t, 'frog', { n: 'D3', dur: .22 + .3 * H(i, 4), v: .045 + .02 * H(i, 5), pan: pan(i + 130, .9), flutter: 22 + 8 * H(i, 6) }, .6));
    // the villagers' laughs and puddle stomps: film/crowd.js's own plan when present (so each laugh is heard as it is drawn),
    // else a few fixed ones. Only the 16 laughs and 12 stomps nearest the ear, quieter with distance. Children yip; every
    // laugh shakes a little sparkle of afterhang mist down (BIBLE.md M13).
    if (has('laughs') && CR && Array.isArray(CR.laughs) && CR.laughs.length) {
      near(CR.laughs.filter(l => l.t0 > 75 && l.t0 < 87.5 && l.head), l => l.head, 16).forEach(({ x: l, d }, i) => { const k = 1 / (1 + d / 9), p = panOf(l.head);
        if (l.kid) { cue(l.t0, 'yip', { n: ['B5', 'C#6', 'G#5', 'B5'][i % 4], v: .032 * k, pan: p }, .2); if ((l.dur || 0) > .6) cue(l.t0 + .3, 'laugh', { n0: 'C#5', n1: 'G#4', syl: 4, rate: 8, v: .03 * k, child: true, pan: p, seed: 30 + i }, .3); }
        else cue(l.t0, 'laugh', { n0: ['C#4', 'E4', 'B3'][i % 3], n1: ['A3', 'C#4', 'G#3'][i % 3], syl: clamp(Math.round((l.dur || .8) * 6), 3, 8), v: .045 * k, pan: p, seed: i + 1 }, .3);
        cue(l.t0 + .25, 'sparkle', { dur: 1.0, v: .012 * k, pan: p, seed: 70 + i }, 1); }); }
    else if (has('laughs')) { [81.4, 82.25, 83.05, 85.3].forEach((t, i) => cue(t, 'yip', { n: ['B5', 'C#6', 'A5', 'B5'][i], v: .03, pan: pan(i + 150, .8) }, .2));
      [[81.85, 'C#4', 'A3', 6, .045, -.5], [83.2, 'E4', 'C#4', 5, .04, .45], [86.0, 'B4', 'G#4', 5, .035, -.2]].forEach(([t, n0, n1, syl, v, p], i) => { cue(t, 'laugh', { n0, n1, syl, v, pan: p, seed: i + 1 }, .2); cue(t + .25, 'sparkle', { dur: 1.0, v: .01, pan: p, seed: 70 + i }, 1); }); }
    // Pell laughs out loud at 84.0 and a sparkle shower forms over her own head
    cue(84.0, 'laugh', { n0: 'E5', n1: 'B4', syl: 7, rate: 7, v: .065, child: true, pan: .05, seed: 9, echo: .1 }, .3); cue(84.25, 'sparkle', { dur: 1.3, v: .02, pan: .05, seed: 80 }, 1.3);
    if (has('stomps') && CR && Array.isArray(CR.stomps) && CR.stomps.length)
      near(CR.stomps.filter(s => s.t > 75 && s.t < 87.5 && s.pos), s => s.pos, 12).forEach(({ x: s, d }, i) => cue(s.t, 'stomp', { v: .055 / (1 + d / 10), pan: panOf(s.pos), seed: 180 + i }, .2));
    else if (has('stomps')) [81.3, 81.65, 82.45, 83.6, 85.05].forEach((t, i) => cue(t, 'stomp', { v: .05, pan: pan(i + 170, .8), seed: 180 + i }, .2));
    cue(82.5, 'rustle', { dur: .6, v: .02, f: 1000, pan: -.1 }, .6); cue(83.25, 'tap', { v: .02, pan: -.1, seed: 9 }, .1);
    cue(84.75, 'shimmer', { notes: ['D6', 'E6', 'F#6', 'A6', 'C#7', 'D7', 'E7'], v: .035, gap: .06 }, 1.2);
    if (has('chimewings') && !WINGS) for (let i = 0; i < 9; i++) { const t = 83.4 + i * .33 + .15 * H(i, 11); cue(t, 'wing', { v: .025, pan: pan(i + 190, .9) }, .3); cue(t + .05, 'sparkle', { dur: .7, v: .006, pan: pan(i + 190, .9), seed: 90 + i }, .7); }
    // ---------------- bars 30-31, DUSK (87-93): the music box remembers the hush motif; her hum; the palm drop; D, last.
    // The palm toll (88.5, D4 held) lets the drop above her palm go (about 90.0): A5 as it lets go, E5 half-way down,
    // D5 (with D6, a soft D chord and the sub) as it lands on her palm (about 90.3).
    // the dusk pad stays dry (B F# C#) and is voiced round her hum D4: B3 a third under it, C#5 a seventh over it, no semitone rub
    cue(86.9, 'pad', { notes: ['B2', 'F#3', 'B3', 'C#5'], nv: [1, .9, .75, .35], dur: 3.4, att: 1.8, rel: .6, v: .12, cut: 900 }, 4);
    if (has('frogs')) cue(87.3, 'frog', { n: 'D3', dur: .35, v: .018, pan: -.7, flutter: 24 }, .4);
    [[87.375, 'B5', .1], [87.75, 'C#6', .09], [88.125, 'F#5', .11], [88.875, 'B5', .05], [89.25, 'C#6', .045]].forEach(([t, n, v], i) => cue(t, 'mbox', { n, v, pan: .15 }, .1));
    if (T0('palm') != null) { const e = EV.T.find(x => x.id === 'palm'); cue(e.t0, 'voice', { mode: 'hum', notes: [[0, e.note]], end: e.dur, v: .05, echo: .55, rev: .4, pan: -.05,
        amp: [[0, 0], [.15, 1], [e.dur - .2, .85], [e.dur + .25, 0]] }, e.dur + .3, { palm: e.t0 });
      const sp = P.special.palm, tr = EV.releaseTime(sp.pos, 0, 0, 0, sp.since ?? -1), land = tr < LEN ? tr + EV.hitTau(sp.pos[1] - P.palmPos[1], 0) : 90.3;
      if (tr < LEN) { cue(tr, 'plink', { n: 'D5', v: .06 }, .1); cue(tr, 'mbox', { n: 'A5', v: .08, pan: .1 }, .1); cue((tr + land) / 2, 'mbox', { n: 'E5', v: .08, pan: .05 }, .1); }
      cue(land, 'plip', { f: 880, v: .05 }, .1); cue(land, 'mbox', { n: 'D5', v: .12, dec: 2.6 }, .1); cue(land, 'mbox', { n: 'D6', v: .04, dec: 2.0, pan: -.2 }, .1);
      cue(land, 'choir', { notes: ['D3', 'A3', 'F#4'], dur: 1.6, att: .5, rel: 1.1, v: .075, vow: 'oo' }, 2.8); cue(land, 'sub', { n: 'D2', dur: 1.6, att: .6, rel: 1.0, v: .025 }, 2.7); }
    [88.0, 91.2, 92.0].forEach((t, i) => cue(t, 'plip', { f: 1000 + 200 * i, v: .018, pan: pan(i + 210, .6), rev: .5 }, .1));   // mirror ripples

    // ---------------- release plinks of the field, from the release math. Per toll at most 60 (30 for the cupola bells,
    // Pell's bell and Tock, whose tolls come close together), picked evenly along the list sorted by distance, so near
    // and far drops are both heard. Level falls with distance (1 / (1 + d / 7)); far ones are duller (a.far).
    // NOTE: the note a drop rings as it lets go: its band's wet note, an octave lower for a big drop
    // (heavy D4 / D5, marble A5 / A6, mist E7)
    const NOTE = (band, size) => band === 0 ? (size > .33 ? 'D4' : 'D5') : band === 1 ? (size > .04 ? 'A5' : 'A6') : 'E7';
    let plinks = 0;
    for (const [key, list] of Object.entries(an.groups)) { list.sort((x, y) => x.d - y.d); const n = Math.min(list.length, key === 'cupola' || key === 'tock' || key === 'bell' ? 30 : 60);
      for (let j = 0; j < n; j++) { const it = list[Math.floor(j * list.length / n)], base = it.band === 0 ? .26 : it.band === 1 ? .19 : .05;
        const p = clamp(((it.p[0] - it.s[0]) - (it.p[2] - it.s[2])) / 25, -.85, .85);
        cue(it.tr, 'plink', { n: NOTE(it.band, it.size), v: base / (1 + it.d / 7), pan: p, far: clamp(it.d / 30) }, .1); plinks++; } }
    // other modules' micro emitters (FILM.music.add); a cue naming an unknown instrument is dropped
    for (const list of Object.values(EXTRA)) for (const c of list) if (INST[c.k]) cue(c.t, c.k, c.a || {}, c.d || .5, c.tolls);
    C.sort((x, y) => x.t - y.t); C.plinks = plinks; return C;
  }

  // ============================================================================================================
  // 7. Lanes: control curves over film time (wind, gust, rain beds, music level, reverb, echo, master). [[t, v], ...]
  //    The scheduler turns each point into a linear ramp on the lane's AudioParams (the table T in makeDesk).
  //    Levels are linear gains; windF and gustF are filter frequencies in Hz; echoFb is the echo's feedback.
  // ============================================================================================================
  function buildLanes(an) {
    // grid: sample fn every 0.1 s, plus the `extra` times, so a sharp edge (a cut, a gate) lands exactly where it should
    const grid = (fn, extra = []) => { const ts = new Set(extra.map(x => +x.toFixed(3))); for (let i = 0; i <= LEN * 10 + 5; i++) ts.add(+(i / 10).toFixed(3)); return [...ts].sort((a, b) => a - b).map(t => [t, fn(t)]); };
    // wind level by hand (the hush is breezy, the run windier, 57.05-59.5 silent), made to breathe by slow sines;
    // windF: the wind band's centre wanders round 420 Hz and rises 40 % during the run; windHi: the thin whistle
    const WIND = [[0, 0], [.6, 0], [4, .06], [6, .07], [12, .065], [12.3, .04], [18, .04], [18.3, .05], [24, .05], [24.3, .04], [33, .05], [36, .06], [42, .075], [48, .09], [56.95, .09], [57.05, 0],
      [59.5, 0], [60.6, .028], [66, .03], [69, .04], [72, .05], [75, .035], [81, .025], [87, .04], [92.25, .04], [93, 0]];
    const wa = pw(WIND), wind = t => wa(t) * (1 + .35 * Math.sin(TAU * .11 * t) * Math.sin(TAU * .037 * t + 1) + .12 * Math.sin(TAU * .53 * t + 2));
    const windF = t => (420 + 150 * Math.sin(TAU * .07 * t) + 80 * Math.sin(TAU * .19 * t + 2)) * (t > 42 && t < 57 ? 1.4 : 1);
    const windHi = pw([[0, 0], [5, 0], [7, .006], [12, .004], [42, .004], [44, .012], [56.95, .014], [57.05, 0], [60.5, 0], [61.5, .004], [66, .004], [87, 0], [88.5, .005], [92.3, .005], [93, 0]]);
    // the gust's strength: path.js's own gust envelope (36-41 s, the same one that pushes the rain field), plus rushes
    const gustK = t => { let g = .5 * P.gust(t) * (1 - sm(40.5, 45, t));
      g += .32 * sm(36, 36.25, t) * (1 - sm(36.35, 36.9, t));                               // the whip-pan rush
      if (t >= 69 && t < 72) g += .3 * sm(69.0, 70.4, t) * (1 - sm(71.96, 72.0, t));       // falling: air rushing past her, cut with the picture
      if (t > 42 && t < 46.5) g += .05;                                                     // the run along the rim
      return g; };
    // the rain's hard gates: no rain bed from the crack to the end of Ma (56.95-66.05), and a fade over the last 0.75 s
    const gate = t => (t > 56.95 && t < 66.05 ? 0 : 1) * (t > 92.25 ? 1 - sm(92.25, 93, t) : 1);
    // the rain curves with each shot's trim, then a 0.5 s release so a cut to a drier shot lets the rain thin out instead of
    // switching off (the silence at 57 and the end are hard gates applied after this)
    const trim = (t, b) => (RTRIM[S.shotAt(t).id] || [1, 1, 1])[b], kR = Math.exp(-.1 / .5);
    const RC = an.curve.map((L, b) => { const o = new Float32Array(an.NB); let y = 0; for (let i = 0; i < an.NB; i++) { y = Math.max(L[i] * trim(i / 10, b), y * kR); o[i] = y; } return o; });
    // the rain curve of band b at any time t (linear between the 0.1 s bins); cutT: extra grid times at the cuts and gates
    const rAt = (b, t) => { const x = clamp(t * 10, 0, an.NB - 1), i = Math.floor(x), k = x - i; return RC[b][i] * (1 - k) + RC[b][Math.min(an.NB - 1, i + 1)] * k; };
    const cutT = S.SHOTS.map(s => s.t0).concat([56.95, 57.0, 66.05, 92.25]);
    // The cut at 57.0 (the crack): the music and the world drop to 0 within 15 ms, the reverb and echo returns (and the
    // echo's feedback) 0.1 s later, so only the crack itself (bus 'x') and a sliver of its tail are heard. The world
    // comes back at 58.5, the echo at 59.5, the music at 60.05 and the reverb by 60.4. The master fades out over 92.25-93.
    return {
      wind: grid(wind, WIND.map(x => x[0])), windF: grid(windF), windHi: grid(windHi), gust: grid(t => gustK(t) * .4, [36, 36.25, 36.35, 71.96, 72.0]), gustF: grid(t => 220 + 1500 * clamp(gustK(t) * 1.6)),
      rainH: grid(t => .22 * rAt(0, t) * gate(t), cutT), rumble: grid(t => .13 * rAt(0, t) * gate(t), cutT),
      rainM: grid(t => .28 * rAt(1, t) * gate(t), cutT), rainS: grid(t => .18 * rAt(2, t) * gate(t), cutT),
      mus: [[0, 1], [57.0, 1], [57.015, 0], [60, 0], [60.05, 1], [LEN + 1, 1]], sfx: [[0, 1], [56.995, 1], [57.008, 0], [58.4, 0], [58.5, 1], [LEN + 1, 1]],
      rev: [[0, 1], [57.06, 1], [57.14, 0], [59.6, 0], [60.4, 1], [LEN + 1, 1]],
      echo: [[0, 1], [57.06, 1], [57.12, 0], [59.4, 0], [59.6, 1], [LEN + 1, 1]], echoFb: [[0, .28], [57.06, .28], [57.1, 0], [59.4, 0], [59.5, .28], [LEN + 1, .28]],
      master: [[0, 1], [92.25, 1], [93.0, 0], [LEN + 1, 0]],
    };
  }

  // the analysis, the cue sheet and the lanes, made once and cached (0.15-0.4 s of main-thread work; done in idle time)
  function prepare() {
    if (PREP) return PREP; const t0 = performance.now(), an = analyse(), cues = buildCues(an), lanes = buildLanes(an);
    let maxD = 0; for (const c of cues) maxD = Math.max(maxD, c.d);
    PREP = { cues, lanes, an, maxD, ms: performance.now() - t0 };
    stats.prepMs = Math.round(PREP.ms); stats.cues = cues.length; stats.plinks = cues.plinks; stats.drops = an.drops; stats.released = an.released; stats.releaseMismatch = an.mismatch;
    return PREP;
  }

  // ============================================================================================================
  // 8. The scheduler. Film time T <-> context time: ctx = base + (T - filmBase). A lookahead of ~180 ms (2.5 s while
  //    the tab is hidden, since browsers slow its timers down to about once a second) on a 25 ms timer driven by the
  //    audio clock. The audio clock is the master: main.js asks clock() for film time and draws that frame.
  // ============================================================================================================
  // stats: measurements for tools/listen.mjs and the console. L: the live player { ctx, desk, started, paused, timer }.
  // pendingT: the film time of the last seek before start().
  const stats = {}; let L = null, muted = false, pendingT = 0;
  const ctxT = (D, t) => D.base + (t - D.filmBase);
  // play one cue; a failing instrument logs an error and the rest of the score carries on
  function play(D, c, when, off) { const f = INST[c.k]; if (!f || (D.kinds && !D.kinds.has(c.k))) return; try { f(D, when, off, c.a); } catch (e) { console.error('music ' + c.k + ' @' + c.t.toFixed(2) + ': ' + (e && e.message)); } }
  // play every cue that starts before film time `until`; one whose start has already passed is joined `off` s late
  function schedule(D, until) {
    const C = PREP.cues, now = D.ctx.currentTime;
    while (D.ci < C.length && C[D.ci].t < until) { const c = C[D.ci++]; let w = ctxT(D, c.t), off = 0; if (w < now) { off = now - w; w = now; } play(D, c, w, off); }
  }
  // queue each lane's points up to film time `until` as linear ramps (points already in the past are skipped)
  function lanesTo(D, until) { for (const ln of D.lanes) { while (ln.i < ln.pts.length && ln.pts[ln.i][0] <= until) { const [t, v] = ln.pts[ln.i++]; const w = ctxT(D, t); if (w < D.ctx.currentTime) continue; for (const p of ln.params) p.linearRampToValueAtTime(v, w); } } }
  const laneAt = (pts, t) => envAt(pts, t);
  // jump to film time T: retire the old generation, start a new one, rejoin every cue still sounding at T, and move each
  // lane to its value at T (live: a 60 ms ramp from where it is, so nothing clicks; offline: at once)
  function seekTo(D, T, fade) {
    const now = D.ctx.currentTime; killGen(D); newGen(D, fade);
    D.filmBase = T; D.base = now + (D.live ? .06 : 0);
    const C = PREP.cues; let i = 0; while (i < C.length && C[i].t < T) i++;
    for (let j = 0; j < i; j++) { const c = C[j]; if (c.t + c.d > T) play(D, c, D.base, T - c.t); }   // sounds already under way join in the middle
    D.ci = i;
    for (const ln of D.lanes) { const v = laneAt(ln.pts, T); for (const p of ln.params) { p.cancelScheduledValues(now); p.setValueAtTime(D.live ? p.value : v, now); p.linearRampToValueAtTime(v, D.base + (D.live ? 0 : 0)); }
      let k = 0; while (k < ln.pts.length && ln.pts[k][0] <= T) k++; ln.i = k; }
  }
  // every 25 ms: schedule cues up to the lookahead and lanes 0.12 s beyond it, and forget sources that have finished
  function tick() {
    if (!L || !L.started || L.paused) return; const D = L.desk, now = D.ctx.currentTime, T = D.filmBase + (now - D.base), until = T + (document.hidden ? 2.5 : .18);
    schedule(D, until); lanesTo(D, until + .12);
    if (D.srcs.length > 400) D.srcs = D.srcs.filter(x => x[1] > now - .2);
  }
  // where to start playing: the picture's own film time (FILM.dev.T from main.js), else the last seek
  const curT = () => (F.dev && typeof F.dev.T === 'number' ? F.dev.T : pendingT);

  F.music = {
    // the first call (inside a click or key press, as browsers require) makes the context (48 kHz when allowed), the
    // cue sheet and the desk, then starts the 25 ms timer; later calls only resume a suspended context
    start() {
      if (!L) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; const t0 = performance.now(); let ctx; try { ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 }); } catch (e) { ctx = new AC({ latencyHint: 'interactive' }); }
        const t1 = performance.now(); prepare(); const t2 = performance.now(); L = { ctx, desk: makeDesk(ctx, true), started: false, paused: false };
        stats.startMs = Math.round(performance.now() - t0); stats.startParts = { ctx: Math.round(t1 - t0), prepare: Math.round(t2 - t1), desk: Math.round(performance.now() - t2), deskParts: L.desk.parts };
        stats.buffersMs = Math.round(L.desk.B.ms); stats.sampleRate = ctx.sampleRate; }
      if (L.ctx.state !== 'running' && !L.paused) L.ctx.resume();
      if (!L.started) { L.started = true; seekTo(L.desk, curT(), true); L.timer = setInterval(tick, 25); tick(); }
    },
    pause(p) { if (!L) return; L.paused = !!p; if (p) L.ctx.suspend(); else L.ctx.resume(); },
    seek(t) { pendingT = t; if (L && L.started) { seekTo(L.desk, t, true); tick(); } },
    // film time as heard: the context clock minus the output latency, so the picture matches what reaches the speakers
    clock() { if (!L || !L.started || L.paused || L.ctx.state !== 'running') return null; const D = L.desk, lat = L.ctx.outputLatency || L.ctx.baseLatency || 0;
      return D.filmBase + Math.max(0, L.ctx.currentTime - D.base - lat); },
    mute() { muted = !muted; if (L) L.desk.muteG.gain.setTargetAtTime(muted ? 0 : 1, L.ctx.currentTime, .03); return muted; },
    // the whole score (or a part of it) rendered sample-exact: for recordings and for tools/listen.mjs
    //   opts.only 'beds' | 'mus' | 'sfx' renders one stem; opts.kinds ['voice', 'choir'] plays only those instruments (beds still follow opts.only)
    //   An OfflineAudioContext has no timers, so the render suspends itself every 2 s of audio and schedules the next
    //   3 s each time, which keeps the number of live nodes small.
    async offline(sr = 48000, from = 0, dur = LEN - from, opts = {}) {
      prepare(); const n = Math.max(128, Math.round(dur * sr)), ctx = new OfflineAudioContext(2, n, sr), t0 = performance.now(), D = makeDesk(ctx, false, opts || {});
      stats.offlineBuildMs = Math.round(performance.now() - t0); stats.buffers = D.B.timing;
      seekTo(D, from, false); lanesTo(D, from + dur + 1); schedule(D, from + 3);
      const STEP = 2; for (let k = 1; k * STEP < dur - .2; k++) { const s = k * STEP; ctx.suspend(s).then(() => { schedule(D, from + s + 3); ctx.resume(); }); }
      return ctx.startRendering();
    },
    // other modules' micro emitters: FILM.music.add('chimewings', [{t, k: 'wing', a: {v, pan}}]) replaces the default group
    // (chimewings, frogs, laughs, stomps, tock, pellsteps); any other name just adds its cues. Call it while the film
    // loads, before start(): it throws away the prepared cue sheet, which a running scheduler reads.
    add(group, list) { EXTRA[group] = list; PREP = null; },
    // every toll of FILM.events.T must have a sound starting at its t0 (within 1 ms); tools/listen.mjs prints this
    check() { const C = prepare().cues, miss = [], off = [];
      for (const e of EV.T) { const c = C.find(x => x.tolls && e.id in x.tolls); if (!c) miss.push(e.id); else if (Math.abs(c.tolls[e.id] - e.t0) > .001) off.push([e.id, +(c.tolls[e.id] - e.t0).toFixed(4)]); }
      return { ok: !miss.length && !off.length, miss, off, tolls: EV.T.length }; },
    // how much rain the ear hears falling now, per band 0..1 [heavy, marble, mist], before the per-shot trims (other
    // modules may follow it)
    rainAt(t) { const an = prepare().an, i = clamp(Math.round(t * 10), 0, an.NB - 1); return [an.curve[0][i], an.curve[1][i], an.curve[2][i]]; },
    get CUES() { return prepare().cues; }, get lanes() { return prepare().lanes; },
    get voice() { return VOICE; }, set voice(v) { VOICE = v === 'ocarina' ? 'ocarina' : 'formant'; },
    get state() { return L ? { ctx: L.ctx.state, started: L.started, paused: L.paused, T: L.started ? L.desk.filmBase + (L.ctx.currentTime - L.desk.base) : null } : null; },
    stats, INST,
  };
  // The analysis and the 48 kHz buffers are made in idle moments once the film has loaded, one job per idle slice, so
  // start() only has to build the graph. (If the viewer clicks before they are done, start() finishes them at once.)
  // idle() waits for FILM.ready, starts the buffer worker, then runs prepare() in requestIdleCallback slices.
  const idle = () => { if (!F.ready) return setTimeout(idle, 300); const ric = window.requestIdleCallback || (f => setTimeout(() => f(null), 30));
    warm(48000);
    const jobs = [() => prepare()], a = performance.now(); let busy = 0;
    const run = dl => { try { do { const j = jobs.shift(); const b = performance.now(); j(); busy += performance.now() - b; } while (jobs.length && dl && dl.timeRemaining() > 10); }
      catch (e) { console.error('music prepare: ' + (e && e.stack || e)); jobs.length = 0; }
      if (jobs.length) ric(run, { timeout: 1000 }); else { stats.idleMs = Math.round(busy); stats.idleSpanMs = Math.round(performance.now() - a); } };
    ric(run, { timeout: 2000 });
    // if the worker could not run (or is slow), make what is still missing here, one buffer per idle slice
    setTimeout(() => { if (worker === 'done') return; BUF_KEYS.forEach(k => jobs.push(() => bufStep(48000, k))); ric(run, { timeout: 1000 }); }, worker === false ? 0 : 6000); };
  setTimeout(idle, 500);
})();
