// s06 · GREEN FLASH  (33.0 – 36.0)  bar 12
//
// Feeling: relief. The village exhales.
// Camera: 40 mm wide from 9 m above the north end of terrace 9, a slow pan across the cupolas (the aim 30 m out, sinking with
//         the veil). 33.0 the cupola bells ring E6 and the mist veil sinks as glittering haze.
// Cup-leaves swivel in spreading waves and fill; wet patches flash jade; villagers' shoulders drop together; tadpoles plop into a cistern.
// About two thirds of the field still hangs overhead.
(function () {
  const F = FILM, A = F.anim, C = F.cam, V = F.valley, E = F.engine, { keys } = A;
  const c0 = V.cupolas[0];
  F.scene({ id: 's06', t0: 33, t1: 36, title: '초록 번짐 · Green Flash', update(s) {
    const pos = C.add(V.onTerrace(9, -1.05, .9), [0, 9, 0]);
    const yaw = keys(s.t, [[0, -.35], [3, -.15, 'lin']]);   // the pan: .2 rad over the shot
    const look = C.add(c0, [Math.sin(yaw) * 30, 10 - 4 * s.u, Math.cos(yaw) * 30]);
    E.shadowFit(new THREE.Vector3(...c0), 70);
    return { cam: { pos, look, fov: C.mm(40) }, look: { rays: .3, bloom: .5, glow: .2, live: 1 } };
  } });
})();
