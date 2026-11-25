// rain.js - STILLRAIN's rain: water that hangs in the air until a sound of its own pitch lets it go. Owns FILM.rain.
//
// What it builds (film/RAIN.md, in Korean, has the counts, the full API table and the test views):
//   the field     a drifting rain-field shaped like a cumulus / a starling flock, in three strata whose field-local heights
//                 come from FILM.path.FIELD: heavy drops at the bottom (band 0, they answer D), marble beads in the middle
//                 (band 1, A), a mist veil on top (band 2, E), a thin haze of mist through it all, a painted translucent "body"
//                 that gives the mass its lumpy silhouette from afar, and 150 drop-strands that hang from inside the field down
//                 to 2.5 m above the ground (bead curtains: beads on a thin water thread)
//   local drops   world-fixed strands, loose beads and mist puffs over the village (Cistern Row, Pell's roof, terrace 9, the
//                 bench, S01's grove), so every small wet sound in Act 1 visibly brings something down
//   story drops   the macro drop of S01 (with a tadpole), frog, nose, face, palm, and the hero drops Pell hops on: real glass
//                 meshes that hold an upside-down miniature of the valley and squash like jelly when she lands
//   sound rings   an expanding shell for every big toll (reach > 30 m); Pell's voice (66.0, 67.5) x4 with star sparkles, and
//                 its screen shock (shock() feeds the engine's look.shock)
//
// How it works. Every drop is a pure function of film time, so any frame can be drawn on its own:
//   1. At load each drop gets a rest position, size, seed and flags, and its release time tr: the same formula as
//      FILM.events.releaseTime (tr = t0 + distance / 30 + hold + 0.08 seed, over the same toll table), evaluated once per
//      drop and stored as an attribute, so the vertex shader does not loop over the tolls for every vertex. Where it will
//      land (the ground height under its fall) is estimated once too.
//   2. The vertex shader (RAIN_CORE below) moves the hanging drop (bob, breathing, curl-noise murmuration, gust shear, strand
//      sway, the fans' dents, the bead curtain parting round Pell), shakes it while a held note builds on it, and from tr lets
//      it fall on the film's terminal-velocity curve (FILM.events GLSL fallDist). A falling drop stretches into an anime
//      streak along its velocity relative to the camera and ends in a splash crown on the ground (about one in four).
//   3. hangJS / stateJS mirror that GLSL formula for formula, so other modules (snails on strands, tests) can ask where a
//      drop is without reading back from the GPU.
// The look (bible section 8 "Drops"): an upside-down miniature inside (ground over sky, split by a bent horizon), a thin
// darker cyan rim, light gathered on the far side, a kidney highlight toward the sun (upper left), a small glint opposite,
// four-point star glints that twinkle on the held clock, near drops as soft bokeh discs.
// M3, M4, M6, M10 ... in the comments are the signature motions of film/BIBLE.md section 5.
//
// API at a glance: steps(scene) / finalize(scene) build it, update(t) runs every frame, set(o) tunes the look for one frame,
//   hero(id, t), strands / strandAt / beadAt / strandPts / strandsNear, addBeads(list), shock(t, cam), releases(...),
//   fallingNear(...), sets (the raw typed arrays; music/synth.js reads them), relTime / hangJS / stateJS / groundStep / curl
//   (JS mirrors of the shader), GLSL / DRAW2D (shader chunks other modules may reuse).
// Reads: FILM.anim, FILM.engine (COMMON, glass, col, the GLASS layer), FILM.valley (ground, wob, places, onTerrace),
//   FILM.path (fieldC, gust, fans, Pell's path, the hop drops, the special story drops), FILM.events (the toll table T, HOLD,
//   C_SOUND, fall, hitTau, releaseTime, GLSL).
// See it: node tools/shot.mjs --test field --k 0,1,2,3   (other views: drops, drop, release, hops, fall, story, voice; they
//   are defined at the end of this file).
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim, E = F.engine, V = F.valley, P = F.path, EV = F.events;
  const { clamp, lerp, TAU } = A;
  const add = P.add, sub = P.sub;
  const FIELD = P.FIELD;   // field size and strata: { base 44 m, rx, rz (footprint half-axes), heavy, marble, mist: [y0, y1] }
  // how many of each: heavy drops, marble beads, mist points, field strands, body cloudlets
  const CNT = { heavy: 5600, marble: 36000, mist: 92000, strands: 150, body: 210 };
  // field strands: a bead every 0.5 m, at most 112 beads (56 m), and nothing lower than 2.5 m above the ground (the cut)
  const STRAND = { step: .5, max: 112, cut: 2.5 };
  // instance flags (aInfo.w): bit 0 drifts with the field, 1 strand bead, 2 holds a tadpole, 3 makes a splash crown
  const DRIFT = 1, BEAD = 2, TAD = 4, SPLASH = 8;
  // sRGB colours: the drop's body, its rim, the white-gold release flash, the ground seen inside a drop (lit, shade), the
  // tadpole's ink, and the field body's lit and shade tones
  const COL = { drop: '#BFEFFF', rim: '#5FC8E0', flash: '#FFF3C8', gnd: '#E8B36A', gndShade: '#C08A70', ink: '#3A1F33', bodyLit: '#CDEFFF', bodyShade: '#6E9FD8' };
  const R = F.rain = F.rain || {};
  const HOLD = EV.HOLD, CS = EV.C_SOUND;   // 1.5 s a held note must last to release; the speed of sound, 30 m/s

  // ------------------------------------------------------------------ release times (once per drop, at load)
  // The toll table with the field's centre at each toll's start: a drifting drop's distance to a toll is measured where the
  // field was when the toll sounded (exactly as FILM.events.releaseTime and its GLSL twin do).
  const EVS = EV.T.map(e => ({ id: e.id, band: e.band, t0: e.t0, s: e.src, reach: e.reach, hold: e.hold, dur: e.dur, fc: P.fieldC(e.t0) }));
  // the tolls that can release each band. A held note that stops before HOLD only makes drops tremble, so it is left out
  const EVB = [0, 1, 2].map(b => EVS.filter(e => e.band === b && !(e.hold > 0 && e.dur < e.hold)));
  // a drop's release time (s), the same value as FILM.events.releaseTime: the earliest toll of its band whose front reaches it
  // (within reach, arriving after `since`), plus that toll's hold and a small per-drop spread of 0.08 s x seed. 1e9 = never.
  // (x, y, z) is field-local when drift = 1, world otherwise
  function relTime(x, y, z, drift, band, seed, since) {
    let tr = 1e9; const L = EVB[band] || [];
    for (let k = 0; k < L.length; k++) { const e = L[k];
      const dx = x + (drift ? e.fc[0] : 0) - e.s[0], dy = y + (drift ? e.fc[1] : 0) - e.s[1], dz = z + (drift ? e.fc[2] : 0) - e.s[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > e.reach) continue; const ta = e.t0 + d / CS; if (ta < since) continue; const v = ta + e.hold + .08 * seed; if (v < tr) tr = v; }
    return tr; }
  // the held note that makes a heavy drop tremble (M6): the latest sustained front to reach it before it lets go -> [arrival, end]
  // (end = how far through HOLD the note lasts: 1 releases it, less only shakes it, as with the test hum at 64.5).
  // Only heavy drops (band 0) tremble: every held note in the toll table is a D
  function tremFront(x, y, z, drift, tr) {
    let ta = 1e9, end = 0;
    for (const e of EVS) { if (e.band !== 0 || e.hold <= 0) continue;
      const dx = x + (drift ? e.fc[0] : 0) - e.s[0], dy = y + (drift ? e.fc[1] : 0) - e.s[1], dz = z + (drift ? e.fc[2] : 0) - e.s[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > e.reach) continue; const a = e.t0 + d / CS; if (a > tr + .01) continue; if (ta > 1e8 || a > ta) { ta = a; end = Math.min(1, e.dur / e.hold); } }
    return [ta, end]; }

  // ------------------------------------------------------------------ motion (JS mirror of RAIN_CORE in GLSL below)
  // analytic curl noise: the curl of two sine-wave vector potentials, so it is divergence free and needs no texture
  // (the second octave is 2.13x finer at half strength). JS twin of curl3() in RAIN_CORE
  function curl(x, y, z) {
    let cx = Math.cos(1.0 * y + .7 * z + .3), cy = Math.cos(.9 * z + 1.1 * x + 1.7), cz = Math.cos(1.2 * x + .8 * y + 2.9);
    let ox = .8 * cz - .9 * cy, oy = .7 * cx - 1.2 * cz, oz = 1.1 * cy - 1.0 * cx;
    const X = x * 2.13 + 4.1, Y = y * 2.13 + 1.3, Z = z * 2.13 + 7.7;
    cx = Math.cos(.8 * Y + 1.3 * Z + .9); cy = Math.cos(1.2 * Z + .6 * X + 2.2); cz = Math.cos(.7 * X + 1.1 * Y + .4);
    ox += .5 * (1.1 * cz - 1.2 * cy); oy += .5 * (1.3 * cx - .7 * cz); oz += .5 * (.6 * cy - .8 * cx);
    return [ox * .5, oy * .5, oz * .5];
  }
  // the bead curtain follows Pell on a damped spring (M10): her position at 8 past moments (seconds ago), weighted by a spring's
  // impulse response (1.3 Hz, damping ratio 0.32), normalised to sum 1. The later lags weigh negative, so the curtain swings
  // aside as she passes and closes again behind her. The weights go to the shader as uPellW
  const LAGS = [0, .15, .3, .45, .6, .75, .9, 1.05];
  const LAGW = (() => { const w = 2 * Math.PI * 1.3, z = .32, wd = w * Math.sqrt(1 - z * z); const h = LAGS.map(t => Math.exp(-z * w * t) * Math.sin(wd * t)); const s = h.reduce((a, b) => a + b, 0); return h.map(v => v / s); })();
  // the field's drift direction before the gust (V0D) and after it (VG), FILM.path's two drift velocities made unit length
  const VG = [.39, 0, .92], V0D = [1, 0, .075];
  // the wind's direction: east, swinging to the Spillway in the gust (36-38 s). JS twin of rWind() in RAIN_CORE
  const windAt = t => { const k = A.sm(36, 38, t), wx = lerp(V0D[0], VG[0], k), wz = lerp(V0D[2], VG[2], k), wl = Math.hypot(wx, wz); return [wx / wl, 0, wz / wl]; };
  // everything the motion reads that depends only on time (the uniforms, in JS), cached for the last t asked:
  //   gust 0..1, wind direction, fans on 0..1, fans [x, y, z, phase, phase offset], Pell's middle (0.75 m above her feet) at
  //   each of the 8 lags, and the field's velocity (m/s, a central difference over 0.1 s)
  let gCache = null;
  function globalsAt(t) {
    if (gCache && gCache.t === t) return gCache;
    const c1 = P.fieldC(t + .05), c0 = P.fieldC(t - .05);
    const g = { t, gust: P.gust(t), wind: windAt(t), fanOn: P.FANS_ON(t), fans: [], pell: [], fieldV: [(c1[0] - c0[0]) / .1, 0, (c1[2] - c0[2]) / .1] };
    for (const f of P.fans(t)) g.fans.push([f.pos[0], f.pos[1], f.pos[2], f.phase, f.phase - TAU * t / 1.5]);
    for (const l of LAGS) { const p = P.pell(t - l).pos; g.pell.push([p[0], p[1] + .75, p[2]]); }
    return (gCache = g);
  }
  // where a drop hangs at time t (JS twin of rainHang). Rr: rest (field-local when drift), r: radius (m), seed: the drop's
  // seed, ss: its strand's seed, h: metres below the strand's top (0 = a loose drop), cur: how much the bead curtain parts
  // round Pell (1 strand beads, 0.6 loose heavy drops, 0 the rest)
  function hangJS(Rr, drift, r, seed, ss, h, cur, t) {
    const g = globalsAt(t), fc = drift ? P.fieldC(t) : [0, 0, 0];
    const wx = Rr[0] + fc[0], wy = Rr[1] + fc[1], wz = Rr[2] + fc[2];
    // idle bob: a strand moves as one (its seed, 3 cm, the phase lagging down the strand); a loose drop bobs more the bigger it is
    const ph = h > 0 ? ss : seed, amp = h > 0 ? .03 : .03 + .4 * r, hp = h * .07;
    let mx = .5 * amp * Math.sin(TAU * (.17 + .13 * ph) * t + 3.1 * ph + 1 - hp), my = amp * Math.sin(TAU * (.25 + .2 * ph) * t + 6.28 * ph - hp), mz = .5 * amp * Math.sin(TAU * (.13 + .11 * ph) * t + 5.3 * ph + 2 - hp);
    if (drift) {
      // the field breathes (M3): its edge swells and shrinks by a few percent in slow lobes, and it stretches and squashes
      // vertically about the 14 m level
      const th = Math.atan2(Rr[2], Rr[0]), br = .035 * Math.sin(.45 * t + 3 * th) + .025 * Math.sin(.31 * t - 2 * th + 1.3);
      mx += Rr[0] * br; mz += Rr[2] * br; my += (Rr[1] - 14) * .03 * Math.sin(.37 * t + 2 * th + .7);
      // murmuration (M3): large curl noise (wavelengths of roughly 80-200 m, drifting with time), weighted 0.6 in calm air
      // and up to 2.6 in the gust
      const c = curl(wx * .025, wy * .025, wz * .025 + .07 * t), k = 2 * (.3 + g.gust); mx += c[0] * k; my += c[1] * k; mz += c[2] * k;
      // gust shear: above the field's middle (19 m) drops lean downwind, below it upwind, at most 5 m
      const sh = clamp(Rr[1] - 19, -20, 20) * .25 * g.gust; mx += g.wind[0] * sh; mz += g.wind[2] * sh;
    }
    // finer curl noise for every drop (wavelengths of roughly 20-50 m), 0.22 m
    const c2 = curl(wx * .11 + .05 * t, wy * .11, wz * .11); mx += c2[0] * .22; my += c2[1] * .22; mz += c2[2] * .22;
    // strand sway: a pendulum-like swing in the strand's own direction, growing with depth below the top, and in the gust a
    // drifting strand leans downwind
    if (h > 0) { const a = ss * TAU, sw = Math.sin(.55 * t + ss * 9 - h * .12) * (.018 + .05 * g.gust) * h; mx += Math.cos(a) * sw; mz += Math.sin(a) * sw;
      if (drift) { mx += g.wind[0] * g.gust * .1 * h; mz += g.wind[2] * g.gust * .1 * h; } }
    let px = wx + mx, py = wy + my, pz = wz + mz;
    // the fans' dents (M4): within 20 m of a fan, a gaussian push (sigma about 4 m) mostly upward and a little outward, on
    // the fan's 1.5 s sweep, fading above 8 m over the fan; up to 3 m while the fans are on (23.5-35 s)
    if (g.fanOn > 0) { let fx = 0, fy = 0, fz = 0;
      for (const f of g.fans) { const dx = px - f[0], dz = pz - f[2], d2 = dx * dx + dz * dz; if (d2 > 400) continue;
        const v = Math.exp(-d2 / 36) * (.5 + .5 * Math.sin(TAU * t / 1.5 + f[4])) * Math.exp(-Math.max(0, py - f[1] - 8) / 10), l = Math.hypot(dx * .4, 1, dz * .4);
        fx += dx * .4 / l * v; fy += v / l; fz += dz * .4 / l * v; }
      const k = 3 * g.fanOn; px += fx * k; py += fy * k; pz += fz * k; }
    // the bead curtain (M10): pushed sideways away from Pell's recent positions (within about 1 m across, 1.2 m up and down),
    // up to 0.8 m x cur
    if (cur > 0) { let cx = 0, cz = 0;
      for (let i = 0; i < 8; i++) { const q = g.pell[i], dx = px - q[0], dy = py - q[1], dz = pz - q[2], d2 = dx * dx + dz * dz; if (d2 > 30) continue;
        const v = .8 * LAGW[i] * Math.exp(-d2 / 2) * Math.exp(-dy * dy / 2.9) / Math.sqrt(d2 + .01); cx += dx * v; cz += dz * v; }
      px += cx * cur; pz += cz * cur; }
    return [px, py, pz];
  }
  // a held note building on a drop (M6), from its current position: 0..1, growing as x^2 through HOLD (used for the glass
  // story drops; the JS twin of FILM.events' evTremble)
  function tremJS(p, t, band) { let m = 0;
    for (const e of EV.T) { if (e.hold <= 0 || e.band !== band) continue; const d = Math.hypot(p[0] - e.src[0], p[1] - e.src[1], p[2] - e.src[2]); if (d > e.reach) continue;
      const x = (t - e.t0 - d / CS) / e.hold, end = e.dur / e.hold; if (x > 0 && x < Math.min(1, end)) m = Math.max(m, x * x); }
    return m; }
  // the whole life of one drop at time t (JS mirror of rainState): {p, state 0 hangs | 1 falls | 2 landed, tau (s since
  // release), age (s since landing), tr, trem, hang (where it hangs, or hung when it let go)}.
  // aux = [arrival, end] of its tremble front (tremFront), gEst = the ground height it lands on (groundEst).
  // Before tr it hangs and trembles (14-20 Hz, growing as x^2 through HOLD). From tr it starts where it hung at tr, falls
  // FILM.events.fall(tau) and keeps drifting with the field, until it has fallen to gEst
  function stateJS(Rr, drift, band, r, seed, ss, h, cur, tr, aux, gEst, t) {
    const tq = Math.min(t, tr), p = hangJS(Rr, drift, r, seed, ss, h, cur, tq), tau = t - tr;
    if (tau < 0) { const x = (t - aux[0]) / HOLD, tm = x > 0 && x < aux[1] ? x * x : 0, a = seed * 37, k = (.06 + .25 * r) * tm * Math.sin(TAU * (14 + 6 * seed) * t);
      return { p: [p[0] + Math.cos(a) * k, p[1] + .4 * Math.sin(a * 1.7) * k, p[2] + Math.sin(a) * k], state: 0, tau, age: 0, tr, trem: tm, hang: p }; }
    const y0 = p[1], th = EV.hitTau(y0 - gEst, band);
    const dr = (tt) => { if (!drift) return [0, 0]; const a = P.fieldC(tr + tt), b = P.fieldC(tr); return [a[0] - b[0], a[2] - b[2]]; };
    const tt = Math.min(tau, th), d1 = dr(tt);
    return { p: [p[0] + d1[0], y0 - EV.fall(tt, band), p[2] + d1[1]], state: tau < th ? 1 : 2, tau, age: tau - th, tr, trem: 0, hang: p };
  }

  // the ground as plain terrace steps (no wall slope, lip, notch or peaks): where a field strand ends (2.5 m above it).
  // The same rings as FILM.valley.ground: the floor inside 40 m, nine 16.5 m terraces 3.2 m apart, then the rim rising to 36 m.
  // JS twin of rGroundStep in RAIN_CORE
  function groundStep(x, z) { const r = Math.sqrt(x * x + z * z), th = Math.atan2(z, x), w = V.wob(th), R9 = 40 + 148.5 + w * 1.5;
    if (r < 40 + w * .5) return 0; if (r > R9) return 28.8 + 7.2 * A.sm(0, 14, r - R9);
    const k = clamp(Math.floor((r - 40 - w * .5) / 16.5), 0, 8), rk = 40 + 16.5 * k + w * (.5 + k / 9); return r > rk ? 3.2 * (k + 1) : 3.2 * k; }

  // ------------------------------------------------------------------ the field's shape and its drops
  // the field's own seeded random stream: the same field on every load, whatever other modules draw from theirs
  const rnd = A.named('rain-field');
  // Box-Muller gives two normal numbers per draw; keep the second for the next call
  let gSpare = null;
  const gauss = () => { if (gSpare !== null) { const v = gSpare; gSpare = null; return v; } let u = 0; while (!u) u = rnd(); const m = Math.sqrt(-2 * Math.log(u)), a = TAU * rnd(); gSpare = m * Math.sin(a); return m * Math.cos(a); };
  // the footprint: an ellipse of half-axes FIELD.rx x FIELD.rz with a wavy, lobed outline. footE < 1 inside
  const lobe = th => 1 + .16 * Math.sin(3 * th + 1) + .09 * Math.sin(5 * th + 2.3) + .05 * Math.sin(8 * th + .4);
  const footE = (x, z) => { const ex = x / FIELD.rx, ez = z / FIELD.rz; return Math.sqrt(ex * ex + ez * ez) / lobe(Math.atan2(ez, ex)); };   // < 1 inside
  // the staircase Pell climbs (field-local), so drops and strands keep out of her way and gather round it
  const STAIR = P.hops.map(h => ({ c: h.local, r: h.r })).concat([{ c: P.H.local, r: P.H.r }]);
  // its bounding box [min x, y, z, max x, y, z] with 2 m to spare (3.5 m above, for her body), for a quick reject
  const SBOX = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
  STAIR.forEach(s => { for (let k = 0; k < 3; k++) { SBOX[k] = Math.min(SBOX[k], s.c[k] - s.r - 2); SBOX[k + 3] = Math.max(SBOX[k + 3], s.c[k] + s.r + (k === 1 ? 3.5 : 2)); } });
  // distance from point p to the segment a-b
  const segDist = (p, a, b) => { const ab = sub(b, a), ap = sub(p, a), k = clamp((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1)); return Math.hypot(ap[0] - ab[0] * k, ap[1] - ab[1] * k, ap[2] - ab[2] * k); };
  // is a field-local point in Pell's way? Inside a hop drop, in the 1.7 m column of her body standing on one, or on the
  // line of her jump from one drop's top to the next (pad: extra clearance, m)
  function inPellsWay(p, pad = .7) {
    if (p[0] < SBOX[0] - pad || p[0] > SBOX[3] + pad || p[1] < SBOX[1] - pad || p[1] > SBOX[4] + pad || p[2] < SBOX[2] - pad || p[2] > SBOX[5] + pad) return false;
    for (let i = 0; i < STAIR.length; i++) { const s = STAIR[i]; const top = add(s.c, [0, s.r, 0]);
      if (Math.hypot(p[0] - s.c[0], p[1] - s.c[1], p[2] - s.c[2]) < s.r + pad) return true;
      if (segDist(p, top, add(top, [0, 1.7, 0])) < .6 + pad * .5) return true;                    // her body standing on it
      if (i + 1 < STAIR.length) { const n = STAIR[i + 1]; if (segDist(p, add(top, [0, .8, 0]), add(n.c, [0, n.r + .8, 0])) < .7 + pad * .5) return true; } }
    return false; }
  // lumps: cumulus heads / flock bodies. Each stratum is sampled round them, so the silhouette is lumpy and breathes.
  // A lump: centre (x, z), gaussian spread (sx, sz, m), weight w (how often it is picked), height factor hk (how tall it piles)
  const lumps = [];
  { for (let i = 0; i < 26; i++) { let x, z; do { x = (rnd() * 2 - 1) * FIELD.rx * .82; z = (rnd() * 2 - 1) * FIELD.rz * .82; } while (footE(x, z) > .85);
      lumps.push({ x, z, sx: 8 + 14 * rnd(), sz: 6 + 10 * rnd(), w: .4 + rnd(), hk: .5 + .5 * rnd() }); }
    // thick rain round the staircase and the heart drop, so the hops sit inside it
    const H = P.H.local, h0 = P.hops[0].local; lumps.push({ x: H[0], z: H[2], sx: 11, sz: 11, w: 2.2, hk: 1 }, { x: lerp(h0[0], H[0], .5), z: lerp(h0[2], H[2], .5), sx: 10, sz: 9, w: 1.6, hk: .9 }); }
  const lumpW = lumps.reduce((a, l) => a + l.w, 0);
  const pickLump = () => { let u = rnd() * lumpW; for (const l of lumps) { u -= l.w; if (u <= 0) return l; } return lumps[0]; };
  // a point of a stratum [y0, y1]: round a lump, denser low (flat base), domed top, swept into flock-like sheets.
  // The lump is picked by weight and the point scattered round it; its top falls off toward the lump's edge and the field's
  // edge (the dome), and y = y0 + top * rnd^pw (pw > 1 packs points toward the base). A slanted sine pattern then rejects some
  // points, leaving the sheets. After 40 misses it gives up and returns the field's centre at the stratum's bottom
  function samplePoint(y0, y1, pw, out) {
    for (let tries = 0; tries < 40; tries++) {
      const l = pickLump(), gx = gauss(), gz = gauss(), x = l.x + gx * l.sx, z = l.z + gz * l.sz;
      const fe = footE(x, z); if (fe > 1) continue;
      const e2 = Math.min(1, (gx * gx + gz * gz) / 6), top = (y1 - y0) * l.hk * (1 - .5 * e2) * (1 - .35 * fe * fe);
      const y = y0 + top * Math.pow(rnd(), pw);
      const sheet = .55 + .45 * Math.sin(x * .085 + Math.sin(z * .05) * 2.2 + y * .06);
      if (rnd() > sheet) continue;
      out[0] = x; out[1] = y; out[2] = z; return out; }
    out[0] = 0; out[1] = y0; out[2] = 0; return out;
  }
  // a set of drops: typed arrays, readable by other modules (synth: plink cascades and rain gain). They go to the GPU as
  // instanced attributes as they are (aRest, aInfo, aLife, aAux, aGnd):
  //   rest[i*3..] rest (field-local when it drifts), info[i*4..] = band, radius, seed, flags,
  //   life[i*4..] = since, until, release time, hang (metres below its strand's top), aux[i*4..] = tremble front, its end, strand seed, thread
  //   (the length of the water thread up to the bead above, 0 for none),
  //   gnd[i] = about where it will land (the ground height under its fall, ignoring the small hanging motion). The shader
  //            ends the fall when the drop has come down to this height
  function makeSet(n) { return { n: 0, rest: new Float32Array(n * 3), info: new Float32Array(n * 4), life: new Float32Array(n * 4), aux: new Float32Array(n * 4), gnd: new Float32Array(n) }; }
  // the ground height a drop will land on. World-fixed drops fall straight down. A drifting drop starts where the field holds
  // it at tr (heavy drops add the large hanging offsets: curl and gust shear), the fall time is judged on the plain terrace
  // steps, and the answer is the ground where the field's drift has carried it by then. 0 for a drop that never lets go
  function groundEst(x, y, z, drift, band, tr) { if (tr > 1e8) return 0; if (!drift) return V.ground(x, z);
    const c = P.fieldC(tr); let px = x + c[0], py = y + c[1], pz = z + c[2];
    if (band === 0) { const g = P.gust(tr), w = windAt(tr), cu = curl(px * .025, py * .025, pz * .025 + .07 * tr), k = 2 * (.3 + g), sh = clamp(y - 19, -20, 20) * .25 * g;
      px += cu[0] * k + w[0] * sh; py += cu[1] * k; pz += cu[2] * k + w[2] * sh; }
    const th = EV.hitTau(py - groundStep(px, pz), band), c1 = P.fieldC(tr + th), lx = px + c1[0] - c[0], lz = pz + c1[2] - c[2];
    return band === 2 ? groundStep(lx, lz) : V.ground(lx, lz); }      // mist lands as nothing in particular: the steps will do
  // add one drop to a set and work out its release time, tremble front and landing height. p: rest position (field-local
  // when flags has DRIFT), since / until: the drop exists only between these times, trF >= 0: a fixed release time instead of
  // the toll table's, hang / ss / thread: its strand (0, own seed, 0 for a loose drop). Returns its index
  function push(set, p, band, r, seed, flags, since = -1, until = 1e9, trF = -1, hang = 0, ss = seed, thread = 0) {
    const i = set.n++, drift = flags & DRIFT;
    const tr = trF >= 0 ? trF : relTime(p[0], p[1], p[2], drift, band, seed, since);
    const tf = band === 0 && tr < 1e8 ? tremFront(p[0], p[1], p[2], drift, tr) : band === 0 ? tremFront(p[0], p[1], p[2], drift, 1e8) : [1e9, 0];
    set.rest[i * 3] = p[0]; set.rest[i * 3 + 1] = p[1]; set.rest[i * 3 + 2] = p[2];
    set.info[i * 4] = band; set.info[i * 4 + 1] = r; set.info[i * 4 + 2] = seed; set.info[i * 4 + 3] = flags;
    set.life[i * 4] = since; set.life[i * 4 + 1] = until; set.life[i * 4 + 2] = tr; set.life[i * 4 + 3] = hang;
    set.aux[i * 4] = tf[0]; set.aux[i * 4 + 1] = tf[1]; set.aux[i * 4 + 2] = ss; set.aux[i * 4 + 3] = thread; set.gnd[i] = groundEst(p[0], p[1], p[2], drift, band, tr); return i; }
  const sets = {};           // big (heavy drops + field strands), marble, mist, body, local, beads
  // every strand: { kind 'field' | 'local', drifting, top (its top bead's rest), set (name in sets), first (index of its first
  // bead there), n (beads), seed, place (local strands: which spot) }
  const strands = [];
  // load times in ms per stage (R.timing), for the loading budget
  const timing = {}; const tick = (k, t0) => { timing[k] = Math.round(performance.now() - t0); return performance.now(); };
  // the drifting field: heavy drops and field strands (set 'big'), marble beads, mist, and the body cloudlets
  function genField() { let T0 = performance.now();
    const big = sets.big = makeSet(CNT.heavy + CNT.strands * STRAND.max), q = [0, 0, 0];
    // heavy drops, bottom stratum (8 tries to keep out of Pell's way; after that the last try stays)
    for (let i = 0; i < CNT.heavy; i++) { let ok = false; for (let k = 0; k < 8 && !ok; k++) { samplePoint(FIELD.heavy[0], FIELD.heavy[1], 1.5, q); ok = !inPellsWay(q); }
      // radius 9-22 cm, mostly small; a quarter splash; a tadpole in 5.5 % of those over 14 cm (about 1 heavy drop in 40)
      const r = .09 + .13 * Math.pow(rnd(), 1.7), seed = rnd(); let fl = DRIFT | (rnd() < .25 ? SPLASH : 0); if (r > .14 && rnd() < 1 / 40 * 2.2) fl |= TAD;
      push(big, q, 0, r, seed, fl); }
    T0 = tick('heavy', T0);
    // drop-strands: 60 % in the bead curtains round the staircase, the rest anywhere under the field.
    // A strand's top is 7-17 m up in the curtains, 2-11 m elsewhere (field-local), and clear of the hop drops (30 tries, then
    // the last try stays)
    const H = P.H.local, h0 = P.hops[0].local;
    for (let s = 0; s < CNT.strands; s++) {
      let x, z, topY;
      for (let k = 0; k < 30; k++) {
        if (s < CNT.strands * .6) { const u = rnd(); x = lerp(h0[0], H[0], u) + gauss() * 7; z = lerp(h0[2], H[2], u) + gauss() * 7; topY = 7 + 10 * rnd(); }
        else { const l = pickLump(); x = l.x + gauss() * l.sx; z = l.z + gauss() * l.sz; topY = 2 + 9 * rnd(); }
        if (footE(x, z) > .95) continue;
        let clear = true; for (const st of STAIR) if (Math.hypot(x - st.c[0], z - st.c[2]) < st.r + .9) { clear = false; break; }
        if (clear) break; }
      // enough beads to reach from the top (FIELD.base + topY above the valley floor) down to about 2 m above the floor (at
      // most 112); the shader hides the ones within 2.5 m of the terrace below them. j = 0 is the top bead; every 7th bead is
      // 1.3x fatter.
      // hang gets +0.001 so even the top bead counts as a strand bead (h > 0) in the motion
      const n = Math.min(STRAND.max, Math.ceil((topY + FIELD.base + 1 - STRAND.cut) / STRAND.step)), first = big.n, sd = rnd();
      for (let j = 0; j < n; j++) { const hang = j * STRAND.step, seed = A.hash(s, j, 3), fat = j % 7 === 3 ? 1.3 : 1;
        push(big, [x, topY - hang, z], 0, (.055 + .035 * A.hash(s, j, 5)) * fat, seed, DRIFT | BEAD | (seed < .25 ? SPLASH : 0), -1, 1e9, -1, hang + .001, sd, j > 0 ? STRAND.step : 0); }
      strands.push({ kind: 'field', drifting: true, top: [x, topY, z], set: 'big', first, n, seed: sd }); }
    T0 = tick('strands', T0);
    // marble beads, middle stratum: radius 1-3 cm, re-drawn until clear of Pell's way, about one in five splash
    const mb = sets.marble = makeSet(CNT.marble);
    for (let i = 0; i < CNT.marble; i++) { samplePoint(FIELD.marble[0], FIELD.marble[1], 1.1, q); if (inPellsWay(q, .3)) { i--; continue; }
      const seed = rnd(); push(mb, q, 1, .01 + .02 * rnd(), seed, DRIFT | (seed < .22 ? SPLASH : 0)); }
    T0 = tick('marble', T0);
    // mist: the top veil (85 %) and a thin haze through the whole field (15 %); info = release time, radius, seed, flags.
    // Mist needs no life / aux arrays: it always drifts, never trembles and has no strands. It is drawn as points
    const ms = sets.mist = { n: CNT.mist, rest: new Float32Array(CNT.mist * 3), info: new Float32Array(CNT.mist * 4), gnd: new Float32Array(CNT.mist) };
    for (let i = 0; i < CNT.mist; i++) { if (i < CNT.mist * .85) samplePoint(FIELD.mist[0], FIELD.mist[1], .8, q); else samplePoint(0, FIELD.mist[1], 1, q);
      const seed = rnd(), tr = relTime(q[0], q[1], q[2], 1, 2, seed, -1); ms.rest.set(q, i * 3); ms.info.set([tr, .002 + .006 * rnd(), seed, DRIFT], i * 4); ms.gnd[i] = groundEst(q[0], q[1], q[2], 1, 2, tr); }
    // the body: painted translucent cloudlets in each stratum. From afar, where single drops are under a pixel, they give the
    // mass its cumulus / flock silhouette; each thins out when its own band is rung down.
    // 42 % heavy, 34 % marble, 24 % mist; radius 5-14 m (bigger higher up). a = (x, y, z, radius), b = (seed, band, release
    // time of its centre with a median seed of 0.5, 0)
    const bd = sets.body = { n: CNT.body, a: new Float32Array(CNT.body * 4), b: new Float32Array(CNT.body * 4) };
    for (let i = 0; i < CNT.body; i++) { const u = rnd(), band = u < .42 ? 0 : u < .76 ? 1 : 2, st = band === 0 ? FIELD.heavy : band === 1 ? FIELD.marble : FIELD.mist;
      samplePoint(st[0] + 1.5, st[1], band === 0 ? 1.2 : .9, q); const rad = (band === 0 ? 7.5 : band === 1 ? 9 : 11) * (.7 + .6 * rnd()), seed = rnd();
      bd.a.set([q[0], q[1], q[2], rad], i * 4); bd.b.set([seed, band, relTime(q[0], q[1], q[2], 1, band, .5, -1), 0], i * 4); }
    tick('mistBody', T0);
  }

  // ------------------------------------------------------------------ local drops: world-fixed strands and beads over the village
  // Every small Act 1 sound has drops in its reach, so it visibly brings something down; the toll table decides when.
  const rl = A.named('rain-local');   // a separate random stream, so the field above does not shift when these change
  const gl = () => { let u = 0; while (!u) u = rl(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rl()); };   // a normal number
  // a short strand: beads every 0.22 m from its top down to `bottom`, a fat drop at the tip (8.5-12 cm; the others 3.5-5.5 cm).
  // Here j = 0 is the tip, the bottom bead (field strands count from the top)
  function localStrand(set, x, z, bottom, len, place, flags = 0) {
    const n = Math.max(2, Math.round(len / .22)), first = set.n, sd = rl();
    for (let j = 0; j < n; j++) { const hang = (n - 1 - j) * .22, tip = j === 0, seed = rl();
      push(set, [x, bottom + (n - 1 - j) * .22, z], 0, tip ? .085 + .035 * rl() : .035 + .02 * rl(), seed, BEAD | flags | (seed < .3 ? SPLASH : 0), -1, 1e9, -1, hang + .001, sd, j < n - 1 ? .22 : 0); }
    strands.push({ kind: 'local', drifting: !!(flags & DRIFT), top: [x, bottom + (n - 1) * .22, z], set: 'local', first, n, seed: sd, place });
  }
  // a loose world-fixed bead: 70 % heavy (radius 5-12 cm), else marble (1.2-3 cm)
  function looseBead(set, p, band = rl() < .7 ? 0 : 1) { const seed = rl(); push(set, p, band, band === 0 ? .05 + .07 * rl() : .012 + .018 * rl(), seed, seed < .3 ? SPLASH : 0); }
  // mist sparkle cluster round a point (world, or field-local when drift): n points inside radius rad (m), flattened a little
  // vertically; avoid(p) -> true rejects a point
  function mistCluster(set, c, rad, n, flags = 0, avoid = null) {
    for (let i = 0; i < n; i++) { const p = [c[0] + gl() * rad * .5, c[1] + gl() * rad * .4, c[2] + gl() * rad * .5];
      if (Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) > rad) { i--; continue; } if (avoid && avoid(p)) { i--; continue; }
      push(set, p, 2, .003 + .005 * rl(), rl(), flags); } }
  const SP = P.special;
  // about 120 short strands, 470 loose beads and three mist puffs (about 3,200 drops; the set has room for 4,400)
  function genLocal() {
    const L = sets.local = makeSet(4400), gnd = (x, z) => V.ground(x, z);
    const headAt = P.pellHead(20.25);   // Pell's head during her hum on the roof (D4 from 20.25 s, reach 1.6 m)
    // Cistern Row: strands over the path, to 2.3-3.2 m above it
    const cr = V.places.cisternRow;
    for (let i = 0; i < 38; i++) { const th = lerp(cr.th0, cr.th1, (i + rl()) / 38), p = V.onTerrace(cr.k, th, .3 + .45 * rl());
      localStrand(L, p[0], p[2], p[1] + 2.3 + .9 * rl(), 1.2 + 3.2 * rl(), 'cisternRow'); }
    for (let i = 0; i < 140; i++) { const p = V.onTerrace(cr.k, lerp(cr.th0, cr.th1, rl()), .15 + .75 * rl()); looseBead(L, [p[0], p[1] + 2.1 + 2 * rl(), p[2]]); }
    // the toy-bell child (13.5): a little cloud of mist over the two kids (the bell reaches 1.8 m)
    mistCluster(L, add(P.kid, [0, 2.1, 0]), 1.15, 320);
    // the frog's strand: the drop it drinks is a glass story drop; this strand hangs above it, out of the croak's reach
    { const f = SP.frog.pos; localStrand(L, f[0] + .01, f[2] - .02, f[1] + .98, 1.6, 'frog'); }
    // Pell's roof: strands round her, none inside her hum's reach (kept over 2 m from her head) except the nose drop's own strand
    const roof = P.pellRoofSpot;
    for (let i = 0; i < 16; i++) { let x, z, ok = false; for (let k = 0; k < 20 && !ok; k++) { const a = rl() * TAU, d = 2.2 + 4 * rl(); x = roof[0] + Math.cos(a) * d; z = roof[2] + Math.sin(a) * d; ok = Math.hypot(x - headAt[0], z - headAt[2]) > 2.0; }
      localStrand(L, x, z, roof[1] + 1.6 + 1.2 * rl(), 1.5 + 2.5 * rl(), 'pellRoof'); }
    { const n = SP.nose.pos; localStrand(L, n[0], n[2], n[1] + .72, 1.4, 'nose'); }
    for (let i = 0; i < 40; i++) { const a = rl() * TAU, d = 2.4 + 6 * rl(), x = roof[0] + Math.cos(a) * d, z = roof[2] + Math.sin(a) * d; looseBead(L, [x, Math.max(gnd(x, z) + 2.2, roof[1] + 1) + 2 * rl(), z]); }
    // terrace 9: the toll terrace and the run to the Spillway
    for (let i = 0; i < 34; i++) { const th = lerp(-.8, -.16, rl()), p = V.onTerrace(9, th, .1 + .8 * rl()); localStrand(L, p[0], p[2], p[1] + 2.3 + 1.4 * rl(), 1.2 + 3.5 * rl(), 'terrace9'); }
    for (let i = 0; i < 110; i++) { const p = V.onTerrace(9, lerp(-.82, -.12, rl()), rl()); looseBead(L, [p[0], p[1] + 2 + 2 * rl(), p[2]]); }
    // the Listeners' bench
    { const b = V.places.spillway.bench; for (let i = 0; i < 9; i++) { const a = rl() * TAU, d = 2 + 4 * rl(), x = b[0] + Math.cos(a) * d, z = b[2] + Math.sin(a) * d; localStrand(L, x, z, gnd(x, z) + 2.4 + rl(), 1.2 + 2 * rl(), 'bench'); }
      for (let i = 0; i < 30; i++) { const a = rl() * TAU, d = 1.5 + 6 * rl(), x = b[0] + Math.cos(a) * d, z = b[2] + Math.sin(a) * d; looseBead(L, [x, gnd(x, z) + 2 + 2 * rl(), z]); } }
    // S01's grove: the macro drop is the tip of a strand, and the pull-back reveals more strands, beads and sparkles round it
    { const m = SP.macro.pos; localStrand(L, m[0], m[2], m[1] + SP.macro.r + .08, 3.2, 'macro');
      for (let i = 0; i < 20; i++) { const a = rl() * TAU, d = 1.2 + 9 * Math.sqrt(rl()), x = m[0] + Math.cos(a) * d, z = m[2] + Math.sin(a) * d; localStrand(L, x, z, gnd(x, z) + 2.2 + 1.6 * rl(), 1.5 + 4 * rl(), 'macro'); }
      for (let i = 0; i < 150; i++) { const a = rl() * TAU, d = .8 + 13 * Math.sqrt(rl()), x = m[0] + Math.cos(a) * d, z = m[2] + Math.sin(a) * d; looseBead(L, [x, gnd(x, z) + 2 + 3.5 * rl(), z]); }
      mistCluster(L, add(m, [0, .6, 0]), 7, 380); }
    // Pell's bell (54.0-56.6): a puff of mist round her bell hand that rides with the field (the bell reaches 4 m), kept out
    // of her own body
    { const hand = P.pellHand(54.0), c = sub(hand, P.fieldC(54.0)), body = sub(add(P.pell(54).pos, [0, .7, 0]), P.fieldC(54.0));
      mistCluster(L, c, 3.3, 420, DRIFT, p => Math.hypot(p[0] - body[0], (p[1] - body[1]) * .6, p[2] - body[2]) < .75); }
  }

  // ------------------------------------------------------------------ story and hero drops (glass): their state at time t
  // kind: 'hop' (the staircase), 'heart' (H), or a special: macro, frog, nose, face, palm. Positions, sizes and the hops'
  // timing come from FILM.path (hops, H, special). A hop drop lets go 0.75 s after Pell lands on it, the heart drop at 69.0;
  // a story drop's release time comes from the toll table like any heavy drop's (seed 0)
  const HERO = [];
  { P.hops.forEach((h, i) => HERO.push({ id: 'hop' + i, kind: 'hop', local: h.local, r: h.r, ts: h.ts, tr: h.tr, drifting: true }));
    HERO.push({ id: 'heart', kind: 'heart', local: P.H.local, r: P.H.r, ts: P.H.ts, tr: P.H.tr, drifting: true });
    for (const k of ['macro', 'frog', 'nose', 'face', 'palm']) { const s = SP[k]; const d = { id: k, kind: k, r: s.r, drifting: !!s.drifting, since: s.since ?? -1, until: s.until ?? 1e9, tad: !!s.tadpole };
      d.local = s.drifting ? s.local : s.pos; d.tr = EV.releaseTime(d.local, d.drifting, 0, 0, d.since);
      // where it lands: the frog's mouth, Pell's nose, her palm; anything else falls to the ground
      d.land = k === 'frog' ? P.frog[1] + .05 : k === 'nose' ? s.pos[1] - 1.11 + .02 : k === 'palm' ? P.palmPos[1] + s.r * .75 : null;
      HERO.push(d); } }
  // a hero drop at time t -> { pos, sx, sy (scale = radius x stretch), a2, a3 (jelly squash, Legendre P2 / P3 amplitudes, see
  // FILM.path.jelly), trem 0..1, show }. A hop squashes when Pell lands (ts); every drop but the heart trembles under a held D.
  // After tr: a drop with a landing spot falls straight to it and stretches as it speeds up; on landing the palm drop sits
  // and jiggles in her hands, the frog's and the nose drop vanish. The others fall with the field's drift and vanish at the
  // ground (or after 6 s). The stretch keeps the volume: sx = r / sqrt(sy)
  function heroAt(d, t) {
    const o = { pos: [0, -1e4, 0], sx: 0, sy: 0, a2: 0, a3: 0, trem: 0, show: false };
    if (t < (d.since ?? -1) || t > (d.until ?? 1e9)) return o;
    const rest = d.drifting ? add(P.fieldC(Math.min(t, d.tr)), d.local) : d.local.slice();
    if (d.kind === 'hop' || d.kind === 'heart') { const j = P.jelly(t - d.ts); o.a2 = j[0]; o.a3 = j[1];
      // it bobs with the field like every heavy drop until she lands on it
      if (t < d.ts) { const s = d.r * 3.7; rest[1] += .05 * Math.sin(TAU * .27 * t + s); rest[0] += .025 * Math.sin(TAU * .19 * t + s * 2); } }
    else { // story drops bob a little on their strand (the length of the name gives each its own phase)
      const s = d.kind.length * .17; rest[1] += .012 * Math.sin(TAU * .3 * t + s * 9); rest[0] += .006 * Math.sin(TAU * .21 * t + s * 5); }
    // the face drop is boosted 7x: the test hum at 64.5 is short (0.45 s of the 1.5 s HOLD), and the drop must shiver visibly
    if (d.kind !== 'heart') { o.trem = tremJS(rest, t, 0); if (d.kind === 'face') o.trem = Math.min(1, o.trem * 7); }
    let pos = rest, sy = 1;
    if (t >= d.tr) { const tau = t - d.tr, y0 = rest[1];
      if (d.land != null) { const dh = y0 - d.land, th = EV.hitTau(dh, 0);
        if (tau < th) { pos = [rest[0], y0 - EV.fall(tau, 0), rest[2]]; sy = 1 + Math.min(.5, EV.VT[0] * Math.tanh(EV.G * tau / EV.VT[0]) * .05); }
        else if (d.kind === 'palm') { pos = [rest[0], d.land, rest[2]]; const j = P.jelly(tau - th); o.a2 = j[0] * .8; o.a3 = j[1]; }
        else return o; }
      else { const fc = d.drifting ? P.fieldC(t) : null, fr = d.drifting ? P.fieldC(d.tr) : null;
        pos = [rest[0] + (fc ? fc[0] - fr[0] : 0), y0 - EV.fall(tau, 0), rest[2] + (fc ? fc[2] - fr[2] : 0)];
        if (pos[1] < V.ground(pos[0], pos[2]) + d.r * .5 || tau > 6) return o;
        const v = EV.VT[0] * Math.tanh(EV.G * tau / EV.VT[0]); sy = 1 + Math.min(1.4, v * .085); } }
    // the tremble: a 16 Hz shake, a few centimetres
    if (o.trem > 0) { const a = d.r * 7, k = (.03 + .12 * d.r) * o.trem * Math.sin(TAU * 16 * t); pos = [pos[0] + Math.cos(a) * k, pos[1] + .4 * k, pos[2] + Math.sin(a) * k]; }
    o.pos = pos; o.sy = d.r * sy; o.sx = d.r / Math.sqrt(sy); o.show = true; return o;
  }

  // ------------------------------------------------------------------ GLSL
  // RAIN_CORE: the motion of a hanging drop and its whole life (hang -> tremble -> let go -> fall -> land). Same formulas as
  // hangJS / stateJS above. Needs FILM.events.GLSL (the toll uniforms, fieldC, gustK, fallDist, fallVel, hitTau, C_SOUND,
  // EV_HOLD) and FILM.valley.GLSL (vWob) before it. update() fills its uniforms every frame from globalsAt(t).
  const RAIN_CORE = /* glsl */`
// uPellL / uPellW: Pell's middle at the 8 curtain lags and their spring weights (M10); uFan: each fan (x, y, z, phase offset);
// uCut: a field strand ends this far above the ground (2.5 m); uFieldV: the field's velocity (m/s); uCamVel: the camera's
// velocity (m/s, from set({ camVel }))
uniform vec3 uPellL[8]; uniform float uPellW[8]; uniform vec4 uFan[18]; uniform float uCut; uniform vec3 uFieldV, uCamVel;
uniform int uFanN, uPellN;
// the fans sweep on a 2-beat cycle (M4): on from 23.5 to 35 s; the wind turns toward the Spillway in the gust
float rFansOn(float t){ return smoothstep(23.5, 24.5, t) * (1.0 - smoothstep(33.0, 35.0, t)); }
vec2 rWind(float t){ return normalize(mix(vec2(1.0, 0.075), vec2(0.39, 0.92), smoothstep(36.0, 38.0, t))); }
const float RTAU = 6.2831853;
// loops run to a uniform count (not a constant), so the shader compiler keeps them as loops instead of unrolling them:
// that is most of the difference in shader compile time
// a sound front passing p now: 1 at the moment it arrives, fading over w seconds (any band); the same as FILM.events' evFlash
float rFlash(vec3 p, float t, float w){ float f = 0.0;
  for (int k = 0; k < uEvN; k++) { float d = distance(p, uEv[k].xyz); if (d > uEvP[k].y * 1.15) continue;
    float x = t - uEv[k].w - d / C_SOUND; if (x >= 0.0 && x < w) f = max(f, 1.0 - x / w); }
  return f; }
// bit b of the flags float (GLSL ES 1.0 has no integer bit operators)
float rbit(float f, float b){ return mod(floor(f / exp2(b) + 0.001), 2.0); }
// analytic curl noise, the twin of curl() in JS
vec3 curl3(vec3 p){
  float cx = cos(1.0 * p.y + 0.7 * p.z + 0.3), cy = cos(0.9 * p.z + 1.1 * p.x + 1.7), cz = cos(1.2 * p.x + 0.8 * p.y + 2.9);
  vec3 o = vec3(0.8 * cz - 0.9 * cy, 0.7 * cx - 1.2 * cz, 1.1 * cy - 1.0 * cx);
  vec3 q = p * 2.13 + vec3(4.1, 1.3, 7.7);
  cx = cos(0.8 * q.y + 1.3 * q.z + 0.9); cy = cos(1.2 * q.z + 0.6 * q.x + 2.2); cz = cos(0.7 * q.x + 1.1 * q.y + 0.4);
  o += 0.5 * vec3(1.1 * cz - 1.2 * cy, 1.3 * cx - 0.7 * cz, 0.6 * cy - 0.8 * cx);
  return o * 0.5; }
// where a drop hangs at time t: idle bob, the field's breathing and murmuration (curl noise + shear in the gust), strand sway,
// the fans' dents (M4) and the bead curtain parting round Pell (M10). It is called with t = min(now, tr), and everything but
// where the fans and Pell stand (uniforms of the current frame) comes from t itself, so a drop that let go keeps the place it
// hung at that moment.
// R: rest (field-local when drift = 1), r: radius, seed, ss: strand seed, h: metres below the strand's top (0 = loose),
// cur: how much the curtain parts. The mist defines RAIN_NO_PUSH and skips the fans and the curtain (too many points)
vec3 rainHang(vec3 R, float drift, float r, float seed, float ss, float h, float cur, float t){
  vec3 wp0 = R + drift * fieldC(t); float gu = gustK(t); vec2 wd = rWind(t);
  // idle bob: a strand moves as one, its phase lagging down the strand; a loose drop bobs more the bigger it is
  float ph = h > 0.0 ? ss : seed, amp = h > 0.0 ? 0.03 : 0.03 + 0.4 * r, hp = h * 0.07;
  vec3 m = vec3(0.5 * amp * sin(RTAU * (0.17 + 0.13 * ph) * t + 3.1 * ph + 1.0 - hp), amp * sin(RTAU * (0.25 + 0.2 * ph) * t + 6.28 * ph - hp),
                0.5 * amp * sin(RTAU * (0.13 + 0.11 * ph) * t + 5.3 * ph + 2.0 - hp));
  if (drift > 0.5) {
    // breathing (M3): the edge swells and shrinks in slow lobes, the field stretches and squashes about the 14 m level
    float th = atan(R.z, R.x), br = 0.035 * sin(0.45 * t + 3.0 * th) + 0.025 * sin(0.31 * t - 2.0 * th + 1.3);
    m.xz += R.xz * br; m.y += (R.y - 14.0) * 0.03 * sin(0.37 * t + 2.0 * th + 0.7);
    // murmuration (M3): large slow curl noise, weighted 0.6 in calm air and up to 2.6 in the gust
    m += curl3(vec3(wp0.x * 0.025, wp0.y * 0.025, wp0.z * 0.025 + 0.07 * t)) * 2.0 * (0.3 + gu);
    // gust shear: above the field's middle (19 m) drops lean downwind, below it upwind (at most 5 m)
    float sh = clamp(R.y - 19.0, -20.0, 20.0) * 0.25 * gu; m.xz += wd * sh; }
  // finer curl noise for every drop
  m += curl3(vec3(wp0.x * 0.11 + 0.05 * t, wp0.y * 0.11, wp0.z * 0.11)) * 0.22;
  // strand sway, growing with depth below the top, and the downwind lean of a drifting strand in the gust
  if (h > 0.0) { float a = ss * RTAU, sw = sin(0.55 * t + ss * 9.0 - h * 0.12) * (0.018 + 0.05 * gu) * h;
    m.x += cos(a) * sw; m.z += sin(a) * sw; m.xz += drift * wd * gu * 0.1 * h; }
  vec3 p = wp0 + m;
#ifndef RAIN_NO_PUSH
  // the fans' dents (M4): a gaussian push (sigma about 4 m) within 20 m of each fan, mostly upward, on its 1.5 s sweep
  float fon = rFansOn(t);
  if (fon > 0.0) { vec3 f = vec3(0.0);
    for (int k = 0; k < uFanN; k++) { vec2 d = p.xz - uFan[k].xz; float d2 = dot(d, d); if (d2 > 400.0) continue;
      float v = exp(-d2 / 36.0) * (0.5 + 0.5 * sin(RTAU * t / 1.5 + uFan[k].w)) * exp(-max(0.0, p.y - uFan[k].y - 8.0) / 10.0);
      f += normalize(vec3(d.x * 0.4, 1.0, d.y * 0.4)) * v; }
    p += f * 3.0 * fon; }
  // the bead curtain (M10): pushed sideways away from Pell's recent positions, weighted by the spring
  if (cur > 0.0) { vec2 c = vec2(0.0);
    for (int i = 0; i < uPellN; i++) { vec3 d = p - uPellL[i]; float d2 = dot(d.xz, d.xz); if (d2 > 30.0) continue;
      c += d.xz * (0.8 * uPellW[i] * exp(-d2 / 2.0) * exp(-d.y * d.y / 2.9) / sqrt(d2 + 0.01)); }
    p.xz += c * cur; }
#endif
  return p; }
// the whole life of a drop, given its release time tr and its tremble front aux = (arrival, end). Returns its position;
// st = (state 0 hangs | 1 falls | 2 landed, seconds since release, seconds since landing, tr); trem = 0..1; ph = where it hung.
// gEst: the ground height it lands on (precomputed, aGnd). Before tr: hang and tremble (14-20 Hz, growing through EV_HOLD).
// From tr: start where it hung at tr, keep drifting with the field, fall on the terminal-velocity curve until gEst
vec3 rainState(vec3 R, float drift, float band, float r, float seed, float ss, float h, float cur, float tr, vec2 aux, float gEst, float t, out vec4 st, out float trem, out vec3 ph){
  st = vec4(0.0); trem = 0.0;
  vec3 p = rainHang(R, drift, r, seed, ss, h, cur, min(t, tr)); ph = p;
  float tau = t - tr;
  if (tau < 0.0) { float x = (t - aux.x) / EV_HOLD; trem = (x > 0.0 && x < aux.y) ? x * x : 0.0; float a = seed * 37.0;
    p += vec3(cos(a), 0.4 * sin(a * 1.7), sin(a)) * (0.06 + 0.25 * r) * trem * sin(RTAU * (14.0 + 6.0 * seed) * t);
    st = vec4(0.0, tau, 0.0, tr); return p; }
  float y0 = p.y, th = hitTau(y0 - gEst, band), tt = min(tau, th);
  p.xz += drift * (fieldC(tr + tt).xz - fieldC(tr).xz);
  p.y = y0 - fallDist(tt, band);
  st = vec4(tau < th ? 1.0 : 2.0, tau, tau - th, tr);
  return p; }
// the ground as plain terrace steps (no wall slope, lip, notch or peaks): where a field strand ends (2.5 m above it).
// The twin of groundStep() in JS
float rGroundStep(vec2 p){ float r = length(p), th = atan(p.y, p.x), w = vWob(th), R9 = 40.0 + 148.5 + w * 1.5;
  if (r < 40.0 + w * 0.5) return 0.0; if (r > R9) return 28.8 + 7.2 * smoothstep(0.0, 14.0, r - R9);
  float k = clamp(floor((r - 40.0 - w * 0.5) / 16.5), 0.0, 8.0), rk = 40.0 + 16.5 * k + w * (0.5 + k / 9.0); return r > rk ? 3.2 * (k + 1.0) : 3.2 * k; }
`;

  // 2D drawing helpers for the drop face (coordinates in drop radii, y up on screen; aa = the antialiasing width)
  const DRAW2D = /* glsl */`
// an arc of the circle of radius rr, centred on the angle a0, hw radians to each side, th thick in the middle and tapering
// to points at its ends (the kidney highlight and the far-side light)
float crescent(vec2 p, float a0, float rr, float hw, float th, float aa){ float r = length(p), a = atan(p.y, p.x);
  float da = abs(mod(a - a0 + 3.14159265, 6.2831853) - 3.14159265); float k = 1.0 - (da / hw) * (da / hw); if (k <= 0.0) return 0.0;
  float w = th * sqrt(k); return smoothstep(w + aa, w - aa, abs(r - rr)); }
// a four-point star glint: two long tapered spikes (len) along x and y, two short diagonal ones and a round core
float starShape(vec2 p, float len, float aa){ vec2 a = abs(p); float s = 0.0;
  float t1 = 1.0 - a.y / len, t2 = 1.0 - a.x / len, w1 = 0.07 * t1 + aa * 0.35, w2 = 0.07 * t2 + aa * 0.35;
  if (t1 > 0.0) s = max(s, smoothstep(w1 + aa, w1 - aa, a.x) * (0.4 + 0.6 * t1));
  if (t2 > 0.0) s = max(s, smoothstep(w2 + aa, w2 - aa, a.y) * (0.4 + 0.6 * t2));
  vec2 d = vec2(a.x + a.y, abs(a.x - a.y)) * 0.7071; float t3 = 1.0 - d.x / (len * 0.4), w3 = 0.045 * t3 + aa * 0.3;
  if (t3 > 0.0) s = max(s, smoothstep(w3 + aa, w3 - aa, d.y) * t3 * 0.8);
  return max(s, smoothstep(0.22 + aa, 0.22 - aa, length(p))); }
// a drop-tadpole: a dark comma swimming on a circle inside the drop
float tadpole(vec2 p, float t, float seed, float aa){ float ang = t * (1.3 + seed) + seed * 6.28; vec2 c = vec2(cos(ang), sin(ang) * 0.6) * 0.34;
  vec2 dir = normalize(vec2(-sin(ang), cos(ang) * 0.6)); vec2 q = p - c; float head = smoothstep(0.13 + aa, 0.13 - aa, length(q));
  float al = dot(q, -dir), ac = dot(q, vec2(dir.y, -dir.x)) - 0.05 * sin(al * 22.0 - t * 16.0) * smoothstep(0.0, 0.1, al);
  float w = 0.055 * (1.0 - al / 0.34); float tail = al > 0.0 && al < 0.34 ? smoothstep(w + aa, w - aa, abs(ac)) : 0.0; return max(head, tail); }
// the sun's direction on screen, pulled toward upper left (where an anime drop keeps its highlight)
vec2 hiDir(){ vec3 sv = mat3(viewMatrix) * uSunDir; vec2 s = length(sv.xy) > 1e-3 ? normalize(sv.xy) : vec2(-0.7071, 0.7071); return normalize(s * 0.45 + vec2(-0.7071, 0.7071)); }
`;

  // the drop billboard: every heavy, marble, strand and local bead is one camera-facing quad (alpha to coverage). Each set is
  // drawn in three passes (RAIN_PASS): 0 small drops, streaks and splash crowns (no depth write); 1 drops whose radius on screen
  // is over uLargePx pixels (they write depth, so a near drop covers far ones, depth of field sees it and it gets the ink line);
  // 2 bokeh discs. A drop that is not drawn in a pass is sent off screen (gl_Position outside the clip box).
  // Varyings for the face (DROP_FS): vUV / vS quad coordinates in drop radii (vUV in the streak's axes, vS in screen axes),
  //   vA = (flash, tremble, streak length in radii, 0), vB = (radius px, star glint, seed, band),
  //   vC = (bokeh, tadpole, fade of sub-pixel drops, horizon height), vD = (highlight direction xy, thread, falling).
  //   For a splash crown: vA = (age 0..1, 0, 0, 1), vB = (crown size px, 0, seed, band)
  const DROP_VS = /* glsl */`${E.COMMON}
${EV.GLSL}
${V.GLSL}
${RAIN_CORE}
${DRAW2D}
attribute vec3 aRest; attribute vec4 aInfo; attribute vec4 aLife; attribute vec4 aAux; attribute float aGnd;
uniform float uBokNear, uMinPx, uMaxPx, uStreak, uLargePx;
varying vec2 vUV, vS; varying vec4 vA, vB, vC, vD; varying vec3 vWP;
void main(){
  float band = aInfo.x, r = aInfo.y, seed = aInfo.z, fl = aInfo.w, t = uTime;
  float drift = rbit(fl, 0.0), strand = rbit(fl, 1.0), tad = rbit(fl, 2.0), spl = rbit(fl, 3.0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = vec4(0.0); vB = vec4(0.0); vC = vec4(0.0); vD = vec4(0.0); vUV = vec2(0.0); vS = vec2(0.0); vWP = vec3(0.0);
  if (t < aLife.x || t > aLife.y) return;
  // landed long ago: a cheap early out before the motion. The fall height is overestimated (field base 44 m plus its bob
  // is under 46 m, plus 6 m for the hanging motion) and 0.35 s covers the splash
  if (t - aLife.z > hitTau(aRest.y + drift * 46.0 - aGnd + 6.0, band) + 0.35) return;      // landed long ago
  vec4 st; float trem; vec3 ph;
  // the curtain parts fully round strand beads, 60 % round loose heavy drops, not round marble or mist
  float cur = band < 0.5 ? (strand > 0.5 ? 1.0 : 0.6) : 0.0, h = aLife.w, ss = aAux.z;
  vec3 p = rainState(aRest, drift, band, r, seed, ss, h, cur, aLife.z, aAux.xy, aGnd, t, st, trem, ph);
  // a field strand ends 2.5 m above the ground: beads lower down are not there (a bead that let go while cut stays gone)
  float keep = 1.0;
  if (strand * drift > 0.5) keep = smoothstep(uCut, uCut + 0.7, ph.y - rGroundStep(ph.xz));
  if (keep <= 0.0) return;
  // landed: only splashing drops (not mist) stay, for the 0.25 s of their crown
  if (st.x > 1.5 && (spl < 0.5 || band > 1.5 || st.z > 0.25)) return;
  vec4 mv = viewMatrix * vec4(p, 1.0); float depth = -mv.z; if (depth < 0.06) return;
  float pxm = projectionMatrix[1][1] * uRes.y * 0.5 / depth;       // screen pixels per metre at this depth
  // the white-gold flash: a shimmer as any front passes, full as the drop itself lets go
  float fl2 = st.x > 0.5 ? clamp(1.0 - st.y / 0.2, 0.0, 1.0) : 0.0, flash = max(rFlash(p, t, 0.2) * 0.22, fl2);
  // the radius: swells 40 % in the flash, grows in over 0.12 s when the drop appears (since > 0), shrinks at the strand cut
  float rr = r * keep * (1.0 + 0.4 * fl2) * (aLife.x > 0.0 ? smoothstep(aLife.x, aLife.x + 0.12, t) : 1.0), rpx = rr * pxm;
  // distance LOD: far sub-pixel marble (and local mist) thins out, so the far field reads as rain, not glitter. All are kept
  // up to 56 m away, only a quarter beyond 116 m
  if (band > 0.5 && rpx < 1.0 && fract(seed * 7.31) > clamp(1.7 - depth / 80.0, 0.25, 1.0)) return;
  vWP = p;
  if (st.x > 1.5) {        // splash crown: an upright card on the ground for 0.25 s
#if RAIN_PASS != 0
    return;
#endif
    // the crown is about 3 drop radii wide, kept between 2.5 and 140 px on screen; the card turns to face the camera about
    // the vertical axis and stands from 0.15 below the ground to 1.6 crown sizes above it
    float Rs = 3.2 * r + 0.04, pxs = Rs * pxm; Rs *= clamp(pxs, 2.5, 140.0) / max(pxs, 1e-4);
    vec3 cr = cross(vec3(0.0, 1.0, 0.0), p - cameraPosition); cr = length(cr) > 1e-4 ? normalize(cr) : vec3(1.0, 0.0, 0.0);
    vec2 q = position.xy; float yy = q.y > 0.0 ? 1.6 : -0.15;
    gl_Position = projectionMatrix * viewMatrix * vec4(p + cr * q.x * Rs + vec3(0.0, yy * Rs, 0.0), 1.0);
    vUV = vec2(q.x, yy); vS = vUV; vA = vec4(st.z / 0.25, 0.0, 0.0, 1.0); vB = vec4(Rs * pxm, 0.0, seed, band); return; }
  // bokeh: a hanging drop nearer than uBokNear turns into a soft disc, fully at 0.4 x uBokNear, and grows up to 2.8x.
  // rpxC: the drawn radius in px (at least uMinPx), rv: the same in metres
  float bok = st.x < 0.5 ? smoothstep(uBokNear, uBokNear * 0.4, depth) : 0.0;
  float rpxC = clamp(rpx * (1.0 + 1.8 * bok), uMinPx, mix(uMaxPx * 5.0, uMaxPx, bok)), rv = rpxC / pxm;   // bokeh discs up to uMaxPx, sharp drops up to 5x that
  // which pass draws this drop
#if RAIN_PASS == 0
  if (bok > 0.01 || rpxC > uLargePx) return;
#elif RAIN_PASS == 1
  if (bok > 0.01 || rpxC <= uLargePx) return;
#else
  if (bok <= 0.01) return;
#endif
  // falling: stretch into an anime streak along the screen velocity relative to the camera (head in front, tail behind).
  // hanging strand beads: a thin water thread up to the bead above.
  // A2: the streak's screen direction, L: the tail's length in drop radii
  vec2 A2 = vec2(0.0, 1.0); float L = 0.0, thread = 0.0;
  // the streak: the drop's velocity (falling, drifting with the field, minus the camera's) turned into the rate its screen
  // position changes, ds. Length = how far it moves during the exposure uStreak, at most 40 radii and 320 px
  if (st.x > 0.5) { vec3 vel = vec3(drift * uFieldV.x, -fallVel(st.y, band), drift * uFieldV.z) - uCamVel, vv = mat3(viewMatrix) * vel;
    vec2 ds = (vv.xy * depth + mv.xy * vv.z) / (depth * depth); float sl = length(ds);
    if (sl > 1e-4) { A2 = ds / sl; L = min(min(sl * depth * uStreak / rv, 40.0), 320.0 / rpxC); } }
  // the thread: where the bead above hangs (aAux.w higher, with its own strand sway and lean; the other small motions are
  // taken as equal), seen at this bead's depth. At most 80 radii long
  else if (aAux.w > 0.0 && bok < 0.5) {
    float gu = gustK(t), a = ss * RTAU, k = (0.018 + 0.05 * gu), h1 = max(h - aAux.w, 0.0); vec2 wd = rWind(t) * drift * gu * 0.1 * aAux.w;
    float dsw = sin(0.55 * t + ss * 9.0 - h1 * 0.12) * k * h1 - sin(0.55 * t + ss * 9.0 - h * 0.12) * k * h;
    vec3 pu = p + vec3(cos(a) * dsw - wd.x, aAux.w, sin(a) * dsw - wd.y);
    vec4 mu = viewMatrix * vec4(pu, 1.0); vec2 ds = mu.xy / max(-mu.z, 0.06) * depth - mv.xy; float dl = length(ds);
    if (dl > 1e-5) { A2 = -ds / dl; L = min(dl / rv, 80.0); thread = 1.0; } }
  // four-point star glints that twinkle on the held clock: a glint lasts 2 drawings when the world is live, 4 in silence
  // (6 or 3 steps a second at 12 drawings a second). The chance per step: 3 % heavy, 0.8 % marble, 2 % mist, up to 3.5x
  // more against the sun, and much more in the release flash. A glint fades by half through its step
  float rate = uLive > 0.5 ? 6.0 : 3.0, phs = t * rate + seed * 13.0, hs = h12(vec2(seed * 71.3, floor(phs)));
  float backl = pow(max(dot(normalize(p - cameraPosition), uSunDir), 0.0), 3.0);
  float pS = (band < 0.5 ? 0.03 : band < 1.5 ? 0.008 : 0.02) * (1.0 + 2.5 * backl) + fl2 * 0.35 + flash * 0.1;
  float star = (bok < 0.3 && rpx > 0.7 && (st.x < 0.5 || fl2 > 0.0)) ? step(1.0 - pS, hs) * (1.0 - 0.5 * fract(phs)) : 0.0;
  // the quad: Q radii round the drop (bigger when it carries a star, so the spikes fit), and L more behind it for the tail
  float Q = star > 0.0 ? max(2.7, 3.2 / max(rpxC, 0.5)) : 1.0;
  vec2 q = position.xy; float along = q.y > 0.0 ? Q : -(Q + L), across = q.x * Q;
  vec2 B2 = vec2(A2.y, -A2.x), sOff = A2 * along + B2 * across;
  mv.xy += sOff * rv;
  gl_Position = projectionMatrix * mv;
  // the horizon inside the drop: looking up at a drop it shows mostly sky, looking down mostly ground (a ball lens turns it over)
  float hz = clamp(normalize(p - cameraPosition).y * 1.15, -0.8, 0.8);
  // vUV: (across, along) the streak's axes; vS: the same point in screen axes; vC.z fades drops under about a pixel
  vUV = vec2(across, along); vS = sOff;
  vA = vec4(flash, trem, L, 0.0); vB = vec4(rpxC, star, seed, band); vC = vec4(bok, tad, clamp(rpx / 0.9, 0.55, 1.0), hz); vD = vec4(hiDir(), thread, st.x > 0.5 ? 1.0 : 0.0);
}`;
  // the drop's face, drawn on the quad (see the varyings above DROP_VS)
  const DROP_FS = /* glsl */`${E.COMMON}
${DRAW2D}
uniform vec3 uDropC, uRimC, uFlashC, uGndC, uGndS, uInkC;
varying vec2 vUV, vS; varying vec4 vA, vB, vC, vD; varying vec3 vWP;
void main(){
  // aa: about one pixel in drop radii (the antialiasing width); sun: the light's tint on everything
  float rpx = vB.x, aa = 1.15 / max(rpx, 0.6), seed = vB.z; vec3 c; float a;
  vec3 sun = mix(vec3(0.9, 0.95, 1.0), uSunCol, 0.6);
  if (vA.w > 0.5) {     // splash crown: a ring on the water and six blades that throw droplets
    // ag: the crown's age 0..1 over 0.25 s. The ring is a flat ellipse that widens; each blade rises and falls on a half
    // sine, leans outward, and after a quarter of the crown's life throws a droplet on a little parabola
    float ag = clamp(vA.x, 0.0, 1.0); vec2 q = vUV; float a2 = 1.4 / max(rpx, 1.0);
    float rx = 0.3 + 0.7 * ag, ry = rx * 0.28, e = length(vec2(q.x / rx, q.y / ry));
    float ring = smoothstep(0.16 * (1.0 - ag) + a2 / rx, 0.0, abs(e - 1.0)) * (1.0 - ag * 0.7), bl = 0.0;
    for (int i = 0; i < 6; i++) { float fi = float(i), hsh = h12(vec2(fi, seed * 31.0)), x0 = ((fi + 0.5) / 6.0 - 0.5) * 2.0 * rx * 0.85;
      float hgt = (0.55 + 0.45 * hsh) * sin(3.1416 * min(ag * 1.4, 1.0)), yy = q.y / max(hgt, 1e-3);
      if (yy > 0.0 && yy < 1.0) { float xc = x0 * (1.0 + 0.6 * yy), w = 0.1 * (1.0 - yy) + a2 * 0.4; bl = max(bl, smoothstep(w + a2, w - a2, abs(q.x - xc))); }
      vec2 dp = vec2(x0 * (1.7 + ag), hgt + 0.35 * ag - 0.45 * ag * ag);
      bl = max(bl, smoothstep(0.085 + a2, 0.085 - a2, length(q - dp)) * step(0.25, ag) * (1.0 - ag * 0.6)); }
    a = max(ring, bl); c = mix(uRimC * 0.9, mix(uDropC, vec3(1.0), 0.6) * 1.15, smoothstep(0.0, 0.5, q.y + bl * 0.3)) * sun;
  } else {
    // p: this pixel in drop radii on screen, r: its distance from the centre, body: the drop's disc
    vec2 p = vS; float r = length(p), L = vA.z;
    float body = smoothstep(1.0 + aa, 1.0 - aa, r);
    // the tail: a falling streak (tapered, fading), or the thin thread a strand's beads hang on (vD.z = thread)
    float tailA = 0.0;
    if (L > 0.05 && vUV.y < 0.0) { float u = clamp(-vUV.y / (L + 1.0), 0.0, 1.0);
      if (vD.z > 0.5) { float w = 0.07 + aa * 0.5; tailA = smoothstep(w + aa, w - aa, abs(vUV.x)) * 0.55; }
      else { float w = mix(0.4, 0.03, u) + aa * 0.45; tailA = smoothstep(w + aa, w - aa, abs(vUV.x)) * (1.0 - u) * (0.45 + 0.4 * (1.0 - u)); } }
    // hl: the highlight's direction on screen (toward the sun, pulled to the upper left), a0: its angle
    vec2 hl = vD.xy; float a0 = atan(hl.y, hl.x);
    vec3 hc; float bodyA = 1.0;
    if (rpx < 2.4) {   // a few pixels: a bright silver-cyan point, brightest toward the light
      hc = mix(mix(uDropC, uSkyHor, 0.25) * 1.05, vec3(1.8), smoothstep(0.85, 0.0, length(p - hl * 0.4)) * 0.8);
    } else {
      // inside: the valley upside down. Ground above a bent horizon (its shadow tone at the top), sky below (deeper at the bottom).
      // The horizon sits at vC.w (from the view's tilt) and bends up toward the sides, as through a ball lens
      float hz = vC.w + 0.24 * p.x * p.x;
      float g = smoothstep(hz - aa, hz + aa, p.y);
      vec3 gIn = mix(uGndC, uGndS, smoothstep(hz + 0.42 - aa, hz + 0.42 + aa, p.y));
      vec3 sIn = mix(mix(uSkyHor, vec3(1.0), 0.5) * 1.15, mix(uSkyHor, uSkyTop, 0.45), smoothstep(hz - 0.55 + aa, hz - 0.55 - aa, p.y));
      hc = mix(mix(sIn, gIn, g), uDropC, 0.3);
      // the tadpole, once the drop is big enough on screen to read it (over 9 px)
      if (vC.y > 0.5 && rpx > 9.0) hc = mix(hc, uInkC, tadpole(p, uTime, seed, aa) * 0.85);
      // light gathered on the far side: a bright crescent inside the rim, opposite the highlight
      hc = mix(hc, mix(uDropC, vec3(1.0), 0.55) * 1.15, crescent(p, a0 + 3.14159, 0.76, 0.95, 0.08, aa) * 0.8);
      // the rim: a thin darker cyan line, heavier away from the light (about 1.2-2.9 px, whatever the drop's size)
      float side = clamp(dot(p / max(r, 1e-3), -hl), 0.0, 1.0), rw = min((1.2 + 1.7 * side) / rpx + 0.025, 0.3);
      float rim = smoothstep(1.0 - rw - aa, 1.0 - rw + aa * 0.5, r);
      hc = mix(hc, uRimC * 0.55, rim);
      // kidney highlight toward the light, a small glint opposite
      float kid = crescent(p, a0, 0.6, 0.5, 0.115, aa), dot2 = smoothstep(0.085 + aa, 0.085 - aa, length(p + hl * 0.58));
      hc = mix(hc, vec3(1.45), kid); hc = mix(hc, vec3(1.3), dot2);
      // the body is clear: the picture behind shows through, the rim and highlights do not
      // (72 % alpha; with alpha to coverage that is a fine dither over the scene, no sorting needed)
      bodyA = mix(0.72, 1.0, max(max(rim, kid), dot2));
    }
    // the tail's colour (a thread is paler and dimmer than a streak), then whichever of drop and tail is stronger wins
    vec3 tc = mix(uDropC, vec3(1.0), vD.z > 0.5 ? 0.15 : 0.4) * (vD.z > 0.5 ? 0.95 : 1.1);
    c = (body >= tailA ? hc : tc); a = max(body * bodyA, tailA);
    // a trembling drop turns silver-white (M6); the release flash fills the drop with white gold, solid
    c = mix(c, vec3(1.3), vA.y * 0.35);
    c = mix(c, mix(uFlashC, vec3(1.0), 0.35) * 1.3, vA.x * 0.8 * smoothstep(0.98, 0.7, r)); a = max(a, body * vA.x);
    // near the lens: a soft bokeh disc with a brighter edge
    if (vC.x > 0.0) { float bd = smoothstep(1.0, 0.86, r), ring = smoothstep(0.66, 0.95, r) * bd;
      vec3 bc = mix(uDropC, vec3(1.0), 0.22 + 0.35 * ring) * (0.95 + 0.3 * ring) * (1.0 + 0.3 * vA.x);
      c = mix(c, bc, vC.x); a = mix(a, bd * (0.28 + 0.32 * ring), vC.x); }
    // the star glint, centred on the highlight side, shrinking as it fades
    if (vB.y > 0.0) { float s = starShape(p - hl * 0.36, 2.4 * (0.55 + 0.45 * vB.y), aa); c = mix(c, vec3(1.9), s); a = max(a, s); }
    a *= vC.z; c *= sun;
  }
  // alpha to coverage: what is nearly clear is dropped, the rest is dithered by the multisample mask
  if (a < 0.02) discard;
  c = fogApply(c, vWP);
  gl_FragColor = vec4(c, a);
}`;

  // mist points: 1-3 px dots that twinkle, and sink slowly (2.2 m/s at most) when an E lets them go. Drawn as gl.POINTS, one
  // vertex each (92,000), with the cheap motion (RAIN_NO_PUSH: no fans, no curtain) and no tremble.
  // vM = (flash, twinkle, distance fade 0..1 over 400 m, state)
  const MIST_VS = /* glsl */`${E.COMMON}
${EV.GLSL}
${V.GLSL}
${RAIN_CORE}
attribute vec4 aInfo; attribute float aGnd; varying vec4 vM; varying vec3 vWP;
void main(){
  float tr = aInfo.x, r = aInfo.y, seed = aInfo.z, drift = rbit(aInfo.w, 0.0), t = uTime;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vM = vec4(0.0); vWP = vec3(0.0);
  // landed long ago (the same cheap early out as the drops)
  if (t - tr > hitTau(position.y + drift * 46.0 - aGnd + 6.0, 2.0) + 0.1) return;
  vec4 st; float trem; vec3 ph;
  vec3 p = rainState(position, drift, 2.0, r, seed, seed, 0.0, 0.0, tr, vec2(1e9, 0.0), aGnd, t, st, trem, ph);
  vWP = p;
  if (st.x > 1.5) return;
  vec4 mv = viewMatrix * vec4(p, 1.0); float depth = -mv.z; if (depth < 0.1) return;
  // a flash as a front passes, a stronger one for 0.35 s as the point itself lets go
  float flash = max(rFlash(p, t, 0.25) * 0.35, st.x > 0.5 ? clamp(1.0 - st.y / 0.35, 0.0, 1.0) : 0.0);
  // size: as if 3 cm across, kept between 1 and 2.6 px, varied per point; a twinkle (1.2 % of points per held step) adds 1.6 px
  float px = clamp(0.03 * projectionMatrix[1][1] * uRes.y * 0.5 / depth, 1.0, 2.6) * (0.75 + 0.5 * seed);
  float tw = step(0.988 - flash * 0.3, h12(vec2(seed * 53.1, floor(t * (uLive > 0.5 ? 6.0 : 3.0) + seed * 7.0))));
  gl_PointSize = px + tw * 1.6 + flash * 1.2;
  gl_Position = projectionMatrix * mv;
  vM = vec4(flash, tw, clamp(depth / 400.0, 0.0, 1.0), st.x);
}`;
  // a soft round dot: pale cyan, white when it twinkles, white gold in the flash; falling mist is a little brighter, far
  // mist fainter
  const MIST_FS = /* glsl */`${E.COMMON}
uniform vec3 uDropC, uFlashC; varying vec4 vM; varying vec3 vWP;
void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.45, d);
  vec3 c = mix(mix(uDropC, vec3(1.0), 0.45), vec3(1.6), vM.y) * mix(vec3(0.9, 0.95, 1.0), uSunCol, 0.5);
  c = mix(c, uFlashC * 1.8, vM.x);
  a *= (0.36 + 0.5 * vM.y + 0.4 * vM.x + 0.15 * vM.w) * (1.0 - 0.45 * vM.z);
  c = fogApply(c, vWP); gl_FragColor = vec4(c, a); }`;

  // the field's body: painted translucent cloudlets, cel-lit (sun-side pale, shade side cool lilac-blue) with a lumpy cumulus
  // edge. They show from afar and fade out as the camera comes close (then the drops themselves carry the picture).
  // One camera-facing quad per cloudlet, its centre moving like a drop of the field (rainHang).
  // vH = (visibility, seed, band, how far above the camera it is seen: 0 level, 1 overhead)
  const BODY_VS = /* glsl */`${E.COMMON}
${EV.GLSL}
${V.GLSL}
${RAIN_CORE}
attribute vec4 aBody; attribute vec4 aBody2; varying vec2 vUV; varying vec4 vH; varying vec3 vWP, vSunV;
void main(){ float t = uTime, rad = aBody.w, seed = aBody2.x, band = aBody2.y, tr = aBody2.z;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vH = vec4(0.0); vUV = vec2(0.0); vWP = vec3(0.0); vSunV = vec3(0.0, 1.0, 0.0);
  vec3 c = rainHang(aBody.xyz, 1.0, 0.0, seed, seed, 0.0, 0.0, min(t, tr));
  float tau = max(t - tr, 0.0); c.y -= fallDist(min(tau, 2.0), band) * 0.35;           // the mass slumps after its rain as it thins
  // it fades once its band is rung down: over 1.8 s (heavy, marble) or 5 s (the slow mist)
  float alive = 1.0 - smoothstep(0.0, band > 1.5 ? 5.0 : 1.8, t - tr);
  vec4 mv = viewMatrix * vec4(c, 1.0); float depth = -mv.z;
  // and as the camera comes nearer than 7 radii (gone at 3)
  float near = smoothstep(rad * 3.0, rad * 7.0, depth);
  if (alive * near <= 0.001) return;
  float rr = rad * (1.0 + 0.07 * sin(t * 0.5 + seed * 9.0));                             // breathing
  mv.xy += position.xy * rr; gl_Position = projectionMatrix * mv;
  // seen from below (the sine of its elevation from 0.12 to 0.55), a cloudlet is mostly in its own shade
  float below = smoothstep(0.12, 0.55, (c.y - cameraPosition.y) / max(length(c - cameraPosition), 1.0));
  vUV = position.xy; vH = vec4(alive * near, seed, band, below); vWP = c; vSunV = mat3(viewMatrix) * uSunDir; }`;
  const BODY_FS = /* glsl */`${E.COMMON}
uniform vec3 uBodyLit, uBodyShade; uniform float uBodyK; varying vec2 vUV; varying vec4 vH; varying vec3 vWP, vSunV;
void main(){ float d = length(vUV); if (d > 1.0 || vH.x <= 0.0) discard;
  // the lumpy outline: the distance from the centre pushed in and out by two noise lookups (n drifts slowly with time)
  float seed = vH.y, n = nz(vUV * 0.3 + seed * 7.13 + vec2(uTime * 0.004, 0.0)), n2 = nzA(vUV * 0.55 + seed * 3.1);
  float sh = d + (n - 0.5) * 0.8 + (n2 - 0.5) * 0.3;
  float m = smoothstep(0.93, 0.86, sh); if (m <= 0.0) discard;
  float edge = smoothstep(0.8, 0.88, sh) * m;
  // cel light on a fake sphere normal: a hard terminator (noise-broken) between the lit and the shade tone. Higher bands
  // are paler, and a cloudlet seen from below stays mostly in shade
  vec3 nv = normalize(vec3(vUV * 1.15, sqrt(max(0.0, 1.0 - d * d)) + 0.15));
  float ndl = dot(nv, normalize(vSunV)) + (n2 - 0.5) * 0.55;
  float lit = smoothstep(-0.03, 0.03, ndl) * (1.0 - 0.75 * vH.w);
  vec3 lc = mix(uBodyLit * vec3(0.82, 0.94, 1.0), mix(uBodyLit, vec3(1.0), 0.35), vH.z * 0.5), sc = mix(uBodyShade * vec3(0.78, 0.9, 1.0), uBodyShade * 1.12, vH.z * 0.5);
  vec3 c = mix(sc, lc, lit);
  // darker toward the bottom, a warm rim light just inside the lit edge
  c *= mix(0.82, 1.0, smoothstep(-0.7, 0.2, vUV.y + (n - 0.5) * 0.4) * 0.5 + vH.z * 0.25);
  c += uRimCol * smoothstep(0.62, 0.8, sh) * lit * 0.3;
  c = mix(c, uBodyShade * 0.78, edge * 0.55);                                               // a darker cyan line round each lump
  // glints: a few tiny stars per lump that twinkle on the held clock (a 12 x 12 grid over the quad, 14 % of its cells lit
  // at a time, each dot placed at random in its cell, changing 6 times a second)
  vec2 gq = vUV * 6.0 + seed * 17.0, gi = floor(gq), gf = fract(gq) - 0.5; float gh = h12(gi + floor(uHeld * 6.0) * 0.37 + seed);
  float gs = step(0.86, gh) * smoothstep(0.07, 0.0, length(gf - (vec2(h12(gi + 1.3), h12(gi + 2.7)) - 0.5) * 0.6)) * (1.0 - vH.w * 0.5);
  c = mix(c, vec3(1.6), gs);
  c = mix(c, fogApply(c, vWP), 0.6);
  // alpha: the body's opacity uBodyK (set({ body })), the edge line and the glints, all times the visibility
  gl_FragColor = vec4(c, (m * uBodyK * (0.85 + 0.15 * vH.z) * (1.0 - 0.35 * vH.w) + gs * 0.6 + edge * uBodyK * 0.6) * vH.x); }`;

  // sound ring: an expanding shell drawn as a crisp line where it is seen edge-on, a faint glow inside it, added on top.
  // Where the shell passes through the field (from its base to about 35 m above) it shimmers in noise patches, so seen from
  // below a ring of release reads as a band of light. uA: strength, uFieldY: the field's base height, uRad: the radius (m)
  const RING_VS = /* glsl */`varying vec3 vN, vWP; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWP = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
  const RING_FS = /* glsl */`${E.COMMON}
