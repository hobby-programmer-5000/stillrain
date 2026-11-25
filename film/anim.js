// anim.js - the animator's kit: easing, keyed values, held drawings, springs, noise, seeded randomness.
// Everything here is a pure function of time, so any frame of the film can be drawn on its own (seek, stills, recording).
// It is the first file in the page and uses nothing but plain JS; every other module reads it as FILM.anim (often `A`).
//
// keys(), the ease set, mixv(), hash() and spline() follow bide's film/anim.js (ChetasLua/bide, MIT, see vendor/bide-LICENSE):
// "every value is keyed against the song clock, held on twos". Here they also drive 3D poses, cameras and lights.
//
// At a glance (FILM.anim):
//   clamp lerp sm TAU          basics; sm(a, b, x) is smoothstep
//   ease, keys(t, ks), mixv    keyframes: keys(t, [[time, value, easeIntoThisKey], ...]) for numbers, arrays or objects
//   twos, held, heldOn         hand-drawn timing: poses on twos (12 drawings a second); key 2 in the player flips heldOn
//   ring, springTo, drag, damp springs and follow-through (all but damp need no stored state)
//   crPoint, spline            Catmull-Rom through points
//   hash, noise1, wobble       stable hash and 1D noise (hand-held drift, wind, breathing)
//   rng, named                 seeded random streams (named('crowd') always gives the same numbers)
//   ih, vn2, fbm2, vn3, fbm3   CPU value noise for placing and sculpting things
//   hex, toHex, mixc           '#rrggbb' colour helpers
// It also defines FILM.scene(o), the call every file in film/scenes/ uses to register its shot.
// A worked example:  A.keys(t, [[0, 0], [1.5, 1, 'snap'], [3, 0, 'io']])  rises from 0 to 1 by 1.5 s with a pop, back by 3 s.
// Nothing to look at on its own: try the calls in the browser console on the built page (FILM.anim.keys(...)).
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM;
  const TAU = Math.PI * 2;
  const clamp = (x, a = 0, b = 1) => x < a ? a : x > b ? b : x;
  const lerp = (a, b, k) => a + (b - a) * k;
  const sm = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  // easing curves: each maps 0..1 to 0..1 (some leave the range on the way, on purpose)
  const ease = {
    lin: x => x,
    io: x => x * x * x * (x * (6 * x - 15) + 10),                 // slow in, slow out (quintic smootherstep)
    in: x => x * x * (1.2 * x - .2 * x * x),                     // slow start, full speed at the end
    out: x => 1 - Math.pow(1 - x, 2.6),                          // fast start, slows into the key
    snap: x => 1 - Math.pow(1 - x, 5),                            // pops, long settle
    antic: x => x < .28 ? -.12 * Math.sin(x / .28 * Math.PI) : ease.io((x - .28) / .72),   // a small wind-up first (dips to -0.12)
    settle: x => x >= 1 ? 1 : 1 - Math.exp(-5.2 * x) * Math.cos(7.2 * x) * (1 - x),       // overshoot, then settle
    heavy: x => x * x * x,                                       // a weight that only gets going late
    hold: () => 0,                                               // no in-between: keeps the old value, jumps at the key's time
  };
  // keys(t, [[time, value, easeIntoThisKey], ...]) ; value: number, array or object of numbers.
  // Keys are sorted by time. Before the first key the first value holds, after the last the last. The ease named on a key
  // shapes the move INTO that key (default 'io').
  function keys(t, ks) {
    if (t <= ks[0][0]) return ks[0][1];
    for (let i = 1; i < ks.length; i++) {
      if (t <= ks[i][0]) {
        const a = ks[i - 1], b = ks[i], x = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        return mixv(a[1], b[1], (ease[b[2] || 'io'])(clamp(x)));
      }
    }
    return ks[ks.length - 1][1];
  }
  // mix two values of the same shape: numbers, arrays (element by element) or objects (key by key, recursively).
  // A key found on only one side is taken as it is.
  function mixv(a, b, k) {
    if (typeof a === 'number') return a + (b - a) * k;
    if (Array.isArray(a)) return a.map((v, i) => mixv(v, b[i], k));
    const o = {}; for (const q in a) o[q] = q in b ? mixv(a[q], b[q], k) : a[q]; for (const q in b) if (!(q in o)) o[q] = b[q]; return o;
  }
  // a stable hash of up to three numbers -> [0,1). Inputs are cut to steps of 0.001 first, so hash(i, 0.5) is fine but
  // two values inside the same 0.001 step hash the same.
  function hash(a, b = 0, c = 0) {
    let h = (Math.imul((a * 1000) | 0, 374761393) ^ Math.imul((b * 1000) | 0, 668265263) ^ Math.imul((c * 1000) | 0, 2147483647 ^ 0x5bd1e995)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return ((h >>> 0) % 1000003) / 1000003;
  }
  // smooth 1D value noise in -1..1, one new random value per unit of x; s picks a different curve
  function noise1(x, s = 0) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash(i, s, 7), hash(i + 1, s, 7), u) * 2 - 1; }
  // a few octaves of noise1, still -1..1: hand-held drift, wind, breathing irregularity
  function wobble(x, s = 0, oct = 3) { let v = 0, a = .5, f = 1, n = 0; for (let k = 0; k < oct; k++) { v += a * noise1(x * f, s + k * 13.1); n += a; a *= .5; f *= 2.1; } return v / n; }

  // ---- held drawings. Animation in this film is timed like hand-drawn anime: people and creatures are posed
  //      12 times a second ("on twos"), while the camera, light, water and sky move every frame.
  const FPS_DRAW = 12;
  // round t down to the last drawing: on a 24 fps sheet, a new drawing every n frames (the 1e-6 guards against float error)
  const twos = (t, n = 2) => Math.floor(t * 24 / n + 1e-6) * n / 24;   // n=2 -> 12 drawings/s, n=3 -> 8
  let heldOn = true;
  // the time people and creatures are posed at (main.js passes it to every shot as `held`, and as FILM.U.uHeld to the
  // shaders); with heldOn off (key 2 in the player) they move every frame instead
  const held = (t, n = 2) => heldOn ? twos(t, n) : t;

  // ---- springs, solved in closed form so they need no history: a value that was pushed at time t0 and rings out
  // impulse response of a damped spring (frequency f Hz, damping ratio z), 0 before t0. It starts at 0, swings to
  // a peak below 1 and dies away; multiply by the size of the push.
  const ring = (t, t0, f = 2, z = .25) => { const x = t - t0; if (x < 0) return 0; const w = TAU * f, wd = w * Math.sqrt(Math.max(1e-4, 1 - z * z)); return Math.exp(-z * w * x) * Math.sin(wd * x); };
  // step response: goes from 0 to 1 starting at t0 with overshoot
  const springTo = (t, t0, f = 1.5, z = .45) => { const x = t - t0; if (x <= 0) return 0; const w = TAU * f, wd = w * Math.sqrt(Math.max(1e-4, 1 - z * z));
    return 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + z * w / wd * Math.sin(wd * x)); };
  // a lagged copy of a keyed motion: loose parts (hair, ribbons, sleeves) follow the body late (overlap, follow-through)
  const drag = (fn, t, lag) => fn(t - lag);
  // exponential follow from a toward b (rate per second, frame-rate independent), for things that must be simulated
  // step by step (ropes, flocks). Unlike everything above it depends on the previous frame.
  const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

  // ---- Catmull-Rom through points (any dimension); u in 0..1 along the whole path.
  // u is spread evenly over the segments, not by length, so the point moves faster along long segments.
  // The end points are repeated as their own neighbours, so the curve starts and ends exactly on them.
  function crPoint(pts, u, out = []) {
    const n = pts.length - 1, f = clamp(u) * n, i = Math.min(n - 1, Math.floor(f)), t = f - i;
    const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[i + 1], d = pts[Math.min(n, i + 2)], t2 = t * t, t3 = t2 * t;
    for (let k = 0; k < b.length; k++) out[k] = .5 * (2 * b[k] + (c[k] - a[k]) * t + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t2 + (3 * b[k] - a[k] - 3 * c[k] + d[k]) * t3);
    out.length = b.length; return out;
  }
  // a polyline made smooth: `per` points on every segment of a Catmull-Rom curve through pts (closed: loop back to the
  // start). Fewer than three points come back as copies.
  function spline(pts, per = 8, closed = false) {
    const n = pts.length, out = []; if (n < 3) return pts.map(p => p.slice());
    const g = i => closed ? pts[(i % n + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]; const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) { const a = g(i - 1), b = g(i), c = g(i + 1), d = g(i + 2);
      for (let j = 0; j < per; j++) { const t = j / per, t2 = t * t, t3 = t2 * t, o = [];
        for (let k = 0; k < b.length; k++) o.push(.5 * (2 * b[k] + (c[k] - a[k]) * t + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t2 + (3 * b[k] - a[k] - 3 * c[k] + d[k]) * t3));
        out.push(o); } }
    if (!closed) out.push(pts[n - 1].slice()); return out;
  }

  // ---- seeded random streams (mulberry32): every random choice in the world comes from a named stream.
  // rng(seed) returns a function that gives the next number in [0,1) on each call; named(text) seeds it from a string
  // (FNV-1a hash), so a module's stream does not shift when another module draws more numbers.
  function rng(seed) { let s = seed >>> 0; return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const named = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return rng(h >>> 0); };

  // ---- CPU value noise (for placing things, terrain, sculpting)
  // ih: integer lattice hash -> [0,1). vn2 / vn3: value noise in [0,1] with smooth (cubic) interpolation between lattice
  // points. fbm2 / fbm3: several octaves, each at about twice the frequency and half the weight, normalised to [0,1].
  function ih(i, j, k = 0) { let h = Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(k | 0, 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
  function vn2(x, y) { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = ih(i, j), b = ih(i + 1, j), c = ih(i, j + 1), d = ih(i + 1, j + 1); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
  function fbm2(x, y, oct = 5) { let s = 0, a = .5, f = 1, n = 0; for (let k = 0; k < oct; k++) { s += a * vn2(x * f + k * 17.3, y * f - k * 9.1); n += a; f *= 2.03; a *= .5; } return s / n; }
  function vn3(x, y, z) { const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z); let fx = x - i, fy = y - j, fz = z - k;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const L = (a, b, t) => a + (b - a) * t;
    return L(L(L(ih(i, j, k), ih(i + 1, j, k), fx), L(ih(i, j + 1, k), ih(i + 1, j + 1, k), fx), fy),
             L(L(ih(i, j, k + 1), ih(i + 1, j, k + 1), fx), L(ih(i, j + 1, k + 1), ih(i + 1, j + 1, k + 1), fx), fy), fz); }
  function fbm3(x, y, z, oct = 4) { let s = 0, a = .5, f = 1, n = 0; for (let k = 0; k < oct; k++) { s += a * vn3(x * f, y * f, z * f); n += a; f *= 2.07; a *= .5; } return s / n; }

  // ---- colour helpers: hex('#abc' or '#aabbcc') -> [r, g, b] 0..255, toHex back, mixc mixes two colours in sRGB
  function hex(c) { if (Array.isArray(c)) return c; c = c.replace('#', ''); if (c.length === 3) c = c.replace(/./g, '$&$&'); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
  function toHex(a) { return '#' + a.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
  function mixc(a, b, k) { a = hex(a); b = hex(b); return toHex([0, 1, 2].map(i => a[i] + (b[i] - a[i]) * k)); }

  F.anim = { TAU, clamp, lerp, sm, ease, keys, mixv, hash, noise1, wobble, FPS_DRAW, twos, held, set heldOn(v) { heldOn = v; }, get heldOn() { return heldOn; },
    ring, springTo, drag, damp, crPoint, spline, rng, named, ih, vn2, fbm2, vn3, fbm3, hex, toHex, mixc };
  // the shot registry: each scene file calls FILM.scene({ id, t0, t1, setup?, enter?, update }); main.js sorts them by t0
  // and asks the shot that owns the current time for the camera and the look. It lives here because this file loads first.
  F.scenes = F.scenes || {};
  F.scene = o => { F.scenes[o.id] = o; };
})();
