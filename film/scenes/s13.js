// s13 · THE FALLING STAIRCASE  (69.0 – 72.0)  bar 24
//
// Feeling: free fall, and the rain hangs still around her because it is falling with her.
// Camera: 28 mm locked to Pell on the same fall (FILM.path.pell), 3.4 m away, above and behind her shoulder; the horizon
//         rolls gently, within 5°. Vertical speed lines at the edges.
// Action: 69.0 Tock trills E6 and the heavy band lets go. The whole field falls in rings. She runs across the falling drops toward the cloth,
//         on ones (sakuga), cape and tassels streaming up. The terraces and the cloth rush up from below.
(function () {
  const F = FILM, C = F.cam, P = F.path, E = F.engine;
  F.scene({ id: 's13', t0: 69, t1: 72, title: '떨어지는 계단 · The Falling Staircase', update(s) {
    const p = P.pell(s.abs), c = C.add(p.pos, [0, .7, 0]);
    const pos = C.orbit(c, 3.4, p.yaw + 2.5, .16);
    const look = C.add(c, [0, -.15, 0]);
    // her velocity (m/s, a central difference over .02 s): the rain draws its streaks relative to the falling camera
    const vel = C.mul(C.sub(P.pell(s.abs + .01).pos, P.pell(s.abs - .01).pos), 50);
    if (F.rain && F.rain.set) F.rain.set({ camVel: vel });
    if (F.world) F.world.sunOverride = null;   // back to the sun of the time of day after s12's backlight
    if (F.cast && F.cast.pellPose) F.cast.pellPose(s.abs, { expr: 'determined', onOnes: true });
    E.shadowFit(new THREE.Vector3(...p.pos), 14);
    return { cam: { pos: C.add(pos, C.hand(s.abs, .05, 2)), look, fov: C.mm(28), roll: .06 * Math.sin(s.t * 1.3) },
      look: { speed: .55, speedMode: 2, ink: 'pale', bloom: .6, live: 1 } };
  } });
})();
