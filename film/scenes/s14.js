// s14 · CURTAIN  (72.0 – 75.0)  bar 25
//
// Feeling: the size of what she did.
// Camera: hard cut to a 28 mm wide from the east rim by the Spillway, about 30 m east of the cloth, looking west across the
//         upper valley; letterbox opens. Static, then a slight crane up (2 m).
// Action: a vast silver curtain pours across the upper valley in still-expanding rings; the leading fringe spills over the Spillway notch.
//         73.0 tiny Pell drops into the hush-cloth held by twenty villagers (squash-stretch bounce on ones). Splash crowns everywhere.
(function () {
  const F = FILM, C = F.cam, P = F.path, V = F.valley, E = F.engine;
  F.scene({ id: 's14', t0: 72, t1: 75, title: '비의 장막 · Curtain', update(s) {
    const cl = P.cloth.pos, pos = C.add(cl, [30, 6.5 + 2 * s.u, -7]);
    const look = C.add(cl, [-34, 7.5, 5]);
    E.shadowFit(new THREE.Vector3(...cl), 40);
    return { cam: { pos, look, fov: C.mm(28) }, look: { rays: .35, bloom: .55, glow: .22, live: 1 } };
  } });
})();
