// listen.mjs - render the film's sound offline in headless Chrome and look at it with numbers. Node built-ins only
// (Node 22 or newer, for the global fetch and WebSocket). Chrome or Edge must be installed (or pass --chrome).
// It does for the ear what tools/shot.mjs does for the eye: it loads a built page with ?shots (no loading screen, the
// picture held still), calls FILM.music.offline(sampleRate, from, dur) inside the page (music/synth.js), pulls the
// samples back over the DevTools protocol, writes a 16-bit stereo WAV and prints what is in it.
// The page defaults to index.html; any build works, e.g. one made with  python tools/build.py --out build/sound.html
//
//   node tools/listen.mjs                                                           the whole film -> build/listen.wav
//   node tools/listen.mjs --page build/sound.html                                   the same, from another build
//   node tools/listen.mjs --page build/sound.html --from 64 --dur 8 --out build/voice.wav --fft 66.5,68.5 --clicks
//   node tools/listen.mjs --page build/sound.html --spec build/full.png              + a spectrogram (ffmpeg on PATH)
//   node tools/listen.mjs --page build/sound.html --live [--wait 3000]               start the live context, seek, read the clock
//   node tools/listen.mjs --page build/sound.html --stem mus --out build/mus.wav     one stem: beds | mus | sfx
//   node tools/listen.mjs --page build/sound.html --kinds voice,choir --from 64 --dur 8   only those instruments
//   node tools/listen.mjs --page build/sound.html --expect 27,30,33,57,66,67.5,69,90.3  is there an onset at each of these times?
// Prints one JSON line: load and render time, FILM.music.stats, the toll check (FILM.music.check()), the overall peak,
// integrated loudness (BS.1770 K-weighted, gated; 48 kHz), clicks (sample discontinuities, with the nearest cue), spectra,
// onsets; then a table of RMS / peak per second in dBFS (and the band table with --bands).
//   options: --page <html> (index.html)  --out <wav> (build/listen.wav)  --from <s> (0)  --dur <s> (to the end)
//            --fft t1,t2  spectra at these film times   --stem beds|mus|sfx   --kinds a,b   --expect t1,t2   --live [--wait ms]
//            --sr 48000  --chrome <path>  --size 1280x720  --eval "js run before rendering"  --quiet (no table)
//            spectrogram: --spec-size 1600x600  --spec-fscale lin|log  --spec-start <Hz>  --spec-stop <Hz>  --spec-drange <dB>
//            --onsets N  print the N strongest onsets (spectral flux, 5 ms hop)   --bands  spectral balance per second   --clicks  find discontinuities
// All analysis runs here in Node on the WAV's samples; every time printed is film time (--from is added back).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join, resolve, dirname } from 'node:path'; import { pathToFileURL, fileURLToPath } from 'node:url';

// ---- options. arg('x', default) reads "--x value"; flag('x') is true when "--x" is present.
// --page resolves from the project root; --out and --spec from the current folder.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes('--' + k);
// where to look for a browser: $CHROME first, then the usual install places on Windows, macOS and Linux
const CANDIDATES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = arg('chrome') || CANDIDATES.find(p => existsSync(p));
const page = resolve(ROOT, arg('page', 'index.html'));
const [PW, PH] = arg('size', '1280x720').split('x').map(Number);
const SR = +arg('sr', 48000), FROM = +arg('from', 0), DUR = arg('dur') != null ? +arg('dur') : null;
const out = resolve(arg('out', 'build/listen.wav')); mkdirSync(dirname(out), { recursive: true });
const pre = arg('eval', ''), specOut = arg('spec'), ffts = (arg('fft', '') || '').split(',').filter(Boolean).map(Number);
const stem = arg('stem', null), kinds = arg('kinds') ? arg('kinds').split(',').filter(Boolean) : null;
const expect = (arg('expect', '') || '').split(',').filter(Boolean).map(Number), nOnsets = +arg('onsets', expect.length ? 30 : 0);   // --expect needs onsets

// ---- Chrome over the DevTools protocol (the same approach as tools/shot.mjs)
// A throwaway profile; port 0 lets Chrome pick a free port and print it. The autoplay flag lets the live mode start an
// AudioContext without a click; the two 'background' flags keep timers at full speed in a headless window.
const prof = mkdtempSync(join(tmpdir(), 'film-listen-'));
const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, `--window-size=${PW},${PH}`, '--hide-scrollbars', '--ignore-gpu-blocklist',
  '--use-angle=d3d11', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank']);
