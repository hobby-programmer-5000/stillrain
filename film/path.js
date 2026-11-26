// path.js - where everyone and everything is, at every moment: the choreography that the shots, the rain, the cast and
// the sound all agree on. Everything is a pure function of film time t (seconds), so any frame can be drawn on its own.
//
// The field: the rain-field is one ellipse of hanging drops (half-axes 80 x 55 m, three strata). Its drops are stored
// field-local and ride on its centre fieldC(t). The centre drifts east at about 2 m/s; the gust at 36 s blends that velocity,
// over 3 s, into a slower slide (about 1.4 m/s) south-east toward the Spillway. The blend is integrated in closed form, so
// fieldC(t) needs no history (see S below). P.GLSL has the same formula for the shaders, with the numbers written out.
// Pell: pell(t) is a chain of time windows, one per piece of action (roof, run, leaps, climb, the staircase of drops, the
// heart drop, the fall, the cloth, the bench). Each window builds her position from the places in valley.js and from the
// drops defined here, so her feet land exactly where rain.js draws the drops.
//
//   P.fieldC(t)        the rain-field's centre [x,y,z] (m)
//   P.gust(t)          0..1 envelope of the gust: up at 36-37.2 s, easing to a steady 0.35 by 44 s
//   P.FIELD            field size (rx, rz half-axes) and strata (heights are field-local, above the base)
//   P.pell(t)          { pos:[x,y,z] (between her feet), yaw (facing angle, 0 = +z, PI/2 = +x), state, air (1 in flight), on (drop) }
//   P.pellHead(t), P.pellHand(t)   her head centre and bell hand in world space (the sources of her tolls in events.js)
//   P.hops             the hero drops of the staircase: { local:[x,y,z] (centre, field-local), r, ts (she lands), tr (it lets go) }
//   P.H                the heart drop she stands on from 54 to 69 (released by her own voice at 69.0)
//   P.topOf(drop, t)   the top of a drifting drop in world space      P.jelly(tau) -> [a2, a3], the squash of a stepped drop (M5)
//   P.fallY, P.fallV   the heavy band's fall (the law of events.js)   P.dun(t), P.fans(t), P.FANS_ON(t), P.cloth, P.kid, P.frog
//   P.special          the story drops (macro, frog, nose, face, palm); film/CONTRACT.md lists every field
// GLSL: P.GLSL has fieldC(t) and gustK(t). events.js pastes it into its own GLSL, so a shader gets it from FILM.events.GLSL.
// Reads: FILM.valley (places, houses, terraces), FILM.anim. Read by events.js, rain.js, cast.js, crowd.js, life.js, world.js,
//        the shots and music/synth.js.
// See it: node tools/shot.mjs --test hops --k 0,1,2,3 --cols 2 --out build/hops.jpg   (the staircase, from rain.js)
//         node tools/shot.mjs --test fall --k 0,1,2 --cols 3 --out build/fall.jpg     (falling with her, from rain.js)
//         FILM.dev.sweep() in the browser console checks every camera against these paths (main.js).
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim, V = F.valley, { clamp, lerp, sm, keys } = A;
  // small helpers on plain [x, y, z] arrays
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], mix3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  // the yaw that faces from a toward b (0 = +z, PI/2 = +x)
  const yawTo = (a, b) => Math.atan2(b[0] - a[0], b[2] - a[2]);

  // ---- the field. Base 44 m (15 m above terrace 9). Heavy stratum 0..14 m, marble 12..26, mist 24..38, haze throughout.
  const FIELD = { base: 44, rx: 80, rz: 55, heavy: [0, 14], marble: [12, 26], mist: [24, 38] };
  // C0: the centre at t = 0, over the north-east terraces. V0: its drift before the gust (m/s, east).
  // VG: its slide after the gust (m/s, mostly south, toward the Spillway notch, which lies due east of the valley centre)
  const C0 = [96, FIELD.base, -74], V0 = [2.0, 0, .15], VG = [.55, 0, 1.3];
  // closed form: C(t) = C0 + V0 t + (VG - V0) S(t), S = integral of smoothstep(36, 39, t)
  // The velocity blends from V0 to VG along smoothstep(36, 39, t); S is the integral of that blend (seconds). With
  // x = (t - 36) / 3 the integral of 3x^2 - 2x^3 over 3 s is 3 (x^3 - x^4 / 2); after 39 it grows by 1 per second.
  // On top, the field breathes up and down 0.6 m (y).
  const S = t => { if (t <= 36) return 0; const x = (t - 36) / 3; return x < 1 ? 3 * (x * x * x - x * x * x * x / 2) : 1.5 + (t - 39); };
  const fieldC = t => { const s = S(t); return [C0[0] + V0[0] * t + (VG[0] - V0[0]) * s, C0[1] + .6 * Math.sin(t * .21), C0[2] + V0[2] * t + (VG[2] - V0[2]) * s]; };
  const gust = t => sm(36, 37.2, t) * (1 - sm(39.5, 44, t) * .65);   // the tear, then a steady wind that keeps it sliding
  const GLSL = /* glsl */`
// the same S, fieldC and gust as the JS in film/path.js, with C0, V0 and VG written out as numbers: keep them in step
float pathS(float t){ if (t <= 36.0) return 0.0; float x = (t - 36.0) / 3.0; return x < 1.0 ? 3.0 * (x * x * x - x * x * x * x * 0.5) : 1.5 + (t - 39.0); }
vec3 fieldC(float t){ float s = pathS(t); return vec3(96.0 + 2.0 * t + (0.55 - 2.0) * s, 44.0 + 0.6 * sin(t * 0.21), -74.0 + 0.15 * t + (1.3 - 0.15) * s); }
float gustK(float t){ return smoothstep(36.0, 37.2, t) * (1.0 - smoothstep(39.5, 44.0, t) * 0.65); }`;

  // ---- places for people: Pell's house, the Listeners' hut, the Spillway mast and its top (12 m up)
  const roofH = V.places.pellRoof.house, hut = V.places.spillway.hut, mast = V.places.spillway.mast, mastTop = add(mast, [0, V.places.spillway.mastH, 0]);
  // a point on a house's hush-roof, given in the house's own frame (valley.js roofY / houseToWorld)
  const onRoof = (h, lx, lz) => V.houseToWorld(h, lx, V.roofY(h, lx, lz), lz);
  const pellRoofSpot = onRoof(roofH, .9, .7);   // where she sits on her roof in S04
  const T9 = (th, u) => V.onTerrace(9, th, u);   // a point on terrace 9, the toll terrace (angle th, u = 0 inner .. 1 outer edge)
  const cloth = { pos: [184.5, V.ground(184.5, -14) + 1.15, -14], r: 3.4 };           // the hush-cloth Pell lands in (S14)
  cloth.ground = V.ground(184.5, -14);

  // ---- the heart drop and the staircase
  // H: centre field-local, radius .7 m; she lands on it at 54 (ts) and her own voice lets it go at 69 (tr)
  const H = { local: [5, 13.3, 20], r: .7, ts: 54.0, tr: 69.0 };
  // the top of a drifting drop at time t, in world space: where her feet go
  const topOf = (d, t) => add(add(fieldC(t), d.local), [0, d.r, 0]);
  // Ten drops from just above the mast top up to the heart drop, one every .75 s (the held step, bible rule 3). The line
  // between the ends is eased, and wound into a helix that shrinks from 2.6 m to 0, so the climb spirals in. Each drop is
  // stored field-local as of the moment she lands on it (so it is under her feet then) and lets go .75 s later.
  const hops = [];
  { const S0 = add(mastTop, [-.9, 1.6, -.6]), E0 = topOf(H, 54.0);
    for (let i = 0; i < 10; i++) { const ts = 46.5 + .75 * i, k = i / 10, hel = (1 - k) * 2.6;
      const w = add(mix3(S0, E0, A.ease.io(k) * .5 + k * .5), [Math.cos(i * 1.1) * hel, 0, Math.sin(i * 1.1) * hel]);
      const r = .46 + .06 * Math.sin(i * 2.3);
      hops.push({ local: sub(sub(w, fieldC(ts)), [0, r, 0]), r, ts, tr: ts + .75 }); } }
  // jelly squash of a stepped drop (M5): returns [a2, a3] Legendre amplitudes, tau = time since the step
  // (the drop's radius is R [1 + a2 P2(cos th) + a3 P3(cos th)]: a2 squashes and bulges, a3 tips it; rain.js shapes the drop
  // with both, and pell() bobs her feet with a2)
  const jelly = tau => tau < 0 ? [0, 0] : [-.32 * Math.exp(-5 * tau) * Math.cos(A.TAU * 3 * tau), .08 * Math.exp(-6 * tau) * Math.sin(A.TAU * 4.6 * tau)];
  // fall after release (heavy band, film physics): y drop after tau seconds at terminal velocity vt
  // (the same law as FILM.events.fall; it is written here too because path.js loads before events.js)
  const G = 6.0, fallY = (tau, vt = 14) => tau <= 0 ? 0 : (vt * vt / G) * Math.log(Math.cosh(G * tau / vt));
  const fallV = (tau, vt = 14) => tau <= 0 ? 0 : vt * Math.tanh(G * tau / vt);

  // ---- Pell: one window of time per piece of action
  const PELL_FALL_K = .81;   // she falls a little slower than the drops, so the rain sinks past her (bible §9.8)
  function pell(t) {
    const o = { pos: [0, 0, 0], yaw: 0, state: 'stand', air: 0, on: null };
    // S01-S04: on her roof (terrace 8), turned a little off the valley centre
    if (t < 24) { o.pos = pellRoofSpot.slice(); o.yaw = yawTo(pellRoofSpot, [0, 0, 0]) + .35; o.state = 'roof'; return o; }
    if (t < 36) { // S05/S06: she runs beside the fanners along terrace 9, then stands and watches the toll
      const th = keys(t, [[24, -.66], [27, -.47, 'out'], [36, -.43]]); o.pos = T9(th, .62); o.yaw = Math.PI / 2 + th + (t < 27 ? 0 : -1.2); o.state = t < 27 ? 'run' : 'watch'; return o; }
    // S07: the gust. She walks on along the terrace toward the Spillway, then grips her staff (39)
    if (t < 42) { const th = keys(t, [[36, -.43], [38.5, -.3, 'io'], [42, -.27]]); o.pos = T9(th, .8); o.yaw = Math.PI / 2 + th + (t > 39 ? -.4 : .2); o.state = t > 39 ? 'grip' : 'walk'; return o; }
    // S08 from here to 48: sprint to the end of the terrace
    if (t < 42.75) { const th = lerp(-.27, -.225, (t - 42) / .75); o.pos = T9(th, .8); o.yaw = Math.PI / 2 + th; o.state = 'sprint'; return o; }
    const hutTop = onRoof(hut, .3, 0);
    // a jump from a to b: a straight line plus a parabola that peaks 'apex' metres higher halfway
    const arc = (a, b, k, apex) => { const p = mix3(a, b, k); p[1] += apex * 4 * k * (1 - k); return p; };
    // leap onto the Listeners' hut roof (.25 s), crouch there, leap to the Spillway mast and catch it 5.4 m up
    if (t < 43.0) { const a = T9(-.225, .8), k = (t - 42.75) / .25; o.pos = arc(a, hutTop, k, 1.2); o.air = 1; o.state = 'leap'; o.yaw = yawTo(a, hutTop); return o; }
    if (t < 43.5) { o.pos = hutTop; o.state = 'crouch'; o.yaw = yawTo(hutTop, mast); return o; }
    const cling = (y) => [mast[0] - .4, y, mast[2] + .15];   // where she hangs on the mast at height y (just off its axis)
    if (t < 44.25) { const k = (t - 43.5) / .75; o.pos = arc(hutTop, cling(mast[1] + 5.4), k, 2.0); o.air = 1; o.state = 'leap'; o.yaw = yawTo(hutTop, mast); return o; }
    // the climb: two quick scrambles ('snap' keys, 5.4 -> 8.4 -> 11.4 m), then up to the top
    if (t < 46.1) { const y = keys(t, [[44.25, mast[1] + 5.4], [44.55, mast[1] + 5.4], [44.85, mast[1] + 8.4, 'snap'], [45.45, mast[1] + 8.4], [45.75, mast[1] + 11.4, 'snap'], [46.1, mast[1] + 12]]);
      o.pos = cling(y); o.state = 'climb'; o.yaw = yawTo(o.pos, mast); return o; }
    // leap from the mast top onto the first drop of the staircase (46.5)
    if (t < 46.5) { const k = (t - 46.1) / .4, a = cling(mast[1] + 12); o.pos = arc(a, topOf(hops[0], 46.5), k, 1.4); o.air = 1; o.state = 'leap'; o.yaw = yawTo(a, topOf(hops[0], 46.5)); return o; }
    if (t < 54) { // the staircase: land at ts, squash, push off at ts + .4, fly to the next drop
      const i = Math.min(9, Math.floor((t - 46.5) / .75)), d = hops[i], nx = i < 9 ? hops[i + 1] : H, tau = t - d.ts;
      if (tau < .4) { const j = jelly(tau)[0]; o.pos = add(topOf(d, t), [0, d.r * j * .9, 0]); o.state = 'step'; o.on = i; }
      else { const k = (tau - .4) / .35, a = topOf(d, d.ts + .4), b = topOf(nx, nx.ts); o.pos = arc(a, b, k, .9); o.air = 1; o.state = 'hop'; }
      o.yaw = yawTo(topOf(d, t), topOf(nx, nx.ts)); return o; }
    // S10-S12: on the heart drop, bobbing with its squash: the bell (54-57), stillness (57-66), the song (66-69)
    if (t < 69) { o.pos = add(topOf(H, t), [0, H.r * jelly(t - 54)[0] * .9, 0]); o.state = t < 57 ? 'bell' : t < 66 ? 'still' : 'sing'; o.on = 'H';
      o.yaw = keys(t, [[54, 2.2], [60, 2.2], [66, 2.0]]); return o; }
    // S13: the fall. She drifts across to the hush-cloth over 4 s while falling PELL_FALL_K times as far as the drops
    if (t < 73) { const tau = t - 69, a = topOf(H, 69), k = sm(0, 4, tau);
      const land = cloth.pos[1] - .25 - (a[1] - PELL_FALL_K * fallY(4));   // the gap to the cloth at 73.0, closed over the last 1.5 s
      o.pos = [lerp(a[0], cloth.pos[0], k), a[1] - PELL_FALL_K * fallY(tau) + land * sm(2.5, 4, tau), lerp(a[2], cloth.pos[2], k)]; o.air = 1; o.state = 'fall'; o.yaw = yawTo(a, cloth.pos); return o; }
    // S14: the bounce in the cloth (a damped sine)
    if (t < 75) { const sq = Math.exp(-(t - 73) * 5) * Math.sin((t - 73) * 18); o.pos = add(cloth.pos, [0, -.25 + .35 * sq, 0]); o.state = 'land'; o.yaw = 1.2; return o; }
    // S15-S16: on the ground beside the cloth, sitting, then standing (81)
    if (t < 87) { o.pos = [cloth.pos[0] - 1.5, cloth.ground, cloth.pos[2] + 1]; o.state = t < 81 ? 'sit' : 'stand'; o.yaw = -1.9; return o; }
    // S17: on the Listeners' bench by the Spillway
    o.pos = add(V.places.spillway.bench, [0, .45, 0]); o.state = 'bench'; o.yaw = -1.6; return o;
  }
  // her head (a little above the hood brim) and the bell hand, in world space, for the events that come from her
  const PELL_H = 1.38;   // her height (m)
  const pellHead = t => { const p = pell(t); return add(p.pos, [0, PELL_H * .82, 0]); };   // the head centre of the sculpted Pell (cast.js)
  // the bell hand: .32 m out from her centre, .9 rad (about 50 degrees) off the way she faces, at 62% of her height
  const pellHand = t => { const p = pell(t), y = p.yaw; return add(p.pos, [Math.sin(y + .9) * .32, PELL_H * .62, Math.cos(y + .9) * .32]); };

  // ---- Old Dun: strapping on her drum on terrace 9 (until 22), hushing Pell (22-24), at the drum (24-36), looking
  //      toward the Spillway after the runaway field (36-81), then walking over to Pell
  const drum = V.places.tollTerrace.drum;
  const dun = t => { if (t < 36) { const p = t < 22 ? T9(-.58, .4) : drum; return { pos: t < 22 ? p : drum, yaw: yawTo(drum, pellRoofSpot), state: t < 22 ? 'strap' : t < 24 ? 'hush' : 'drum' }; }
    if (t < 81) return { pos: drum, yaw: yawTo(drum, mast), state: 'look' };
    // from 81 she walks to Pell's side and ends .6 m north of her (cast.js wraps the shawl from there)
    const a = [cloth.pos[0] - 1.5, cloth.ground, cloth.pos[2] + .4], k = sm(81, 82.45, t); return { pos: mix3(add(a, [-6, 0, -3]), a, k), yaw: yawTo(a, cloth.pos), state: t < 82.5 ? 'walk' : 'wrap' }; };

  // ---- the fanners (S05): three teams of six on terrace 9, sweeping on a 2-beat cycle; fan k sits at fans(t)[k]
  // phase: one sweep every 1.5 s (two beats at 80 bpm), each fan .2 rad behind the one before, so the sweep ripples down
  // the line; the teams creep .05 rad along the terrace between 24 and 33
  const fans = t => { const out = []; for (let team = 0; team < 3; team++) for (let i = 0; i < 6; i++) { const th = -.78 + team * .12 + i * .016 + keys(t, [[24, 0], [33, .05]]);
      out.push({ pos: T9(th, .3 + .08 * (i % 2)), phase: A.TAU * t / 1.5 - .8 * (team * 6 + i) * .25, team }); } return out; };
  // how hard the fans push on the field (M4), 0..1: on from 24, off by 35. The push itself (a horizontal gaussian round
  // each fan, strong on the sweep cycle) is computed in rain.js; synth.js times the felt whooshes from the same phase.
  const FANS_ON = t => sm(23.5, 24.5, t) * (1 - sm(33, 35, t));

  // ---- small anchors for the events of Act 1
  const cr = V.places.cisternRow;
  const kid = V.onTerrace(cr.k, lerp(cr.th0, cr.th1, .62), .4);                    // the child whose toy bell jingles at 13.5
  const frogC = V.cisterns[3], frog = add(frogC.pos, [0, 1.55 * frogC.size, .55 * frogC.size]);   // the dripfrog on the rim
  // ---- single drops that matter to the story (world-fixed, not part of the drifting field). rain.js draws them as hero drops.
  //   macro: S01's first drop (a strand tip on terrace 5, south side, looking north across the valley), with a tadpole inside
  //   frog:  above the dripfrog's mouth; the frog's held D3 lets it go at about 15.8 and it lands in the mouth at about 16.1
  //   nose:  above Pell's nose; her hum (D4 from 20.25) lets it go at about 21.8 and it hits her nose at 22.4
  //   face:  beside her face in S11; the tiny test hum (64.5) only makes it tremble (her D5 at 67.5 lets it go at 69.0)
  //   palm:  above her cupped hands on the bench; her hum at 88.5 lets it go at about 90.0 and it lands at 90.3
  //   r is the radius (m), band 0 = heavy; 'since' = when the drop forms (events.js releaseTime)
  const fwd = (t, d) => { const p = pell(t), y = p.yaw; return [Math.sin(y) * d, 0, Math.cos(y) * d]; };   // d metres ahead of her
  const nose = add(add(pellHead(22.4), fwd(22.4, .11)), [0, -.045, 0]);        // her nose tip at 22.4
  const palmPos = add(add(pell(90.3).pos, fwd(90.3, .26)), [0, .52, 0]);         // her cupped hands on the bench at 90.3
  const special = {
    macro: { pos: add(V.onTerrace(5, 1.62, .5), [0, 2.6, 0]), r: .16, band: 0, tadpole: true, until: 6 },
    frog: { pos: add(frog, [.02, .36, .06]), r: .07, band: 0 },
    nose: { pos: add(nose, [0, 1.11, 0]), r: .06, band: 0 },
    face: { pos: add(add(pellHead(64.5), fwd(64.5, .35)), [.25, .1, 0]), r: .09, band: 0, drifting: true },
    palm: { pos: add(palmPos, [0, .28, 0]), r: .07, band: 0, since: 87 },
  };
  // 'face' rides with the field: store it field-local
  special.face.local = sub(special.face.pos, fieldC(64.5));
  F.path = { special, palmPos, FIELD, fieldC, gust, GLSL, S, H, hops, topOf, jelly, fallY, fallV, G, pell, pellHead, pellHand, PELL_H, PELL_FALL_K, dun, fans, FANS_ON, cloth, kid, frog, mastTop, pellRoofSpot, onRoof, yawTo, add, sub, mix3 };
})();
