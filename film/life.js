// life.js - the small life of Hollowmere (FILM.life): the plants and creatures that make every shot feel lived in.
//
//   cup-leaves   ~5.9k peltate bowl leaves in beds along the wall feet (and a few wall tops) of every terrace. Each one swivels
//                its cup toward every sound that reaches it, on a damped spring (bible M7: the vertex shader loops over the
//                toll table), turns up just before rain reaches it, flips over in the gust, and holds a bright water disc
//                once its ground is wet.
//   chime-reeds  ~2.6k hollow stems in clumps (pond edge, terrace edges, rim, Spillway shoulder, round the cloth), swaying in
//                the wind and flattened by the gust.
//   sprouts      ~4.2k seedlings that pop on twos with spring overshoot as the green flood wets their terrace (M12, 75.5+).
//   sky-vines    40 helix vines that corkscrew up the strands still hanging after the fall (FILM.rain.strands) from 76.
//   dripfrogs    12 sculpted frogs (FILM.sculpt): the hero frog of S03 (throat-sac swell, open mouth, the drop, squash, gulp:
//                M8), three on cistern rims, and a chorus of eight that croaks through the finale (81-87).
//   bead-snails  60 twisted-lathe snails creeping up strand beads (they ride their bead down when it is rung).
//   chimewings   2 flocks of 40 on analytic paths, flapping in the vertex shader; every wingbeat shakes loose a dotted line
//                of mist (M9, 12 beads per beat through FILM.rain.addBeads).
//   hushmoths    30 felt moths circling under the eaves.
//   tadpoles     20 drop-tadpoles plopping into the Cistern Row cisterns (33-35, 75.7-78.7), with ripples, then swimming.
//
// How it works: everything is a pure function of film time, so any frame can be drawn on its own. The plants are instanced
// meshes whose whole motion lives in the vertex shader; JS only places them, once, from this module's seeded random streams
// (A.named), so the placement is the same on every load. The creatures are posed in JS once per drawing and written into
// instance matrices and small per-instance attributes. Plants and creatures run on held time (uHeld / A.held: 12 drawings a
// second, "on twos"); falling things move on ones. Timing comes from the same formulas as the rest of the film: the toll
// table and release math of FILM.events, and the green-flood rule of events.wetAt. Units: metres and seconds (the frogs are
// modelled in centimetres, see U_).
//
// Public API (full table in film/LIFE.md): steps(scene), finalize(scene), update(t, dt, cam), beads(list), frogs,
// frogPose(i, t), FROG_TR, FROG_LAND, bird(i, t), birdRing(i, t), NB, FLOCK_A, wetTime(x, z), beds, leaves, plops, moths,
// snails, counts(), meshes.
// Reads: FILM.anim, engine (toon, outline, COMMON), valley (terraces, places, houses, cisterns), path (the special drops, cloth,
// frog, pell, dun, fieldC), events (toll table, releaseTime, hitTau, fall, GLSL), sculpt (the frog's SDF meshes), and rain
// (strands, beadAt, addBeads) when it is there. Where world.js or rain.js is missing (test builds), simple stand-ins appear:
// Cistern Row's cisterns, the frog's drop, and the mist beads (drawn here as points).
// Test views (bottom of the file): node tools/shot.mjs --test leaves|frog|birds|small|tadpoles --k 0,1,2 --cols 3 --out build/x.jpg
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim, E = F.engine, V = F.valley, P = F.path, EV = F.events, SC = F.sculpt;
  const { clamp, lerp, sm, keys, TAU } = A;
  const add = P.add, sub = P.sub;
  const onG = (x, z) => [x, V.ground(x, z), z];                          // a point on the ground
  const polar = (th, r) => onG(Math.cos(th) * r, Math.sin(th) * r);       // on the ground at angle th, radius r from the valley's centre
  const WEST_X = -V.ringR(9, Math.PI);                       // the gust line starts at the west rim (as world.js)
  const WIND = (() => { const l = Math.hypot(1, .45); return [1 / l, 0, .45 / l]; })();   // the plants' wind: east (+x), a little south (+z)
  const R = A.named('life');                                 // this module's random stream: the same placement on every load
  const gauss = () => { let u = 0; while (!u) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * R()); };   // normal(0, 1), Box-Muller
  const IA = (arr, n) => new THREE.InstancedBufferAttribute(arr, n);
  const L = F.life = {};
  const built = {};   // the meshes and attributes the build steps made (FILM.life.meshes)

  // ------------------------------------------------------------------ shared GLSL
  // LGL goes into every plant shader: the wind and flock uniforms, the gust as the plants feel it, and rotation helpers.
  const LGL = /* glsl */`
uniform vec3 uLfWind; uniform vec4 uLfBird;
// seconds before the gust front reaches x: it leaves the west rim at 36 and crosses the valley east at 18 m/s (bible M16)
float lfDelay(float x){ return max(0.0, (x - (${WEST_X.toFixed(3)})) / 18.0); }
// the gust as the plants feel it: the tear at 36, gone by 44 but for a breeze that dies by 60
float lfGust(float t){ return smoothstep(36.0, 37.2, t) * (1.0 - smoothstep(39.5, 44.0, t)) + 0.1 * smoothstep(39.5, 44.0, t) * (1.0 - smoothstep(52.0, 60.0, t)); }
// rotation that takes +y to n (Rodrigues)
mat3 lfAlign(vec3 n){ float c = n.y; vec3 ax = vec3(n.z, 0.0, -n.x); float s = length(ax);
  if (s < 1e-4) return c > 0.0 ? mat3(1.0) : mat3(1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0);
  ax /= s; float C = 1.0 - c;
  return mat3(c + ax.x * ax.x * C, ax.y * ax.x * C + ax.z * s, ax.z * ax.x * C - ax.y * s,
              ax.x * ax.y * C - ax.z * s, c + ax.y * ax.y * C, ax.z * ax.y * C + ax.x * s,
              ax.x * ax.z * C + ax.y * s, ax.y * ax.z * C - ax.x * s, c + ax.z * ax.z * C); }
mat3 lfRotY(float a){ float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 lfRotX(float a){ float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 lfRotZ(float a){ float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
`;
  // uLfWind: the wind direction. uLfBird: the S02 flock's centre (xyz) and how hard the cup-leaves twitch toward it (w),
  // set once per drawing by updateBirds; parked far below the ground when the flock is away.
  const LU = { uLfWind: { value: new THREE.Vector3(...WIND) }, uLfBird: { value: new THREE.Vector4(0, -1e4, 0, 0) } };
  // a depth material for the shadow map that runs the same vertex deformation (pars: GLSL, body: sets vec3 lP)
  const depthMat = (pars, body, extra = {}) => new THREE.ShaderMaterial({ uniforms: Object.assign({}, F.U, LU, extra),
    vertexShader: E.COMMON + EV.GLSL + LGL + pars + `\nvoid main(){ vec3 lP, lN; ${body} gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(lP, 1.0); }`,
    fragmentShader: '#include <packing>\nvoid main(){ gl_FragColor = packDepthToRGBA(gl_FragCoord.z); }', side: THREE.DoubleSide });
  // a BufferGeometry from flat arrays; normals default to zero because the plant shaders compute their own
  const geo = (pos, nrm, idx, attrs = {}) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm || pos.map(() => 0), 3)); for (const k in attrs) g.setAttribute(k, new THREE.Float32BufferAttribute(attrs[k][0], attrs[k][1]));
    g.setIndex(idx); return g; };
  // an InstancedMesh with one instance per placement point o.at(i) (a translation only: the shader does the rest).
  // Never frustum-culled: the shader moves the vertices, so three.js's bounds would be wrong.
  const instanced = (g, mat, n, o = {}) => { const m = new THREE.InstancedMesh(g, mat, n); m.frustumCulled = false; m.castShadow = !!o.cast; m.receiveShadow = o.receive ?? true;
    if (o.depth) m.customDepthMaterial = o.depth; const d = new THREE.Object3D(); for (let i = 0; i < n; i++) { if (o.at) { d.position.set(...o.at(i)); d.updateMatrix(); m.setMatrixAt(i, d.matrix); } } return m; };

  // ------------------------------------------------------------------ when the ground under (x, z) is wet (same rule as FILM.events.wetAt)
  // closed form of the time wetAt() crosses 0.5: the field events that reach the column above, and the cascade down the terraces.
  // wetAt ramps over 1.2 s from its start time, so it crosses 0.5 at start + 0.6 (and at 75.5 + 0.5 (9 - k) + 0.35 for the
  // cascade). The cup-leaves bake this into an attribute: they turn up just before it and hold water after it.
  function wetTime(x, z) {
    let tw = 1e9;
    for (const e of EV.FIELD_EV) { if (e.band === 2) continue;   // mist alone only dampens (0.45)
      const fc = P.fieldC(e.t0), ex = (x - fc[0]) / P.FIELD.rx, ez = (z - fc[2]) / P.FIELD.rz; if (ex * ex + ez * ez > 1.1) continue;
      const dh = Math.hypot(x - e.src[0], z - e.src[2]), reachH = Math.sqrt(Math.max(0, e.reach * e.reach - 400)); if (dh > reachH) continue;
      tw = Math.min(tw, e.t0 + Math.hypot(dh, 18) / EV.C_SOUND + e.hold + 2.2 + (e.band === 1 ? 1.2 : 0) + .6); }
    const k = V.terraceAt(x, z); if (k >= 1 && k <= 9) tw = Math.min(tw, 75.5 + .5 * (9 - k) + .35); else if (k === 0) tw = Math.min(tw, 80.5);
    return tw; }
  const cascadeT = k => 75.5 + .5 * (9 - k) + .35;   // when the green flood has wetted terrace k (top terrace first, 0.5 s a step)

  // ================================================================== CUP-LEAVES
  // Placement in JS (beds along the walls, then leaves scattered in each bed); every motion is in LEAF_GL below.
  // beds: { k, th, wall: 'foot' (the outer edge of terrace k, at the foot of the next wall up) | 'top' (its inner lip), n, half (m) }
  // The named groups put leaves where the shots look: Cistern Row (S03), the toll terrace, round the cloth, S02's foreground wall.
  const beds = [];
  { const cr = V.places.cisternRow, tt = V.places.tollTerrace, thCloth = Math.atan2(P.cloth.pos[2], P.cloth.pos[0]);
    const bed = (k, th, wall, n, half) => beds.push({ k, th, wall, n: Math.round(n), half });
    for (let i = 0; i < 20; i++) bed(6, lerp(cr.th0 - .06, cr.th1 + .06, (i + .2 + .6 * R()) / 20), 'foot', 18 + 12 * R(), 1.0 + .6 * R());   // Cistern Row
    for (let i = 0; i < 8; i++) bed(6, lerp(cr.th0, cr.th1, (i + R()) / 8), 'top', 12 + 8 * R(), .8 + .5 * R());
    for (let i = 0; i < 16; i++) bed(9, lerp(-.86, -.2, (i + R()) / 16), i % 3 ? 'top' : 'foot', 18 + 10 * R(), 1.0 + .6 * R());   // the toll terrace
    for (let i = 0; i < 10; i++) bed(8, lerp(-.8, -.3, (i + R()) / 10), 'foot', 16 + 10 * R(), 1.1 + .5 * R());
    for (let i = 0; i < 14; i++) bed(9, thCloth + (R() - .5) * .3, R() < .5 ? 'top' : 'foot', 16 + 10 * R(), 1 + .6 * R());          // the cloth (S14-S16)
    for (let i = 0; i < 6; i++) bed(8, thCloth - .1 + (R() - .5) * .3, 'foot', 16 + 8 * R(), 1.2);
    for (let i = 0; i < 5; i++) bed(4, 2.35 + (i - 2) * .018 + (R() - .5) * .01, 'top', 22, 1.1);                                     // S02's foreground wall
    bed(8, tt.th + .03, 'foot', 40, 1.8); bed(9, tt.th + .045, 'top', 36, 1.6);                                                       // the 'leaves' test bed
    // everywhere else: the north and east slopes, where the shots look, get the most
    const wTh = th => { const a = Math.atan2(Math.sin(th), Math.cos(th)); return a > -2.8 && a < .55 ? 1 : .28; };
    for (let k = 1; k <= 9; k++) { const n = 40 + k * 4; for (let i = 0; i < n; i++) { const th = R() * TAU - Math.PI; if (R() > wTh(th)) continue;
      bed(k, th, R() < .8 ? 'foot' : 'top', 12 + 16 * R(), .8 + .9 * R()); } } }
  // leaf instances: base (world), yaw0, tilt0, seed, wetT ; stalk h, cup R, shade
  // Each leaf sits 0.45-1.45 m from the wall foot (or 0.7-1.6 m in from the lip), its cup facing roughly inward (+-0.8 rad);
  // stalks 0.14-0.54 m tall, cup radius 0.12-0.23 m, both larger close to the wall. Leaves that land off their terrace are dropped.
  const leaves = [];
  for (const b of beds) {
    const inward = b.th + Math.PI;                              // toward the valley's centre (from a wall foot: over the open terrace)
    for (let i = 0; i < b.n; i++) {
      const along = (R() * 2 - 1) * b.half, out = Math.pow(R(), 1.4), rC = b.wall === 'foot' ? V.ringR(b.k, b.th) - .45 - out * 1.0 : V.ringR(b.k - 1, b.th) + .7 + out * .9;
      const th = b.th + along / rC, x = Math.cos(th) * rC, z = Math.sin(th) * rC, y = V.ground(x, z);
      if (V.terraceAt(x, z) !== b.k) continue;
      const near = 1 - out;                                     // close to the wall: taller and bigger
      const yaw = (b.wall === 'foot' ? inward : inward) + (R() - .5) * 1.6;
      leaves.push({ p: [x, y, z], yaw, tilt: .25 + .55 * R(), seed: R(), wet: wetTime(x, z), h: .14 + .34 * near * (.6 + .4 * R()) + .06 * R(), r: .12 + .08 * R() + .03 * near, shade: R() });
    } }

  // The cup-leaf vertex shader. leafLook() finds where the cup faces at held time h (a rest tilt plus a sum of pulls),
  // leafPose() bends the stalk to it and seats the cup on top.
  const LEAF_GL = /* glsl */`
// per vertex aLp: 0 stalk, 1 cup. Per instance aLeaf = (yaw, tilt, seed, wet time), aLeaf2 = (stalk height m, cup radius m, shade, -)
// vLf = (cup x, cup z, 1 on the cup, wet 0..1); vLs = (shade, gust)
attribute float aLp; attribute vec4 aLeaf; attribute vec4 aLeaf2;
varying vec4 vLf; varying vec2 vLs;
// the damped spring's step response, 0 -> 1 with overshoot: zeta * omega = 2.4, omega_d = 8 sqrt(1 - 0.09) = 7.63
float lfM7(float x){ return x <= 0.0 ? 0.0 : 1.0 - exp(-2.4 * x) * cos(7.63 * x); }   // M7: omega 8, zeta 0.3
vec3 leafLook(vec3 top, float h, float seed, float wetT){
  vec3 n0 = normalize(vec3(cos(aLeaf.x) * aLeaf.y, 1.0, sin(aLeaf.x) * aLeaf.y));   // at rest: tilted toward its yaw
  vec3 pull = vec3(0.0);
  // every sound that reaches it (any band; it hears 1.5x the toll's reach, at least 7 m): swivel toward the source on a damped
  // spring when the front arrives (distance / C_SOUND), then a second spring back after max(2.5 s, the sound's length)
  for (int k = 0; k < 24; k++) { if (k >= uEvN) break;
    vec3 src = uEv[k].xyz; float d = distance(top, src), hear = max(uEvP[k].y * 1.5, 7.0); if (d > hear) continue;
    float tau = h - uEv[k].w - d / C_SOUND; if (tau <= 0.0) continue;
    float s = lfM7(tau) - lfM7(tau - max(2.5, uEvP[k].w)); if (abs(s) < 0.002) continue;
    pull += normalize(src - top + vec3(0.0, 0.4, 0.0)) * s * (1.0 - smoothstep(0.5, 1.0, d / hear)) * 1.9; }
  // the chimewings passing over (S02): a twitch toward the flock
  float db = distance(top, uLfBird.xyz); pull += normalize(uLfBird.xyz - top) * uLfBird.w * (1.0 - smoothstep(12.0, 48.0, db)) * (0.55 + 0.3 * sin(h * 9.0 + seed * 40.0));
  // rain on its way: cups turn up to catch it, then settle part way back
  float ru = smoothstep(wetT - 2.4, wetT - 0.5, h) * (1.0 - 0.5 * smoothstep(wetT + 4.0, wetT + 9.0, h)); pull.y += 1.5 * ru;
  // idle: a slow nod
  pull += vec3(sin(h * 0.9 + seed * 17.0), 0.0, cos(h * 0.7 + seed * 23.0)) * 0.07;
  // the gust: flipped over downwind, fluttering
  float g = lfGust(h - lfDelay(top.x)); vLs.y = g;
  pull += (uLfWind * (2.4 + 0.9 * sin(h * 17.0 + seed * 31.0)) - vec3(0.0, 1.1, 0.0)) * g;
  return normalize(n0 + pull); }
// one vertex of the leaf in instance space (the instance matrix only moves it to its base on the ground)
void leafPose(vec3 pos, out vec3 p, out vec3 n){
  vec3 base = instanceMatrix[3].xyz; float hs = aLeaf2.x, Rc = aLeaf2.y, seed = aLeaf.z, h = uHeld;
  vec3 nn = leafLook(base + vec3(0.0, hs, 0.0), h, seed, aLeaf.w);
  // the stalk's tip leans the way the cup faces, so a turning cup drags its stalk with it
  vec3 tip = vec3(nn.x, 0.0, nn.z) * hs * 0.38 + vec3(0.0, hs * (0.9 + 0.1 * nn.y), 0.0);
  vLs.x = aLeaf2.z;
  if (aLp < 0.5) {   // the stalk: a quadratic curve from the ground to the cup's centre
    float v = pos.y; vec3 c1 = vec3(0.0, hs * 0.55, 0.0);
    vec3 q = mix(mix(vec3(0.0), c1, v), mix(c1, tip, v), v), tg = normalize(mix(c1, tip - c1, v) + vec3(0.0, 1e-3, 0.0));
    vec3 s1 = normalize(cross(tg, vec3(0.0, 0.0, 1.0))), s2 = cross(tg, s1); float rr = 0.0075 * (1.0 - 0.35 * v) * (Rc / 0.17);
    n = normalize(s1 * pos.x + s2 * pos.z); p = q + n * rr; vLf = vec4(0.0, v, 0.0, 0.0);
  } else {           // the cup: a shallow bowl on its centre (0.62 Rc deep at the rim), the rim a little wavy (5 lobes)
    float r2 = dot(pos.xz, pos.xz), ang = atan(pos.z, pos.x);
    vec3 q = vec3(pos.x * Rc, (0.62 * r2 + 0.07 * sin(ang * 5.0 + seed * 20.0) * r2 * r2) * Rc, pos.z * Rc * 1.08);
    vec3 qn = normalize(vec3(-1.24 * pos.x, 1.0, -1.15 * pos.z));
    mat3 M = lfAlign(nn) * lfRotY(seed * 6.2832);
    p = tip + M * q; n = M * qn;
    vLf = vec4(pos.x, pos.z, 1.0, smoothstep(aLeaf.w - 0.15, aLeaf.w + 0.5, h)); }
}`;
  function buildLeaves(scene) {
    // one leaf: a 3-sided stalk (4 segments) and a cup (centre + 3 rings of 14)
    const pos = [], lp = [], idx = [];
    const SEG = 4; for (let j = 0; j <= SEG; j++) for (let s = 0; s < 3; s++) { const a = s / 3 * TAU; pos.push(Math.cos(a), j / SEG, Math.sin(a)); lp.push(0); }
    for (let j = 0; j < SEG; j++) for (let s = 0; s < 3; s++) { const a = j * 3 + s, b = j * 3 + (s + 1) % 3, c = a + 3, d = b + 3; idx.push(a, c, b, b, c, d); }
    const c0 = pos.length / 3, NS = 14, NR = 3; pos.push(0, 0, 0); lp.push(1);
    for (let r = 1; r <= NR; r++) for (let s = 0; s < NS; s++) { const a = s / NS * TAU, rr = r / NR; pos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr); lp.push(1); }
    const ring = (r, s) => c0 + 1 + (r - 1) * NS + ((s % NS) + NS) % NS;
    for (let s = 0; s < NS; s++) idx.push(c0, ring(1, s + 1), ring(1, s));
    for (let r = 1; r < NR; r++) for (let s = 0; s < NS; s++) { const a = ring(r, s), b = ring(r, s + 1), c = ring(r + 1, s + 1), d = ring(r + 1, s); idx.push(a, b, c, a, c, d); }
    const n = leaves.length, g = geo(pos, null, idx, { aLp: [lp, 1] });
    const a1 = new Float32Array(n * 4), a2 = new Float32Array(n * 4);
    leaves.forEach((l, i) => { a1.set([l.yaw, l.tilt, l.seed, l.wet], i * 4); a2.set([l.h, l.r, l.shade, 0], i * 4); });
    g.setAttribute('aLeaf', IA(a1, 4)); g.setAttribute('aLeaf2', IA(a2, 4));
    // the paint: the top in two greens with veins, a darker hollow, a light lip, a painted edge, and the water disc once wet;
    // the pale underside shows when the gust flips the cup. The leaves cast shadows through a depth material with the same pose.
    const U = Object.assign({ uLfTop: { value: new THREE.Color('#7FA84A') }, uLfTop2: { value: new THREE.Color('#5E9A3E') }, uLfUnder: { value: new THREE.Color('#B9C97A') }, uLfStalk: { value: new THREE.Color('#9DB85A') } }, LU);
    const mat = E.toon({ side: THREE.DoubleSide, paint: .16, rim: .3, soft: .04, wrap: .1, uniforms: U,
      vpars: EV.GLSL + LGL + LEAF_GL, vnormal: 'vec3 lP, lN; leafPose(position, lP, lN); objectNormal = lN;', vdeform: 'transformed = lP;',
      fpars: 'varying vec4 vLf; varying vec2 vLs; uniform vec3 uLfTop, uLfTop2, uLfUnder, uLfStalk;',
      fpre: /* glsl */`
        if (vLf.z > 0.5) { float r = length(vLf.xy), a = atan(vLf.y, vLf.x);
          if (gl_FrontFacing) {
            base = mix(uLfTop, uLfTop2, vLs.x);
            float vein = smoothstep(0.09, 0.0, abs(fract(a * 7.0 / 6.2832 + 0.5) - 0.5)) * smoothstep(0.12, 0.3, r) * (1.0 - smoothstep(0.8, 0.95, r));
            base = mix(base, base * vec3(1.25, 1.22, 0.88), vein * 0.6);
            base *= mix(0.62, 1.0, smoothstep(0.0, 0.75, r));                                    // the hollow of the cup
            base = mix(base, vec3(0.86, 0.92, 0.55), smoothstep(0.86, 0.93, r) * 0.55);              // the lip catches the light
            base = mix(base, base * vec3(0.5, 0.55, 0.45), smoothstep(0.95, 0.99, r));             // a painted edge
            if (vLf.w > 0.5 && r < 0.68 + 0.03 * sin(a * 3.0)) {   // the water it caught
              base = mix(vec3(0.16, 0.5, 0.72), vec3(0.58, 0.88, 0.98), smoothstep(0.66, 0.1, r) * 0.85); lightK = 1.0; }
          } else { base = mix(uLfUnder, uLfUnder * vec3(0.92, 0.98, 0.85), vLs.x); base = mix(base, base * 1.1, vLs.y * 0.4); }
        } else base = uLfStalk;`,
      fpost: /* glsl */`
        // on the water disc: a sun glint, a cyan ring at its edge, a little cool light
        if (vLf.z > 0.5 && gl_FrontFacing && vLf.w > 0.5) { float r = length(vLf.xy);
          if (r < 0.71) { c += uSunCol * 1.3 * smoothstep(0.2, 0.12, length((vLf.xy - vec2(-0.24, -0.22)) * vec2(1.0, 1.9)));
            c += vec3(0.55, 0.9, 1.0) * 0.45 * smoothstep(0.58, 0.68, r); c += vec3(0.04, 0.1, 0.14); } }`,
    });
    const m = instanced(g, mat, n, { cast: true, receive: true, at: i => leaves[i].p,
      depth: depthMat(LEAF_GL, 'leafPose(position, lP, lN);') });
    scene.add(m); built.leaves = m;
  }

  // ================================================================== CHIME-REEDS
  // reeds: { p (ground point), h (height m), lean (direction of its rest lean), seed }, 0.7-1.5 m tall (times hMul)
  const reeds = [];
  // clump(c, n, rad, hMul): n reeds scattered over a disc of radius rad round c, none on a wall face
  { const clump = (c, n, rad, hMul = 1) => { for (let i = 0; i < n; i++) { const a = R() * TAU, d = rad * Math.sqrt(R()), x = c[0] + Math.cos(a) * d, z = c[2] + Math.sin(a) * d;
        const k = V.terraceAt(x, z), r = Math.hypot(x, z), th = Math.atan2(z, x);
        if (k >= 1 && k <= 9 && (r - V.ringR(k - 1, th) < .7 || V.ringR(k, th) - r < .3)) continue;   // not on a wall face
        reeds.push({ p: onG(x, z), h: (.7 + .8 * R()) * hMul, lean: R() * TAU, seed: R() }); } };
    for (let i = 0; i < 46; i++) { const th = R() * TAU, r = V.ringR(0, th) - .6 - 2.4 * R(); clump(polar(th, r), 14 + 12 * R(), 1.3, 1.1); }        // the pond's edge
    for (let i = 0; i < 46; i++) { const k = 1 + Math.floor(R() * 9), th = -2.9 + 3.5 * R(), r = V.ringR(k, th) - .5 - .6 * R(); clump(polar(th, r), 10 + 10 * R(), .9); }   // terrace edges
    for (let i = 0; i < 48; i++) { const th = R() * TAU, r = V.ringR(9, th) + 3 + 9 * R(); clump(polar(th, r), 12 + 10 * R(), 1.4, 1.15); }              // the rim
    const sp = V.places.spillway; for (let i = 0; i < 14; i++) { const th = -.3 + .45 * R(), r = V.ringR(9, th) + 1.5 + 8 * R(); clump(polar(th, r), 14 + 8 * R(), 1.2, 1.2); }   // the Spillway shoulder
    const cl = P.cloth.pos; for (let i = 0; i < 10; i++) { const a = R() * TAU, d = 6 + 10 * R(); clump(onG(cl[0] + Math.cos(a) * d, cl[2] + Math.sin(a) * d), 10 + 8 * R(), 1.0); }   // round the cloth
    void sp; }
  // The reed vertex shader: a thin 3-sided tube (radius 12 mm at the foot, 6 mm at the top) bent along a parabola.
  const REED_GL = /* glsl */`
// per instance aRd = (height m, rest-lean direction rad, seed, -); pos.y runs 0 (foot) .. 1 (top)
attribute vec4 aRd; varying vec3 vRd;
void reedPose(vec3 pos, out vec3 p, out vec3 n){
  vec3 base = instanceMatrix[3].xyz; float H = aRd.x, v = pos.y, seed = aRd.z, h = uHeld;
  float rad = mix(0.012, 0.006, v) * (0.8 + 0.4 * seed);
  vec2 w = uLfWind.xz, lean0 = vec2(cos(aRd.y), sin(aRd.y)) * 0.07;
  // the bend at the top (as a slope): its own lean, an idle sway that rolls across the valley, and the gust laying it flat
  float sway = 0.07 * sin(h * 1.6 + seed * 6.28 + base.x * 0.13 + base.z * 0.07) + 0.03 * sin(h * 3.3 + seed * 17.0);
  float g = lfGust(h - lfDelay(base.x));
  vec2 bend = lean0 + w * (sway + 0.05) + w * g * (1.25 + 0.3 * sin(h * 12.0 + seed * 30.0));
  float b2 = min(dot(bend, bend), 1.6);
  // offset grows with v^2; the stem gets shorter as it bends, so it keeps roughly its length
  vec2 off = bend * v * v * H; float y = v * H * (1.0 - 0.3 * b2 * v);
  vec3 tg = normalize(vec3(2.0 * bend.x * v * H, H * (1.0 - 0.6 * b2 * v), 2.0 * bend.y * v * H));
  vec3 s1 = normalize(cross(tg, vec3(0.0, 0.0, 1.0))), s2 = cross(tg, s1);
  n = normalize(s1 * pos.x + s2 * pos.z); p = vec3(off.x, y, off.y) + n * rad; vRd = vec3(v, H, seed);
}`;
  function buildReeds(scene) {
    const pos = [], idx = [], SEG = 6, S = 3;
    for (let j = 0; j <= SEG; j++) for (let s = 0; s < S; s++) { const a = s / S * TAU; pos.push(Math.cos(a), j / SEG, Math.sin(a)); }
    for (let j = 0; j < SEG; j++) for (let s = 0; s < S; s++) { const a = j * S + s, b = j * S + (s + 1) % S, c = a + S, d = b + S; idx.push(a, c, b, b, c, d); }
    const n = reeds.length, g = geo(pos, null, idx), a = new Float32Array(n * 4);
    reeds.forEach((r, i) => a.set([r.h, r.lean, r.seed, 0], i * 4)); g.setAttribute('aRd', IA(a, 4));
    const mat = E.toon({ paint: .1, rim: .25, soft: .05, wrap: .2, side: THREE.DoubleSide, uniforms: Object.assign({}, LU),
      vpars: EV.GLSL + LGL + REED_GL, vnormal: 'vec3 lP, lN; reedPose(position, lP, lN); objectNormal = lN;', vdeform: 'transformed = lP;',
      fpars: 'varying vec3 vRd;',
      fpre: /* glsl */`
        float v = vRd.x; base = mix(vec3(0.66, 0.72, 0.36), vec3(0.78, 0.74, 0.42), smoothstep(0.2, 0.85, v + (vRd.z - 0.5) * 0.3));
        float node = smoothstep(0.035, 0.0, abs(fract(v * vRd.y * 3.2 + vRd.z) - 0.5) - 0.44);   // dark nodes along the stem
        base = mix(base, vec3(0.42, 0.44, 0.22), node * 0.7);
        base = mix(base, vec3(0.33, 0.27, 0.2), smoothstep(0.95, 0.985, v));                        // the open, whistling top`,
    });
    const m = instanced(g, mat, n, { at: i => reeds[i].p }); scene.add(m); built.reeds = m;
  }

  // ================================================================== SPROUTS (the green flood)
  // sprouts: { p, pop (when it pops, s), yaw, size, seed }. Each pops 0.15-1.1 s after the flood has wetted its terrace
  // (cascadeT), later toward the terrace's outer wall and with a random lag, so they come up in a ragged wave.
  const sprouts = [];
  // okAt: terrace k at (x, z), or 0 when the point is within 0.9 m of the lip or 0.5 m of the wall foot.
  // patch(c, n, rad): n tries scattered round c (gaussian, sigma 0.55 x rad)
  { const okAt = (x, z) => { const k = V.terraceAt(x, z), r = Math.hypot(x, z), th = Math.atan2(z, x); return k >= 1 && k <= 9 && r - V.ringR(k - 1, th) > .9 && V.ringR(k, th) - r > .5 ? k : 0; };
    const patch = (c, n, rad) => { for (let i = 0; i < n; i++) { const x = c[0] + gauss() * rad * .55, z = c[2] + gauss() * rad * .55, k = okAt(x, z); if (!k) continue;
        const r = Math.hypot(x, z), th = Math.atan2(z, x), u = clamp((r - V.ringR(k - 1, th)) / (V.ringR(k, th) - V.ringR(k - 1, th)));
        sprouts.push({ p: onG(x, z), pop: cascadeT(k) + .15 + .45 * u + .5 * R() * R(), yaw: R() * TAU, size: .7 + .7 * R(), seed: R() }); } };
    // patches: round the cloth, terraces 5-9 on the north-east, Cistern Row, the toll terrace, the 'leaves' test bed, anywhere
    const cl = P.cloth.pos;
    for (let i = 0; i < 24; i++) { const a = R() * TAU, d = 4 + 16 * Math.sqrt(R()); patch([cl[0] + Math.cos(a) * d, 0, cl[2] + Math.sin(a) * d], 40 + 30 * R(), 2 + 2 * R()); }
    for (let i = 0; i < 46; i++) { const k = 5 + Math.floor(R() * 5), th = -1.25 + 1.55 * R(); patch(V.onTerrace(k, th, R()), 40 + 30 * R(), 2 + 2.5 * R()); }
    const cr = V.places.cisternRow; for (let i = 0; i < 10; i++) patch(V.onTerrace(6, lerp(cr.th0, cr.th1, R()), .2 + .5 * R()), 30, 2);
    for (let i = 0; i < 6; i++) patch(V.onTerrace(9, V.places.tollTerrace.th + .02 + (R() - .5) * .08, .2 + .6 * R()), 50, 2.5);
    for (let i = 0; i < 4; i++) { const th = V.places.tollTerrace.th + .03 + (R() - .5) * .04; patch(polar(th, V.ringR(8, th) - 2.2 - 3 * R()), 60, 1.8); }
    for (let i = 0; i < 12; i++) patch(V.onTerrace(1 + Math.floor(R() * 9), R() * TAU, R()), 40, 3); }
  // The sprout vertex shader: a stem that shoots up with overshoot, then two seed leaves that open one drawing later.
  const SPROUT_GL = /* glsl */`
// per instance aSp = (pop time, yaw, size, seed); per vertex aSv = (part: 0 stem, 1 / 2 a seed leaf; u along; v across)
attribute vec4 aSp; attribute vec3 aSv; varying vec3 vSp;
// M12's pop: 1 - e^(-6 tau) cos(12 tau), on held time so it pops on twos
float lfPop(float x){ return x <= 0.0 ? 0.0 : 1.0 - exp(-6.0 * x) * cos(12.0 * x); }
void sproutPose(vec3 pos, out vec3 p, out vec3 n){
  float tau = uHeld - aSp.x, s = lfPop(tau), s2 = lfPop(tau - 0.0834), S = aSp.z, seed = aSp.w;
  // the stem: 13 cm x size, swaying a little (the gust term is zero by the time the flood comes)
  float H = 0.13 * S * s, sw = (0.05 * sin(uHeld * 2.2 + seed * 20.0) + 0.25 * lfGust(uHeld - lfDelay(instanceMatrix[3].x))) * s;
  vec3 top = vec3(sw * H, H, 0.0);
  if (aSv.x < 0.5) { float v = aSv.y; p = vec3(sw * H * v * v, H * v, 0.0) + vec3(pos.x, 0.0, pos.z) * 0.0055 * S * (1.0 - 0.4 * v); n = normalize(vec3(pos.x, 0.0, pos.z)); }
  // a seed leaf (8.5 x 4.5 cm x size): opens from folded up (0.12 rad from vertical) to spread (about 1.05 rad), cupped a little
  else { float side = aSv.x < 1.5 ? -1.0 : 1.0, ang = mix(0.12, 1.05 + 0.1 * sin(uHeld * 1.7 + seed * 9.0), s2);
    vec3 d = vec3(side * sin(ang), cos(ang), 0.0), ac = vec3(0.0, 0.0, 1.0), up = cross(ac, d) * side;
    float Ll = 0.085 * S * s2, Wl = 0.045 * S * s2, u = aSv.y, v = aSv.z, wid = pow(max(sin(3.1416 * u), 0.0), 0.75);
    p = top + d * u * Ll + ac * v * Wl * wid + up * (0.3 * Wl * v * v - 0.15 * Ll * u * u); n = normalize(up); }
  mat3 Ry = lfRotY(aSp.y); p = Ry * p; n = Ry * n; vSp = vec3(aSv.x, aSv.y, s);
}`;
  function buildSprouts(scene) {
    const pos = [], sv = [], idx = [];
    // stem: 3 sides, 3 segments
    for (let j = 0; j <= 3; j++) for (let s = 0; s < 3; s++) { const a = s / 3 * TAU; pos.push(Math.cos(a), 0, Math.sin(a)); sv.push(0, j / 3, 0); }
    for (let j = 0; j < 3; j++) for (let s = 0; s < 3; s++) { const a = j * 3 + s, b = j * 3 + (s + 1) % 3, c = a + 3, d = b + 3; idx.push(a, c, b, b, c, d); }
    // two seed leaves: a 4 x 3 grid each (u along, v across)
    for (const part of [1, 2]) { const o = pos.length / 3; for (let i = 0; i <= 4; i++) for (let j = 0; j <= 2; j++) { pos.push(0, 0, 0); sv.push(part, i / 4, j - 1); }
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) { const a = o + i * 3 + j, b = a + 1, c = a + 3, d = c + 1; idx.push(a, c, b, b, c, d); } }
    const n = sprouts.length, g = geo(pos, null, idx, { aSv: [sv, 3] }), a = new Float32Array(n * 4);
    sprouts.forEach((s, i) => a.set([s.pop, s.yaw, s.size, s.seed], i * 4)); g.setAttribute('aSp', IA(a, 4));
    const mat = E.toon({ side: THREE.DoubleSide, paint: .08, rim: .35, soft: .05, wrap: .25, uniforms: Object.assign({}, LU),
      vpars: EV.GLSL + LGL + SPROUT_GL, vnormal: 'vec3 lP, lN; sproutPose(position, lP, lN); objectNormal = lN;', vdeform: 'transformed = lP;',
      fpars: 'varying vec3 vSp;',
      fpre: /* glsl */`
        if (vSp.x < 0.5) base = vec3(0.55, 0.78, 0.35);
        else { base = mix(vec3(0.42, 0.78, 0.3), vec3(0.7, 0.9, 0.38), smoothstep(0.3, 1.0, vSp.y)); if (gl_FrontFacing) base *= 1.12; }`,
    });
    const m = instanced(g, mat, n, { at: i => sprouts[i].p }); scene.add(m); built.sprouts = m;
  }

  // ================================================================== SKY-VINES (built in finalize: they climb the rain's strands)
  // The whole vine is analytic: a helix round the strand's line, drawn up to a growing tip, with heart leaves that unfold behind it.
  const VINE_GL = /* glsl */`
// per instance aVine = (start time, height m, phase, hand +-1); per vertex aVn = (part: 0 tube, 1 leaf; u 0..1 up the vine;
// tube: angle round it | leaf: the leaf point's (a, b))
attribute vec4 aVine; attribute vec4 aVn; varying vec3 vVn;
// the vine's centre line at u: a helix of one turn per 0.6 m (bible M12), radius about 0.25 m narrowing upward plus 2 cm,
// a slight drift sideways; hand picks the twist
vec3 vineC(float u, float H, float ph, float hand){ float a = ph + hand * 6.2832 * (H / 0.6) * (u + 0.04 * sin(u * 19.0 + ph));
  float rr = (0.25 * smoothstep(0.0, 0.05, u) * (1.15 - 0.55 * u) + 0.02) * (1.0 + 0.18 * sin(u * 31.0 + ph * 3.0));
  return vec3(cos(a) * rr + 0.12 * sin(u * 4.0 + ph) * u, H * u, sin(a) * rr + 0.12 * cos(u * 3.3 + ph) * u); }
// how far up the tip has climbed, 0..1 over 3 s from the start time (fast, then slowing), on held time
float vineGrow(){ float x = clamp((uHeld - aVine.x) / 3.0, 0.0, 1.0); return 1.0 - (1.0 - x) * (1.0 - x) * (1.0 - 0.4 * x); }
void vinePose(vec3 pos, out vec3 p, out vec3 n){
  float H = aVine.y, ph = aVine.z, hand = aVine.w, g = vineGrow(); vVn = vec3(aVn.x, aVn.y, g);
  if (g <= 0.0) { p = vec3(0.0); n = vec3(0.0, 1.0, 0.0); return; }   // not started: collapsed to a point
  if (aVn.x < 0.5) {   // the tube, drawn up to the growing tip (vertices above it pile up at the tip), radius 2.6 cm, tapering
    float u = min(aVn.y, g); vec3 c = vineC(u, H, ph, hand), c2 = vineC(u + 0.003, H, ph, hand);
    vec3 T = normalize(c2 - c + vec3(0.0, 1e-5, 0.0)), Nr = normalize(vec3(c.x, 0.0, c.z) + vec3(1e-4, 0.0, 0.0)), B = normalize(cross(T, Nr)); Nr = cross(B, T);
    float rad = 0.026 * (1.0 - 0.8 * smoothstep(g - 0.06, g, u)) * (1.0 - 0.45 * u);
    n = Nr * cos(aVn.z) + B * sin(aVn.z); p = c + n * rad;
  } else {             // a heart leaf that unfolds (a springy pop) once the tip has passed it, 20-28 cm long, smaller higher up
    float u = aVn.y, age = (g - u) * H / 0.6 * 0.5; float s = age <= 0.0 ? 0.0 : 1.0 - exp(-5.0 * age) * cos(9.0 * age);
    vec3 c = vineC(u, H, ph, hand), c2 = vineC(u + 0.003, H, ph, hand), T = normalize(c2 - c), Nr = normalize(vec3(c.x, 0.0, c.z) + vec3(1e-4, 0.0, 0.0));
    vec3 d = normalize(Nr * 0.85 + vec3(0.0, 0.55, 0.0) + T * 0.2), ac = normalize(cross(d, T));
    float a = aVn.z, b = aVn.w, Ll = (0.2 + 0.08 * fract(u * 13.7)) * s * (1.0 - 0.35 * u), wid = 0.5;
    p = c + Nr * 0.03 + d * a * Ll + ac * b * Ll * 0.55 * wid + cross(d, ac) * 0.25 * Ll * b * b; n = normalize(cross(ac, d) + d * 0.1);
  } }`;
  function buildVines(scene) {
    const n = 40, guides = [];
    // Guides (x, z, height H): up to 26 local strands of the rain module that still hang at 76.2 with their tops 2.5-9 m above
    // the ground (Cistern Row, the macro grove, roofs), two at the 'leaves' test bed, and the rest made up here round Cistern
    // Row and the cloth. Without the rain module all of them are made up here.
    if (F.rain && F.rain.strands && F.rain.strands.length && F.rain.beadAt) {
      const st = F.rain.strands; const cand = [];
      st.forEach((s, i) => { if (s.kind !== 'local' || s.drifting) return; const b = F.rain.beadAt(i, 0, 76.2); if (!b.on) return; const g = V.ground(b.p[0], b.p[2]), top = s.top[1] - g;
        if (top > 2.5 && top < 9) cand.push({ x: s.top[0], z: s.top[2], H: Math.min(7.5, top + .2), w: A.hash(i, 7) }); });
      cand.sort((a, b) => a.w - b.w).slice(0, 26).forEach(c => guides.push(c)); }
    const cl = P.cloth.pos, rg = A.named('life-vines');
    { const th = V.places.tollTerrace.th + .03; for (const [dt, dr] of [[-.012, 1.6], [.014, 2.4]]) { const q = polar(th + dt, V.ringR(8, th) - dr); guides.push({ x: q[0], z: q[2], H: 4.2 + dr * .4, w: 0 }); } }
    while (guides.length < n) { const i = guides.length; let x, z;
      if (i % 3 === 0) { const cr = V.places.cisternRow, p = V.onTerrace(6, lerp(cr.th0, cr.th1, rg()), .25 + .5 * rg()); x = p[0]; z = p[2]; }
      else { const a = -1.9 + 3.6 * rg(), d = 5 + 12 * rg(); x = cl[0] + Math.cos(a) * d; z = cl[2] + Math.sin(a) * d; }
      guides.push({ x, z, H: 3.6 + 2.6 * rg(), w: 0 }); }
    // one vine: a 5-sided tube of 150 rings, and 24 heart leaves along it (a fan of triangles round the 9 HEART points)
    const NU = 150, NSd = 5, NL = 24, pos = [], vn = [], idx = [];
    for (let j = 0; j <= NU; j++) for (let s = 0; s < NSd; s++) { pos.push(0, 0, 0); vn.push(0, j / NU, s / NSd * TAU, 0); }
    for (let j = 0; j < NU; j++) for (let s = 0; s < NSd; s++) { const a = j * NSd + s, b = j * NSd + (s + 1) % NSd, c = a + NSd, d = b + NSd; idx.push(a, b, c, b, d, c); }
    const HEART = [[.42, 0], [0, 0], [.18, -.9], [.5, -1], [.8, -.6], [1, 0], [.8, .6], [.5, 1], [.18, .9]];
    for (let l = 0; l < NL; l++) { const o = pos.length / 3, u = (l + .45 + .3 * Math.sin(l * 7.1)) / NL * .97; for (const [a, b] of HEART) { pos.push(0, 0, 0); vn.push(1, u, a, b); }
      for (let q = 1; q < HEART.length; q++) idx.push(o, o + q, o + (q % (HEART.length - 1)) + 1); }
    const g = geo(pos, null, idx, { aVn: [vn, 4] }), a = new Float32Array(n * 4);
    // start times 76.0-79: staggered, and 0.8 s later on terraces 6 and below, which the flood reaches later; alternate twist
    guides.forEach((v, i) => a.set([76.0 + .25 * (i % 8) + .4 * A.hash(i, 3) + (V.terraceAt(v.x, v.z) <= 6 ? .8 : 0), v.H, A.hash(i, 5) * TAU, i % 2 ? 1 : -1], i * 4));
    g.setAttribute('aVine', IA(a, 4));
    const mat = E.toon({ side: THREE.DoubleSide, paint: .1, rim: .35, soft: .04, wrap: .15, uniforms: Object.assign({}, LU),
      vpars: LGL + VINE_GL, vnormal: 'vec3 lP, lN; vinePose(position, lP, lN); objectNormal = lN;', vdeform: 'transformed = lP;',
      fpars: 'varying vec3 vVn;',
      fpre: /* glsl */`if (vVn.x < 0.5) base = mix(vec3(0.12, 0.42, 0.22), vec3(0.45, 0.75, 0.25), smoothstep(vVn.z - 0.08, vVn.z, vVn.y)); else base = mix(vec3(0.2, 0.6, 0.28), vec3(0.4, 0.78, 0.32), float(gl_FrontFacing));`,
    });
    const m = instanced(g, mat, n, { at: i => onG(guides[i].x, guides[i].z) }); scene.add(m); built.vines = m; built.vineGuides = guides;
  }

  // ================================================================== DRIPFROGS
  const U_ = .01;   // frogs are designed in centimetres
  const cm = p => p.map(v => v * U_);
  // MY: the mouth line (cm above the feet); the body is cut below it and the jaw above it, so the jaw can hinge open.
  // HINGE: the jaw's hinge point. JAW_E: the jaw ellipsoid (centre, radii). The frog faces +z.
  const MY = 3.75, HINGE = [0, MY, 1.0], JAW_E = { c: [0, 3.5, 2.75], r: [3.0, 1.2, 2.85] };
  const FROG_C = { green: '#6FA35A', dark: '#4E7E3E', cream: '#F2E6C8', toe: '#8DBF6A', eye: '#20202E', sac: '#F0D9C0' };
  const frogs = [];
  const SP = P.special;
  // the hero frog's moment (S03): the drop's release time from the toll table, and when it reaches the open mouth
  // (path.special.frog, a heavy drop let go by the frog's own held D3: about 15.76, then 0.23 m of fall: about 16.04)
  const FROG_TR = EV.releaseTime(SP.frog.pos, false, 0, 0, -1), FROG_LAND = FROG_TR + EV.hitTau(.23, 0);
  // frogs: { pos, yaw, s (scale), seed, hero?, chorus? }. s03(th): a point on the S03 camera's line on terrace 6; camAt is
  // where that camera stands, so the hero frog can face it.
  { const cs = V.cisterns, s03 = th => { const r = lerp(V.ringR(5, th) + 1.2, V.ringR(6, th) - 1.5, .02); return [Math.cos(th) * r, 0, Math.sin(th) * r]; };
    const camAt = s03(-1.593), dirY = (a, b) => Math.atan2(b[0] - a[0], b[2] - a[2]);
    // hero (on cistern 3's rim, path.frog), facing the camera: its mouth (when it looks up) right under the drop
    { const yaw = dirY(P.frog, camAt), mz = 2.2 * U_ * 1.3, d = SP.frog.pos; frogs.push({ hero: true, pos: [d[0] - Math.sin(yaw) * mz, P.frog[1], d[2] - Math.cos(yaw) * mz], yaw, s: 1.3, seed: .3 }); }
    // three more on the rims of the row's cisterns
    for (const [ci, a] of [[1, .4], [2, -2.2], [5, .9]]) { const c = cs[ci], r = .58 * c.size, p = [c.pos[0] + Math.sin(a) * r, c.pos[1] + 1.55 * c.size, c.pos[2] + Math.cos(a) * r]; frogs.push({ pos: p, yaw: a + .3, s: .95 + .1 * R(), seed: R() }); }
    // the chorus round the cloth (S16), west of it where the camera looks east
    { const pl = add(P.pell(84.5).pos, [0, 1, 0]), dn = add(P.dun(84.5).pos, [0, 1.1, 0]), mid = P.mix3(pl, dn, .4), cam = add(mid, [-8.8, 2.2, -2.96]);
      const f = [mid[0] - cam[0], mid[2] - cam[2]], fl = Math.hypot(f[0], f[1]), d = [f[0] / fl, f[1] / fl], l = [-d[1], d[0]];
      for (const [a, o] of [[7.2, -1.1], [7.9, 1.2], [8.7, -2.2], [9.5, .3], [10.4, 1.9], [8.3, 2.7]]) { const x = cam[0] + d[0] * a + l[0] * o, z = cam[2] + d[1] * a + l[1] * o;
        frogs.push({ pos: onG(x, z), yaw: dirY([x, 0, z], cam) + (R() - .5) * .9, s: 1.2 + .2 * R(), seed: R(), chorus: true }); } }
    // two by the Listeners' bench (dusk)
    const b = V.places.spillway.bench; for (const [dx, dz] of [[1.4, 1.1], [-1.1, 1.6]]) { const x = b[0] + dx, z = b[2] + dz; frogs.push({ pos: onG(x, z), yaw: R() * TAU, s: 1, seed: R(), chorus: true }); } }
  // a frog's pose at held time h: pitch (look up, rad), squash (1 rest), jaw (open angle, rad), sac (radius cm), blink 0..1,
  // look x/y (x is never set: always 0), hop (m), turn (rad, added to its yaw)
  function frogPose(f, h) {
    const o = { pitch: 0, sq: 1, jaw: 0, sac: 1.4, blink: 0, lx: 0, ly: 0, hop: 0, turn: 0 };
    const sd = f.seed * 10;
    // breathing: the throat flutters on twos
    o.sac += .12 * (Math.floor(h * 12) % 2) * (.5 + .5 * Math.sin(h * 1.3 + sd));
    // blinks: 3 drawings (half shut, then shut), every 2.6-4.8 s
    const bp = 2.6 + f.seed * 2.2, bx = ((h + sd) % bp + bp) % bp; if (bx < 3 / 12) o.blink = bx < 1 / 12 ? .6 : 1;
    o.turn = .35 * (A.hash(Math.floor((h + sd) / 2.3), f.seed * 99) - .5);   // held glances: a new angle (a cut) every 2.3 s
    if (f.hero) {
      // tc: its croak (the 'frog' toll, held D3); tl: the drop lands in its mouth
      const tc = 14.25, tl = FROG_LAND;
      // the eyes snap up to the drop at 13.95; no glances while it waits for it
      o.ly = keys(h, [[13.7, 0], [13.95, .55, 'snap']]); o.turn *= 1 - sm(13.6, 13.9, h) * (1 - sm(17.4, 17.8, h));
      // the head tips back as it croaks and holds there, then snaps down on the catch
      o.pitch = keys(h, [[14.0, 0], [14.25, -.06, 'io'], [14.5, .2, 'snap'], [15.4, .34, 'io'], [tl - .2, .38], [tl, .16, 'snap'], [tl + .6, .02, 'io']]);
      // the croak: an anticipation drawing, then the sac swells from 1.6 to 3.05 cm over 1.5 s (M8) and trembles on twos;
      // it drops to 1.95 cm as the mouth opens (two drawings before the catch) and settles to 1.45 cm with a damped wobble
      if (h >= tc - 1 / 12 && h < tc) o.sq = .9;
      const tau = h - tc, to = tl - 2 / 12; if (tau >= 0 && h < to) { o.sac = 1.6 + 1.45 * sm(0, 1.5, tau); o.sac *= 1 + .045 * ((Math.floor(h * 12) % 2) * 2 - 1); }
      else if (h >= to) o.sac = lerp(1.95, 1.45, sm(to, tl + .25, h)) * (1 + .1 * Math.sin((h - to) * 30) * Math.exp(-(h - to) * 6));
      // the mouth opens two drawings before the drop arrives (wider on the second), snaps shut one drawing after
      if (h >= tl - 2 / 12 && h < tl + 1 / 12) o.jaw = h < tl - 1 / 12 ? .42 : .62;
      if (h > tl + .35 && h < tl + .75) o.jaw = .08 * Math.abs(Math.sin((h - tl - .35) * 15));    // a gulp, a chew
      // the catch: squashed flat (0.7) for three drawings, then a stretch and a settle
      if (h >= tl && h < tl + 3 / 12) o.sq = .7; else if (h >= tl + 3 / 12) o.sq = 1 + .1 * A.ring(h, tl + 3 / 12, 2.2, .3);
      if (h > tl + .4 && h < tl + 1.4) o.blink = 1;                                   // content: eyes shut in a smile
      if (h < 13.7 || h > tl + 1.4) o.ly = .1;                                         // otherwise: eyes a little up
    }
    if (f.chorus) {   // 81-87: a croak every 1.5 s (0.9 s swell, then rest), staggered by seed; little hops every 3.6 s from 82
      const k = sm(80.6, 81.2, h) * (1 - sm(87.2, 88, h));
      if (k > 0) { const ph = ((h - 81 + f.seed * 1.5) % 1.5 + 1.5) % 1.5, sw = ph < .9 ? Math.sin(Math.PI * ph / .9) : 0;
        o.sac = lerp(o.sac, 1.6 + 1.3 * sw, k); o.pitch += .14 * sw * k; o.sq = 1 - .05 * sw * k;
        const hp = ((h - 82.3 - f.seed * 3) % 3.6 + 3.6) % 3.6; if (hp < .5 && h > 82) { o.hop = Math.sin(Math.PI * hp / .5) * .05; o.sq = hp < .1 ? .85 : 1.06; } } }
    return o; }

  // The frog is sculpted from signed-distance primitives (FILM.sculpt: ellipsoids, spheres, capsules, smooth-blended by k) and
  // meshed once with surface nets, in three pieces drawn as three InstancedMeshes: the body (with the jaw's region carved out), the jaw (hinged
  // at HINGE) and the throat-sac (a sphere scaled every drawing). Each primitive's tag becomes the vertex attribute aId the
  // shaders paint by: 0 green skin, 1 cream belly, 2 / 3 left / right eye, 4 toe pads, 5 jaw, 6 throat.
  function buildFrogs(scene) {
    const C = FROG_C;
    const head = SC.ell(cm([0, 4.1, 2.5]), cm([3.3, 2.35, 2.9]));
    const upper = SC.inter(head, (x, y, z) => MY * U_ - y, .3 * U_); upper.b = head.b;   // the head above the mouth line
    // torso, upper head, belly; then per side: eye bump, eyeball, front leg, front toes, thigh, shin, hind toes
    const body = [{ f: SC.ell(cm([0, 3.0, -1.0]), cm([3.5, 2.75, 4.2])), col: C.green, tag: 0 },
      { f: upper, col: C.green, k: 1.1 * U_, tag: 0 },
      { f: SC.ell(cm([0, 2.35, .6]), cm([2.9, 1.6, 3.3])), col: C.cream, k: .7 * U_, tag: 1 }];
    for (const s of [1, -1]) {
      body.push({ f: SC.sph(cm([1.85 * s, 5.55, 2.8]), 1.45 * U_), col: C.green, k: .9 * U_, tag: 0 });
      body.push({ f: SC.sph(cm([1.98 * s, 5.72, 3.12]), 1.12 * U_), col: C.eye, k: .12 * U_, tag: s > 0 ? 2 : 3 });
      body.push({ f: SC.cap(cm([2.5 * s, 2.7, 2.1]), cm([3.0 * s, .6, 3.5]), .8 * U_, .55 * U_), col: C.green, k: .5 * U_, tag: 0 });
      body.push({ f: SC.ell(cm([3.25 * s, .42, 4.05]), cm([.95, .42, .8])), col: C.toe, k: .4 * U_, tag: 4 });
      body.push({ f: SC.ell(cm([3.0 * s, 1.9, -2.6]), cm([1.75, 1.7, 2.6])), col: C.green, k: .9 * U_, tag: 0 });
      body.push({ f: SC.cap(cm([3.7 * s, .42, -1.7]), cm([3.45 * s, .36, 1.1]), .55 * U_, .45 * U_), col: C.green, k: .45 * U_, tag: 0 });
      body.push({ f: SC.ell(cm([3.5 * s, .32, 1.5]), cm([.95, .34, .75])), col: C.toe, k: .35 * U_, tag: 4 }); }
    // the body loses a slightly larger copy of the jaw below the mouth line, so the jaw has room to swing down
    const jawBig = SC.ell(cm(JAW_E.c), cm(JAW_E.r.map(v => v + .12)));
    const jawRegion = (x, y, z) => Math.max(jawBig(x, y, z), y - MY * U_);
    const bmin = cm([-5.4, -.4, -6.2]), bmax = cm([5.4, 7.6, 6.6]), h = .28 * U_;   // the meshing box and a 2.8 mm grid
    const gBody = SC.mesh(body, bmin, bmax, h, { blend: .35 * U_, post: (d, x, y, z) => Math.max(d, -jawRegion(x, y, z)) });
    const jawE = SC.ell(cm(JAW_E.c), cm(JAW_E.r));
    const gJaw = SC.mesh([{ f: jawE, col: C.green, tag: 5 }, { f: SC.ell(cm([0, 3.0, 3.1]), cm([2.5, .85, 2.4])), col: C.cream, k: .5 * U_, tag: 6 }],
      cm([-3.6, 2.0, -.4]), cm([3.6, 4.2, 6.0]), .22 * U_, { blend: .3 * U_, post: (d, x, y, z) => Math.max(d, y - MY * U_) });
    const gSac = new THREE.SphereGeometry(1, 18, 12);
    const N = frogs.length;
    // per instance aFrog = (eyelid 0..1, look x (always 0), look y, -), written by updateFrogs
    const fa = new Float32Array(N * 4); gBody.setAttribute('aFrog', IA(fa, 4)); built.frogA = gBody.attributes.aFrog;
    const FP = /* glsl */`attribute float aId; attribute vec4 aFrog; varying float vId; varying vec4 vFrog;`;
    const bodyMat = E.toon({ vcol: true, paint: .14, rim: .4, soft: .03, uniforms: {},
      vpars: FP, vnormal: 'vId = aId; vFrog = aFrog;',
      fpars: 'varying float vId; varying vec4 vFrog;',
      fpre: /* glsl */`
        vec3 o = vOP * 100.0;   // object space in cm
        // the mouth's inside, seen when the jaw drops
        vec3 jq = (o - vec3(${JAW_E.c.join(', ')})) / vec3(${JAW_E.r.map(v => (v + .35).toFixed(2)).join(', ')});
        if (o.y < ${MY + .12} && dot(jq, jq) < 1.0) { base = mix(vec3(0.45, 0.12, 0.2), vec3(0.75, 0.32, 0.36), smoothstep(-0.2, 0.9, jq.z)); lightK = 0.6; }
        else if (vId > 1.5 && vId < 3.5) {   // the eyes: a big pupil, a gold rim, two highlights; the lid comes down when it blinks
          float s = vId < 2.5 ? 1.0 : -1.0; vec3 d = normalize(o - vec3(1.98 * s, 5.72, 3.12));
          vec3 lk = normalize(vec3(0.42 * s + vFrog.y * 0.3, 0.12 + vFrog.z * 0.6, 0.9));
          float c0 = dot(d, lk);
          base = mix(vec3(0.86, 0.66, 0.2), vec3(0.06, 0.05, 0.1), smoothstep(0.62, 0.66, c0));
          float hl = smoothstep(0.955, 0.965, dot(d, normalize(lk + vec3(-0.3 * s, 0.38, 0.0)))) + smoothstep(0.985, 0.99, dot(d, normalize(lk + vec3(0.22 * s, -0.24, 0.0)))) * 0.8;
          base = mix(base, vec3(1.6), hl); lightK = max(lightK, 0.7);
          // the lid: skin colour above a line that comes down as it blinks, with a dark lash line
          float lid = vFrog.x; if (lid > 0.01) { float edge = 1.0 - 2.1 * lid; float above = smoothstep(edge - 0.02, edge + 0.02, d.y + 0.25 * d.z * 0.0);
            base = mix(base, vec3(0.44, 0.64, 0.35), above);
            float ln = lid < 0.95 ? abs(d.y - edge) : abs(d.y + 0.02 - 0.35 * (1.0 - d.z)); base = mix(base, vec3(0.13, 0.17, 0.1), smoothstep(0.07, 0.02, ln) * step(0.2, d.z)); } }
        else if (vId < 0.5) {   // dark spots on the back, a darker top
          float sp = smoothstep(0.62, 0.66, nz(o.xz * 0.045 + 0.3)) * smoothstep(3.0, 4.5, o.y);
          base = mix(base, base * vec3(0.62, 0.7, 0.55), sp * 0.8); base *= mix(0.88, 1.04, smoothstep(2.0, 5.5, o.y)); }`,
    });
    // the jaw: its top face (inside the mouth) is pink, with a lighter tongue
    const jawMat = E.toon({ vcol: true, paint: .12, rim: .35, soft: .03,
      vpars: 'attribute float aId; varying float vId;', vnormal: 'vId = aId;', fpars: 'varying float vId;',
      fpre: /* glsl */`vec3 o = vOP * 100.0; if (o.y > ${MY - .16}) { base = vec3(0.78, 0.36, 0.4); float tg = length((o.xz - vec2(0.0, 3.4)) / vec2(1.3, 1.6)); base = mix(base, vec3(0.92, 0.5, 0.5), smoothstep(1.0, 0.85, tg)); lightK = 0.7; }`,
    });
    // the sac: thin, glossy skin: a sharp sun highlight and a pink flush round its sides
    const sacMat = E.toon({ color: C.sac, paint: .05, rim: .3, soft: .03, wrap: .1,
      fpost: /* glsl */`vec3 Hh = normalize(uSunDir + V); c += uSunCol * smoothstep(0.965, 0.975, dot(N, Hh)) * 0.45; c = mix(c, c * vec3(1.02, 0.88, 0.88), 0.35 * (1.0 - abs(N.y)));`,
    });
    // one InstancedMesh per piece, all 12 frogs, each with an ink outline; the matrices change every drawing
    const mk = (g, m) => { const im = new THREE.InstancedMesh(g, m, N); im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); E.outline(im, { color: '#25331F', px: 1.6, max: .004 }); im.userData.line.frustumCulled = false; scene.add(im); return im; };
    built.frogBody = mk(gBody, bodyMat); built.frogJaw = mk(gJaw, jawMat); built.frogSac = mk(gSac, sacMat);
  }
  const mB = new THREE.Matrix4(), mJ = new THREE.Matrix4(), mS = new THREE.Matrix4(), mT = new THREE.Matrix4(), mR = new THREE.Matrix4();
  // once per drawing: every frog's three matrices (body, jaw, sac) and its eye attribute
  function updateFrogs(t) {
    if (!built.frogBody) return; const h = A.held(t), fa = built.frogA.array;
    frogs.forEach((f, i) => { const o = frogPose(f, h), s = f.s;
      // body: on its spot, turned, pitched up about a point 4 cm behind its centre (its back feet), squashed with its volume kept
      mB.makeTranslation(f.pos[0], f.pos[1] + o.hop, f.pos[2]).multiply(mR.makeRotationY(f.yaw + o.turn))
        .multiply(mT.makeTranslation(0, 0, -4 * U_ * s)).multiply(mR.makeRotationX(-o.pitch)).multiply(mT.makeTranslation(0, 0, 4 * U_ * s))
        .multiply(mS.makeScale(s / Math.sqrt(o.sq), s * o.sq, s / Math.sqrt(o.sq)));
      built.frogBody.setMatrixAt(i, mB);
      // jaw: the body's matrix, then a rotation about the hinge
      mJ.copy(mB).multiply(mT.makeTranslation(...cm(HINGE))).multiply(mR.makeRotationX(o.jaw)).multiply(mS.makeTranslation(...cm(HINGE).map(v => -v)));
      built.frogJaw.setMatrixAt(i, mJ);
      // sac: hangs under the jaw and moves forward and down as it swells
      const r = o.sac * U_, c = [0, 3.05 - .18 * (o.sac - 1.4), 3.15 + .58 * (o.sac - 1.4)];
      mS.copy(mJ).multiply(mT.makeTranslation(...cm(c))).multiply(mR.makeScale(r * 1.05, r * .9, r)); built.frogSac.setMatrixAt(i, mS);
      fa.set([o.blink, 0, o.ly, 0], i * 4); });
    for (const m of [built.frogBody, built.frogJaw, built.frogSac]) m.instanceMatrix.needsUpdate = true; built.frogA.needsUpdate = true;
  }

  // ================================================================== BEAD-SNAILS (built in finalize: they ride the rain's strand beads)
  // snails: { strand, j (bead index), field, a (heading round the bead), seed } on the rain's strands, or { fixed: [x, y, z], a, seed }.
  // Picks: 20 on Cistern Row strands, 8 on terrace 9, 4 at the bench, 6 in the S01 macro grove, 4 on Pell's roof, and the rest
  // on drifting field strands, starting 5-18 beads above their lowest bead.
  const snails = [];
  function buildSnails(scene) {
    const rn = A.named('life-snails');
    if (F.rain && F.rain.strands && F.rain.strands.length && F.rain.beadAt) {
      const st = F.rain.strands, by = pl => st.map((s, i) => [s, i]).filter(([s]) => pl(s));
      const pickN = (list, n) => { for (let k = 0; k < n && list.length; k++) { const [s, i] = list[Math.floor(rn() * list.length)]; snails.push({ strand: i, j: s.kind === 'field' ? Math.max(0, s.n - 6 - Math.floor(rn() * 14)) : Math.floor(rn() * Math.max(1, s.n - 1)), field: s.kind === 'field', a: rn() * TAU, seed: rn() }); } };
      pickN(by(s => s.place === 'cisternRow'), 20); pickN(by(s => s.place === 'terrace9'), 8); pickN(by(s => s.place === 'bench'), 4); pickN(by(s => s.place === 'macro'), 6); pickN(by(s => s.place === 'pellRoof'), 4);
      pickN(by(s => s.kind === 'field'), 60 - snails.length); }
    else {   // no rain module: on the cisterns and the wall under Cistern Row
      for (let i = 0; i < 60; i++) { const c = V.cisterns[i % V.cisterns.length], a = rn() * TAU, y = .4 + 1.0 * rn();
        snails.push({ fixed: [c.pos[0] + Math.sin(a) * .8 * c.size, c.pos[1] - .05 + y * c.size, c.pos[2] + Math.cos(a) * .8 * c.size], a, seed: rn() }); } }
    // a shell: a lathe whose whorls are twisted into a spiral; a soft foot with two eye stalks (about 4 cm long in all),
    // merged into one mesh with vertex colours
    const prof = []; for (let i = 0; i <= 16; i++) { const y = i / 16, r = (1 - y * .92) * (.7 + .3 * Math.abs(Math.sin(Math.PI * 3 * y))); prof.push(new THREE.Vector2(Math.max(.02, r * .9), y * 1.25)); }
    const sh = new THREE.LatheGeometry(prof, 12); { const p = sh.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i), a = y / 1.25 * 3 * TAU, x = p.getX(i), z = p.getZ(i);
      p.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), y, x * Math.sin(a) + z * Math.cos(a)); } sh.computeVertexNormals(); }
    sh.rotateX(-.55); sh.scale(.017, .017, .017); sh.translate(0, .006, -.004);
    const foot = new THREE.CapsuleGeometry(.0075, .024, 3, 8); foot.rotateX(Math.PI / 2); foot.scale(1, .5, 1); foot.translate(0, .0035, .003);
    const st1 = new THREE.CylinderGeometry(.0012, .0012, .009, 4); st1.rotateX(-.5); const st2 = st1.clone(); st1.translate(.0035, .0085, .02); st2.translate(-.0035, .0085, .02);
    const parts = [[sh, '#F2B8BE'], [foot, '#D9CFC4'], [st1, '#CFC2B6'], [st2, '#CFC2B6']].map(([g, c]) => { const gg = g.toNonIndexed(); gg.deleteAttribute('uv'); const n = gg.attributes.position.count, col = new THREE.Color(c), a = new Float32Array(n * 3); for (let i = 0; i < n; i++) col.toArray(a, i * 3); gg.setAttribute('color', new THREE.BufferAttribute(a, 3)); return gg; });
    const merged = mergeGeos(parts);
    const mat = E.toon({ vcol: true, paint: .1, rim: .45, soft: .03, fpre: 'if (vOP.y > 0.009) base *= 0.85 + 0.25 * smoothstep(0.3, 0.7, fract(atan(vOP.z, vOP.x) * 0.477 + vOP.y * 90.0));' });
    const m = new THREE.InstancedMesh(merged, mat, snails.length); m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    E.outline(m, { color: '#4A2A3A', px: 1.4, max: .0015 }); m.userData.line.frustumCulled = false; scene.add(m); built.snails = m;
  }
  // concatenate non-indexed geometries (position, normal, color) into one
  function mergeGeos(list) { let n = 0; list.forEach(g => n += g.attributes.position.count); const p = new Float32Array(n * 3), nn = new Float32Array(n * 3), c = new Float32Array(n * 3); let o = 0;
    for (const g of list) { p.set(g.attributes.position.array, o * 3); nn.set(g.attributes.normal.array, o * 3); c.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nn, 3)); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g; }
  const dum = new THREE.Object3D();
  // every frame (film time t): a snail moves one bead up its strand every 22 s (1 cm/s on the 0.22 m local strands; field
  // strands count beads from the top, local ones from the tip, hence the two signs) and slowly circles its bead. It sits on
  // the bead's live position, so it rides the bead down when it falls, and hides once the bead is gone (radius under 4 mm).
  // Without the rain module it climbs its cistern at 1 mm/s.
  function updateSnails(t) {
    if (!built.snails) return; const m = built.snails;
    snails.forEach((s, i) => { let p, r = .05, vis = 1;
      if (s.fixed) { p = [s.fixed[0], s.fixed[1] + .01 * t * .1, s.fixed[2]]; dum.position.set(...p); dum.rotation.set(0, s.a + Math.PI, 0); dum.rotateX(-1.4); dum.scale.setScalar(1); }
      else { const st = F.rain.strands[s.strand], dj = Math.floor(Math.max(0, t) * .01 / .22), j = clamp(s.field ? s.j - dj : s.j + dj, 0, st.n - 1), b = F.rain.beadAt(s.strand, j, t);
        r = b.r; vis = b.r > .004 ? 1 : 0; const a = s.a + t * .02, out = [Math.sin(a), 0, Math.cos(a)];
        p = [b.p[0] + out[0] * (r + .002), b.p[1] + r * .15, b.p[2] + out[2] * (r + .002)];
        dum.position.set(...p); dum.rotation.set(0, a + Math.PI, 0); dum.rotateX(-1.25); dum.scale.setScalar(vis); }
      dum.updateMatrix(); m.setMatrixAt(i, dum.matrix); });
    m.instanceMatrix.needsUpdate = true; }

  // ================================================================== CHIMEWINGS
  // two flocks of 40. Flock A crosses the valley at 9.0, scatters in the gust (36-39) and comes home over the crowd (81-87);
  // flock B wheels round Pell on the staircase and bursts away (S09). Birds 0-39 are flock A, 40-79 flock B.
  // bird(i, t) (public) -> [x, y, z], or null while that bird is not in the sky.
  // Per bird: off (its place in the flock, m), ph (wingbeat phase), seed, sc (its scatter direction), f (wingbeats a second).
  const NB = 80, BIRD = [];
  { const rb = A.named('life-birds'); for (let i = 0; i < NB; i++) BIRD.push({ off: [gaussB(rb) * 3.2, gaussB(rb) * 1.0, gaussB(rb) * 3.2], ph: rb() * TAU, seed: rb(), sc: [rb() * 2 - 1, .3 + .7 * rb(), rb() * 2 - 1], f: 2.7 + .6 * rb() }); }
  function gaussB(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * r()); }   // gauss() on stream r
  // flock A's three flights: in the sky t0..t1, shedding mist in the ring window, along a Catmull-Rom path through pts (m);
  // the gust flight scatters from `scatter`
  const FLOCK_A = [
    { t0: 6.6, t1: 12.6, ring: [8.4, 10.9], pts: [[-62, 24, -43], [-37, 25, -14], [-11, 27, 17], [14, 29, 46], [38, 32, 75]] },
    { t0: 34.0, t1: 41.5, ring: [36.3, 38.9], pts: [[-10, 34, -92], [28, 33, -70], [62, 34, -52], [110, 40, -30], [160, 52, 0]], scatter: 36.3 },
    { t0: 80.4, t1: 88.0, ring: [82.2, 86.0], pts: [[250, 55, -70], [212, 40, -45], [192, 31.8, -18], [186, 32.4, 4], [160, 48, 38]] },
  ];
  const tmpP = [0, 0, 0];
  // where bird i is at time t (written into out), or null. Flock A: along its flight's path, each bird a little behind the
  // leader by i % 7, round its own offset in the flock, plus a slow wobble; in the gust each is blown downwind and apart.
  function birdPos(i, t, out = [0, 0, 0]) {
    const b = BIRD[i], s = b.seed, w = A.wobble;
    if (i < 40) { const seg = FLOCK_A.find(g => t >= g.t0 && t <= g.t1); if (!seg) return null;
      const u = (t - seg.t0) / (seg.t1 - seg.t0), lead = (i % 7) * .006; A.crPoint(seg.pts, clamp(u - lead), out);
      const mur = 1 + .35 * Math.sin(t * .9 + s * 6);                     // the flock breathes like a murmuration
      out[0] += b.off[0] * mur + 1.4 * w(t * .6, s * 30); out[1] += b.off[1] * mur + .8 * w(t * .5, s * 30 + 7); out[2] += b.off[2] * mur + 1.4 * w(t * .6, s * 30 + 13);
      if (seg.scatter) { const k = sm(seg.scatter + s * .25, seg.scatter + 1.6 + s * .4, t), ex = (t - seg.scatter) * k;
        out[0] += (b.sc[0] * 7 + WIND[0] * 9) * ex; out[1] += (b.sc[1] * 4 - 1.2) * ex; out[2] += (b.sc[2] * 7 + WIND[2] * 9) * ex; }
      return out; }
    // flock B: round Pell between the drops (47-54), a circle of radius about 7 m, 1.5 m above her, bursting outward at 50.2
    if (t < 46.6 || t > 54.6) return null;
    const pc = P.pell(t).pos, a = t * .7 + (i - 40) / 40 * TAU * .35 + s, rr = 7 + b.off[0] * .35;
    out[0] = pc[0] + Math.cos(a) * rr; out[1] = pc[1] + 1.5 + b.off[1] * .8 + .6 * w(t * .8, s * 20); out[2] = pc[2] + Math.sin(a) * rr;
    const k = sm(50.2 + s * .3, 51.4 + s * .3, t), ex = (t - 50.2) * k * 1.0; const dx = out[0] - pc[0], dz = out[2] - pc[2], dl = Math.hypot(dx, dz) || 1;
    out[0] += dx / dl * 7 * ex + b.sc[0] * 2 * ex; out[1] += (b.sc[1] * 3 + .5) * ex; out[2] += dz / dl * 7 * ex + b.sc[2] * 2 * ex;
    return out; }
  // is bird i shedding mist with its wingbeats at t (FILM.life.birdRing)
  const ringOf = (i, t) => { if (i < 40) { const g = FLOCK_A.find(g => t >= g.ring[0] && t <= g.ring[1]); return !!g; } return t > 49.0 && t < 52.6; };
  // wingbeats a second: 2.7-3.3, faster in the gust (x1.45) and round Pell (x1.25)
  const flapF = (i, t) => BIRD[i].f * (i < 40 ? (t > 34 && t < 42 ? 1.45 : 1) : 1.25);       // constant through each ringing window
  const glides = (i, t) => i < 40 && t > 9.6 && t < 11 && i % 5 === 0;   // every fifth bird of flock A glides across S02: no flap, no mist
  // M9: every wingbeat shakes down 12 mist beads where the bird was; they sink and fade (registered with the rain)
  // For beat k at time tk the beads are spread along the stretch flown since the previous beat; they appear just before tk,
  // let go one after another (tr), and vanish 6.5 s later.
  function birdBeads() {
    const list = [], rb = A.named('life-bird-beads'), q = [0, 0, 0], q0 = [0, 0, 0];
    for (let i = 0; i < NB; i++) { const b = BIRD[i]; const wins = i < 40 ? FLOCK_A.map(g => g.ring) : [[49.0, 52.6]];
      for (const [r0, r1] of wins) { const fe = flapF(i, (r0 + r1) / 2); for (let k = Math.ceil(r0 * fe + b.ph / TAU); ; k++) { const tk = (k - b.ph / TAU) / fe; if (tk > r1) break; if (tk < r0) continue;
          if (glides(i, tk) || !birdPos(i, tk, q) || !birdPos(i, tk - 1 / fe, q0)) continue;
          for (let j = 0; j < 12; j++) { const u = (j + rb()) / 12;
            list.push({ p: [lerp(q0[0], q[0], u) + (rb() - .5) * .08, lerp(q0[1], q[1], u) - .04 + (rb() - .5) * .05, lerp(q0[2], q[2], u) + (rb() - .5) * .08], band: 2, size: .003 + .003 * rb(), ts: tk - .02, tr: tk + .015 * u, until: tk + 6.5, seed: rb() }); } } } }
    return list; }
  // The chimewing vertex shader: the flap is done here, the flight (instance matrix) in updateBirds.
  const BIRD_GL = /* glsl */`
// per vertex aWing = (1 on a wing, side +-1, -, -); per instance aBird = (flap phase in beats, flap amplitude rad, dihedral rad, -)
attribute vec4 aWing; attribute vec4 aBird; varying vec3 vBd;
void birdPose(vec3 pos, vec3 nrm, out vec3 p, out vec3 n){
  p = pos; n = nrm; vBd = vec3(aWing.x, aWing.y, 0.0);
  if (aWing.x > 0.5) {   // wings: the inner part turns at the shoulder, the outer part folds further (a 4-drawing flap on twos)
    float side = aWing.y, th = aBird.y * sin(6.2832 * aBird.x) + aBird.z, th2 = th * 0.6 + aBird.y * 0.35 * sin(6.2832 * aBird.x - 1.2);
    vec3 q = p; q.x *= side;   // left side in +x
    float x0 = 0.012, x1 = 0.055;   // the shoulder and the wrist, m from the body's axis
    if (q.x > x1) { vec3 j = vec3(x1, 0.0, q.z); vec3 r = q - j; float c2 = cos(th + th2), s2 = sin(th + th2); r = vec3(r.x * c2 - r.y * s2, r.x * s2 + r.y * c2, r.z);
      float c1 = cos(th), s1 = sin(th); vec3 jj = vec3(x0 + (x1 - x0) * c1, (x1 - x0) * s1, q.z); q = jj + r; n = vec3(-s2 * side, c2, 0.0); }
    else { vec3 r = q - vec3(x0, 0.0, 0.0); float c1 = cos(th), s1 = sin(th); q = vec3(x0, 0.0, 0.0) + vec3(r.x * c1 - r.y * s1, r.x * s1 + r.y * c1, r.z); n = vec3(-s1 * side, c1, 0.0); }
    q.x *= side; p = q; }
  // far birds are drawn a little larger, so the flock still reads as birds (never under about 18 px across at 1080p):
  // a 0.22 m wingspan at distance d covers 0.22 * 540 * P[1][1] / d pixels of a 1080-pixel-high frame
  p *= max(1.0, 36.0 * distance(cameraPosition, instanceMatrix[3].xyz) / (0.22 * 1080.0 * projectionMatrix[1][1]));
}`;
  function buildBirds(scene) {
    const pos = [], nrm = [], col = [], wing = [], idx = [];
    const v = (x, y, z, nx, ny, nz, c, w0, w1) => { pos.push(x, y, z); nrm.push(nx, ny, nz); col.push(...c); wing.push(w0, w1, 0, 0); return pos.length / 3 - 1; };
    const IND = new THREE.Color('#2A3570').toArray(), WHITE = new THREE.Color('#F4F8FF').toArray(), RUST = new THREE.Color('#C9603A').toArray();
    // a bird about 12 cm long with a 22 cm wingspan, facing +z
    // body: a spindle along z (lathe), indigo above, white below, a rust throat
    { const prof = [[0, -.06], [.012, -.045], [.019, -.012], [.019, .016], [.013, .036], [.006, .05], [0, .058]], NS = 8, o = pos.length / 3;
      for (let i = 0; i < prof.length; i++) for (let s = 0; s < NS; s++) { const a = s / NS * TAU, r = prof[i][0], ny = Math.sin(a), nx = Math.cos(a);
        const c = ny > -.15 ? IND : (prof[i][1] > .025 ? RUST : WHITE); v(nx * r, ny * r * .85, prof[i][1], nx, ny, 0, c, 0, 0); }
      for (let i = 0; i < prof.length - 1; i++) for (let s = 0; s < NS; s++) { const a = o + i * NS + s, b = o + i * NS + (s + 1) % NS, c = a + NS, d = b + NS; idx.push(a, b, c, b, d, c); } }
    // forked tail
    for (const s of [1, -1]) { const a = v(0, .004, -.045, 0, 1, 0, IND, 0, 0), b = v(.006 * s, .004, -.05, 0, 1, 0, IND, 0, 0), c = v(.03 * s, .002, -.115, 0, 1, 0, IND, 0, 0), d = v(.012 * s, .003, -.07, 0, 1, 0, IND, 0, 0);
      idx.push(a, c, b, a, d, c); }
    // wings: two parts each, swept back to a point
    for (const s of [1, -1]) { const p0 = v(.012 * s, 0, .022, 0, 1, 0, IND, 1, s), p1 = v(.012 * s, 0, -.022, 0, 1, 0, IND, 1, s), p2 = v(.055 * s, 0, .02, 0, 1, 0, IND, 1, s), p3 = v(.055 * s, 0, -.028, 0, 1, 0, IND, 1, s),
        p4 = v(.112 * s, 0, -.03, 0, 1, 0, IND, 1, s), p5 = v(.085 * s, 0, -.035, 0, 1, 0, IND, 1, s);
      if (s > 0) idx.push(p0, p2, p1, p1, p2, p3, p2, p4, p3, p3, p4, p5); else idx.push(p0, p1, p2, p1, p3, p2, p2, p3, p4, p3, p5, p4); }
    const g = geo(pos, nrm, idx, { color: [col, 3], aWing: [wing, 4] });
    const ba = new Float32Array(NB * 4); g.setAttribute('aBird', IA(ba, 4)); built.birdA = g.attributes.aBird; built.birdA.setUsage(THREE.DynamicDrawUsage);
    const mat = E.toon({ vcol: true, side: THREE.DoubleSide, paint: .05, rim: .4, soft: .03, wrap: .2,
      vpars: BIRD_GL, vnormal: 'vec3 lP, lN; birdPose(position, objectNormal, lP, lN); objectNormal = lN;', vdeform: 'transformed = lP;',
      fpars: 'varying vec3 vBd;',
      fpre: 'if (vBd.x > 0.5) { base = gl_FrontFacing ? vec3(0.165, 0.208, 0.44) : vec3(0.36, 0.4, 0.62); }',
    });
    const m = new THREE.InstancedMesh(g, mat, NB); m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(m); built.birds = m;
  }
  const pa = [0, 0, 0], pb = [0, 0, 0];
  // once per drawing: each bird faces where it will be 0.06 s later and banks into its turn (x6 the change of heading over
  // the next 0.06 s, at most 0.9 rad); birds not in the sky are parked under the ground at scale 0
  function updateBirds(t, cam) {
    if (!built.birds) return; const m = built.birds, ba = built.birdA.array, h = A.held(t);
    let cx = 0, cy = 0, cz = 0, cn = 0;
    for (let i = 0; i < NB; i++) { const p = birdPos(i, h, pa);
      if (!p) { dum.position.set(0, -500, 0); dum.scale.setScalar(0); dum.updateMatrix(); m.setMatrixAt(i, dum.matrix); continue; }
      const q = birdPos(i, h + .06, pb) || p, d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], dl = Math.hypot(...d) || 1;
      const yaw = Math.atan2(d[0], d[2]), pitch = Math.asin(clamp(d[1] / dl, -1, 1));
      const q2 = birdPos(i, h + .12, [0, 0, 0]) || q, yaw2 = Math.atan2(q2[0] - q[0], q2[2] - q[2]), bank = clamp(-(Math.atan2(Math.sin(yaw2 - yaw), Math.cos(yaw2 - yaw))) * 6, -.9, .9);
      dum.position.set(p[0], p[1], p[2]); dum.rotation.set(0, 0, 0); dum.rotateY(yaw); dum.rotateX(-pitch); dum.rotateZ(bank); dum.scale.setScalar(1); dum.updateMatrix(); m.setMatrixAt(i, dum.matrix);
      const f = flapF(i, h), glide = glides(i, h);
      ba.set([h * f + BIRD[i].ph / TAU, glide ? .05 : .85, glide ? .1 : .15, 0], i * 4);
      if (i < 40 && h > 7 && h < 12.5) { cx += p[0]; cy += p[1]; cz += p[2]; cn++; } }
    m.instanceMatrix.needsUpdate = true; built.birdA.needsUpdate = true;
    // the flock over the leaves (S02): the cup-leaves below twitch toward it
    if (cn) LU.uLfBird.value.set(cx / cn, cy / cn, cz / cn, sm(8.2, 8.8, t) * (1 - sm(11, 11.6, t))); else LU.uLfBird.value.set(0, -1e4, 0, 0);
  }

  // ================================================================== HUSHMOTHS
  // moths: { c (the point it circles, under a house's eaves), r (radius m), w (rad/s, either way), ph, seed }:
  // 12 round the Cistern Row houses (terraces 6-7), 6 at Pell's roof, 4 at the Spillway hut, 8 at every fourth house
  const moths = [];
  { const rm = A.named('life-moths'), cr = V.places.cisternRow;
    const near = V.houses.filter(h => !h.pell && !h.hut && (h.k === 6 || h.k === 7) && h.th > cr.th0 - .1 && h.th < cr.th1 + .1);
    const pick = (list, n) => { for (let i = 0; i < n && list.length; i++) { const h = list[i % list.length], lx = (rm() - .5) * 3 * h.size, c = V.houseToWorld(h, lx, (2.6 + 1.6 * rm()) * h.size, (2.6 + .8 * rm()) * h.size);
      moths.push({ c, r: .5 + .8 * rm(), w: (.6 + .5 * rm()) * (rm() < .5 ? -1 : 1), ph: rm() * TAU, seed: rm() }); } };
    pick(near, 12); pick([V.places.pellRoof.house], 6); pick([V.places.spillway.hut], 4); pick(V.houses.filter((h, i) => i % 4 === 1), 8); }
  // a slow flattened circle with a flutter on top
  function mothAt(m, t, out) { const a = m.ph + m.w * t; out[0] = m.c[0] + Math.cos(a) * m.r + .15 * Math.sin(t * 2.3 + m.seed * 9); out[1] = m.c[1] + .3 * Math.sin(t * 1.7 + m.ph) + .08 * Math.sin(t * 5.1 + m.seed * 20); out[2] = m.c[2] + Math.sin(a) * m.r * .7; return out; }
  function buildMoths(scene) {
    const pos = [], nrm = [], w = [], idx = [];
    // two wing quads (5 x 7 cm, hinged at the body) and a body quad; the wing shape is cut in the fragment shader.
    // aMw = (side +-1, or 0 on the body; quad u; quad v)
    for (const s of [1, -1]) { const o = pos.length / 3; for (const [x, z] of [[0, -.03], [0, .03], [.05 * s, -.035], [.05 * s, .035]]) { pos.push(x, 0, z); nrm.push(0, 1, 0); w.push(s, x * s / .05, z / .035); }
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    { const o = pos.length / 3; for (const [x, z] of [[-.006, -.025], [.006, -.025], [-.006, .02], [.006, .02]]) { pos.push(x, .002, z); nrm.push(0, 1, 0); w.push(0, x / .006, z / .025); } idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3); }
    const g = geo(pos, nrm, idx, { aMw: [w, 3] }), ma = new Float32Array(moths.length * 4); g.setAttribute('aMoth', IA(ma, 4)); built.mothA = g.attributes.aMoth;
    // vdeform raises both wings by the angle aMoth.x about the body's axis; fpre cuts a fore and a hind wing out of each quad
    // (two ellipses) and paints a dark eye-spot and pale edges
    const mat = E.toon({ side: THREE.DoubleSide, paint: .2, rim: .3, soft: .05, wrap: .3,
      vpars: 'attribute vec3 aMw; attribute vec4 aMoth; varying vec3 vMw;',
      vnormal: 'vMw = aMw;',
      vdeform: 'if (abs(aMw.x) > 0.5) { float a = aMoth.x * aMw.x; float x = transformed.x; transformed.x = x * cos(a); transformed.y = abs(x) * sin(aMoth.x); }',
      fpars: 'varying vec3 vMw;',
      fpre: /* glsl */`
        if (abs(vMw.x) > 0.5) { vec2 q = vec2(vMw.y, vMw.z); float fore = length((q - vec2(0.55, 0.35)) / vec2(0.55, 0.65)), hind = length((q - vec2(0.45, -0.45)) / vec2(0.45, 0.5));
          if (min(fore, hind) > 1.0) discard;
          base = vec3(0.7, 0.64, 0.78); base = mix(base, vec3(0.45, 0.38, 0.56), smoothstep(0.32, 0.26, length(q - vec2(0.6, 0.3))));
          base = mix(base, vec3(0.86, 0.8, 0.9), smoothstep(0.75, 1.0, min(fore, hind)) * 0.6); }
        else { if (abs(vMw.y) > 1.0) discard; base = vec3(0.5, 0.44, 0.52); }`,
    });
    const m = new THREE.InstancedMesh(g, mat, moths.length); m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.castShadow = false; scene.add(m); built.moths = m;
  }
  // once per drawing: facing along its path, scaled 1.2 (about 12 cm across), a 4-drawing flap (0.15, 0.75, 1.25, 0.75 rad)
  function updateMoths(t) {
    if (!built.moths) return; const h = A.held(t), ma = built.mothA.array;
    moths.forEach((mo, i) => { const p = mothAt(mo, h, pa), q = mothAt(mo, h + .1, pb);
      dum.position.set(...p); dum.rotation.set(0, Math.atan2(q[0] - p[0], q[2] - p[2]), 0); dum.rotateX(-.25); dum.scale.setScalar(1.2); dum.updateMatrix(); built.moths.setMatrixAt(i, dum.matrix);
      const fl = Math.floor(h * 12 + mo.seed * 4) % 4; ma[i * 4] = [.15, .75, 1.25, .75][fl]; });
    built.moths.instanceMatrix.needsUpdate = true; built.mothA.needsUpdate = true; }

  // ================================================================== DROP-TADPOLES (plop into the Cistern Row cisterns)
  // plops: { c (cistern index), t (when it hits the water), a (where on the water), seed }: six as the cupola bells bring the
  // mist down (33.25-34.95), then two per cistern in the green flood (75.7-78.7)
  const plops = [];
  { const rt = A.named('life-tadpoles'), cs = V.cisterns;
    [[1, 33.25], [3, 33.55], [2, 33.9], [4, 34.25], [3, 34.6], [5, 34.95]].forEach(([c, t]) => plops.push({ c, t, a: rt() * TAU, seed: rt() }));
    for (let i = 0; i < cs.length; i++) for (let j = 0; j < 2; j++) plops.push({ c: i, t: 75.7 + i * .35 + j * (.5 + .6 * rt()), a: rt() * TAU, seed: rt() }); }
  // cistern i's water line: it rises to the brim over the 2.5 s before that cistern overflows (76.6 + 0.35 i, as world.js)
  const waterY = (c, i, t) => c.pos[1] - .05 + c.size * lerp(1.36, 1.5, sm(76.6 + i * .35 - 2.5, 76.6 + i * .35, t));
  // two instances per plop on one transparent plane: the tadpole (2i) and its ripple ring (2i + 1).
  // aTd = (kind: 0 ripple, 1 swimming, 2 falling in its drop; alpha; seed; -). Both shapes are drawn in the fragment shader.
  function buildTadpoles(scene) {
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); const n = plops.length * 2;
    const ta = new Float32Array(n * 4); g.setAttribute('aTd', IA(ta, 4)); built.tadA = g.attributes.aTd;
    const mat = new THREE.ShaderMaterial({ uniforms: Object.assign({}, F.U), transparent: true, depthWrite: false,
      vertexShader: E.COMMON + /* glsl */`attribute vec4 aTd; varying vec2 vUv2; varying vec4 vTd; varying vec3 vWP;
        void main(){ vUv2 = position.xz; vTd = aTd; vec3 p = position;
          vec4 w = instanceMatrix * vec4(p, 1.0);
          if (aTd.x > 1.5) {   // falling: a billboard facing the camera
            vec3 c = instanceMatrix[3].xyz; float s = length(instanceMatrix[0].xyz); vec3 rgt = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
            w = vec4(c + (rgt * p.x - up * p.z) * s, 1.0); }
          vWP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: E.COMMON + /* glsl */`varying vec2 vUv2; varying vec4 vTd; varying vec3 vWP;
        void main(){ vec2 q = vUv2 * 2.0; float a = vTd.y; if (a <= 0.0) discard;
          if (vTd.x < 0.5) {   // a ripple ring on the water
            float r = length(q), ring = smoothstep(0.1, 0.0, abs(r - 0.82)) + 0.5 * smoothstep(0.08, 0.0, abs(r - 0.5));
            if (ring < 0.02) discard; gl_FragColor = vec4(vec3(0.86, 0.96, 1.0), ring * a * 0.8); return; }
          // a tadpole: a dark comma (head and a wriggling tail); falling ones sit in a little drop
          float wig = sin(q.y * 6.0 + vTd.z * 30.0) * 0.12 * (q.y < 0.0 ? -q.y : 0.0);
          float head = length((q - vec2(0.0, 0.32)) / vec2(0.34, 0.42)), tail = abs(q.x - wig) - 0.09 * (1.0 + q.y);
          float body = min(head - 1.0, max(tail, max(q.y - 0.3, -q.y - 0.95)) * 6.0);
          vec4 c = vec4(0.0);
          if (vTd.x > 1.5) { float d = length(q * vec2(1.0, 0.9)); if (d < 1.0) c = vec4(mix(vec3(0.75, 0.94, 1.0), vec3(0.37, 0.78, 0.88), smoothstep(0.7, 1.0, d)), 0.45);
            c.rgb += smoothstep(0.25, 0.1, length(q - vec2(-0.4, 0.45))) * 0.8; c.a = max(c.a, smoothstep(0.25, 0.1, length(q - vec2(-0.4, 0.45)))); }
          if (body < 0.0) c = vTd.x > 1.5 ? vec4(vec3(0.16, 0.13, 0.2), 1.0) : vec4(vec3(0.1, 0.2, 0.26), 1.0);
          if (c.a < 0.01) discard; gl_FragColor = vec4(c.rgb, c.a * a); }` });
    const m = new THREE.InstancedMesh(g, mat, n); m.frustumCulled = false; m.renderOrder = 3; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); built.tad = m;
  }
  function updateTadpoles(t) {
    if (!built.tad) return; const m = built.tad, ta = built.tadA.array, h = A.held(t);
    plops.forEach((pl, i) => { const c = V.cisterns[pl.c], wy = waterY(c, pl.c, t), R0 = .38 * c.size;
      // the tadpole: falls in its drop for 0.7 s on ones (about 1.45 m on the heavy-drop curve, EV.fall), then swims in
      // circles at the water line on held time (drawn just above the water plane, in a dark water colour)
      const tau = t - pl.t; let kind = 1, a = 0, s = .03, x = c.pos[0] + Math.cos(pl.a) * R0 * .5, z = c.pos[2] + Math.sin(pl.a) * R0 * .5, y = wy - .025, yaw = pl.a;
      if (tau < -.7) a = 0;
      else if (tau < 0) { kind = 2; a = 1; s = .06; y = wy + EV.fall(.7, 0) - EV.fall(tau + .7, 0); }
      else { a = sm(0, .3, tau) * .7; y = wy + .005; const sw = h - pl.t, ang = pl.a + sw * (.8 + pl.seed); x = c.pos[0] + Math.cos(ang) * R0 * (.45 + .25 * Math.sin(sw * .7 + pl.seed * 5)); z = c.pos[2] + Math.sin(ang) * R0 * (.45 + .25 * Math.sin(sw * .7 + pl.seed * 5)); yaw = -ang; }
      dum.position.set(x, y, z); dum.rotation.set(0, yaw, 0); dum.scale.setScalar(s); dum.updateMatrix(); m.setMatrixAt(i * 2, dum.matrix); ta.set([kind, a, pl.seed, 0], i * 8);
      // its ripple: grows from 6 cm to about 56 cm across over 0.9 s after the plop, fading as it goes
      const rk = tau > 0 && tau < .9 ? tau / .9 : -1; dum.position.set(c.pos[0] + Math.cos(pl.a) * R0 * .5, wy + .004, c.pos[2] + Math.sin(pl.a) * R0 * .5); dum.rotation.set(0, 0, 0); dum.scale.setScalar(.06 + .5 * Math.sqrt(Math.max(rk, 0)));
      dum.updateMatrix(); m.setMatrixAt(i * 2 + 1, dum.matrix); ta.set([0, rk > 0 ? 1 - rk : 0, pl.seed, 0], i * 8 + 4); });
    m.instanceMatrix.needsUpdate = true; built.tadA.needsUpdate = true; }

  // ================================================================== mist beads: through the rain module, or drawn here as points
  // FILM.life.beads(list) is how other modules (the chimewings here, the laughter drizzle in crowd.js) hang extra mist beads:
  // { p: [x, y, z], band: 2, size (m), seed, ts (appears), tr (lets go), until (gone) }.
  const beadList = [];
  L.beads = list => { if (F.rain && F.rain.addBeads) F.rain.addBeads(list); else for (const b of list) beadList.push(b); };
  // the stand-in when rain.js is missing: one additive point per bead, aB = (ts, tr, until, seed). It falls on the mist curve
  // after tr (fallDist, band 2), flashes warm for 0.2 s as it lets go and twinkles on the held clock. The point size comes from
  // a 6 cm glow at its depth (taking tan(fov / 2) as about 0.4), kept between 1.2 and 4 px.
  function buildBeadPoints(scene) {
    const n = beadList.length; if (!n) return; const p = new Float32Array(n * 3), a = new Float32Array(n * 4);
    beadList.forEach((b, i) => { p.set(b.p, i * 3); a.set([b.ts ?? -1, b.tr ?? 1e9, b.until ?? 1e9, b.seed ?? .5], i * 4); });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aB', new THREE.BufferAttribute(a, 4));
    const mat = new THREE.ShaderMaterial({ uniforms: Object.assign({}, F.U), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: E.COMMON + EV.GLSL + /* glsl */`attribute vec4 aB; varying float vA; varying float vF;
        void main(){ float t = uTime; vA = 0.0; vF = 0.0; vec3 p = position;
          if (t < aB.x || t > aB.z) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float tau = t - aB.y; p.y -= fallDist(tau, 2.0); vF = tau > 0.0 && tau < 0.2 ? 1.0 - tau / 0.2 : 0.0;
          vA = smoothstep(aB.x, aB.x + 0.1, t) * (1.0 - smoothstep(aB.z - 1.5, aB.z, t)) * (0.6 + 0.4 * sin(uHeld * 9.0 + aB.w * 40.0));
          vec4 mv = viewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(0.06 / -mv.z * uRes.y / (2.0 * 0.4), 1.2, 4.0); }`,
      fragmentShader: /* glsl */`varying float vA; varying float vF; void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; float d = length(q); if (d > 1.0 || vA <= 0.0) discard;
          gl_FragColor = vec4(mix(vec3(0.75, 0.95, 1.0), vec3(1.0, 0.95, 0.78), vF) * (1.0 - d * d) * vA * 0.75, 1.0); }` });
    const m = new THREE.Points(g, mat); m.frustumCulled = false; m.renderOrder = 4; scene.add(m); built.beadPts = m;
  }

  // ================================================================== stand-ins when world.js / rain.js are missing (test builds only)
  function buildStandIns(scene) {
    if (!F.world) {   // Cistern Row's cisterns (the same lathe as world.js) with water
      const prof = [[0, 0], [.6, 0], [.68, .06], [.76, .3], [.79, .6], [.76, .9], [.67, 1.13], [.57, 1.32], [.52, 1.44], [.56, 1.5], [.61, 1.54], [.59, 1.58], [.5, 1.57], [.47, 1.5], [.45, 1.0]].map(q => new THREE.Vector2(q[0], q[1]));
      const lg = new THREE.LatheGeometry(prof, 22), wg = new THREE.CircleGeometry(.5, 20); wg.rotateX(-Math.PI / 2);
      const cm1 = E.toon({ color: '#B9714A', paint: .2, rim: .25 }), wm = E.toon({ color: '#3E8FA8', paint: .05, rim: 0 });
      V.cisterns.forEach((c, i) => { const m = E.mesh(lg, cm1, { line: { color: '#4A2418', px: 1.6, max: .02 } }); m.position.set(c.pos[0], c.pos[1] - .05, c.pos[2]); m.scale.setScalar(c.size); scene.add(m);
        const w = new THREE.Mesh(wg, wm); w.position.set(c.pos[0], waterY(c, i, 0), c.pos[2]); w.scale.setScalar(c.size); w.userData.ci = i; scene.add(w); (built.standWater = built.standWater || []).push(w); }); }
    if (!F.rain) {   // the frog's drop: hangs, trembles while the croak holds (M6), lets go and falls into the open mouth
      const m = new THREE.Mesh(new THREE.SphereGeometry(SP.frog.r, 20, 14), E.toon({ color: '#BFEFFF', rim: .8, paint: 0, emit: '#203a48',
        fpost: 'vec3 Hh = normalize(uSunDir + V); c += vec3(1.0) * smoothstep(0.96, 0.975, dot(N, Hh)) * 1.5; c = mix(c, vec3(0.37, 0.78, 0.88), smoothstep(0.55, 0.75, 1.0 - max(dot(N, V), 0.0)));' }));
      m.castShadow = false; scene.add(m); built.standDrop = m; }
  }
  // the stand-in drop: it trembles from when the croak reaches it until it lets go (M6, growing as k^2 over the 1.5 s hold),
  // falls on the heavy-drop curve stretched 1.25x, and hides one frame (1/24 s) after it lands in the mouth
  function updateStandIns(t) {
    if (built.standWater) built.standWater.forEach(w => { const c = V.cisterns[w.userData.ci]; w.position.y = waterY(c, w.userData.ci, t); });
    if (built.standDrop) { const d = built.standDrop, p = SP.frog.pos, arr = 14.25 + Math.hypot(p[0] - P.frog[0], p[1] - P.frog[1] - .1, p[2] - P.frog[2]) / EV.C_SOUND;
      const tr = FROG_TR, tau = t - tr; let y = p[1], ox = 0;
      if (t > arr && tau < 0) { const k = (t - arr) / EV.HOLD; ox = .03 * SP.frog.r * 10 * k * k * Math.sin(TAU * 16 * t) * .3; }
      if (tau > 0) y -= EV.fall(tau, 0);
      d.position.set(p[0] + ox, y, p[2]); d.visible = t < FROG_LAND + 1 / 24; d.scale.set(1, tau > 0 ? 1.25 : 1, 1); }
  }

  // ================================================================== module
  Object.assign(L, {
    steps(scene) { return [
      ['잎과 갈대를 심는 중', () => { buildLeaves(scene); buildReeds(scene); buildSprouts(scene); }],
      ['개구리를 빚는 중', () => buildFrogs(scene)],
      ['새와 나방을 풀어 놓는 중', () => { buildBirds(scene); buildMoths(scene); buildTadpoles(scene); L.beads(birdBeads()); buildStandIns(scene); }],
    ]; },
    // after every module has built: the vines and snails need the rain's strands; stand-in beads gather what was registered
    finalize(scene) { buildVines(scene); buildSnails(scene); if (!F.rain) buildBeadPoints(scene); },
    // creatures are posed once per drawing (12 a second); falling tadpoles, snails riding falling beads and the stand-in drop move on ones
    update(t, dt, cam) { const h = A.held(t); if (h !== built.lastH) { built.lastH = h; updateFrogs(t); updateBirds(t, cam); updateMoths(t); }
      updateTadpoles(t); updateSnails(t); updateStandIns(t); },
    // ---- public queries (for shots, the synth and other modules)
    frogs, frogPose: (i, t) => frogPose(frogs[i], A.held(t)), FROG_TR, FROG_LAND,
    bird: (i, t) => birdPos(i, t), birdRing: ringOf, NB, FLOCK_A,
    beds, leaves, wetTime, plops, moths, snails,
    counts: () => ({ leaves: leaves.length, reeds: reeds.length, sprouts: sprouts.length, vines: built.vineGuides ? built.vineGuides.length : 0, frogs: frogs.length, snails: snails.length, birds: NB, moths: moths.length, plops: plops.length, standInBeads: beadList.length }),
    get meshes() { return built; },
  });

  // ------------------------------------------------------------------ test views
  // FILM.test.NAME(k, s) -> { cam, look }; node tools/shot.mjs --test NAME --k 0,1,2 puts the moments on one sheet.
  // each k is a moment (its own film time + camera); the view re-poses every module at that time (other k: the sheet's time s.t)
  const at = tk => { F.U.uTime.value = tk; F.U.uHeld.value = A.held(tk); for (const m of ['world', 'life', 'rain', 'cast', 'crowd']) { const M = F[m]; if (M && M.update) try { M.update(tk, 1 / 60, F.three && F.three.cam); } catch (e) { } } return tk; };
  F.test = F.test || {};
  // the leaf bed under the toll terrace: at rest, turned to Dun's drum, and full of water with sprouts and vines in the flood
  F.test.leaves = (k, s) => { const tk = at([26.5, 28.5, 77][k] ?? s.t), C = F.cam, th = V.places.tollTerrace.th + .03;
    const bedP = polar(th, V.ringR(8, th) - 1.1), camP = polar(th - .012, V.ringR(8, th) + 2.2);
    E.shadowFit(new THREE.Vector3(...bedP), 14);
    return { cam: { pos: add(camP, [0, 1.35, 0]), look: add(bedP, [0, .2, 0]), fov: C.mm(55) }, look: { focus: 4.4, ap: .004, live: 1, bloom: .45 } }; };
  // the hero frog on its cistern: before, swelling, the catch, content
  F.test.frog = (k, s) => { const tk = at([14.0, 15.2, 16.15, 16.4][k] ?? s.t), C = F.cam, f = frogs[0], c = add(f.pos, [0, .2, 0]);
    const y = f.yaw + .75; E.shadowFit(new THREE.Vector3(...c), 3);
    return { cam: { pos: add(c, [Math.sin(y) * 1.05, -.1, Math.cos(y) * 1.05]), look: c, fov: C.mm(50), near: .02 }, look: { focus: 1.05, ap: .008, live: 1 } }; };
  // the chimewings: crossing the valley (9.5) and scattering in the gust (37)
  F.test.birds = (k, s) => { const tk = at([9.5, 37][k] ?? s.t), C = F.cam; let cx = 0, cy = 0, cz = 0, n = 0; const q = [0, 0, 0];
    for (let i = 0; i < 40; i++) if (birdPos(i, tk, q)) { cx += q[0]; cy += q[1]; cz += q[2]; n++; } const c = [cx / n, cy / n, cz / n];
    const back = k === 0 ? [-6, -1.6, 4.5] : [-30, -12, 8]; E.shadowFit(new THREE.Vector3(...c), 60);
    return { cam: { pos: add(c, back), look: add(c, [0, -2, 0]), fov: C.mm(28) }, look: { live: 1, rays: .25, bloom: .45, speed: k === 1 ? .3 : 0, speedMode: 1 } }; };
  // the smallest life: a hushmoth at Pell's roof (20.4), the open mouth (one drawing before the drop lands), sprouts popping
  // under the toll terrace (77.3), the first snail (14.5)
  F.test.small = (k, s) => { const C = F.cam;
    if (k === 0) { at(20.4); const m = moths[12], q = mothAt(m, A.held(20.4), [0, 0, 0]); E.shadowFit(new THREE.Vector3(...q), 6);
      return { cam: { pos: add(q, [1.6, .3, 1.4]), look: q, fov: C.mm(50) }, look: { focus: 2.1, ap: .006, live: 1 } }; }
    if (k === 1) { at(FROG_LAND - 1 / 12); const f = frogs[0], c = add(f.pos, [0, .07, 0]), y = f.yaw + .4; E.shadowFit(new THREE.Vector3(...c), 2);
      return { cam: { pos: add(c, [Math.sin(y) * .42, .12, Math.cos(y) * .42]), look: add(c, [0, .03, 0]), fov: C.mm(50), near: .02 }, look: { focus: .42, ap: .01, live: 1 } }; }
    if (k === 2) { at(77.3); const th = V.places.tollTerrace.th + .03, c = polar(th, V.ringR(8, th) - 3.6); E.shadowFit(new THREE.Vector3(...c), 8);
      return { cam: { pos: add(c, [-1.4, .55, 1.0]), look: add(c, [.6, .05, -.3]), fov: C.mm(40) }, look: { focus: 1.8, ap: .006, live: 1 } }; }
    at(14.5); const sn = snails[0], c = sn.fixed || (F.rain ? F.rain.beadAt(sn.strand, sn.j, 14.5).p : [0, 0, 0]); E.shadowFit(new THREE.Vector3(...c), 3);
    return { cam: { pos: add(c, [.25, .08, .3]), look: c, fov: C.mm(50), near: .01 }, look: { focus: .4, ap: .015, live: 1 } }; };
  // tadpoles plopping into a cistern
  F.test.tadpoles = (k, s) => { const tk = at([33.62, 77.1][k] ?? s.t), C = F.cam, c = V.cisterns[k === 0 ? 3 : 1], top = add(c.pos, [0, 1.5 * c.size, 0]);
    E.shadowFit(new THREE.Vector3(...top), 3);
    return { cam: { pos: add(top, [.9, 1.1, 1.4]), look: add(top, [0, -.1, 0]), fov: C.mm(50), near: .05 }, look: { live: 1 } }; };
})();