const fail = m => { console.error(m); try { ch.kill(); } catch { } process.exit(1); };
const wsUrl = await new Promise((res, rej) => { let buf = ''; ch.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); }); setTimeout(() => rej(new Error('Chrome did not start')), 20000); }).catch(e => fail(e.message));
// find the page target and talk to it: send(method, params) -> the reply; ev(expr) evaluates in the page (awaiting
// promises) and returns the value. Page exceptions, console errors and warnings are collected in `logs`.
const port = new URL(wsUrl).port;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(), logs = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 500));
  else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) logs.push(m.params.type + ' ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400)); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr, timeout = 900000) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result?.result?.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// load the page and wait (up to 3 minutes) for the film to finish building (FILM.ready)
await send('Runtime.enable'); await send('Page.enable');
const t0 = Date.now(); await send('Page.navigate', { url: pathToFileURL(page).href + '?shots' });
for (;;) { const ok = await ev('!!(window.FILM && FILM.ready)').catch(() => false); if (ok) break; if (Date.now() - t0 > 180000) fail(JSON.stringify({ error: 'timeout waiting for FILM.ready', logs })); await sleep(200); }
const loadMs = Date.now() - t0;
if (pre) await ev(pre);
// done(code): close Chrome, delete the profile and exit a moment later (the script itself does not stop at a done() call)
// done() never resolves: `await done(n)` closes Chrome, cleans up and waits for process.exit, so nothing after it runs
const done = code => { ws.close(); ch.kill(); setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch { } process.exit(code); }, 400); return new Promise(() => { }); };
if (!(await ev('!!(window.FILM && FILM.music)'))) { console.log(JSON.stringify({ error: 'FILM.music is missing', logs })); await done(1); }

// ---- live mode: the real AudioContext (no gesture needed with the autoplay flag): start, read the clock, seek, pause
// The script: start; 1.5 s later the clock should read about 1.5; seek to 66 and 1.2 s later it should read about 67.2;
// while paused clock() is null; resume; mute twice ([true, false]); seek to 56.5 and play through the crack at 57.0;
// then the toll check. Prints one JSON object (no WAV).
if (flag('live')) {
  const r = {}; await sleep(+arg('wait', 0));   // --wait ms: let the page sit (as a viewer would) before the click that starts the sound
  r.start = await ev(`(() => { const t = performance.now(); FILM.music.start(); return { ms: +(performance.now() - t).toFixed(1), state: FILM.music.state, stats: FILM.music.stats }; })()`);
  await sleep(1500); r.clock1 = await ev('FILM.music.clock()');
  r.seek = await ev('(() => { FILM.music.seek(66); return FILM.music.state; })()'); await sleep(1200); r.clock2 = await ev('FILM.music.clock()');
  await ev('FILM.music.pause(true)'); await sleep(400); r.paused = await ev('[FILM.music.clock(), FILM.music.state]');
  await ev('FILM.music.pause(false)'); await sleep(600); r.resumed = await ev('FILM.music.clock()');
  r.mute = await ev('[FILM.music.mute(), FILM.music.mute()]');
  await ev('FILM.music.seek(56.5)'); await sleep(1300); r.afterCrack = await ev('FILM.music.clock()');
  r.check = await ev('FILM.music.check()');
  console.log(JSON.stringify({ live: r, loadMs, logs: logs.slice(0, 20) }, null, 1)); await done(0);
}

// ---- render offline in the page, then pull the 16-bit PCM over in chunks
// The page converts to interleaved 16-bit (clipped to +-1) and keeps it in window.__pcm; Node then fetches it 3 MB at a
// time as base64 (one DevTools reply cannot carry the whole film) and writes a 44-byte RIFF / PCM header in front.
const dur = DUR ?? (await ev('FILM.score.LEN')) - FROM;
const info = await ev(`(async () => { const t = performance.now(); const b = await FILM.music.offline(${SR}, ${FROM}, ${dur}, ${JSON.stringify({ only: stem, kinds })}); const ms = performance.now() - t;
  const L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : L, n = b.length, pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) { pcm[2 * i] = Math.round(Math.max(-1, Math.min(1, L[i])) * 32767); pcm[2 * i + 1] = Math.round(Math.max(-1, Math.min(1, R[i])) * 32767); }
  window.__pcm = new Uint8Array(pcm.buffer);
  return { renderMs: Math.round(ms), n, sr: b.sampleRate, stats: FILM.music.stats, check: FILM.music.check(), cues: FILM.music.CUES.map(c => [+c.t.toFixed(3), c.k]) }; })()`);
