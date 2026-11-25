// cast.js - the three characters of STILLRAIN: Pell (the hero, the only close-up character), Tock (her tock bird) and
// Old Dun (the head toller). FILM.cast builds them once at load and poses them for any film time t.
//
// How they are built. Every body is sculpted with FILM.sculpt: capsules and ellipsoids merged by a smooth union, then meshed
// with surface nets. Pell and Dun each have a 15-bone skeleton (hips, chest, neck, two arms, two legs) and are one SkinnedMesh
// each, whose skin weights come from the bone each sculpted part names. Heads, Pell's hood and the props are rigid meshes that
// ride on the bones. Pell's face is not a texture: it is drawn in the head's fragment shader in head-local metres (eyes, lash
// line, highlights, brows, mouth keys, freckles, blush hatch), so it stays crisp at any size; when an eye is only a few pixels
// wide it turns into a dot. Dun's face is drawn the same way with fewer strokes. Every material is cel() below (E.toon plus a
// mid light band, paint grain that sticks to the body and wet darkening), and every mesh gets an inverted-hull ink line.
//
// How they move. Everything is a pure function of film time. A pose is a plain object in character space (feet at the origin,
// facing +z, +x is the character's left). pellPose() starts from basePose(), lets the state FILM.path.pell gives (run, leap,
// bell ...) fill it in (STATES), applies the shot's options, then puts it on the rig in applyPell(): two-bone IK for arms and
// legs, a look-at shared by the neck and the eyes. Bodies are posed at held time (FILM.anim.held: 12 drawings a second, "on
// twos"). The cape, the fringe lock, the hood tassels and the bead string move every frame ("on ones") in secondary(): they
// lag analytically behind her path velocity (no verlet, no history, so any frame can be drawn on its own), and the tassels
// and beads shiver when a sound front from film/events.js passes her (the clothing meter, bible M17).
//
// Public API at a glance (every option is in film/CAST.md):
//   FILM.cast.update(t)           pose all three with the default choreography (main.js calls it every frame)
//   FILM.cast.pellPose(t, opts)   pose Pell (follows FILM.path.pell unless opts say otherwise) -> the pose object
//   FILM.cast.tockPose(t, opts)   pose Tock (on the staff's crook by default) -> his plan for that moment
//   FILM.cast.dunPose(t, opts)    pose Old Dun (follows FILM.path.dun) -> the pose object
//   FILM.cast.pell / .tock / .dun the built meshes and the anchors (Object3D) cameras aim at: root, head, eye, handL, crook ...
//   FILM.cast.EXPR / .MOUTH / .PAL expression keys, mouth keys, the palette;  FILM.cast.steps(scene) the build steps
// Reads: FILM.anim (easing, held time), FILM.engine (toon, outline), FILM.sculpt, FILM.path (positions, states, the gust),
// FILM.valley (places), FILM.events (sound arrivals for the meter), FILM.three.scene and FILM.U (shared uniforms).
// See it (after python tools/build.py): node tools/shot.mjs --test pell --k 0,1,2,3,4,5 --cols 3 --w 640 --out build/cast-pell.jpg
//   (the test views pell, face, tock and dun are listed at the end of this file).
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim, E = F.engine, V = F.valley, P = F.path, EV = F.events, S = F.sculpt;
  const { clamp, lerp, sm, keys, TAU } = A;
  // small helpers: [x, y, z] array maths (poses are plain arrays), ramp(x, a, b, ease) = eased 0..1 between a and b
  // (the ease names are FILM.anim.ease: io, out, snap, antic ...)
  const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k], mix3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  const len3 = a => Math.hypot(a[0], a[1], a[2]), nrm3 = a => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const ramp = (x, a, b, e = 'io') => A.ease[e](clamp((x - a) / (b - a)));
  const G = h => { const c = new THREE.Color(h); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; };   // sRGB hex -> linear GLSL literal
  // rotate a vector about y (character yaw): local -> world and back
  const yawV = (v, y) => [v[0] * Math.cos(y) + v[2] * Math.sin(y), v[1], -v[0] * Math.sin(y) + v[2] * Math.cos(y)];

  // ------------------------------------------------------------------ palette (bible §3)
  const PAL = {
    skin: '#F6DCC4', hair: '#3E2422', hairHi: '#8E5A4A', hood: '#E4572E', lining: '#6F9A3B', cape: '#2F3E7A', stitch: '#C98B2E',
    tunic: '#EFE6D2', trousers: '#6F8A4A', boots: '#CDB892', bootCuff: '#E2D4B2', sole: '#6B5A48', staff: '#B08A5A', brass: '#D9A43A',
    mitten: '#6F9A3B', tassel: '#6F8A4A', bead: '#C8F1FF', tie: '#6F9A3B', ink: '#3A1F33', hoodInk: '#8A2A1A',
    tock: '#7EC8F0', tockBelly: '#F4F8FF', tockWing: '#5AAEE0', beak: '#F2A65A', tockInk: '#2B2E5C',
    dunSkin: '#EDC8A8', dunHair: '#B8B4AE', shawl: '#C98B2E', patch: '#2F3E7A', robe: '#6B5A3A', hide: '#E3CFA6', hoop: '#8A3B2A',
    drumWood: '#7A4E34', felt: '#CDB892', strap: '#7A4A2E', dunInk: '#3B2630',
  };

  // ------------------------------------------------------------------ materials
  // A cast material is E.toon plus: paint grain in object space (so it sticks to a moving body instead of swimming in world
  // space), a third cel band, a saturation lift in shadow (never grey), and wet cloth darkening. The bands (bible §8 asks for
  // lit above N.L .45, mid .10-.45 at 40% shadow, shadow below .10): cel() shifts N.L by wrap -.1, so the lit/shadow edge sits
  // at N.L .10, and the mid band (midAt .33 after the shift) ends at N.L .43. vON / vId are the rest normal and the part id
  // (the sculpt tag, or the merge() id, of the part that owns the vertex).
  const CAST_FPARS = /* glsl */`
varying vec3 vON; varying float vId; uniform float uPaintS, uPaintK, uMidAt, uMidK, uWetK;
float cov(float d){ float w = max(fwidth(d), 1e-7); return clamp(0.5 - d / w, 0.0, 1.0); }      // anti-aliased inside test, d < 0 inside
// distance to a stroke from a to b whose radius tapers from ra to rb (a brush stroke with a tapered tail)
float sdSegT(vec2 p, vec2 a, vec2 b, float ra, float rb){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - mix(ra, rb, h); }
vec2 rot2(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
// lay the colour k over c with coverage a (0..1): every face stroke is drawn with this
void inkp(inout vec3 c, vec3 k, float a){ c = mix(c, k, clamp(a, 0.0, 1.0)); }
`;
  const PAINT = /* glsl */`
  // paint grain: tri-planar noise and a fine grain in object space (vOP), scaled by uPaintS (per metre); wet cloth is 20% darker
  { vec3 onr = normalize(vON + vec3(1e-5)); float pn = tri3(vOP * uPaintS, onr, 1.0); float gr = grain(vOP.xy * 21.0 + vOP.zx * 13.0);
    base *= 1.0 + (pn - 0.5) * uPaintK + (gr - 0.5) * uPaintK * 0.7; base *= 1.0 - uWetK * 0.2; }`;
  const MID = /* glsl */`
  // the mid band: lit pixels whose (wrapped) N.L is below uMidAt get 40% of the shadow colour; then +14% saturation in shadow
  { float mb = lit * (1.0 - smoothstep(uMidAt - 0.02, uMidAt + 0.02, ndl)) * uMidK;
    c = mix(c, mix(base * uSunCol, shadeC, 0.4), mb);
    float sl = dot(c, vec3(0.299, 0.587, 0.114)); c = mix(c, mix(vec3(sl), c, 1.14), 1.0 - lit); }`;
  // cel(o): any E.toon option, plus paintS (grain scale), paintK (grain strength), midAt / mid (where the mid band ends, and how
  // strong it is, 0..1), wetU (a shared { value } uniform 0..1, so one write wets every material that holds it) and shadeRGB
  // (a multiplier on the shadow colour, to shift each material's shadow hue). E.toon's own world-space paint is turned off.
  function cel(o = {}) {
    const u = Object.assign({ uPaintS: { value: o.paintS ?? 6 }, uPaintK: { value: o.paintK ?? .1 }, uMidAt: { value: o.midAt ?? .33 }, uMidK: { value: o.mid ?? 1 },
      uWetK: o.wetU || { value: 0 } }, o.uniforms || {});
    const m = E.toon(Object.assign({ rim: .3 }, o, { paint: 0, wrap: o.wrap ?? -.1, soft: o.soft ?? .016, uniforms: u,
      vpars: 'varying vec3 vON; attribute float aId; varying float vId;\n' + (o.vpars || ''),
      vnormal: 'vON = objectNormal; vId = aId;\n' + (o.vnormal || ''),
      fpars: CAST_FPARS + (o.fpars || ''), fpre: PAINT + (o.fpre || ''), fpost: MID + (o.fpost || '') }));
    if (o.shadeRGB) m.uniforms.uShadeM.value.setRGB(...o.shadeRGB);
    return m;
  }
  // shadows on, culling off (bones, instances and the per-frame cape move vertices outside the bind-pose bounds)
  const prepMesh = (m, cast = true) => { m.castShadow = cast; m.receiveShadow = true; m.frustumCulled = false; return m; };
  // the ink line: px is its width in pixels at 1080p, max caps it in metres so a far character's line stays thin
  const ink = (m, color, px = 1.8, max = .012) => { const l = E.outline(m, { color, px, max }); l.frustumCulled = false; return l; };

  // a few three.js shapes merged into one geometry with a colour and a part id per piece (one draw call)
  function merge(items) {
    let nv = 0, ni = 0; for (const it of items) { nv += it.g.attributes.position.count; ni += it.g.index.count; }
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), colA = new Float32Array(nv * 3), ids = new Float32Array(nv), uvs = new Float32Array(nv * 2), idx = new Uint32Array(ni);
    let vo = 0, io = 0; const c = new THREE.Color();
    for (const it of items) { const g = it.g, n = g.attributes.position.count; pos.set(g.attributes.position.array.subarray(0, n * 3), vo * 3); nrm.set(g.attributes.normal.array.subarray(0, n * 3), vo * 3);
      if (g.attributes.uv) uvs.set(g.attributes.uv.array.subarray(0, n * 2), vo * 2);
      c.set(it.col || '#ffffff'); for (let i = 0; i < n; i++) { colA[(vo + i) * 3] = c.r; colA[(vo + i) * 3 + 1] = c.g; colA[(vo + i) * 3 + 2] = c.b; ids[vo + i] = it.id || 0; }
      const gi = g.index.array; for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo; vo += n; io += gi.length; }
    const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setAttribute('color', new THREE.BufferAttribute(colA, 3)); out.setAttribute('aId', new THREE.BufferAttribute(ids, 1)); out.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));
    out.setIndex(new THREE.BufferAttribute(idx, 1)); out.computeBoundingSphere(); return out;
  }
  // a sheet with thickness that wraps round in a: fn(a, v) -> [x, y, z] on its mid-surface (a -PI..PI, v 0..1), th(v) its thickness.
  // Outer, inner and the two edge bands share vertices, so normals round the edges. col(side, v) -> [hex, id] colours each side.
  // NA points round, NV rows down. The hood shell, the hood brim and Dun's shawl are sheets: much cheaper than sculpting them,
  // and the thickness gives the inverted-hull ink line a closed surface to work with.
  function sheetGeo(NA, NV, fn, th, col) {
    // the mid-surface points, then a normal at each from central differences (wrapping round in a)
    const M = [], N3 = []; for (let j = 0; j <= NV; j++) for (let i = 0; i < NA; i++) M.push(fn(i / NA * TAU - Math.PI, j / NV));
    const at = (i, j) => M[j * NA + ((i % NA) + NA) % NA];
    for (let j = 0; j <= NV; j++) for (let i = 0; i < NA; i++) { const du = sub3(at(i + 1, j), at(i - 1, j)), dv = sub3(at(i, Math.min(NV, j + 1)), at(i, Math.max(0, j - 1)));
      const n = [dv[1] * du[2] - dv[2] * du[1], dv[2] * du[0] - dv[0] * du[2], dv[0] * du[1] - dv[1] * du[0]], l = len3(n); N3.push(l > 1e-9 ? mul3(n, 1 / l) : [0, 1, 0]); }
    // two copies of the grid, pushed half the thickness out (side 0, outer) and in (side 1, inner) along the normal
    const nM = M.length, pos = new Float32Array(nM * 6), colA = new Float32Array(nM * 6), ids = new Float32Array(nM * 2), uv = new Float32Array(nM * 4), idx = [], c = new THREE.Color();
    for (let side = 0; side < 2; side++) for (let j = 0; j <= NV; j++) for (let i = 0; i < NA; i++) { const k = j * NA + i, o = side * nM + k, t = th(j / NV) * (side ? -.5 : .5), m = M[k], n = N3[k];
      pos[o * 3] = m[0] + n[0] * t; pos[o * 3 + 1] = m[1] + n[1] * t; pos[o * 3 + 2] = m[2] + n[2] * t;
      const [hx, id] = col(side, j / NV); c.set(hx); colA[o * 3] = c.r; colA[o * 3 + 1] = c.g; colA[o * 3 + 2] = c.b; ids[o] = id; uv[o * 2] = i / NA; uv[o * 2 + 1] = j / NV; }
    // triangles: the outer and inner faces (opposite winding), then bands joining them along the last and first rows
    const V = (i, j, side) => side * nM + j * NA + ((i % NA) + NA) % NA;
    for (let j = 0; j < NV; j++) for (let i = 0; i < NA; i++) { const a = V(i, j, 0), b = V(i + 1, j, 0), cc = V(i, j + 1, 0), d = V(i + 1, j + 1, 0); idx.push(a, cc, b, b, cc, d);
      const a2 = V(i, j, 1), b2 = V(i + 1, j, 1), c2 = V(i, j + 1, 1), d2 = V(i + 1, j + 1, 1); idx.push(a2, b2, c2, b2, d2, c2); }
    for (let i = 0; i < NA; i++) { const oA = V(i, NV, 0), oB = V(i + 1, NV, 0), iA = V(i, NV, 1), iB = V(i + 1, NV, 1); idx.push(oA, iA, oB, oB, iA, iB);
      const pA = V(i, 0, 0), pB = V(i + 1, 0, 0), qA = V(i, 0, 1), qB = V(i + 1, 0, 1); idx.push(pA, pB, qA, pB, qB, qA); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(colA, 3));
    g.setAttribute('aId', new THREE.BufferAttribute(ids, 1)); g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere(); return g;
  }
  const lathe = (pts, seg, a0 = 0, al = TAU) => new THREE.LatheGeometry(pts.slice().reverse().map(([r, y]) => new THREE.Vector2(r, y)), seg, a0, al);   // profiles are written top to bottom; three wants them bottom up

  // ------------------------------------------------------------------ rigs: bones from rest positions, two-bone IK
  // Every bone rests with identity rotation; a pose only turns bones (and moves the hips). Arms and legs are solved by ik().
  function makeRig(defs) {   // defs: [[name, parentName | null, [x, y, z] rest position in character space]]
    const bones = {}, list = [], rest = {};
    for (const [n, p, pos] of defs) { const b = new THREE.Bone(); b.name = n; bones[n] = b; list.push(b); rest[n] = pos;
      if (p) { bones[p].add(b); const q = rest[p]; b.position.set(pos[0] - q[0], pos[1] - q[1], pos[2] - q[2]); } else b.position.set(...pos); }
    return { bones, list, rest, index: Object.fromEntries(list.map((b, i) => [b.name, i])) };
  }
  // scratch objects, reused every frame so posing allocates little
  const _a = v3(), _b = v3(), _c = v3(), _d = v3(), _e = v3(), _f = v3(), _g = v3(), _h = v3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _eu = new THREE.Euler();
  // turn a bone (whose rest rotation is identity) so that its child offset points along dirW (world)
  function aimBone(bone, childLocal, dirW) {
    bone.parent.getWorldQuaternion(_q).invert();
    _g.copy(dirW).normalize().applyQuaternion(_q); _h.copy(childLocal).normalize();
    bone.quaternion.setFromUnitVectors(_h, _g); bone.updateMatrixWorld(true);
  }
  // two-bone IK: up -> lo -> end reaches the world point T; the middle joint bends toward the world direction pole.
  // The bone lengths L1, L2 and the reach d make a triangle (law of cosines): a is how far along the root->target line the
  // middle joint sits, h how far off that line. A target out of reach is clamped, so the limb straightens toward it.
  function ik(up, lo, end, T, pole) {
    up.parent.updateWorldMatrix(true, false); up.updateMatrixWorld(true);
    const Sp = up.getWorldPosition(_a), L1 = lo.position.length(), L2 = end.position.length();
    _b.subVectors(T, Sp); let d = _b.length(); _b.divideScalar(d || 1);
    d = clamp(d, Math.abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4);
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // the bend direction: the pole made perpendicular to the root->target line
    _c.copy(pole).addScaledVector(_b, -pole.dot(_b)); if (_c.lengthSq() < 1e-8) _c.set(0, 0, 1); _c.normalize();
    _d.copy(Sp).addScaledVector(_b, a).addScaledVector(_c, h);    // the elbow / knee
    _e.copy(Sp).addScaledVector(_b, d);                            // where the wrist / ankle ends up
    aimBone(up, lo.position, _f.subVectors(_d, Sp));
    aimBone(lo, end.position, _f.subVectors(_e, _d));
  }
  // set a bone's world rotation (used to keep feet flat and to turn hands)
  function setWorldQ(bone, qW) { bone.parent.getWorldQuaternion(_q2).invert(); bone.quaternion.copy(_q2).multiply(qW); bone.updateMatrixWorld(true); }
  // set a bone's local rotation from [x, y, z] radians in YXZ order: x pitches (+ tips a +z-facing part forward and down),
  // y turns (+ toward the character's left), z tilts
  const setE = (bone, e) => { bone.quaternion.setFromEuler(_eu.set(e[0], e[1], e[2], 'YXZ')); };

  // ------------------------------------------------------------------ the clothing meter (bible M17)
  // angle 0.25 e^(-8 tau) sin(2 pi 11 tau) at every sound front that has reached p, plus a steady shiver while a held note sounds.
  // tau is the time since that front arrived (FILM.events.arrivals: sound travels 30 m/s from each toll). The result is a small
  // angle in radians, clamped to +-0.4, that the tassels, beads, cape and fringe add to their swing in secondary().
  function meter(p, t) { let a = 0;
    for (const { e, ta } of EV.arrivals(p, t)) { const tau = t - ta; if (tau > 1.5 + e.dur) continue;
      a += .25 * Math.exp(-8 * tau) * Math.sin(TAU * 11 * tau);
      if (e.dur > .6) a += .08 * Math.sin(TAU * 11 * tau + 1.3) * sm(0, .25, tau) * (1 - sm(e.dur - .2, e.dur + .1, tau)); }
    return clamp(a, -.4, .4); }

  // ================================================================== PELL
  // character space: feet at the origin, facing +z, her left is +x, metres. The head centre is 1.13 m up and the hood's crown
  // about 1.35 m (path.js uses the bible's 1.38 m as PELL_H); the hooded head is about a quarter of her height.
  // PJ: the joints' rest positions (left side written out, the right mirrored); PDEF: each bone's parent.
  const PJ = (() => { const j = { hips: [0, .58, 0], chest: [0, .78, -.005], neck: [0, .965, -.012],
      armL: [.118, .925, -.01], foreL: [.136, .745, -.014], handL: [.143, .585, -.002], legL: [.066, .545, 0], shinL: [.07, .31, .012], footL: [.072, .095, -.004] };
    for (const k of ['arm', 'fore', 'hand', 'leg', 'shin', 'foot']) { const p = j[k + 'L']; j[k + 'R'] = [-p[0], p[1], p[2]]; } return j; })();
  const PDEF = [['hips', null], ['chest', 'hips'], ['neck', 'chest'], ['armL', 'chest'], ['foreL', 'armL'], ['handL', 'foreL'], ['armR', 'chest'], ['foreR', 'armR'], ['handR', 'foreR'],
    ['legL', 'hips'], ['shinL', 'legL'], ['footL', 'shinL'], ['legR', 'hips'], ['shinR', 'legR'], ['footR', 'shinR']].map(([n, p]) => [n, p, PJ[n]]);
  const HEAD_OFF = [0, .165, .018];          // head centre from the neck bone
  // angles round the hood: a = 0 in front (+z), +PI/2 at her left (+x). Head space, metres.
  const rimR = a => .278 - .03 * Math.max(Math.cos(a), 0) ** 2;   // the drip-brim's radius round the hood (narrower in front)
  const rimY = a => .022 - .014 * Math.max(0, -Math.cos(a));      // and its edge height (it droops a little at the back)

  // the sculpted body: { f (signed distance), col, bone (index, via ix = rig.index), k (how softly it blends into the parts
  // before it, metres) }. Character space at rest. One mesh holds tunic, skin, trousers and boots; colours blend where parts meet.
  function pellBodyParts(ix) {
    const C = PAL, out = [], add = (f, col, bone, k = .03) => out.push({ f, col, bone: ix[bone], k });
    add(S.ell([0, .86, -.008], [.102, .095, .076]), C.tunic, 'chest');
    add(S.ell([0, .73, -.002], [.092, .09, .072]), C.tunic, 'chest', .05);
    add(S.ell([0, .6, 0], [.098, .072, .078]), C.tunic, 'hips', .05);
    add(S.cut(S.cap([0, .68, 0], [0, .47, .005], .1, .13), (x, y, z) => y - .5, .004), C.tunic, 'hips', .03);   // a short flared tunic skirt, a flat hem
    add(S.cap([0, .9, -.012], [0, .995, -.012], .029), C.skin, 'neck', .03);
    add(S.ell([0, .975, .07], [.007, .011, .006]), C.stitch, 'chest', .003);           // the cape's toggle
    // per side: sleeves, a moss cuff, the hand and thumb, trouser legs, a felt boot (shaft, toe, sole) and its turned-down cuff
    for (const s of [1, -1]) { const L = s > 0 ? 'L' : 'R', J = n => PJ[n + L];
      add(S.cap(J('arm'), J('fore'), .04, .034), C.tunic, 'arm' + L, .035);
      add(S.cap(J('fore'), J('hand'), .033, .031), C.tunic, 'fore' + L, .02);
      add(S.torus(add3(J('hand'), [0, .03, 0]), .029, .0055), C.lining, 'fore' + L, .004);   // moss cuff
      add(S.ell(add3(J('hand'), [s * .002, -.04, .006]), [.027, .036, .022]), C.skin, 'hand' + L, .012);
      add(S.cap(add3(J('hand'), [-s * .012, -.02, .018]), add3(J('hand'), [-s * .017, -.046, .026]), .0105, .009), C.skin, 'hand' + L, .008);
      add(S.cap(add3(J('leg'), [0, -.01, 0]), J('shin'), .06, .05), C.trousers, 'leg' + L, .006);
      add(S.cap(J('shin'), add3(J('foot'), [0, .05, 0]), .05, .046), C.trousers, 'shin' + L, .02);
      const f = J('foot');
      add(S.ell(add3(f, [0, -.005, .02]), [.06, .075, .082]), C.boots, 'foot' + L, .03);
      add(S.ell(add3(f, [0, -.048, .08]), [.055, .046, .062]), C.boots, 'foot' + L, .03);
      add(S.ell(add3(f, [0, -.08, .035]), [.062, .018, .104]), C.sole, 'foot' + L, .01);
      add(S.torus(add3(f, [0, .066, 0]), .05, .015), C.bootCuff, 'shin' + L, .004); }
    return out;
  }
  // the head, in head space (origin at the head centre, face toward +z). tag becomes the vertex's aId, which the shaders read:
  // 1 skin (the face is drawn on it), 2 hair (the angel ring), 3 the braid ties.
  // Skull, the lower face, two cheek masses, chin, a neck stub and a tiny nose bump.
  function pellHeadParts() {
    const C = PAL, H = [], add = (f, col, tag, k = .03) => H.push({ f, col, tag, k });
    add(S.sph([0, .012, -.01], .112), C.skin, 1);
    add(S.ell([0, -.03, .02], [.09, .085, .085]), C.skin, 1, .05);
    for (const s of [1, -1]) add(S.ell([s * .048, -.055, .045], [.05, .042, .05]), C.skin, 1, .04);
    add(S.ell([0, -.096, .04], [.03, .021, .03]), C.skin, 1, .05);
    add(S.cap([0, -.07, -.02], [0, -.16, -.022], .03), C.skin, 1, .03);
    add(S.ell([0, -.043, .1], [.0065, .010, .009]), C.skin, 1, .012);
    // hair: a cap over the skull, cut back from the face (the hood hides most of it); two short looped braids by the jaw
    const hairCap = S.inter(S.sph([0, .022, -.016], .119), (x, y, z) => Math.min(z - .03, .058 - y)); hairCap.b = [0, .022, -.016, .12];
    add(hairCap, C.hair, 2, .008);
    for (const s of [1, -1]) { add(S.torus([s * .094, -.112, -.036], .021, .0105, 'x'), C.hair, 2, .01); add(S.sph([s * .094, -.09, -.036], .0105), C.tie, 3, .006); }
    return H;
  }
  // the hood: a rounded shell (a sheet round HOOD_C, radii HOOD_R) plus the wide drip-brim, both thick sheets in head space.
  // Ids: 1 the persimmon outside, 2 the moss lining inside the shell, 3 the brim's underside (also lining).
  const HOOD_C = [0, .045, -.01], HOOD_R = [.172, .172, .174];
  const hoodPinch = y => 1 - .3 * sm(.02, -.17, y);                // the lower shell narrows (up to 30%) to hug the neck
  const hoodEdgeY = a => .058 - .21 * sm(.35, 2.0, Math.abs(a));     // the shell's lower edge: brow height in front, the neck behind
  function hoodGeo() {
    // shell: v runs from the crown (v 0) down to the lower edge; thickness 18 mm, thinner at the edge.
    // brim: an annulus from r .14 at brow height out to rimR(a), sagging a little between; 22 mm thick at the root, 9 at the edge
    const shell = sheetGeo(64, 16, (a, v) => { const tb = Math.acos(clamp((hoodEdgeY(a) - HOOD_C[1]) / HOOD_R[1], -.995, .995)), t = tb * v;
        const y = HOOD_C[1] + Math.cos(t) * HOOD_R[1] - .009, k = hoodPinch(y); return [Math.sin(t) * Math.sin(a) * (HOOD_R[0] - .009) * k, y, HOOD_C[2] + Math.sin(t) * Math.cos(a) * (HOOD_R[2] - .009) * k]; },
      v => .018 * (1 - .4 * sm(.9, 1, v)), (side, v) => side ? [PAL.lining, 2] : [PAL.hood, 1]);
    const brim = sheetGeo(72, 6, (a, v) => { const ax = .14, ay = .058, bx = rimR(a), by = rimY(a), r = lerp(ax, bx, v), y = lerp(ay, by, v) - .004 * Math.sin(v * Math.PI);
        return [Math.sin(a) * r, y, Math.cos(a) * r]; }, v => lerp(.022, .009, v), (side, v) => side ? [PAL.lining, 3] : [PAL.hood, 1]);
    const parts = [shell, brim].map(g => ({ g, col: null }));
    // merge keeping each vertex's own colour and id (merge() above would paint each piece one colour)
    let nv = 0, ni = 0; for (const { g } of parts) { nv += g.attributes.position.count; ni += g.index.count; }
    const out = new THREE.BufferGeometry(), names = ['position', 'normal', 'color', 'aId', 'aUv'], arr = {}, idx = new Uint32Array(ni); let vo = 0, io = 0;
    for (const k of names) arr[k] = new Float32Array(nv * parts[0].g.attributes[k].itemSize);
    for (const { g } of parts) { for (const k of names) arr[k].set(g.attributes[k].array, vo * g.attributes[k].itemSize); const gi = g.index.array; for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo; vo += g.attributes.position.count; io += gi.length; }
    for (const k of names) out.setAttribute(k, new THREE.BufferAttribute(arr[k], parts[0].g.attributes[k].itemSize)); out.setIndex(new THREE.BufferAttribute(idx, 1)); out.computeBoundingSphere(); return out;
  }

  // ---- the face, drawn in head-local space (metres; the face looks down +z, her left is +x)
  // Each feature is a function of q = the head-space (x, y) of the pixel: shapes are signed distances turned into anti-aliased
  // coverage by cov() and laid on with inkp(), so the strokes stay sharp at any distance. pellPose() fills the uniforms below
  // from the expression and mouth keys. detail (0..1) fades the fine strokes out when the face is small on screen.
  const FACE_PARS = /* glsl */`
uniform vec4 uEyeA;    // lid left, lid right (0 open .. 1 shut), gaze x, gaze y
uniform vec4 uEyeB;    // wide (stunned: small pupils), happy (shut eyes arch like ^), sparkle, dull
uniform vec4 uBrowA;   // raise, furrow, sad
uniform vec4 uMouthA;  // open 0..1, half width (m), top roundness, smile
uniform vec4 uMouthB;  // teeth, -, -, -
uniform vec4 uCheekA;  // blush, freckles, -, force dot eyes
// one eye; s = +1 her left eye, -1 her right. Centre (+-39 mm, -18 mm), half size 19 x 24 mm.
void pellEye(inout vec3 c, vec2 q, float s, float detail){
  float lid = s > 0.0 ? uEyeA.x : uEyeA.y; float wide = uEyeB.x, happy = uEyeB.y;
  vec2 ec = vec2(s * 0.039, -0.018), sz = vec2(0.0192, 0.0238) * (1.0 + 0.07 * wide);
  vec2 e = (q - ec) / sz; e.x *= s; float x = e.x;                  // eye units, +x toward the outer corner
  // the lids, as heights in eye units: uO the open upper lid, uS the shut line, uH the happy arch; lid 0..1 lowers the upper
  // lid, and from lid .7 the lower lid rises to meet it
  float uO = 0.88 - 0.30 * x * x - 0.12 * x, uS = -0.34 - 0.16 * (1.0 - x * x), uH = -0.30 + 0.46 * (1.0 - x * x);
  float yU = mix(uO, mix(uS, uH, happy), lid);
  float yL = mix(-0.96 + 0.36 * x * x + 0.06 * x, yU - 0.04, smoothstep(0.7, 1.0, lid));
  // the eye white: a superellipse (|x|^2.6 + |y|^2.6 = 1) cut by both lids; dW < 0 inside. It fades out as the eye shuts.
  float px = pow(abs(x), 2.6), se = pow(px + pow(abs(e.y), 2.6), 0.3846) - 1.0, seTop = pow(max(1.0 - px, 0.0), 0.3846);
  float top = min(yU, seTop);
  float dW = max(max(se, e.y - yU), yL - e.y);
  float aW = cov(dW) * (1.0 - smoothstep(0.86, 0.97, lid)) * detail;
  vec3 col = mix(${G('#FFFBF2')}, ${G('#D6C7E2')}, smoothstep(top - 0.55, top - 0.05, e.y));
  // iris: dark umber at the top, amber band, honey at the bottom; a darker ring; the pupil; a glow low in the iris
  vec2 ic = vec2(uEyeA.z * 0.30 * s, -0.12 + uEyeA.w * 0.22), ir = vec2(0.66, 0.84) * (1.0 - 0.3 * wide);
  vec2 ip = (e - ic) / ir; float rI = length(ip);
  vec3 iris = mix(${G('#E8A53A')}, ${G('#9A5A1E')}, smoothstep(0.0, 0.75, ip.y));
  iris = mix(iris, ${G('#F6C66A')}, smoothstep(-0.1, -0.8, ip.y));
  iris = mix(iris, ${G('#6E3818')}, smoothstep(0.80, 0.94, rI));
  float pu = cov(length((e - ic - vec2(0.0, 0.08)) / (vec2(0.25, 0.37) * (1.0 - 0.6 * wide))) - 1.0);
  float glow = cov(length((e - ic - vec2(0.0, -0.46)) / (ir * vec2(0.6, 0.34))) - 1.0);
  iris = mix(iris, ${G('#FFE7A6')}, glow * 0.4 * (1.0 - pu));
  iris = mix(iris, ${G('#3B1A1E')}, pu);
  iris *= mix(1.0, 0.56, smoothstep(top - 0.5, top - 0.14, e.y));    // the lid's shadow over the top of the iris
  col = mix(col, iris, cov(rI - 1.0));
  // highlights: on the same screen side for both eyes (the viewer's upper left is head -x)
  vec2 hp = vec2((q.x - ec.x) / sz.x - uEyeA.z * 0.30, e.y - ic.y); float dl = 1.0 - 0.55 * uEyeB.w;
  float h1 = length(rot2(hp - vec2(-0.30, 0.30), 0.5) / (vec2(0.19, 0.27) * dl)) - 1.0;
  float h2 = length((hp - vec2(0.30, -0.40)) / (vec2(0.09) * dl)) - 1.0;
  float h3 = length((hp - vec2(-0.06, -0.56)) / vec2(0.055)) - 1.0;
  float aH = max(max(cov(h1), cov(h2)), cov(h3) * uEyeB.z) * cov(rI - 1.06);
  col = mix(col, vec3(1.0), aH);
  inkp(c, col, aW);
  // a hairline round the bottom of the white, very light
  inkp(c, ${G('#B98A92')}, cov(abs(dW + 0.03) - 0.03) * step(e.y, -0.2) * 0.35 * aW);
  // lower lash: two soft strokes under the outer half
  float lo = min(sdSegT(e, vec2(0.18, -1.04), vec2(0.50, -0.95), 0.05, 0.03), sdSegT(e, vec2(0.64, -0.88), vec2(0.93, -0.70), 0.045, 0.012));
  inkp(c, ${G('#6A3A55')}, cov(lo) * 0.8 * (1.0 - smoothstep(0.45, 0.85, lid)) * detail);
  // upper lash: a thick band riding the top edge, heavier toward the outer corner, ending in a flick
  float th = mix(0.11, 0.30, smoothstep(-0.9, 0.95, x)) * mix(1.0, 0.8, lid);
  float dL = max(abs(e.y - top - th * 0.5) - th * 0.5, abs(x - 0.02) - 1.02);
  float fa = mix(0.72, mix(-0.30, -0.06, happy), lid), fb = mix(0.80, mix(-0.20, -0.34, happy), lid);
  float dF = sdSegT(e, vec2(0.80, fa), vec2(1.32, fb), 0.135, 0.0);
  float dI = sdSegT(e, vec2(-0.98, mix(0.35, -0.3, lid)), vec2(-1.12, mix(0.12, -0.42, lid)), 0.06, 0.0);   // a tiny inner tick
  inkp(c, ${G('#3A1F33')}, cov(min(min(dL, dF), dI)) * detail);
}
// a brow: a short stroke 1.6 eye-heights above the eye, thicker at the inner end. raise lifts it, furrow pulls the inner end
// down, sad lifts the inner end and drops the outer one
void pellBrow(inout vec3 c, vec2 q, float s, float detail){
  vec2 ec = vec2(s * 0.039, -0.018), sz = vec2(0.0192, 0.0238);
  vec2 e = (q - ec) / sz; e.x *= s;
  float x = clamp(e.x, -1.0, 0.9), k = (1.0 - x) * 0.5;      // k = 1 at the inner end
  float yb = 1.6 + 0.16 * (1.0 - x * x) + uBrowA.x * 0.4 - uBrowA.y * 0.55 * k + uBrowA.z * (0.62 * k - 0.22 * (1.0 - k));
  float tk = mix(0.065, 0.14, k);
  float d = max(abs(e.y - yb) - tk, abs(e.x + 0.05) - 0.95);
  inkp(c, ${G('#4A2630')}, cov(d) * 0.95 * detail);
}
// the mouth, centred 70 mm below the head centre; x is in half-widths, bend lifts the corners with the smile
void pellMouth(inout vec3 c, vec2 q, float detail){
  float open = uMouthA.x, w = uMouthA.y, topK = uMouthA.z, smile = uMouthA.w;
  vec2 mc = vec2(0.0, -0.07);
  float x = (q.x - mc.x) / w, x2 = min(x * x, 1.0), sq = sqrt(1.0 - x2);
  float bend = smile * 0.0034 * x * x;
  float isOpen = step(0.04, open);
  // shut: a short tapered line whose corners lift with the smile
  float yl = mc.y + bend - smile * 0.0009;
  float dl = max(abs(q.y - yl) - 0.0013 * (1.0 - 0.6 * x2), (abs(x) - 1.0) * w);
  inkp(c, ${G('#8A3A48')}, cov(dl) * (1.0 - isOpen) * detail);
  // open: a rounded shape, flat-topped for a laugh, round for o and oh; tongue below, teeth above; up to 22 mm tall
  float h = open * 0.022;
  float yT = mc.y + h * topK * 0.5 * sq + bend * (1.0 - 0.5 * topK);
  float yB = mc.y - h * 0.62 * sq + bend * 0.4;
  float dO = max((abs(x) - 1.0) * w, max(q.y - yT, yB - q.y));
  vec3 m = ${G('#6E2438')};
  m = mix(m, ${G('#E07A80')}, 0.9 * cov(length((q - vec2(0.0, yB + h * 0.18)) / vec2(w * 0.6, h * 0.3 + 1e-4)) - 1.0));
  m = mix(m, ${G('#FFF8F2')}, cov((yT - 0.0034) - q.y) * uMouthB.x);
  inkp(c, m, cov(dO) * isOpen * detail);
  inkp(c, ${G('#5A1E33')}, cov(abs(dO + 0.0005) - 0.0005) * isOpen * detail * 0.9);
}
// a cheek: a soft blush oval, diagonal hatch strokes inside it, and five freckles (mirrored to the other side by s)
void pellCheek(inout vec3 c, vec2 q, float s, float detail){
  vec2 cc = vec2(s * 0.051, -0.051);
  float r = length((q - cc) / vec2(0.021, 0.0115));
  inkp(c, ${G('#F7A0A0')}, (1.0 - smoothstep(0.3, 1.0, r)) * 0.32 * uCheekA.x);
  float hx = (q.x * s * 0.8 + q.y) / 0.0046;                        // diagonal strokes leaning outward
  float f = abs(fract(hx + 0.5) - 0.5) * 0.0046 / 1.28;
  inkp(c, ${G('#E86F7A')}, cov(f - 0.00052) * cov((r - 0.8) * 0.01) * 0.55 * uCheekA.x * detail);
  vec2 b = vec2(q.x * s, q.y); float fr = 0.0;
  fr = max(fr, cov(length(b - vec2(0.033, -0.047)) - 0.0015)); fr = max(fr, cov(length(b - vec2(0.041, -0.0435)) - 0.0016));
  fr = max(fr, cov(length(b - vec2(0.049, -0.046)) - 0.0014)); fr = max(fr, cov(length(b - vec2(0.038, -0.0535)) - 0.0013));
  fr = max(fr, cov(length(b - vec2(0.046, -0.054)) - 0.0015));
  inkp(c, ${G('#C9846A')}, fr * 0.8 * uCheekA.y * detail);
}
// the bangs: hair covers everything above the hairline hb, which is scalloped into locks 24.5 mm wide (each hangs to a point
// in its middle) and comes further down at the temples; then its shadow on the forehead, the hair's gradient, a broken
// angel-ring line and an ink edge
void pellBangs(inout vec3 c, vec2 q, float detail){
  float lx = q.x / 0.0245 + 0.42; float tip = 1.0 - abs(fract(lx) - 0.5) * 2.0;     // 1 at the middle of a lock
  float hb = 0.046 - 0.02 * pow(tip, 1.6) - 0.07 * smoothstep(0.058, 0.082, abs(q.x));
  float d = hb - q.y;                                                    // < 0 inside the hair
  inkp(c, ${G('#E6B4A8')}, cov(d - 0.0042) * 0.75);                     // the bangs' shadow on the forehead
  vec3 hc = mix(${G('#4A2B28')}, ${G('#2A1719')}, smoothstep(0.035, 0.065, q.y));
  hc = mix(hc, ${G('#8E5A4A')}, cov(abs(q.y - 0.052 + 0.004 * sin(q.x * 300.0)) - 0.0012) * step(0.5, fract(q.x * 70.0)) * 0.7);
  inkp(c, hc, cov(d));
  inkp(c, ${G('#3A1F33')}, cov(abs(d) - 0.0006) * 0.8 * detail);
}
`;
  // the face pass (fragment, before lighting, so the strokes are lit and shaded like skin): only on skin (id 1) facing front.
  // eyePx is roughly how many pixels wide an eye is; below 7 px the strokes give way to two dot eyes.
  // Order matters: cheeks, nose tick, mouth, eyes, bangs, then the brows on top of the bangs (anime shows brows through hair).
  // Last, the shadow of the chin on the neck is painted in, because the head ignores the shadow map (shadowK 0 in buildPell)
  // so the brim's shadow never hides her eyes.
  const FACE_PRE = /* glsl */`
  { float skinM = 1.0 - smoothstep(0.3, 0.7, abs(vId - 1.0));
    float front = smoothstep(0.02, 0.055, vOP.z) * skinM;
    vec2 q = vOP.xy;
    float eyePx = 0.034 / max(length(fwidth(q)), 1e-7);
    float detail = smoothstep(7.0, 12.0, eyePx) * (1.0 - uCheekA.w);
    vec3 f = base;
    pellCheek(f, q, 1.0, detail); pellCheek(f, q, -1.0, detail);
    inkp(f, ${G('#D18A82')}, cov(sdSegT(q, vec2(-0.0006, -0.039), vec2(0.0016, -0.0455), 0.0009, 0.0006)) * 0.6 * detail);
    pellMouth(f, q, detail);
    pellEye(f, q, 1.0, detail); pellEye(f, q, -1.0, detail);
    pellBangs(f, q, detail);
    pellBrow(f, q, 1.0, detail); pellBrow(f, q, -1.0, detail);
    // far away: two plain dots where the eyes are
    float dotE = min(length((q - vec2(0.039, -0.02)) / vec2(0.0068, 0.0095)), length((q - vec2(-0.039, -0.02)) / vec2(0.0068, 0.0095))) - 1.0;
    inkp(f, ${G('#3A1F33')}, cov(dotE) * (1.0 - detail));
    base = mix(base, f, front);
    // under the jaw line the skin takes its shadow colour (F6DCC4 -> E2A7A6)
    float jaw = -0.112 + 6.5 * vOP.x * vOP.x + 0.02 * smoothstep(0.0, -0.08, vOP.z);
    base = mix(base, base * ${G('#E2A7A6')} / ${G('#F6DCC4')}, cov(vOP.y - jaw) * skinM); }`;
  // the angel-ring on the hair (braids, temples): a narrow band of light, broken by strands
  const HAIR_POST = /* glsl */`
  { float hairM = 1.0 - smoothstep(0.3, 0.7, abs(vId - 2.0));
    vec3 Hh = normalize(uSunDir + V); float sp = dot(N, Hh) + (nz(vOP.xy * 9.0 + vOP.z * 3.0) - 0.5) * 0.16;
    c += ${G('#8E5A4A')} * hairM * smoothstep(0.78, 0.81, sp) * (1.0 - smoothstep(0.92, 0.95, sp)) * (0.5 + 0.5 * lit) * 1.2; }`;

  // ---- the cape: a parametric sheet with thickness (so the ink hull works), rebuilt every frame on the CPU
  // CNU x CNV quads; the two faces sit CTH (5.5 mm) either side of the mid-surface that secondary() moves.
  const CNU = 34, CNV = 10, CTH = .0055;
  // The front opening widens from .14 rad at the collar to .42 at the hem. The top quarter (v < .24) is the yoke that rounds
  // over the shoulders; below it the cape flares out and hangs longer at the back (the hem is 49 cm up there, 66 in front).
  function capeRest(u, v) {     // character space, rest pose. u 0..1 round from her front-left to front-right, v 0..1 collar to hem
    const gap = lerp(.14, .42, Math.pow(v, .8)), a = lerp(gap, TAU - gap, u), back = Math.max(0, -Math.cos(a)), vs = .24;
    let rx, rz, y;
    if (v < vs) { const k = Math.sin(v / vs * Math.PI / 2); rx = lerp(.07, .18, k); rz = lerp(.064, .122, k); y = lerp(1.0, .918, v / vs); }
    else { const k = (v - vs) / (1 - vs); rx = lerp(.18, .265, k); rz = lerp(.122, .2, k); y = lerp(.918, .64 - .15 * Math.pow(back, 1.6) + .02 * Math.max(0, Math.cos(a)), k); }
    return [Math.sin(a) * rx, y, Math.cos(a) * rz - .008];
  }
  // the cape's index buffer and empty position / normal buffers. uv.x is 0..1 on the outer face and 2..3 on the inner face,
  // so the shader can tell them apart; the four rim strips close the edges.
  function capeGeo() {
    const nM = (CNU + 1) * (CNV + 1), pos = new Float32Array(nM * 2 * 3), uv = new Float32Array(nM * 2 * 2), idx = [];
    const I = (i, j, side) => side * nM + j * (CNU + 1) + i;
    for (let side = 0; side < 2; side++) for (let j = 0; j <= CNV; j++) for (let i = 0; i <= CNU; i++) { const k = I(i, j, side); uv[k * 2] = i / CNU + side * 2; uv[k * 2 + 1] = j / CNV; }
    for (let j = 0; j < CNV; j++) for (let i = 0; i < CNU; i++) { const a = I(i, j, 0), b = I(i + 1, j, 0), c = I(i, j + 1, 0), d = I(i + 1, j + 1, 0); idx.push(a, c, b, b, c, d);
      const a2 = I(i, j, 1), b2 = I(i + 1, j, 1), c2 = I(i, j + 1, 1), d2 = I(i + 1, j + 1, 1); idx.push(a2, b2, c2, b2, d2, c2); }
    const rim = (p, q) => { const a = I(...p, 0), b = I(...q, 0), c = I(...p, 1), d = I(...q, 1); idx.push(a, b, c, b, d, c); };
    for (let i = 0; i < CNU; i++) { rim([i + 1, CNV], [i, CNV]); rim([i, 0], [i + 1, 0]); }
    for (let j = 0; j < CNV; j++) { rim([0, j + 1], [0, j]); rim([CNU, j], [CNU, j + 1]); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
    g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx); g.attributes.position.setUsage(THREE.DynamicDrawUsage); g.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    g.boundingSphere = new THREE.Sphere(v3(0, .8, 0), 1.6); return g;
  }
  // the rest shape, sampled once, and this frame's mid-surface (written by secondary())
  const CAPE_REST = []; for (let j = 0; j <= CNV; j++) for (let i = 0; i <= CNU; i++) CAPE_REST.push(capeRest(i / CNU, j / CNV));
  const CAPE_MID = new Float32Array(CAPE_REST.length * 3);
  const CAPE_FS = /* glsl */`
  // quilting: two families of diagonal lines make diamonds; ochre running stitches on the outside, an ochre binding along
  // the hem and the front edges, a darker indigo inside
  { vec2 uv = vUv2; float inner = step(1.5, uv.x); uv.x -= inner * 2.0;
    float a = uv.x * 24.0 + uv.y * 5.0, b = uv.x * 24.0 - uv.y * 5.0;
    float la = abs(fract(a + 0.5) - 0.5), lb = abs(fract(b + 0.5) - 0.5);
    base *= mix(0.82, 1.05, smoothstep(0.0, 0.32, min(la, lb)));        // quilted puffs between the stitch lines
    float st = max(cov(la - 0.03) * step(0.38, fract(b * 2.0)), cov(lb - 0.03) * step(0.38, fract(a * 2.0)));
    base = mix(base, ${G('#C98B2E')}, st * 0.9 * (1.0 - inner));
    float edge = max(smoothstep(0.925, 0.945, uv.y), max(smoothstep(0.022, 0.01, uv.x), smoothstep(0.978, 0.99, uv.x)));
    base = mix(base, ${G('#C98B2E')}, edge);
    base = mix(base, ${G('#22305E')}, inner * (1.0 - edge)); }`;

  // ---- staff, bell, mitten
  // the ash toll-staff: a tube of radius 16 mm, straight to 1.8 m, then a crook that curls forward (+z) and down to its tip at 1.85 m
  // (the top of the crook is about 1.97 m). The last 15% tapers; small spheres cap both ends. Staff space: base at the origin.
  function staffGeo() {
    const pts = [[0, 0, 0], [0, .9, 0], [0, 1.8, 0], [0, 1.88, .012], [0, 1.94, .05], [0, 1.965, .1], [0, 1.95, .15], [0, 1.905, .175], [0, 1.85, .172]].map(p => v3(...p));
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal', .5), 80, .016, 10, false);
    // taper toward the crook's tip; round caps
    const p = tube.attributes.position, n = 81, r = 11;
    for (let i = 0; i < n; i++) { const k = i / (n - 1), sc = lerp(1, .78, sm(.85, 1, k)); const c = new THREE.Vector3(); for (let j = 0; j < r; j++) { const v = (i * r + j); c.x += p.getX(v) / r; c.y += p.getY(v) / r; c.z += p.getZ(v) / r; }
      for (let j = 0; j < r; j++) { const v = i * r + j; p.setXYZ(v, c.x + (p.getX(v) - c.x) * sc, c.y + (p.getY(v) - c.y) * sc, c.z + (p.getZ(v) - c.z) * sc); } }
    tube.computeVertexNormals();
    const cap0 = new THREE.SphereGeometry(.016, 10, 6); const cap1 = new THREE.SphereGeometry(.0125, 10, 6); cap1.translate(0, 1.85, .172);
    const g = merge([{ g: tube, col: PAL.staff, id: 1 }, { g: cap0, col: PAL.staff, id: 1 }, { g: cap1, col: PAL.staff, id: 1 }]);
    return g;
  }
  const STAFF_FS = /* glsl */`
  // wood grain along the staff, and two moss felt wraps (the grip at .74-.96 m, a band at 1.62-1.70 m) with a spiral stitch
  { float ang = atan(vOP.x, vOP.z);
    base *= 0.9 + 0.2 * nz(vec2(vOP.y * 1.3, ang * 0.25 + vOP.y * 0.02));
    float band = step(0.74, vOP.y) * step(vOP.y, 0.96) + step(1.62, vOP.y) * step(vOP.y, 1.7);
    float sp = fract(vOP.y * 70.0 + ang / 6.2832);
    base = mix(base, ${G('#6F9A3B')} * (0.75 + 0.35 * step(0.5, sp)), band); }`;
  // the bell hangs from its handle: the grip is the origin, the mouth points down -y.
  // Its lathe profile [radius, y] in metres, top to bottom: the wooden handle down to y -.046, the brass flaring to a 35 mm
  // lip at y -.105 (7 cm across), then back up the inside.
  const BELL_PTS = [[0, .002], [.0085, -.001], [.0095, -.012], [.0075, -.03], [.0105, -.04], [.0135, -.046], [.016, -.049], [.0185, -.056], [.0205, -.068], [.024, -.084], [.031, -.098], [.035, -.105],
    [.032, -.106], [.028, -.099], [.021, -.086], [.0175, -.071], [.0145, -.058], [.0, -.055]];
  const BELL_FS = /* glsl */`
  // wood above y -0.046, brass below with two turned rings; from 57.0 (uCrack) a crack
  { float wood = step(-0.046, vOP.y); base = mix(base, ${G('#B08A5A')} * (0.9 + 0.2 * nz(vOP.xy * 40.0)), wood);
    float ring = cov(abs(vOP.y + 0.095) - 0.0012) + cov(abs(vOP.y + 0.06) - 0.001);
    base = mix(base, base * 0.7, ring * (1.0 - wood));
    // the crack: a dark zigzag up from the missing shard
    float ang = atan(vOP.x, vOP.z);
    float zz = abs(ang - 0.55 - 0.05 * sin(vOP.y * 900.0) - (vOP.y + 0.08) * 3.0) - 0.035;
    base = mix(base, ${G('#3A1F1A')}, uCrack * cov(zz) * step(vOP.y, -0.07) * step(-0.1, vOP.y) * (1.0 - wood)); }`;
  const BELL_SPEC = /* glsl */`
  // a sharp highlight and a soft sheen on the brass
  { float brass = 1.0 - step(-0.046, vOP.y); vec3 Hh = normalize(uSunDir + V); float s1 = dot(N, Hh);
    c += ${G('#FFF0C0')} * brass * (smoothstep(0.93, 0.95, s1) * 0.9 + smoothstep(0.7, 0.74, s1) * 0.12) * (0.4 + 0.6 * lit); }`;
  // the bell cracks at 57.0: the shard's vertices fold away (vertex shader, so the ink hull loses it too).
  // On the strike frames the back of the bell is dragged along uSmearV (a fixed streak standing in for the bible's
  // "-0.4 x velocity", M14), broken up by a hash so it reads as a drawn smear.
  const BELL_VD = /* glsl */`
  { float ang = atan(P0.x, P0.z); float inS = step(0.55, ang) * step(ang, 1.45);
    float yc = -0.082 + 0.008 * sin(ang * 23.0);
    // inside the missing sector (.55-1.45 rad) everything below the jagged line yc is flattened onto it
    if (uCrack > 0.5 && inS > 0.5 && P0.y < yc) transformed = vec3(P0.x, yc, P0.z) * vec3(0.98, 1.0, 0.98);
    float tr = clamp(-dot(normalize(objectNormal), normalize(uSmearV + vec3(1e-5))) * 1.5, 0.0, 1.0);
    transformed -= uSmearV * tr * (0.55 + 0.45 * h12(floor(P0.xz * 300.0))); }`;
  // the moss felt mitten pulled over the bell (bell space): a round body, the neck, a ribbed cuff and a thumb
  function mittenParts() {
    return [{ f: S.ell([0, -.079, 0], [.041, .039, .041]), col: PAL.mitten, tag: 1 }, { f: S.cap([0, -.045, 0], [0, -.062, 0], .021, .028), col: PAL.mitten, tag: 1, k: .02 },
      { f: S.torus([0, -.043, 0], .02, .0075), col: '#86AE52', tag: 2, k: .008 }, { f: S.ell([.034, -.074, .014], [.013, .02, .013]), col: PAL.mitten, tag: 1, k: .012 }];
  }

  // ---- the hood's tassels and the 7-bead string (bible §3: the meter)
  // where they hang, as angles round the brim (a = 0 in front, + toward her left): three tassels on the left and at the back,
  // the bead string slung along her right side between two points
  const TASSEL_A = [.95, 1.95, -2.45], BEAD_A = [-.95, -1.85];
  // a tassel, turned on a lathe (origin at the brim, hanging down -y), 7 cm long: a cord, a knot, then the skirt of threads
  function tasselGeo() { return merge([{ g: lathe([[.0001, .001], [.0022, 0], [.0022, -.022], [.0058, -.025], [.0068, -.03], [.0052, -.036], [.0042, -.038], [.0062, -.042],
    [.0095, -.055], [.011, -.066], [.0095, -.069], [.0001, -.069]], 12), col: PAL.tassel, id: 1 }]); }

  // ---- Pell: build
  // pell holds everything built here (meshes, uniforms, anchors) plus pell.last, the last pose.
  const pell = {};
  function buildPell(scene) {
    // R, the root, stands between her feet and turns with her yaw; Q inside it is scaled for squash and stretch (pivot at the
    // feet). The body, staff and bell hang under Q; the cape, tassels and beads under R (secondary() places them itself).
    const R = new THREE.Group(); R.name = 'pell'; const Q = new THREE.Group(); R.add(Q); scene.add(R);
    const rig = makeRig(PDEF); pell.root = R; pell.squash = Q; pell.rig = rig; pell.wetU = { value: 0 };
    // body. The smear (vdeform): on a smear frame, vertices whose normal points away from uSmear (the side trailing the
    // motion) are dragged back along it, by an amount broken up per 14 mm cell so the streak looks drawn
    const bodyMat = cel({ vcol: true, shadeRGB: [1.06, .9, 1.04], wetU: pell.wetU, rim: .28, uniforms: { uSmear: { value: v3() } },
      vpars: 'uniform vec3 uSmear;',
      vdeform: /* glsl */`{ float tr = clamp(-dot(normalize(objectNormal), normalize(uSmear + vec3(1e-5))) * 1.6, 0.0, 1.0);
        transformed -= uSmear * tr * (0.45 + 0.55 * h12(floor(P0.xy * 70.0))); }` });
    const T0 = performance.now(), mark = k => { F.cast.bootMs[k] = Math.round(performance.now() - T0); };
    // sculpted on a 10.4 mm grid inside this box, skin weights from the 15 bones; the root bone goes under the mesh and the
    // skeleton is bound in the rest pose
    const bodyGeo = S.mesh(pellBodyParts(rig.index), [-.22, -.01, -.13], [.22, 1.02, .17], .0104, { bones: rig.list.length, skinBlend: .016, blend: .005 });
    const body = prepMesh(new THREE.SkinnedMesh(bodyGeo, bodyMat)); Q.add(body); body.add(rig.list[0]); R.updateMatrixWorld(true); body.bind(new THREE.Skeleton(rig.list));
    ink(body, PAL.ink, 1.8, .012); pell.body = body; mark('body');
    // head + face. The head ignores the shadow map (shadowK 0: the face pass paints its own shadows) and has a warmer skin
    // shadow and a softer mid band. vnormal bends the skin normals 72% toward a smooth ellipsoid, so light falls on the face
    // in clean anime shapes instead of following the nose and cheek bumps.
    pell.faceU = { uEyeA: { value: new THREE.Vector4() }, uEyeB: { value: new THREE.Vector4() }, uBrowA: { value: new THREE.Vector4() }, uMouthA: { value: new THREE.Vector4(0, .01, .5, .2) },
      uMouthB: { value: new THREE.Vector4() }, uCheekA: { value: new THREE.Vector4(.4, 1, 0, 0) } };
    const headMat = cel({ vcol: true, shadeRGB: [1.22, .76, .82], shadowK: 0, rim: .22, paintK: .05, wetU: pell.wetU, uniforms: pell.faceU, mid: .6,
      vnormal: /* glsl */`{ float sk = (1.0 - step(0.5, abs(aId - 1.0))) * smoothstep(-0.125, -0.095, P0.y); vec3 sn = normalize((P0 - vec3(0.0, -0.005, -0.035)) * vec3(1.0, 0.9, 1.3));
        objectNormal = normalize(mix(objectNormal, sn, 0.72 * sk)); }`,
      fpars: FACE_PARS, fpre: FACE_PRE, fpost: HAIR_POST });
    const head = prepMesh(new THREE.Mesh(S.mesh(pellHeadParts(), [-.13, -.18, -.15], [.13, .145, .135], .0054, { blend: .006 }), headMat), true);
    head.position.set(...HEAD_OFF); rig.bones.neck.add(head); ink(head, PAL.ink, 1.7, .01); pell.head = head; mark('head');
    // hood. Soaked (uWet), the crown sinks 4 cm, the brim's edge 5 cm, and the upper part spreads up to 7%: the hood flattens.
    // The fragment adds the lining colours, a dashed ochre seam 17 mm inside the brim's edge and a darker centre seam on the crown.
    pell.hoodU = { uWet: { value: 0 } };
    const hoodMat = cel({ vcol: true, shadeRGB: [1.12, .72, .92], wetU: pell.wetU, rim: .3, paintK: .14, paintS: 9, uniforms: pell.hoodU, vpars: 'uniform float uWet;',
      vdeform: /* glsl */`if (uWet > 0.0) { float r = length(P0.xz); float up = smoothstep(0.0, 0.2, P0.y);
          transformed.y -= uWet * (0.04 * up + 0.05 * smoothstep(0.16, 0.27, r)); transformed.xz *= 1.0 + uWet * 0.07 * up; }`,
      vpars: 'uniform float uWet; attribute vec2 aUv; varying vec2 vUv2;', vnormal: 'vUv2 = aUv;',
      fpars: 'uniform float uWet; varying vec2 vUv2; float rimR(float a){ return 0.278 - 0.03 * pow(max(cos(a), 0.0), 2.0); }',
      fpre: /* glsl */`
      { float rho = length(vOP.xz); float under = step(2.5, vId), inner = step(1.5, vId) * (1.0 - under);
        // the shell's lower edge is turned back: a band of moss lining round the face and the neck, with a darker fold line
        float shellOut = 1.0 - step(1.5, vId), lip = cov(0.93 - vUv2.y) * shellOut * step(rho, 0.2);
        base = mix(base, ${G(PAL.lining)} * (0.92 + 0.16 * nz(vOP.xz * 7.0)), max(inner, lip));
        base = mix(base, ${G('#3E6A22')}, cov(abs(vUv2.y - 0.925) - 0.006) * shellOut * step(rho, 0.2) * 0.85);
        float ang = atan(vOP.x, vOP.z), rE = rimR(ang);
        float seam = cov(abs(rho - (rE - 0.017)) - 0.0011) * step(0.42, fract(ang * 40.0)) * (1.0 - under) * smoothstep(0.19, 0.2, rho);
        base = mix(base, ${G('#F6C27A')}, seam * 0.8);
        float crown = cov(abs(vOP.x) - 0.0012) * step(0.1, vOP.y + vOP.z * 0.2) * step(vOP.z, 0.05) * shellOut;
        base = mix(base, base * 0.72, crown); }` });
    const hood = prepMesh(new THREE.Mesh(hoodGeo(), hoodMat));
    head.add(hood); ink(hood, PAL.hoodInk, 2.0, .014); pell.hood = hood; mark('hood');
    // fringe lock (rebuilt every frame in head space): hair colour with a hard highlight band
    pell.fringe = prepMesh(new THREE.Mesh(fringeGeo(), cel({ color: PAL.hair, shadeRGB: [1.1, .85, 1.1], paintK: .04, fpost: /* glsl */`
      { vec3 Hh = normalize(uSunDir + V); c += ${G('#8E5A4A')} * smoothstep(0.84, 0.87, dot(N, Hh)) * 0.9; }` })), false);
    head.add(pell.fringe); ink(pell.fringe, PAL.ink, 1.3, .006);
    // cape
    pell.capeGeo = capeGeo();
    pell.cape = prepMesh(new THREE.Mesh(pell.capeGeo, cel({ color: PAL.cape, shadeRGB: [.95, .88, 1.12], wetU: pell.wetU, paintK: .08, rim: .3,
      vpars: 'attribute vec2 aUv; varying vec2 vUv2;', vnormal: 'vUv2 = aUv;', fpars: 'varying vec2 vUv2;', fpre: CAPE_FS })));
    R.add(pell.cape); ink(pell.cape, PAL.ink, 1.8, .012);
    // pellPose() only marks the secondary motion dirty; it is computed once per frame, from the last pose, right before drawing
    pell.flushSecondary = () => { const d = pell.secDirty; if (d) { pell.secDirty = null; secondary(d.z, d.t); } };
    // three uploads geometry while it gathers the scene, before any mesh's onBeforeRender, so flush from the scene's hook (chained)
    const prevBR = scene.onBeforeRender; scene.onBeforeRender = function (...a) { pell.flushSecondary(); if (prevBR) prevBR.apply(this, a); };
    pell.cape.onBeforeRender = pell.flushSecondary;   // a fallback; it does nothing once the scene hook has flushed
    // staff
    pell.staff = prepMesh(new THREE.Mesh(staffGeo(), cel({ vcol: true, shadeRGB: [1.08, .86, .98], paintK: .06, fpre: STAFF_FS })));
    Q.add(pell.staff); ink(pell.staff, PAL.ink, 1.7, .01);
    pell.crook = new THREE.Object3D(); pell.crook.position.set(0, 1.978, .1); pell.staff.add(pell.crook);   // Tock's perch
    // bell (+ the mitten over it), and the shard and clapper that fly off at 57.0. The bell is a lathe plus its clapper
    // (id 2); the shard is the missing sector of the same profile (.55-1.45 rad), so it fits the gap BELL_VD leaves.
    pell.bellU = { uCrack: { value: 0 }, uSmearV: { value: v3() } };
    pell.bell = prepMesh(new THREE.Mesh(merge([{ g: lathe(BELL_PTS, 40), col: PAL.brass, id: 1 }, { g: new THREE.SphereGeometry(.0075, 8, 6).translate(0, -.094, 0), col: '#8A6A2A', id: 2 }]),
      cel({ vcol: true, shadeRGB: [1.1, .8, .85], paintK: .03, uniforms: pell.bellU, vpars: 'uniform float uCrack; uniform vec3 uSmearV;', vdeform: BELL_VD,
        fpars: 'uniform float uCrack;', fpre: BELL_FS, fpost: BELL_SPEC })));
    Q.add(pell.bell); ink(pell.bell, PAL.ink, 1.5, .008);
    pell.mitten = prepMesh(new THREE.Mesh(S.mesh(mittenParts(), [-.06, -.13, -.06], [.065, -.025, .06], .0028, { blend: .004 }), cel({ vcol: true, shadeRGB: [.9, 1, 1.05], paintK: .16, paintS: 14 })));
    pell.bell.add(pell.mitten); ink(pell.mitten, PAL.ink, 1.5, .008);
    pell.shard = prepMesh(new THREE.Mesh(lathe(BELL_PTS.slice(9, 14), 6, .55, .9), cel({ color: PAL.brass, side: THREE.DoubleSide, shadeRGB: [1.1, .8, .85] })), false);
    pell.clapper = prepMesh(new THREE.Mesh(new THREE.SphereGeometry(.008, 8, 6), cel({ color: '#8A6A2A' })), false);
    scene.add(pell.shard); scene.add(pell.clapper); pell.shard.visible = pell.clapper.visible = false;
    // tassels and beads (instanced, placed in the root's space every frame). Tassels: darker thread stripes in the skirt and
    // an ochre binding at the knot. Beads: pale glass, a hard white highlight and a cyan rim (the drops' look, bible §8).
    pell.tassels = prepMesh(new THREE.InstancedMesh(tasselGeo(), cel({ vcol: true, shadeRGB: [.9, 1, 1.05], paintK: .12, paintS: 30,
      fpre: `base *= 1.0 - 0.28 * step(vOP.y, -0.04) * step(0.55, fract(atan(vOP.x, vOP.z) * 5.0 + vOP.y * 9.0)); base = mix(base, ${G('#C98B2E')}, step(-0.0365, vOP.y) * step(vOP.y, -0.0325));` }), TASSEL_A.length), false);
    pell.tassels.instanceMatrix.setUsage(THREE.DynamicDrawUsage); R.add(pell.tassels); ink(pell.tassels, PAL.ink, 1.3, .006);
    pell.beads = prepMesh(new THREE.InstancedMesh(new THREE.SphereGeometry(.0078, 12, 8), cel({ color: PAL.bead, shadeRGB: [.8, 1, 1.15], rim: .7, paintK: 0, mid: 0,
      fpost: /* glsl */`{ vec3 Hh = normalize(uSunDir + V); float s1 = dot(N, Hh); c += vec3(1.0) * smoothstep(0.9, 0.93, s1) * 1.4; c += ${G('#5FC8E0')} * smoothstep(0.55, 0.85, 1.0 - max(dot(N, V), 0.0)) * 0.5; }` }), 7), false);
    pell.beads.instanceMatrix.setUsage(THREE.DynamicDrawUsage); R.add(pell.beads); ink(pell.beads, '#2E5A78', 1.2, .005);
    // anchors for shots: the bones themselves, the point between the eyes, the hood's crown (Tock's seat), the left shoulder
    // and the seat the shawl moves to at 82.5
    mark('props');
    pell.handL = rig.bones.handL; pell.handR = rig.bones.handR; pell.chest = rig.bones.chest; pell.hips = rig.bones.hips;
    pell.eye = new THREE.Object3D(); pell.eye.position.set(0, -.017, .1); head.add(pell.eye);
    pell.headTop = new THREE.Object3D(); pell.headTop.position.set(0, .214, -.01); head.add(pell.headTop);   // Tock sits here
    pell.shoulderL = new THREE.Object3D(); pell.shoulderL.position.set(.13, .14, -.02); rig.bones.chest.add(pell.shoulderL);
    pell.shawlSeat = new THREE.Object3D(); pell.shawlSeat.position.set(0, .13, -.01); rig.bones.chest.add(pell.shawlSeat);
  }

  // ---- the fringe lock: a flat tapered ribbon of hair, rebuilt each frame from four control points in head space
  const FNS = 12, FNR = 6, FR0 = [[.004, .072, .1], [.011, .046, .117], [.015, .02, .118], [.009, -.004, .112]];
  function fringeGeo() { const g = new THREE.BufferGeometry(), n = (FNS + 1) * FNR + 1, idx = [];
    for (let i = 0; i < FNS; i++) for (let j = 0; j < FNR; j++) { const a = i * FNR + j, b = i * FNR + (j + 1) % FNR, c = a + FNR, d = b + FNR; idx.push(a, c, b, b, c, d); }
    const tip = (FNS + 1) * FNR; for (let j = 0; j < FNR; j++) idx.push(FNS * FNR + j, tip, FNS * FNR + (j + 1) % FNR);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(v3(0, .03, .1), .2); return g; }
  const FCURVE = new THREE.CatmullRomCurve3([v3(), v3(), v3(), v3()]), _fc = v3(), _ft = v3(), _fs = v3(), _fn = v3(), _fw = v3(0, 0, 1);
  // off: how far the tip is pushed this frame (head-space metres, from secondary()). The push grows as (i/3)^2 along the
  // lock, so the root stays under the hood; z is clamped so the lock never sinks into the forehead. The cross-section is a
  // flat oval FNR points round, 5.8 mm half-wide at the root and narrowing to a point; a last vertex closes the tip.
  function updateFringe(off) {
    const g = pell.fringe.geometry, p = g.attributes.position, nr = g.attributes.normal;
    FR0.forEach((q, i) => { const k = (i / 3) ** 2; FCURVE.points[i].set(q[0] + off[0] * k, q[1] + off[1] * k, Math.max(q[2] + off[2] * k, .104 + (i ? .006 : 0))); });
    for (let i = 0; i <= FNS; i++) { const s = i / FNS; FCURVE.getPoint(s, _fc); FCURVE.getTangent(s, _ft); _fs.crossVectors(_ft, _fw).normalize(); _fn.crossVectors(_fs, _ft).normalize();
      const w = .0058 * (1 - Math.pow(s, 1.4)) + .0006, th = w * .38;
      for (let j = 0; j < FNR; j++) { const a = j / FNR * TAU, ca = Math.cos(a), sa = Math.sin(a), k = i * FNR + j;
        p.setXYZ(k, _fc.x + _fs.x * ca * w + _fn.x * sa * th, _fc.y + _fs.y * ca * w + _fn.y * sa * th, _fc.z + _fs.z * ca * w + _fn.z * sa * th);
        const nx = _fs.x * ca * th + _fn.x * sa * w, ny = _fs.y * ca * th + _fn.y * sa * w, nz = _fs.z * ca * th + _fn.z * sa * w, l = Math.hypot(nx, ny, nz) || 1; nr.setXYZ(k, nx / l, ny / l, nz / l); } }
    FCURVE.getPoint(1, _fc); FCURVE.getTangent(1, _ft); p.setXYZ((FNS + 1) * FNR, _fc.x + _ft.x * .004, _fc.y + _ft.y * .004, _fc.z + _ft.z * .004); nr.setXYZ((FNS + 1) * FNR, _ft.x, _ft.y, _ft.z);
    p.needsUpdate = true; nr.needsUpdate = true;
  }

  // ---- expressions and mouth keys
  // An expression: lid (0 open .. 1 shut), wide (stunned: bigger eye, smaller pupil), happy (shut eyes arch like ^), sparkle
  // (the third highlight), dull (smaller highlights), brow [raise, furrow, sad], the mouth key it uses, smile (-1 corners
  // down .. 1 up), blush 0..1, an optional gaze, noBlink. The aliases below are the bible's names for her moods.
  const EXPR = {
    neutral: { lid: .08, brow: [0, 0, 0], mouth: 'closed', smile: .2, blush: .4 },
    eager: { lid: 0, wide: .08, brow: [.5, 0, 0], mouth: 'grin', smile: .8, blush: .65, sparkle: .7 },
    sad: { lid: .4, brow: [0, 0, .95], mouth: 'closed', smile: -.55, blush: .2, gaze: [0, -.55] },
    determined: { lid: .24, brow: [-.1, .9, 0], mouth: 'closed', smile: -.2, blush: .35 },
    strain: { lid: .34, brow: [0, 1, .25], mouth: 'clench', smile: -.3, blush: .6 },
    stunned: { lid: 0, wide: 1, brow: [.95, 0, .15], mouth: 'o', blush: .15 },
    still: { lid: .3, wide: .35, brow: [.1, 0, .45], mouth: 'closed', smile: -.15, dull: 1, blush: .1, noBlink: true },
    wonder: { lid: 0, wide: .12, brow: [.7, 0, .1], mouth: 'o', blush: .4, sparkle: 1 },
    singing: { lid: .5, brow: [.5, 0, .3], mouth: 'ah', blush: .65, sparkle: .6 },
    joyful: { lid: 1, happy: 1, brow: [.6, 0, 0], mouth: 'laugh', blush: .9 },
    peace: { lid: .45, brow: [.2, 0, .25], mouth: 'closed', smile: .5, blush: .45 },
  };
  Object.assign(EXPR, { sidelined: EXPR.sad, broken: EXPR.still, resolved: EXPR.determined, reckless: EXPR.determined, happy: EXPR.joyful });
  // A mouth key: open 0..1 (up to 22 mm tall), w the half width in metres, topK the top lip's roundness (0 flat for a laugh,
  // 1 round for o), and optionally smile and teeth (0..1). A mouth key's smile wins over the expression's.
  const MOUTH = {
    closed: { open: 0, w: .0105, topK: .5 }, o: { open: .42, w: .0052, topK: 1 }, hum: { open: .14, w: .0046, topK: 1 },
    ah: { open: .82, w: .0105, topK: .62 }, oh: { open: .95, w: .0072, topK: .95 }, laugh: { open: .9, w: .0148, topK: .28, smile: .9, teeth: 1 },
    grin: { open: .34, w: .0118, topK: .22, smile: .9, teeth: .8 }, clench: { open: .3, w: .012, topK: .9, teeth: 1, smile: -.25 },
  };
  MOUTH['small-o'] = MOUTH.o;
  // the blink: three drawings (half, shut, half). There is one blink in every 3.5 s slot, at a hashed moment in its first
  // 1.8 s, so blinks come 1.7-5.3 s apart (3.5 s on average) and the same time always gives the same blink.
  function blinkAt(th) { const i0 = Math.floor(th / 3.5); for (let i = i0 - 1; i <= i0 + 1; i++) { const tb = Math.floor((i * 3.5 + A.hash(i, 41) * 1.8) * 12) / 12, d = Math.round((th - tb) * 12);
      if (d === 0 || d === 2) return .6; if (d === 1) return 1; } return 0; }
  // the face for one drawing -> the values the face uniforms take. The shot's options (o) win over the state's (z); a number
  // for blink closes the lids at least that far, false turns blinking off; happy (^) eyes never blink.
  function faceOf(z, th, o) {
    const ex = EXPR[o.expr || z.expr] || EXPR.neutral, mk = MOUTH[o.mouth || ex.mouth] || MOUTH.closed;
    let lid = ex.lid ?? 0; const bl = o.blink === false || ex.noBlink ? 0 : typeof o.blink === 'number' ? o.blink : blinkAt(th);
    lid = Math.max(lid, bl * (ex.happy ? 0 : 1));
    const gz = o.gaze || z.gaze || ex.gaze || [0, 0];
    return { lid, wide: ex.wide || 0, happy: ex.happy || 0, sparkle: ex.sparkle || 0, dull: ex.dull || 0, gaze: gz, brow: ex.brow,
      open: mk.open, w: mk.w, topK: mk.topK, smile: mk.smile ?? ex.smile ?? 0, teeth: mk.teeth || 0, blush: ex.blush ?? .4 };
  }

  // ---- poses. A pose is a plain object in character space; states fill it in, then applyPell() puts it on the rig.
  // Its fields (metres and radians):
  //   pos, yaw              where she stands (world) and which way she faces (0 = +z)
  //   hip                   offset of the hips bone from rest;  hipR, chest, head: [x, y, z] rotations (see setE)
  //   handL / handR         hand targets in character space, or handLsh / handRsh relative to the shoulder (they win)
  //   poleL / poleR         the direction the elbows bend toward;  kneeL / kneeR the same for the knees
  //   footL / footR         ankle targets;  footPL / footPR foot pitch (+ points the toe down, - lifts it)
  //   staff, bell           where the props are (see placeStaff and applyPell);  expr, mouth, gaze, blink: the face
  //   squash, smear, wet, shawl, lookW (a world point to look at)
  // tock: null is never read.
  const restFeet = () => ({ footL: [.078, .095, 0], footR: [-.078, .095, 0] });
  function basePose() {
    return Object.assign({ pos: [0, 0, 0], yaw: 0, hip: [0, 0, 0], hipR: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0],
      handL: [.17, .56, .02], handR: [-.17, .56, .02], handLsh: null, handRsh: null, poleL: [.4, -.3, -1], poleR: [-.4, -.3, -1],
      footPL: 0, footPR: 0, kneeL: [.1, 0, 1], kneeR: [-.1, 0, 1],
      staff: { mode: 'R', dir: [0, 1, 0], grip: .82, face: [-1, 0, .3] }, bell: { mode: 'L', mitten: 1 },
      expr: 'neutral', squash: 1, smear: null, wet: 0, lookW: null, tock: null, shawl: 0 }, restFeet());
  }
  // a gait: ph is the phase of one full stride (both feet), o: stride, lift, dip, bounce, lean, arm, twist, kick
  // stride / lift: how far each foot swings (fore and aft) and rises; dip / bounce: the hips sink, and bob twice a stride;
  // lean: forward pitch; arm: arm swing; twist: hips, chest and head counter-rotate (default 1); kick: the trailing foot
  // flicks up behind; heel, armOut, armUp: optional extras. The foot in the air points its toe down.
  function gait(z, ph, o) {
    const q = TAU * ph;
    for (const s of [1, -1]) { const qs = s > 0 ? q : q + Math.PI, c = Math.cos(qs), sn = Math.sin(qs), sw = Math.max(0, -sn);
      const kick = (o.kick || 0) * sw * Math.max(0, -c);
      z[s > 0 ? 'footL' : 'footR'] = [s * .075, .095 + o.lift * Math.pow(sw, 1.3) + kick * .5, o.stride * c - kick * .25];
      z[s > 0 ? 'footPL' : 'footPR'] = sw > 0 ? .6 * sw : -.25 * Math.max(0, c) * (o.heel ?? 1);
      z[s > 0 ? 'handLsh' : 'handRsh'] = [s * (.03 + (o.armOut || 0)), -.3 + (o.armUp || 0) + .05 * Math.abs(c) * o.arm, -c * o.arm * .26 + .02]; }
    z.hip[1] -= o.dip + o.bounce * (.5 - .5 * Math.cos(2 * q));
    z.hipR[0] += o.lean; z.hipR[1] -= .07 * (o.twist ?? 1) * Math.cos(q); z.chest[1] += .16 * (o.twist ?? 1) * Math.cos(q);
    z.head[1] -= .09 * (o.twist ?? 1) * Math.cos(q); z.chest[0] += (o.lean || 0) * .3;
  }
  // crouch by k (0..1): hips 20 cm lower, leaning forward, knees out
  const crouch = (z, k, lean = .25) => { z.hip[1] -= .2 * k; z.hip[2] -= .04 * k; z.hipR[0] += lean * k; z.chest[0] += .2 * k; z.head[0] -= .25 * k; z.kneeL = [.25, 0, 1]; z.kneeR = [-.25, 0, 1]; };
  // her handbell strikes in S10: the first six are the 'bell' tolls in film/events.js; the seventh, at 57.0, cracks it (silence)
  const STRIKES = [54.0, 54.75, 55.5, 55.875, 56.25, 56.625, 57.0];
  // where the bell hand is while she rings (character space): down at each strike; between strikes it rises over the first
  // 40% of the gap and comes down in the last 20%, a little higher each time. After the crack it jerks up and holds.
  function bellHand(th) {
    const down = [.2, .76, .3], up = [.25, 1.12, .14];
    if (th < STRIKES[0]) return down;
    if (th >= 57) { const k = ramp(th, 57.0, 57.35, 'snap'); return mix3([.24, .82, .34], [.15, .9, .27], k); }
    let i = 0; while (i < STRIKES.length - 1 && th >= STRIKES[i + 1]) i++;
    const ts = STRIKES[i], tn = STRIKES[i + 1], u = (th - ts) / (tn - ts);
    const k = sm(0, .4, u) * (1 - sm(.8, 1, u)) * (1 + .1 * i);
    return mix3(down, up, k);
  }

  // One function per state of FILM.path.pell: state(z, th, p, o) fills the pose z for held time th; p is the path sample
  // ({ pos, yaw, state, air, on }), o the shot's options. Times are film seconds; the S numbers are the bible's shots.
  const STATES = {
    // a test pose for the turnaround views: standing, the staff upright in her right hand
    idle(z) { z.staff = { mode: 'R', dir: [0, 1, -.04], grip: .82, face: [-1, 0, .25] }; z.handR = [-.21, .8, .12]; z.handL = [.16, .7, .14]; },
    roof(z, th) {   // S04: on the ridge of her own roof
      const mit = 1 - sm(19.55, 19.8, th);
      const rockOn = sm(19.7, 20.0, th) * (1 - sm(22.3, 22.4, th));
      const rk = Math.sin(TAU * th / .75) * rockOn;            // heel to toe on the beat (80 bpm, .75 s), held on twos
      z.hip[1] += .022 * Math.max(0, rk); z.hipR[0] += .06 * rk; z.footPL = z.footPR = .45 * Math.max(0, rk); z.head[0] -= .05 * rk;
      z.expr = 'eager';
      if (mit > 0) {   // she snugs the felt mitten onto the bell, both hands at her chest, the staff leaning on her shoulder
        z.staff = { mode: 'free', base: [-.17, 0, .17], dir: nrm3([.05, 1, -.16]), face: [-1, 0, .2] };
        const w = Math.floor(th * 12) % 2;
        z.handL = [.05, .84, .2]; z.handR = [-.03 + .01 * w, .88 - .012 * w, .21]; z.head[0] += .28; z.gaze = [0, -.8]; z.expr = 'neutral';
      } else { z.staff = { mode: 'R', dir: nrm3([.02, 1, -.05]), grip: .82, face: [-1, 0, .3] }; z.handR = [-.2, .8, .13]; z.handL = [.11, .8, .17]; }
      // she hums (the D4 'hum' toll at 20.25), swaying her head; at 22.4 a drop lands on her nose: eyes shut two drawings,
      // then she looks across to Dun at the drum (who hushes her) and her face falls
      if (th > 20.25 && th < 22.35) { z.expr = 'peace'; z.mouth = 'hum'; z.head[2] += .08 * Math.sin(TAU * th / 1.5); }
      if (th >= 22.35 && th < 22.55) { z.expr = 'stunned'; z.head[0] -= .14; z.squashHead = 1; z.blink = th < 22.5 ? 1 : .6; }
      if (th >= 22.55) { const look = V.places.tollTerrace.drum; z.lookW = add3(look, [0, 1.3, 0]); z.expr = th < 22.85 ? 'stunned' : 'sad'; }
      const drop = ramp(th, 22.85, 23.1, 'snap');             // shoulders drop over a 3-drawing hold
      if (drop > 0) { z.chest[0] += .2 * drop; z.hip[1] -= .02 * drop; z.head[0] += .22 * drop; z.handL = mix3(z.handL, [.15, .66, .12], drop); z.handR = mix3(z.handR, [-.19, .72, .1], drop); z.lookW = th < 23.1 ? z.lookW : null;
        z.expr = 'sad'; z.staff.dir = nrm3([.1, 1, .1]); }
      // she starts to kick a pebble, stops herself mid-kick (hush) and puts the foot down without a sound
      if (th > 23.1) { const k = keys(th, [[23.1, [0, 0, 0]], [23.3, [0, .05, -.14], 'out'], [23.42, [0, .06, .1], 'snap'], [23.67, [0, .06, .1]], [23.95, [0, 0, 0], 'io']]);
        z.footL = add3(z.footL, k); z.footPL = k[2] > 0 ? .3 : -.3 * (k[1] / .06); }
    },
    // S05: running along terrace 9 beside the fanners, a stride every .5 s, the staff pointing ahead
    run(z, th) { gait(z, th / .5, { stride: .27, lift: .16, dip: .085, bounce: .03, lean: .28, arm: .9, kick: .25, armUp: .06 });
      z.staff = { mode: 'R', dir: nrm3([0, 1, .75]), grip: .95, face: [-1, 0, 0] }; z.handRsh = [-.04, -.24, .12]; z.expr = 'eager'; },
    // S05-S06: both hands on the staff, watching the rain field above; a start at 27.3 (the drum struck at 27.0), then wonder
    watch(z, th) {
      z.staff = { mode: 'both', base: [-.04, 0, .26], dir: nrm3([0, 1, -.1]), grip: [.92, .76], face: [0, 0, 1] };
      const fc = P.fieldC(th); z.lookW = add3(fc, [-30, -12, 0]); z.expr = th < 27.3 ? 'eager' : th < 27.6 ? 'stunned' : th < 33 ? 'wonder' : 'eager';
      const st = sm(27.25, 27.33, th) * (1 - sm(27.5, 27.8, th)); z.hip[1] += .03 * st; z.chest[0] -= .08 * st;
    },
    // S07: walking into the gust (36-39), leaning more as it blows (P.gust 0..1)
    walk(z, th) { gait(z, th / .667, { stride: .17, lift: .06, dip: .03, bounce: .012, lean: .08 + .15 * P.gust(th), arm: .45, twist: .6 });
      z.staff = { mode: 'R', dir: nrm3([0, 1, .12]), grip: .8, face: [-1, 0, .2] }; z.handRsh = [-.05, -.17, .16]; z.expr = th > 36.3 ? 'stunned' : 'neutral';
      z.handLsh = [.02, .32, .1]; z.poleL = [1, -.2, -.3];   // a hand up to hold the hood against the gust
    },
    grip(z, th) { // S07 from 39: braced against the wind, both hands on the staff, her head shivering in a 3-drawing cycle
      z.footL = [.14, .095, .1]; z.footR = [-.12, .095, -.12]; z.hip[1] -= .06; z.hipR[0] -= .12; z.hipR[1] += .2; z.chest[1] -= .15;
      z.staff = { mode: 'both', base: [-.02, 0, .34], dir: nrm3([-.05, 1, -.2]), grip: [.95, .74], face: [1, 0, 0] }; z.expr = 'determined';
      const w = Math.floor(th * 12) % 3; z.head[2] += .02 * (w - 1);
    },
    // S08: the low, forward-leaning sprint (a stride every .36 s), arms back, the staff pointing ahead
    sprint(z, th) { gait(z, th / .36, { stride: .3, lift: .2, dip: .1, bounce: .035, lean: .55, arm: .3, kick: .4 });
      z.handLsh = [.07, -.2, -.26]; z.handRsh = [-.07, -.18, -.3]; z.poleL = [.3, 1, .2]; z.poleR = [-.3, 1, .2];
      z.staff = { mode: 'R', dir: nrm3([0, .25, 1]), grip: .55, face: [0, 1, 0] }; z.expr = 'determined';
      const an = ramp(th, 42.5, 42.75); if (an > 0) crouch(z, an, .45); },   // 3-drawing anticipation before the leap
    // three leaps: terrace -> the hut roof (42.75-43.0), hut -> the mast (43.5-44.25), mast top -> the first drop (46.1-46.5).
    // Legs tucked; arms reach up for the mast, out for the others. z.launch marks the take-off for the smear in pellPose().
    leap(z, th, p) {
      const seg = th < 43.0 ? [42.75, 43.0] : th < 44.25 ? [43.5, 44.25] : [46.1, 46.5], k = (th - seg[0]) / (seg[1] - seg[0]);
      z.hipR[0] += .25; z.footL = [.08, .32 - .1 * k, .12]; z.footR = [-.08, .42 - .2 * k, -.1]; z.kneeL = z.kneeR = [0, 0, 1]; z.footPL = z.footPR = .6;
      if (seg[0] === 43.5) { z.handLsh = [.04, .38, .16]; z.handRsh = [-.04, .36, .18]; z.poleL = [1, 0, -.3]; z.poleR = [-1, 0, -.3]; }
      else { z.handLsh = [.3, .1, .08]; z.handRsh = [-.3, .14, .02]; z.poleL = [0, -1, -.5]; z.poleR = [0, -1, -.5]; }
      z.staff = seg[0] === 42.75 ? { mode: 'R', dir: nrm3([0, .3, 1]), grip: .5, face: [0, 1, 0] } : { mode: 'back' };
      z.expr = 'determined'; z.launch = seg[0]; },
    // on the hut roof between two leaps: absorb the landing (squashed 12%), then wind up for the next
    crouch(z, th) {
      const land = 1 - ramp(th, 43.0, 43.17), an = ramp(th, 43.25, 43.5);
      crouch(z, Math.max(land * .9, an), .4); z.squash = 1 - .12 * land; z.handLsh = [.2, -.15, -.15 * an]; z.handRsh = [-.2, -.12, -.2 * an];
      z.staff = { mode: 'back' }; z.expr = 'determined'; },
    climb(z, th, p) {   // hand over hand on the Spillway mast (it stands in front of her)
      // pz: how far in front of her the mast's surface is. Two scrambles (44.55-44.85, 45.45-45.75) with holds between,
      // then at 45.85 she stands up on the top and crouches for the leap
      const m = yawV(sub3(V.places.spillway.mast, p.pos), -p.yaw), pz = Math.hypot(m[0], m[2]) - .07;
      const scr = th < 44.85 ? ramp(th, 44.55, 44.85, 'snap') : ramp(th, 45.45, 45.75, 'snap'), held = th < 44.55 || (th > 44.85 && th < 45.45) || th > 45.75;
      z.hip = [0, -.05, pz - .2]; z.hipR = [-.12, 0, 0]; z.chest = [-.15, 0, 0]; z.head = [-.35, 0, 0];
      const top = th > 45.85 ? 1 : 0;
      const hy = held ? 1.18 : 1.18 + .25 * Math.sin(scr * Math.PI);
      z.handL = [.05, hy + .08 * (Math.floor(th * 4) % 2), pz]; z.handR = [-.05, hy - .02, pz]; z.poleL = [1, -.3, -.4]; z.poleR = [-1, -.3, -.4];
      z.footL = [.07, .36 + .15 * (1 - scr), pz - .02]; z.footR = [-.07, .2 + .1 * scr, pz - .02]; z.kneeL = [.6, 0, .4]; z.kneeR = [-.6, 0, .4];
      if (top) { const an = ramp(th, 45.85, 46.1); z.hip = [0, -.2 * an, .1]; z.hipR = [.5 * an, 0, 0]; z.footL = [.07, .095, .05]; z.footR = [-.07, .095, -.05]; z.handLsh = [.1, -.15, -.25]; z.handRsh = [-.1, -.15, -.25]; z.chest = [.2, 0, 0]; z.head = [-.2, 0, 0]; }
      z.staff = { mode: 'back' }; z.expr = 'determined'; if (!held) z.smearK = scr; },
    step(z, th, p) {   // S08-S09, landing on a jelly drop: squash, arms out for balance (p.on is the drop's index in P.hops)
      const d = P.hops[p.on], tau = th - d.ts, k = Math.exp(-tau * 7);
      crouch(z, .75 * k + .15, .3); z.handLsh = [.3, .05, .05]; z.handRsh = [-.32, .1, 0]; z.poleL = [0, -1, -.6]; z.poleR = [0, -1, -.6];
      z.footL = [.1, .095, .04]; z.footR = [-.1, .095, -.04];
      z.staff = { mode: 'R', dir: nrm3([-.3, 1, .1]), grip: .7, face: [-1, 0, 0] }; z.expr = tau < .15 ? 'determined' : 'eager'; z.bell.mode = 'belt'; },
    // in the air between two drops: each hop leaves .4 s after landing and lasts .35 s (the path's staircase, .75 s a drop)
    hop(z, th, p) {
      const i = Math.min(9, Math.floor((th - 46.5) / .75)), d = P.hops[i], k = clamp((th - d.ts - .4) / .35);
      z.hipR[0] += .2; z.footL = [.08, .33 - .15 * k, .14]; z.footR = [-.08, .4 - .2 * k, -.06]; z.footPL = z.footPR = .5;
      z.handLsh = [.28, .18, .05]; z.handRsh = [-.28, .22, 0]; z.poleL = [0, -1, -.6]; z.poleR = [0, -1, -.6];
      z.staff = { mode: 'R', dir: nrm3([-.2, 1, .25]), grip: .7, face: [-1, 0, 0] }; z.expr = 'eager'; z.bell.mode = 'belt'; z.launch = d.ts + .4; },
    bell(z, th) {   // S10: ringing the handbell, faster and harder; 57.0 it cracks
      z.bell = { mode: 'L', mitten: 0 }; z.staff = { mode: 'R', dir: nrm3([-.04, 1, -.06]), grip: .74, face: [-1, 0, .3] }; z.handR = [-.21, .74, .1];
      z.handL = bellHand(th); z.poleL = [1, -.5, -.6];
      z.expr = th < 55.4 ? 'determined' : th < 57 ? 'strain' : 'stunned'; z.gaze = th < 57 ? [.2, -.25] : [.25, -.65];
      const hit = STRIKES.find(s => th >= s && th < s + .17);
      if (hit != null) { z.chest[0] += .06; z.head[0] += .05; z.bellSmear = hit; }
      if (th >= 57) { z.chest[0] -= .04 * (1 - ramp(th, 57.1, 57.5)); z.head[0] += .25 * ramp(th, 57.1, 57.6); z.bell.cracked = 1; }
    },
    // S10-S11 (57-66), broken: the staff hangs from one hand (held 1.5 m up its length), the dead bell in the other; only
    // the fringe and tassels move. 64.5 a small hum, her head lifts (wonder); 65.25 one big inhale and she is resolved.
    still(z, th) {
      z.bell = { mode: 'L', mitten: 0, cracked: 1 }; z.handL = [.13, .74, .2]; z.poleL = [1, -.6, -.5];
      z.handR = [-.18, .6, .05]; z.staff = { mode: 'R', dir: nrm3([.3, 1, .25]), grip: 1.5, face: [-1, 0, 0] };
      z.head[0] += .34 * (1 - ramp(th, 64.55, 65.1)); z.chest[0] += .1 * (1 - ramp(th, 64.6, 65.2)); z.gaze = th < 64.55 ? [.15, -.7] : [0, 0];
      z.expr = th < 64.55 ? 'still' : 'wonder'; z.mouth = th > 64.5 && th < 64.95 ? 'hum' : null;
      const inh = ramp(th, 65.25, 65.5, 'snap');            // one big inhale, held three drawings
      z.chest[0] -= .1 * inh; z.hip[1] += .015 * inh; z.head[0] -= .12 * inh; if (th > 65.25) z.expr = 'determined';
    },
    sing(z, th) {   // S12 (66-69): chest lifted, chin up, arms open, mouth ah then oh (67.5), no blinking
      z.bell = { mode: 'L', mitten: 0, cracked: 1 }; z.chest[0] -= .14; z.head[0] -= .3; z.hip[1] += .005;
      z.handL = [.27, .66, -.02]; z.handR = [-.26, .64, -.02]; z.poleL = [1, 0, -.5]; z.poleR = [-1, 0, -.5];
      z.staff = { mode: 'R', dir: nrm3([-.15, 1, -.05]), grip: .7, face: [-1, 0, 0] };
      z.footL = [.1, .095, .03]; z.footR = [-.1, .095, -.03]; z.expr = 'singing'; z.mouth = th < 67.5 ? 'ah' : 'oh'; z.blink = false;
    },
    fall(z, th) {   // S13-S14 (69-73): running down the falling drops (on ones), arms out, cape and tassels streaming up
      gait(z, th / .42, { stride: .26, lift: .2, dip: .07, bounce: .03, lean: .35, arm: .25, kick: .3, armOut: .2, armUp: .25 });
      z.staff = { mode: 'R', dir: nrm3([-.35, 1, .3]), grip: .7, face: [-1, 0, 0] }; z.bell = { mode: 'belt', mitten: 0, cracked: 1 }; z.expr = 'determined'; z.head[0] += .15; },
    land(z, th) {   // S14 (73-75), into the hush-cloth: a squash, then a bounce (the same damped sine as the path's)
      const tau = th - 73, sq = Math.exp(-tau * 5) * Math.sin(tau * 18);
      z.hip = [0, -.38, -.05]; z.hipR = [-.45, 0, 0]; z.chest = [.15, 0, 0]; z.footL = [.12, .3, .35]; z.footR = [-.12, .26, .38]; z.kneeL = [.3, 1, .3]; z.kneeR = [-.3, 1, .3];
      z.handLsh = [.32, .22, 0]; z.handRsh = [-.32, .2, 0]; z.poleL = [0, -1, -.4]; z.poleR = [0, -1, -.4]; z.squash = 1 - .22 * Math.max(0, -sq) + .1 * Math.max(0, sq);
      z.staff = { mode: 'free', base: [-.5, .05, -.4], dir: nrm3([.2, .15, 1]), face: [0, 1, 0] }; z.bell = { mode: 'belt', mitten: 0, cracked: 1 }; z.expr = tau < .3 ? 'stunned' : 'wonder'; z.wet = 1; },
    sit(z, th) {    // S15 (75-81): soaked, sitting up in the cloth, hood flattened
      z.hip = [0, -.47, -.06]; z.hipR = [-.2, 0, 0]; z.chest = [.12, 0, 0]; z.footL = [.1, .08, .38]; z.footR = [-.12, .1, .33]; z.kneeL = [.2, 1, .2]; z.kneeR = [-.2, 1, .2];
      z.handL = [.2, .08, -.12]; z.handR = [-.2, .08, -.1]; z.poleL = [0, 0, -1]; z.poleR = [0, 0, -1]; z.footPL = -1.1; z.footPR = -1.1;
      z.staff = { mode: 'free', base: [-.45, .03, -.6], dir: nrm3([.15, .02, 1]), face: [0, 1, 0] }; z.bell = { mode: 'belt', mitten: 0, cracked: 1 };
      z.expr = th < 77 ? 'stunned' : 'wonder'; z.wet = 1; z.head[2] += .06 * Math.sin(th * 1.3); },
    stand(z, th) {  // S16: wrapped in Dun's shawl (82.5), the forehead tap, then a laugh with arms flung wide and a hop (84.0)
      z.staff = { mode: 'free', base: [-.6, 0, -.3], dir: nrm3([.05, .02, 1]), face: [0, 1, 0] }; z.bell = { mode: 'belt', mitten: 0, cracked: 1 }; z.wet = 1;
      z.expr = 'wonder'; z.shawl = sm(82.5, 83.05, th);
      // she looks at Dun's head where dunPose() last put it (update() poses Pell first, so that is Dun's previous pose)
      z.lookW = F.cast && F.cast.dun && F.cast.dun.head ? F.cast.dun.head.getWorldPosition(v3()).toArray() : null;
      if (th > 82.5 && th < 84) { const k = ramp(th, 82.5, 82.9); z.handL = mix3(z.handL, [.06, .86, .14], k); z.handR = mix3(z.handR, [-.06, .86, .14], k); z.chest[0] += .05 * k; z.expr = 'peace'; }
      const tap = sm(83.25, 83.33, th) * (1 - sm(83.5, 83.7, th)); z.head[0] -= .2 * tap; if (tap > .5) z.blink = 1;
      if (th >= 84) { const k = ramp(th, 84.0, 84.17, 'snap'), hop = Math.max(0, Math.sin(clamp((th - 84.1) / .45) * Math.PI));
        z.head[0] -= .38 * k; z.chest[0] -= .15 * k; z.handLsh = [.38, .22, .02]; z.handRsh = [-.38, .24, .02]; z.poleL = [0, -1, -.5]; z.poleR = [0, -1, -.5];
        z.hip[1] += .12 * hop; z.footL[1] += .1 * hop; z.footR[1] += .1 * hop; z.footPL = z.footPR = .5 * hop; z.squash = 1 + .06 * hop - .08 * (1 - sm(84.0, 84.1, th)) * k;
        z.expr = th < 85.6 ? 'joyful' : 'eager'; z.lookW = null; }
    },
    bench(z, th) {  // S17: on the Spillway bench, the cracked bell in her lap; 88.2-88.6 she cups her hands for the stray drop
      // (at P.palmPos, where path.js lets it come down; nothing sets z.palmL), and hums from 88.5
      z.hip = [0, -.525, -.02]; z.hipR = [-.04, 0, 0]; z.footL = [.08, -.36, .27]; z.footR = [-.08, -.36, .25]; z.kneeL = [.1, 1, 1]; z.kneeR = [-.1, 1, 1];
      z.staff = { mode: 'free', base: [-.42, -.45, .15], dir: nrm3([.08, 1, -.18]), face: [-1, 0, 0] }; z.shawl = 1; z.wet = 0; z.expr = 'peace';
      const cup = sm(88.2, 88.6, th);
      z.bell = { mode: 'lap', mitten: 0, cracked: 1 };
      const palm = z.palmL || P.palmPos, pl = yawV(sub3(palm, z.pos), -z.yaw);
      z.handL = mix3([.07, .17, .2], add3(pl, [.025, -.03, 0]), cup); z.handR = mix3([-.07, .17, .2], add3(pl, [-.025, -.03, 0]), cup);
      z.poleL = [1, -.5, -.3]; z.poleR = [-1, -.5, -.3]; z.head[0] += .2 * (1 - cup) + .1; z.gaze = [0, -.55];
      if (th > 88.5 && th < 90.4) { z.mouth = 'hum'; }
    },
  };

  // ---- put a pose on the rig
  // toW / dirW: a point / direction in R's space (character space for the root) -> world;  toR: world point -> R's space
  const _w = v3(), _w2 = v3(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
  const toW = (R, p) => _w.set(p[0], p[1], p[2]).applyMatrix4(R.matrixWorld).clone();
  const dirW = (R, d) => _w2.set(d[0], d[1], d[2]).transformDirection(R.matrixWorld).clone();
  const toR = (R, wv) => R.worldToLocal(wv.clone());
  // the staff's frame: its +y runs along dir, its +z toward face (the way the crook opens). In one hand (mode R or L) it
  // slides so that the point grip metres up the staff sits in the palm; 'both' and 'free' stand it on base (character
  // space; for 'both' applyPell has already put the hands on it); 'back' hangs it on the chest bone.
  function placeStaff(z) {
    const st = z.staff, S0 = pell.staff, Q = pell.squash, B = pell.rig.bones;
    if (st.mode === 'back') {   // slung across her back, crook up over the left shoulder
      if (S0.parent !== B.chest) B.chest.add(S0);
      S0.position.set(-.25, -.52, -.2); S0.quaternion.setFromEuler(_eu.set(.05, Math.PI, .42)); S0.updateMatrixWorld(true); return; }
    if (S0.parent !== Q) Q.add(S0);
    const dir = v3(...st.dir).normalize(), f = v3(...(st.face || [0, 0, 1])); f.addScaledVector(dir, -f.dot(dir)); if (f.lengthSq() < 1e-6) f.set(1, 0, 0); f.normalize();
    const x = v3().crossVectors(dir, f); _m.makeBasis(x, dir, f); S0.quaternion.setFromRotationMatrix(_m);
    let base;
    if (st.mode === 'R' || st.mode === 'L') { const h = (st.mode === 'R' ? B.handR : B.handL).localToWorld(v3(0, -.04, .005)); const hl = toR(Q, h); base = hl.addScaledVector(dir, -st.grip); }
    else base = v3(...st.base);
    S0.position.copy(base); S0.updateMatrixWorld(true);
  }
  // order: root and spine first (with the squash undone, so IK works in true metres), then the head, the legs, the arms,
  // the staff and the bell, and last the squash scale
  function applyPell(z, t) {
    const R = pell.root, Q = pell.squash, rig = pell.rig, B = rig.bones, RS = rig.rest;
    R.position.set(...z.pos); R.rotation.set(0, z.yaw, 0); Q.scale.set(1, 1, 1);
    B.hips.position.set(RS.hips[0] + z.hip[0], RS.hips[1] + z.hip[1], RS.hips[2] + z.hip[2]);
    setE(B.hips, z.hipR); setE(B.chest, z.chest);
    for (const n of ['armL', 'foreL', 'handL', 'armR', 'foreR', 'handR', 'legL', 'shinL', 'footL', 'legR', 'shinR', 'footR', 'neck']) B[n].quaternion.identity();
    R.updateMatrixWorld(true);
    // head: a look-at (world point) shared between the neck and the eyes, plus the pose's own nod/turn/tilt.
    // Measured from eye height (17 cm above the neck joint) in the chest's frame: the neck takes 80% of the turn (clamped to
    // +-1.2 rad of yaw, -.7..+.6 of pitch), and unless the pose set its own gaze the eyes take the rest (1 = .4 rad).
    let hd = z.head.slice();
    if (z.lookW) { B.chest.updateWorldMatrix(true, false); const np = B.neck.getWorldPosition(v3()).add(v3(0, .17, 0)); const d = v3(...z.lookW).sub(np);
      B.chest.getWorldQuaternion(_qa); d.applyQuaternion(_qa.invert());
      const yaw = Math.atan2(d.x, d.z), pit = -Math.atan2(d.y, Math.hypot(d.x, d.z));
      const ty = clamp(yaw, -1.2, 1.2), tp = clamp(pit, -.7, .6); hd[0] += tp * .8; hd[1] += ty * .8;
      if (!z.gaze) z.gaze = [clamp((yaw - ty * .8) / .4, -1, 1), clamp(-(pit - tp * .8) / .4, -1, 1)]; }
    setE(B.neck, hd); B.neck.updateMatrixWorld(true);
    // legs: IK to the ankle targets, knees toward their poles; each foot level with the root, then pitched by footP
    const rq = R.getWorldQuaternion(_qb);
    for (const s of ['L', 'R']) { ik(B['leg' + s], B['shin' + s], B['foot' + s], toW(R, z['foot' + s]), dirW(R, z['knee' + s]));
      setWorldQ(B['foot' + s], rq.clone().multiply(_qa.setFromAxisAngle(v3(1, 0, 0), z['footP' + s] || 0))); }
    // arms: shoulder-relative targets become character space; with the staff in both hands the hands go to the grip points
    for (const s of ['L', 'R']) { const rel = z['hand' + s + 'sh']; if (rel) { const shp = toR(R, B['arm' + s].getWorldPosition(v3())); z['hand' + s] = add3(shp.toArray(), rel); } }
    if (z.staff.mode === 'both') { const st = z.staff, d = nrm3(st.dir); z.handR = add3(st.base, mul3(d, st.grip[1])); z.handL = add3(st.base, mul3(d, st.grip[0]));
      z.poleL = [.6, -.4, -1]; z.poleR = [-.6, -.4, -1]; }
    for (const s of ['L', 'R']) { const T = toW(R, z['hand' + s]), pole = dirW(R, z['pole' + s]);
      ik(B['arm' + s], B['fore' + s], B['hand' + s], T, pole);
      // aim the grip, not the wrist: pull the target back along the forearm and solve once more
      const fw = B['hand' + s].getWorldPosition(v3()).sub(B['fore' + s].getWorldPosition(v3())).normalize();
      ik(B['arm' + s], B['fore' + s], B['hand' + s], T.clone().addScaledVector(fw, -.04), pole); }
    placeStaff(z);
    // bell: in a hand (L / R), at her left hip ('belt', on the hips bone), or in her lap ('lap', for the bench)
    const bl = pell.bell, bm = z.bell.mode;
    if (bm === 'L' || bm === 'R') { const h = B['hand' + bm]; if (bl.parent !== h) h.add(bl); bl.position.set(0, -.03, .006); bl.rotation.set(0, 0, 0); }
    else if (bm === 'belt') { if (bl.parent !== B.hips) B.hips.add(bl); bl.position.set(.105, -.02, .06); bl.rotation.set(0, .3, .12); }
    else if (bm === 'lap') { if (bl.parent !== Q) Q.add(bl); const hp = B.hips.position; bl.position.set(0, hp.y + .07, .2); bl.rotation.set(-1.25, 0, 0); }
    pell.mitten.visible = (z.bell.mitten ?? 0) > .5; pell.bellU.uCrack.value = z.bell.cracked ? 1 : 0;
    // squash and stretch (the whole drawing, pivoting at her feet)
    Q.scale.set(1 / Math.sqrt(z.squash), z.squash, 1 / Math.sqrt(z.squash));
    R.updateMatrixWorld(true);
  }

  // ---- what moves every frame: the cape, the fringe, the tassels and beads (lag behind her path; the meter)
  // Instead of simulating cloth, each piece is offset by her path velocity a moment ago: the lag is a closed-form function of
  // t, so seeking needs no pre-roll. Note that the velocities come from FILM.path.pell, not from a shot's pos override.
  // pathVel: her velocity in m/s, by a .05 s finite difference; a jump faster than 16 m/s is a cut in the path, read as 0.
  const pathVel = t => { const a = P.pell(t).pos, b = P.pell(t - .05).pos; const v = mul3(sub3(a, b), 20); return len3(v) > 16 ? [0, 0, 0] : v; };
  // z is the frame's last pose, t film time (not held: this runs on ones). Velocities now, .12 s ago and .32 s ago, turned
  // into character space; z.vel / z.velLag / z.velOld would override them, but nothing sets them at present.
  function secondary(z, t) {
    const R = pell.root, yaw = z.yaw, B = pell.rig.bones;
    const vel = z.vel || pathVel(t), velLag = z.velLag || pathVel(t - .12), velOld = z.velOld || pathVel(t - .32);
    const vl = yawV(velLag, -yaw), vo = yawV(velOld, -yaw), vn = yawV(vel, -yaw);
    // the gust (0..1) blows toward +x (east), a little south; mt is the clothing meter at her head, and her own singing
    // shakes it too
    const g = P.gust(t), wind = yawV([1, 0, .2], -yaw);
    const mt = meter(P.pellHead(t), t) * (z.meterK ?? 1) + (z.state === 'sing' ? .08 * Math.sin(TAU * 11 * t) : 0);
    // the cape hem trails her velocity (a tenth of a second late), overshoots when she stops, and fills with the gust.
    // In metres: 2.4 cm back per m/s of speed, plus 1.2 cm per m/s she has lost in the last .32 s; never more than 26 cm.
    let lag = add3(mul3(vl, -.024), mul3(sub3(vo, vn), .012)); lag = add3(lag, mul3(wind, .16 * g)); const ll = len3(lag); if (ll > .26) lag = mul3(lag, .26 / ll);
    const spd = Math.min(1, len3(vl) / 7) + .6 * g;   // how hard the cloth flutters: 1 at a 7 m/s run, more in the gust
    // cape: rest shape relative to the chest, through the chest bone's current matrix, plus the lag (weighted toward the hem)
    const Mc = _m.copy(R.matrixWorld).invert().multiply(B.chest.matrixWorld), cr = PJ.chest;
    const shL = toR(R, B.armL.getWorldPosition(v3())), elL = toR(R, B.foreL.getWorldPosition(v3())), shR = toR(R, B.armR.getWorldPosition(v3())), elR = toR(R, B.foreR.getWorldPosition(v3()));
    const hipP = toR(R, B.hips.getWorldPosition(v3())), chP = toR(R, B.chest.getWorldPosition(v3())).add(v3(0, .08, 0));
    // collision capsules in root space: the two upper arms (r 5.2 cm) and the torso from hips to chest (r 10.8 cm, more at the hem)
    const SG = [[shL, elL, .052], [shR, elR, .052], [hipP, chP, .108]].map(([a, b, r]) => [a.x, a.y, a.z, b.x - a.x, b.y - a.y, b.z - a.z, r]);
    const e = Mc.elements, CM = CAPE_MID, nU = CNU + 1;
    for (let j = 0; j <= CNV; j++) for (let i = 0; i <= CNU; i++) { const k = j * nU + i, r0 = CAPE_REST[k], v = j / CNV, u = i / CNU, w = Math.pow(v, 1.5);
      const x0 = r0[0] - cr[0], y0 = r0[1] - cr[1], z0 = r0[2] - cr[2];
      // w = v^1.5: the collar follows the chest exactly, the hem takes the full lag; fl is a travelling flutter wave
      let x = e[0] * x0 + e[4] * y0 + e[8] * z0 + e[12], y = e[1] * x0 + e[5] * y0 + e[9] * z0 + e[13], zz = e[2] * x0 + e[6] * y0 + e[10] * z0 + e[14];
      const fl = (.006 + .035 * spd) * Math.sin(t * (8 + 7 * spd) - u * 13 + v * 4) * w + .012 * mt * Math.sin(u * 37) * w;
      const ripple = .045 * spd * Math.sin(t * 11 + u * 9 - v * 5) * w;     // the cloth folds and unfolds as it streams
      x += lag[0] * w + fl * Math.sin(u * TAU); y += lag[1] * w * (1 - .35 * v) + ripple + Math.abs(fl) * .5; zz += lag[2] * w + fl * Math.cos(u * TAU);
      // keep out of the upper arms and the torso (capsules)
      for (let q = 0; q < 3; q++) { const c = SG[q], r = c[6] + (q === 2 ? .02 * v : 0), px = x - c[0], py = y - c[1], pz = zz - c[2], l2 = c[3] * c[3] + c[4] * c[4] + c[5] * c[5] || 1;
        const h = clamp((px * c[3] + py * c[4] + pz * c[5]) / l2), dx = px - c[3] * h, dy = py - c[4] * h, dz = pz - c[5] * h, l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l < r && l > 1e-6) { const f = (r - l) / l; x += dx * f; y += dy * f; zz += dz * f; } }
      CM[k * 3] = x; CM[k * 3 + 1] = y; CM[k * 3 + 2] = zz; }
    // normals of the mid-surface by central differences; the outer and inner faces sit CTH either side of it
    const pa = pell.capeGeo.attributes.position.array, na = pell.capeGeo.attributes.normal.array, nM = nU * (CNV + 1);
    for (let j = 0; j <= CNV; j++) for (let i = 0; i <= CNU; i++) { const k = j * nU + i, i1 = j * nU + Math.min(CNU, i + 1), i0 = j * nU + Math.max(0, i - 1), j1 = Math.min(CNV, j + 1) * nU + i, j0 = Math.max(0, j - 1) * nU + i;
      const ux = CM[i1 * 3] - CM[i0 * 3], uy = CM[i1 * 3 + 1] - CM[i0 * 3 + 1], uz = CM[i1 * 3 + 2] - CM[i0 * 3 + 2], vx = CM[j1 * 3] - CM[j0 * 3], vy = CM[j1 * 3 + 1] - CM[j0 * 3 + 1], vz = CM[j1 * 3 + 2] - CM[j0 * 3 + 2];
      let nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux; const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const o = k * 3, o2 = (nM + k) * 3;
      pa[o] = CM[o] + nx * CTH; pa[o + 1] = CM[o + 1] + ny * CTH; pa[o + 2] = CM[o + 2] + nz * CTH; na[o] = nx; na[o + 1] = ny; na[o + 2] = nz;
      pa[o2] = CM[o] - nx * CTH; pa[o2 + 1] = CM[o + 1] - ny * CTH; pa[o2 + 2] = CM[o + 2] - nz * CTH; na[o2] = -nx; na[o2 + 1] = -ny; na[o2 + 2] = -nz; }
    pell.capeGeo.attributes.position.needsUpdate = true; pell.capeGeo.attributes.normal.needsUpdate = true;
    // fringe (head space): trails the head's motion, the gust, and the meter (a few mm to 2 cm); it lifts while she falls
    const hq = pell.head.getWorldQuaternion(new THREE.Quaternion()).invert(), vh = v3(...velLag).applyQuaternion(hq), wh = v3(1, 0, .2).applyQuaternion(hq);
    const fo = [clamp(-vh.x * .0035, -.02, .02) + wh.x * .012 * g + .0025 * Math.sin(t * 2.3) + .006 * mt, clamp(-vh.y * .002, -.012, .02), clamp(-vh.z * .002, -.01, .012) + .004 * mt];
    if (z.state === 'fall') fo[1] += .025;
    updateFringe(fo);
    // tassels and beads hang from the brim (head space -> root space), lag and shiver on ones. anchor(a) is a point just
    // under the brim's edge at angle a (lower when the wet hood has flattened). Each tassel turns from straight down toward
    // the lag (2.2 x the cape's), the gust and the meter (alternate tassels swing opposite ways); the beads hang in a
    // 3.8 cm parabolic sag between their two anchors and swing by the same lag and meter.
    const hm = new THREE.Matrix4().copy(R.matrixWorld).invert().multiply(pell.head.matrixWorld), wet = z.wet || 0, qd = new THREE.Quaternion(), dn = v3(0, -1, 0);
    const anchor = a => { const r = rimR(a) - .008; return v3(Math.sin(a) * r, rimY(a) - .006 - wet * .045, Math.cos(a) * r).applyMatrix4(hm); };
    const lagT = mul3(lag, 2.2);
    TASSEL_A.forEach((a, i) => { const p = anchor(a), sh = mt * (i % 2 ? 1 : -1), dir = v3(lagT[0] + sh * Math.cos(a) + .1 * g * wind[0], -1 + Math.max(0, lagT[1]), lagT[2] - sh * Math.sin(a) + .1 * g * wind[2]).normalize();
      qd.setFromUnitVectors(dn, dir); _m.compose(p, qd, v3(1, 1, 1)); pell.tassels.setMatrixAt(i, _m); });
    pell.tassels.instanceMatrix.needsUpdate = true;
    const A0 = anchor(BEAD_A[0]), A1 = anchor(BEAD_A[1]);
    for (let i = 0; i < 7; i++) { const s = (i + 1) / 8, bow = 4 * s * (1 - s), p = A0.clone().lerp(A1, s);
      p.y -= .038 * bow - Math.max(0, lagT[1]) * .03 * bow; p.x += (lagT[0] * .035 + mt * .02 * Math.sin(i * 2.1)) * bow; p.z += (lagT[2] * .035 + mt * .02 * Math.cos(i * 1.7)) * bow;
      _m.makeTranslation(p.x, p.y, p.z); pell.beads.setMatrixAt(i, _m); }
    pell.beads.instanceMatrix.needsUpdate = true;
  }

  // ---- the bell's shard and clapper (57.0): slow analytic arcs away from the hand, tumbling
  // They start at FILM.path.pellHand(57.0) and fall at 2.2 m/s^2 (y gains -1.1 tau^2), a slow, dreamlike drop; the
  // clapper flies the other way. On ones (film time) and visible from 57.0 to 60.5.
  function debris(t) {
    const on = t >= 57.0 && t < 60.5; pell.shard.visible = pell.clapper.visible = on; if (!on) return;
    const tau = t - 57.0, h0 = P.pellHand(57.0), y0 = P.pell(57.0).yaw, out = yawV([.6, .3, .9], y0);
    const arc = (k, sp, up) => [h0[0] + out[0] * sp * tau * k, h0[1] + .05 + up * tau - 1.1 * tau * tau, h0[2] + out[2] * sp * tau * k];
    pell.shard.position.set(...arc(1, .55, .9)); pell.shard.rotation.set(tau * 5.1, tau * 3.3, tau * 2.2);
    pell.clapper.position.set(...arc(-.6, .35, .5)); pell.clapper.rotation.set(tau * 2, 0, tau * 4);
  }

  // ---- Pell's pose for film time t
  // The body is posed at held time th (unless o.onOnes); the smears, the face uniforms and secondary() use film time t.
  // Calling it again in the same frame (a shot after update()) simply replaces the pose: secondary motion follows the last call.
  function pellPose(t, o = {}) {
    if (!pell.root) return null;
    const th = o.onOnes ? t : A.held(t);
    const p = P.pell(th);
    const z = basePose(); z.pos = (o.pos || p.pos).slice(); z.yaw = o.yaw ?? p.yaw; z.state = o.state || p.state;
    // the wet and the shawl, by default
    z.wet = t >= 72.8 && t < 87 ? 1 : 0; z.shawl = t >= 83.05 ? 1 : 0;
    if (STATES[z.state]) STATES[z.state](z, th, p, o);
    // the bell, by default: before 54 the mitten is on and the bell rides at her belt (she holds it only in the roof, watch
    // and idle states); from 54 the mitten is off, and from 57 the bell is cracked
    z.bell.mitten = z.bell.mitten ?? (th < 54 ? 1 : 0); if (th < 54 && z.bell.mode === 'L' && z.state !== 'roof' && z.state !== 'watch' && z.state !== 'idle') z.bell.mode = 'belt';
    if (th >= 54 && !z.bell.cracked) z.bell.cracked = th >= 57 ? 1 : 0; if (th >= 54) z.bell.mitten = 0;
    // a shot's overrides
    if (o.expr) z.expr = o.expr; if (o.wet != null) z.wet = o.wet; if (o.lean) z.hipR[0] += o.lean; if (o.look) z.lookW = o.look; if (o.gaze) z.gaze = o.gaze;
    if (o.head) { z.head[0] += o.head.nod || 0; z.head[1] += o.head.turn || 0; z.head[2] += o.head.tilt || 0; }
    if (o.arms) { if (o.arms.L) z.handL = o.arms.L, z.handLsh = null; if (o.arms.R) z.handR = o.arms.R, z.handRsh = null; }
    if (o.staff) z.staff = Object.assign({}, z.staff, o.staff); if (o.bell) z.bell = Object.assign({}, z.bell, o.bell);
    if (o.shawl != null) z.shawl = o.shawl; if (o.squash) z.squash = o.squash;
    applyPell(z, t);
    // smear: a launch (two frames on ones), a scramble on the mast, the bell strike, or the shot's own vector.
    // A launch stretches her back by the distance the path covers in 1/20 s; the vector goes to the shader in character space.
    let sm3 = o.smear || null;
    if (!sm3 && z.launch != null && t >= z.launch && t < z.launch + 2 / 24) sm3 = mul3(sub3(P.pell(z.launch + .06).pos, P.pell(z.launch).pos), 1 / .06 * .05);
    if (!sm3 && z.smearK > .2) sm3 = [0, .12 * z.smearK, 0];
    pell.body.material.uniforms.uSmear.value.set(...(sm3 ? yawV(sm3, -z.yaw) : [0, 0, 0]));
    // the bell's own smear on the strike frames: a fixed streak in bell space for two frames (stands in for M14's -0.4 x velocity)
    const bs = z.bellSmear != null && t >= z.bellSmear && t < z.bellSmear + 2 / 24 ? [0, .07, -.03] : [0, 0, 0];
    pell.bellU.uSmearV.value.set(...bs);
    // face: both eyes get the same lid (uEyeA.y could close the right eye on its own; nothing uses that yet), freckles always on
    const f = faceOf(z, th, Object.assign({ mouth: z.mouth, blink: z.blink }, o, { mouth: o.mouth || z.mouth || undefined, blink: o.blink ?? z.blink }));
    const U = pell.faceU, lidR = f.lid;
    U.uEyeA.value.set(f.lid, lidR, f.gaze[0], f.gaze[1]); U.uEyeB.value.set(f.wide, f.happy, f.sparkle, f.dull);
    U.uBrowA.value.set(f.brow[0], f.brow[1], f.brow[2], 0); U.uMouthA.value.set(f.open, f.w, f.topK, f.smile); U.uMouthB.value.set(f.teeth, 0, 0, 0);
    U.uCheekA.value.set(f.blush, 1, 0, o.dots ? 1 : 0);
    pell.wetU.value = z.wet; pell.hoodU.uWet.value = z.wet;
    // secondary() runs from the render hook with this pose (see buildPell); pell.last is what Tock and Dun read
    z.meterK = 1; pell.secDirty = { z, t }; debris(t);
    pell.last = z; z.face = f;
    if (tock.root && tock.attach) attachTock();   // nothing sets tock.attach at present, so this never runs
    return z;
  }

  // ================================================================== TOCK
  // Pell's tock bird, about 11 cm tall: one sculpted mesh (no skeleton) plus two instanced wings. His space: feet at the
  // origin, facing +z. Tags: 1 blue body, 2 white belly, 3 the brass bell-throat, 4 beak and feet, 5 eyes.
  const tock = {};
  function tockParts() {
    const C = PAL, H = [], add = (f, col, tag, k = .012) => H.push({ f, col, tag, k });
    add(S.sph([0, .058, 0], .05), C.tock, 1);
    add(S.ell([0, .05, .02], [.041, .038, .034]), C.tockBelly, 2, .02);
    add(S.cap([0, .07, -.04], [0, .086, -.072], .014, .005), C.tock, 1, .014);       // tail
    add(S.cap([0, .1, .0], [0, .116, -.014], .006, .002), C.tock, 1, .008);          // a little crest
    add(S.cut(S.cap([0, .053, .038], [0, .04, .06], .008, .0145), S.sph([0, .037, .064], .0105), .003), C.brass, 3, .008);   // the bell-throat, open at the mouth
    add(S.cap([0, .07, .044], [0, .066, .066], .0085, .0018), C.beak, 4, .006);       // apricot cone beak
    for (const s of [1, -1]) { add(S.sph([s * .027, .074, .035], .0075), '#1E1626', 5, .003);   // a bead eye, then a foot
      add(S.cap([s * .014, .012, .006], [s * .015, .0, .02], .0042, .0034), C.beak, 4, .004); }
    return H;
  }
  // The vertex shader opens the bell-throat (uThroat: it grows 55% about its root as he trills) and puffs his feathers
  // (uPuff: body and belly pushed out 6-8 mm along the normal, rippled). The fragment makes the blue more saturated, puts a
  // fixed highlight in each eye (it does not move with the light, like a drawn one), a glint on the brass and a dark
  // opening in the throat.
  function buildTock(scene) {
    tock.u = { uThroat: { value: 0 }, uPuff: { value: 0 } };
    const mat = cel({ vcol: true, shadeRGB: [.8, .9, 1.18], rim: .1, paintK: .08, paintS: 18, uniforms: tock.u, vpars: 'uniform float uThroat, uPuff;',
      vdeform: /* glsl */`if (aId > 2.5 && aId < 3.5) { vec3 r0 = vec3(0.0, 0.053, 0.04); transformed = r0 + (transformed - r0) * vec3(1.0 + 0.55 * uThroat, 1.0 + 0.55 * uThroat, 1.0 + 0.25 * uThroat); }
        transformed += normal * uPuff * (0.006 + 0.002 * sin(P0.x * 160.0 + P0.y * 140.0)) * step(aId, 2.5);`,
      fpost: /* glsl */`
      { float blue = 1.0 - step(0.5, abs(vId - 1.0)); float l0 = dot(c, vec3(0.3, 0.59, 0.11)); c = mix(c, mix(vec3(l0), c, 1.25), blue);
        float eye = 1.0 - step(0.5, abs(vId - 5.0)); vec3 on = normalize(vON + vec3(1e-5));
        float hl = smoothstep(0.9, 0.93, dot(on, normalize(vec3(0.0, 0.62, 0.78))));
        c = mix(c, vec3(1.0), hl * eye);
        float brass = 1.0 - step(0.5, abs(vId - 3.0)); vec3 Hh = normalize(uSunDir + V); c += ${G('#FFE7B0')} * brass * smoothstep(0.95, 0.97, dot(N, Hh)) * 0.5;
        c = mix(c, ${G('#3A2012')}, brass * smoothstep(0.009, 0.006, length(vOP - vec3(0.0, 0.037, 0.064)))); }` });
    const body = prepMesh(new THREE.Mesh(S.mesh(tockParts(), [-.07, -.008, -.085], [.07, .125, .09], .0029, { blend: .004 }), mat));
    const R = new THREE.Group(); R.name = 'tock'; const Q = new THREE.Group(); R.add(Q); Q.add(body); scene.add(R); ink(body, PAL.tockInk, 1.5, .005);
    // a stub paddle wing: a flattened ellipsoid (7 x 26 x 34 mm half-sizes) hinged at its top; two instances, flapped in tockPose()
    const wg = new THREE.SphereGeometry(1, 12, 8); wg.scale(.007, .026, .034); wg.translate(0, -.02, -.012);
    tock.wings = prepMesh(new THREE.InstancedMesh(merge([{ g: wg, col: PAL.tockWing, id: 1 }]), cel({ vcol: true, shadeRGB: [.92, .98, 1.12], paintK: .05 }), 2), false);
    tock.wings.instanceMatrix.setUsage(THREE.DynamicDrawUsage); Q.add(tock.wings); ink(tock.wings, PAL.tockInk, 1.3, .004);
    Object.assign(tock, { root: R, squash: Q, body, head: body });
  }
  // what Tock is doing at t (default choreography); the shot may override with opts.
  // Modes: 'hood' / 'crook' perch on Pell's anchors; 'hop' jumps from one to the other (k 0..1); 'fly' and 'ground' sit at
  // off, an offset in Pell's character space (fly offsets start at her neck height).
  function tockPlan(t) {
    if (t < 19.0) return { mode: 'hood' };
    if (t < 19.33) return { mode: 'hop', from: 'hood', to: 'crook', k: (t - 19.0) / .33 };
    if (t < 42.0) return { mode: 'crook' };
    if (t < 54.0) return { mode: 'fly', off: [.42, .3, -.25] };                         // beside her through the leaps, the climb and the staircase
    if (t < 58.6) return { mode: 'crook', puff: t > 57.0 ? 1 - sm(58.0, 58.6, t) : 0 };  // puffed up by the crack
    if (t < 58.93) return { mode: 'hop', from: 'crook', to: 'hood', k: (t - 58.6) / .33 };
    if (t < 68.4) return { mode: 'hood' };
    if (t < 73.0) return { mode: 'fly', off: [.3, .45, .12], trill: t >= 68.6 && t < 71.2 };   // his E6 trill (the 69.0 toll)
    if (t < 81.0) return { mode: 'ground', off: [.34, 0, .3], shake: t > 76.4 && t < 76.9 };    // beside her in the cloth, shaking off
    return { mode: 'hood' };
  }
  // perch: parent Tock to the crook or the hood's crown, so he rides along with no extra work; on the crook he sits sideways
  function attachTock() {
    const pl = tock.plan, R = tock.root;
    const target = pl.mode === 'crook' ? pell.crook : pl.mode === 'hood' ? pell.headTop : null;
    if (target) { if (R.parent !== target) target.add(R); R.position.set(0, 0, 0); R.quaternion.identity();
      if (pl.mode === 'crook') R.rotation.set(0, Math.PI / 2 + (tock.turn || 0), 0); else R.rotation.set(0, tock.turn || 0, 0);
      // stay upright in the world whatever the staff does
      R.updateMatrixWorld(true); const wq = R.getWorldQuaternion(new THREE.Quaternion()); const e = new THREE.Euler().setFromQuaternion(wq, 'YXZ');
      const up = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, e.y, 0, 'YXZ')); target.getWorldQuaternion(_qa).invert(); R.quaternion.copy(_qa.multiply(up));
      R.position.y += tock.hopY || 0; R.updateMatrixWorld(true); }
  }
  // opts: mode, plan (merged into tockPlan's), puff, trill, turn, onOnes. Returns the plan used.
  function tockPose(t, o = {}) {
    if (!tock.root) return null;
    const th = o.onOnes ? t : A.held(t), pl = Object.assign(tockPlan(th), o.plan || {}); if (o.mode) pl.mode = o.mode;
    tock.plan = pl; const R = tock.root, Q = tock.squash, scene = F.three && F.three.scene;
    // a tilt and a turn picked by hash every 1.25 s and held (they snap, like drawn head turns); while perched, a little
    // hop (1.8 cm) in the last tenth of every 2.7 s
    const slot = Math.floor(th / 1.25), tilt = [0, .32, -.28, .12][Math.floor(A.hash(slot, 7) * 4)], turn = [-.5, .3, 0, .6][Math.floor(A.hash(slot, 9) * 4)];
    tock.turn = o.turn ?? turn * .6; const hopT = (th % 2.7) / 2.7; tock.hopY = pl.mode === 'crook' || pl.mode === 'hood' ? (hopT > .9 ? .018 * Math.sin((hopT - .9) / .1 * Math.PI) : 0) : 0;
    const puff = o.puff ?? pl.puff ?? 0, trill = o.trill ?? pl.trill ?? false;
    let flap = 0;
    // off a perch he lives in world space: a .3 m arc between the anchors for a hop, or Pell's position plus the offset
    // (bobbing while he flies); he turns with her, and on the ground faces back toward her
    if (pl.mode === 'fly' || pl.mode === 'hop' || pl.mode === 'ground') {
      if (scene && R.parent !== scene) scene.add(R);
      const pz = pell.last || basePose(); let w;
      if (pl.mode === 'hop') { const ends = { hood: pell.headTop, crook: pell.crook }, a = ends[pl.from].getWorldPosition(v3()), b = ends[pl.to].getWorldPosition(v3()); w = a.lerp(b, pl.k); w.y += .3 * Math.sin(pl.k * Math.PI); }
      else { const off = pl.off.slice(); if (pl.mode === 'fly') { off[1] += .05 * Math.sin(th * 7); off[0] += .03 * Math.sin(th * 2.3); }
        w = v3(...add3(pz.pos, yawV(off, pz.yaw))); if (pl.mode === 'fly') w.add(v3(0, PJ.neck[1] * pz.squash, 0)); }
      R.position.copy(w); R.rotation.set(0, pz.yaw + (pl.mode === 'ground' ? -2.2 : 0) + tock.turn * .3, 0);
      flap = pl.mode === 'ground' ? 0 : 1;
    } else attachTock();
    // body: puff 1.3x when startled, a quick shake, wings flap on twos (up one drawing, down the next).
    // The throat is half open while she sings (67.5-71.6) and wide open while he trills.
    const s = 1 + .3 * puff; Q.scale.set(s, s * (1 - .05 * puff), s);
    Q.rotation.set(0, pl.shake ? .5 * Math.sin(th * 60) : 0, tilt + (pl.shake ? .3 * Math.sin(th * 47) : 0));
    tock.u.uPuff.value = puff; tock.u.uThroat.value = trill ? 1 : sm(67.5, 68.4, th) * (1 - sm(71.2, 71.6, th)) * .5;
    const fp = flap ? (Math.floor(th * 12) % 2 ? 1.2 : -.5) : (pl.mode === 'crook' && hopT > .9 ? .6 : 0);
    for (const sd of [0, 1]) { const sg = sd ? -1 : 1; _m.compose(v3(sg * .046, .074, -.004), new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, 0, sg * (.12 + fp))), v3(1, 1, 1)); tock.wings.setMatrixAt(sd, _m); }
    tock.wings.instanceMatrix.needsUpdate = true; R.updateMatrixWorld(true);
    return pl;
  }

  // ================================================================== OLD DUN
  // The head toller: about 1.5 m, broad as a barrel. Built like Pell (sculpted skinned body, same 15-bone hierarchy with her own
  // joint positions, a rigid head with a painted face) plus the poncho shawl, the 0.9 m drum and the felt mallet.
  const DJ = (() => { const j = { hips: [0, .6, 0], chest: [0, .9, 0], neck: [0, 1.16, -.01], armL: [.21, 1.07, -.01], foreL: [.27, .85, -.02], handL: [.29, .66, .02],
      legL: [.1, .56, 0], shinL: [.1, .32, .01], footL: [.1, .085, 0] };
    for (const k of ['arm', 'fore', 'hand', 'leg', 'shin', 'foot']) { const p = j[k + 'L']; j[k + 'R'] = [-p[0], p[1], p[2]]; } return j; })();
  const DDEF = PDEF.map(([n, p]) => [n, p, DJ[n]]);
  // the body: the robe (the first three parts, which the body shader reads as robe), a felt sash, arms, hands, felt shoes,
  // the drum straps crossing her chest, and the braid
  function dunBodyParts(ix) {
    const C = PAL, out = [], add = (f, col, bone, k = .04) => out.push({ f, col, bone: ix[bone], k });
    add(S.ell([0, .98, -.01], [.2, .17, .165]), C.robe, 'chest');
    add(S.ell([0, .64, .015], [.3, .42, .262]), C.robe, 'hips', .1);                   // the barrel
    add(S.cap([0, .3, .01], [0, .15, .01], .225, .232), C.robe, 'hips', .07);          // the hem
    add(S.torus([0, .8, .02], .272, .024), C.felt, 'hips', .006);                      // a felt sash
    add(S.cap([0, 1.1, -.01], [0, 1.2, -.01], .055), C.dunSkin, 'neck', .04);
    for (const s of [1, -1]) { const L = s > 0 ? 'L' : 'R', J = n => DJ[n + L];
      add(S.cap(J('arm'), J('fore'), .07, .06), C.robe, 'arm' + L, .05);
      add(S.cap(J('fore'), J('hand'), .06, .052), C.robe, 'fore' + L, .03);
      add(S.ell(add3(J('hand'), [0, -.05, .008]), [.037, .048, .03]), C.dunSkin, 'hand' + L, .02);
      add(S.cap(add3(J('hand'), [-s * .018, -.025, .024]), add3(J('hand'), [-s * .024, -.058, .034]), .014, .012), C.dunSkin, 'hand' + L, .01);
      add(S.cap(J('leg'), J('shin'), .07, .06), C.robe, 'leg' + L, .04);
      add(S.ell(add3(J('foot'), [0, -.035, .05]), [.078, .052, .105]), C.felt, 'foot' + L, .03);
      add(S.cap([s * .13, 1.12, .1], [s * .06, .86, .245], .017), C.strap, 'chest', .01); }
    // the thick grey braid over her left shoulder, down to the waist
    add(S.chain([[.06, 1.22, -.08], [.15, 1.13, .05], [.2, .99, .17], [.205, .82, .235], [.19, .66, .24]], [.036, .035, .031, .027, .021], .03), C.dunHair, 'chest', .02);
    add(S.sph([.19, .645, .24], .024), C.hoop, 'chest', .01);
    return out;
  }
  // the head (head space; tags 1 skin, 2 hair): skull, round jowls, ears, a round nose, chin, neck
  function dunHeadParts() {
    const C = PAL, H = [], add = (f, col, tag, k = .03) => H.push({ f, col, tag, k });
    add(S.sph([0, .012, -.005], .112), C.dunSkin, 1);
    add(S.ell([0, -.03, .025], [.098, .088, .088]), C.dunSkin, 1, .05);
    for (const s of [1, -1]) { add(S.ell([s * .056, -.048, .056], [.05, .044, .046]), C.dunSkin, 1, .04); add(S.ell([s * .108, -.005, -.002], [.017, .027, .021]), C.dunSkin, 1, .015); }
    add(S.ell([0, -.026, .108], [.02, .022, .02]), C.dunSkin, 1, .02);       // a round nose
    add(S.ell([0, -.092, .045], [.05, .03, .04]), C.dunSkin, 1, .05);
    add(S.cap([0, -.07, -.02], [0, -.16, -.02], .055), C.dunSkin, 1, .04);
    const hair = S.inter(S.sph([0, .02, -.012], .121), (x, y, z) => Math.min(z + .004, .064 - y + .02 * x * x * 40)); hair.b = [0, .02, -.012, .122];
    add(hair, C.dunHair, 2, .008);                                              // grey hair, parted, pulled back
    add(S.sph([0, .075, -.105], .05), C.dunHair, 2, .025);                      // a bun
    return H;
  }
  // Dun's face, drawn like Pell's (head-space metres, strokes laid with inkp). uDunA = [eyes open, smile, mouth open, brow down].
  const DUN_FACE = /* glsl */`
  { float skinM = 1.0 - smoothstep(0.3, 0.7, abs(vId - 1.0)); float front = smoothstep(0.02, 0.06, vOP.z) * skinM; vec2 q = vOP.xy; vec3 f = base;
    float eyePx = 0.036 / max(length(fwidth(q)), 1e-7), detail = smoothstep(5.0, 10.0, eyePx);
    // cheeks
    for (int i = 0; i < 2; i++) { float s = i == 0 ? 1.0 : -1.0; float r = length((q - vec2(s * 0.058, -0.045)) / vec2(0.026, 0.016)); inkp(f, ${G('#E89A88')}, (1.0 - smoothstep(0.2, 1.0, r)) * 0.38); }
    for (int i = 0; i < 2; i++) { float s = i == 0 ? 1.0 : -1.0; vec2 e = (q - vec2(s * 0.043, -0.004)) / vec2(0.019, 0.012); e.x *= s;
      // narrow smiling eyes: an arch of ink (open a crack when uDunA.x > 0)
      float yA = 0.42 * (1.0 - e.x * e.x) - 0.25 + 0.15 * e.x;
      float d = max(abs(e.y - yA) - mix(0.16, 0.22, uDunA.x), abs(e.x) - 1.05);
      inkp(f, ${G('#3B2630')}, cov(d) * detail);
      float lens = max(max(abs(e.x) - 0.75, yA - 0.1 - e.y), e.y - yA + 0.02);
      inkp(f, ${G('#2A1A22')}, cov(lens + 0.32 - 0.32 * uDunA.x) * detail);
      // crow's feet, a line under the eye, a heavy grey brow
      float cf = min(min(sdSegT(e, vec2(1.25, 0.05), vec2(1.7, 0.25), 0.05, 0.02), sdSegT(e, vec2(1.25, -0.12), vec2(1.75, -0.18), 0.05, 0.02)), sdSegT(e, vec2(1.22, -0.3), vec2(1.62, -0.6), 0.05, 0.02));
      inkp(f, ${G('#A0645A')}, cov(cf) * 0.75 * detail);
      inkp(f, ${G('#B97A6C')}, cov(sdSegT(e, vec2(-0.5, -0.85), vec2(0.6, -0.8), 0.04, 0.03)) * 0.55 * detail);
      float yb = 1.75 + 0.2 * (1.0 - e.x * e.x) - 0.25 * uDunA.w * (1.0 - e.x) * 0.5;
      inkp(f, ${G('#8C8682')}, cov(max(abs(e.y - yb) - mix(0.3, 0.16, (e.x + 1.0) * 0.5), abs(e.x) - 1.1)) * detail);
      // smile folds from the nose to the mouth corners
      vec2 b = vec2(q.x * s, q.y); inkp(f, ${G('#B5786A')}, cov(sdSegT(b, vec2(0.024, -0.05), vec2(0.034, -0.078), 0.0012, 0.0006)) * 0.7 * detail); }
    // forehead lines (two wavy strokes)
    for (int i = 0; i < 2; i++) { float y0 = 0.033 + float(i) * 0.009; inkp(f, ${G('#BE8472')}, cov(abs(q.y - y0 - 0.004 * cos(q.x * 40.0)) - 0.0007) * step(abs(q.x), 0.04) * 0.6 * detail); }
    // mouth: a smiling line, or pursed for the hush, or a little open laugh
    float x = q.x / 0.017, my = -0.083 + uDunA.y * 0.006 * x * x;
    inkp(f, ${G('#7A3440')}, cov(max(abs(q.y - my) - 0.0013, abs(q.x) - 0.017)) * (1.0 - step(0.05, uDunA.z)) * detail);
    float mo = length((q - vec2(0.0, -0.083)) / vec2(0.007 + 0.006 * uDunA.y, 0.005 + 0.009 * uDunA.z)) - 1.0;
    inkp(f, ${G('#5E2232')}, cov(mo) * step(0.05, uDunA.z) * detail);
    // far away: two short dashes for the eyes
    float dotE = min(length((q - vec2(0.043, 0.0)) / vec2(0.012, 0.004)), length((q - vec2(-0.043, 0.0)) / vec2(0.012, 0.004))) - 1.0;
    inkp(f, ${G('#3B2630')}, cov(dotE) * (1.0 - detail));
    base = mix(base, f, front); }`;
  const DUN_HAIR = /* glsl */`
  // combed strands in the grey hair, and a darker centre parting
  { float hairM = 1.0 - smoothstep(0.3, 0.7, abs(vId - 2.0)); float a = atan(vOP.x, vOP.z + 0.03);
    float str = abs(fract(a * 9.0 + vOP.y * 4.0) - 0.5); base = mix(base, base * mix(0.62, 0.92, smoothstep(0.0, 0.3, str)), hairM);
    base = mix(base, base * 0.6, hairM * cov(abs(vOP.x) - 0.0016) * step(0.0, vOP.z) * step(0.06, vOP.y)); }`;
  const dun = {};
  function buildDun(scene) {
    const R = new THREE.Group(); R.name = 'dun'; const Q = new THREE.Group(); R.add(Q); scene.add(R);
    const rig = makeRig(DDEF); Object.assign(dun, { root: R, squash: Q, rig });
    // the body: soft vertical folds in the lower robe and a lighter panel down its front
    const bodyMat = cel({ vcol: true, shadeRGB: [1.04, .88, 1.06], rim: .26, paintK: .13, paintS: 7,
      fpre: /* glsl */`{ float robe = step(vId, 2.5); float a = atan(vOP.x, vOP.z);
        base *= 1.0 - robe * 0.16 * smoothstep(0.55, 1.0, sin(a * 7.0 + vOP.y * 2.0)) * smoothstep(0.62, 0.3, vOP.y);
        base = mix(base, base * 1.18, robe * step(abs(a), 0.42) * step(vOP.y, 0.78) * step(0.15, vOP.y)); }` });
    const geo = S.mesh(dunBodyParts(rig.index), [-.37, -.01, -.3], [.37, 1.27, .3], .0155, { bones: rig.list.length, skinBlend: .028, blend: .012 });
    const body = prepMesh(new THREE.SkinnedMesh(geo, bodyMat)); Q.add(body); body.add(rig.list[0]); R.updateMatrixWorld(true); body.bind(new THREE.Skeleton(rig.list));
    ink(body, PAL.dunInk, 1.9, .014); dun.body = body;
    // the head: scaled 1.1 on her neck; the shadow map touches it only lightly (shadowK .3); the hair's angel ring is silver
    dun.faceU = { uDunA: { value: new THREE.Vector4(0, 1, 0, 0) } };
    const head = prepMesh(new THREE.Mesh(S.mesh(dunHeadParts(), [-.14, -.2, -.17], [.14, .15, .14], .0062, { blend: .006 }),
      cel({ vcol: true, shadeRGB: [1.18, .78, .85], shadowK: .3, rim: .2, paintK: .06, uniforms: dun.faceU, mid: .5,
        vnormal: /* glsl */`{ float sk = 1.0 - step(0.5, abs(aId - 1.0)); objectNormal = normalize(mix(objectNormal, normalize((P0 - vec3(0.0, -0.01, -0.04)) * vec3(1.0, 0.9, 1.25)), 0.6 * sk)); }`,
        fpars: 'uniform vec4 uDunA;', fpre: DUN_FACE + DUN_HAIR, fpost: HAIR_POST.replace(G('#8E5A4A'), G('#E8E4DE')) })));
    head.position.set(0, .18, .02); head.scale.setScalar(1.1); rig.bones.neck.add(head); ink(head, PAL.dunInk, 1.8, .012); dun.head = head;
    // the patched ochre shawl (it goes round Pell at 82.5)
    // a poncho over the shoulders: an ellipsoid shell, hem cut in a gentle wave, a hole for the neck (seat = shoulder level)
    const shawlGeo = sheetGeo(56, 10, (a, v) => { const r = lerp(.125, .335, Math.sin(v * Math.PI / 2) ** .8), y = lerp(.12, -.17 + .03 * Math.cos(a * 2), v) + .03 * Math.sin(v * Math.PI);
        return [Math.sin(a) * r, y, Math.cos(a) * r * .9]; }, v => .016, () => [PAL.shawl, 1]);
    dun.shawlU = { uShawlS: { value: 1 } };
    dun.shawl = prepMesh(new THREE.Mesh(shawlGeo, cel({ vcol: true, shadeRGB: [1.08, .82, .95], paintK: .14, paintS: 9, side: THREE.DoubleSide,
      fpre: /* glsl */`
      // indigo patches in about a third of the cells (a hash per cell), cream running stitches down their sides, an oxblood hem
      { float a = atan(vOP.x, vOP.z) * 3.0, y = vOP.y * 12.0; vec2 cell = floor(vec2(a, y)); float h = h12(cell);
        vec2 fc = fract(vec2(a, y)); float pt = step(0.62, h) * step(0.12, fc.x) * step(fc.x, 0.88) * step(0.15, fc.y) * step(fc.y, 0.85);
        base = mix(base, ${G('#2F3E7A')}, pt);
        float st = (cov(abs(fc.x - 0.12) - 0.012) + cov(abs(fc.x - 0.88) - 0.012)) * step(0.62, h) * step(0.5, fract(y * 6.0));
        base = mix(base, ${G('#E8D3A0')}, st * 0.8);
        base = mix(base, ${G('#8A3B2A')}, smoothstep(-0.13, -0.15, vOP.y - 0.03 * cos(atan(vOP.x, vOP.z) * 2.0)) * 0.8); }` })));
    dun.shawlSeat = new THREE.Object3D(); dun.shawlSeat.position.set(0, .17, .0); rig.bones.chest.add(dun.shawlSeat); dun.shawlSeat.add(dun.shawl); ink(dun.shawl, PAL.dunInk, 1.8, .012);
    // the drum: hide faces, oxblood hoops, a wooden shell laced with cord; carried on her back. 0.9 m across, 0.3 m deep, its
    // axis along z. After the strike at 27.0 the hides ring (vdeform): a ripple 14 mm high running out from the centre at
    // 1.5 m/s and dying away as e^(-4 tau). The fragment mottles the hide, paints a ring on it and zigzags the lacing.
    const shell = new THREE.CylinderGeometry(.45, .45, .3, 48, 1, true); shell.rotateX(Math.PI / 2);
    const faceA = new THREE.CircleGeometry(.44, 48); faceA.translate(0, 0, .152); const faceB = new THREE.CircleGeometry(.44, 48); faceB.rotateY(Math.PI); faceB.translate(0, 0, -.152);
    const hoopA = new THREE.TorusGeometry(.452, .022, 8, 48); hoopA.translate(0, 0, .15); const hoopB = new THREE.TorusGeometry(.452, .022, 8, 48); hoopB.translate(0, 0, -.15);
    dun.drumU = { uRipple: { value: -1 } };
    dun.drum = prepMesh(new THREE.Mesh(merge([{ g: shell, col: PAL.drumWood, id: 1 }, { g: faceA, col: PAL.hide, id: 2 }, { g: faceB, col: PAL.hide, id: 2 }, { g: hoopA, col: PAL.hoop, id: 3 }, { g: hoopB, col: PAL.hoop, id: 3 }]),
      cel({ vcol: true, shadeRGB: [1.08, .84, .95], paintK: .1, paintS: 4, side: THREE.DoubleSide, uniforms: dun.drumU, vpars: 'uniform float uRipple;',
        vdeform: /* glsl */`if (uRipple >= 0.0 && aId > 1.5 && aId < 2.5) { float r = length(P0.xy); transformed.z += sign(P0.z) * 0.014 * exp(-uRipple * 4.0) * sin(r * 40.0 - uRipple * 60.0) * (1.0 - r / 0.44); }`,
        fpre: /* glsl */`
        { float id = vId; float r = length(vOP.xy), a = atan(vOP.y, vOP.x);
          if (id > 1.5 && id < 2.5) { base *= 0.92 + 0.12 * nz(vOP.xy * 3.0); base = mix(base, base * 0.82, smoothstep(0.36, 0.44, r));
            base = mix(base, ${G('#8A3B2A')}, cov(abs(r - 0.2) - 0.004) * 0.35); }
          if (id > 0.5 && id < 1.5) { float zz = abs(fract(a * 24.0 / 6.2832) - 0.5) * 2.0; float lace = cov(abs(vOP.z - (zz - 0.5) * 0.26) - 0.006);
            base = mix(base, ${G('#E8D8B0')}, lace); } }` })));
    ink(dun.drum, PAL.dunInk, 1.8, .014); Q.add(dun.drum);
    // the felt mallet: a 36 cm stick with a felt knob, in her right hand
    const stick = new THREE.CylinderGeometry(.011, .013, .36, 8); stick.translate(0, -.12, 0); const knob = new THREE.SphereGeometry(.052, 14, 10); knob.scale(1, .85, 1); knob.translate(0, -.32, 0);
    dun.mallet = prepMesh(new THREE.Mesh(merge([{ g: stick, col: PAL.staff, id: 1 }, { g: knob, col: PAL.felt, id: 2 }]), cel({ vcol: true, shadeRGB: [1.06, .88, .98], paintK: .14, paintS: 20 })));
    ink(dun.mallet, PAL.dunInk, 1.6, .01); rig.bones.handR.add(dun.mallet); dun.mallet.position.set(0, -.05, .01);
    dun.handL = rig.bones.handL; dun.handR = rig.bones.handR;
  }
  // Dun's poses: slow and weighty, with small wind-ups ('antic' ease) before her gestures. The pose has the same fields as
  // Pell's (character space) plus drum ('back' | 'front') and face (uDunA). States come from FILM.path.dun: strap, hush,
  // drum, look, walk, wrap. opts: state, face, look, arms, onOnes. Returns the pose; dun.last keeps it.
  function dunPose(t, o = {}) {
    if (!dun.root) return null;
    const th = o.onOnes ? t : A.held(t), p = P.dun(th), rig = dun.rig, B = rig.bones, RS = rig.rest, R = dun.root, Q = dun.squash;
    const z = { pos: p.pos.slice(), yaw: p.yaw, state: o.state || p.state, hip: [0, 0, 0], hipR: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0],
      handL: [.27, .62, .06], handR: [-.27, .62, .06], poleL: [.5, -.2, -1], poleR: [-.5, -.2, -1], footL: [.1, .09, 0], footR: [-.1, .09, 0],
      drum: 'back', face: [0, 1, 0, 0], lookW: null, shawl: 1 };
    const pellNow = pell.last;
    const br = Math.sin(TAU * th / 3.2) * .012;   // slow breathing
    z.chest[0] += br; z.hip[1] += br * .3;
    // strap (before 22): tugging the drum straps tight at her chest, hands alternating
    if (z.state === 'strap') { const w = Math.floor(th * 6) % 2; z.handL = [.13, 1.08 - .03 * w, .17]; z.handR = [-.12, 1.05 + .03 * w, .18]; z.head[0] += .2; z.face = [0, .6, 0, 0]; }
    // hush (22-24): looking at Pell, a finger to her lips at 22.4 (lips pursed), then an open palm, 'wait', at 22.92
    if (z.state === 'hush') { z.lookW = P.pellHead(th);
      const sh = ramp(th, 22.4, 22.58, 'antic'), palm = ramp(th, 22.92, 23.1, 'antic');
      z.handR = mix3(z.handR, [-.02, 1.33, .17], sh * (1 - palm)); z.poleR = [-1, -.3, -.2];
      if (palm > 0) { z.handR = mix3([-.02, 1.33, .17], [-.2, 1.25, .46], palm); }
      z.face = [0, .4, sh * (1 - palm) * .6, .3]; }
    // the drum hangs in front; a big wind-up (26.2-26.75), held at the top until the D2 strike at 27.0, then the follow-through.
    // (The 1.05 overshoot for 26.92-27.0 only shows on ones: on twos the held times jump from 26.917 to 27.0.)
    if (z.state === 'drum') {
      z.drum = 'front'; z.lookW = add3(P.fieldC(th), [-20, -20, 0]);
      const up = ramp(th, 26.2, 26.75, 'io'), hit = th >= 27.0 ? 1 - ramp(th, 27.0, 27.6, 'out') : 0;
      const raised = th < 26.92 ? up : th < 27.0 ? 1.05 : 0;
      z.handR = th < 27.0 ? mix3([-.3, .9, .3], [-.32, 1.48, -.05], raised) : mix3([-.12, .96, .42], [-.3, .9, .3], 1 - hit);
      z.poleR = [-1, .2, -.4]; z.handL = [.24, 1.0, .36]; z.chest[0] += th >= 27 ? .12 * hit : -.08 * raised; z.chest[1] += .2 * raised - .1 * hit; z.head[0] -= .1;
      z.face = [th > 26.7 && th < 27.4 ? .6 : 0, th < 26.5 ? .7 : .2, 0, raised]; }
    // look (36-81): she watches the field, then from 39 the Spillway mast, her gaze climbing 10 -> 40 m above it as Pell
    // goes up the drops (46-54); brows lowered with worry 39-69, eyes open 69-75, and from 72 a smile and both hands up
    if (z.state === 'look') { z.lookW = th < 39 ? add3(P.fieldC(th), [0, -15, 0]) : add3(V.places.spillway.mast, [0, 10 + 30 * sm(46, 54, th), 0]);
      z.drum = th < 36.6 ? 'front' : 'back'; z.face = [th > 69 && th < 75 ? .5 : 0, th > 72 ? 1 : .5, 0, th > 39 && th < 69 ? .6 : 0];
      if (th > 72) { z.handL = [.36, .95, .12]; z.handR = [-.36, .95, .12]; } }
    // walking to Pell, then the wrap (82.5) and the forehead tap (83.25)
    if (z.state === 'walk' || z.state === 'wrap') {
      // she comes to Pell's side, .6 m north of her, so the S16 camera sees them both, the drum edge-on. FILM.path.dun now
      // ends at the same spot, so this blend only eases her arrival and turns her to face Pell once she is past halfway.
      // A stride every .9 s while she walks; the blend lets go over 86.8-87, when Pell leaves for the bench.
      const pp = P.pell(Math.min(th, 86.9)), side = add3(pp.pos, [0, 0, -.6]), k = sm(81, 82.45, th) * (1 - sm(86.8, 87.0, th));
      z.pos = mix3(p.pos, side, k); z.pos[1] = V.ground(z.pos[0], z.pos[2]); z.yaw = k > .5 ? P.yawTo(z.pos, pp.pos) : p.yaw;
      if (th < 82.45) { const ph = th / .9, q = TAU * ph; z.footL = [.1, .09 + .05 * Math.max(0, -Math.sin(q)), .12 * Math.cos(q)]; z.footR = [-.1, .09 + .05 * Math.max(0, Math.sin(q)), -.12 * Math.cos(q)]; z.hip[1] -= .02 * Math.abs(Math.sin(q)); z.hipR[2] = .04 * Math.cos(q); }
      z.face = [0, 1, 0, 0]; z.lookW = add3(P.pellHead(th), [0, 0, 0]);
      // the wrap: both arms forward round Pell's shoulders, then the right hand's forehead tap, and a laugh from 84
      if (th >= 82.45) { const wrap = ramp(th, 82.45, 82.95), tap = sm(83.12, 83.25, th) * (1 - sm(83.5, 83.75, th));
        z.handL = mix3([.27, .62, .06], [.17, 1.0, .5], wrap); z.handR = mix3([-.27, .62, .06], [-.17, 1.0, .5], wrap); z.chest[0] += .18 * wrap; z.head[0] += .1;
        if (th > 83.05) { z.handL = [.2, .98, .4]; z.handR = mix3([-.18, .98, .42], [-.03, 1.06, .55], tap); }
        z.face = [0, 1, th > 84 && th < 85.6 ? .5 : 0, 0]; if (th > 84) z.chest[0] -= .08 * Math.sin((th - 84) * 9) * Math.exp(-(th - 84)); } }
    if (o.face) z.face = o.face; if (o.look) z.lookW = o.look; if (o.arms) { if (o.arms.L) z.handL = o.arms.L; if (o.arms.R) z.handR = o.arms.R; }
    // apply, as applyPell does but simpler: no squash, no eye gaze (the neck takes 70% of the look), knees forward, feet flat
    R.position.set(...z.pos); R.rotation.set(0, z.yaw, 0);
    B.hips.position.set(RS.hips[0] + z.hip[0], RS.hips[1] + z.hip[1], RS.hips[2] + z.hip[2]); setE(B.hips, z.hipR); setE(B.chest, z.chest);
    for (const n of ['armL', 'foreL', 'handL', 'armR', 'foreR', 'handR', 'legL', 'shinL', 'footL', 'legR', 'shinR', 'footR', 'neck']) B[n].quaternion.identity();
    R.updateMatrixWorld(true);
    let hd = z.head.slice();
    if (z.lookW) { const np = B.neck.getWorldPosition(v3()).add(v3(0, .17, 0)), d = v3(...z.lookW).sub(np); B.chest.getWorldQuaternion(_qa); d.applyQuaternion(_qa.invert());
      hd[1] += clamp(Math.atan2(d.x, d.z), -1, 1) * .7; hd[0] += clamp(-Math.atan2(d.y, Math.hypot(d.x, d.z)), -.6, .5) * .7; }
    setE(B.neck, hd); B.neck.updateMatrixWorld(true);
    const rq = R.getWorldQuaternion(_qb);
    for (const s of ['L', 'R']) { ik(B['leg' + s], B['shin' + s], B['foot' + s], toW(R, z['foot' + s]), dirW(R, [s === 'L' ? .1 : -.1, 0, 1])); setWorldQ(B['foot' + s], rq.clone());
      ik(B['arm' + s], B['fore' + s], B['hand' + s], toW(R, z['hand' + s]), dirW(R, z['pole' + s])); }
    // drum on the back or hung in front, its hide ringing after 27.0
    const D0 = dun.drum; if (z.drum === 'back') { D0.position.set(0, .9, -.43); D0.rotation.set(.08, 0, 0); } else { D0.position.set(.02, .84, .52); D0.rotation.set(-.5, 0, 0); }
    dun.drumU.uRipple.value = t >= 27.0 && t < 30 ? t - 27.0 : -1;
    dun.mallet.rotation.set(-.9, 0, 0); dun.mallet.visible = z.state === 'drum' || (z.state === 'look' && th < 36.6);   // she takes the mallet up only to drum
    dun.faceU.uDunA.value.set(...z.face);
    // the shawl: hers until 82.5, then it travels round Pell's shoulders. Pell's pose decides (pell.last.shawl 0..1): at 0 it
    // rides Dun's seat; in between it flies in world space from seat to seat, rising 12 cm mid-way, turning and shrinking to
    // 72%; at 1 it rides Pell's chest.
    const SW = dun.shawl, sk = pellNow ? (pellNow.shawl ?? 0) : 0;
    if (sk <= 0) { if (SW.parent !== dun.shawlSeat) dun.shawlSeat.add(SW); SW.position.set(0, 0, 0); SW.rotation.set(0, 0, 0); SW.scale.setScalar(1); }
    else if (sk >= 1) { if (SW.parent !== pell.shawlSeat) pell.shawlSeat.add(SW); SW.position.set(0, .005, 0); SW.rotation.set(0, 0, 0); SW.scale.set(.72, .72, .74); }
    else { const scn = F.three.scene; if (SW.parent !== scn) scn.add(SW); const a = dun.shawlSeat.getWorldPosition(v3()), b = pell.shawlSeat.getWorldPosition(v3());
      SW.position.copy(a.lerp(b, A.ease.io(sk))).add(v3(0, .12 * Math.sin(sk * Math.PI), 0)); const qa = dun.shawlSeat.getWorldQuaternion(new THREE.Quaternion()), qb = pell.shawlSeat.getWorldQuaternion(new THREE.Quaternion());
      SW.quaternion.copy(qa.slerp(qb, sk)); SW.scale.setScalar(lerp(1, .72, sk)); }
    R.updateMatrixWorld(true);
    dun.last = z; return z;
  }

  // ================================================================== module
  F.cast = {
    PAL, EXPR, MOUTH, pell, tock, dun, bootMs: {},
    // the build, in two steps that main.js runs behind the loader (the labels are shown on the loading screen)
    steps(scene) { return [
      ['펠을 빚는 중', () => buildPell(scene)],
      ['톡과 던을 빚는 중', () => { buildTock(scene); buildDun(scene); }],
    ]; },
    // every frame, before the shot: Pell first, because Tock perches on her anchors and Dun's shawl follows her pose
    update(t) { if (!pell.root) return; pellPose(t); tockPose(t); dunPose(t); },
    pellPose, tockPose, dunPose,
    // dev: how long each sculpted mesh takes to build (best of n), for the boot budget
    bench(n = 2) { const jobs = { pellBody: () => S.mesh(pellBodyParts(pell.rig.index), [-.22, -.01, -.13], [.22, 1.02, .17], .0104, { bones: 15, skinBlend: .016, blend: .005 }),
        pellHead: () => S.mesh(pellHeadParts(), [-.13, -.18, -.15], [.13, .145, .135], .0054, { blend: .006 }), tock: () => S.mesh(tockParts(), [-.07, -.008, -.085], [.07, .125, .09], .0029, { blend: .004 }), dunBody: () => S.mesh(dunBodyParts(dun.rig.index), [-.37, -.01, -.3], [.37, 1.27, .3], .0155, { bones: 15, skinBlend: .028, blend: .012 }),
        dunHead: () => S.mesh(dunHeadParts(), [-.14, -.2, -.17], [.14, .15, .14], .0062, { blend: .006 }) };
      const out = {}; for (const k in jobs) { let b = 1e9; for (let i = 0; i < n; i++) { const t0 = performance.now(); jobs[k](); b = Math.min(b, performance.now() - t0); } out[k] = Math.round(b); } return out; },
  };

  // ================================================================== test views (tools/shot.mjs --test pell|face|tock|dun --k ...)
  //   pell  k 0-5: 18.5 on the roof, 26.1 running, 42.6 sprint, 55.55 ringing, 67.2 singing, 84.25 laughing;
  //         k 6-9: a turnaround at rest (front, 3/4, side, back)
  //   face  k 0-5: neutral, eager, sad, determined, singing, joyful, from 0.74 m (even k from the front, odd k at 3/4)
  //   tock  k 0-2: 30.2 on the crook, 57.4 puffed after the crack, 69.2 flying and trilling
  //   dun   k 0-2: 22.65 hush, 26.85 the drum raised, 83.3 the shawl and the forehead tap
  // For pell (k < 6), tock and dun any other k shows the --at time. Only the cast and the shared time uniforms are set to
  // these times; the other modules stay where the --at time put them.
  const at = tk => { F.U.uTime.value = tk; F.U.uHeld.value = A.held(tk); pellPose(tk); dunPose(tk); tockPose(tk); };
  F.test = F.test || {};
  const sunYaw = () => { const d = F.U.uSunDir.value; return Math.atan2(d.x, d.z); };
  F.test.pell = (k, s) => { const C = F.cam;
    if (k >= 6) { const tk = 30.4, pp = P.pell(tk); F.U.uTime.value = tk; pellPose(tk, { state: 'idle', yaw: sunYaw() + .45, pos: pp.pos, expr: 'neutral' }); tockPose(tk); dunPose(tk);
      const z = pell.last, c = add3(z.pos, [0, .68, 0]); E.shadowFit(v3(...z.pos), 3);
      return { cam: { pos: C.orbit(c, 2.6, z.yaw + [0, .8, 1.6, 3.14][k - 6], .05), look: c, fov: 34 }, look: { focus: 2.6, ap: 0, edge: .5 } }; }
    const tk = [18.5, 26.1, 42.6, 55.55, 67.2, 84.25][k] ?? s.t; at(tk); const z = pell.last;
    const c = add3(z.pos, [0, .7, 0]); E.shadowFit(v3(...z.pos), 3.5);
    return { cam: { pos: C.orbit(c, 3.3, z.yaw + (k === 5 ? -.9 : .6), .06), look: c, fov: 34 }, look: { focus: 3.3, ap: 0, edge: .5 } }; };
  F.test.face = (k, s) => { const ex = ['neutral', 'eager', 'sad', 'determined', 'singing', 'joyful'][k] || 'neutral', tk = 30.4, C = F.cam;
    F.U.uTime.value = tk; const pp = P.pell(tk);
    pellPose(tk, { state: 'idle', yaw: sunYaw() + .45, expr: ex, blink: 0, pos: pp.pos }); tockPose(tk); dunPose(tk);
    const h = pell.head.getWorldPosition(v3()).toArray(), y = pell.last.yaw + (k % 2 ? .62 : .08);
    E.shadowFit(v3(...h), 1.5);
    return { cam: { pos: C.orbit(add3(h, [0, -.02, 0]), .74, y, -.03), look: add3(h, [0, -.018, 0]), fov: 30, near: .02 }, look: { focus: .74, ap: 0, edge: .3 } }; };
  F.test.tock = (k, s) => { const tk = [30.2, 57.4, 69.2][k] ?? s.t; at(tk); const C = F.cam;
    const w = tock.root.getWorldPosition(v3()).toArray(), c = add3(w, [0, .06, 0]); E.shadowFit(v3(...c), 1.5);
    return { cam: { pos: C.orbit(c, .55, pell.last.yaw + (k === 1 ? -1.5 : .9), .1), look: c, fov: 30, near: .02 }, look: { focus: .55, ap: 0, edge: .3 } }; };
  F.test.dun = (k, s) => { const tk = [22.65, 26.85, 83.3][k] ?? s.t; at(tk); const z = dun.last, C = F.cam;
    const c = add3(z.pos, [0, .95, 0]); E.shadowFit(v3(...c), 4);
    return { cam: { pos: C.orbit(c, k === 2 ? 3.6 : 3.2, z.yaw + (k === 2 ? 1.3 : .5), .05), look: c, fov: 34 }, look: { focus: 3.3, ap: 0, edge: .5 } }; };
})();
