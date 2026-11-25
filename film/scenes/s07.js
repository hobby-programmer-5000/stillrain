// s07 · THE GUST  (36.0 – 42.0)  bars 13–14
//
// Feeling: everything goes wrong at once, and only the smallest one is near.
// Camera: whip-pan 36.0–36.55 with horizontal speed lines, resolving to a 24 mm wide from terrace 3 on the west side (3 -> 5 m up),
//         aimed between Pell and the sliding field; a heavy, quick hand; then the gust's own speed lines.
// Action: a cloud shadow races in; felt curtains and cupola sleeves snap in a chain; the field tears loose and slides toward the Spillway.
//         Fanners stumble, paddles twist. 39.0 every hood turns east, staggered on twos. Pell, alone near the rim, grips her staff.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, V = F.valley, E = F.engine, { sm } = A;
  const pos0 = V.onTerrace(3, 2.75, .5);
  F.scene({ id: 's07', t0: 36, t1: 42, title: '돌풍 · The Gust', update(s) {
    const pos = C.add(pos0, [0, 3.0 + 2 * s.u, 0]);
    const fc = P.fieldC(s.abs), pell = P.pell(s.abs).pos;
    // the aim: 18 m above Pell, a third of the way toward the field's centre. The whip swings the heading 1.7 rad onto it.
    const yaw = C.whip(s.t, 0, .55, -1.7, 0), target = C.v(C.add(pell, [0, 18, 0]), fc, .35);
    const dir = C.norm(C.sub(target, pos)), base = Math.atan2(dir[0], dir[2]);
    const look = C.add(pos, [Math.sin(base + yaw) * 50, dir[1] * 50, Math.cos(base + yaw) * 50]);
    E.shadowFit(new THREE.Vector3(...pell), 90);
    const sp = s.t < .6 ? 1 : .35 * P.gust(s.abs);   // full speed lines during the whip, then as strong as the wind
    return { cam: { pos: C.add(pos, C.hand(s.abs, .12, 1.1)), look, fov: C.mm(24) }, look: { speed: sp, speedMode: 1, live: 1 } };
  } });
})();