const CH = 3 << 20, total = info.n * 4, parts = [];
for (let o = 0; o < total; o += CH) parts.push(Buffer.from(await ev(`(() => { const u = window.__pcm.subarray(${o}, ${Math.min(total, o + CH)}); let s = ''; for (let k = 0; k < u.length; k += 0x8000) s += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000)); return btoa(s); })()`), 'base64'));
const pcm = Buffer.concat(parts), hdr = Buffer.alloc(44);
hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22);
hdr.writeUInt32LE(info.sr, 24); hdr.writeUInt32LE(info.sr * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
writeFileSync(out, Buffer.concat([hdr, pcm]));
done.later = true;

// ---- numbers (read back from the 16-bit samples, exactly what the WAV holds)
const n = info.n, sr = info.sr, L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { L[i] = pcm.readInt16LE(4 * i) / 32768; R[i] = pcm.readInt16LE(4 * i + 2) / 32768; }
const db = x => x > 0 ? +(20 * Math.log10(x)).toFixed(1) : -Infinity;
// per second: [film time, RMS of both channels, peak], in dBFS (0 dBFS = full scale)
const secs = [];
for (let s = 0; s * sr < n; s++) { let ss = 0, pk = 0, c = 0; for (let i = s * sr; i < Math.min(n, (s + 1) * sr); i++) { ss += L[i] * L[i] + R[i] * R[i]; pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); c += 2; } secs.push([+(FROM + s).toFixed(2), db(Math.sqrt(ss / c)), db(pk)]); }
let peak = 0, peakAt = 0; for (let i = 0; i < n; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > peak) { peak = a; peakAt = i; } }
// BS.1770 loudness (K-weighting coefficients are for 48 kHz)
//   kw: the K-weighting filter, two biquads in a row: a high shelf (+4 dB above ~1.5 kHz, the head's effect) and a
//   high-pass near 38 Hz. Then 400 ms blocks every 100 ms, the mean square of L + R per block, an absolute gate at
//   -70 LUFS and a relative gate 10 LU under the mean of what passed; lufs is the mean of the rest. momentaryMaxLufs is
//   the loudest single block.
function kw(x) { const y = new Float32Array(x.length); const st = [[1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, .73248077421585], [1, -2, 1, -1.99004745483398, .99007225036621]];
  let v = x; for (const [b0, b1, b2, a1, a2] of st) { const o = new Float32Array(v.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < v.length; i++) { const yy = b0 * v[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v[i]; y2 = y1; y1 = yy; o[i] = yy; } v = o; } return v; }
const KL = kw(L), KR = kw(R), blk = Math.round(.4 * sr), hop = Math.round(.1 * sr), z = [];
for (let s = 0; s + blk <= n; s += hop) { let a = 0, b = 0; for (let i = s; i < s + blk; i++) { a += KL[i] * KL[i]; b += KR[i] * KR[i]; } z.push((a + b) / blk); }
const lk = v => -.691 + 10 * Math.log10(v);
const za = z.filter(v => lk(v) > -70), rel = za.length ? lk(za.reduce((s, v) => s + v, 0) / za.length) - 10 : -70, zg = za.filter(v => lk(v) > rel);
const lufs = zg.length ? +lk(zg.reduce((s, v) => s + v, 0) / zg.length).toFixed(1) : -Infinity, momMax = z.length ? +lk(Math.max(...z)).toFixed(1) : -Infinity;
// clicks: an isolated spike in the second difference, far above the signal's own high-frequency level just before it.
//   d2 = |x[i] - 2 x[i-1] + x[i-2]| is large where the waveform bends sharply; e is its running mean square over ~4 ms.
//   A click is d2 > 0.012 and more than 14x that running RMS, at most one per 50 ms per channel. near(t): the cue
//   closest to it (within 250 ms) as [ms away, instrument, cue time], which usually names the culprit.
const cues = info.cues, near = t => { let best = null; for (const [ct, k] of cues) { const d = Math.abs(ct - t); if (d < .25 && (!best || d < best[0])) best = [+(d * 1000).toFixed(0), k, ct]; } return best; };
const clicks = [];
if (flag('clicks')) for (const [name, x] of [['L', L], ['R', R]]) { let e = 1e-7; const W = Math.round(sr * .004), a = 1 / W; let last = -1;
  for (let i = 2; i < n; i++) { const d2 = Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]); if (d2 > .012 && d2 > 14 * Math.sqrt(e) && i - last > sr * .05) { const t = FROM + i / sr; clicks.push([name, +t.toFixed(4), +d2.toFixed(3), near(t)]); last = i; } e += a * (d2 * d2 - e); } }