uniform float uA, uFieldY, uRad, uShim; uniform vec3 uRingC; varying vec3 vN, vWP;
void main(){ vec3 V = normalize(cameraPosition - vWP); float fr = 1.0 - abs(dot(normalize(vN), V));
  // fr: 1 where the shell is seen edge-on (its outline), 0 where it faces the camera
  float inF = smoothstep(uFieldY - 1.0, uFieldY + 2.0, vWP.y) * smoothstep(uFieldY + 40.0, uFieldY + 30.0, vWP.y);
  float sp = nz(vWP.xz * 0.11 + vWP.y * 0.05 + uRad * 0.02) * nzA(vWP.zx * 0.23 - uRad * 0.03);
  float shim = inF * (0.35 + 1.6 * smoothstep(0.32, 0.5, sp)) * (0.25 + 0.75 * fr) * uShim;
  float a = (smoothstep(0.955, 0.99, fr) * 2.2 + pow(fr, 5.0) * 0.5 + shim) * uA; gl_FragColor = vec4(uRingC, a); }`;
  // star sparkles riding on the voice shells: 3,600 points spread evenly over a unit sphere, scaled to the shell. Each
  // twinkles 12 times a second (about half are lit at a time) and only near the shell's outline, where it is seen edge-on
  const SPARK_VS = /* glsl */`${E.COMMON}
