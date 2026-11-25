// s10 · THE BELL  (54.0 – 60.0)  bars 19–20
//
// Feeling: trying with everything she has, and it is not enough.
// Camera: 50 mm close-up 2.1 m from her face, slight low angle; the bell hand in the foreground, focus racking from her face to
//         the bell (56.4–56.9) and back by 57.6.
// Action: 54.0 she unmittens the bell and rings it (E6, reach 4 m): only a small puff of mist falls. Faster and harder:
//         54.75 55.5 55.875 56.25 56.625. 57.0 the bell CRACKS: smear, inverted two-tone frame, flat persimmon frame.
//         The shard and clapper tumble away; she stares at the dead bell. 57.0–60.0 is silent.
// Look: impact frames 57.0 (inverted two-tone) and 57.083 (flat persimmon fill), a white flash at 57.167; after 57.0 the
//       drawing is held (live 0).
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, E = F.engine, { sm } = A;
  F.scene({ id: 's10', t0: 54, t1: 60, title: '종 · The Bell', update(s) {
    const head = P.pellHead(s.abs), hand = P.pellHand(s.abs), y = P.pell(s.abs).yaw;
    const pos = C.orbit(head, 2.1, y + .45, -.2);
    const rack = sm(2.4, 2.9, s.t) * (1 - sm(3.2, 3.6, s.t));   // 0 = her face, 1 = the bell
    const look = C.v(C.v(head, hand, .35), hand, rack * .6);
    if (F.cast && F.cast.pellPose) F.cast.pellPose(s.abs, { expr: s.t < 1.4 ? 'determined' : s.t < 3 ? 'strain' : 'stunned', gaze: s.t > 3.2 ? [.25, -.7] : [.2, -.3] });
    E.shadowFit(new THREE.Vector3(...head), 8);
    // one drawing (1/12 s) each: 1 = inverted two-tone, 2 = flat colour fill (engine.js)
    const imp = s.abs >= 57.0 && s.abs < 57.083 ? 1 : s.abs >= 57.083 && s.abs < 57.167 ? 2 : 0;
    const focus = A.lerp(C.len(C.sub(head, pos)), C.len(C.sub(hand, pos)), rack);
    return { cam: { pos: C.add(pos, C.hand(s.abs, .015 + (s.t < 3 ? .01 : 0))), look, fov: C.mm(50), near: .05 },
      look: { focus, ap: .012, impact: imp, impactC: '#E4572E', live: s.t < 3 ? 1 : 0, flash: s.abs >= 57.167 && s.abs < 57.25 ? .3 : 0 } };
  } });
})();
