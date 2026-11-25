// s17 · STAYS  (87.0 – 93.0)  bars 30–31
//
// Feeling: hours later, quiet. The cracked bell, and one drop that stays.
// Camera: dusk. A near-profile close on her cupped palm (1.6 -> 1.15 m) until the drop has landed; from 90.4 a slow
//         pull-back crane to 15 m from her, 35 mm -> 24 mm.
// Action: peach-lilac sky; flooded terraces mirror it in stepped bands. Pell on the Spillway bench, cracked bell in her lap, Tock on her hood.
//         A fresh field glints cool lilac-silver over the north peaks. 88.5 she hums D4; the stray drop before her trembles and falls
//         into her cupped palm at 90.3 (the inverted dusk valley inside, rhyming with s01).
//         90.5 STILLRAIN writes itself stroke by stroke (film/titles.js), then 머문 비 from 91.7. Fade to black 92.4–93.0.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, E = F.engine, { sm } = A;
  F.scene({ id: 's17', t0: 87, t1: 93, title: '머문 비 · Stays', update(s) {
    const p = P.pell(s.abs), palm = P.palmPos, c = C.add(p.pos, [0, .5, 0]);
    const k = A.ease.io(sm(3.4, 6, s.t));   // hold on the palm until the drop has landed (90.32), then pull back
    const pos = C.v(C.orbit(palm, A.lerp(1.6, 1.15, sm(0, 3.4, s.t)), p.yaw + 1.15, -.1), C.orbit(c, 15, p.yaw + 1.05, .3), k);
    const look = C.v(C.add(palm, [0, .2, 0]), C.add(c, [-4, 3.5, -8]), k);
    if (F.world) F.world.sunOverride = null;   // the dusk light of world.js
    if (F.cast && F.cast.pellPose) F.cast.pellPose(s.abs, { expr: 'peace', mouth: s.abs > 88.5 && s.abs < 90.4 ? 'hum' : 'closed', gaze: [0, -.5] });
    E.shadowFit(new THREE.Vector3(...c), 12 + 40 * k);
    // focus follows the aim from the palm to her; the drawing is alive only while the hum and the drop play (88.4–91)
    return { cam: { pos, look, fov: A.lerp(C.mm(35), C.mm(24), k), near: .03 },
      look: { focus: C.len(C.sub(C.v(palm, c, k), pos)), ap: .01 * (1 - k), fade: sm(92.4, 93, s.abs), bloom: .55, glow: .25, live: s.abs > 88.4 && s.abs < 91 ? 1 : 0 } };
  } });
})();
