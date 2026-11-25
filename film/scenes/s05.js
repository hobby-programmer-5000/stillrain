// s05 · THE TOLL  (24.0 – 33.0)  bars 9–11
//
// Feeling: the village working as one; the first rain of the film comes down as a ring you can watch travel.
// Camera: 35 mm high tracking behind the fan teams (22 m from the middle fan, about 30° above), craning down by 27.0 to a low
//         angle under the field, about 40 m south-west of the drum; the aim rises with the ring (27–30) and the hand shakes
//         when the drum hits.
// Action: fanners sweep in unison, the field bulges with fan-shaped dents; Pell runs alongside, empty-handed.
//         27.0 Dun strikes D2: a ring crosses the field at 30 m/s, beads flash and the heavy layer falls as an expanding curtain.
//         Every villager's tassels shiver as the front passes. 30.0 three masts ring A4: a finer band peels away.
// Eye: the paddles -> the dented field -> (27) the ring of flashing beads -> the curtain landing on the top terrace.
(function () {
  const F = FILM, A = F.anim, C = F.cam, P = F.path, V = F.valley, E = F.engine, { keys, sm } = A;
  const drum = V.places.tollTerrace.drum;
  F.scene({ id: 's05', t0: 24, t1: 33, title: '울림 · The Toll', update(s) {
    const fans = P.fans(s.abs), mid = fans[8].pos;   // fan 8: the middle of the three teams
    const k = A.ease.io(sm(0, 3.0, s.t));            // 24 -> 27: from the high track to the low angle
    const high = C.orbit(mid, 22, -2.4, .55);
    const low = C.add(drum, [-26, 2.0, 30]);
    const pos = C.v(high, low, k);
    const look = C.v(C.add(mid, [8, 4, 0]), C.add(drum, [6, 20 + 4 * sm(3, 6, s.t), -6]), k);
    E.shadowFit(new THREE.Vector3(...drum), 60);
    // A.ring: a damped spring struck at 27.0, so the hand jolts with the drum and settles
    return { cam: { pos: C.add(pos, C.hand(s.abs, .04 + .06 * Math.abs(A.ring(s.abs, 27, 3, .2)))), look, fov: C.mm(35) },
      look: { rays: .35, flare: .5, bloom: .5, glow: .2, live: 1 } };
  } });
})();
