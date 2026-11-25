// valley.js - the map of Hollowmere. One analytic ground, the same in JS and GLSL, and every named place.
//
// Units are metres, y is up. The valley is a bowl centred on the origin: east is +x, north is -z, the sun is high in the south.
//   pond      r < R0 (about 40 m), water at y = 0
//   terraces  nine rings k = 1..9, terrace k between R(k-1) and R(k), its flat top at y = 3.2 k, a dry-stone wall on its inner edge
//   rim       beyond R9 the ground rises to a crest (about 36 m), then to peaks of roughly 90-140 m
//   Spillway  a notch 22 m wide in the east crest (angle 0), down to 27 m; beyond it a cliff to the Hushlands at -50 m
// Ring radii wobble with the angle through a few sines (no textures), so the GLSL copy is exact and cheap.
// ground(x, z) is a height field: polar angle and radius pick the ring, and smoothsteps make the walls and the crest.
// There is no mesh data here; world.js builds the terrain mesh from ground() and shaders call vGround() for the same heights.
//
// Public API (FILM.valley; film/CONTRACT.md has the full list):
//   ground(x, z) -> y      terraceAt(x, z) -> 0 pond, 1..9, 10 rim      normalAt(x, z)      wob(th)
//   ringR(k, th)           the outer radius of terrace k (k = 0: the pond's edge)
//   onTerrace(k, th, u)    a point on terrace k at angle th, u = 0 inner wall .. 1 outer edge -> [x, y, z]
//   GLSL                   float vWob(th), vPeaks(th), vGround(vec2 xz): ground() for shaders
//   places { tollTerrace, spillway, cisternRow, pellRoof, pond }, houses, HOUSE, roofY, houseToWorld, masts, cisterns, cupolas
//   TH 3.2, DEPTH 16.5, R0 40, NT 9, CREST 36, NOTCH_Y 27
// Reads: FILM.anim (smoothstep, lerp, the seeded stream 'houses'). Drawn by world.js, or by stub.js when world.js is left out.
// See it: node tools/shot.mjs --test valley --k 0,1,2,3,4,5 --cols 3 --out build/valley.jpg   (world.js's views of the bowl)
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim, { clamp, sm, lerp } = A;
  // TH: rise of one terrace; DEPTH: ring spacing; R0: pond radius; NT: number of terraces; WALL: width of a wall's slope (m)
  const TH = 3.2, DEPTH = 16.5, R0 = 40, NT = 9, WALL = .9;
  // how far the rings wobble at angle th (m, within about ±5.3): three sines, so the GLSL copy is exact
  const wob = th => 3.0 * Math.sin(3 * th + .7) + 2.0 * Math.sin(5 * th + 1.9) + 1.2 * Math.sin(9 * th + .4);
  // outer radius of ring k; the wobble grows outward (x0.5 at the pond, x1.5 at the rim)
  const ringR = (k, th) => R0 + DEPTH * k + wob(th) * (.5 + k / NT);           // k = 0..9
  const CREST = 36, NOTCH_Y = 27, NOTCH_W = .06;                                  // notch half-width in radians (about 11 m at the rim)
  // 1 inside the Spillway notch (angle near 0, due east), 0 outside, with a soft edge .05 rad wide
  const notch = th => { const a = Math.atan2(Math.sin(th), Math.cos(th)); return 1 - sm(NOTCH_W, NOTCH_W + .05, Math.abs(a)); };
  // how tall the mountains are at angle th (0.22 .. about 1.25)
  const peaks = th => Math.max(.22, .55 + .45 * Math.sin(2 * th + 1.3) * Math.sin(3.3 * th + .2) + .25 * Math.sin(7 * th + 2.1));
  // the ground height at (x, z)
  function ground(x, z) {
    const r = Math.hypot(x, z), th = Math.atan2(z, x);
    const w = wob(th), R = k => R0 + DEPTH * k + w * (.5 + k / NT);
    if (r < R(0)) return -.8 + .8 * sm(R(0) - 10, R(0), r);                          // the pond bed
    // the terraces: f counts rings out from the pond; band k runs from height 3.2 k up to 3.2 (k + 1) across the wall at R(k).
    // The band index uses only the 0.5 w part of the wobble while the wall sits at R(k) with w (0.5 + k / 9), so where wob is
    // negative an outer wall falls before its band starts and shows as a hard step at the band edge, a few metres outside
    // ringR(k). JS and GLSL do the same, and terraceAt() uses the same bands, so nothing disagrees on screen.
    if (r < R(NT)) { const f = (r - R0 - w * .5) / DEPTH; let k = Math.floor(f); k = clamp(k, 0, NT - 1);
      // the wall at the inner edge of terrace k+1 sits at R(k)
      const rk = R(k), hTop = TH * (k + 1), hLow = TH * k;
      const wall = sm(rk - WALL * .3, rk + WALL * .7, r);
      const lip = .12 * Math.sin(th * 23 + k) * .5;                                  // terrace tops are not perfectly flat
      return lerp(hLow, hTop, wall) + lip * sm(rk + 2, rk + 6, r); }
    // the rim: up from terrace 9 (28.8 m) to the crest over 14 m, then the mountains climb (.32 m per m times peaks, more
    // beyond 120 m), capped at 40 + 100 peaks
    const R9 = R(NT), d = r - R9, n = notch(th);
    const crest = TH * NT + (CREST - TH * NT) * sm(0, 14, d);
    let h = crest + Math.max(0, d - 14) * .32 * peaks(th) + Math.max(0, d - 120) * .25 * peaks(th + 1.1);
    h = Math.min(h, 40 + 100 * peaks(th));
    // the Spillway: the crest cut to 27 m, and beyond it the cliff to the Hushlands
    if (n > 0) { const cut = lerp(h, Math.min(h, NOTCH_Y), n); h = lerp(cut, -50, sm(18, 34, d) * n); }
    // the far east beyond the notch opens onto the plain
    const east = sm(.5, .2, Math.abs(Math.atan2(Math.sin(th), Math.cos(th)))) * sm(30, 60, d);
    return lerp(h, Math.min(h, -50 + 6 * Math.sin(x * .01) * Math.cos(z * .013)), east);
  }
  // terrace index (0 = pond, 1..9, 10 = rim), banded exactly as ground() bands it
  function terraceAt(x, z) { const r = Math.hypot(x, z), th = Math.atan2(z, x), w = wob(th); if (r < R0 + w * .5) return 0; const f = (r - R0 - w * .5) / DEPTH; return Math.min(NT + 1, Math.floor(f) + 1); }
  // the ground's normal by central differences e metres apart
  const normalAt = (x, z, e = .25) => { const hx = ground(x + e, z) - ground(x - e, z), hz = ground(x, z + e) - ground(x, z - e); const n = new THREE.Vector3(-hx, 2 * e, -hz); return n.normalize(); };
  // a point on terrace k at angle th, u = 0 at its inner wall .. 1 at its outer edge
  // (kept 1.2 m clear of the inner wall and 1.5 m short of the next one)
  const onTerrace = (k, th, u = .5) => { const r = lerp(ringR(k - 1, th) + 1.2, ringR(k, th) - 1.5, u); const x = Math.cos(th) * r, z = Math.sin(th) * r; return [x, ground(x, z), z]; };

  // GLSL copy of ground(). Keep it in step with the JS above.
  const GLSL = /* glsl */`
// wob() and peaks() of the JS
float vWob(float th){ return 3.0 * sin(3.0 * th + 0.7) + 2.0 * sin(5.0 * th + 1.9) + 1.2 * sin(9.0 * th + 0.4); }
float vPeaks(float th){ return max(0.22, 0.55 + 0.45 * sin(2.0 * th + 1.3) * sin(3.3 * th + 0.2) + 0.25 * sin(7.0 * th + 2.1)); }
// ground(x, z) with the constants written out: R0 40, DEPTH 16.5, TH 3.2, the wall 0.27 / 0.63 m either side of rk
// (WALL .3 / .7), 28.8 = terrace 9, the crest 36, the notch 0.06 rad wide to 27 m, the Hushlands -50
float vGround(vec2 p){
  float r = length(p), th = atan(p.y, p.x), w = vWob(th);
  float R0 = 40.0 + w * 0.5;
  // the pond bed
  if (r < R0) return -0.8 + 0.8 * smoothstep(R0 - 10.0, R0, r);
  float R9 = 40.0 + 16.5 * 9.0 + w * 1.5;
  // the terraces: band k, its wall at rk, and the lip on the terrace top
  if (r < R9) { float k = clamp(floor((r - 40.0 - w * 0.5) / 16.5), 0.0, 8.0); float rk = 40.0 + 16.5 * k + w * (0.5 + k / 9.0);
    float wall = smoothstep(rk - 0.27, rk + 0.63, r); float lip = 0.06 * sin(th * 23.0 + k);
    return mix(3.2 * k, 3.2 * (k + 1.0), wall) + lip * smoothstep(rk + 2.0, rk + 6.0, r); }
  // the rim, the mountains, the Spillway notch and its cliff, the plain beyond
  float d = r - R9; float a = atan(sin(th), cos(th)); float n = 1.0 - smoothstep(0.06, 0.11, abs(a));
  float h = 28.8 + (36.0 - 28.8) * smoothstep(0.0, 14.0, d) + max(0.0, d - 14.0) * 0.32 * vPeaks(th) + max(0.0, d - 120.0) * 0.25 * vPeaks(th + 1.1);
  h = min(h, 40.0 + 100.0 * vPeaks(th));
  if (n > 0.0) { float cut = mix(h, min(h, 27.0), n); h = mix(cut, -50.0, smoothstep(18.0, 34.0, d) * n); }
  float east = smoothstep(0.5, 0.2, abs(a)) * smoothstep(30.0, 60.0, d);
  return mix(h, min(h, -50.0 + 6.0 * sin(p.x * 0.01) * cos(p.y * 0.013)), east);
}`;

  // ---- named places
  const P = (k, th, u) => onTerrace(k, th, u);
  const places = {
    // terrace 9 below the north-east rim: Dun's drum station, three chime masts 40 m apart, the fanners' ground
    tollTerrace: { k: 9, th: -.52, drum: P(9, -.52, .45), masts: [P(9, -.74, .7), P(9, -.52, .78), P(9, -.30, .7)] },
    // the east shoulder by the notch: the 12 m Spillway mast and the Listeners' bench
    // (notch: a point on the notch floor; mast 3.5 m and bench 5 m outside terrace 9, a little north of due east)
    spillway: { notch: [ringR(9, 0) + 8, NOTCH_Y, 0], mast: (() => { const th = -.085, r = ringR(9, th) + 3.5; const x = Math.cos(th) * r, z = Math.sin(th) * r; return [x, ground(x, z), z]; })(), mastH: 12,
      bench: (() => { const th = -.16, r = ringR(9, th) + 5; const x = Math.cos(th) * r, z = Math.sin(th) * r; return [x, ground(x, z), z]; })() },
    // terrace 6 on the north side: the path between a wall and a row of bell cisterns
    cisternRow: { k: 6, th0: -1.92, th1: -1.38 },
    // Pell's roof (S04): a house on terrace 8
    pellRoof: { k: 8, th: -.62 },
    pond: { r: R0 },
  };
  // houses: about 45 on the south-facing (north) slope, terraces 2..8, on stilts
  // (seeded, so the village is the same every load; about half the houses are left out along Cistern Row so the path reads,
  // and none stand close to Pell's roof)
  const houses = []; { const r = A.named('houses'); for (let k = 2; k <= 8; k++) { const n = 4 + Math.round(k * .45); for (let i = 0; i < n; i++) {
    const th = lerp(-2.65, -.5, (i + .2 + .6 * r()) / n); if (k === 6 && th > places.cisternRow.th0 && th < places.cisternRow.th1 && r() < .5) continue;
    if ((k === 8 || k === 7) && Math.abs(th - places.pellRoof.th) < .1) continue;   // keep Pell's roof clear
    const p = P(k, th, .55 + .3 * r()); houses.push({ k, th, pos: p, size: .85 + .4 * r(), rot: th + Math.PI / 2 + (r() - .5) * .4, seed: r() }); } } }
  // a house, in its own frame (x along the ridge, z across, y up from the ground at pos), all times `size`:
  //   stilts to 2.2, floor 2.2..2.5, walls to 4.9, then the hush-roof: the upper half of an ellipsoid centred at y 4.7
  //   with radii (3.4, 2.5, 3.0), felt and moss; the toll-cupola (r .55) sits on top at y 7.2..8.4. Door curtain on +z.
  const HOUSE = { stilt: 2.2, floor: 2.5, wall: 4.9, roof: { cy: 4.7, rx: 3.4, ry: 2.5, rz: 3.0 }, cupola: { y: 7.2, r: .55, h: 1.2 }, body: { hx: 2.6, hz: 2.2 } };
  // the height of a roof above the house's ground at local (lx, lz), or null off the roof
  const roofY = (h, lx, lz) => { const R = HOUSE.roof, s = h.size, q = 1 - (lx / (R.rx * s)) ** 2 - (lz / (R.rz * s)) ** 2; return q < 0 ? null : (R.cy + R.ry * Math.sqrt(q)) * s; };
  // local -> world for a house
  const houseToWorld = (h, lx, ly, lz) => { const c = Math.cos(h.rot), s = Math.sin(h.rot); return [h.pos[0] + lx * c + lz * s, h.pos[1] + ly, h.pos[2] - lx * s + lz * c]; };
  // make sure Pell's roof is a house
  { const p = P(8, places.pellRoof.th, .62); houses.push({ k: 8, th: places.pellRoof.th, pos: p, size: 1.05, rot: places.pellRoof.th + Math.PI / 2, seed: .5, pell: true }); places.pellRoof.house = houses[houses.length - 1]; }
  // the Listeners' hut on terrace 9 near the Spillway (Pell bounces off its roof in S08)
  { const th = -.21, p = P(9, th, .5); houses.push({ k: 9, th, pos: p, size: .8, rot: th + Math.PI / 2, seed: .3, hut: true }); places.spillway.hut = houses[houses.length - 1]; }
  // toll-masts: one per terrace (on the north-east side), the three chime masts, the Spillway mast
  const masts = []; for (let k = 1; k <= 9; k++) masts.push({ k, pos: P(k, -.95 + k * .07, .85), h: 6 + k * .2, pitch: k });
  places.tollTerrace.masts.forEach((p, i) => masts.push({ k: 9, pos: p, h: 8, chime: i }));
  masts.push({ k: 9, pos: places.spillway.mast, h: places.spillway.mastH, spill: true });
  // cisterns: seven along Cistern Row, near the outer edge of the path
  const cisterns = []; { const cr = places.cisternRow; for (let i = 0; i < 7; i++) cisterns.push({ pos: P(cr.k, lerp(cr.th0, cr.th1, (i + .5) / 7), .82), size: 1 + .15 * Math.sin(i * 2.1) }); }
  // cupolas: the four toll-cupolas that ring at 33.0 (on the houses closest to the toll terrace)
  // (terraces 6-8, the four with the largest angle, i.e. furthest east; each point is the cupola's bell, .6 m above its base)
  const cupolas = houses.filter(h => h.k >= 6 && !h.hut && !h.pell).sort((a, b) => b.th - a.th).slice(0, 4).map(h => [h.pos[0], h.pos[1] + (HOUSE.cupola.y + .6) * h.size, h.pos[2]]);
  F.valley = { TH, DEPTH, R0, NT, CREST, NOTCH_Y, wob, ringR, ground, terraceAt, normalAt, onTerrace, GLSL, places, houses, masts, cisterns, cupolas, HOUSE, roofY, houseToWorld };
})();
