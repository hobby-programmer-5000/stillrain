// s09 · STEPPING STONES  (48.0 – 54.0)  bars 17–18
//
// Feeling: the joy and terror of running on rain.
// Camera: 35 mm ascending orbit 6.2 m round her, swinging about 105° across her front (never past 120°), always 3/4 front;
//         Pell no more than a third of the frame.
// Action: she hops up a staircase of heavy drops; each squashes, holds 0.75 s and falls behind her as a streak. Bead curtains part
//         and close; snails cling on; chimewings burst away in drizzle trails; the sun flares through the beads.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, E = F.engine, { keys } = A;
  F.scene({ id: 's09', t0: 48, t1: 54, title: '징검다리 · Stepping Stones', update(s) {
    const p = P.pell(s.abs), c = C.add(p.pos, [0, .8, 0]);
    // the orbit is measured from the way she faces (+.9 -> -.95 rad) and rises a little (pitch -.12 -> .05)
    const yaw = p.yaw + keys(s.t, [[0, .9], [6, -.95, 'lin']]);
    const pos = C.orbit(c, 6.2, yaw, keys(s.t, [[0, -.12], [6, .05]]));
    E.shadowFit(new THREE.Vector3(...p.pos), 16);
    return { cam: { pos: C.add(pos, C.hand(s.abs, .05)), look: c, fov: C.mm(35) }, look: { focus: 6.2, ap: .006, flare: .7, rays: .3, live: 1 } };
  } });
})();
