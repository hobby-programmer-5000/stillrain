// s03 · LIFE UNDER THE HUSH  (12.0 – 18.0)  bars 5–6
//
// Feeling: a village that talks with its hands. Small, quiet, busy.
// Camera: 50 mm lateral truck along Cistern Row (terrace 6) at about 1.3 m/s, eye height 1.25 m, the aim swinging from the
//         child to the frog (13.6–15.0). Crowd on twos.
//         15.45 cut: an insert on the dripfrog, 40 mm, low and close (0.95 -> 0.78 m), the trembling drop above it in frame.
// 13.5 a child's toy bell slips its mitten: a tiny sparkling ring of mist falls on two kids; the other child shushes.
// 14.25 a dripfrog swells and croaks a held D3; the strand drop above it trembles, lets go about 15.8, lands in its mouth about 16.1.
// Eye: greeting hands -> the toy bell and its little rain -> the frog and its drop.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, V = F.valley, E = F.engine, { keys, sm } = A;
  // at(th, u, h): a point on Cistern Row's terrace at angle th, u across it, h metres above the ground (like valley.onTerrace)
  const cr = V.places.cisternRow, R = th => V.ringR(cr.k, th);
  const at = (th, u, h) => { const r = A.lerp(V.ringR(cr.k - 1, th) + 1.2, R(th) - 1.5, u); const x = Math.cos(th) * r, z = Math.sin(th) * r; return [x, V.ground(x, z) + h, z]; };
  F.scene({ id: 's03', t0: 12, t1: 18, title: '쉿, 의 마을 · Life Under the Hush', update(s) {
    const th = keys(s.t, [[0, -1.555], [6, -1.62, 'lin']]);   // the truck: .065 rad along the row at a steady speed
    const pos = at(th, .02, 1.25);
    // look along the row toward the cisterns, swinging to the frog for the gulp
    const kid = P.kid, frog = P.frog, w = sm(1.6, 3.0, s.t);
    const look = C.v(C.add(kid, [0, .6, 0]), C.add(frog, [0, .25, 0]), w);
    if (s.t >= 3.45) {   // cut: the insert on the dripfrog, low and close, the trembling drop above it in frame (M8)
      const fr = F.life && F.life.frogs ? F.life.frogs[0] : { pos: frog, yaw: 0 }, u = sm(3.45, 6, s.t);
      const fc = C.add(fr.pos, [0, .17, 0]), fp = C.orbit(fc, A.lerp(.95, .78, u), fr.yaw + .38, .1);
      E.shadowFit(new THREE.Vector3(...fc), 3);
      return { cam: { pos: C.add(fp, C.hand(s.abs, .004)), look: C.add(fc, [0, .04, 0]), fov: C.mm(40), near: .02 },
        look: { focus: C.len(C.sub(fc, fp)), ap: .02, live: 1, edge: .5 } };
    }
    E.shadowFit(new THREE.Vector3(...P.kid), 18);
    return { cam: { pos: C.add(pos, C.hand(s.abs, .02)), look, fov: C.mm(50) }, look: { focus: C.len(C.sub(look, pos)), ap: .006, live: 1, edge: .5 } };
  } });
})();