// spectra at chosen film times: strongest peaks and band energies (formant check)
// fft: an in-place radix-2 FFT (bit-reversal, then butterflies); N must be a power of two
function fft(re, im) { const N = re.length; for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= N; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < N; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr; re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai; re[i + k] += ar; im[i + k] += ai; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } }
// per --fft time: an 8192-sample Hann window centred on t (mono). Magnitudes are scaled by N/4, so a sine of amplitude
// A reads A (its dB is the sine's own level). peaks: the 14 strongest local maxima [Hz, dB]; bands: energy per range (dB).
const spectra = ffts.map(t => { const N = 8192, c = Math.round((t - FROM) * sr), re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) { const k = c - N / 2 + i; re[i] = k >= 0 && k < n ? (L[k] + R[k]) * .5 * (.5 - .5 * Math.cos(2 * Math.PI * i / N)) : 0; }
  fft(re, im); const mag = Array.from({ length: N / 2 }, (_, i) => Math.hypot(re[i], im[i]) / (N / 4)), fq = i => i * sr / N;
  const pk = []; for (let i = 3; i < N / 2 - 3; i++) if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1] && mag[i] > mag[i - 2] && mag[i] > mag[i + 2]) pk.push([Math.round(fq(i)), db(mag[i])]);
  pk.sort((a, b) => b[1] - a[1]);
  const band = (a, b) => { let s = 0; for (let i = 0; i < N / 2; i++) if (fq(i) >= a && fq(i) < b) s += mag[i] * mag[i]; return +(10 * Math.log10(s + 1e-20)).toFixed(1); };
  return { t, peaks: pk.slice(0, 14), bands: { '150-350': band(150, 350), '350-600': band(350, 600), '600-1000': band(600, 1000), '1000-1400': band(1000, 1400), '1400-2500': band(1400, 2500), '2500-3300': band(2500, 3300), '3300-6000': band(3300, 6000), '6000-12000': band(6000, 12000) } }; });
// onsets: spectral flux of log band energies (5 ms hop, 2048 window), peaks picked over an adaptive median threshold
//   Bands are a third of an octave wide (40 Hz - 16 kHz). For each frame the flux is the mean rise in dB over all bands
//   (only rises count, measured from no lower than -60 dB, so a band waking from silence does not dominate), and `top`
//   remembers the band that rose most. A frame is an
//   onset if it is the largest within +-40 ms and more than 1.0 above the median flux of the surrounding second.
//   onsets: [film time, strength over the median, band centre Hz], the N strongest, in time order.
let onsets = null, expected = null;
if (nOnsets) { const N = 2048, hop = Math.round(sr * .005), win = Float64Array.from({ length: N }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / N));
  const edges = []; for (let f = 40; f < 16000; f *= Math.pow(2, 1 / 3)) edges.push(f); const binOf = f => Math.round(f * N / sr), NBd = edges.length - 1;
  const frames = Math.floor((n - N) / hop), flux = new Float32Array(frames), top = new Int16Array(frames); let prev = null; const re = new Float64Array(N), im = new Float64Array(N);
  for (let fI = 0; fI < frames; fI++) { const o = fI * hop; for (let i = 0; i < N; i++) { re[i] = (L[o + i] + R[o + i]) * .5 * win[i]; im[i] = 0; } fft(re, im);
    const e = new Float64Array(NBd); for (let b = 0; b < NBd; b++) { let s2 = 0; for (let k = binOf(edges[b]); k < Math.max(binOf(edges[b]) + 1, binOf(edges[b + 1])); k++) s2 += re[k] * re[k] + im[k] * im[k]; e[b] = 10 * Math.log10(s2 + 1e-9); }
    if (prev) { let f = 0, best = 0, bi = 0; for (let b = 0; b < NBd; b++) { const d = Math.max(0, e[b] - Math.max(prev[b], -60)); f += d; if (d > best) { best = d; bi = b; } } flux[fI] = f / NBd; top[fI] = bi; } prev = e; }
  const tOf = i => FROM + (i * hop + N / 2) / sr, med = []; const W = Math.round(.5 / .005);
  for (let i = 0; i < frames; i++) { const a = Math.max(0, i - W), b = Math.min(frames, i + W), w = Array.from(flux.subarray(a, b)).sort((x, y) => x - y); med.push(w[w.length >> 1]); }
  const peaks = [], all = []; for (let i = 2; i < frames - 2; i++) { let mx = true; for (let j = Math.max(0, i - 8); j < Math.min(frames, i + 9); j++) if (flux[j] > flux[i] || (flux[j] === flux[i] && j < i)) { mx = false; break; }
    if (!mx) continue; const pk = { t: +tOf(i).toFixed(3), s: +(flux[i] - med[i]).toFixed(2), hz: Math.round(Math.sqrt(edges[top[i]] * edges[top[i] + 1])) }; all.push(pk); if (flux[i] > med[i] + 1.0) peaks.push(pk); }
  onsets = [...peaks].sort((a, b) => b.s - a.s).slice(0, nOnsets).sort((a, b) => a.t - b.t).map(p => [p.t, p.s, p.hz]);
  // each expected time: the strongest flux peak within 120 ms ([t, offset ms, strength over the local median, band Hz]); 'soft' if it barely stands out
  if (expect.length) expected = expect.map(t => { let best = null; for (const p of all) { const d = p.t - t; if (Math.abs(d) <= .12 && (!best || p.s > best.s)) best = { ...p, dms: Math.round(d * 1000) }; }
    return best ? [t, best.dms, best.s, best.hz].concat(best.s < .6 ? ['soft'] : []) : [t, 'MISSING']; }); }
