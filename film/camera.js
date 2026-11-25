// camera.js - the cinematographer's kit the shots share: lenses, moves, a hand on the camera, focus.
// Everything returns plain arrays so a shot can mix them with FILM.anim.keys.
// FILM.cam: mm (lens -> fov), v add sub mul len norm (3-vector maths on [x, y, z]), orbit, hand, whip, toward, focusOn, along.
// A shot uses it like this (see any file in film/scenes/):
//   const C = F.cam, pos = C.add(C.orbit(target, 6, yaw, .2), C.hand(s.abs));
//   return { cam: { pos, look: target, fov: C.mm(50) }, look: { focus: C.len(C.sub(target, pos)), ap: .006 } };
// Units: metres, radians, seconds. Reads FILM.anim (lerp, clamp, wobble, ease, crPoint).
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim, { lerp, clamp, keys } = A;
  // a full-frame lens: focal length in mm -> vertical field of view in degrees (24 mm tall sensor). 35 mm -> 37.8 deg, 85 mm -> 16.1 deg
  const mm = f => 2 * Math.atan(12 / f) * 180 / Math.PI;
  const v = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const len = a => Math.hypot(a[0], a[1], a[2]), norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  // a point at distance d from c, at compass yaw (0 = +z, PI/2 = +x) and pitch (up positive)
  const orbit = (c, d, yaw, pitch = 0) => [c[0] + Math.sin(yaw) * Math.cos(pitch) * d, c[1] + Math.sin(pitch) * d, c[2] + Math.cos(yaw) * Math.cos(pitch) * d];
  // a hand on the camera: a small smooth drift (breathing), amp metres at most, rate in wobbles a second, seed picks the
  // curve. It moves every frame ("on ones"), unlike the held poses; add it to a position
  const hand = (t, amp = .02, rate = .6, seed = 1) => [A.wobble(t * rate, seed) * amp, A.wobble(t * rate, seed + 7) * amp * .7, A.wobble(t * rate, seed + 13) * amp];
  // a whip pan: a value (usually an angle) that rushes from a to b over dur seconds from t0, slow-fast-slow. There is no
  // motion blur; the look's speed lines sell the speed
  const whip = (t, t0, dur, a, b) => lerp(a, b, A.ease.io(clamp((t - t0) / dur)));
  // the point d metres from `from` in the direction of `to` (for framing over a shoulder)
  const toward = (from, to, d) => add(from, mul(norm(sub(to, from)), d));
  // focus: distance from the camera to a point (the look's `focus`)
  const focusOn = (camPos, p) => len(sub(p, camPos));
  // a move along points (Catmull-Rom), u 0..1; u is spread evenly over the segments, not by length
  const along = (pts, u) => A.crPoint(pts, clamp(u));
  F.cam = { mm, v, add, sub, mul, len, norm, orbit, hand, whip, toward, focusOn, along };
})();
