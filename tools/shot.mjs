// shot.mjs - stills and contact sheets from the built film, in headless Chrome on the real GPU. Node built-ins only
// (Node 22 or newer, for the global fetch and WebSocket).
//
//   node tools/shot.mjs --t 3,7.5,12 --cols 3 --w 640 --out build/x.jpg        moments of the film on one sheet
//   node tools/shot.mjs --test valley --k 0,1,2,3 --cols 2 --w 800 --out build/v.jpg [--at 12]   a module's test view
//                                                                   (FILM.test.valley; --at is the film time for what moves)
//   node tools/shot.mjs --t 30 --w 1920 --out docs/s1.jpg                       one still at full size (one --t and no --cols)
//   --print "js" evaluates an expression after shooting and prints it (debugging)
//   options: --page FILE (default index.html; e.g. a test build made with tools/build.py --out), --size 1920x1080 (the
//   page's own size), --chrome <path> (or the CHROME environment variable), --eval "js run before shooting",
//   --profile DIR (keep the Chrome profile, and with it the GPU shader cache, between runs: later boots are faster)
// It also prints the boot times, a frame time and any console errors, as JSON.
// How it works: start Chrome headless with remote debugging, open the page with ?shots (film/main.js then starts paused, keeps
// the drawing buffer and leaves the render scale alone), wait for FILM.ready, call FILM.dev.still / sheet / sheetTest over the DevTools protocol and
// write the JPEG they return.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join, resolve, dirname } from 'node:path'; import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// --name value from the command line, or d
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
// the usual places of Chrome and Edge on Windows, macOS and Linux
const CANDIDATES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const CHROME = arg('chrome') || CANDIDATES.find(p => existsSync(p));
const page = resolve(ROOT, arg('page', 'index.html'));
const [PW, PH] = arg('size', '1920x1080').split('x').map(Number);
const out = resolve(arg('out', 'build/shot.jpg')); mkdirSync(dirname(out), { recursive: true });
const cols = +arg('cols', 4), w = +arg('w', 480);
const times = (arg('t', '') || '').split(',').filter(Boolean).map(Number);
const test = arg('test'), ks = (arg('k', '0') || '0').split(',').map(Number), at = +arg('at', 0);
const pre = arg('eval', ''), printExpr = arg('print', '');

const keepProf = arg('profile', null);   // --profile <dir>: keep the Chrome profile (and its GPU shader cache) between runs
const prof = keepProf || mkdtempSync(join(tmpdir(), 'film-shot-'));
// --use-angle=d3d11 is the GPU path on Windows; --ignore-gpu-blocklist keeps the real GPU in headless mode;
// background throttling is off so the page runs at full speed unseen
const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, `--window-size=${PW},${PH}`, '--hide-scrollbars', '--ignore-gpu-blocklist',
  '--use-angle=d3d11', '--enable-gpu-rasterization', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank']);
const fail = m => { console.error(m); try { ch.kill(); } catch { } process.exit(1); };
// Chrome prints its DevTools address on stderr; connect to the page target over a WebSocket
const wsUrl = await new Promise((res, rej) => { let buf = ''; ch.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); }); setTimeout(() => rej(new Error('Chrome did not start')), 20000); }).catch(e => fail(e.message));
const port = new URL(wsUrl).port;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
// the DevTools protocol: every command gets an id and its answer comes back with it; exceptions and console errors and
// warnings are collected in logs
let id = 0; const pend = new Map(), logs = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 500));
  else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) logs.push(m.params.type + ' ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400)); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
// evaluate an expression in the page and return its value (promises are awaited)
const ev = async (expr, timeout = 600000) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: PW, height: PH, deviceScaleFactor: 1, mobile: false });
// load the page and wait for main.js to set FILM.ready (boot and shader warm-up done), at most 3 minutes
const t0 = Date.now(); await send('Page.navigate', { url: pathToFileURL(page).href + '?shots' });
for (;;) { const ok = await ev('!!(window.FILM && FILM.ready)').catch(() => false); if (ok) break; if (Date.now() - t0 > 180000) fail(JSON.stringify({ error: 'timeout waiting for FILM.ready', logs })); await new Promise(r => setTimeout(r, 200)); }
const bootMs = Date.now() - t0;
if (pre) await ev(pre);
// a test view sheet, a single still, or a contact sheet of film times (film/main.js FILM.dev)
let data;
try {
  if (test) data = await ev(`FILM.dev.sheetTest(${JSON.stringify(test)}, ${JSON.stringify(ks)}, ${Math.min(cols, ks.length)}, ${w}, ${at})`);
  else if (times.length === 1 && cols === 4 && !arg('cols')) data = await ev(`FILM.dev.still(${times[0]}, ${w})`);
  else data = await ev(`FILM.dev.sheet(${JSON.stringify(times.length ? times : [0])}, ${Math.min(cols, Math.max(1, times.length))}, ${w})`);
} catch (e) { logs.push('SHOT FAILED ' + e.message.slice(0, 600)); }
// the JPEG comes back as a data URL
if (data) writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
const printed = printExpr ? await ev(printExpr).catch(e => 'ERR ' + e.message) : undefined;
const info = await ev(`({ boot: FILM.dev.bootMs, ms: +FILM.dev.time(6).toFixed(1), shots: FILM.dev.shots.length })`).catch(() => ({}));
console.log(JSON.stringify({ out: data ? out : null, loadMs: bootMs, ...info, printed, logs: logs.slice(0, 20) }));
ws.close(); ch.kill(); setTimeout(() => { try { if (!keepProf) rmSync(prof, { recursive: true, force: true }); } catch { } process.exit(0); }, 400);
