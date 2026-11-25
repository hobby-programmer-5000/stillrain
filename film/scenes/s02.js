// s02 · HOLLOWMERE  (6.0 – 12.0)  bars 3–4
//
// Feeling: the whole place at once: a dry gold bowl, and above it a vast silver field breathing like a flock.
// Camera: 28 mm crane from behind a terrace wall on the south-west side (terrace 4; wall and cup-leaves in the foreground),
//         rising 2 -> 40 m while drifting 6 m east and 10 m north, tilting up from the far terraces to the field over the north-east.
// Action: stilt houses with round moss roofs, masts, cisterns. 9.0: a chimewing flock crosses and leaves dotted drizzle (FILM.life).
// Eye: the wall top -> the terraces stepping away -> the field over the north-east.
// Look: the drawing comes alive (live 1) at 9.0, when the wingbeats ring.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, V = F.valley, E = F.engine, { keys, sm } = A;
  const base = V.onTerrace(4, 2.35, .06);   // terrace 4, south-west, right against its inner wall
  F.scene({ id: 's02', t0: 6, t1: 12, title: '홀로미어 · Hollowmere', update(s) {
    const u = A.ease.io(sm(0, 6, s.t)), fc = P.fieldC(s.abs);
    const pos = C.add(base, [6 * u, 2 + 38 * u * u * .9 + 4 * u, -10 * u]);
    // the aim travels from a point over the north-east terraces up to the field's near edge
    const look = C.v([60, 18, -40], C.add(fc, [-20, -6, 0]), A.ease.io(sm(.5, 6, s.t)));
    E.shadowFit(new THREE.Vector3(60, 20, -60), 170);
    return { cam: { pos: C.add(pos, C.hand(s.abs, .05)), look, fov: C.mm(28) }, look: { rays: .25, flare: .4, bloom: .45, glow: .18, live: s.t > 3 ? 1 : 0 } };
  } });
})();
