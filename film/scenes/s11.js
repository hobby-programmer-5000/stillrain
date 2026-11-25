// s11 · MA  (60.0 – 66.0)  bars 21–22
//
// Feeling: silence. The held breath before everything.
// Camera: letterbox 2.39 eases in (60.0–61.5). One continuous push from 34 m away in the field (24 mm) to 0.62 m from her eye
//         (105 mm) by 64.5. It starts a little above her and ends under the hood brim, looking up into the eye.
// Action: she stands on one drop at the heart of the glittering field; far below, tiny hoods on dry gold; a team runs uphill with the cloth.
//         64.5 a tiny test hum escapes her (D4): the drop beside her face shivers, her brows lift. 65.25 she inhales (3-drawing hold).
// Look: the drawing is held (live 0: grain and boil on fours).
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, E = F.engine, { sm } = A;
  F.scene({ id: 's11', t0: 60, t1: 66, title: '마(間) · Ma', update(s) {
    const p = P.pell(s.abs), head = P.pellHead(s.abs);
    const k = A.ease.io(sm(0, 4.5, s.t));          // 0..1 through the push (60.0 -> 64.5)
    const d = A.lerp(34, .62, Math.pow(k, .6));     // k^.6: the distance closes fast at first, then slowly onto the eye
    const fov = A.lerp(C.mm(24), C.mm(105), k);
    if (F.cast && F.cast.pellPose) F.cast.pellPose(s.abs, { expr: s.t < 4.5 ? 'still' : 'wonder', mouth: s.abs > 64.5 && s.abs < 64.95 ? 'o' : 'closed', gaze: [0, s.t < 4 ? -.6 : 0] });
    // aim at the drawn eye (the pose bows her head), falling back to the path's head
    let eye = C.add(head, [0, -.02, 0]); const ea = F.cast && F.cast.pell && F.cast.pell.eye;
    if (ea && ea.getWorldPosition) { ea.updateWorldMatrix(true, false); const w = ea.getWorldPosition(new THREE.Vector3()); eye = [w.x, w.y + .012, w.z]; }
    // orbit pitch .18 -> -.26 rad: from above her to below the brim
    const pos = C.orbit(eye, d, p.yaw + .1, A.lerp(.18, -.26, k));
    E.shadowFit(new THREE.Vector3(...head), 12);
    return { cam: { pos, look: eye, fov, near: .02 }, look: { focus: d, ap: .004 + .014 * k, live: 0, grain: .02 } };
  } });
})();
