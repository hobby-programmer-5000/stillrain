// s16 · NOISE ALLOWED  (81.0 – 87.0)  bars 28–29
//
// Feeling: the first noise anyone has been allowed to make. Laughter is rain now.
// Camera: 50 mm handheld feel, moving along the crowd to Pell and Dun from the west; facing east, the sun low behind the camera.
//         From 84.5 it cranes up and back and widens to 22 mm, the aim rising to take in the rainbow over the Spillway.
// Action: children stomp puddles, frogs chorus, every laugh shakes a sparkling drizzle from the afterhang. 82.5 Dun wraps Pell in the ochre
//         shawl and taps her forehead. 84.0 Pell laughs out loud; a little sparkle shower forms over her own head.
//         84.75 the sun breaks through and a rainbow arcs over the Spillway behind them.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, E = F.engine, { keys, sm } = A;
  F.scene({ id: 's16', t0: 81, t1: 87, title: '소리를 내도 좋은 날 · Noise Allowed', update(s) {
    const pell = C.add(P.pell(s.abs).pos, [0, 1.0, 0]), dun = C.add(P.dun(s.abs).pos, [0, 1.1, 0]);
    const mid = C.v(pell, dun, .4);
    const up = A.ease.io(sm(3.5, 5.8, s.t));   // the crane for the rainbow, 84.5 -> 86.8
    const pos = C.add(C.add(mid, [keys(s.t, [[0, -12], [6, -6.5]]), 2.2, keys(s.t, [[0, -5], [6, -1.5]])]), [-5 * up, 2.2 * up, -1.5 * up]);
    // the low sun behind the camera, in the west (world.sunOverride stays set until a shot changes it; s17 clears it)
    if (F.world) F.world.sunOverride = { dir: C.norm([-.88, .36, .3]) };
    if (F.cast && F.cast.pellPose) F.cast.pellPose(s.abs, { expr: s.abs > 84 ? 'joyful' : 'wonder', mouth: s.abs > 84 && s.abs < 85.6 ? 'laugh' : null, wet: 1 });
    E.shadowFit(new THREE.Vector3(...mid), 30);
    return { cam: { pos: C.add(pos, C.hand(s.abs, .06, .9)), look: C.add(mid, [9 * up, .2 + 4.2 * up, -1.5 * up]), fov: A.lerp(C.mm(50), C.mm(22), up) },
      look: { focus: C.len(C.sub(mid, pos)), ap: .005 * (1 - up), rainbow: sm(84.75, 86.5, s.abs), bloom: .5, glow: .22, live: 1 } };
  } });
})();
