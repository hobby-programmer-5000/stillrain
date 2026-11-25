// s04 · NOSE DROP  (18.0 – 24.0)  bars 7–8
//
// Feeling: eager, then told no. She is too small to be part of it.
// Camera: 85 mm close push-in on Pell on the hush-roof ridge (3.4 m -> 2.2 m by 22.3), sinking lower as it pushes in.
//         22.5–23.3 the reverse: her point of view down the slope to Dun (a lens that frames about 3 m at Dun's distance),
//         then back to her for the drooping shoulders.
// Action: she mittens her bell, rocking on her toes; Tock hops onto the crook. 20.25 her idle hum slides down onto D and holds;
//         the strand drop above her trembles, lets go about 21.8 and hits her nose at 22.4 (splash, two-drawing squash blink).
//         22.5 Dun shushes, finger to lips, then an open palm: wait, not you. Pell's shoulders drop (3-drawing hold).
// Eye: her face -> the trembling drop -> splash on the nose -> Dun (the reverse) -> back to her drooping shoulders.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, E = F.engine, { keys, sm } = A;
  F.scene({ id: 's04', t0: 18, t1: 24, title: '코끝의 비 · Nose Drop', update(s) {
    const p = P.pell(s.abs), head = P.pellHead(s.abs), y = p.yaw;
    const d = keys(s.t, [[0, 3.4], [4.3, 2.2, 'io'], [6, 2.0]]);
    const pos = C.orbit(head, d, y + .25, keys(s.t, [[0, -.08], [4.4, -.12], [5.6, -.3, 'io']]));
    const dunHead = C.add(P.dun(s.abs).pos, [0, 1.35, 0]);
    // the aim lifts a little to the drop above her (20.0–21.6), then settles back on her face
    const look = C.add(head, [0, keys(s.t, [[2.0, -.02], [3.6, .18], [4.5, .02]]), 0]);
    // her acting: eager, the hum ('o', 20.25–22.1), eyes up to the drop, stunned at the splash, then sad; eyes to Dun 22.5–23.3
    if (F.cast && F.cast.pellPose) F.cast.pellPose(s.abs, { expr: s.t < 4.4 ? 'eager' : s.t < 4.6 ? 'stunned' : 'sad',
      mouth: s.t > 2.25 && s.t < 4.1 ? 'o' : 'closed', gaze: s.t > 2.6 && s.t < 4.3 ? [0, -.6] : s.t > 4.5 && s.t < 5.3 ? [.5, -.1] : [0, 0] });
    if (s.t >= 4.5 && s.t < 5.3) {   // reverse: her point of view, down the slope to Dun: finger to lips, then the open palm
      const to = C.norm([dunHead[0] - head[0], 0, dunHead[2] - head[2]]), side = [to[2], 0, -to[0]];
      const rp = C.add(C.add(head, C.mul(to, .65)), C.add(C.mul(side, .12), [0, -.04, 0])), D = C.len(C.sub(dunHead, rp));
      E.shadowFit(new THREE.Vector3(...dunHead), 10);
      return { cam: { pos: C.add(rp, C.hand(s.abs, .006)), look: C.add(dunHead, [0, -.25, 0]), fov: 2 * Math.atan(1.5 / D) * 180 / Math.PI, near: .05 },
        look: { focus: D, ap: .01, live: 1, edge: .4 } };
    }
    E.shadowFit(new THREE.Vector3(...head), 10);
    return { cam: { pos: C.add(pos, C.hand(s.abs, .01)), look, fov: C.mm(85), near: .05 }, look: { focus: C.len(C.sub(head, pos)), ap: .012, live: 1, edge: .4 } };
  } });
})();
