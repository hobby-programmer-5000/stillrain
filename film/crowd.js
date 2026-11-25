// crowd.js - the people of Hollowmere (FILM.crowd): eighty felt-hooded villagers (the three fan teams and two more cloth
// bearers, the six Listeners on the rim, the sixteen of Cistern Row, thirty-eight round the houses) and the hush-cloth that
// catches Pell.
//
// Every villager is one instance of a single merged felt doll (robe, head, hood with a dark lining and a capelet, drip-brim,
// tassels, a string of glass beads, sleeves with mittens, boots, and three props that fold away when not carried: the 3 m fan
// paddle, the drop-picker's gourd pole and a child's toy bell in its felt sleeve). One InstancedMesh draws them all (81
// instances: the 80 villagers and a stand-in for Pell), with an ink hull and a shadow caster.
//
// Where everyone is and what they do is a pure function of film time: update(t) runs each villager's little script at held
// time (12 drawings a second, "on twos") and writes 16 pose channels per instance. The vertex shader bends the parts with
// them (arms at the shoulder, head at the neck, props at the grip, boots on the gait), squashes and stretches the body, and
// shivers the tassels and beads on ones when a sound front passes the wearer (bible M17), so the sound ring shows on people.
// A script is built up in layers: rest() gives the base pose, then walks and gestures add on top (glance, gSign, gExhale,
// gGust, gLaugh, gStomp, gHold), then the acts the whole village shares (acts(): look up at 25, exhale at 33, the gust at 36,
// hoods east at 39, palms up to the rain at 69). Units: metres, seconds, radians.
//
//   FILM.crowd.pose(i, t)        the pose object of villager i at film time t (what update writes)
//   FILM.crowd.people            the cast list: { role, group, kid, prop, robe, hood, felt, scale, seed, ... }
//   FILM.crowd.laughs            every laugh [{ i, t0, dur, head:[x,y,z], kid }] (for the synth); each laugh also shakes 40
//                                afterhang mist beads down from 2.2 m above the head (M13), registered at build time with
//                                FILM.life.beads / FILM.rain.addBeads
//   FILM.crowd.stomps            every puddle stomp [{ t, pos, i }] (splashes and felt thumps)
//   FILM.crowd.cloth(t)          the hush-cloth's state { c, R, dip, sag, billow, dir, dx, dz, lowered, vis }
//   FILM.crowd.head(i, t)        where villager i's head is (for emitters); also N, mesh, clothMesh
//   FILM.crowd.standIn           true -> draw a persimmon-hooded stand-in for Pell when cast.js is missing (test views)
// Reads: FILM.anim, engine (toon, outline, COMMON), valley (terraces, houses, places), path (fans, pell, dun, cloth, kid,
// frog, fieldC), events (the toll table, for the tassel meter), life.beads or rain.addBeads. Korean doc: film/LIFE.md.
// Test views: node tools/shot.mjs --test crowd --k 0,1,2,3 --cols 2 (13.6, 27.3, 39.4, 84.2)
//             node tools/shot.mjs --test cloth --k 0,1,2 --cols 3 (72.9, 73.15, 73.5)
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim, E = F.engine, V = F.valley, P = F.path, EV = F.events;
  const { clamp, lerp, sm, keys, TAU } = A;
  const ez = A.ease;
  const ramp = (x, a, b, e = 'io') => ez[e](clamp((x - a) / (b - a)));       // 0 -> 1 as x goes a -> b, eased
  const yawTo = P.yawTo, add = P.add;
  const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));                    // an angle into -pi..pi
  const lerpA = (a, b, k) => a + wrapA(b - a) * k;                           // turn from a toward b the short way round
  // a point on terrace 9 / 6 at angle th; u runs across it from the inner lip (0) to the foot of the next wall (1)
  const T9 = (th, u) => V.onTerrace(9, th, u), T6 = (th, u) => V.onTerrace(6, th, u);
  const onG = (x, z) => [x, V.ground(x, z), z];

  // ---------------------------------------------------------------- palette (bible §3 Supporting life)
  const FELT = { ochre: '#C98B2E', indigo: '#2F3E7A', moss: '#6F8A4A', oat: '#CDB892', rust: '#9E4E2E', plum: '#5B4A72', slate: '#4C6B7A', persimmon: '#E4572E' };
  const FELT_I = Object.keys(FELT);
  // the shader's felt table uFelt[10]: the eight felts above, padded with white. A villager's felts are packed as robe * 16 + hood.
  const FELT_U = { value: Object.values(FELT).map(h => new THREE.Color(h)).concat([new THREE.Color('#ffffff'), new THREE.Color('#ffffff')]) };

  // ---------------------------------------------------------------- the doll template
  // parts: 0 robe, 1 head, 2 hood, 3 brim, 4 tassel, 5 bead, 6 arm L, 7 arm R, 8 boot L, 9 boot R, 10 paddle, 11 gourd pole, 12 toy bell
  // paint: 0 its own colour, 1 robe felt (instance colour A), 2 hood felt (instance colour B)
  // The doll faces +z, feet at the origin. Its left is +x. The doll is about 1.4 m tall to the hood's tip, times its scale.
  // Pivots (m): the neck, the left and right shoulders, and where the hands hold a prop.
  const NECK = [0, .99, .01], SH_L = [.165, .86, 0], SH_R = [-.165, .86, 0], GRIP = [0, .74, .27];
  // tag one part's geometry for the merge: a flat vertex colour and aPiv = (pivot xyz, part * 4 + paint); index it if it is not
  function prep(g, part, paint, col, piv = [0, 0, 0]) {
    if (g.attributes.uv) g.deleteAttribute('uv');
    if (!g.index) { const n = g.attributes.position.count, ix = []; for (let i = 0; i < n; i++) ix.push(i); g.setIndex(ix); }
    const n = g.attributes.position.count, c = new THREE.Color(col), C = new Float32Array(n * 3), Pv = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { C[i * 3] = c.r; C[i * 3 + 1] = c.g; C[i * 3 + 2] = c.b; Pv[i * 4] = piv[0]; Pv[i * 4 + 1] = piv[1]; Pv[i * 4 + 2] = piv[2]; Pv[i * 4 + 3] = part * 4 + paint; }
    g.setAttribute('color', new THREE.BufferAttribute(C, 3)); g.setAttribute('aPiv', new THREE.BufferAttribute(Pv, 4));
    return g;
  }
  // concatenate the tagged parts into one indexed geometry (32-bit indices if it needs them)
  function merge(list) {
    const names = ['position', 'normal', 'color', 'aPiv']; let nv = 0, ni = 0; list.forEach(g => { nv += g.attributes.position.count; ni += g.index.count; });
    const out = new THREE.BufferGeometry(), arrs = {}; names.forEach(k => arrs[k] = new Float32Array(nv * list[0].attributes[k].itemSize));
    const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(ni); let vo = 0, io = 0;
    for (const g of list) { const n = g.attributes.position.count; names.forEach(k => { const a = g.attributes[k]; arrs[k].set(a.array.subarray ? a.array.subarray(0, n * a.itemSize) : a.array, vo * a.itemSize); });
      const gi = g.index.array; for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo; vo += n; io += gi.length; }
    names.forEach(k => out.setAttribute(k, new THREE.BufferAttribute(arrs[k], list[0].attributes[k].itemSize))); out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  }
  const lathe = (pts, seg) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  const M4 = () => new THREE.Matrix4();
  function buildDoll() {
    const parts = [];
    // robe: a quilted felt bell with round shoulders
    parts.push(prep(lathe([[.001, .06], [.25, .06], [.296, .1], [.29, .2], [.264, .4], [.238, .58], [.216, .72], [.192, .84], [.15, .93], [.09, .985], [.001, 1.0]], 20), 0, 1, '#ffffff'));
    // head (the face is painted in the fragment shader: dot eyes for children, brim shadow for adults)
    { const g = new THREE.SphereGeometry(.14, 16, 12); g.translate(0, 1.055, .035); parts.push(prep(g, 1, 0, '#F2D3B6')); }
    // hood: a soft cone whose tip droops back
    { const g = lathe([[.176, .985], [.2, 1.06], [.198, 1.14], [.172, 1.23], [.128, 1.31], [.08, 1.37], [.04, 1.41], [.012, 1.435], [.001, 1.44]], 18);
      const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const k = clamp((p.getY(i) - 1.1) / .34); p.setZ(i, p.getZ(i) - .2 * k * k * k + .01); p.setY(i, p.getY(i) - .07 * k * k * k); }
      g.computeVertexNormals(); parts.push(prep(g, 2, 2, '#ffffff'));
      // its dark felt lining, seen round the face through the opening (the front of the hood is cut away in the fragment shader)
      const ln = g.clone(); const q = ln.attributes.position; for (let i = 0; i < q.count; i++) { q.setX(i, q.getX(i) * .955); q.setZ(i, (q.getZ(i) - .01) * .955 + .01); }
      const ix = ln.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i]; ix[i] = ix[i + 2]; ix[i + 2] = t; } ln.computeVertexNormals(); parts.push(prep(ln, 2, 0, '#3B2C4E')); }
    // the capelet: the hood's felt flares over the shoulders, so hood and body read as one shape
    { const g = lathe([[.25, .745], [.276, .76], [.272, .815], [.232, .895], [.17, .955], [.105, .995]], 20); g.translate(0, 0, .005); parts.push(prep(g, 0, 2, '#f2eef2')); }
    // the wide drip-brim: a flattened ring that droops at its edge
    { const g = new THREE.TorusGeometry(.205, .066, 6, 30); g.rotateX(Math.PI / 2); g.scale(1, .34, 1);
      const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z); p.setY(i, p.getY(i) - .085 * clamp((r - .16) / .12) ** 1.6 * (1 - .8 * Math.max(0, z / r))); }
      g.translate(0, 1.13, .03); g.computeVertexNormals(); parts.push(prep(g, 3, 2, '#d8d2dc')); }
    // three felt tassels on the brim (they swing about their knot: aPiv)
    for (const a of [1.0, -1.0, Math.PI]) { const q = [Math.sin(a) * .262, 1.07 - .05 * (1 - Math.cos(a)) / 2, Math.cos(a) * .262 + .03];
      const s = new THREE.CylinderGeometry(.011, .008, .075, 5); s.translate(q[0], q[1] - .037, q[2]); parts.push(prep(s, 4, 1, '#ffffff', q));
      const b = new THREE.SphereGeometry(.026, 8, 6); b.scale(1, 1.25, 1); b.translate(q[0], q[1] - .09, q[2]); parts.push(prep(b, 4, 1, '#ffffff', q)); }
    // the string of five glass beads across the front of the brim (the meter)
    for (let i = 0; i < 5; i++) { const a = Math.PI - .75 + 1.5 * i / 4, q = [Math.sin(a) * .268, 1.06, Math.cos(a) * .268 + .03];
      const b = new THREE.SphereGeometry(.011, 7, 5); b.translate(q[0], q[1] - .018 - .014 * Math.cos(a * 2.2), q[2]); parts.push(prep(b, 5, 0, '#BFEFFF', q)); }
    // sleeves and mittens
    for (const L of [true, false]) { const s = L ? 1 : -1, S = L ? SH_L : SH_R, tilt = .13 * s;
      const m = M4().makeRotationZ(tilt).premultiply(M4().makeTranslation(...S));
      const c = new THREE.CylinderGeometry(.05, .062, .31, 9, 1); c.translate(0, -.155, 0); c.applyMatrix4(m); parts.push(prep(c, L ? 6 : 7, 1, '#ffffff', S));
      const mt = new THREE.SphereGeometry(.062, 10, 8); mt.scale(1, .92, 1.12); mt.translate(0, -.33, .012); mt.applyMatrix4(m); parts.push(prep(mt, L ? 6 : 7, 2, '#ffffff', S)); }
    // boots
    for (const L of [true, false]) { const g = new THREE.SphereGeometry(.07, 10, 6); g.scale(.95, .62, 1.45); g.translate(L ? .09 : -.09, .035, .06); parts.push(prep(g, L ? 8 : 9, 0, '#5B4636', [L ? .09 : -.09, .035, .06])); }
    // the fan paddle: grip at the origin, pole up +y, felt blade at the top (blade faces +-x once twisted)
    { const p = new THREE.CylinderGeometry(.022, .027, 3.0, 6); p.translate(0, 1.15, 0); parts.push(prep(p, 10, 0, '#A07A52'));
      const b = new THREE.CylinderGeometry(.56, .56, .06, 28, 1); b.rotateX(Math.PI / 2); b.scale(1, 1.08, 1); b.translate(0, 2.12, 0); parts.push(prep(b, 10, 2, '#ffffff'));
      const rim = new THREE.TorusGeometry(.565, .035, 5, 30); rim.scale(1, 1.08, 1); rim.translate(0, 2.12, 0); parts.push(prep(rim, 10, 0, '#6B4A35')); }
    // the gourd pole with its hook and a hanging gourd
    { const p = new THREE.CylinderGeometry(.016, .02, 2.55, 6); p.translate(0, .97, 0); parts.push(prep(p, 11, 0, '#A07A52'));
      const h = new THREE.TorusGeometry(.07, .013, 5, 10, Math.PI * 1.2); h.rotateY(Math.PI / 2); h.translate(0, 2.27, .07); parts.push(prep(h, 11, 0, '#7A5A3A'));
      const g1 = new THREE.SphereGeometry(.078, 10, 8); g1.translate(0, 1.98, .15); parts.push(prep(g1, 11, 0, '#D9A94E'));
      const g2 = new THREE.SphereGeometry(.052, 9, 7); g2.translate(0, 2.085, .15); parts.push(prep(g2, 11, 0, '#D9A94E')); }
    // the toy bell, hanging from the right mitten on a short string, inside a little felt sleeve
    { const mR = [-.205, .53, .015], piv = mR;
      const st = new THREE.CylinderGeometry(.004, .004, .05, 3); st.translate(mR[0], mR[1] - .06, mR[2]); parts.push(prep(st, 12, 1, '#2a2030', piv));
      const sl = lathe([[.001, .0], [.036, .004], [.04, .03], [.034, .06], [.02, .075], [.001, .08]], 9); sl.rotateX(Math.PI); sl.translate(mR[0], mR[1] - .085, mR[2]); parts.push(prep(sl, 12, 1, '#ffffff', piv));
      const bl = lathe([[.001, 0], [.032, .0], [.035, .012], [.029, .032], [.017, .052], [.001, .06]], 10); bl.translate(mR[0], mR[1] - .15, mR[2]); parts.push(prep(bl, 12, 0, '#E2AE3E', piv)); }
    return merge(parts);
  }

  // ---------------------------------------------------------------- the pose in the vertex shader
  // crowdPose() moves one doll vertex: first the unused props fold away, then the part turns about its own pivot (the head
  // group at the neck, arms at the shoulders, boots on the gait, props at the grip), then the whole body squashes (volume
  // kept), leans and rolls about the hip and bobs. The shadow caster and the ink hull run the same function.
  const GL = /* glsl */`
attribute vec4 aPiv; attribute vec4 aKind; uniform vec3 uFelt[10];
attribute vec4 aPose0; attribute vec4 aPose1; attribute vec4 aPose2; attribute vec4 aPose3;
mat3 rX(float a){ float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rY(float a){ float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rZ(float a){ float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
// aPose0: arm L pitch (forward), arm L raise, arm R pitch, arm R raise
// aPose1: lean (forward), side roll, head pitch (up), head yaw (to its left)
// aPose2: bob (m), squash (1 = rest), prop pitch | bell swing, prop roll | bell slip
// aPose3: gait phase, gait amount (>1 lifts high: stomps), time the last sound front passed (tassel meter), prop twist
// aKind:  child (0/1), prop (0 none, 1 paddle, 2 gourd, 3 toy bell), seed, robe felt * 16 + hood felt (indices into uFelt)
// aPiv:   xyz the knot a tassel or bell swings about, w = part * 4 + paint
void crowdPose(vec3 p0, vec3 n0, out vec3 p, out vec3 n){
  float part = floor(aPiv.w / 4.0 + 0.01), paint = aPiv.w - part * 4.0, kid = aKind.x, prop = aKind.y; p = p0; n = n0;
  // props this villager does not carry fold away to nothing
  if (part > 9.5 && abs(prop - (part - 9.0)) > 0.1) { p = vec3(0.0, 0.6, 0.0); n = vec3(0.0, 1.0, 0.0); return; }
  // the hood's inward-facing lining gets no ink hull (its hull would sit in front of the face)
  if (uLinePx > 0.0 && abs(part - 2.0) < 0.1 && paint < 0.5) { p = vec3(0.0, 0.6, 0.0); n = vec3(0.0, 1.0, 0.0); return; }
  // children: a shorter body and a bigger head (on top of their smaller instance scale)
  float bodyS = 1.0 - 0.16 * kid, headS = 1.0 + 0.36 * kid;
  vec3 NECK = vec3(${NECK.join(', ')});
  if (part > 0.5 && part < 5.5) {   // the head group: head, hood, brim, tassels, beads
    // tassels and beads: a quick shiver when a front passes (on ones), and a bounce on the gait.
    // The shiver is 0.85 e^(-6.5 tau) sin(2 pi 11 tau) rad, tau = seconds since the front passed (aPose3.z)
    if (part > 3.5) {
      float tau = uTime - aPose3.z; float sh = (tau > 0.0 && tau < 1.0) ? 0.85 * exp(-6.5 * tau) * sin(6.2832 * 11.0 * tau) : 0.0;
      float sw = sh + 0.22 * aPose3.y * sin(aPose3.x * 2.0 - 0.8) + 0.04 * sin(uHeld * 2.3 + aKind.z * 30.0);
      mat3 T = rX(sw) * rZ(sh * 0.7); p = aPiv.xyz + T * (p - aPiv.xyz); n = T * n; }
    if (abs(part - 3.0) < 0.1 || part > 3.5) { vec3 c = vec3(0.0, 1.13, 0.03); vec3 q = p - c; q.xz *= 1.0 - 0.2 * kid; q.y += 0.03 * kid * q.z / 0.25; p = c + q; }   // children: a smaller brim, tipped up
    // the head turns (yaw) and nods (pitch) at the neck
    mat3 H = rY(aPose1.w) * rX(-aPose1.z);
    p = NECK * vec3(1.0, bodyS, 1.0) + H * ((p - NECK) * headS); n = H * n;
  } else if ((part > 5.5 && part < 7.5) || part > 11.5) {   // the arms, and the toy bell hanging from the right mitten
    bool L = part < 6.5; vec3 S = L ? vec3(${SH_L.join(', ')}) : vec3(${SH_R.join(', ')});
    vec2 a = L ? aPose0.xy : aPose0.zw;
    if (part > 11.5) {   // the toy bell swings from the mitten; 'slip' drops it out of its felt sleeve
      vec3 q = p - aPiv.xyz; if (paint < 0.5) q.y -= aPose2.w * 0.07; mat3 B = rX(aPose2.z) * rZ(aPose2.z * 0.35); p = aPiv.xyz + B * q; n = B * n; }
    // the arm swings forward (pitch) and out to its side (raise) at the shoulder
    mat3 Rm = rX(-a.x) * rZ(L ? a.y : -a.y);
    p = S * vec3(1.0, bodyS, 1.0) + Rm * (p - S); n = Rm * n;
  } else if (part > 7.5 && part < 9.5) {
    // boots, half a cycle apart: a 12 cm stride and a lift (6 cm x amount^2, so stomps lift high). They skip the body's
    // squash, lean and bob below, so the feet stay planted; they only sink a little when the body crouches.
    float ph = aPose3.x + (part < 8.5 ? 0.0 : 3.14159), g = aPose3.y;
    p.z += 0.12 * min(g, 1.2) * sin(ph); p.y += 0.06 * g * g * max(0.0, cos(ph));
    p.y += min(aPose2.x, 0.0) * 0.3;
    return;
  } else if (part > 9.5) {   // the paddle or the gourd pole, held at the grip: twisted about its own pole, then rolled, then pitched
    mat3 Rp = rX(aPose2.z) * rZ(aPose2.w) * rY(aPose3.w);
    p = vec3(${GRIP.join(', ')}) * vec3(1.0, bodyS, 1.0) + Rp * p; n = Rp * n;
  } else { p.y *= bodyS; }   // the robe
  // the whole body: squash and stretch with the volume kept, lean and roll about the hip (0.26 m up), then the bob
  float sq = aPose2.y; p.xz *= inversesqrt(max(sq, 0.3)); p.y *= sq;
  mat3 Lb = rZ(aPose1.y) * rX(aPose1.x); vec3 HIP = vec3(0.0, 0.26, 0.0);
  p = HIP + Lb * (p - HIP); n = Lb * n;
  p.y += aPose2.x;
}`;

  // ---------------------------------------------------------------- the cast list
  const N_STANDIN = 1;
  const people = [];   // static: role, group, kid, prop, robe, hood, felt, scale, seed, i, and script data
  const R = A.named('crowd');   // the crowd's own random stream: the same village on every load
  const pick = arr => arr[Math.floor(R() * arr.length) % arr.length];
  // felt choices, weighted by repetition (indigo robes are the most common)
  const ROBES = ['indigo', 'indigo', 'indigo', 'oat', 'moss', 'rust', 'ochre', 'slate'], HOODS = ['ochre', 'moss', 'rust', 'indigo', 'oat', 'plum', 'ochre', 'moss'];
  // add one villager: a hood the same felt as the robe becomes ochre (or indigo); children are scaled 0.66-0.71, adults 0.98-1.12
  function person(o) { const robe = o.robe || pick(ROBES); let hood = o.hood || pick(HOODS); if (hood === robe) hood = robe === 'ochre' ? 'indigo' : 'ochre';
    const p = Object.assign({ kid: 0, prop: 0, scale: o.kid ? .66 + .05 * R() : .98 + .14 * R(), seed: R(), robe, hood }, o); p.felt = FELT_I.indexOf(robe) * 16 + FELT_I.indexOf(hood); p.i = people.length; people.push(p); return p; }

  // the three fan teams (18) and two more bearers: they carry the hush-cloth later
  const TEAM_HOOD = ['ochre', 'rust', 'moss'];
  for (let i = 0; i < 18; i++) person({ group: 'fan', role: 'fanner', team: Math.floor(i / 6), j: i % 6, fan: i, prop: 1, robe: pick(['indigo', 'indigo', 'oat', 'slate']), hood: TEAM_HOOD[Math.floor(i / 6)], scale: 1.02 + .1 * R() });
  for (let i = 0; i < 2; i++) person({ group: 'extra', role: 'bearer', fan: 18 + i });
  // the six Listeners on the rim
  for (let i = 0; i < 6; i++) person({ group: 'listen', role: 'listener', j: i, robe: pick(['oat', 'slate', 'indigo']), hood: pick(['indigo', 'plum', 'moss']), scale: .95 + .06 * R() });
  // Cistern Row (terrace 6): who is where at 12-18 (th: angle round the valley, u: across the terrace; tg: when they greet)
  const KID_TH = lerp(V.places.cisternRow.th0, V.places.cisternRow.th1, .62);
  const ROW = [
    { role: 'bellkid', kid: 1, prop: 3, th: KID_TH, u: .4, robe: 'oat', hood: 'moss' },
    { role: 'shush', kid: 1, th: KID_TH - .0068, u: .44, robe: 'rust', hood: 'ochre' },
    { role: 'hopkid', kid: 1, th: KID_TH + .019, u: .36, robe: 'indigo', hood: 'ochre' },
    { role: 'hopkid', kid: 1, th: KID_TH + .025, u: .33, robe: 'moss', hood: 'rust' },
    { role: 'picker', prop: 2, th: KID_TH - .016, u: .63, robe: 'indigo', hood: 'oat' },
    { role: 'greet', th: KID_TH - .03, u: .55, face: 1, tg: 12.25 }, { role: 'greet', th: KID_TH - .0365, u: .56, face: -1, tg: 12.95 },
    { role: 'greet', th: KID_TH + .006, u: .66, face: 1, tg: 14.55 }, { role: 'greet', th: KID_TH + .0128, u: .68, face: -1, tg: 15.25 },
    { role: 'walker', path: [[KID_TH + .0012, .17], [KID_TH + .046, .2]], t: [11.2, 15.6] },
    { role: 'walker', path: [[KID_TH + .03, .95], [KID_TH - .045, .97]], t: [11.5, 19.5] },
    { role: 'carrier', path: [[KID_TH - .07, .7], [KID_TH - .012, .76]], t: [11.0, 18.5] },
    { role: 'keeper', th: KID_TH - .082, u: .86 },
    { role: 'chat', th: KID_TH - .046, u: .9, face: 1 }, { role: 'chat', th: KID_TH - .052, u: .92, face: -1 }, { role: 'chat', th: KID_TH - .049, u: .99, face: 0 },
  ];
  ROW.forEach(r => person(Object.assign({ group: 'row' }, r)));
  // the rest live round the houses on the north slope (terraces 2-8, in a hashed order): 22% are children at play, the
  // adults mostly stroll, some chat, stand idle or carry things
  const HOMES = V.houses.filter(h => !h.hut && !h.pell && h.k >= 2 && h.k <= 8).sort((a, b) => A.hash(a.th, a.k) - A.hash(b.th, b.k));
  for (let i = 0; i < 38; i++) { const h = HOMES[i % HOMES.length], kid = R() < .22 ? 1 : 0, kind = kid ? 'play' : pick(['stroll', 'stroll', 'stroll', 'chat', 'idle', 'carry']);
    person({ group: 'scatter', role: kind, kid, home: h, th: h.th + (R() - .5) * .05 + (i >= HOMES.length ? .045 : 0), u: .14 + .26 * R(), span: .02 + .045 * R(), speed: .9 + .5 * R() }); }
  // the scattered 'chat' villagers get face = 1. scatterLife does not read it: it turns every other one round (by index)
  // so that neighbours face each other.
  people.filter(p => p.group === 'scatter' && p.role === 'chat').forEach(p => { p.face = 1; });
  // a persimmon-hooded stand-in for Pell, drawn only when cast.js is missing (so test views read)
  const STANDIN = person({ group: 'standin', role: 'pell', robe: 'indigo', hood: 'persimmon', scale: .9 });
  const N = people.length;

  // who gathers at the cloth after the catch (72+), and where they stand: Cistern Row (but the keeper) and the first 14 of
  // the scattered villagers who live on terrace 6 or higher or are children (29 people, 10 of them children)
  const CL = P.cloth.pos, CLG = P.cloth.ground;   // the cloth's centre (held taut) and the ground under it
  const thCloth = Math.atan2(CL[2], CL[0]);
  const gather = [];
  { const row = people.filter(p => p.group === 'row' && p.role !== 'keeper'), sc = people.filter(p => p.group === 'scatter' && (p.home.k >= 6 || p.kid));
    row.concat(sc.slice(0, 14)).forEach(p => gather.push(p)); }
  // Their slots. S16 looks east along the crowd to Pell and Dun (its camera runs from about cloth + (-14.6, -5.6) to
  // (-9.1, -2.1)), so the stomping children (KS) and ten laughing adults (AS) flank that path at different depths, as
  // (distance along it, offset to the side) from O toward M, and wipe past as the camera moves; the other adults stand
  // round the east half of the cloth, behind Pell and Dun as the camera sees them.
  { const kids = gather.filter(p => p.kid), adults = gather.filter(p => !p.kid);
    const O = [CL[0] - 13, CL[2] - 4.6], M = [CL[0] - 2.6, CL[2] - .6], fl = Math.hypot(M[0] - O[0], M[1] - O[1]), f = [(M[0] - O[0]) / fl, (M[1] - O[1]) / fl], l = [-f[1], f[0]];
    const along = (d, s) => onG(O[0] + f[0] * d + l[0] * s, O[1] + f[1] * d + l[1] * s);
    const KS = [[4.0, 2.0], [5.2, -2.3], [7.0, 2.7], [8.3, -2.5], [10.6, 3.2], [11.4, -2.9], [6.0, 3.6], [3.0, -3.0]];
    kids.forEach((p, i) => { const s = KS[i % KS.length]; p.slot = along(s[0], s[1]); p.stomper = true; });
    const AS = [[2.4, 3.7], [3.7, -4.3], [6.1, 4.6], [6.7, -4.9], [8.9, 4.4], [9.7, -4.6], [12.6, 4.3], [13.6, -3.9], [-.5, 3.2], [.6, -3.4]];
    adults.forEach((p, i) => { if (i < AS.length) { p.slot = along(AS[i][0] + (A.hash(i, 2) - .5) * .8, AS[i][1] + (A.hash(i, 3) - .5) * .6); return; }
      const a = -1.6 + 3.2 * A.hash(i, 7), r = 6.4 + 3.4 * A.hash(i, 9); p.slot = onG(CL[0] + Math.cos(a) * r, CL[2] + Math.sin(a) * r); }); }
  // At 72 each of them starts 30-60 m north of the cloth along terrace 9 (runFrom: they jump there from wherever their day
  // left them) and runs to the slot at 4.6-6 m/s; arrive is when they get there.
  gather.forEach((p, i) => { p.gather = true; const th0 = thCloth - .17 - .14 * A.hash(i, 3), u0 = .25 + .5 * A.hash(i, 4); p.runFrom = T9(th0, u0);
    p.arrive = 72.2 + Math.hypot(p.slot[0] - p.runFrom[0], p.slot[2] - p.runFrom[2]) / (4.6 + 1.4 * A.hash(i, 5)); });

  // ---------------------------------------------------------------- the hush-cloth
  // RUN0: where the bearers pick it up on terrace 9; CLOTH_R: its radius once spread at P.cloth (3.4 m)
  const RUN0 = { th: -.45, u: .5 }, CLOTH_R = P.cloth.r;
  // the cloth's spot as a u across terrace 9, so the run can go along the terrace from RUN0 to it
  const uCloth = (() => { const th = thCloth, r = Math.hypot(CL[0], CL[2]), a = V.ringR(8, th) + 1.2, b = V.ringR(9, th) - 1.5; return (r - a) / (b - a); })();
  const runS = t => keys(t, [[60, 0], [61.2, .06, 'in'], [68.8, .94, 'lin'], [70, 1, 'out']]);   // the run's progress 0..1, 60-70
  const runC = t => { const s = runS(t); return T9(lerp(RUN0.th, thCloth, s), lerp(RUN0.u, uCloth, s)); };
  // the cloth at time t (the GLSL below turns this into a shape):
  //   < 57      hidden
  //   57-70     carried 1 m up, 2.9 m across in radius and saggy: held still until 60, then run along terrace 9 (bouncing,
  //             billowing), and set down on its spot over 69.5-70.3
  //   70-73     braced: the bearers pull it taut as Pell comes down
  //   73-75     the catch: the middle dips under Pell (dip, centred at dx, dz) and the cloth draws in as it dips
  //   75-76.6   lowered to the ground, opening out, while the dip slides off to one side
  function cloth(t) {
    const o = { c: CL.slice(), R: CLOTH_R, dip: 0, dx: 0, dz: 0, sag: .06, billow: 0, dir: [1, 0], lowered: 0, vis: 1 };
    if (t < 57) { o.vis = 0; return o; }
    if (t < 70) { const c = runC(t), c2 = runC(t + .05); o.c = [c[0], c[1] + 1.02 + (t > 60 ? .035 * Math.abs(Math.sin(t * 7.5)) : 0), c[2]]; o.R = 2.9; o.sag = .16;
      const d = [c2[0] - c[0], c2[2] - c[2]], l = Math.hypot(d[0], d[1]); if (l > 1e-5) o.dir = [d[0] / l, d[1] / l]; else o.dir = [Math.cos(thCloth + 1.57), Math.sin(thCloth + 1.57)];
      o.billow = t < 60 ? .05 : .2 * sm(60, 61, t) * (1 - sm(69.2, 70, t));
      if (t > 69.5) { const k = ramp(t, 69.5, 70.3); o.c = [lerp(o.c[0], CL[0], k), lerp(o.c[1], CL[1], k), lerp(o.c[2], CL[2], k)]; o.R = lerp(2.9, CLOTH_R, k); o.sag = lerp(.16, .05, k); }
      return o; }
    if (t < 73) { o.billow = .015; o.dip = -.025 * sm(72.4, 72.95, t); return o; }   // braced: the bearers pull it taut as she comes
    if (t < 75) { const p = P.pell(t).pos; o.dip = clamp(CL[1] - p[1] + .04, -.12, .7); o.dx = p[0] - CL[0]; o.dz = p[2] - CL[2]; o.R = CLOTH_R - .22 * Math.max(0, o.dip); return o; }
    const k = ramp(t, 75, 76.6); o.c = [CL[0], lerp(CL[1], CLG + .05, k), CL[2]]; o.R = lerp(CLOTH_R, CLOTH_R + .25, k); o.sag = lerp(.05, .02, k); o.lowered = k;
    o.dip = .25 * (1 - k); o.dx = -1.5 * k; o.dz = 1 * k; return o;
  }

  // ---------------------------------------------------------------- scripts: everyone's pose as a function of held time
  // A pose: pos, yaw, s (scale), arms aL / aR = [pitch forward, raise sideways], lean, roll, hp / hy (head pitch up, head yaw
  // to its left), bob (m), sq (squash, 1 at rest), pa / pb / pc (prop pitch, roll, twist; for the toy bell: swing, slip),
  // gait (phase) and gAmp (stride, above 1 for stomps), prop (null = its own), hide. All angles in radians.
  const PO = () => ({ prop: null, pos: [0, 0, 0], yaw: 0, s: 1, aL: [0, 0], aR: [0, 0], lean: 0, roll: 0, hp: 0, hy: 0, bob: 0, sq: 1, pa: 0, pb: 0, pc: 0, gait: 0, gAmp: 0, hide: 0 });
  const armTo = (arm, v, k) => { arm[0] = lerp(arm[0], v[0], k); arm[1] = lerp(arm[1], v[1], k); };   // blend an arm toward v by k
  // the base pose every script starts from: arms down, standing, a slow breath every 3.2 s
  function rest(o, h, seed) { o.aL[0] = .05; o.aL[1] = .1; o.aR[0] = .05; o.aR[1] = .1; o.lean = .02; o.roll = 0; o.hp = 0; o.hy = 0;
    o.bob = .007 * Math.sin(TAU * h / 3.2 + seed * 6.3); o.sq = 1 + .008 * Math.sin(TAU * h / 3.2 + seed * 6.3); o.gait = 0; o.gAmp = 0; o.pa = 0; o.pb = 0; o.pc = 0; }
  // small life: a held glance now and then (2-drawing head turns), like hand-drawn background people
  function glance(o, h, seed, amp = .5) { const k = Math.floor((h + seed * 7) / (1.6 + seed * 1.4)); const a = (A.hash(k, seed * 100) - .5) * 2 * amp, b = (A.hash(k - 1, seed * 100) - .5) * 2 * amp;
    const x = (h + seed * 7) % (1.6 + seed * 1.4); o.hy += lerp(b, a, ramp(x, 0, 2 / 12)); o.hp += .08 * (A.hash(k, seed * 50) - .5); }
  // add a walk cycle at gait phase `phase` (one step per pi): swinging arms, a bob, a forward lean, a sway; run = 1 for a run
  function walkPose(o, phase, amp = 1, run = 0) { const s = Math.sin(phase);
    o.gait = phase; o.gAmp = amp * (1 + .25 * run); o.aL[0] = (.42 + .5 * run) * s * amp + .5 * run; o.aR[0] = -(.42 + .5 * run) * s * amp + .5 * run;
    o.aL[1] = .12 + .15 * run; o.aR[1] = .12 + .15 * run; o.bob += (.022 + .05 * run) * Math.abs(Math.cos(phase)) * amp - .012 * amp; o.lean += (.06 + .22 * run) * amp; o.roll += .04 * s * amp; o.sq += .02 * Math.cos(2 * phase) * amp; }
  // walk between two world points (pure: progress from time); stride in m per step. Returns true while moving.
  function walkLine(o, a, b, t0, t1, h, stride = .58, e = 'lin') { const k = ramp(h, t0, t1, e), x = lerp(a[0], b[0], k), z = lerp(a[2], b[2], k);
    o.pos = onG(x, z); const L = Math.hypot(b[0] - a[0], b[2] - a[2]); o.yaw = yawTo(a, b); const moving = h > t0 && h < t1;
    if (moving) walkPose(o, k * L / stride * Math.PI, 1); return moving; }
  // a stroll back and forth along a terrace with pauses: wait, walk the span (p.span rad of the terrace) at 0.8 x p.speed m/s,
  // wait and turn round, walk back. Returns true while walking.
  function stroll(o, p, h) { const L = Math.abs(p.span) * V.ringR(p.home.k, p.th), legT = L / (p.speed * .8), dwell = 1.2 + 2.5 * p.seed, per = 2 * (legT + dwell);
    let x = ((h + p.seed * 37) % per + per) % per, s, mv = 0, dir;
    if (x < dwell) { s = 0; dir = 1; } else if (x < dwell + legT) { s = (x - dwell) / legT; mv = 1; dir = 1; } else if (x < 2 * dwell + legT) { s = 1; dir = -1; } else { s = 1 - (x - 2 * dwell - legT) / legT; mv = 1; dir = -1; }
    const th = p.th + p.span * (s - .5); o.pos = V.onTerrace(p.home.k, th, p.u); const ahead = V.onTerrace(p.home.k, th + .01 * dir * Math.sign(p.span), p.u);
    o.yaw = yawTo(o.pos, ahead); if (!mv) { const turn = x < dwell ? ramp(x, dwell * .5, dwell * .5 + .25) : ramp(x - dwell - legT, dwell * .5, dwell * .5 + .25); if (turn > 0 && turn < 1) o.yaw += Math.PI * (1 - turn); else if (turn === 0) o.yaw += Math.PI; }
    if (mv) walkPose(o, s * L / .56 * Math.PI, 1); return mv; }

  // gestures (overlays): tau = time since the gesture began (held)
  // the hush greeting: finger to the lips, then an open palm, then a small nod (k = those three weights over 2.1 s)
  function gSign(o, tau, arm = 'aR') { if (tau < 0 || tau > 2.1) return;
    const k = keys(tau, [[0, [0, 0, 0]], [.3, [1, 0, 0], 'antic'], [.9, [1, 0, 0]], [1.08, [0, 1, 0], 'snap'], [1.55, [0, 1, 0]], [1.68, [0, 1, 1]], [1.8, [0, .6, 0]], [2.1, [0, 0, 0]]]);
    armTo(o[arm], [2.0, -.56], k[0]); armTo(o[arm], [1.42, .12], k[1]); o.hp -= .22 * k[2] - .06 * k[0]; o.lean += .05 * k[1]; }
  // look up by amt rad (weight k), leaning back a little
  function gLookUp(o, k, amt = .55) { o.hp += amt * k; o.lean -= .07 * k; o.aL[1] += .1 * k; o.aR[1] += .1 * k; o.bob += .006 * k; }
  // the exhale at 33: a breath in, then the shoulders drop over three drawings and stay low a while
  function gExhale(o, h, t0) { const x = h - t0; if (x < -.6 || x > 3.6) return;
    const k = keys(x, [[-.6, 0], [-.05, -.6, 'io'], [.25, 1, 'snap'], [1.6, 1], [3.6, 0, 'io']]);
    o.bob -= .028 * k; o.sq -= .022 * k; o.hp -= .16 * k; o.aL[1] -= .06 * k; o.aR[1] -= .06 * k; o.aL[0] -= .05 * k; o.aR[0] -= .05 * k; o.lean += .05 * k; }
  // the gust (36-38.5): leaning into the wind, a hand clamped on the hood, a stagger
  const WIND = [1, 0, .18];   // the gust's direction as the people feel it: east (+x), a little south
  function gGust(o, h, seed, strength = 1) { const k = sm(36.05 + seed * .3, 36.5 + seed * .3, h) * (1 - sm(38.3, 39.2, h)) * strength; if (k <= 0) return;
    const c = Math.cos(o.yaw), s = Math.sin(o.yaw), lx = WIND[0] * c - WIND[2] * s, lz = WIND[0] * s + WIND[2] * c;   // wind in the body's frame
    const j = A.wobble(h * 5 + seed * 9, seed * 13) * .5 + .5;
    o.lean -= .3 * lz * k * (.7 + .5 * j); o.roll += .3 * lx * k * (.7 + .5 * j); armTo(o.aR, [2.85, -.3], k * .9); o.hp -= .12 * k; o.sq -= .03 * k; }
  // laughing: a bouncing belly laugh, head thrown back (laugh-bounce)
  function gLaugh(o, tau, dur, seed) { if (tau < 0 || tau > dur + .4) return; const k = ramp(tau, 0, .16) * (1 - ramp(tau, dur, dur + .4));
    const f = 3.4 + seed, b = Math.abs(Math.sin(Math.PI * f * tau));
    o.bob += (.012 + .05 * b) * k; o.sq += (.07 * b - .03) * k; o.hp += (.42 + .1 * Math.sin(tau * 9)) * k; o.lean -= .12 * k;
    if (seed > .5) { armTo(o.aL, [.85, -.35], k); armTo(o.aR, [.85, -.35], k); } else { armTo(o.aL, [2.55, .75 + .15 * b], k); armTo(o.aR, [2.55, .75 + .15 * b], k); } }
  // puddle stomp: big knees on the spot, arms out
  function gStomp(o, h, t0, rate = 2.2) { const ph = (h - t0) * rate * Math.PI; o.gait = ph; o.gAmp = 1.7; const s = Math.sin(ph);
    o.bob += .05 * Math.max(0, Math.cos(ph * 2)) - .01; o.aL[1] = .75 + .2 * s; o.aR[1] = .75 - .2 * s; o.aL[0] = .3; o.aR[0] = .3; o.lean += .08; o.roll += .1 * s; o.sq += .05 * Math.cos(2 * ph); o.hp += .1; }
  // hold the cloth: hands up and forward on its edge
  function gHold(o, k, lean = -.12) { armTo(o.aL, [1.95, .18], k); armTo(o.aR, [1.95, .18], k); o.lean += lean * k; }

  // sound meter: when did the most recent sound front pass this point? (any band; reach * 1.15 as in evFlash)
  function lastFront(p, t) { let best = -10; for (const e of EV.T) { const d = Math.hypot(p[0] - e.src[0], p[1] - e.src[1], p[2] - e.src[2]); if (d > e.reach * 1.15) continue; const ta = e.t0 + d / EV.C_SOUND; if (ta <= t && ta > best) best = ta; } return best; }

  const NOTCH = V.places.spillway.notch;           // the Spillway notch in the east crest, where the gust takes the field
  const stag = p => (p.i * 7 % 11) / 12;           // staggered on twos: one drawing apart
  // the shared act overlays for the village (not the fanners, not the Listeners)
  function acts(o, p, h, mobile) {
    // 25-39 look up at the field (they turn to face it a drawing apart)
    const up = sm(25.2 + stag(p), 25.9 + stag(p), h) * (1 - sm(42, 43, h));
    if (up > 0 && h < 39) { const fc = P.fieldC(Math.min(h, 39)); o.yaw = lerpA(o.yaw, yawTo(o.pos, fc), up * .8); gLookUp(o, up, .5 + .15 * p.seed); }
    gExhale(o, h, 33 + stag(p) * .5);
    gGust(o, h, p.seed, .8);
    // 39: every hood turns east toward the Spillway, staggered on twos, each with a small anticipation
    const tt = 39 + stag(p); if (h > tt - .2 && h < 72) { const k = keys(h - tt, [[0, 0], [.17, -.12, 'io'], [.5, 1, 'snap']]); o.yaw = lerpA(o.yaw, yawTo(o.pos, NOTCH), clamp(k, -.2, 1)); }
    // 39-69 they watch it go, chins up; about a quarter shade their eyes with a mitten for a while (about 46-56)
    if (h > 39 && h < 69) { gLookUp(o, sm(39.3, 40, h), .25 + .25 * p.seed); if (p.seed > .72 && h > 44 && h < 62) armTo(o.aR, [2.3, .1], ramp(h, 44 + p.seed * 3, 44.4 + p.seed * 3) * (1 - ramp(h, 52 + p.seed * 4, 52.5 + p.seed * 4))); }
    // 69-76.5 the rain comes down: palms up, faces up, a little bounce (children bounce more)
    if (h > 69 && h < 76.5) { const k = sm(69.2 + stag(p), 69.7 + stag(p), h) * (1 - sm(75, 76.5, h)); armTo(o.aL, [2.1, .7], k * .9); armTo(o.aR, [2.1, .7], k * .9); gLookUp(o, k, .45); o.bob += .02 * k * Math.abs(Math.sin((h - 69) * 7 + p.seed * 6)) * (p.kid ? 2 : .5); }
  }

  // ---- per group
  const fanPos = (p, h) => P.fans(h)[p.fan].pos;   // a fanner's spot on the fan line (path.fans, which also drives the field)
  // A fanner's day: waits on terrace 9 with the paddle on the shoulder, walks up to its spot (14-21), swings the paddle up
  // (21.5-24), sweeps (24-33.4), rests and rides out the gust, watches the field go, and from 57 is a cloth bearer.
  function fanner(o, p, h, t) {
    const st = P.fans(clamp(h, 24, 33))[p.fan], home = st.pos, faceIn = yawTo(home, [0, home[1], 0]) + .25;
    const start = T9(Math.atan2(home[2], home[0]) - .085 - .004 * p.j, .3 + .06 * (p.j % 2));
    rest(o, h, p.seed);
    if (h < 14 + p.j * .25) { o.pos = start; o.yaw = yawTo(start, home) + .6 * Math.sin(p.j * 2.1); o.pa = -1.05; o.pb = -.25; o.pc = 0; armTo(o.aR, [1.5, -.1], 1); armTo(o.aL, [.9, -.2], 1); glance(o, h, p.seed, .4); }
    else if (h < 21.5) { const t0 = 14 + p.j * .25; walkLine(o, start, home, t0, 21.2, h, .62); o.pa = -1.05 + .06 * Math.sin(o.gait); o.pb = -.25; armTo(o.aR, [1.5, -.1], 1); armTo(o.aL, [.9, -.2], 1); }
    else if (h < 24) { o.pos = home; o.yaw = lerpA(yawTo(start, home), faceIn, ramp(h, 21.5, 22)); const k = ramp(h, 21.8 + p.j * .08, 22.6 + p.j * .08, 'antic');   // swing the paddle up off the shoulder
      o.pa = lerp(-1.05, .18, k); o.pb = lerp(-.25, 0, k); o.pc = lerp(0, Math.PI / 2, k); armTo(o.aR, [1.5, -.1], 1); armTo(o.aL, [.9, -.2], 1); armTo(o.aR, [1.75, .25], k); armTo(o.aL, [1.45, .3], k); o.sq -= .04 * Math.sin(Math.PI * k); }
    else if (h < 33.4) { // the sweep: a 2-beat cycle with the phase from path.fans; fast through the middle, a hang at each end
      o.pos = fanPos(p, h); o.yaw = faceIn; const ph = P.fans(h)[p.fan].phase, s = Math.sin(ph), sh = Math.sign(s) * Math.pow(Math.abs(s), .45);
      const on = ramp(h, 24, 24.5) * (1 - ramp(h, 33, 33.4));
      o.pa = .18 + .12 * on * Math.cos(ph); o.pb = .78 * sh * on; o.pc = Math.PI / 2 - .35 * Math.cos(ph) * on;
      armTo(o.aR, [1.75 + .2 * sh * on, .25 - .3 * sh * on], 1); armTo(o.aL, [1.45 - .2 * sh * on, .3 + .3 * sh * on], 1);
      o.roll = -.14 * sh * on; o.lean = .1 * on; o.bob += .03 * Math.abs(Math.cos(ph)) * on - .02 * on; o.sq += .04 * Math.cos(2 * ph) * on; o.hp = .25 * on; o.hy = -.12 * sh * on;
      o.gait = ph * .5; o.gAmp = .25 * on; }
    else if (h < 57) { // rest, exhale, stumble in the gust, turn east, watch
      const g = sm(36, 36.6 + p.j * .05, h) * (1 - sm(38, 39, h)), push = sm(36, 37.6, h) * (.7 + .4 * p.seed);
      o.pos = onG(fanPos(p, 33.4)[0] + WIND[0] * push * .9, fanPos(p, 33.4)[2] + WIND[2] * push * .9); o.yaw = faceIn;
      o.pa = .12; o.pb = 0; o.pc = Math.PI / 2; armTo(o.aR, [1.6, .2], 1); armTo(o.aL, [1.3, .25], 1); o.lean = .06; o.hp = .15;
      gExhale(o, h, 33 + stag(p) * .5);
      if (g > 0) { const w = A.wobble(h * 4.5 + p.j, p.seed * 11); o.pb = (.9 + .4 * w) * g; o.pc = Math.PI / 2 + 2.2 * w * g; o.pa = .12 + .5 * g * (.5 + .5 * A.wobble(h * 3 + 7, p.j));
        o.lean -= .25 * g; o.roll -= .35 * g * (.6 + .4 * w); o.gait = (h - 36) * 10; o.gAmp = .9 * g; o.sq -= .05 * g; }
      const tt = 39 + stag(p); if (h > tt - .2) { const k = keys(h - tt, [[0, 0], [.17, -.12, 'io'], [.5, 1, 'snap']]); o.yaw = lerpA(o.yaw, yawTo(o.pos, NOTCH), clamp(k, -.2, 1)); }
      if (h > 39.5) { o.hp = .2 + .25 * sm(39.5, 40.5, h); o.pa = lerp(.12, -.15, sm(40, 41, h)); }
    }
    else bearer(o, p, h, t);
  }
  // the hush-cloth bearers (the 18 fanners and two more): run with it 60-70, hold it taut 70-75, lower it, then celebrate.
  // Bearer j holds the rim at angle 2 pi j / 20, 0.4 m outside it (they jump to the cloth at 57 from wherever they were).
  function bearer(o, p, h, t) {
    rest(o, h, p.seed); o.prop = 0; const j = p.fan, phi = TAU * j / 20;
    if (h < 75) { const c = cloth(h), run = h >= 60 && h < 70, R0 = c.R + .4;
      const pos = [c.c[0] + Math.cos(phi) * R0, 0, c.c[2] + Math.sin(phi) * R0]; o.pos = onG(pos[0], pos[2]);
      const inYaw = yawTo(o.pos, c.c), runYaw = Math.atan2(c.dir[0], c.dir[1]);
      if (h < 60) { o.yaw = inYaw; gHold(o, ramp(h, 57.2, 57.8), -.05); o.hp = .2; glance(o, h, p.seed, .3); }
      else if (run) { const k = ramp(h, 60, 60.5) * (1 - ramp(h, 69.4, 70)); o.yaw = lerpA(inYaw, runYaw, .72 * k);
        walkPose(o, (h - 60) * 15 + j * 1.3, k, 1); gHold(o, 1, .1 * k); o.hp = .25; }
      else { o.yaw = inYaw; gHold(o, 1, -.16); o.hp = .3 + .2 * sm(72, 72.9, h);
        // the catch: yanked in on impact, then they lean back and ride it (on twos)
        const k = A.ring(h, 73.0, 2.4, .32); o.lean += .42 * Math.max(0, k) - .12 * Math.max(0, -k); o.sq -= .05 * Math.abs(k); o.bob -= .03 * Math.abs(k);
        if (h > 73) armTo(o.aL, [1.7, .1], .5 * Math.abs(k)), armTo(o.aR, [1.7, .1], .5 * Math.abs(k)); }
      return; }
    // lower the cloth, then step back to their places round it (4.3-6.9 m out, on its east side) and celebrate; home at 87.2
    const slot = (() => { const a = -1.9 + 3.8 * (j + .5) / 20 + (A.hash(j, 6) - .5) * .22, r = 4.3 + 2.6 * A.hash(j, 5) ** 1.5; return onG(CL[0] + Math.cos(a) * r, CL[2] + Math.sin(a) * r); })();
    const hold = [CL[0] + Math.cos(phi) * (CLOTH_R + .5), 0, CL[2] + Math.sin(phi) * (CLOTH_R + .5)];
    const k = ramp(h, 75, 76.4); o.pos = onG(hold[0], hold[2]); o.yaw = yawTo(o.pos, CL);
    gHold(o, 1 - k); o.sq -= .08 * Math.sin(Math.PI * k); o.hp = .2;
    if (h > 76.6) { const moved = walkLine(o, onG(hold[0], hold[2]), slot, 76.6 + .1 * (j % 5), 78.2 + .1 * (j % 5), h, .58, 'io'); if (!moved) o.yaw = yawTo(o.pos, P.pell(81).pos); }
    if (h > 78.2 && h < 81) { const k2 = sm(78.4, 79, h); armTo(o.aL, [2.6, .6], k2 * (p.seed > .4 ? 1 : 0)); armTo(o.aR, [2.6, .6], k2); o.hp += .3 * k2; o.bob += .03 * k2 * Math.abs(Math.sin(h * 6 + j)); }
    celebrate(o, p, h);
    if (h > 87.2) { const home = T9(thCloth - .3 - .02 * (j % 7), .3 + .03 * (j % 9)); walkLine(o, slot, home, 87.2 + .2 * (j % 4), 120, h, .56); }
  }
  // 81-87: laughs (laugh-bounce) at staggered times
  const laughs = [], stomps = [];
  // villager p's laughs as [start, length] pairs: from 81.1-82.5 until 86.4, each 0.8-1.7 s with 0.5-2.1 s between, from
  // its own seeded stream (cached on p)
  function laughPlan(p) { if (p.plan) return p.plan; const r = A.rng(1000 + p.i), L = []; let t = 81.1 + r() * 1.4;
    while (t < 86.4) { const d = .8 + r() * .9; L.push([t, d]); t += d + .5 + r() * 1.6; } return (p.plan = L); }
  function celebrate(o, p, h) { if (h < 80.6 || h > 87.4) return;
    for (const [t0, d] of laughPlan(p)) gLaugh(o, h - t0, d, p.seed); }

  function listener(o, p, h) {
    // the six on the rim near the bench: sitting, facing out over the Hushlands. One key pose every 4-6 s, eased over 8 drawings.
    const TH = [-.302, -.278, -.252, -.214, -.193, -.128][p.j], r = V.ringR(9, TH) + 5.6 + .5 * Math.sin(p.j * 1.7), pos = onG(Math.cos(TH) * r, Math.sin(TH) * r);
    rest(o, h, p.seed); o.pos = pos; o.yaw = Math.atan2(Math.cos(TH), Math.sin(TH)) + (p.j - 2.5) * .12;   // outward
    const POSES = [{ aL: [.85, -.12], aR: [.85, -.12], hp: 0, hy: 0, roll: 0, lean: .05 },                // still
      { aL: [.85, -.12], aR: [1.95, 1.12], hp: .06, hy: .2, roll: -.14, lean: .02 },                      // a mitten cupped to the ear
      { aL: [.8, -.1], aR: [.8, -.1], hp: .5, hy: 0, roll: 0, lean: -.06 },                                 // looking up at the sky
      { aL: [.85, -.12], aR: [.85, -.12], hp: .05, hy: .95 * (p.j % 2 ? 1 : -1), roll: 0, lean: .03 },     // turning to the valley
      { aL: [1.05, -.25], aR: [1.05, -.25], hp: -.18, hy: 0, roll: 0, lean: .22 }];                        // bowed, listening hard
    // the key poses in order (never the same twice running), each eased in from the one before over 8 drawings, then held
    const rr = A.rng(500 + p.j); const ks = []; let t = -8 + rr() * 4, last = -1;
    while (t < 81) { let q = Math.floor(rr() * POSES.length); if (q === last) q = (q + 1) % POSES.length; ks.push([t, POSES[q]]); last = q; t += 4 + 2 * rr(); }
    ks.push([81.4 + p.j * .55, { aL: [1.8, .4], aR: [1.8, .4], hp: .35, hy: 0, roll: 0, lean: -.04 }]);           // 81-87: slowly raising their hands
    ks.push([84.2 + p.j * .5, { aL: [2.75, .55], aR: [2.75, .55], hp: .5, hy: 0, roll: 0, lean: -.08 }]);
    let a = ks[0][1], b = ks[0][1], k = 0; for (let i = 0; i < ks.length; i++) if (h >= ks[i][0]) { a = i ? ks[i - 1][1] : ks[i][1]; b = ks[i][1]; k = ramp(h, ks[i][0], ks[i][0] + 8 / 12); }
    const q = A.mixv(a, b, k); armTo(o.aL, q.aL, 1); armTo(o.aR, q.aR, 1); o.hp = q.hp; o.hy = q.hy; o.roll = q.roll; o.lean = q.lean;
    o.sq = .64; o.bob = -.03;                                      // sitting: the felt robe settles into a low mound
    // the tassels still answer the big tolls; at 87 they stand up and walk home along the rim
    if (h > 87) { const up = ramp(h, 87.2 + p.j * .3, 87.9 + p.j * .3, 'antic'); o.sq = lerp(.64, 1, up); o.bob = lerp(-.03, 0, up); armTo(o.aL, [.1, .1], up); armTo(o.aR, [.1, .1], up); o.hp *= 1 - up; o.hy *= 1 - up;
      if (h > 88.2 + p.j * .3) { const th2 = TH - .013 * (h - 88.2 - p.j * .3) / 3; const r2 = V.ringR(9, th2) + 5.6; const q2 = onG(Math.cos(th2) * r2, Math.sin(th2) * r2);
        o.yaw = yawTo(pos, q2) ; walkPose(o, (h - 88) * 5.5, ramp(h, 88.2 + p.j * .3, 88.6 + p.j * .3)); o.pos = q2; o.lean += .08; } }
  }

  // Cistern Row (12-18) and the rest of their day. Each role has its own small script; P.kid is the bell-kid's spot, and the
  // toy bell rings (E6, the 'toybell' toll) at 13.5.
  function rowLife(o, p, h) {
    rest(o, h, p.seed);
    const base = p.th != null ? T6(p.th, p.u) : null;
    const kidPos = P.kid;
    switch (p.role) {
      case 'bellkid': { o.pos = kidPos.slice(); o.yaw = yawTo(kidPos, [0, 0, 0]) + .35; o.pa = 0; o.pb = 0; glance(o, h, p.seed, .3);
        // swinging the muffled bell, then it slips (13.5) and jingles: a jump, arms up, a look up at the mist, then mittens over the mouth
        armTo(o.aR, [.55 + .35 * Math.sin(h * 7.5), .05], h < 13.5 ? 1 : 0); o.pa = h < 13.5 ? .35 * Math.sin(h * 7.5 - .9) : 0;
        if (h > 12.4 && h < 13.45) { o.bob += .03 * Math.abs(Math.sin(h * 7.5)); o.roll += .06 * Math.sin(h * 7.5); }
        if (h >= 13.5) { const tau = h - 13.5; o.pb = 1; o.pa = .9 * Math.exp(-2.2 * tau) * Math.sin(tau * 13) + .25 * Math.exp(-1.2 * tau) * Math.sin(tau * 5);
          const k = keys(tau, [[0, [1, 0, 0, 1.12]], [.5, [1, 1, 0, 1.0]], [.6, [1, 1, 0, 1.0]], [.75, [0, 1, 1, .94], 'snap'], [1.7, [0, 0, 1, .95]], [2.1, [0, 0, 0, 1], 'io']]);
          armTo(o.aL, [2.3, .9], k[0]); armTo(o.aR, [2.3, .9], k[0]); gLookUp(o, k[1], .6); armTo(o.aL, [1.92, -.5], k[2]); armTo(o.aR, [1.92, -.5], k[2]); o.hp -= .15 * k[2]; o.sq *= k[3]; o.bob += .06 * (k[3] - 1) * 2 + (tau < .17 ? .06 : 0); }
        else if (h > 13.4) { o.sq *= .88; o.bob -= .02; }   // anticipation drawing before the jingle
        break; }
      // the shushing child: hears the bell when its sound arrives (0.03 s, about a metre at 30 m/s) and reacts a drawing
      // later: a glance, a turn toward the bell-kid, then a finger to the lips, wagging its head (13.85-15.3)
      case 'shush': { o.pos = base; o.yaw = yawTo(base, [0, 0, 0]) - .3; glance(o, h, p.seed, .35);
        const heard = 13.5 + .03 + 1 / 12; const k = ramp(h, heard, heard + 2 / 12);
        o.hy = lerpA(o.hy, wrapA(yawTo(base, kidPos) - o.yaw), k); if (h > heard + .25) { const k2 = ramp(h, heard + .25, heard + .45); o.yaw = lerpA(o.yaw, yawTo(base, kidPos), k2); o.hy *= 1 - k2; }
        if (h > 13.85 && h < 15.3) { const k3 = keys(h, [[13.85, 0], [14.0, 1, 'antic'], [15.0, 1], [15.3, 0]]); armTo(o.aR, [1.93, -.56], k3); o.lean += .16 * k3; o.hp -= .1 * k3; o.hy += .16 * Math.sin((h - 14) * 9) * k3 * (h < 14.7 ? 1 : 0); o.bob += .015 * k3; }
        break; }
      // two children hopping on the spot, facing each other; they all but stop and turn their heads when the bell rings (13.6-15)
      case 'hopkid': { o.pos = base; o.yaw = yawTo(base, T6(p.th + (p.i % 2 ? -.006 : .006), p.u)); const ph = h * 2.6 * Math.PI + p.i, b = Math.max(0, Math.sin(ph));
        o.bob += .1 * b * b; o.sq += b > .1 ? .06 * b : -.06; o.aL[1] = .4 + .5 * b; o.aR[1] = .4 + .5 * b; o.hp += .1 * b; if (h > 13.5 + .1 && h < 15) { o.hy = .6; o.bob *= .3; } break; }
      case 'picker': { o.pos = base; o.yaw = yawTo(base, kidPos) + 1.2; glance(o, h, p.seed, .25);
        // raise the gourd pole to a low strand, hook a bead (14.8), lower it carefully
        const k = keys(h, [[12.2, 0], [13.6, .7, 'io'], [14.6, 1, 'io'], [14.8, 1.08, 'snap'], [15.3, 1], [16.6, 0, 'io']]);
        o.pa = lerp(-.32, .42, k); o.pb = -.1; armTo(o.aR, [lerp(.7, 1.9, k), .05], 1); armTo(o.aL, [lerp(.6, 1.5, k), -.1], 1); gLookUp(o, k, .55); o.lean -= .05 * k; break; }
      // two pairs greet each other with the hush sign, twice (at tg and 3.4 s later)
      case 'greet': { o.pos = base; const other = T6(p.th + (p.face > 0 ? -.006 : .006) * (p.th > KID_TH ? 1 : 1), p.u); o.yaw = yawTo(base, other);
        gSign(o, h - p.tg); gSign(o, h - p.tg - 3.4); glance(o, h, p.seed, .15); break; }
      // passers-by along the row; the carrier holds a load in front of it
      case 'walker': case 'carrier': { const a = T6(p.path[0][0], p.path[0][1]), b = T6(p.path[1][0], p.path[1][1]); const mv = walkLine(o, a, b, p.t[0], p.t[1], h, .56);
        if (!mv) o.yaw = yawTo(a, b) + (h > p.t[1] ? .8 : 0); if (p.role === 'carrier') { armTo(o.aL, [1.1, -.25], 1); armTo(o.aR, [1.1, -.25], 1); } break; }
      // the cistern keeper watches the frog: a snap glance as it croaks (14.5), a nod as it catches its drop (16.1)
      case 'keeper': { o.pos = base; o.yaw = yawTo(base, P.frog) - .2; o.lean += .1; armTo(o.aL, [.9, -.2], 1); armTo(o.aR, [.9, -.2], 1);
        o.hy = keys(h, [[14.2, 0], [14.5, .35, 'snap'], [16.4, .35], [16.7, 0]]); o.hp = keys(h, [[15.6, -.1], [16.1, -.3, 'io'], [16.5, -.1]]); break; }
      // three neighbours talking in signs
      case 'chat': { o.pos = base; const other = T6(p.th + (p.face > 0 ? -.006 : p.face < 0 ? .006 : .003), p.u - (p.face === 0 ? .06 : 0)); o.yaw = yawTo(base, other);
        gSign(o, h - 12.6 - p.seed * 4); gSign(o, h - 16.2 - p.seed * 3, 'aL'); glance(o, h, p.seed, .25); break; }
    }
    if (h > 18.5 && p.role !== 'walker' && p.role !== 'carrier') glance(o, h, p.seed, .2);
  }
  // the villagers round the houses: strolling, chatting, children running in circles, standing about. Their clock `live`
  // stops at 25.2 when the toll begins and runs again from 87.
  function scatterLife(o, p, h) {
    rest(o, h, p.seed); const live = h < 25.2 ? h : h > 87 ? h - 62 : 25.2;   // they stop when the toll begins, walk again at dusk
    switch (p.role) {
      case 'stroll': case 'carry': { stroll(o, p, live); if (h > 25.2 && h < 87) { const q = o.pos, y = o.yaw; rest(o, h, p.seed); o.pos = q; o.yaw = y; } if (p.role === 'carry') { armTo(o.aL, [1.05, -.25], 1); armTo(o.aR, [1.05, -.25], 1); } break; }
      case 'chat': { o.pos = V.onTerrace(p.home.k, p.th, p.u); o.yaw = yawTo(o.pos, V.onTerrace(p.home.k, p.th + .004, p.u)) + (p.i % 2 ? Math.PI : 0); gSign(o, (live % 5.3) - 1 - p.seed); glance(o, h, p.seed, .2); break; }
      case 'play': { const c = V.onTerrace(p.home.k, p.th, p.u), a = live * (1.6 + p.seed) + p.i, rr = 1.2 + p.seed;
        o.pos = onG(c[0] + Math.cos(a) * rr, c[2] + Math.sin(a) * rr); o.yaw = yawTo(o.pos, onG(c[0] + Math.cos(a + .1) * rr, c[2] + Math.sin(a + .1) * rr));
        if (h < 25.2 || h > 87) walkPose(o, live * 10, 1, 1); else { o.pos = onG(c[0] + Math.cos(25.2 * (1.6 + p.seed) + p.i) * rr, c[2] + Math.sin(25.2 * (1.6 + p.seed) + p.i) * rr); } break; }
      default: { o.pos = V.onTerrace(p.home.k, p.th, p.u); o.yaw = yawTo(o.pos, [0, 0, 0]) + (p.seed - .5) * 2; glance(o, h, p.seed, .45); if (p.seed > .6) { armTo(o.aL, [.7, -.3], 1); armTo(o.aR, [.7, -.3], 1); } }
    }
  }
  // the gathering at the cloth after the catch: run in along terrace 9 from 72, then stand round it, cheer, laugh, stomp
  function gatherLife(o, p, h) {
    rest(o, h, p.seed);
    const mv = walkLine(o, p.runFrom, p.slot, 72, p.arrive, h, 1.05, 'lin');
    if (mv) { walkPose(o, ((h - 72) / (p.arrive - 72)) * Math.hypot(p.slot[0] - p.runFrom[0], p.slot[2] - p.runFrom[2]) / 1.05 * Math.PI, 1, 1); o.gAmp = 1.25; }
    else { o.pos = p.slot; o.yaw = yawTo(p.slot, P.pell(80).pos) + (p.seed - .5) * .5; glance(o, h, p.seed, .3);
      if (h > 75.4 && h < 81) { const k = sm(75.5 + p.seed, 76 + p.seed, h); armTo(o.aL, [2.5, .7], k); armTo(o.aR, [2.5, .7], k); o.hp += .35 * k; o.bob += .04 * k * Math.abs(Math.sin(h * 5.5 + p.i)); }
      if (p.stomper && h > 80.8) { const t0 = 80.9 + p.seed * .8; if (h > t0) gStomp(o, h, t0, 2.0 + p.seed * .6); laughPlan(p); }
      else celebrate(o, p, h); }
    if (h > 87.2) { const home = T9(thCloth - .26 - .05 * p.seed, .25 + .4 * p.seed); walkLine(o, p.slot, home, 87.2 + p.seed, 125, h, .56); }
  }

  // one villager's whole pose at held time h = A.held(t) (the stand-in for Pell follows her on film time t, on ones)
  function pose(i, t, o = PO()) {
    const p = people[i], h = A.held(t);
    if (p.group === 'fan') fanner(o, p, h, t);
    // the two extra bearers stroll near a house until 57 (their stroll data is filled in on first use)
    else if (p.group === 'extra') { if (h >= 57) bearer(o, p, h, t); else { p.home = p.home || HOMES[(i * 5) % HOMES.length]; p.th = p.th ?? p.home.th + .02; p.u = p.u ?? .3; p.span = .03; p.speed = 1; p.role2 = 'stroll';
      rest(o, h, p.seed); stroll(o, p, h < 25.2 ? h : 25.2); acts(o, p, h); } }
    else if (p.group === 'listen') listener(o, p, h);
    else if (p.group === 'standin') { const s = P.pell(t); rest(o, h, p.seed); o.pos = s.pos.slice(); o.yaw = s.yaw; o.hide = F.cast || !api.standIn ? 1 : 0; if (s.air) { armTo(o.aL, [2.2, .8], 1); armTo(o.aR, [2.2, .8], 1); } }
    else if (p.gather && h >= 72) gatherLife(o, p, h);
    // everyone else: their own script, then the village's shared acts, then the laughs of 81-87
    else { if (p.group === 'row') rowLife(o, p, h); else scatterLife(o, p, h); acts(o, p, h); celebrate(o, p, h); }
    return o;
  }

  // the laughs and stomps, gathered once at build time (they also drive the laughter drizzle below and the synth).
  // Everyone but the Listeners and the stand-in laughs; the stomping children stomp instead: one stomp per half cycle, the
  // foot landing a quarter cycle later, 9 cm to the left or right of the body.
  function plan() {
    for (const p of people) { if (!(p.group === 'fan' || p.group === 'extra' || p.gather || p.group === 'row' || p.group === 'scatter')) continue;
      if (p.stomper) { const t0 = 80.9 + p.seed * .8, rate = 2.0 + p.seed * .6; for (let k = 0; ; k++) { const t = t0 + (k + .5) / rate; if (t > 87.2) break; const o = pose(p.i, t); const side = k % 2 ? -1 : 1;
          stomps.push({ t: t + .5 / rate * .5, pos: [o.pos[0] + Math.cos(o.yaw) * .09 * side * o.s, o.pos[1], o.pos[2] - Math.sin(o.yaw) * .09 * side], i: p.i }); } continue; }
      for (const [t0, d] of laughPlan(p)) { const o = pose(p.i, t0 + .2); laughs.push({ i: p.i, t0, dur: d, head: [o.pos[0], o.pos[1] + 1.5 * p.scale, o.pos[2]], kid: p.kid }); } }
    laughs.sort((a, b) => a.t0 - b.t0); stomps.sort((a, b) => a.t - b.t);
  }
  // M13: every laugh shakes a sparkling drizzle out of the afterhang veil 2.2 m above the head: 40 mist beads that hang there
  // from just after the rain (74.5) and let go one by one over the laugh. Through the rain module (or life.js's stand-in).
  // The beads hang in a disc 0.85 m in radius; more of them go early in the laugh than late (j / 40 to the power 0.8).
  function laughBeads() {
    const put = F.life && F.life.beads ? F.life.beads : F.rain && F.rain.addBeads; if (!put) return;
    const r = A.named('laugh-beads'), list = [];
    for (const l of laughs) for (let j = 0; j < 40; j++) { const a = r() * TAU, d = .85 * Math.sqrt(r());
      list.push({ p: [l.head[0] + Math.cos(a) * d, l.head[1] + 2.2 + (r() - .5) * .5, l.head[2] + Math.sin(a) * d], band: 2, size: .003 + .004 * r(),
        ts: 74.5 + r(), tr: l.t0 + l.dur * Math.pow(j / 40, .8) + .05 * r(), until: l.t0 + l.dur + 5, seed: r() }); }
    put(list);
  }

  // ---------------------------------------------------------------- build
  let mesh = null, clothMesh = null, attrs = null, clothU = null, kindAttr = null;
  const o0 = PO(), dummy = new THREE.Object3D();
  // The crowd mesh: the doll with per-instance attributes aKind = (kid, prop, seed, felt) and aPose0-3, all rewritten by
  // update(). The fragment shader paints the felt colours, the quilting, the faces and the fan blades.
  function buildCrowd(scene) {
    const g = buildDoll(); const kind = new Float32Array(N * 4);
    people.forEach((p, i) => kind.set([p.kid, p.prop, p.seed, p.felt], i * 4));
    const IA = (arr, n) => new THREE.InstancedBufferAttribute(arr, n);
    kindAttr = IA(kind, 4); kindAttr.setUsage(THREE.DynamicDrawUsage); g.setAttribute('aKind', kindAttr);
    attrs = [0, 1, 2, 3].map(k => { const a = IA(new Float32Array(N * 4), 4); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute('aPose' + k, a); return a; });
    const mat = E.toon({ vcol: true, paint: .22, rim: .32, soft: .03, uniforms: { uFelt: FELT_U },
      vpars: GL + 'varying vec3 vColA; varying vec3 vColB; varying vec4 vInfo;',
      vnormal: 'vec3 cP, cN; crowdPose(position, objectNormal, cP, cN); objectNormal = cN; float fi = floor(aKind.w / 16.0 + 0.01); vColA = uFelt[int(fi)]; vColB = uFelt[int(aKind.w - fi * 16.0 + 0.01)]; float pt = floor(aPiv.w / 4.0 + 0.01); vInfo = vec4(pt, aPiv.w - pt * 4.0, aKind.x, aKind.z);',
      vdeform: 'transformed = cP;',
      fpars: 'varying vec3 vColA; varying vec3 vColB; varying vec4 vInfo;',
      fpre: /* glsl */`
        float part = vInfo.x, paint = vInfo.y, kid = vInfo.z;
        if (paint > 0.5 && paint < 1.5) base *= vColA; else if (paint > 1.5) base *= vColB;
        if (part < 0.5) {   // quilted robe: diamond stitches and a darker hem band
          float a = atan(vOP.x, vOP.z); vec2 q = vec2(a * 2.2 + vOP.y * 9.0, a * 2.2 - vOP.y * 9.0); vec2 f = abs(fract(q) - 0.5);
          float st = smoothstep(0.035, 0.0, min(f.x, f.y)) * step(0.5, fract(q.x * 3.0 + q.y * 3.0)) * step(0.12, vOP.y) * step(vOP.y, 0.9);
          base *= 1.0 - 0.13 * st; base *= mix(0.8, 1.0, smoothstep(0.08, 0.14, vOP.y)); }
        if (abs(part - 2.0) < 0.1 && paint > 1.5) { vec3 q = vOP - vec3(0.0, 1.055, 0.03); if (q.z > 0.0 && q.z / length(q.xz) > 0.5 && vOP.y < 1.165) discard; }   // the face opening
        if (abs(part - 1.0) < 0.1) {   // the face
          // adults: the face stays a dark, unlit shadow under the hood; children: two dot eyes and pink cheeks
          vec3 d = normalize(vOP - vec3(0.0, 1.055, 0.035)); float front = smoothstep(0.2, 0.55, d.z);
          if (kid < 0.5) { base = mix(base, vec3(0.13, 0.1, 0.24), front * 0.92); lightK = mix(lightK, 0.0, front); }
          else { vec3 eL = normalize(vec3(0.34, 0.02, 0.94)), eR = normalize(vec3(-0.34, 0.02, 0.94));
            float e = smoothstep(0.9955, 0.998, max(dot(d, eL), dot(d, eR)));
            float bl = smoothstep(0.975, 0.993, max(dot(d, normalize(vec3(0.56, -0.26, 0.79))), dot(d, normalize(vec3(-0.56, -0.26, 0.79)))));
            base = mix(base, vec3(0.98, 0.5, 0.48), bl * 0.45); base = mix(base, vec3(0.09, 0.05, 0.13), e);
            base = mix(base, base * vec3(0.72, 0.62, 0.8), smoothstep(0.75, 0.95, d.y) * 0.8); } }   // under the brim
        if (abs(part - 3.0) < 0.1 && N.y < -0.2) base *= 0.78;                // the brim's underside
        if (abs(part - 10.0) < 0.1 && length(vOP.xy - vec2(0.0, 2.12)) < 0.6 && paint > 1.5) {   // fan blade
          float r = length(vec2(vOP.x, (vOP.y - 2.12) / 1.08)), a = atan(vOP.y - 2.12, vOP.x);
          // a felt raindrop appliqué in the middle, running stitches round the edge
          vec2 q = vec2(vOP.x, vOP.y - 2.06); float drop = length(q * vec2(1.0, 0.8)) - 0.17 + max(0.0, q.y) * 0.55;
          base = mix(base, vec3(0.62, 0.52, 0.32), smoothstep(0.006, -0.006, drop));
          base *= 1.0 - 0.22 * smoothstep(0.01, 0.0, abs(r - 0.5)) * step(0.5, fract(a * 14.0)); }`,
      // the glass beads (part 5) catch the sun and a cool fill
      fpost: /* glsl */`if (abs(vInfo.x - 5.0) < 0.1) c += uSunCol * 0.12 * lit + vec3(0.04, 0.08, 0.1);`,
    });
    mesh = new THREE.InstancedMesh(g, mat, N); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    // the shadow caster runs the same pose (uLinePx is declared but never set here, so it stays 0 and the hood lining is kept)
    mesh.customDepthMaterial = new THREE.ShaderMaterial({ uniforms: Object.assign({ uFelt: FELT_U }, F.U),
      vertexShader: E.COMMON + 'uniform float uLinePx;' + GL +'\nvoid main(){ vec3 cP, cN; crowdPose(position, normal, cP, cN); gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(cP, 1.0); }',
      fragmentShader: '#include <packing>\nvoid main(){ gl_FragColor = packDepthToRGBA(gl_FragCoord.z); }' });
    E.outline(mesh, { color: '#33223f', px: 1.7, max: .022 });
    mesh.userData.line.frustumCulled = false;
    scene.add(mesh);
  }

  // the hush-cloth: a felt patchwork disc with a little thickness (so the ink hull works), shaped wholly in the vertex shader
  const GLC = /* glsl */`
attribute vec3 aRp;   // rho 0..1, phi, side (+1 top, -1 underside)
uniform vec4 uCl0;    // centre xyz, radius
uniform vec4 uCl1;    // dip, edge sag, billow, lowered
uniform vec4 uCl2;    // run direction xz, dip centre offset xz
uniform float uClVis;
// the cloth's height (m) over its centre at offset xz, built up in layers
float clothH(vec2 xz){
  float R = uCl0.w, rho = length(xz) / R, phi = atan(xz.y, xz.x);
  // the edge sags between the 20 hands that hold it, and the whole disc droops toward the rim
  float y = -uCl1.y * (0.5 - 0.5 * cos(phi * 20.0)) * smoothstep(0.55, 1.0, rho) - uCl1.y * 0.7 * rho * rho;
  // the dip: a bowl under Pell, centred at the dip offset
  float dd = length(xz - uCl2.zw) / (R * 1.05); float bowl = max(0.0, 1.0 - dd * dd);
  y -= uCl1.x * bowl * bowl * (1.0 + 0.6 * bowl);
  y += max(uCl1.x, 0.0) * 0.3 * rho * rho;                                        // stretch: the rim is pulled up as the middle sinks
  float tc = uTime - 73.0; if (tc > 0.0 && tc < 1.6) { float rr = length(xz - uCl2.zw);   // the catch: a ring runs out to the rim (on ones)
    y += 0.09 * exp(-tc * 2.6) * sin(rr * 4.2 - tc * 16.0) * smoothstep(0.0, 0.4, rr) * smoothstep(-0.2, 0.4, tc * 16.0 - rr * 4.2); }
  // the billow while it is carried: a wave running along the run direction, the trailing half dragging low
  float along = dot(xz, uCl2.xy); y += uCl1.z * (sin(along * 1.4 + uTime * 10.0 + phi * 2.0) * rho - 0.6 * smoothstep(0.0, -R, along) * rho);
  // lowered onto the ground: soft rumples
  y += uCl1.w * (0.045 * sin(phi * 7.0 + rho * 8.0) * smoothstep(0.2, 0.9, rho) + 0.03 * sin(phi * 13.0 - rho * 5.0) * rho);
  return y; }
// one cloth vertex: its normal from central differences of clothH (6 cm apart); the underside sits 3.5 cm below the top
// (the thickness the ink hull needs), the rim band faces outward; when hidden it is moved 500 m below the ground
void clothPos(vec3 rp, out vec3 p, out vec3 n){
  float R = uCl0.w; vec2 xz = vec2(cos(rp.y), sin(rp.y)) * rp.x * R; float e = 0.06;
  float y = clothH(xz); vec3 nn = normalize(vec3(-(clothH(xz + vec2(e, 0.0)) - clothH(xz - vec2(e, 0.0))) / (2.0 * e), 1.0, -(clothH(xz + vec2(0.0, e)) - clothH(xz - vec2(0.0, e))) / (2.0 * e)));
  bool rim = abs(rp.z) < 0.5, under = rp.z < 0.0;
  p = uCl0.xyz + vec3(xz.x, y, xz.y) - (under ? nn * 0.035 : vec3(0.0));
  n = rim ? normalize(vec3(cos(rp.y), 0.0, sin(rp.y))) : (under ? -nn : nn);
  if (uClVis < 0.5) p = vec3(0.0, -500.0, 0.0); }`;
  function buildCloth(scene) {
    const NR = 12, NP = 64, pos = [], rp = [], idx = [];
    // top, underside, and the rim band between them: 12 rings x 64 segments, every vertex placed by clothPos from aRp
    for (const side of [1, -1]) { const o = pos.length / 3; for (let i = 0; i <= NR; i++) for (let j = 0; j <= NP; j++) { pos.push(0, 0, 0); rp.push(Math.max(.001, i / NR), TAU * j / NP, side); }
      for (let i = 0; i < NR; i++) for (let j = 0; j < NP; j++) { const a = o + i * (NP + 1) + j, b = a + 1, c = a + NP + 1, d = c + 1; if (side > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d); } }
    { const o = pos.length / 3; for (let j = 0; j <= NP; j++) { pos.push(0, 0, 0, 0, 0, 0); rp.push(1, TAU * j / NP, .3, 1, TAU * j / NP, -.3); }
      for (let j = 0; j < NP; j++) { const a = o + j * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, c, d, b); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map(() => 0), 3)); g.setAttribute('aRp', new THREE.Float32BufferAttribute(rp, 3)); g.setIndex(idx);
    clothU = { uCl0: { value: new THREE.Vector4() }, uCl1: { value: new THREE.Vector4() }, uCl2: { value: new THREE.Vector4() }, uClVis: { value: 0 } };
    // the top is patchwork in rings: an ochre centre with a pale star, an indigo ring, alternating moss and rust sectors,
    // an oat rim; quilted, with running stitches between the rings. The underside is plain oat.
    const mat = E.toon({ uniforms: clothU, paint: .2, rim: .25, wrap: .15,
      vpars: GLC + 'varying vec3 vRp;', vnormal: 'vec3 qP, qN; clothPos(aRp, qP, qN); objectNormal = qN; vRp = aRp;', vdeform: 'transformed = qP;',
      fpars: 'varying vec3 vRp;',
      fpre: /* glsl */`
        float rho = vRp.x, phi = vRp.y; vec3 OCH = vec3(0.58, 0.26, 0.03), IND = vec3(0.028, 0.05, 0.2), MOS = vec3(0.16, 0.25, 0.07), RUS = vec3(0.34, 0.075, 0.028), OAT = vec3(0.61, 0.49, 0.29);
        if (vRp.z > 0.5) {
          float sec = floor(phi / 6.2832 * 12.0); vec3 c0 = rho < 0.27 ? OCH : rho < 0.6 ? IND : rho < 0.9 ? (mod(sec, 2.0) < 0.5 ? MOS : RUS) : OAT;
          // the diamond quilting and running stitches between the rings
          vec2 q = vec2(phi * 6.0 / 3.1416 * (0.5 + rho), rho * 9.0); vec2 f = abs(fract(q + vec2(q.y, -q.y) * 0.5) - 0.5);
          float st = smoothstep(0.04, 0.0, min(f.x, f.y)) * step(0.5, fract((q.x + q.y) * 4.0));
          float ring = min(min(abs(rho - 0.27), abs(rho - 0.6)), abs(rho - 0.9)); float run = smoothstep(0.012, 0.0, ring - 0.012) * step(0.5, fract(phi * 40.0 * max(rho, 0.3)));
          base = c0 * mix(1.0, 0.86, st); base = mix(base, OAT * 1.15, run * 0.9);
          float star = smoothstep(0.09, 0.07, abs(rho - 0.13 - 0.05 * cos(phi * 4.0))); base = mix(base, OAT * 1.1, star * 0.8 * step(rho, 0.27)); }
        else base = OAT * 0.9;`,
    });
    clothMesh = new THREE.Mesh(g, mat); clothMesh.frustumCulled = false; clothMesh.castShadow = true; clothMesh.receiveShadow = true;
    clothMesh.customDepthMaterial = new THREE.ShaderMaterial({ uniforms: Object.assign({}, F.U, clothU), vertexShader: E.COMMON + GLC + '\nvoid main(){ vec3 qP, qN; clothPos(aRp, qP, qN); gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(qP, 1.0); }',
      fragmentShader: '#include <packing>\nvoid main(){ gl_FragColor = packDepthToRGBA(gl_FragCoord.z); }' });
    E.outline(clothMesh, { color: '#2b1f3a', px: 1.6, max: .03 }); clothMesh.userData.line.frustumCulled = false;
    scene.add(clothMesh);
  }

  // poses change once per drawing (12 a second): between drawings only the tassel meter (on ones) is refreshed.
  // (With the stand-in on, everyone is re-posed every frame, because the stand-in follows Pell on ones.)
  // The meter is measured 1.3 m up (x scale), at about head height.
  let lastH = null; const meterAt = new Float32Array(N * 3);
  function update(t) {
    if (!mesh) return;
    const a0 = attrs[0].array, a1 = attrs[1].array, a2 = attrs[2].array, a3 = attrs[3].array, h = A.held(t);
    if (h === lastH && !api.standIn) { for (let i = 0; i < N; i++) a3[i * 4 + 2] = lastFront([meterAt[i * 3], meterAt[i * 3 + 1], meterAt[i * 3 + 2]], t); attrs[3].needsUpdate = true; }
    else { lastH = h;
    for (let i = 0; i < N; i++) { const p = people[i], o = pose(i, t, PO());
      const s = p.scale * (o.hide ? 0 : 1); dummy.position.set(o.pos[0], o.pos[1], o.pos[2]); dummy.rotation.set(0, o.yaw, 0); dummy.scale.set(s, s, s); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
      a0.set([o.aL[0], o.aL[1], o.aR[0], o.aR[1]], i * 4); a1.set([o.lean, o.roll, o.hp, o.hy], i * 4); a2.set([o.bob, o.sq, o.pa, o.pb], i * 4);
      meterAt.set([o.pos[0], o.pos[1] + 1.3 * p.scale, o.pos[2]], i * 3);
      a3.set([o.gait, o.gAmp, lastFront([o.pos[0], o.pos[1] + 1.3 * p.scale, o.pos[2]], t), o.pc], i * 4);
      kindAttr.array[i * 4 + 1] = o.prop ?? p.prop; }
    mesh.instanceMatrix.needsUpdate = true; attrs.forEach(a => a.needsUpdate = true); kindAttr.needsUpdate = true; }
    // the cloth: carried on twos (57-70.5), caught and lowered on ones
    if (clothU) { const c = cloth(t >= 57 && t < 70.5 ? A.held(t) : t); clothU.uCl0.value.set(c.c[0], c.c[1], c.c[2], c.R); clothU.uCl1.value.set(c.dip, c.sag, c.billow, c.lowered); clothU.uCl2.value.set(c.dir[0], c.dir[1], c.dx, c.dz); clothU.uClVis.value = c.vis; }
  }

  const api = F.crowd = {
    standIn: false,
    steps(scene) { return [['마을 사람들을 모으는 중', () => { buildCrowd(scene); buildCloth(scene); plan(); laughBeads(); update(0); }]]; },
    update(t) { update(t); },
    pose: (i, t) => pose(i, t, PO()), people, laughs, stomps, cloth, N,
    // where a villager's head is at time t (for emitters)
    head(i, t) { const o = pose(i, t, PO()); return [o.pos[0], o.pos[1] + 1.45 * people[i].scale * (people[i].kid ? .7 : 1), o.pos[2]]; },
    get mesh() { return mesh; }, get clothMesh() { return clothMesh; },
  };

  // ---------------------------------------------------------------- test views
  // each k is a moment (time + camera); the view re-poses the modules at that time so one sheet can show several moments
  const at = (tk) => { F.U.uTime.value = tk; F.U.uHeld.value = A.held(tk); for (const m of ['world', 'life', 'rain', 'cast', 'crowd']) { const M = F[m]; if (M && M.update) try { M.update(tk, 1 / 60, F.three && F.three.cam); } catch (e) { } } };
  F.test = F.test || {};
  // crowd: k 0 Cistern Row from the S03 camera as the toy bell jingles (13.58), k 1 the fan teams sweeping (27.3),
  // k 2 the hoods turning east (39.4), k 3 the laughing crowd round Pell and Dun (84.2). Both views turn the stand-in on.
  F.test.crowd = (k, s) => { api.standIn = true; const C = F.cam;
    if (k === 0) { const tk = 13.5 + 1 / 12; at(tk); const th = -1.555 - .065 * (tk - 12) / 6, r = lerp(V.ringR(5, th) + 1.2, V.ringR(6, th) - 1.5, .02), pos = [Math.cos(th) * r, V.ground(Math.cos(th) * r, Math.sin(th) * r) + 1.25, Math.sin(th) * r];
      E.shadowFit(new THREE.Vector3(...P.kid), 18); return { cam: { pos, look: add(P.kid, [0, .6, 0]), fov: C.mm(50) }, look: { focus: 5.5, ap: .006, edge: .5 } }; }
    if (k === 1) { const tk = 27.3; at(tk); const mid = P.fans(tk)[8].pos; E.shadowFit(new THREE.Vector3(...mid), 30);
      return { cam: { pos: C.orbit(mid, 20, -2.15, .32), look: add(mid, [4, 2.2, 3]), fov: C.mm(35) }, look: { rays: .3 } }; }
    if (k === 2) { const tk = 39.4; at(tk); const c = T9(-.6, .35); E.shadowFit(new THREE.Vector3(...c), 40);
      return { cam: { pos: add(c, [-26, 9, -16]), look: add(c, [8, 1, 10]), fov: C.mm(30) }, look: {} }; }
    const tk = 84.2; at(tk); const pell = add(P.pell(tk).pos, [0, 1, 0]), dun = add(P.dun(tk).pos, [0, 1.1, 0]), mid = C.v(pell, dun, .4);
    E.shadowFit(new THREE.Vector3(...mid), 30);
    return { cam: { pos: add(mid, [-8.5, 2.2, -2.5]), look: add(mid, [0, .2, 0]), fov: C.mm(50) }, look: { focus: 8, ap: .005 } };
  };
  // cloth: braced (72.9), the catch (73.15), riding it (73.5)
  F.test.cloth = (k, s) => { api.standIn = true; const tk = [72.9, 73.15, 73.5][k] ?? s.t; at(tk); const C = F.cam;
    E.shadowFit(new THREE.Vector3(...CL), 14);
    return { cam: { pos: add(CL, [-7.2, 1.9, 4.6]), look: add(CL, [0, .1, 0]), fov: C.mm(35) }, look: { focus: 8.5, ap: .004, live: 1 } };
  };
})();
