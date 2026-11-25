// s12 · THE NOTE  (66.0 – 69.0)  bar 23
//
// Feeling: her own voice. The thing she was told to keep quiet is the thing that saves them.
// Camera: 50 mm frontal close-up, backlit (sun behind her), slow push (2.6 -> 1.9 m). Ink turns to pale rim lines; light leaks.
// Action: 66.0 she sings A4: a ring of light bursts out (impact pair in pale gold); marble beads flash and fall away in an expanding ring.
//         67.5 the note lifts to D5: a second, brighter ring. Every heavy drop trembles harder. Tock opens his bell-throat.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, E = F.engine, { keys } = A;
  F.scene({ id: 's12', t0: 66, t1: 69, title: '한 음 · The Note', update(s) {
    const p = P.pell(s.abs), head = P.pellHead(s.abs);
    const d = keys(s.t, [[0, 2.6], [3, 1.9, 'io']]);
    const pos = C.orbit(head, d, p.yaw, -.04);   // in front of her, nearly level
    // the sun behind her: opposite the camera, a little above
    // (world.sunOverride stays set until a shot changes it; s13 clears it)
    const back = C.norm(C.sub(head, pos)); if (F.world) F.world.sunOverride = { dir: C.norm([back[0], .42, back[2]]) };
    if (F.cast && F.cast.pellPose) F.cast.pellPose(s.abs, { expr: 'singing', mouth: s.abs < 67.5 ? 'ah' : 'oh' });
    E.shadowFit(new THREE.Vector3(...head), 10);
    const imp = s.abs >= 66.0 && s.abs < 66.083 ? 1 : s.abs >= 66.083 && s.abs < 66.167 ? 2 : 0;   // the impact pair, one drawing each
    const shock = F.rain && F.rain.shock ? F.rain.shock(s.abs, s.cam) : [];   // the voice's rings as screen ripples (rain.js)
    return { cam: { pos: C.add(pos, C.hand(s.abs, .01)), look: C.add(head, [0, .05, 0]), fov: C.mm(50), near: .05 },
      look: { focus: d, ap: .012, ink: 'pale', leak: .45, rays: .6, flare: .9, bloom: .7, glow: .3, impact: imp, impactC: '#FFE7A8', shock, live: 1 } };
  } });
})();
