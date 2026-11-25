// events.js - the TOLLS: every sound in the film that brings rain down, in one table that the picture and the synth both read.
//
// The rule of the world (film/BIBLE.md section 2): water in the air hangs still until a sound of its pitch reaches it.
// Sound travels at 30 m/s, slow enough to watch a ring of falling drops spread out from a drum.
//   Three bands of drops, each answering one pitch class in any octave:
//     band 0  HEAVY  (fist to melon)  answers D   home octave D2 (Dun's drum)
//     band 1  MARBLE (2-6 cm)         answers A   home octave A4 (the mast chimes)
//     band 2  MIST   (2-8 mm)         answers E   home octave E6 (handbells, cupola bells)
//   A 'strike' in the home octave releases its band the moment the front arrives. Any other note is a 'sustain': it must be
//   held HOLD = 1.5 s after it arrives, and a sustain that stops sooner (dur < hold) releases nothing, the drops only tremble.
//   Reach (m) is how far a sound carries: a toy bell 1.8 m, Pell's handbell 4 m, Dun's drum 40 m, a voice inside a field 120 m.
//
// The math is closed form, a pure function of where a drop hangs and of film time, so any frame can be drawn on its own:
//   release   tr = t0 + d / 30 + hold + 0.08 seed      d: metres from the source to the drop; seed (0..1) jitters each drop
//             The earliest toll of the drop's band that reaches it wins; 1e9 means 'never'.
//   fall      y(tau) = yRel - (VT^2 / G) ln cosh(G tau / VT),   tau = t - tr
//             Free fall with air drag: the speed v = VT tanh(G tau / VT) starts at 0 and levels off at the band's terminal
//             velocity VT (14, 9, 2.2 m/s), so big drops plunge and mist drifts down. G = 6 m/s^2 is the film's own gravity.
//   landing   tau_hit = (VT / G) acosh(exp(G dh / VT^2))      the inverse of the fall: seconds to fall dh metres
//
// The same math is written twice below, JS first and then GLSL (the string GLSL), with the same function names, so they
// can be read side by side. JS places things and feeds the synth; GLSL moves the drops in the shaders. The uniforms
// uEv / uEvP are filled from the same table T, so the two cannot disagree about when or where a sound happens.
//
// Public API (FILM.events; film/CONTRACT.md has the full table):
//   T, N           the 22 tolls sorted by time: { id, t0, src [x,y,z], note, band, kind, reach, dur, hold, sharp? }
//   releaseTime(local, drifting, band, seed, since) -> tr      posAt(local, drifting, t) -> world position of a drop
//   arrivals(p, t) -> [{ e, ta }]   every front (any band) that has reached p by t      fall(tau, band), hitTau(dh, band)
//   wetAt(x, z, t) -> 0..1          how wet the ground is (M12)      FIELD_EV  the tolls that reach the field (reach > 30 m)
//   C_SOUND 30, G 6, VT [14, 9, 2.2], HOLD 1.5, STEP_HOLD .75, BAND, HOME   (named constants of the rule)
//   GLSL  releaseTime(), fallDist(), fallVel(), hitTau(), evFlash(), evTremble(), evSince(), plus fieldC() / gustK() from
//         film/path.js. The uniforms uEv, uEvP, uEvN live in FILM.U, so a material only pastes FILM.events.GLSL into its shader.
// Reads: FILM.path (sources on Pell, the kid, the frog; the field's drift), FILM.valley (drum, masts, cupolas, terraces),
//        FILM.anim (sm). Read by rain.js, life.js, crowd.js, cast.js, world.js and music/synth.js.
// See it: node tools/shot.mjs --test release --k 0,1,2,3 --cols 2 --out build/release.jpg   (the drum's ring, from rain.js)
//         node tools/shot.mjs --test story --k 0,1,2,3 --cols 2 --out build/story.jpg       (frog, nose, face and palm drops)
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim, S = F.score, P = F.path, V = F.valley;
  // C_SOUND m/s; G the film's gravity, m/s^2; VT terminal velocity per band, m/s; HOLD s a sustain must last after it
  // arrives; STEP_HOLD s a heavy drop holds a light step (bible rule 3; path.js times the staircase with the same .75 s)
  const C_SOUND = 30, G = 6.0, VT = [14, 9, 2.2], HOLD = 1.5, STEP_HOLD = .75;
  const BAND = { HEAVY: 0, MARBLE: 1, MIST: 2 };
  // each band's home octave: a strike there releases at once (for reference; each toll below states its kind itself)
  const HOME = { 0: 'D2', 1: 'A4', 2: 'E6' };
  const add = P.add;
  // ---- the table. toll(id, t0 (s), source [x,y,z] (m), note, band, kind ('strike' | 'sustain'), reach (m),
  //      dur (s, how long the sound lasts), extra fields). hold is HOLD for a sustain and 0 for a strike.
  //      Sources come from film/path.js (Pell's head and hand, the kid, the frog) and film/valley.js (drum, masts, cupolas).
  const T = [];
  const toll = (id, t0, src, note, band, kind, reach, dur = .5, extra = {}) => T.push({ id, t0, src, note, band, kind, reach, dur, hold: kind === 'sustain' ? HOLD : 0, ...extra });
  const masts = V.places.tollTerrace.masts;
  toll('toybell', 13.5, add(P.kid, [0, .9, 0]), 'E6', 2, 'strike', 1.8, .6);                         // S03: a child's toy bell, a tiny ring of mist
  toll('frog', 14.25, add(P.frog, [0, .1, 0]), 'D3', 0, 'sustain', .9, 1.95);                      // S03: the dripfrog's held croak; its drop lets go at about 15.76
  toll('hum', 20.25, P.pellHead(20.25), 'D4', 0, 'sustain', 1.6, 1.8);                            // S04: Pell's hum settles on D; the nose drop lets go at about 21.79
  toll('drum', 27.0, add(V.places.tollTerrace.drum, [0, 1.3, 0]), 'D2', 0, 'strike', 40, 1.2);   // S05: Dun's drum. The bible said 70 m; 40 m leaves about two thirds of the field hanging
  masts.forEach((m, i) => toll('chime' + i, 30.0, add(m, [0, 7.5, 0]), 'A4', 1, 'strike', 45, 3.5));   // S05: the three mast chimes peel off the marble band
  V.cupolas.forEach((c, i) => toll('cupola' + i, 33.0 + i * .09, c, 'E6', 2, 'strike', 55, 2.0));   // S06: four cupola bells, 0.09 s apart; 55 m to reach the mist veil 40-50 m above them
  [54.0, 54.75, 55.5, 55.875, 56.25, 56.625].forEach((t, i) => toll('bell' + i, t, P.pellHand(t), 'E6', 2, 'strike', 4, .4, { sharp: 14 }));   // S10: Pell's handbell, 14 cents sharp (synth.js); 4 m only brings a puff of mist
  toll('testhum', 64.5, P.pellHead(64.5), 'D4', 0, 'sustain', 1.2, .45);                         // S11: the test hum lasts .45 s < HOLD, so the face drop only trembles
  toll('voiceA', 66.0, P.pellHead(66.0), 'A4', 1, 'strike', 120, 1.5);                           // S12: she sings A4, the marble home octave; inside a field a voice carries 120 m
  toll('voiceD', 67.5, P.pellHead(67.5), 'D5', 0, 'sustain', 120, 3.5);                          // S12: the note lifts to D5 and holds: the heavy band lets go at 69.0 + d / 30
  toll('tock', 69.0, add(P.pellHead(69.0), [.2, .5, 0]), 'E6', 2, 'strike', 60, 1.0);            // S13: Tock trills from her hood: the mist veil comes down
  toll('palm', 88.5, P.pellHead(88.5), 'D4', 0, 'sustain', .95, 2.0);                            // S17: her hum on the bench; the palm drop lets go at about 90.0, lands at 90.32
  T.sort((a, b) => a.t0 - b.t0);
  const N = T.length;   // 22

  // ---- release math (the JS half; the GLSL half below has the same names)
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // where a drop hangs at time t: a drifting drop is stored field-local and rides on the field's centre (path.js fieldC),
  // a fixed drop (strand tips, the story drops) is stored in world space
  const posAt = (local, drifting, t) => drifting ? add(P.fieldC(t), local) : local;
  // When a drop lets go: the earliest toll of its band that reaches it, else 1e9. A toll is skipped when it is out of reach,
  // when it is a sustain that stops before HOLD (tremble only), or when its front passed before the drop existed:
  // since = the time the drop formed (sounds that passed earlier do nothing).
  // The drop's position is taken at the toll's t0, not at the moment the front arrives. The field drifts about 2 m/s against
  // sound's 30 m/s, so the error is small, and the GLSL releaseTime() makes exactly the same choice.
  function releaseTime(local, drifting, band, seed = 0, since = -1) {
    let tr = 1e9;
    for (const e of T) { if (e.band !== band) continue; const d = dist(posAt(local, drifting, e.t0), e.src); if (d > e.reach) continue;
      if (e.hold > 0 && e.dur < e.hold) continue; if (e.t0 + d / C_SOUND < since) continue; tr = Math.min(tr, e.t0 + d / C_SOUND + e.hold + .08 * seed); }
    return tr;
  }
  // every sound front (any band) that has reached point p by time t, with its arrival time ta. The reach is stretched by
  // 15% so the white-gold flash (GLSL evFlash) and the clothing meter (cast.js, M17) show a little past the release edge.
  function arrivals(p, t) { const out = []; for (const e of T) { const d = dist(p, e.src); if (d > e.reach * 1.15) continue; const ta = e.t0 + d / C_SOUND; if (ta <= t) out.push({ e, ta }); } return out; }
  // metres fallen tau seconds after release (0 before it), and its inverse: seconds to fall dh metres
  const fall = (tau, band = 0) => { const vt = VT[band]; return tau <= 0 ? 0 : (vt * vt / G) * Math.log(Math.cosh(G * tau / vt)); };
  const hitTau = (dh, band = 0) => { const vt = VT[band]; return (vt / G) * Math.acosh(Math.exp(G * Math.max(0, dh) / (vt * vt))); };

  // ---- uniforms: every material can read the table
  // uEv[k] = (source x, y, z, t0). 24 slots for 22 tolls; an empty slot sits far below the ground and starts at 1e9, so it
  // never fires (the GLSL loops also stop at uEvN).
  const U = F.U;
  U.uEv = { value: Array.from({ length: 24 }, (_, k) => { const e = T[k]; return e ? new THREE.Vector4(e.src[0], e.src[1], e.src[2], e.t0) : new THREE.Vector4(0, -1e4, 0, 1e9); }) };
  // uEvP[k] = (band bit mask 1 << band, reach, hold, dur)
  U.uEvP = { value: Array.from({ length: 24 }, (_, k) => { const e = T[k]; return e ? new THREE.Vector4(1 << e.band, e.reach, e.hold, e.dur) : new THREE.Vector4(0, 0, 0, 0); }) };
  U.uEvN = { value: N };
  // ---- the GLSL half. Pasted into a shader it declares the uniforms, brings in path.js's fieldC() / gustK(), and gives
  //      the same release and fall math as the JS above, plus three looks that read the table (flash, tremble, since).
  const GLSL = /* glsl */`
uniform vec4 uEv[24]; uniform vec4 uEvP[24]; uniform int uEvN;
${P.GLSL}
const float C_SOUND = 30.0, G_FILM = 6.0, EV_HOLD = 1.5;
// terminal velocity of a band (m/s), as VT in the JS
float vtOf(float band){ return band < 0.5 ? 14.0 : band < 1.5 ? 9.0 : 2.2; }
// does toll k speak to this band? uEvP[k].x holds the bit mask 1 << band; this reads bit 'band' with float maths
bool evHas(int k, float band){ return mod(floor(uEvP[k].x / exp2(band) + 0.001), 2.0) > 0.5; }
// when this drop lets go (1e9: never). local is field-local when drifting = 1, else world. Same rules as the JS
// releaseTime(): out of reach, a sustain shorter than its hold, or a front that passed before 'since' do nothing.
float releaseTime(vec3 local, float drifting, float band, float seed, float since){
  float tr = 1e9;
  for (int k = 0; k < 24; k++) { if (k >= uEvN) break; if (!evHas(k, band)) continue;
    vec3 p = local + drifting * fieldC(uEv[k].w); float d = distance(p, uEv[k].xyz);
    if (d > uEvP[k].y) continue; if (uEvP[k].z > 0.0 && uEvP[k].w < uEvP[k].z) continue;
    float ta = uEv[k].w + d / C_SOUND; if (ta < since) continue;
    tr = min(tr, ta + uEvP[k].z + 0.08 * seed); }
  return tr; }
// metres fallen and speed (m/s) tau seconds after release, and seconds to fall dh; acosh(x) is written log(x + sqrt(x*x - 1))
float fallDist(float tau, float band){ if (tau <= 0.0) return 0.0; float vt = vtOf(band); return vt * vt / G_FILM * log(cosh(G_FILM * tau / vt)); }
float fallVel(float tau, float band){ if (tau <= 0.0) return 0.0; float vt = vtOf(band); return vt * tanh(G_FILM * tau / vt); }
float hitTau(float dh, float band){ float vt = vtOf(band); float x = exp(G_FILM * max(dh, 0.0) / (vt * vt)); return vt / G_FILM * log(x + sqrt(x * x - 1.0)); }
// a sound front passing this point now: 1 at the moment of arrival, fading over 'w' seconds (any band). For flashes and meters.
float evFlash(vec3 p, float t, float w){ float f = 0.0;
  for (int k = 0; k < 24; k++) { if (k >= uEvN) break; float d = distance(p, uEv[k].xyz); if (d > uEvP[k].y * 1.15) continue;
    float ta = uEv[k].w + d / C_SOUND; float x = t - ta; if (x >= 0.0 && x < w) f = max(f, 1.0 - x / w); }
  return f; }
// a held note that has reached this drop but not yet released it: 0..1 growing tremble (M6). Only sustains (hold > 0).
// x is the time since the front arrived and 'end' the time the note stops, both in units of the hold, so the tremble
// grows as x*x until the drop lets go (x = 1) or the note stops early (a short hum: tremble, then stillness).
float evTremble(vec3 p, float t, float band){ float m = 0.0;
  for (int k = 0; k < 24; k++) { if (k >= uEvN) break; if (uEvP[k].z <= 0.0 || !evHas(k, band)) continue; float d = distance(p, uEv[k].xyz); if (d > uEvP[k].y) continue;
    float ta = uEv[k].w + d / C_SOUND; float x = (t - ta) / uEvP[k].z; float end = uEvP[k].w / uEvP[k].z; if (x > 0.0 && x < min(1.0, end)) m = max(m, x * x); }
  return m; }
// the most recent front to reach p: seconds since it arrived (1e3 if none). Drives the 'live drawing' (M18) and leaf springs.
float evSince(vec3 p, float t){ float s = 1e3;
  for (int k = 0; k < 24; k++) { if (k >= uEvN) break; float d = distance(p, uEv[k].xyz); if (d > uEvP[k].y * 1.15) continue;
    float x = t - uEv[k].w - d / C_SOUND; if (x >= 0.0) s = min(s, x); }
  return s; }`;

  // ---- wetness of the ground (M12): 0 dry .. 1 soaked, read by world.js (the jade colour) and life.js (sprouts, leaves).
  // Two sources, the larger wins:
  //   1. the big tolls that reach the field (FIELD_EV: reach > 30 m) wet the ground under the part of the field they
  //      released. A point counts if it lies under the field's ellipse at t0 and within the sound's reach measured about
  //      20 m down (reachH). It turns wet when the front has reached the column above it (hypot(dh, 18) / 30), the hold has
  //      passed, and the drops have fallen: about 2.2 s for heavy drops, 1.2 s more for marbles, 6 s more for mist
  //      (rough fall times from the field's underside). Mist alone only dampens (0.45).
  //   2. the green flood after the fall: terrace k turns wet at 75.5 + 0.5 (9 - k), top terrace first; the pond at 80.
  const FIELD_EV = T.filter(e => e.reach > 30);
  function wetAt(x, z, t) { let w = 0;
    for (const e of FIELD_EV) { const fc = P.fieldC(e.t0), ex = (x - fc[0]) / P.FIELD.rx, ez = (z - fc[2]) / P.FIELD.rz; if (ex * ex + ez * ez > 1.1) continue;
      const dh = Math.hypot(x - e.src[0], z - e.src[2]); const reachH = Math.sqrt(Math.max(0, e.reach * e.reach - 400)); if (dh > reachH) continue;
      const ta = e.t0 + Math.hypot(dh, 18) / C_SOUND + e.hold + 2.2 + (e.band === 2 ? 6 : e.band === 1 ? 1.2 : 0); w = Math.max(w, A.sm(ta, ta + 1.2, t) * (e.band === 2 ? .45 : 1)); }
    const k = V.terraceAt(x, z); if (k >= 1 && k <= 9) w = Math.max(w, A.sm(75.5 + .5 * (9 - k), 76.2 + .5 * (9 - k), t)); else if (k === 0) w = Math.max(w, A.sm(80, 81, t));
    return w; }

  F.events = { C_SOUND, G, VT, HOLD, STEP_HOLD, BAND, HOME, T, N, releaseTime, arrivals, fall, hitTau, posAt, GLSL, wetAt, FIELD_EV };
})();
