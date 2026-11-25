// s15 · GREEN FLOOD  (75.0 – 81.0)  bars 26–27
//
// Feeling: the valley drinks.
// Camera: 28 mm low wide at cloth level (5.4 m from Pell), then from 76.0 a crane up 22 m and back over the terraces,
//         turning to look down the valley to the west. The sun is set in the west (world.sunOverride).
// Action: Pell sits up soaked and blinking, hood flattened; Tock shakes off water with a smear. 75.5 the green flood cascades down the
//         terraces, gold to jade, one terrace every 0.5 s. Sprouts pop on twos, sky-vines corkscrew up, cisterns overflow, tadpoles plop in.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, E = F.engine, { sm } = A;
  F.scene({ id: 's15', t0: 75, t1: 81, title: '초록 홍수 · Green Flood', update(s) {
    const p = P.pell(s.abs), c = C.add(p.pos, [0, .6, 0]);
    const k = A.ease.io(sm(1.0, 6, s.t));   // the crane, 76.0 -> 81.0
    const end = C.add(c, [-30, 22, 24]);
    const pos = C.v(C.orbit(c, 5.4, 1.2, .3), end, k);
    const look = C.v(c, C.add(end, [-100, -26, -34]), A.ease.io(sm(.6, 5, s.t)));
    // (world.sunOverride stays set until a shot changes it; s16 sets its own, s17 clears it)
    if (F.world) F.world.sunOverride = { dir: C.norm([-.8, .5, .35]) };
    if (F.cast && F.cast.pellPose) F.cast.pellPose(s.abs, { expr: s.t < 2 ? 'stunned' : 'wonder', wet: 1 });
    E.shadowFit(new THREE.Vector3(...c), 30 + 80 * k);
    return { cam: { pos, look, fov: C.mm(28) }, look: { focus: C.len(C.sub(c, pos)), ap: .006 * (1 - k), bloom: .5, glow: .2, live: 1 } };
  } });
})();
