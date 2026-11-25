// s01 · ONE DROP  (0.0 – 6.0)  bars 1–2
//
// Feeling: the world is holding its breath. One drop, and the whole valley upside down inside it.
// Camera: extreme macro on the strand-tip drop (FILM.path.special.macro), 12° lens, dolly out 0.8 m -> 14 m (0.3–5.8, eased,
//         most of it late) while the lens widens to 40°. The camera sits south of the drop looking north; the aim lifts
//         from the drop to the valley behind it. Fade up from black 0.0–0.75. More drops appear, then thousands.
// Eye: the drop -> the inverted gold valley inside it -> the strata of hanging rain behind.
// Sound: 0.75 one dry glass chime (B5), wind fades in, 3.0 a dry pad. Nothing falls.
// Look: silence, so the drawing is held (live 0, bible M18); focus stays on the drop while the aperture closes.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, E = F.engine, { keys, sm } = A;
  const D = P.special.macro.pos, back = [0, .25, 1];   // we look north across the valley, so the camera sits south of the drop
  F.scene({ id: 's01', t0: 0, t1: 6, title: '물방울 하나 · One Drop', update(s) {
    // k: 0..1 through the pull-back; distance and aim follow k*k so the move starts slow and opens up at the end
    const k = A.ease.io(sm(.3, 5.8, s.t)), d = .8 + 13.2 * k * k, fov = keys(s.t, [[0, 12], [5.8, 40, 'io']]);
    const cn = C.norm(back), pos = C.add(C.add(D, C.mul(cn, d)), [0, .6 * k * k, 0]), look = C.add(D, [0, -.04 + 2.2 * k * k, -6 * k * k]);
    E.shadowFit(new THREE.Vector3(...D), 12);
    // the hero drop turns a wider view upside down (.5 screen heights), and only drops nearer than .3 m go to bokeh
    // (rain.js resets both every frame, so this holds only while s01 runs)
    if (F.rain && F.rain.set) F.rain.set({ invert: .5, bokehNear: .3 });
    return { cam: { pos: C.add(pos, C.hand(s.t, .004 + .02 * k)), look, fov, near: .02 },
      look: { fade: 1 - sm(0, .75, s.t), focus: C.len(C.sub(D, pos)), ap: .03 * (1 - k) + .004, bloom: .5, glow: .2, live: 0, edge: .3 } };
  } });
})();