attribute float aSeed; uniform vec3 uSrc; uniform float uRad, uA; varying float vK;
void main(){ vec3 p = uSrc + position * uRad; vec4 mv = viewMatrix * vec4(p, 1.0); float depth = -mv.z;
  float fr = 1.0 - abs(dot(position, normalize(cameraPosition - p)));
  float tw = h12(vec2(aSeed * 91.7, floor(uTime * 12.0))); vK = uA * step(0.45, tw) * (0.5 + tw) * smoothstep(0.55, 0.92, fr);
  gl_PointSize = depth > 0.1 ? clamp(260.0 / depth, 2.0, 7.0) * (0.6 + tw) : 0.0; gl_Position = projectionMatrix * mv; }`;
  // a small four-point star in the point sprite
  const SPARK_FS = /* glsl */`uniform vec3 uRingC; varying float vK;
void main(){ vec2 q = abs(gl_PointCoord - 0.5) * 2.0; float s = max(smoothstep(0.3, 0.0, q.x) * (1.0 - q.y), smoothstep(0.3, 0.0, q.y) * (1.0 - q.x)); s = max(s, smoothstep(0.35, 0.1, length(q)));
  gl_FragColor = vec4(uRingC * 1.6, s * vK); }`;

  // ------------------------------------------------------------------ materials and meshes
  const C3 = E.col;
  // the rain's own uniforms. Every rain material shares these same objects, so update() and set() change them all at once:
  //   Pell and the fans (filled by update), the strand cut, field and camera velocity, the look options of set()
  //   (uBokNear m, uMinPx / uMaxPx radius in px, uStreak s, uLargePx: the radius in px above which a drop goes to pass 1),
  //   the colours, and uBodyK (the body's opacity)
  const RU = {
    uPellL: { value: Array.from({ length: 8 }, () => new THREE.Vector3(0, -1e4, 0)) }, uPellW: { value: LAGW.slice() },
    uFan: { value: Array.from({ length: 18 }, () => new THREE.Vector4(0, -1e4, 0, 0)) }, uFanN: { value: 18 }, uPellN: { value: 8 }, uCut: { value: STRAND.cut }, uFieldV: { value: new THREE.Vector3() }, uCamVel: { value: new THREE.Vector3() },
    uBokNear: { value: 1.6 }, uMinPx: { value: .8 }, uMaxPx: { value: 90 }, uStreak: { value: .075 }, uLargePx: { value: 10 },
    uDropC: { value: C3(COL.drop) }, uRimC: { value: C3(COL.rim) }, uFlashC: { value: C3(COL.flash) }, uGndC: { value: C3(COL.gnd) }, uGndS: { value: C3(COL.gndShade) }, uInkC: { value: C3(COL.ink) },
    uBodyLit: { value: C3(COL.bodyLit) }, uBodyShade: { value: C3(COL.bodyShade) }, uBodyK: { value: .2 },
  };
  // a material's uniforms: the film's shared ones (FILM.U: time, sun, sky, the toll table ...) plus the rain's
  const uni = (extra = {}) => Object.assign({}, F.U, RU, extra);
  let mistMat, bodyMat; const dropMats = [];
  const meshes = {};
  // one quad (the corners -1..1) instanced once per drop of a set, with the set's arrays as per-instance attributes
  function quadGeo(set) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aRest', new THREE.InstancedBufferAttribute(set.rest.subarray(0, set.n * 3), 3));
    g.setAttribute('aInfo', new THREE.InstancedBufferAttribute(set.info.subarray(0, set.n * 4), 4));
    g.setAttribute('aLife', new THREE.InstancedBufferAttribute(set.life.subarray(0, set.n * 4), 4));
    g.setAttribute('aAux', new THREE.InstancedBufferAttribute(set.aux.subarray(0, set.n * 4), 4));
    g.setAttribute('aGnd', new THREE.InstancedBufferAttribute(set.gnd.subarray(0, set.n), 1));
    g.instanceCount = set.n; return g;
  }
  // a drop set as three meshes on one geometry, one per pass (rain-NAME, rain-NAME-near, rain-NAME-bokeh). All sets share
  // the three materials. Alpha to coverage with no blending: the drops need no sorting, and pass 1 can write depth.
  // Draw order: pass 0 at `order` (marble 3, the others 4), pass 1 at 6, the bokeh at 8 (the sound rings draw at 5).
  // Called again for the same name (addBeads after the build), it replaces the old meshes
  function dropMesh(scene, name, set, order = 4) {
    if (!dropMats.length) { const u = uni(); for (let k = 0; k < 3; k++) dropMats.push(new THREE.ShaderMaterial({ uniforms: u, vertexShader: DROP_VS, fragmentShader: DROP_FS, defines: { RAIN_PASS: k },
      transparent: true, depthWrite: k === 1, alphaToCoverage: true, blending: THREE.NoBlending })); }
    if (meshes[name]) { for (const m of meshes[name]) scene.remove(m); meshes[name][0].geometry.dispose(); }
    const g = quadGeo(set), list = [];
    for (let k = 0; k < 3; k++) { const m = new THREE.Mesh(g, dropMats[k]); m.frustumCulled = false; m.renderOrder = [order, 6, 8][k] + (k ? order * .01 : 0); m.name = 'rain-' + name + (k ? '-' + ['', 'near', 'bokeh'][k] : ''); scene.add(m); list.push(m); }
    return (meshes[name] = list); }
  // load step 1: generate the field and add its meshes (draw order: body 1, mist 2, marble 3, heavy and strands 4)
  function buildField(scene) {
    genField();
    dropMesh(scene, 'marble', sets.marble, 3); dropMesh(scene, 'big', sets.big, 4);
    // mist: points (the rest positions are the point positions; the shader moves them)
    const ms = sets.mist, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(ms.rest, 3)); g.setAttribute('aInfo', new THREE.BufferAttribute(ms.info, 4)); g.setAttribute('aGnd', new THREE.BufferAttribute(ms.gnd, 1));
    mistMat = new THREE.ShaderMaterial({ uniforms: uni(), defines: { RAIN_NO_PUSH: 1 }, vertexShader: MIST_VS, fragmentShader: MIST_FS, transparent: true, depthWrite: false });
    const pts = new THREE.Points(g, mistMat); pts.frustumCulled = false; pts.renderOrder = 2; pts.name = 'rain-mist'; scene.add(pts); meshes.mist = pts;
    // the body
    const bd = sets.body, hg = new THREE.InstancedBufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)); hg.setIndex([0, 1, 2, 0, 2, 3]);
    hg.setAttribute('aBody', new THREE.InstancedBufferAttribute(bd.a, 4)); hg.setAttribute('aBody2', new THREE.InstancedBufferAttribute(bd.b, 4)); hg.instanceCount = bd.n;
    bodyMat = new THREE.ShaderMaterial({ uniforms: uni(), vertexShader: BODY_VS, fragmentShader: BODY_FS, transparent: true, depthWrite: false });
    const hm = new THREE.Mesh(hg, bodyMat); hm.frustumCulled = false; hm.renderOrder = 1; hm.name = 'rain-body'; scene.add(hm); meshes.body = hm;
    selfCheck();
  }
  // the release times stored per drop must be exactly FILM.events.releaseTime's (64 probes in set 'big', warned in the
  // console if not; R.checkBad = how many differ, 0 when all is well)
  function selfCheck() { const S = sets.big; let bad = 0;
    for (let k = 0; k < S.n; k += Math.max(1, Math.floor(S.n / 64))) { const tr = EV.releaseTime([S.rest[k * 3], S.rest[k * 3 + 1], S.rest[k * 3 + 2]], true, 0, S.info[k * 4 + 2], -1);
      if (Math.abs(Math.min(tr, 1e8) - Math.min(S.life[k * 4 + 2], 1e8)) > 2e-3) bad++; }
    if (bad) console.warn('rain: ' + bad + ' release times differ from FILM.events.releaseTime'); R.checkBad = bad; }
  // load step 2: the village's drops
  function buildLocal(scene) { genLocal(); dropMesh(scene, 'local', sets.local, 4); }
  // hero drops: one instanced glass mesh, jelly modes about the contact normal (+y). Inside: what lies behind the drop, upside
  // down and minified (a ball lens), so each holds an inverted miniature of the valley; anime highlights drawn over it.
  //   aHero (per instance, written by updateHero) = (a2, a3 jelly amplitudes, tremble, tadpole 0/1)
  //   vdeform: r(theta) = 1 + a2 P2(cos theta) + a3 P3(cos theta), theta from +y (bible M5); vCC = the drop centre in clip space
  //   fpost (after E.glass's own refraction): the scene picture (tScene) sampled at the drop's centre minus this pixel's
  //     offset, i.e. turned through the centre, scaled by uInvK (set({ invert })) and widened toward the rim; toward the rim
  //     it blends into a painted inverted valley (ground over sky, as on the small drops). Then the deep rim, fog, the far-side
  //     light, the rim line, the kidney highlight, the glint, the tremble's whitening and the tadpole
  // The glass draws in E.GLASS's own pass (E.render), which samples the finished opaque picture
  let hero, heroAttr, heroDepth;
  // load step 3
  function buildHero(scene) {
    const geo = new THREE.IcosahedronGeometry(1, 14);      // fine enough for a clean silhouette when one fills the screen (S01)
    heroAttr = new THREE.InstancedBufferAttribute(new Float32Array(HERO.length * 4), 4); heroAttr.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('aHero', heroAttr);
    const mat = E.glass({ tint: '#d8f6ff', edge: COL.rim, deep: '#3f9cc8', ior: .34, spec: 1.1,
      vpars: 'attribute vec4 aHero; varying vec4 vHero; varying vec4 vCC;',
      vdeform: `vHero = aHero; float ct = normalize(position).y; transformed = position * (1.0 + aHero.x * 0.5 * (3.0 * ct * ct - 1.0) + aHero.y * 0.5 * (5.0 * ct * ct * ct - 3.0 * ct));
        vCC = projectionMatrix * viewMatrix * modelMatrix *
        #ifdef USE_INSTANCING
          instanceMatrix *
        #endif
          vec4(0.0, 0.0, 0.0, 1.0);`,
      fpars: 'varying vec4 vHero; varying vec4 vCC; uniform vec3 uInkH, uGndC, uGndS; uniform float uInvK;\n' + DRAW2D,
      fpost: `{ vec2 p = vn.xy; float rr = length(p), aa = clamp(fwidth(rr) * 1.2, 0.002, 0.05);
        vec2 cs = vCC.xy / vCC.w * 0.5 + 0.5, asp = vec2(uResG.y / uResG.x, 1.0);
        vec3 img = texture2D(tScene, clamp(cs - p * asp * uInvK * (1.0 + 0.35 * rr * rr), 0.002, 0.998)).rgb;
        float hz = clamp(normalize(vWP - cameraPosition).y * 1.15, -0.8, 0.8) + 0.24 * p.x * p.x, gb = smoothstep(hz - aa, hz + aa, p.y);
        vec3 wide = mix(mix(mix(uSkyHor, vec3(1.0), 0.5) * 1.1, mix(uSkyHor, uSkyTop, 0.45), smoothstep(hz - 0.5 + aa, hz - 0.5 - aa, p.y)),
                        mix(uGndC, uGndS, smoothstep(hz + 0.42 - aa, hz + 0.42 + aa, p.y)), gb);
        c = mix(img, wide, smoothstep(0.38, 0.8, rr) * 0.8) * mix(vec3(1.0), uTint, 0.5) * 1.05;
        c = mix(c, uDeep * 0.85, smoothstep(0.6, 0.97, rr) * 0.5);
        c = mix(c, fogApply(c, vWP), 0.35);
        vec2 hl = hiDir(); float a0 = atan(hl.y, hl.x);
        c = mix(c, mix(uTint, vec3(1.0), 0.5) * 1.35, crescent(p, a0 + 3.14159, 0.78, 1.0, 0.07, aa) * 0.6);
        float rw = max(2.6 * fwidth(rr), 0.012); c = mix(c, uEdge * 0.55, smoothstep(1.0 - rw - aa, 1.0 - rw, rr) * 0.9);
        c = mix(c, vec3(1.2) * uSunCol, crescent(p, a0, 0.6, 0.5, 0.1, aa));
        c = mix(c, vec3(1.15), smoothstep(0.075 + aa, 0.075 - aa, length(p + hl * 0.58)));
        c = mix(c, vec3(1.25), vHero.z * 0.4);
        if (vHero.w > 0.5) c = mix(c, uInkH, tadpole(p * 1.25, uTime, 0.37, aa) * 0.9); }`,
      uniforms: { uInkH: { value: C3(COL.ink) }, uInvK: { value: .3 }, uGndC: RU.uGndC, uGndS: RU.uGndS } });
    hero = new THREE.InstancedMesh(geo, mat, HERO.length); hero.instanceMatrix.setUsage(THREE.DynamicDrawUsage); hero.frustumCulled = false; hero.layers.set(E.GLASS); hero.name = 'rain-hero';
    scene.add(hero);
    // a depth-only stand-in drawn with the opaque scene (layer 0): the same jelly shape, 1.5 % smaller. It puts the drops in
    // the scene's depth, so depth of field and the ink lines know them, while the glass shell itself stays just in front of
    // that depth and is not discarded by the glass pass's depth test. It shares the hero mesh's instance matrices
    const dm = new THREE.ShaderMaterial({ colorWrite: false, depthWrite: true, transparent: true, blending: THREE.NoBlending,
      vertexShader: `attribute vec4 aHero; void main(){ vec3 transformed = position; float ct = normalize(position).y;
        transformed *= 0.985 * (1.0 + aHero.x * 0.5 * (3.0 * ct * ct - 1.0) + aHero.y * 0.5 * (5.0 * ct * ct * ct - 3.0 * ct));
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(transformed, 1.0); }`, fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); }' });
    heroDepth = new THREE.InstancedMesh(geo, dm, HERO.length); heroDepth.instanceMatrix = hero.instanceMatrix; heroDepth.frustumCulled = false; heroDepth.name = 'rain-hero-depth'; heroDepth.renderOrder = 999;
    scene.add(heroDepth);
  }
  const mtx = new THREE.Matrix4(), qI = new THREE.Quaternion(), vP = new THREE.Vector3(), vS = new THREE.Vector3();
  // every frame: each hero drop's position and stretch into its instance matrix, its jelly / tremble / tadpole into aHero
  // (a hidden drop gets scale 0 and sits far below the ground)
  function updateHero(t) { if (!hero) return;
    HERO.forEach((d, i) => { const s = heroAt(d, t); vP.set(...s.pos); vS.set(s.sx, s.sy, s.sx); mtx.compose(vP, qI, vS); hero.setMatrixAt(i, mtx);
      heroAttr.setXYZW(i, s.a2, s.a3, s.trem, d.tad ? 1 : 0); });
    hero.instanceMatrix.needsUpdate = true; heroAttr.needsUpdate = true; }
  // sound rings: a pool of four shells (each with a second, fainter crest just behind it), two sparkle shells for the voice.
  // Only the tolls that reach the field get a ring (reach > 30 m: the drum, the chimes, the cupola bells, the voice, Tock)
  const RING_EV = EV.T.filter(e => e.reach > 30), VOICE = new Set(['voiceA', 'voiceD']);
  const rings = [], sparks = [];
  // load step 4: 8 shell meshes (unit spheres, scaled each frame) and 2 sparkle point clouds, hidden until a toll sounds.
  // The sparkle points lie on a Fibonacci sphere (golden-angle spiral), evenly spread
  function buildRings(scene) {
    const sg = new THREE.SphereGeometry(1, 72, 36);
    for (let i = 0; i < 8; i++) { const m = new THREE.Mesh(sg, new THREE.ShaderMaterial({ uniforms: Object.assign({}, F.U, { uA: { value: 0 }, uFieldY: { value: 44 }, uRad: { value: 0 }, uShim: { value: 1 }, uRingC: { value: C3('#FFF3C8') } }), vertexShader: RING_VS, fragmentShader: RING_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      m.frustumCulled = false; m.renderOrder = 5; m.visible = false; m.name = 'rain-ring' + i; scene.add(m); rings.push(m); }
    const n = 3600, pos = new Float32Array(n * 3), sd = new Float32Array(n);
    for (let i = 0; i < n; i++) { const y = 1 - 2 * (i + .5) / n, rr = Math.sqrt(1 - y * y), a = i * 2.39996; pos.set([Math.cos(a) * rr, y, Math.sin(a) * rr], i * 3); sd[i] = A.hash(i, 9); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
    for (let i = 0; i < 2; i++) { const m = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: Object.assign({}, F.U, { uSrc: { value: new THREE.Vector3() }, uRad: { value: 1 }, uA: { value: 0 }, uRingC: { value: C3('#FFF3C8') } }),
        vertexShader: SPARK_VS, fragmentShader: SPARK_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.frustumCulled = false; m.renderOrder = 5; m.visible = false; m.name = 'rain-spark' + i; scene.add(m); sparks.push(m); }
  }
  // every frame: the sounding tolls, newest first, take the four shell slots. A shell's radius is 30 m/s x (t - t0) (the
  // second crest 1.6 m behind); it fades in over 0.06 s and out over the last 30 % of its reach. The voice is 4x as bright,
  // warm and with less shimmer; the others are tinted by band (heavy gold, marble cyan, mist green-white)
  function updateRings(t) {
    const act = RING_EV.filter(e => t >= e.t0 && t < e.t0 + e.reach / CS + .2).sort((a, b) => b.t0 - a.t0);
    for (let i = 0; i < 4; i++) { const e = act[i];
      for (let j = 0; j < 2; j++) { const m = rings[i * 2 + j]; m.visible = !!e; if (!e) continue;
        const rad = Math.max(.05, CS * (t - e.t0) - j * 1.6), v = VOICE.has(e.id) ? 4 : 1;
        m.position.set(...e.src); m.scale.setScalar(rad); m.updateMatrixWorld();
        m.material.uniforms.uA.value = .08 * v * (j ? .45 : 1) * (1 - A.sm(e.reach * .7, e.reach, rad)) * A.sm(0, .06, t - e.t0);
        m.material.uniforms.uFieldY.value = P.fieldC(t)[1]; m.material.uniforms.uRad.value = rad; m.material.uniforms.uShim.value = v > 1 ? .3 : 1;
        m.material.uniforms.uRingC.value.set(v > 1 ? '#FFE9B8' : e.band === 0 ? '#FFF3C8' : e.band === 1 ? '#E9FBFF' : '#F4FFF8'); } }
    const va = act.filter(e => VOICE.has(e.id));
    sparks.forEach((m, i) => { const e = va[i]; m.visible = !!e; if (!e) return; const rad = Math.max(.05, CS * (t - e.t0)), U = m.material.uniforms;
      U.uSrc.value.set(...e.src); U.uRad.value = rad; U.uA.value = (1 - A.sm(e.reach * .6, e.reach, rad)) * A.sm(0, .05, t - e.t0); });
  }
  const tmpV = new THREE.Vector3(), tmpD = new THREE.Vector3(), tmpW = new THREE.Vector3();
  // the voice rings as they pass the camera, for the engine's look.shock: [[cx, cy, radius in screen heights, strength], ...]
  // (cx, cy: the source on screen, 0..1). A shell is skipped once it reaches the camera or when its source is behind it.
  // Its screen radius is the tangent of the half-angle it subtends over the screen's height in tangents; the strength fades
  // in over 0.05 s, and out as the shell nears the camera or grows past 2.5 screen heights. The 2 strongest are returned.
  // cam must already be placed (position, fov and matrices for this frame)
  function shock(t, cam) { const out = []; if (!cam || !cam.isCamera) return out;
    const ty = Math.tan(cam.fov * Math.PI / 360); cam.getWorldDirection(tmpD);
    for (const e of EV.T) { if (!VOICE.has(e.id)) continue; const rad = CS * (t - e.t0); if (rad <= 0 || rad > e.reach) continue;
      tmpV.set(...e.src); const D = tmpV.distanceTo(cam.position); if (rad >= D * .98) continue;
      if (tmpW.copy(tmpV).sub(cam.position).dot(tmpD) <= 0) continue;
      const sr = Math.tan(Math.asin(rad / D)) / (2 * ty); tmpV.project(cam);
      const str = .5 * A.sm(0, .05, t - e.t0) * (1 - A.sm(.8, .98, rad / D)) * (1 - A.sm(2.5, 4, sr));
      if (str > .01) out.push([tmpV.x * .5 + .5, tmpV.y * .5 + .5, Math.min(sr, 4), str]); }
    return out.sort((a, b) => b[3] - a[3]).slice(0, 2); }

  // ------------------------------------------------------------------ beads from other modules (chimewing drizzle, laughter)
  // bead = { p:[x,y,z] world, ts (appears), tr (lets go; omitted: the toll table decides, counting only sounds after ts),
  //          band 0|1|2, size (radius, m), seed, until }
  // Defaults: band 2 (mist), size 8 cm / 2 cm / 6 mm by band, seed from the position. Beads are loose and world-fixed.
  // Other modules may call addBeads while they build; finalize() turns everything gathered so far into one set ('beads').
  // A call after that rebuilds the whole set at once
  const pending = [];
  const built = { beads: false, scene: null };
  function addBeads(list) { for (const b of list) pending.push(b); if (built.beads && built.scene) buildBeads(built.scene); }
  function buildBeads(scene) {
    const n = pending.length; if (!n) return; const B = sets.beads = makeSet(n);
    for (const b of pending) { const band = b.band ?? 2, seed = b.seed ?? A.hash(b.p[0], b.p[1], b.p[2]), ts = b.ts ?? -1;
      const r = b.size ?? (band === 0 ? .08 : band === 1 ? .02 : .006);
      push(B, b.p, band, r, seed, seed < .25 ? SPLASH : 0, ts, b.until ?? 1e9, b.tr ?? -1, 0); }
    dropMesh(scene, 'beads', B, 4); trCache = null;
  }

  // ------------------------------------------------------------------ public queries
  // All of these run the JS mirrors on the CPU, so they agree with what the shader draws.
  const setOf = name => sets[name];
  // one strand bead at time t: {p, r, tr, state 0 hangs | 1 falls | 2 landed, on (it is there and hanging)}.
  // j counts in the set's own order: from the top for field strands, from the tip for local ones. A field strand's bead
  // within 2.5 m of the terrace below shrinks away (r -> 0, on false), as in the shader
  function beadAt(i, j, t) { const s = strands[i], S = setOf(s.set), k = s.first + j, R3 = [S.rest[k * 3], S.rest[k * 3 + 1], S.rest[k * 3 + 2]];
    const band = S.info[k * 4], r = S.info[k * 4 + 1], seed = S.info[k * 4 + 2], drift = s.drifting ? 1 : 0, h = S.life[k * 4 + 3];
    const o = stateJS(R3, drift, band, r, seed, S.aux[k * 4 + 2], h, 1, S.life[k * 4 + 2], [S.aux[k * 4], S.aux[k * 4 + 1]], S.gnd[k], t);
    let keep = 1; if (s.kind === 'field') keep = A.sm(STRAND.cut, STRAND.cut + .7, o.hang[1] - groundStep(o.hang[0], o.hang[2]));
    return { p: o.p, r: r * keep, tr: o.tr, state: o.state, on: keep > 0 && o.state === 0 }; }
  // a strand's beads at time t, top first
  function strandAt(i, t) { const s = strands[i], out = []; for (let j = 0; j < s.n; j++) out.push(beadAt(i, s.kind === 'field' ? j : s.n - 1 - j, t)); return out; }
  // just the points of a strand that are there and hanging at time t, top first (for snails and sky-vines)
  const strandPts = (i, t) => strandAt(i, t).filter(b => b.on).map(b => b.p);
  // strands near a point at time t (nearest first): [{ i, d }], d = the horizontal distance (m) to the strand's top
  function strandsNear(p, t, radius = 20) { const out = [];
    strands.forEach((s, i) => { const fc = s.drifting ? P.fieldC(t) : [0, 0, 0], dx = s.top[0] + fc[0] - p[0], dz = s.top[2] + fc[2] - p[2], d = Math.hypot(dx, dz); if (d < radius) out.push({ i, d }); });
    return out.sort((a, b) => a.d - b.d); }
  // release times of every drop in a set (drop sets: life.z; mist: info.x), gathered once (rebuilt after addBeads)
  let trCache = null;
  function releaseTable() { if (trCache) return trCache; trCache = {};
    for (const name of ['big', 'marble', 'local', 'beads']) { const S = sets[name]; if (!S) continue; const tr = new Float32Array(S.n); for (let k = 0; k < S.n; k++) tr[k] = S.life[k * 4 + 2]; trCache[name] = tr; }
    if (sets.mist) { const S = sets.mist, tr = new Float32Array(S.n); for (let k = 0; k < S.n; k++) tr[k] = S.info[k * 4]; trCache.mist = tr; }
    return trCache; }
  const bandOf = (name, S, k) => name === 'mist' ? 2 : S.info[k * 4];
  const flagsOf = (name, S, k) => S.info[k * 4 + 3];
  // drops letting go between t0 and t1 within `radius` of `center` (nearest first, at most `max`), sorted by time: [{t, p, band, r, d}]
  // p is the rest position where the field held it at that moment (the small hanging motion is left out). Walks every
  // drop of every set, so it is meant for occasional queries, not every frame
  function releases(t0, t1, center, radius = 30, max = 60, bands = [0, 1, 2]) {
    const T = releaseTable(), out = [];
    for (const name in T) { const S = sets[name], tr = T[name];
      for (let k = 0; k < S.n; k++) { const t = tr[k]; if (t < t0 || t >= t1) continue; const band = bandOf(name, S, k); if (!bands.includes(band)) continue;
        const fc = flagsOf(name, S, k) & DRIFT ? P.fieldC(t) : [0, 0, 0], p = [S.rest[k * 3] + fc[0], S.rest[k * 3 + 1] + fc[1], S.rest[k * 3 + 2] + fc[2]];
        const d = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]); if (d > radius) continue; out.push({ t, p, band, r: name === 'mist' ? S.info[k * 4 + 1] : S.info[k * 4 + 1], d }); } }
    out.sort((a, b) => a.d - b.d); return out.slice(0, max).sort((a, b) => a.t - b.t); }
  // how many drops are falling at time t within radius of center (for the rain roar): heavy, strand, marble and local drops
  // let go in the last 3.5 s, measured across the ground from where they let go. Every third drop is counted three times
  function fallingNear(t, center, radius = 40) { const T = releaseTable(); let n = 0;
    for (const name of ['big', 'marble', 'local']) { const S = sets[name], tr = T[name]; if (!S) continue;
      for (let k = 0; k < S.n; k += 3) { const tau = t - tr[k]; if (tau < 0 || tau > 3.5) continue; const fc = S.info[k * 4 + 3] & DRIFT ? P.fieldC(tr[k]) : [0, 0, 0];
        if (Math.hypot(S.rest[k * 3] + fc[0] - center[0], S.rest[k * 3 + 2] + fc[2] - center[2]) < radius) n += 3; } } return n; }

  // every frame, before the shot's own update (film/main.js): the time-only motion inputs into the uniforms (fans, Pell's
  // lagged positions, the field's velocity), the look options back to their defaults, the inner ground colour for t, and the
  // hero drops and sound rings
  function update(t) {
    const g = globalsAt(t);
    RU.uFanN.value = g.fans.length; RU.uFieldV.value.set(...g.fieldV); set(DEF); groundFor(t);
    g.fans.forEach((f, i) => RU.uFan.value[i].set(f[0], f[1], f[2], f[4])); g.pell.forEach((p, i) => RU.uPellL.value[i].set(p[0], p[1], p[2]));
    updateHero(t); updateRings(t);
  }
  // shots may tune the look. Options last one frame (update() puts the defaults back), so a shot sets them in its own update:
  //   { bokehNear (m), streak (s), minPx, maxPx, body (alpha of the field's body), ground (inner ground colour of the drops),
  //     groundShade, camVel [x,y,z] (m/s: streaks are drawn relative to a moving camera),
  //     invert (how wide a view the glass drops turn upside down, in screen heights) }
  // `haze` is accepted as another name for `body` (it wins when both are given)
  function set(o = {}) { if (o.bokehNear != null) RU.uBokNear.value = o.bokehNear; if (o.streak != null) RU.uStreak.value = o.streak; if (o.minPx != null) RU.uMinPx.value = o.minPx;
    if (o.maxPx != null) RU.uMaxPx.value = o.maxPx; if (o.body != null) RU.uBodyK.value = o.body; if (o.haze != null) RU.uBodyK.value = o.haze; if (o.ground) RU.uGndC.value.set(o.ground); if (o.groundShade) RU.uGndS.value.set(o.groundShade);
    if (o.camVel) RU.uCamVel.value.set(...o.camVel); if (o.invert != null && hero) hero.material.uniforms.uInvK.value = o.invert; }
  // what the drops turn upside down: straw-gold terraces, jade after the green flood (75.5-80), the flooded terraces mirroring
  // the dusk sky in S17 (from 86.5-87.5). A shot's set({ ground, groundShade }) after update wins. Pairs are [lit, shade]
  const GC = { straw: [C3('#E8B36A'), C3('#C08A70')], jade: [C3('#6CC596'), C3('#3E8466')], dusk: [C3('#F0B892'), C3('#A890CC')] }, gTmp = new THREE.Color();
  function groundFor(t) { const j = A.sm(75.5, 80, t), d = A.sm(86.5, 87.5, t);
    for (let i = 0; i < 2; i++) { gTmp.copy(GC.straw[i]).lerp(GC.jade[i], j).lerp(GC.dusk[i], d); (i ? RU.uGndS : RU.uGndC).value.copy(gTmp); } }
  // the defaults set() returns to every frame (ground colours are not here: groundFor sets them)
  const DEF = { bokehNear: 1.6, streak: .075, minPx: .8, maxPx: 90, body: .2, invert: .3, camVel: [0, 0, 0] };

  // FILM.rain. steps() gives the loader its four build steps with their on-screen labels (Korean: lifting the rain-field,
  // hanging the village drops, shaping the big drops, hanging the sound rings). main.js runs every module's steps, then every
  // module's finalize()
  Object.assign(R, {
    steps(scene) { return [
      ['비 무리를 띄우는 중', () => buildField(scene)],
      ['마을 물방울을 다는 중', () => buildLocal(scene)],
      ['큰 물방울을 빚는 중', () => buildHero(scene)],
      ['소리의 고리를 거는 중', () => buildRings(scene)],
    ]; },
    finalize(scene) { built.scene = scene; buildBeads(scene); built.beads = true; },
    update, shock, addBeads, set, reset: () => set(DEF),
    strands, strandAt, strandPts, strandsNear, beadAt, hero: (id, t) => { const d = HERO.find(h => h.id === id); return d ? heroAt(d, t) : null; }, HERO,
    releases, fallingNear, sets, counts: () => Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, s.n])),
    relTime, hangJS, stateJS, groundStep, curl, timing, GLSL: RAIN_CORE, DRAW2D, COL, FLAGS: { DRIFT, BEAD, TAD, SPLASH },
  });

  // ------------------------------------------------------------------ test views (tools/shot.mjs --test <name> --k 0,1,2,3)
  // Each k shows its own film moment: the view sets the clock for the rain itself (the rest of the world stays at --at).
  F.test = F.test || {};
  // set the rain's clock to tk: the shared time uniforms and update(tk). A view returns { cam, look } like a shot's update;
  // s is the frame's state, s.t = the --at time (used when k has no moment of its own)
  const at = tk => { F.U.uTime.value = tk; F.U.uHeld.value = A.held(tk); update(tk); return tk; };
  const mixP = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const LOOK = { bloom: .45, glow: .18, rays: .2, flare: .3, live: 1 };   // the engine's look for all test views
  const V3 = a => new THREE.Vector3(...a);
  // wide over the valley: k 0 before the toll (10 s, from far out and low), 1 the drum's curtain (28.5) and 2 the chimes (31)
  // from below near the drum, 3 the gust (40), 4 looking up from under a fan (26.1), 5 the mist curtain after the cupola
  // bells (35.5)
  F.test.field = (k, s) => { const t = at([10, 28.5, 31, 40, 26.1, 35.5][k] ?? s.t), fc = P.fieldC(t), drum = V.places.tollTerrace.drum;
    if (k === 4) { const f = P.fans(t)[8].pos, cam = add(mixP(f, [0, 0, 0], .2), [0, 3, 0]); E.shadowFit(V3(f), 60);
      return { cam: { pos: cam, look: add(f, [0, 16, 0]), fov: 60 }, look: LOOK }; }
    if (k === 5) { const cam = [40, 20, -10]; E.shadowFit(V3(fc), 160); return { cam: { pos: cam, look: add(fc, [-20, 10, 0]), fov: 55 }, look: LOOK }; }
    if (k === 1 || k === 2) { const c0 = mixP(drum, [0, 0, 0], .36); const cam = [c0[0], V.ground(c0[0], c0[2]) + (k === 1 ? 6 : 10), c0[2]]; E.shadowFit(V3(drum), 120);
      return { cam: { pos: cam, look: add(drum, [6, k === 1 ? 16 : 22, 22]), fov: 52 }, look: LOOK }; }
    if (k === 3) { const cam = [60, 30, 40]; E.shadowFit(V3(fc), 160); return { cam: { pos: cam, look: add(fc, [0, 4, 0]), fov: 50 }, look: LOOK }; }
    const cam = add(fc, [-130, -36, 140]); cam[1] = Math.max(cam[1], V.ground(cam[0], cam[2]) + 3); E.shadowFit(V3(fc), 160);
    return { cam: { pos: cam, look: add(fc, [0, 4, 0]), fov: 50 }, look: LOOK }; };
  // close: k 0 heavy drops at 1-3 m inside the field (the camera 2 m from a big one near the staircase, 10 s), 1 a field
  // strand (10 s), 2 the macro drop of S01 (0.6 s), 3 the toy-bell child's mist (14.2 s).
  // For k 1 the strand is the last of every third field strand whose 25th bead hangs over 5 m above the ground
  F.test.drops = (k, s) => { const t = at([10, 10, .6, 14.2][k] ?? s.t);
    if (k === 0) { const S = sets.big, H = P.H.local; let best = 0, bd = 1e9;
      for (let i = 0; i < CNT.heavy; i++) { const d = Math.hypot(S.rest[i * 3] - H[0] + 7, S.rest[i * 3 + 1] - 8, S.rest[i * 3 + 2] - H[2]) - S.info[i * 4 + 1] * 20; if (d < bd) { bd = d; best = i; } }
      const p = hangJS([S.rest[best * 3], S.rest[best * 3 + 1], S.rest[best * 3 + 2]], 1, S.info[best * 4 + 1], S.info[best * 4 + 2], S.info[best * 4 + 2], 0, .6, t);
      return { cam: { pos: add(p, [-1.5, .35, 1.3]), look: p, fov: 38 }, look: Object.assign({ focus: 2, ap: .004 }, LOOK) }; }
    if (k === 1) { let si = 0, bh = -1e9; strands.forEach((st, i) => { if (st.kind !== 'field' || i % 3) return; const b = beadAt(i, Math.min(st.n - 1, 24), t); if (b.on && b.p[1] - V.ground(b.p[0], b.p[2]) > 5 && b.p[1] > bh - 1e3) { bh = b.p[1]; si = i; } });
      const pts = strandAt(si, t).filter(b => b.on), mid = pts[Math.max(0, pts.length - 9)].p;
      return { cam: { pos: add(mid, [-2.4, -.4, 2.2]), look: add(mid, [0, .2, 0]), fov: 42 }, look: Object.assign({ focus: 3.3, ap: .003 }, LOOK) }; }
    if (k === 2) { const m = SP.macro.pos, dir = norm([P.fieldC(0)[0] - m[0], 0, P.fieldC(0)[2] - m[2]]); set({ invert: .5 });
      return { cam: { pos: add(m, [-dir[0] * .95, .03, -dir[2] * .95]), look: m, fov: 14 }, look: Object.assign({ focus: .95, ap: .02 }, LOOK) }; }
    const kid = add(P.kid, [0, 2.1, 0]), sd = norm(sub([0, kid[1], 0], kid));
    return { cam: { pos: add(kid, [sd[0] * 5 - 1.5, -.8, sd[2] * 5]), look: kid, fov: 30 }, look: Object.assign({ focus: 5, ap: .003 }, LOOK) }; };
  // one heavy drop up close (the drop design), at --at or 10 s: k 0-2 from 0.55, 1.1 and 2.2 m, slightly above it; k 3 from
  // 0.9 m below it, against the sky. The drop is a big one near the staircase
  F.test.drop = (k, s) => { const t = at(s.t || 10), S = sets.big, H = P.H.local; let best = 0, bd = 1e9;
    for (let i = 0; i < CNT.heavy; i++) { const d = Math.hypot(S.rest[i * 3] - H[0] + 7, S.rest[i * 3 + 1] - 8, S.rest[i * 3 + 2] - H[2]) - S.info[i * 4 + 1] * 30; if (d < bd) { bd = d; best = i; } }
    const p = hangJS([S.rest[best * 3], S.rest[best * 3 + 1], S.rest[best * 3 + 2]], 1, S.info[best * 4 + 1], S.info[best * 4 + 2], S.info[best * 4 + 2], 0, .6, t);
    const d = [.55, 1.1, 2.2, .9][k] ?? 1, up = k === 3 ? -.5 : .12;
    set({ bokehNear: .3 });
    return { cam: { pos: add(p, [-d * .75, up * d, d * .66]), look: p, fov: 30 }, look: Object.assign({}, LOOK) }; };
  // the story drops: the frog's (15.5, trembling under the croak), the nose drop falling (21.9), the face drop shivering at the
  // test hum (64.95), the palm drop landing (90.32)
  F.test.story = (k, s) => { const t = at([15.5, 21.9, 64.95, 90.32][k] ?? s.t), id = ['frog', 'nose', 'face', 'palm'][k] || 'frog', h = heroAt(HERO.find(d => d.id === id), t);
    const c = h.show ? h.pos : SP[id].pos, d = [.55, .9, .8, .7][k] ?? .7; set({ bokehNear: .2, invert: .4 });
    return { cam: { pos: add(c, [-d * .7, d * .25, d * .7]), look: add(c, [0, k === 1 ? -.25 : 0, 0]), fov: 32 }, look: Object.assign({ focus: d, ap: .006 }, LOOK) }; };
  // Pell's voice (66.0 A4, 67.5 D5): the bright shells with star sparkles bursting out of the field, and the marble ring falling.
  // The camera is 26 m from her voice; shock() needs a placed camera, and the film's own is placed only after this returns,
  // so a matching one is built here
  F.test.voice = (k, s) => { const t = at([66.25, 66.9, 67.85, 68.6][k] ?? s.t), src = EV.T.find(e => e.id === 'voiceA').src, ang = [2.2, 2.6, 1.9, 2.4][k] ?? 2.2;
    const cam = add(src, [Math.sin(ang) * 26, -6 + 2 * k, Math.cos(ang) * 26]), c = { pos: cam, look: add(src, [0, -2, 0]) };
    const cv = new THREE.PerspectiveCamera(50, 16 / 9, .1, 6000); cv.position.set(...cam); cv.lookAt(...c.look); cv.updateMatrixWorld();
    return { cam: Object.assign(c, { fov: 50 }), look: Object.assign({}, LOOK, { shock: shock(t, cv), ink: 'pale', leak: .15 }) }; };
  // the drum's ring from below on terrace 9: a necklace of drops letting go (27.3, 27.8), the curtain falling (28.6), then
  // the chimes (30.5)
  F.test.release = (k, s) => { const t = at([27.3, 27.8, 28.6, 30.5][k] ?? s.t), drum = V.places.tollTerrace.drum;
    const c0 = V.onTerrace(9, V.places.tollTerrace.th + .2, .35), cam = add(c0, [0, 1.6, 0]); E.shadowFit(V3(drum), 60);
    return { cam: { pos: cam, look: add(drum, [-4, 19, 0]), fov: 72 }, look: Object.assign({}, LOOK, { flare: .5 }) }; };
  // the staircase: hero drops and the bead curtain round Pell (47, 49, 51, 53 s), 6.5 m from her
  F.test.hops = (k, s) => { const t = at([47, 49, 51, 53][k] ?? s.t), p = P.pell(t), c = add(p.pos, [0, .8, 0]), y = p.yaw + .9;
    E.shadowFit(V3(c), 16);
    return { cam: { pos: add(c, [Math.sin(y) * 6.5, .6, Math.cos(y) * 6.5]), look: c, fov: 40 }, look: Object.assign({ focus: 6.5, ap: .004 }, LOOK) }; };
  // the falling staircase (M11): the camera falls with Pell, so the rain round her seems to hang while the far rings lag
  // (69.3, 70.2, 71.5 s). camVel is her velocity, so the streaks are drawn relative to the falling camera
  F.test.fall = (k, s) => { const t = at([69.3, 70.2, 71.5][k] ?? s.t), p = P.pell(t).pos, p1 = P.pell(t + .02).pos, p0 = P.pell(t - .02).pos;
    set({ camVel: [(p1[0] - p0[0]) / .04, (p1[1] - p0[1]) / .04, (p1[2] - p0[2]) / .04] });
    return { cam: { pos: add(p, [3.2, 2.2, 4.2]), look: add(p, [0, -1.5, 0]), fov: 58 }, look: Object.assign({ speed: .35, speedMode: 2 }, LOOK, { ink: 'pale' }) }; };
})();
