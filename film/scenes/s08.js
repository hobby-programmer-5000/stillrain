// s08 · THE RUN  (42.0 – 48.0)  bars 15–16
//
// Feeling: reckless. She does not stop to think.
// Camera: 85 mm side-on track with her from 13 m on the valley side, foreground wall parallax; from 44.5 to 47.0 it cranes up
//         2 m and tilts up as she climbs. Light speed lines on the sprint (42.0–43.2).
// Action: sprint along the terrace-9 edge, bounce off the Listeners' hut roof (moss squish), land on the Spillway mast at 44.25
//         (3-drawing crouch, 2-frame smear on ones), climb in two smeared scrambles, 46.1 leap from the top onto the first jelly drop (46.5).
//         Pell is drawn on ones from 46.0 (the launch is sakuga).
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, E = F.engine, { sm } = A;
  F.scene({ id: 's08', t0: 42, t1: 48, title: '달리기 · The Run', update(s) {
    const p = P.pell(s.abs).pos;
    const target = C.add(p, [0, .7, 0]);
    const inward = [-p[0] / Math.hypot(p[0], p[2]), 0, -p[2] / Math.hypot(p[0], p[2])];   // toward the valley centre: we watch from inside
    const pos = C.add(C.add(target, C.mul(inward, 13)), [0, .9 + 2.0 * sm(2.5, 5, s.t), 0]);
    E.shadowFit(new THREE.Vector3(...p), 18);
    if (F.cast && F.cast.pellPose) F.cast.pellPose(s.abs, { expr: 'determined', onOnes: s.t > 4.0 });
    return { cam: { pos: C.add(pos, C.hand(s.abs, .03, 1.4)), look: C.add(target, [0, 1.2 * sm(2.5, 5, s.t), 0]), fov: C.mm(85) },
      look: { focus: 13, ap: .008, live: 1, speed: .25 * sm(0, .3, s.t) * (1 - sm(.8, 1.2, s.t)), speedMode: 1 } };
  } });
})();