// spectral balance per second: energy in six bands (sub, low, low-mid, mid, presence, air), dB
// (4096-sample Hann windows, half overlapping, averaged over the second; the same scale as the --fft spectra)
let bandRows = null;
if (flag('bands')) { const N = 4096, BD = [[20, 80], [80, 250], [250, 800], [800, 2500], [2500, 6000], [6000, 16000]], win = Float64Array.from({ length: N }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / N));
  bandRows = []; for (let s0 = 0; s0 * sr < n; s0++) { const acc = BD.map(() => 0); let fr = 0;
    for (let o = s0 * sr; o + N <= Math.min(n, (s0 + 1) * sr + N / 2); o += N / 2) { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = (L[o + i] + R[o + i]) * .5 * win[i]; fft(re, im); fr++;
      BD.forEach(([a, b], k) => { for (let i = Math.round(a * N / sr); i < Math.round(b * N / sr); i++) acc[k] += (re[i] * re[i] + im[i] * im[i]) / (N * N / 16); }); }
    bandRows.push([FROM + s0, ...acc.map(x => fr ? Math.round(10 * Math.log10(x / fr + 1e-12)) : -120)]); } }
// --spec: a spectrogram picture of the WAV, drawn by ffmpeg's showspectrumpic filter (ffmpeg must be on PATH)
let spec = null;
if (specOut) { const so = resolve(specOut); mkdirSync(dirname(so), { recursive: true });
  const sp = [`s=${arg('spec-size', '1600x600')}`, 'legend=1', 'scale=log', `fscale=${arg('spec-fscale', 'lin')}`].concat(arg('spec-start') ? [`start=${arg('spec-start')}`] : [], arg('spec-stop') ? [`stop=${arg('spec-stop')}`] : [], arg('spec-drange') ? [`drange=${arg('spec-drange')}`] : []);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-lavfi', 'showspectrumpic=' + sp.join(':'), so], { encoding: 'utf8' });
  spec = r.status === 0 ? so : 'ffmpeg failed: ' + (r.stderr || r.error?.message || '').slice(0, 300); }
// the report: one JSON line (fields that were not asked for are left out), then the tables
console.log(JSON.stringify({ out, loadMs, renderMs: info.renderMs, seconds: +(n / sr).toFixed(2), sr, stats: info.stats, check: info.check, peakDb: db(peak), peakAt: +(FROM + peakAt / sr).toFixed(3),
  lufs, momentaryMaxLufs: momMax, clicks: flag('clicks') ? clicks.slice(0, 60) : undefined, clickCount: flag('clicks') ? clicks.length : undefined, spectra: spectra.length ? spectra : undefined, stem: stem || undefined, kinds: kinds || undefined,
  expected: expected || undefined, onsets: onsets || undefined, spec, logs: logs.slice(0, 20) }));
if (bandRows) console.log('  t   <80  80-250 250-800 .8-2.5k 2.5-6k  6k+   (dB per band, per second)\n' + bandRows.map(r => r.map((v, i) => String(v).padStart(i ? 7 : 4)).join('')).join('\n'));
if (!flag('quiet')) { const rows = []; for (let i = 0; i < secs.length; i += 6) rows.push(secs.slice(i, i + 6).map(([t, r, p]) => `${String(t).padStart(5)}s ${String(r).padStart(6)} ${String(p).padStart(6)}`).join(' |')); console.log('  t   rms  peak (dBFS, per second)\n' + rows.join('\n')); }
done(0);
