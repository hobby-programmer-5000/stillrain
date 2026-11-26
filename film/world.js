// world.js - the valley of Hollowmere and its sky (FILM.world). Everything that does not walk, sing or fall:
//
//   terrain   one polar mesh of FILM.valley.ground (exact inside the bowl and 40 m past the rim), drawn like a painted
//             background: straw-gold terrace fields with straw strokes and patchwork plots, dry-stone walls with their
//             courses and dark joints drawn in the shader, hush-moss on every wall top, a grassy rim; beyond it three
//             painted ranges (forested near peaks, a blue middle range, far snow peaks) that turn bluer and lighter with
//             distance, the Spillway notch and its cliff down to the ochre-hazed Hushlands and their far mesas.
//   water     the pond (y = 0), wetness and the green flood (M12, the same rule as FILM.events.wetAt), dusk mirror terraces.
//   light     sun, sky, fog, bounce and rim by film time (noon, gust, run, ma, climax, curtain, after rain, dusk).
//   sky       painted dome with brushed bands and cirrus; anime cumulus built from lobes (three tones, flat bases, sun rim);
//             analytic moving cloud shadows with a 45 degree halftone screen inside them (JS and GLSL agree).
//   village   stilt houses with moss/felt hush-roofs (exactly FILM.valley.HOUSE), toll-cupolas with quilted sleeves, felt
//             door curtains, toll-masts with tuned bronze bars and streamers, the 12 m Spillway mast, clay cisterns,
//             stone spill-channels, the Listeners' bench. Curtains and sleeves snap in a chain at the gust (M16).
//   (M12, M16: the signature motions in film/BIBLE.md section 5.)
//
// How it works. Everything is a pure function of film time t: update(t) only writes uniforms (and redraws the world map
// below), and all motion (drifting clouds, cloth, bells, water, the flood) is worked out in the shaders from uTime.
// Units are metres, seconds and radians; x is east, z is south, y is up.
//   - Lighting is a list of full "keys" (sun, sky, fog, cloud tones ...) blended by film time with FILM.anim.keys().
//   - Cloud shadows and the wetness left by the tolls are loops over lists. Once a frame they are drawn into one small
//     texture over the valley (the world map: R = cloud shadow, G = wetness), so every material pays one texture lookup.
//   - The terrain is one polar mesh: 640 columns, and every column has the same list of samples (pond, then each wall and
//     terrace top, then the rim and the ranges), so the 3.2 m wall steps line up from column to column. Two painter
//     shaders colour it: the bowl, and the land past the rim (one shader with both compiles much slower).
//   - The village is merged into a few meshes that share one cel shader (E.toon). Every vertex carries a part id (aPart)
//     and a free vec4 (aX) with the pivot and the time of whatever moves, so curtains, bells and bars move in the shader.
//
// Public API at a glance (the full table is in film/WORLD.md): light(t), groundAt(x, z), cloudShadow(x, z, t), wetAt(x, z, t),
//   gustDelay(x), snap(x, t), blow(x, t), the GLSL chunks CLOUD_GLSL and MAP_GLSL, clouds, meshes, and two overrides a shot
//   may set: sunOverride and fieldShadeK. main.js calls steps(scene) while loading, update(t) every frame, and afterCamera(t)
//   once the shot has placed the camera.
// Reads: FILM.valley (ground, ring radii, houses, masts, places), FILM.path (the rain-field centre, the gust envelope, GLSL),
//   FILM.events (the toll table, wetAt), FILM.engine (toon, outline, the COMMON GLSL, the shared uniforms FILM.U),
//   FILM.anim (keys, sm, seeded random streams), FILM.score (shot grades, for the test views only).
// See it (after python tools/build.py):
//   node tools/shot.mjs --test valley --k 0,1,2,3,4,5 --cols 2 --w 800 --at 8 --out build/world-valley.jpg
//   (also --test village --k 0,1,2,3 and --test sky --k 0,1,2; --at picks the film time: 8 noon, 40 gust, 77 flood, 89 dusk)
//
// The pattern of 'one module per world layer, a test view per layer, a .md reference' follows bide's film/world.js
// (ChetasLua/bide, MIT, see vendor/bide-LICENSE).
window.FILM = window.FILM || {};
(function () {
  // short names for the modules this file reads (U = FILM.U, the uniforms every material shares)
  const F = window.FILM, A = F.anim, E = F.engine, V = F.valley, P = F.path, EV = F.events, U = F.U;
  const { clamp, lerp, sm, keys } = A;
  const TAU = Math.PI * 2;
  const lin = c => { const k = new THREE.Color(c); return [k.r, k.g, k.b]; };   // sRGB hex -> linear rgb
  const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const WEST_X = -V.ringR(9, Math.PI);                      // the gust line: the west rim (x = -182 m)
  const gustDelay = x => Math.max(0, (x - WEST_X) / 18);    // M16: the front crosses the valley at 18 m/s from t = 36

  // ==================================================================================================== light by film time
  // Each state is a full lighting key. keys() blends them; cuts switch instantly (a 0.02 s blend).
  // The fields of a key (colours are sRGB hex here, turned into linear rgb arrays by S() so keys() can blend them):
  //   sun          direction toward the sun (x east, y up, z south), normalized in update(); sunK its strength, sunCol its colour
  //   top mid hor low   the sky gradient: zenith, mid sky, horizon, below the horizon
  //   fogCol fogD fogH fogM   fog colour, density per metre, height falloff per metre, maximum amount (FILM.U.uFog)
  //   bounce fill rim   light bounced up from the ground, sky fill in the shade, rim light (read by E.toon)
  //   cLit cMid cCore cGlow   the cumulus tones: sunlit cap, mid, shaded core, the glow round the edges against the sun
  //   haze         aerial perspective colour of far land;  halo   sun halo strength;  cirrus   amount of cirrus wisps
  //   overcast     0..1 greys the sky and the clouds;  mirror   0..1 the dusk mirror (flooded fields reflect the sky)
  //   sunVis       0..1 how much the sun disc, halo and glints show (low under the gust's overcast)
  const S = o => { const s = {}; for (const k in o) s[k] = typeof o[k] === 'string' ? lin(o[k]) : o[k]; return s; };
  const BASE = { sun: [-.36, .78, .52], sunK: 1.0, sunCol: '#FFF4E2', top: '#2F6FD6', mid: '#5DB2F0', hor: '#CFE7F2', low: '#C3DCE6',
    fogCol: '#D2E6F0', fogD: .00042, fogH: .010, fogM: .8, bounce: '#FFD7A6', fill: '#A9D6FF', rim: '#FFE6B0',
    cLit: '#FFF8EC', cMid: '#E6DDF0', cCore: '#9A8FC9', cGlow: '#FFF1C8', haze: '#9DBFE6', halo: .2, cirrus: .5, overcast: 0, mirror: 0, sunVis: 1 };
  const ST = {
    noon: S(BASE),
    gust: S({ ...BASE, sunK: .9, sunCol: '#F2F0E4', top: '#3A5868', mid: '#4C6B7A', hor: '#A9BEC4', low: '#8EA2A8', fogCol: '#A4B8C0', fogD: .0011,
      bounce: '#B9B99C', fill: '#93AEBB', rim: '#E4F0F2', cLit: '#E8EEEE', cMid: '#A9BAC2', cCore: '#5A7280', cGlow: '#EEF4F4', haze: '#98AFBA', halo: .05, cirrus: 0, overcast: .85, sunVis: .35 }),
    run: S({ ...BASE, sun: [-.42, .72, .55], top: '#2C69D3', mid: '#57AEF0', hor: '#C9E6F3', haze: '#AECBEA' }),
    ma: S({ ...BASE, sun: [-.42, .72, .55], sunK: .95, sunCol: '#F6F2EA', top: '#3A72CF', mid: '#6DB4EA', hor: '#D6E8F0', cLit: '#F8F5F1', haze: '#BCD2EA', cirrus: .3 }),
    climax: S({ ...BASE, sun: [-.75, .38, .54], sunK: 1.15, sunCol: '#FFE4BC', top: '#3576D9', mid: '#73BDF2', hor: '#F4EBD6', fogCol: '#EFE4D2', rim: '#FFE2B8',
      cLit: '#FFF4E0', cGlow: '#FFE2B0', haze: '#C9CFE0', halo: .45 }),
    curtain: S({ ...BASE, sun: [-.6, .55, .58], sunK: .8, sunCol: '#E8ECEF', top: '#4A79B8', mid: '#86A9C8', hor: '#D3DEE3', fogCol: '#C8D4DA', fogD: .0014,
      cLit: '#EEF2F4', cMid: '#C5CBD8', cCore: '#8790AE', haze: '#B2C2D2', halo: .1, cirrus: 0, overcast: .5, sunVis: .5 }),
    after0: S({ ...BASE, sun: [-.5, .62, .6], sunK: .9, sunCol: '#FFF6E6', top: '#2563D9', mid: '#4FB0F5', hor: '#D8F1FA', fogD: .0006, fogCol: '#D8EEF6', haze: '#B0D0EE', cirrus: .2 }),
    after: S({ ...BASE, sun: [-.5, .62, .6], sunK: 1.08, sunCol: '#FFF3DC', top: '#2563D9', mid: '#4FB0F5', hor: '#D8F1FA', fogD: .0006, fogCol: '#D8EEF6', haze: '#B0D0EE', halo: .3, cirrus: .35 }),
    dusk: S({ ...BASE, sun: [-.94, .075, .33], sunK: .92, sunCol: '#FFBE98', top: '#5D5FA8', mid: '#B39AD6', hor: '#F2B48A', low: '#C49AA8', fogCol: '#E2B3A0', fogD: .0011,
      bounce: '#F2A98A', fill: '#9C93D6', rim: '#FFC48A', cLit: '#FFD2A8', cMid: '#D6A9C6', cCore: '#7E6FAF', cGlow: '#FFC890', haze: '#B9A3CF', halo: .7, cirrus: .8, mirror: 1 }),
  };
  // the timeline: [film time, key, easing into this key]. Two keys 0.02 s apart make a cut (41.98 gust -> 42.0 run);
  // 'io' blends slowly in and out (36 -> 37.2 noon to gust, 84.6 -> 86 the sun coming back after the rain).
  const TL = [[0, 'noon'], [36.0, 'noon'], [37.2, 'gust', 'io'], [41.98, 'gust'], [42.0, 'run', 'lin'], [59.98, 'run'], [60.0, 'ma', 'lin'], [65.98, 'ma'], [66.0, 'climax', 'lin'],
    [71.98, 'climax'], [72.0, 'curtain', 'lin'], [74.98, 'curtain'], [75.0, 'after0', 'lin'], [84.6, 'after0'], [86.0, 'after', 'io'], [86.98, 'after'], [87.0, 'dusk', 'lin'], [93, 'dusk']]
    .map(([t, s, e]) => [t, ST[s], e]);
  const light = t => keys(t, TL);   // the blended key at film time t (same fields as BASE, colours as linear rgb arrays)

  // ==================================================================================================== clouds (data)
  // Valley clouds drift east on the prevailing wind and cast the analytic shadows. The gust clouds race across at 150 m/s
  // (36-43 s). Horizon towers stand far out over the peaks. The same list drives the 3D lobes and cloudShadow().
  // A cloud: kind ('drift' | 'gust' | 'tower'), x0 z0 (centre at t = 0, m), base (height of its flat base, m), R and rz
  // (radius along x and z, m), H (height, m), vx vz (drift, m/s), seed (shape), k (shadow strength, 0 = casts none).
  // Its centre at film time t is (x0 + vx t, z0 + vz t).
  const CL = []; {
    const r = A.named('world-clouds');
    // composed by where the shadow lands at t = 10 (with the noon sun): [x, z, radius]. Three cross the terraces in the
    // opening shots (over the village, the west fields, the south fields), the rest dapple the ranges.
    // The start position is solved backwards: x0 = (shadow x) - 10 s of drift - the offset of a shadow cast from height hp
    // along the noon sun (ox, oz = how far a shadow moves sideways per metre of height).
    const SH = [[-40, -150, 92], [-185, 55, 104], [45, 170, 84], [175, -40, 70], [-430, -300, 128], [310, -340, 118], [-390, 290, 120], [430, 270, 110],
      [-70, -500, 138], [-660, -30, 136], [150, 540, 126], [660, -560, 140], [-900, 420, 150], [900, 60, 150]];
    const sun0 = new THREE.Vector3(-.36, .78, .52).normalize(), ox = -sun0.x / sun0.y, oz = -sun0.z / sun0.y;
    SH.forEach(([sx, sz, R]) => { const c = { kind: 'drift', base: 300 + r() * 60, R, rz: R * (.72 + .28 * r()), H: R * (1.2 + .8 * r()), vx: 4.3 + r() * 1.1, vz: .5 + r() * .4, seed: r() * TAU, k: .92 };
      const hp = c.base + c.H * .25 - 18; c.x0 = sx - c.vx * 10 - ox * hp; c.z0 = sz - c.vz * 10 - oz * hp; CL.push(c); });
    // the gust: one big racing front and two followers (x = x0 + 150 t, so x(36) = -610)
    CL.push({ kind: 'gust', x0: -6010, z0: -60, base: 230, R: 250, rz: 330, H: 260, vx: 150, vz: 6, seed: 1.3, k: 1 });
    CL.push({ kind: 'gust', x0: -6330, z0: 210, base: 250, R: 160, rz: 190, H: 200, vx: 150, vz: 6, seed: 4.1, k: 1 });
    CL.push({ kind: 'gust', x0: -6260, z0: -330, base: 240, R: 150, rz: 170, H: 190, vx: 150, vz: 6, seed: 2.7, k: 1 });
    // horizon towers (no shadows in the valley): [azimuth (rad), distance from the centre (m), radius, height]
    [[-1.72, 3900, 560, 2100], [-1.18, 4100, 520, 1800], [-.52, 3700, 420, 1500], [.22, 3800, 480, 1650], [1.25, 3900, 560, 1950], [2.2, 3700, 460, 1600], [2.95, 4000, 600, 2200], [-2.45, 4100, 440, 1500]]
      .forEach(([th, d, R, H], i) => CL.push({ kind: 'tower', x0: Math.cos(th) * d, z0: Math.sin(th) * d, base: 380 + r() * 120, R, rz: R * (.8 + .2 * r()), H, vx: 2.5, vz: .3, seed: r() * TAU, k: 0 }));
  }
  const CS = CL.filter(c => c.kind !== 'tower');   // shadow casters
  const csHp = c => c.base + c.H * .25 - 18;          // height the shadow is projected from
  // the shadow list as uniforms (also in FILM.U so any material can include FILM.world.CLOUD_GLSL)
  U.uCSa = { value: CS.map(c => new THREE.Vector4(c.x0, c.z0, c.vx, c.vz)) };
  U.uCSb = { value: CS.map(c => new THREE.Vector4(c.R * .95, c.rz, csHp(c), c.seed)) };
  U.uCSk = { value: CS.map(c => c.k) };
  U.uNCS = { value: CS.length };   // loops run to a uniform count, so the compiler keeps them as loops (fast compile)
  const NCS = CS.length;
  // 0..1 shadow of the drifting clouds on the ground at (x, z), film time t. Uses the current sun direction.
  // Each shadow is an ellipse (R * 0.95 by rz) that moves with its cloud, shifted along the sun as if cast from height
  // csHp (the sun's y is clamped at 0.12 so a low sun cannot throw it to infinity). Its edge is made irregular by 3- and
  // 5-lobed sines round the centre plus a small wobble over the ground, and stays crisp (a 10% smoothstep), like a
  // painted shadow. Overlapping shadows take the max, not the sum.
  function cloudShadow(x, z, t) {
    const s = U.uSunDir.value, sy = Math.max(s.y, .12), ox = -s.x / sy, oz = -s.z / sy;
    const wob = .06 * Math.sin(x * .045 + 1.7 * Math.sin(z * .031)) + .04 * Math.sin(z * .07 + x * .02);
    let m = 0;
    for (const c of CS) { const cx = c.x0 + c.vx * t + ox * csHp(c), cz = c.z0 + c.vz * t + oz * csHp(c);
      const dx = (x - cx) / (c.R * .95), dz = (z - cz) / c.rz; let q = Math.sqrt(dx * dx + dz * dz); if (q > 1.6) continue;
      const an = Math.atan2(dz, dx); q *= 1 - .14 * Math.sin(3 * an + c.seed) - .08 * Math.sin(5 * an + 2 * c.seed);
      m = Math.max(m, c.k * (1 - sm(.9, 1.0, q + wob))); }
    return m;
  }
  const CLOUD_GLSL = /* glsl */`
uniform vec4 uCSa[${NCS}]; uniform vec4 uCSb[${NCS}]; uniform float uCSk[${NCS}]; uniform int uNCS;
// 0..1 shadow of the drifting clouds at ground point p (same as FILM.world.cloudShadow)
float cloudShadow(vec2 p, float t){
  float sy = max(uSunDir.y, 0.12); vec2 so = -uSunDir.xz / sy;
  float wob = 0.06 * sin(p.x * 0.045 + 1.7 * sin(p.y * 0.031)) + 0.04 * sin(p.y * 0.07 + p.x * 0.02);
  float m = 0.0;
  for (int i = 0; i < uNCS; i++) { vec4 a = uCSa[i], b = uCSb[i]; vec2 c = a.xy + a.zw * t + so * b.z;
    vec2 d = (p - c) / b.xy; float q = length(d); if (q > 1.6) continue;
    float an = atan(d.y, d.x); q *= 1.0 - 0.14 * sin(3.0 * an + b.w) - 0.08 * sin(5.0 * an + 2.0 * b.w);
    m = max(m, uCSk[i] * (1.0 - smoothstep(0.9, 1.0, q + wob))); }
  return m; }`;

  // ==================================================================================================== wetness (M12)
  // FILM.events.wetAt, ported: field tolls wet a disc under the part of the field they reached; then the cascade.
  // One entry per field toll (EV.FIELD_EV, the tolls that carry more than 30 m):
  //   a = (source x, source z, horizontal reach, start time)   b = (field centre x, z at the toll, peak wetness, unused)
  // The horizontal reach assumes the drops hang about 20 m above the sound: sqrt(reach^2 - 20^2). The start time adds the
  // hold of a sustained note and the fall time: 2.2 s for heavy drops, +1.2 s for marble, +6 s for mist (which only
  // dampens the ground: 0.45). The GLSL then adds the sound's travel time to a point 18 m up: sqrt(dh^2 + 18^2) / 30 m/s.
  const WE = EV.FIELD_EV.map(e => { const fc = P.fieldC(e.t0); return { a: new THREE.Vector4(e.src[0], e.src[2], Math.sqrt(Math.max(0, e.reach * e.reach - 400)),
    e.t0 + e.hold + 2.2 + (e.band === 2 ? 6 : e.band === 1 ? 1.2 : 0)), b: new THREE.Vector4(fc[0], fc[2], e.band === 2 ? .45 : 1, 0) }; });
  const WET_EV_GLSL = /* glsl */`
uniform vec4 uWEa[${WE.length}]; uniform vec4 uWEb[${WE.length}]; uniform int uNWE;
// wetness from the tolls (the rain of Act 1 and the fall), 0..1. Only points under the field when it rang (an
// ellipse of radii 80 and 55 m round its centre, the field's size in FILM.path.FIELD) and within the sound's reach
// get wet; each point turns wet over 1.2 s once the drops released there have landed.
float wetEvents(vec2 p, float t){ float w = 0.0;
  for (int i = 0; i < uNWE; i++) { vec2 e = (p - uWEb[i].xy) / vec2(80.0, 55.0); if (dot(e, e) > 1.1) continue;
    float dh = distance(p, uWEa[i].xy); if (dh > uWEa[i].z) continue;
    float ta = uWEa[i].w + sqrt(dh * dh + 324.0) / 30.0; w = max(w, smoothstep(ta, ta + 1.2, t) * uWEb[i].z); }
  return w; }`;
  const WET_GLSL = /* glsl */`
// terrace index at p: 0 = pond, 1..9, 10 = past the rim (the GLSL copy of FILM.valley.terraceAt)
float wTerraceAt(vec2 p){ float r = length(p), w = vWob(atan(p.y, p.x)); if (r < 40.0 + w * 0.5) return 0.0; return min(10.0, floor((r - 40.0 - w * 0.5) / 16.5) + 1.0); }
// the green flood running down the terraces: terrace k turns wet at 75.5 + 0.5 (9 - k), the pond at 80
float wetCascade(vec2 p, float t){ float k = wTerraceAt(p);
  if (k >= 1.0 && k <= 9.0) return smoothstep(75.5 + 0.5 * (9.0 - k), 76.2 + 0.5 * (9.0 - k), t);
  if (k < 0.5) return smoothstep(80.0, 81.0, t); return 0.0; }
`;

  // ==================================================================================================== the world map
  // The loops above (cloud shadows, toll wetness) are drawn once a frame into a small texture over the valley
  // (R = cloud shadow, G = toll wetness), so every material pays one lookup and compiles fast.
  // The map covers a 2000 m square centred on the origin at 768 x 768 texels (about 2.6 m a texel); outside it reads 0.
  const MAP_SIZE = 2000, MAP_RES = 768;
  U.tWorldMap = { value: null };
  const MAP_GLSL = /* glsl */`
uniform sampler2D tWorldMap;
vec4 worldMap(vec2 xz){ vec2 uv = xz / ${MAP_SIZE.toFixed(1)} + 0.5; float inside = step(abs(uv.x - 0.5), 0.499) * step(abs(uv.y - 0.5), 0.499);
  return textureLod(tWorldMap, clamp(uv, 0.001, 0.999), 0.0) * inside; }
float cloudShadowAt(vec2 xz){ return worldMap(xz).r; }
// the 45 degree halftone screen used inside shadows: 1 inside a dot. k = shadow amount (dot size), period 5 px at 1080p.
// Works in screen pixels (gl_FragCoord), so the dots stay the same size on screen at any distance. The dot radius grows
// with sqrt(k), so the inked area grows in step with k (up to about half the cell); aa softens the dot edge by about 0.7 px.
float halftone(float k){
  float px = 5.0 * uRes.y / 1080.0; vec2 g = gl_FragCoord.xy / px; g = vec2(g.x + g.y, g.y - g.x) * 0.70710678;
  float d = length(fract(g) - 0.5); float rad = 0.42 * sqrt(clamp(k, 0.0, 1.0)); float aa = 0.7 / px;
  return 1.0 - smoothstep(rad - aa, rad + aa, d); }`;
  let mapRT = null, mapScene = null, mapCam = null;
  // the render target and a one-triangle scene that covers it: each texel works out cloudShadow() and wetEvents() at its
  // own ground point. (WU, the world uniforms, is declared further down; buildMap only runs later, from steps().)
  function buildMap() {
    mapRT = new THREE.WebGLRenderTarget(MAP_RES, MAP_RES, { depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    U.tWorldMap.value = mapRT.texture;
    const tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const q = new THREE.Mesh(tri, new THREE.ShaderMaterial({ uniforms: Object.assign({}, U, WU), depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `${E.COMMON}
${CLOUD_GLSL}
${WET_EV_GLSL}
varying vec2 vUv;
void main(){ vec2 xz = (vUv - 0.5) * ${MAP_SIZE.toFixed(1)}; gl_FragColor = vec4(cloudShadow(xz, uTime), wetEvents(xz, uTime), 0.0, 1.0); }` }));
    q.frustumCulled = false; mapScene = new THREE.Scene(); mapScene.add(q); mapCam = new THREE.Camera();
  }
  // redraw the map for the current uTime and sun (called by update() and afterCamera()); restores the renderer's target
  function drawMap() { const R = F.three && F.three.renderer; if (!mapRT || !R) return; const prev = R.getRenderTarget(); R.setRenderTarget(mapRT); R.render(mapScene, mapCam); R.setRenderTarget(prev); }

  // ==================================================================================================== shared world uniforms
  // The uniforms only the world's own materials read (FILM.U holds the ones every material reads). update() writes them:
  //   uSkyMid uHaze uHalo uCirrus uOvercast uMirror uSunVis   from the lighting key
  //   uGustNow   0..1 while the gust's racing shadow and wind streaks are on (36-42 s)
  //   uRain      0..1 while rain is falling (more ripples on the pond)      uFieldK   strength of the rain-field's dapple
  //   cLit cMid cCore cGlow   the cumulus tones      tSkyline   the skyline texture (reflections of the peaks)
  //   uWEa uWEb uNWE   the toll wetness list (WE above)      uPondN   ripple sources in the pond
  const WU = {
    uSkyMid: { value: new THREE.Color('#5DB2F0') }, uHaze: { value: new THREE.Color('#B4CFEA') }, uHalo: { value: .2 }, uCirrus: { value: .5 }, uOvercast: { value: 0 },
    uMirror: { value: 0 }, uGustNow: { value: 0 }, uRain: { value: 0 }, uFieldK: { value: .3 }, uSunVis: { value: 1 },
    cLit: { value: new THREE.Color() }, cMid: { value: new THREE.Color() }, cCore: { value: new THREE.Color() }, cGlow: { value: new THREE.Color() },
    tSkyline: { value: null },
    uWEa: { value: WE.map(w => w.a) }, uWEb: { value: WE.map(w => w.b) }, uNWE: { value: WE.length }, uPondN: { value: 7 },
  };
  // the painted sky as a function (dome, reflections): zenith / mid / horizon, sun and halo. d must be normalized.
  const SKY_GLSL = /* glsl */`
uniform vec3 uSkyMid, uHaze; uniform float uHalo, uSunVis, uMirror, uCirrus, uOvercast; uniform sampler2D tSkyline;
// the plain gradient (horizon -> mid -> zenith, and below the horizon) with a soft halo round the sun
vec3 wSky(vec3 d){ float y = d.y;
  vec3 c = mix(uSkyHor, uSkyMid, smoothstep(0.0, 0.3, y)); c = mix(c, uSkyTop, smoothstep(0.22, 0.92, y));
  c = mix(c, uSkyLow, smoothstep(0.0, -0.25, y));
  float s = max(dot(d, uSunDir), 0.0); c += uSunCol * uSunVis * (pow(s, 7.0) * uHalo * 0.5 + pow(s, 60.0) * uHalo * 0.6);
  return c; }
// noise with an explicit mip level: lookups inside varying branches need no derivatives, so the shader compiler can keep
// the branches as branches (much faster to compile than flattening them)
float nzL(vec2 p, float l){ return textureLod(tNoise, p, l).r; }
float nzAL(vec2 p, float l){ return textureLod(tNoise, p, l).a; }
// the painted sky: gradient, a pale band on the horizon, brushed bands and cirrus wisps (the dome). a01 is the azimuth
// as 0..1; the cirrus drift slowly with uTime and take the sun's colour at dusk (uMirror); uOvercast greys it all.
vec3 skyPaint(vec3 d){ float y = d.y, a01 = atan(d.z, d.x) / 6.2831853 + 0.5; vec3 c = wSky(d);
  c = mix(c, uSkyHor * 1.04 + vec3(0.02), exp(-max(y, 0.0) * 22.0) * 0.35);
  float b1 = nz(vec2(a01 * 4.0, y * 2.6)) - 0.5, b2 = nzA(vec2(a01 * 12.0 + 0.3, y * 7.5)) - 0.5;
  c *= 1.0 + (b1 * 0.06 + b2 * 0.03) * smoothstep(-0.02, 0.2, y);
  float ci = nz(vec2(a01 * 6.0 + y * 0.6, y * 9.0 + uTime * 0.002)) * nzA(vec2(a01 * 16.0 - y, y * 30.0));
  float wisp = smoothstep(0.34, 0.5, ci) * smoothstep(0.1, 0.28, y) * (1.0 - smoothstep(0.65, 0.9, y));
  float s = max(dot(d, uSunDir), 0.0);
  c = mix(c, mix(uSkyHor, vec3(1.0), 0.6) * mix(vec3(1.0), uSunCol, uMirror * 0.6) + uSunCol * pow(s, 4.0) * 0.4, wisp * uCirrus * 0.32);
  c = mix(c, mix(uSkyHor, uSkyMid, smoothstep(-0.05, 0.6, y)) * (0.92 + 0.12 * b1), uOvercast * 0.55);
  return c; }
// the skyline round the valley (tan of the horizon elevation by azimuth, seen from the bowl) for mirrored mountains.
// skylineTex() stores tan / 0.6 in 8 bits, so * 0.6 decodes it.
float skylineAt(vec3 d){ return textureLod(tSkyline, vec2(atan(d.z, d.x) / 6.2831853 + 0.5, 0.5), 0.0).r * 0.6; }
// skyPaint for reflections: the same picture with explicit-mip noise (it is called inside branches) and one band layer
vec3 skyPaintL(vec3 d){ float y = d.y, a01 = atan(d.z, d.x) / 6.2831853 + 0.5; vec3 c = wSky(d);
  c = mix(c, uSkyHor * 1.04 + vec3(0.02), exp(-max(y, 0.0) * 22.0) * 0.35);
  float b1 = nzL(vec2(a01 * 4.0, y * 2.6), 1.0) - 0.5; c *= 1.0 + b1 * 0.07 * smoothstep(-0.02, 0.2, y);
  float ci = nzL(vec2(a01 * 6.0 + y * 0.6, y * 9.0), 1.0) * nzAL(vec2(a01 * 16.0 - y, y * 30.0), 1.0);
  float wisp = smoothstep(0.34, 0.5, ci) * smoothstep(0.1, 0.28, y) * (1.0 - smoothstep(0.65, 0.9, y));
  float s = max(dot(d, uSunDir), 0.0);
  c = mix(c, mix(uSkyHor, vec3(1.0), 0.6) * mix(vec3(1.0), uSunCol, uMirror * 0.6) + uSunCol * pow(s, 4.0) * 0.4, wisp * uCirrus * 0.32);
  return mix(c, mix(uSkyHor, uSkyMid, smoothstep(-0.05, 0.6, y)) * (0.92 + 0.12 * b1), uOvercast * 0.55); }
// what water reflects along the ray r: the painted sky, and below the skyline (el, the ray's tan of elevation, under e)
// the ring of mountains as a hazy, shaded silhouette
vec3 reflSky(vec3 r){ vec3 c = skyPaintL(vec3(r.x, abs(r.y), r.z)); float e = skylineAt(r); float el = r.y / max(length(r.xz), 1e-3);
  vec3 mtn = mix(uHaze * mix(vec3(0.74, 0.78, 0.9), uShade, 0.5), uHaze, smoothstep(e - 0.1, e, el) * 0.55);
  if (el < e) c = mix(mtn, c, smoothstep(e - 0.004, e, el) * 0.5);
  return c; }`;

  // ==================================================================================================== the land past the rim
  // Exactly FILM.valley.ground inside the bowl and up to 40 m past the rim (the Spillway shoulder, the bench, the Listeners,
  // the notch and its cliff). From 40 m to 90 m it blends into three painted ranges that ring the bowl like the layered
  // mountain flats of an anime background: a near range of 100-140 m peaks, a blue middle range, and far snow peaks.
  // East stays open: through the Spillway notch the ochre Hushlands run to a line of low, hazy mesas.
  // Heights here are absolute (y in metres, the rim crest is at about 36 m); the land takes the highest of the meadow,
  // the ranges and the mesas.
  const wrapA = a => a - TAU * Math.round(a / TAU);   // angle into -PI..PI (cheap: no trig)
  // each range: centre distance past the rim D (+ a slow wobble of amplitude dA), half width W, saddle height sad,
  // jag (height of the jagged sub-peaks), summits pk [azimuth rad, height m, half-width rad]. All in metres.
  // No summit is closer than 0.7 rad to east (azimuth 0): that is the opening onto the Hushlands.
  const RANGES = [
    { D: 235, W: 165, dA: 28, sad: 78, jag: 14, pk: [[-2.98, 126, .42], [-2.5, 104, .36], [-2.0, 138, .44], [-1.52, 110, .34], [-1.1, 132, .38], [-.7, 98, .3],
      [.74, 100, .32], [1.14, 134, .4], [1.62, 116, .36], [2.1, 140, .42], [2.58, 108, .34], [3.06, 122, .38]] },
    { D: 880, W: 380, dA: 90, sad: 160, jag: 26, pk: [[-2.78, 260, .36], [-2.16, 300, .4], [-1.66, 240, .32], [-1.24, 290, .36], [-.8, 235, .3],
      [.88, 250, .32], [1.38, 305, .38], [1.92, 255, .32], [2.42, 295, .36], [2.96, 270, .36]] },
    { D: 2350, W: 760, dA: 160, sad: 400, jag: 70, pk: [[-2.52, 820, .3], [-1.88, 700, .26], [-1.4, 900, .3], [-.94, 660, .24], [1.02, 720, .26],
      [1.56, 920, .3], [2.16, 760, .26], [2.8, 860, .3]] },
  ];
  const rangeD = (R, th) => R.D + R.dA * (.6 * Math.sin(2 * th + R.D * .01) + .4 * Math.sin(5 * th + 1.3));   // its centre line
  // ridged value noise: 1 where the noise crosses 0.5, so its maxima are sharp crests (ridges, buttresses)
  const ridged = (u, v) => { const n = A.vn2(u, v); return 1 - Math.abs(2 * n - 1); };
  // the ridge line along a range: rounded summits over a wavy saddle, broken by jagged sub-peaks. Each summit is a bump
  // (1 - x^2)^1.7, a little lopsided, rising from 0.7 of the saddle to its height; u runs along the ridge in metres / (0.9 W).
  const ridgeH = (R, th, r) => { let h = R.sad * (.82 + .18 * Math.sin(7 * th + R.D));
    for (const [a, H, s] of R.pk) { const x = wrapA(th - a) / s; if (x > -1 && x < 1) { const b = Math.pow(1 - x * x, 1.7) * (1 + .18 * x); h = Math.max(h, lerp(R.sad * .7, H, b)); } }
    const u = th * r / (R.W * .9);
    return h + R.jag * (ridged(u, R.D * .01) * 1.4 + ridged(u * 2.7 + 3.3, 1.7) * .6 - 1.1); };
  // height of one range at (th, d), d = metres past the rim, r = distance from the centre; -1e9 outside the range.
  // x runs -1..1 across the range (0 on its centre line).
  function rangeAt(R, th, d, r) {
    const x = (d - rangeD(R, th)) / R.W; if (x <= -1 || x >= 1) return -1e9;
    const H = ridgeH(R, th, r), ax = Math.abs(x);
    // flanks: convex near the summit, concave at the foot; buttresses and gullies run down the fall line
    const prof = lerp(1 - ax * ax * (3 - 2 * ax), Math.pow(1 - ax, 1.5), .45);
    const u = th * r / (R.W * .42), v = d / (R.W * 2.2);
    const sp = ridged(u, v) * .7 + ridged(u * 2.2 + 7.1, v * 1.9) * .3;
    return H * prof * (1 + .42 * (sp - .55) * Math.sin(Math.PI * Math.min(1, ax * 1.1)));
  }
  // the east: low hazy mesas far out on the Hushlands (flat tops, steep sides): within 0.8 rad of east, a band about
  // 2.7 km past the rim, rising from the plain at -50 m to flat tops of up to about 250 m
  function mesaAt(th, d) { const a = Math.abs(wrapA(th)); if (a > .8) return -1e9; const x = (d - 2700 - 260 * Math.sin(th * 5 + 1)) / 380; if (x <= -1 || x >= 1) return -1e9;
    const top = 190 + 70 * Math.sin(th * 9 + .4) + 40 * Math.sin(th * 23) - 60 * Math.max(0, Math.sin(th * 4.3 + 2)); return -50 + Math.max(30, top) * sm(1, .58, Math.abs(x)) * sm(.8, .5, a); }
  // the land past the rim: high meadows, the three ranges (faded out toward the east opening by mask), the east blended
  // back to FILM.valley.ground (vg: the cliff and the plain at -50 m), and the mesas on top
  function outerLand(x, z, th, r, d, vg) {
    const a = Math.abs(wrapA(th)), east = sm(.5, .2, a), mask = sm(.24, .62, a);
    let h = 36 + Math.min(d - 14, 260) * .1 + 14 * (A.vn2(x * .012, z * .012) - .5);   // high meadows between the ranges
    if (mask > 0) for (const R of RANGES) { const v = rangeAt(R, th, d, r) * mask; if (v > h) h = v; }
    h = lerp(h, vg, east);
    return Math.max(h, mesaAt(th, d));
  }
  // the ground everywhere (JS): FILM.valley.ground in the bowl and near the rim, painted ranges beyond (blended from 40 to
  // 90 m past the rim). This is the height the terrain mesh is built from (FILM.world.groundAt).
  function groundAt(x, z) {
    const r = Math.sqrt(x * x + z * z), th = Math.atan2(z, x), d = r - V.ringR(9, th);
    if (d < 40) return V.ground(x, z);
    // far out and away from the east opening FILM.valley.ground has no say (it is only needed to blend, or for the plain)
    const vg = d < 90 || Math.abs(th) < .55 ? V.ground(x, z) : 0;
    return lerp(vg, outerLand(x, z, th, r, d, vg), sm(40, 90, d));
  }

  // the skyline seen from the middle of the bowl (for reflections of the peaks in water): tan of the horizon by azimuth.
  // For 384 azimuths, march out from 170 m to 3.6 km (7.5% longer steps each time) and keep the steepest (height - 14) / d,
  // i.e. the horizon seen from an eye 14 m up at the centre. Stored as tan / 0.6 in the red channel of a 384 x 1 texture.
  function skylineTex() {
    const N = 384, px = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) { const th = (i + .5) / N * TAU - Math.PI, c = Math.cos(th), s = Math.sin(th); let m = 0;
      for (let d = 170; d < 3600; d *= 1.075) { const h = groundAt(c * d, s * d) - 14; m = Math.max(m, h / d); }
      px[i * 4] = clamp(m / .6) * 255; px[i * 4 + 3] = 255; }
    const t = new THREE.DataTexture(px, N, 1, THREE.RGBAFormat); t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
  }

  // ---- the terrain mesh: polar, one column per angle. Every column has the same list of features in the same order
  //      (the pond's 12 samples, then per terrace: the wall's 7 samples and the top's 9, then the rim's 24, then each range's
  //      16, then 2 far out), so neighbouring columns never join a wall foot to a wall top. Walls: the ground steps where
  //      max(R(k), B(k)) puts it (R = the ring radius, B = the band boundary FILM.valley.ground uses to pick the terrace;
  //      see WORLD.md), sampled on both sides of the step, never exactly on it.
  // RIM_D: metres past the rim R9, dense where the crest bends. WALL_U, TOP_U: fractions up a wall and across a terrace top.
  // RANGE_X: across a range in half widths from its centre line, denser near the crest.
  const RIM_D = [.02, .6, 1.5, 3, 5, 7.5, 10, 13, 15.5, 17.5, 19, 20.5, 22.5, 25, 27.5, 30.5, 34, 38, 43, 49, 56, 65, 75, 85];
  const WALL_U = [0, .14, .32, .5, .68, .84, 1], TOP_U = [.015, .06, .14, .26, .42, .6, .78, .92, .985];
  const RANGE_X = [-.92, -.74, -.56, -.4, -.26, -.14, -.05, .05, .15, .28, .44, .62, .82];
  // the sample radii of the column at angle th, and a zone per sample (the aZone attribute the painters read):
  // 0 the bowl, 1 the rim and meadows, 1 + g on range g (its far side climbs toward 2 + g), 4 the far edge
  function samplesFor(th) {
    const w = V.wob(th), R = k => 40 + 16.5 * k + w * (.5 + k / 9), B = k => 40 + .5 * w + 16.5 * k, rs = [], zone = [], R0 = R(0);
    // radii must strictly increase (by at least 4 mm), or the strip of quads would fold
    const push = (r, z) => { rs.push(rs.length ? Math.max(r, rs[rs.length - 1] + .004) : r); zone.push(z); };
    for (const f of [0, .16, .32, .46, .58, .68, .76, .83, .89, .935, .97]) push(R0 * f, 0);
    push(R0 - .015, 0);
    for (let k = 0; k < 9; k++) {
      // FILM.valley.ground draws wall k as a smoothstep from R - 0.27 to R + 0.63. If the band boundary B falls before that
      // ramp, the whole ramp is drawn (smooth); otherwise the ground jumps at B, so sample just before and after the jump.
      const rk = R(k), bk = B(k), smooth = bk <= rk - .27;
      const foot = smooth ? rk - .27 : bk - .015, top = Math.max(rk + .63, bk + .03);
      if (k > 0) { // the wall of terrace k+1 (k = 0 is the pond's stone lip, sampled the same way)
        if (smooth) for (const u of WALL_U) push(lerp(foot, top, u), 0);
        else { push(bk - .015, 0); push(bk + .015, 0); for (let i = 1; i < WALL_U.length - 1; i++) push(lerp(bk + .015, top, i / (WALL_U.length - 2)), 0); } }
      else for (const u of WALL_U) push(lerp(Math.max(foot, R0 - .01), top, u), 0);
      // the top of terrace k+1, from this wall's top to the next wall's foot
      const rk1 = R(k + 1), bk1 = B(k + 1), next = k < 8 ? (bk1 <= rk1 - .27 ? rk1 - .27 : bk1 - .015) : R(9) - .02;
      for (const u of TOP_U) push(lerp(top, next, u), 0); }
    // the rim, then for each range three samples across the gap before it and 13 across it, then the far edge
    const R9 = R(9); for (const d of RIM_D) push(R9 + d, 1);
    let prev = R9 + 85;
    RANGES.forEach((G, gi) => { const D = rangeD(G, th);
      const lo = D - G.W * .92; for (const u of [.25, .5, .75]) push(lerp(prev, lo, u), 1 + gi);
      for (const x of RANGE_X) push(R9 + D + x * G.W, 1 + gi + (x > 0 ? x * .99 : 0));
      prev = R9 + D + G.W * .92; });
    for (const d of [3600, 3900]) push(R9 + d, 4);
    return { rs, zone };
  }
  // the mesh: NA = 640 columns (about 1.9 m apart at the rim), NR samples each, heights from groundAt()
  function terrainGeo() {
    const NA = 640, NR = samplesFor(0).rs.length, pos = new Float32Array(NA * NR * 3), zn = new Float32Array(NA * NR);
    for (let j = 0; j < NA; j++) { const th = -Math.PI + j / NA * TAU, c = Math.cos(th), s = Math.sin(th), S = samplesFor(th);
      for (let i = 0; i < NR; i++) { const x = c * S.rs[i], z = s * S.rs[i], o = (j * NR + i) * 3; pos[o] = x; pos[o + 1] = groundAt(x, z); pos[o + 2] = z; zn[j * NR + i] = S.zone[i]; } }
    // two index ranges: the bowl (pond, walls, terrace tops, and the step down into the notch) and the land past the rim.
    // They become two geometry groups, so the mesh takes two materials (the two painters, see steps()).
    const SPLIT = samplesFor(0).zone.indexOf(1), idx = new Uint32Array(NA * (NR - 1) * 6); let n = 0;
    const quads = (i0, i1) => { for (let j = 0; j < NA; j++) { const j2 = (j + 1) % NA; for (let i = i0; i < i1; i++) { const a = j * NR + i, b = j2 * NR + i, c = a + 1, d = b + 1;
      idx[n++] = a; idx[n++] = b; idx[n++] = c; idx[n++] = c; idx[n++] = b; idx[n++] = d; } } };
    quads(0, SPLIT); const nBowl = n; quads(SPLIT, NR - 1);
    const g = new THREE.BufferGeometry(); g.addGroup(0, nBowl, 0); g.addGroup(nBowl, n - nBowl, 1); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aZone', new THREE.BufferAttribute(zn, 1)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals(); g.boundingSphere = new THREE.Sphere(V3(), 4600); return g;
  }

  // the terrain painters (GLSL hooks for E.toon). Two materials share these declarations: the bowl (vZone 0) and the land
  // past the rim (vZone 1..4). E.toon's hooks: fpre sets the base colour (base), the normal (N) and a light multiplier
  // (lightK) before the cel lighting; fpost then works on the lit colour (c). See film/engine.js.
  const TER_PARS = /* glsl */`
${V.GLSL}
${P.GLSL}
${MAP_GLSL}
${WET_GLSL}
${SKY_GLSL}
uniform float uGustNow, uFieldK, uRain;
varying float vZone;
// the ring radius R(k) and the band boundary B(k) (w = the wobble at this angle), and the foot and top radius of wall k:
// the same rule samplesFor() builds the mesh with
float tR(float k, float w){ return 40.0 + 16.5 * k + w * (0.5 + k / 9.0); }
float tB(float k, float w){ return 40.0 + 0.5 * w + 16.5 * k; }
float edgeBot(float k, float w){ float r = tR(k, w), b = tB(k, w); return b <= r - 0.27 ? r - 0.27 : b - 0.015; }
float edgeTop(float k, float w){ return max(tR(k, w) + 0.63, tB(k, w) + 0.03); }
// an sRGB colour (0..1) to linear light, so the painters can write colours the way a painter picks them
vec3 sRGB(vec3 c){ return pow(c, vec3(2.2)); }
// explicit mip level and edge width for a noise lookup of s texture units per metre (uses pxw, the world size of a pixel),
// so lookups inside branches need no derivatives
#define LOD(s) max(0.0, log2(pxw * (s) * 256.0))
#define DW(s) (0.015 + 3.0 * pxw * (s))
// a brush dab mask from noise with an explicit edge width w: 1 where lo < n < hi
float dabW(float n, float lo, float hi, float w){ return smoothstep(lo - w, lo + w, n) * (1.0 - smoothstep(hi - w, hi + w, n)); }
// a brush dab mask from noise: crisp-edged painted patches that stay clean at distance
float dab(float n, float lo, float hi){ float w = fwidth(n) * 1.2 + 0.015; return smoothstep(lo - w, lo + w, n) * (1.0 - smoothstep(hi - w, hi + w, n)); }
// the dappled light under the rain-field: glassy beads bend the sun into drifting bright and dark patches.
// The patch sits under the field, moved along the sun by the field's height above the terraces; inside it the light is
// multiplied by 0.6 (dark spots) .. 1.1 (bright spots), stepping on the held clock (uHeld) like the rest of the drawing.
float fieldDapple(vec2 p, float t){ if (uFieldK <= 0.0) return 1.0; vec3 fc = fieldC(t); float sy = max(uSunDir.y, 0.15);
  vec2 c = fc.xz - uSunDir.xz / sy * (fc.y + 14.0 - 22.0); vec2 d = (p - c) / vec2(84.0, 58.0); float m = 1.0 - smoothstep(0.75, 1.05, length(d));
  if (m <= 0.0) return 1.0; vec2 q = (p - fc.xz) * 0.06; float n = nz(q + vec2(0.0, uHeld * 0.012)) * 0.6 + nzA(q * 2.3 - vec2(uHeld * 0.02, 0.0)) * 0.4;
  float spots = smoothstep(0.52, 0.56, n); return mix(1.0, mix(0.6, 1.1, spots), m * uFieldK); }
// a dry-stone wall seen in a reflection (dark warm stone, the moss lip on top). hRel = height up the 3.2 m wall
vec3 wallRefl(float hRel){ vec3 st = sRGB(vec3(0.46, 0.38, 0.36)) * uShade; vec3 mo = sRGB(vec3(0.27, 0.42, 0.2)) * mix(uShade, uSunCol, 0.5);
  return mix(st, mo, smoothstep(2.75, 2.85, hRel)); }`;

  // the start of both painters (inside E.toon's fpre): where we are (polar coordinates, the wobble w), the flat face normal
  // fn from screen derivatives (the true facet, so walls read as walls), the world size of a pixel, the distance past the
  // rim, the outputs the painters fill in, and the cloud shadow from the world map
  const TER_HEAD = /* glsl */`
  vec3 wp = vWP; vec2 xz = wp.xz; float r = length(xz), th = atan(xz.y, xz.x), w = vWob(th);
  vec3 fn = normalize(cross(dFdx(vWP), dFdy(vWP))); if (fn.y < 0.0) fn = -fn;
  float pxw = length(fwidth(vWP));                        // world size of a pixel here
  float R9 = tR(9.0, w), dRim = r - R9;
  float dCam = length(vWP - cameraPosition);
  float steep = 1.0 - fn.y;
  // filled in by the painters, read again after lighting (TER_POST, TER_POST_WET): wetness and its 0.6 m front band, gloss
  // (how much the ground mirrors), terrace / wall / moss / outer-land / snow / Hushlands masks, the distance to the terrace's
  // outer edge (tDOut) and its index (tKt), standing water and the young shoots in it
  float wet = 0.0, wetFront = 0.0, gloss = 0.0, isTop = 0.0, isWall = 0.0, mossK = 0.0, outer = 0.0, snow = 0.0, hushK = 0.0;
  float tDOut = 99.0, tKt = 0.0, waterK = 0.0, shoots = 0.0;
  vec3 col;
  vec4 wmap = worldMap(xz); float cs = wmap.r;
  float lightMul = 1.0 - 0.8 * cs;                        // a cloud shadow keeps 20% of the sun
`;
  const TER_BOWL = TER_HEAD + /* glsl */`
  {
    // ================================================================ the bowl: walls and terrace tops
    // a facet steeper than about 60 degrees is a wall, the rest is a terrace top
    float wallK = smoothstep(0.4, 0.6, steep);
    if (wallK > 0.5) {
      // a dry-stone wall: courses of irregular stones, dark baked joints, moss hanging from the top
      isWall = 1.0; N = fn;
      // which wall: kw climbs from y = 3.2 kw to 3.2 (kw + 1) at radius R(kw); f = 0..1 up it
      float kw = floor(wp.y / 3.2 - 0.0005), f = clamp((wp.y - 3.2 * kw) / 3.2, 0.0, 1.0);
      float rw = tR(kw, w); float nS = floor(6.2831853 * rw / 0.8);
      // 7 courses (about 0.46 m each) with wavy bed lines; each course has its own stone length (L x 0.8 m) and offset,
      // su counts stones along the wall, gap is the distance to the nearest joint in metres
      float rows = 7.0; float v = f * rows + 0.16 * sin(th * 41.0 + kw * 2.1) + 0.1 * sin(th * 113.0 + kw);
      float row = floor(v), fv = fract(v);
      float L = 0.75 + 0.6 * h12(vec2(row, kw + 3.0));
      float su = (th / 6.2831853 + 0.5) * nS * 0.8 / L + h12(vec2(row + 7.0, kw)) * 3.0 + 0.12 * sin(v * 3.0 + th * 17.0);
      float id = floor(su), fu = fract(su);
      float gap = min(min(fv, 1.0 - fv) * 3.2 / rows, min(fu, 1.0 - fu) * L);
      float jw = 0.022 + pxw * 0.6;                        // joint half-width: about 2 cm, plus a share of a pixel so it never breaks up
      float joint = 1.0 - smoothstep(jw, jw + pxw * 1.2 + 0.01, gap);
      joint *= 1.0 - smoothstep(0.06, 0.2, pxw);            // far walls: joints melt into tone
      // each stone gets its own tone from a hash: warm and cool greys, a few ochre and a few mauve stones
      float hs = h12(vec2(id, row + kw * 17.0));
      vec3 st = mix(sRGB(vec3(0.79, 0.72, 0.6)), sRGB(vec3(0.7, 0.64, 0.6)), smoothstep(0.3, 0.7, hs));
      st = mix(st, sRGB(vec3(0.82, 0.66, 0.47)), step(0.82, hs) * 0.75);
      st = mix(st, sRGB(vec3(0.68, 0.6, 0.62)), step(hs, 0.12) * 0.7);
      st *= mix(1.0, 0.84, smoothstep(0.06, 0.2, pxw));      // far walls keep the weight of their joints
      st *= mix(0.82, 1.08, smoothstep(0.05, 0.85, fv));     // chunky: lit top, darker underside of every stone
      st *= 0.9 + 0.2 * nzL(vec2(su * 0.37, v * 0.41), LOD(1.0));
      st = mix(st, sRGB(vec3(0.29, 0.18, 0.17)), joint * 0.8);
      st *= mix(0.7, 1.0, smoothstep(0.0, 0.22, f));         // baked dark at the foot
      // moss tongues hanging over the top course (mh = metres below the wall top, mossW = how far the moss hangs here),
      // with a thin dark line under the moss edge
      float mh = (1.0 - f) * 3.2; float mn = nzL(vec2((th / 6.2831853) * floor(rw * 1.2), kw * 0.37), LOD(0.2));
      float mossW = 0.14 + 0.55 * mn * mn + 0.12 * sin(th * 233.0 + kw);
      mossK = 1.0 - smoothstep(mossW - 0.02 - pxw, mossW + pxw, mh);
      vec3 moss = mix(sRGB(vec3(0.33, 0.5, 0.2)), sRGB(vec3(0.46, 0.62, 0.24)), smoothstep(0.55, 0.62, nzL(vec2(th * 30.0, wp.y * 2.0), LOD(2.0))));
      col = mix(st, moss, mossK);
      col *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.05 + pxw, abs(mh - mossW - 0.03))) * (1.0 - mossK);
      wet = max(wmap.g, wetCascade(xz, uTime)); col *= mix(1.0, 0.72, wet);
      // the flood pours over the walls: water sheets for a few seconds after the terrace above fills
      // (terrace kw + 1 is fully wet at 76.2 + 0.5 (9 - (kw + 1)); the streams fade out 2.5-5 s later)
      float tSp = 76.2 + 0.5 * (9.0 - (kw + 1.0)); float sheet = smoothstep(tSp, tSp + 0.3, uTime) * (1.0 - smoothstep(tSp + 2.5, tSp + 5.0, uTime));
      if (sheet > 0.0) {   // thin streams of the flood spilling over the brink, white where they churn
        float nst = floor(6.2831853 * rw / 1.6), sx = (th / 6.2831853 + 0.5) * nst, ci = floor(sx), fx = fract(sx), hs2 = h12(vec2(ci, kw + 9.0));
        float wdt = 0.03 + 0.08 * hs2, stream = (1.0 - smoothstep(wdt - 0.02, wdt, abs(fx - 0.5))) * step(0.45, hs2);
        float flow = nzL(vec2(ci * 0.37, wp.y * 0.45 + uTime * 2.2), LOD(0.45));
        col = mix(col, mix(sRGB(vec3(0.62, 0.86, 0.9)), vec3(1.0), smoothstep(0.55, 0.68, flow)), sheet * stream * 0.7 * (1.0 - smoothstep(0.05, 0.2, pxw))); }
    } else {
      // ================================================================ terrace tops: straw-gold fields
      isTop = 1.0;
      float kt = floor(wp.y / 3.2 + 0.5); tKt = kt;          // terrace k has its top at y = 3.2 k
      // light the tops flat: a painted field is one tone (the strokes below give it life)
      N = vec3(0.0, 1.0, 0.0);
      if (kt < 0.5) { col = sRGB(vec3(0.62, 0.6, 0.5)); }   // the pond bed, under the water
      else {
        // the top runs from its own wall's top (lo) to the foot of the next wall (hi; the rim for terrace 9):
        // u = 0..1 across it, dIn / dOut = metres from the inner brink / to the outer wall foot, rm its middle radius
        float lo = edgeTop(kt - 1.0, w), hi = kt < 8.5 ? edgeBot(kt, w) : R9;
        float u = clamp((r - lo) / max(hi - lo, 1.0), 0.0, 1.0), dIn = r - lo, dOut = hi - r, rm = 0.5 * (lo + hi);
        tDOut = dOut;
        float a01 = th / 6.2831853 + 0.5;                    // 0..1 round the bowl (seam-free patterns use whole periods)
        // patchwork: plots about 24 m long round the terrace, each one a colour family picked by a hash (ph)
        float nPlot = floor(6.2831853 * rm / 24.0);
        float pu = a01 * nPlot + kt * 0.37 + 0.35 * sin(r * 0.12 + kt); float plot = floor(pu), pf = fract(pu);
        float ph = h12(vec2(plot, kt));
        vec3 straw = sRGB(vec3(0.851, 0.659, 0.357));
        vec3 pale = sRGB(vec3(0.91, 0.77, 0.47)), ochre = sRGB(vec3(0.8, 0.57, 0.29)), olive = sRGB(vec3(0.72, 0.68, 0.36)), dusty = sRGB(vec3(0.86, 0.72, 0.52)), rust = sRGB(vec3(0.76, 0.5, 0.3));
        col = straw;
        col = mix(col, pale, step(0.64, ph) * 0.85); col = mix(col, ochre, step(ph, 0.18) * 0.8); col = mix(col, olive, step(0.42, ph) * step(ph, 0.53) * 0.85);
        col = mix(col, dusty, step(0.9, ph) * 0.8); col = mix(col, rust, step(0.18, ph) * step(ph, 0.24) * 0.6);
        col *= mix(1.03, 0.96, kt / 9.0); col = mix(col, pale, (kt / 9.0) * 0.2);   // higher terraces paler, lower warmer
        // straw strokes along the terrace: big sweeps, medium strokes, fine straws
        float aS = a01 * floor(6.2831853 * rm / 9.0);
        float s1 = nzL(vec2(aS * 0.11, r * 0.07 + kt * 0.31), LOD(0.07)), s2 = nzAL(vec2(aS * 0.6, r * 0.55 + kt), LOD(0.55)), s3 = 0.5;
        if (pxw < 0.08) s3 = nzL(vec2(aS * 3.1, r * 3.3 + kt * 0.7), LOD(3.3));       // fine straws: only where they can be seen
        col *= 1.0 + (s1 - 0.5) * 0.16;
        col = mix(col, col * 1.14 + vec3(0.02, 0.015, 0.0), dabW(s2, 0.6, 1.1, DW(0.55)) * 0.8);
        col = mix(col, col * 0.84, dabW(s2, -0.1, 0.34, DW(0.55)) * 0.75);
        col = mix(col, col * 1.12, dabW(s3, 0.64, 1.1, DW(3.3)) * (1.0 - smoothstep(0.02, 0.08, pxw)));
        // furrows: thin rows along the terrace, faded out where they would shimmer
        float rq = r / 1.05 + 0.3 * sin(th * 7.0 + kt); float rowF = abs(fract(rq) - 0.5) * 2.0; float lw = pxw / 1.05 * 1.5;
        float furrow = (1.0 - smoothstep(0.1 - lw, 0.1 + lw, 1.0 - rowF)) * (1.0 - smoothstep(0.12, 0.35, lw));
        col *= 1.0 - furrow * 0.1 * (1.0 - step(0.88, ph));
        // the boundary between plots: a pale footpath
        float pathW = 0.2 / max(6.2831853 * rm / nPlot, 1.0); float pd = min(pf, 1.0 - pf);
        float fpath = (1.0 - smoothstep(pathW, pathW + pxw * nPlot / (6.2831853 * r) * 1.2, pd)) * (1.0 - smoothstep(0.1, 0.3, pxw));
        col = mix(col, sRGB(vec3(0.93, 0.83, 0.62)), fpath * 0.6);
        // the brink (inner edge): moss cushions; the foot of the next wall (outer edge): a cool grass fringe and contact shadow
        vec3 moss = sRGB(vec3(0.44, 0.6, 0.23)); float fr0 = 0.0;
        if (dIn < 1.2 + pxw * 2.0) { float mn = nzL(vec2(a01 * floor(rm * 1.5), kt * 0.43), LOD(0.24)); float mossW = 0.25 + 0.6 * mn * mn + 0.1 * sin(th * 211.0 + kt);
          mossK = 1.0 - smoothstep(mossW - pxw, mossW + 0.03 + pxw, dIn);
          moss = mix(sRGB(vec3(0.36, 0.53, 0.2)), sRGB(vec3(0.52, 0.67, 0.26)), smoothstep(0.5, 0.56, nzL(vec2(a01 * floor(rm * 6.0), r * 2.0), LOD(2.0))));
          col = mix(col, moss, mossK); }
        if (dOut < 1.4 + pxw * 2.0) { float tuft = nzL(vec2(a01 * floor(rm * 9.0), kt), LOD(1.4)) * 0.9 + 0.35; fr0 = 1.0 - smoothstep(tuft * 0.9 - pxw, tuft * 0.9 + pxw, dOut);
          col = mix(col, mix(sRGB(vec3(0.5, 0.6, 0.28)), sRGB(vec3(0.62, 0.66, 0.3)), step(0.5, h12(floor(vec2(a01 * rm * 3.0, kt))))), fr0 * 0.85); }
        col *= mix(0.74, 1.0, smoothstep(0.0, 0.45 + pxw, dOut));
        // the outer wall's own cast shadow on this terrace (analytic, so it never pops with the shadow map): walk from here
        // toward the sun until the outer wall's top (Dh metres); if the sun ray has risen less than the wall's 3.2 m there,
        // the wall hides the sun
        vec2 sh2 = uSunDir.xz; float shl = length(sh2); vec2 radial = xz / max(r, 1e-3);
        float cosA = dot(radial, sh2 / max(shl, 1e-4));
        if (kt < 8.5 && cosA > 0.02) { float topR = edgeTop(kt, w); float Dh = (topR - r) / cosA; float rise = Dh * uSunDir.y / max(shl, 1e-3);
          lightMul *= smoothstep(3.2 - 0.08, 3.2 + 0.08, rise); }
        // ------------------------------------------------ wet ground and the green flood (M12)
        // Two ways to get wet, each turned into dw, metres behind a wet front: rain from the tolls (we, from the world map)
        // fills low puddle patches first; the cascade (wc) sweeps across the terrace from its outer edge inward. The first
        // 0.6 m behind the front is a darker water line; once fully wet the front band goes.
        float we = wmap.g, wc = wetCascade(xz, uTime);
        float pn = 0.5;
        if (we > 0.0 || wc > 0.0) {
          pn = nzL(xz * 0.021, LOD(0.021)) * 0.65 + nzAL(xz * 0.07, LOD(0.07)) * 0.35;                    // puddle-patch field
          float pe = we - (0.15 + 0.75 * pn);                                       // rain from the tolls: patches that grow
          float prog = wc * 1.18 - 0.08 + (nzL(vec2(a01 * floor(rm * 0.8), r * 0.15), LOD(0.15)) - 0.5) * 0.1;
          float pc = prog - (1.0 - u);                                              // the cascade: a front from the outer edge inward
          float span = max(hi - lo, 1.0);
          float dw = max(pe * 40.0, pc * span);                                     // metres behind the front
          wet = smoothstep(-pxw, pxw, dw);
          wetFront = wet * (1.0 - smoothstep(0.6, 0.6 + pxw * 2.0, dw));
          if (we >= 0.999 || wc >= 0.999) { wet = 1.0; wetFront = 0.0; }
        }
        if (wet > 0.0) {
          // wet ground turns jade, with the same strokes as the straw; light green patches where sprouts come up from 77 s
          // (the sprouts themselves are in life.js)
          float sprout = smoothstep(0.6, 0.68, nzL(xz * 0.35, LOD(0.35))) * smoothstep(77.0, 82.0, uTime);
          vec3 jade = sRGB(vec3(0.247, 0.682, 0.478)), deep = sRGB(vec3(0.18, 0.42, 0.31)), tip = sRGB(vec3(0.56, 0.82, 0.42));
          vec3 g = jade * (1.0 + (s1 - 0.5) * 0.22);
          g = mix(g, tip, dabW(s2, 0.6, 1.1, DW(0.55)) * 0.55 + sprout * 0.5);
          g = mix(g, deep, dabW(s2, -0.1, 0.32, DW(0.55)) * 0.5 + furrow * 0.18);
          g = mix(g, moss, mossK);
          // standing water: crisp puddles in the low patches (about a fifth of the field) that spread while it rains; flooded at dusk
          float water = dabW(pn + 0.25 * (s1 - 0.5), 0.0, 0.3 + 0.12 * wc, DW(0.05)) * (1.0 - mossK);
          water = max(water, uMirror * (1.0 - fr0 * 0.85) * (1.0 - mossK * 0.85));
          col = mix(col, g, wet);
          col = mix(col, deep * 0.9, wetFront);
          gloss = wet * mix(0.12, 1.0, water);
          waterK = wet * water;
          // rows of young shoots poking through the water (rice-paddy texture), near the camera only
          float rowD = abs(fract(rq) - 0.5) * 2.0, sh = h12(floor(vec2(a01 * rm * 6.2831853 / 0.45, floor(rq))));
          float along = fract(a01 * rm * 6.2831853 / 0.45 + sh * 0.5);
          shoots = waterK * step(rowD, 0.14) * step(0.62 + 0.2 * sh, along) * step(sh, 0.55) * (1.0 - smoothstep(0.03, 0.08, pxw));
        }
      }
    }
  }
  base = col;
  lightK *= lightMul * fieldDapple(xz, uTime);`;
  const TER_OUTER = TER_HEAD + /* glsl */`
  {
    // ================================================================ the land past the rim: meadows, three ranges, cliff, Hushlands
    outer = 1.0;
    vec3 Ns = normalize(vWN);                              // the smooth vertex normal (the slope of the hillside)
    // a = angle from east (0 = the Spillway notch); eastK = 1 on the east side past the notch (the cliff, the Hushlands)
    float a = abs(atan(sin(th), cos(th)));
    float eastK = (1.0 - smoothstep(0.3, 0.62, a)) * smoothstep(14.0, 40.0, dRim);
    float slope = smoothstep(0.2, 0.55, 1.0 - Ns.y), hgt = wp.y, zone = vZone;
    float far = smoothstep(1.4, 2.6, zone);                // 0 near range .. 1 the far ranges (strokes get broader)
    float sc = mix(1.0, 0.3, far);                         // the scale of every pattern: far ranges get bigger strokes
    // strokes that run down the fall line (radial for every range): dark gullies and light ribs, big enough to read from the valley.
    // Whole periods round the bowl per layer, so the strokes have no seam in the west.
    float a01 = th / 6.2831853 + 0.5, Rb = zone < 1.5 ? 430.0 : zone < 2.5 ? 1080.0 : 2560.0;
    float pA = floor(6.2831853 * Rb * 0.011 * sc), pB = floor(6.2831853 * Rb * 0.04 * sc);
    float sA = nz(vec2(a01 * pA, r * 0.0032 * sc)), sB = nzA(vec2(a01 * pB, r * 0.011 * sc));
    // near the rim the ground is not a mountainside: no fall-line direction there (radial strokes would read as light rays)
    float iso = 1.0 - smoothstep(70.0, 170.0, dRim);
    sA = mix(sA, nz(xz * 0.016 + 0.7), iso); sB = mix(sB, nzA(xz * 0.05 + 0.2), iso);
    float sC = nz(xz * 0.045 + 0.3) * 0.6 + nzA(xz * 0.13) * 0.4;                // meadow tufts: no direction
    vec2 fp = vec2(-sin(th), cos(th));                     // along the ring, across the fall line (tilts N at the end)
    float pz = nz(xz * 0.0035 + 0.3);                      // broad patches of warmer and greener grass
    // grass: straw-green meadows low down, a cooler sage green higher up
    vec3 grassL = mix(sRGB(vec3(0.76, 0.75, 0.38)), sRGB(vec3(0.58, 0.7, 0.36)), smoothstep(0.4, 0.62, pz));
    vec3 grassH = sRGB(vec3(0.56, 0.67, 0.46));
    vec3 forest = sRGB(vec3(0.27, 0.45, 0.33)), rockW = sRGB(vec3(0.78, 0.68, 0.56)), rockC = sRGB(vec3(0.62, 0.6, 0.7));
    col = mix(grassL, grassH, smoothstep(60.0, 260.0, hgt + (pz - 0.5) * 80.0));
    // meadow: grass strokes and darker tufts, crisp at the rim, melting into tone further out
    float near = 1.0 - smoothstep(0.03, 0.4, pxw);
    col = mix(col, col * vec3(0.82, 0.9, 0.86), dab(sC, -0.1, 0.33) * (0.35 + 0.4 * near));
    col = mix(col, col * 1.1 + vec3(0.02, 0.02, 0.0), dab(sC, 0.7, 1.1) * 0.6);
    // forest: dark tree masses on the lower slopes of the near and middle ranges (not the far ones, not near the rim, not
    // on cliffs), thick low down, running up the gullies (low sA) in fingers, with scalloped crown edges (cells)
    float fz = nz(xz * 0.0045 * sc + 1.7);
    float low = 1.0 - smoothstep(20.0 + 70.0 * far, 120.0 + 230.0 * far, hgt - 36.0);
    float fk = fz * 0.4 + (1.0 - sA) * 0.42 + low * 0.5 + (cells(xz * 0.07 * sc) - 0.5) * 0.08;
    float forestK = dab(fk, 0.74, 9.0) * (1.0 - smoothstep(2.6, 3.0, zone)) * smoothstep(20.0, 70.0, dRim) * (1.0 - smoothstep(0.75, 0.95, slope));
    float crowns = smoothstep(0.55, 0.6, cells(xz * 0.16 * sc + 3.1));
    col = mix(col, forest * (0.88 + 0.18 * sB + 0.12 * crowns), forestK * 0.94);
    // rock on the steep faces: warm in the light, cool blue-violet in the clefts
    vec3 rock = mix(rockW, rockC, smoothstep(0.35, 0.65, sA) * 0.7 + far * 0.3);
    // near rock faces: vertical cracks and ledges, so a cliff reads as stone, not a smooth wall
    if (dRim < 260.0) { vec2 tH = normalize(vec2(-Ns.z, Ns.x) + vec2(1e-4)); float ck = nz(vec2(dot(xz, tH) * 0.11, wp.y * 0.018 + 0.4));
      rock *= mix(1.0, 0.72, dab(ck, -0.1, 0.3)) * mix(1.0, 1.12, dab(fract(wp.y / 3.7 + ck * 0.6), 0.0, 0.12)); }
    col = mix(col, rock, slope * (1.0 - forestK * 0.6));
    col *= 1.0 + (sA - 0.5) * 0.22;
    col = mix(col, col * 0.76, dab(sB, -0.1, 0.3) * (0.35 + 0.65 * slope));
    col = mix(col, col * 1.12 + vec3(0.01), dab(sB, 0.72, 1.1) * 0.7);
    // snow on the far peaks: a crisp line that follows the strokes, thicker on the shallow ledges
    snow = smoothstep(0.5, 0.52, (hgt - 880.0) / 420.0 + (sA - 0.5) * 0.7 + (1.0 - slope) * 0.25) * smoothstep(2.4, 2.8, zone);
    col = mix(col, sRGB(vec3(0.96, 0.97, 1.0)), snow);
    // the crest: the straw meadow carries on over the rim, with a few stones
    float crest = (1.0 - smoothstep(4.0, 16.0, dRim)) * (1.0 - slope * 0.7);
    col = mix(col, mix(sRGB(vec3(0.82, 0.72, 0.42)), sRGB(vec3(0.68, 0.7, 0.38)), smoothstep(0.45, 0.6, sC)) * (0.94 + 0.12 * sB), crest);
    // the Spillway shoulder: a worn stony floor in the notch
    float notch = (1.0 - smoothstep(0.07, 0.12, a)) * (1.0 - smoothstep(14.0, 20.0, dRim));
    col = mix(col, mix(sRGB(vec3(0.76, 0.68, 0.55)), sRGB(vec3(0.62, 0.66, 0.44)), smoothstep(0.45, 0.6, sB)), notch * 0.85);
    // the cliff to the east: banded sandstone, broken by gullies
    float cliff = eastK * smoothstep(0.3, 0.55, slope);
    float band = fract(hgt / 5.3 + 0.35 * nz(xz * 0.008) + 0.15 * sB);
    vec3 strata = mix(sRGB(vec3(0.82, 0.68, 0.52)), sRGB(vec3(0.74, 0.6, 0.52)), smoothstep(0.42, 0.58, band) * (0.4 + 0.6 * nz(xz * 0.02))) * (0.88 + 0.2 * sA);
    strata = mix(strata, col, smoothstep(0.55, 0.75, 1.0 - slope) * 0.6);         // ledges keep their grass
    col = mix(col, strata, cliff);
    // the Hushlands: a dry ochre plain with long wind lines and pale dry riverbeds, and the far mesas.
    // hushK: low ground in the east (the plain at -50 m; 1.8-2.4 km out the limit rises so the mesas count too)
    hushK = eastK * (1.0 - smoothstep(-35.0, -15.0, hgt - smoothstep(1800.0, 2400.0, dRim) * 160.0));
    vec3 hush = sRGB(vec3(0.85, 0.72, 0.52)) * (1.0 + (nz(vec2(xz.x * 0.0012, xz.y * 0.005)) - 0.5) * 0.18);
    hush = mix(hush, sRGB(vec3(0.94, 0.86, 0.7)), dab(nz(vec2(xz.x * 0.002, xz.y * 0.012)), 0.66, 1.1) * 0.5);
    hush = mix(hush, sRGB(vec3(0.82, 0.62, 0.48)), smoothstep(0.3, 0.6, slope) * smoothstep(1800.0, 2300.0, dRim));
    col = mix(col, hush, max(hushK, smoothstep(1800.0, 2200.0, dRim) * (1.0 - smoothstep(0.55, 0.75, a))));
    // dusk: the greens and golds give way to a cool grey-violet so the low sun paints them pink and the shade goes blue
    col = mix(col, vec3(dot(col, vec3(0.3, 0.55, 0.15))) * vec3(0.92, 0.86, 1.08), uMirror * 0.72);
    // painterly terminator: the light/shadow border breaks along the strokes
    N = normalize(Ns + fp.xyy * vec3(1.0, 0.0, 1.0) * (sA - 0.5) * 0.5 + vec3(0.0, (sB - 0.5) * 0.25, 0.0));
    }
  base = col;
  lightK *= lightMul * fieldDapple(xz, uTime);`;

  // after the cel lighting, for both painters (E.toon's fpost): c = the lit colour, lit = 0..1 how sunlit this point is
  const TER_POST = /* glsl */`
  // shade is a colour, not grey: shadowed ground keeps (and gains) saturation, the way a painter mixes a shadow
  float shd = (1.0 - lit) * (1.0 - outer * 0.5); float lum = dot(c, vec3(0.3, 0.59, 0.11));
  c = mix(c, max(vec3(lum) + (c - vec3(lum)) * 1.45, 0.0) * vec3(0.96, 0.9, 1.04), shd * 0.75);
  // the gust: the racing cloud's shadow goes slate-teal (36-42)
  c = mix(c, c * vec3(0.5, 0.7, 0.84), cs * uGustNow * 0.85);
  // halftone screen inside cloud shadows (45 degrees, 5 px at 1080p, ink colour)
  vec3 inkC = outer > 0.5 ? base * vec3(0.3, 0.26, 0.42) : vec3(0.29, 0.18, 0.17) * 0.6;
  c = mix(c, inkC, 0.18 * halftone(cs) * smoothstep(0.04, 0.35, cs) * (1.0 - smoothstep(900.0, 1800.0, dCam)));
  // gust: long white wind streaks racing over the ground (36-42), stepped on twos
  if (uGustNow > 0.0) { float hb = floor(uHeld * 12.0) / 12.0; vec2 q = vec2((xz.x - hb * 46.0) * 0.0035, xz.y * 0.16 + 0.2 * sin(xz.x * 0.01));
    float sn = nz(q) * 0.65 + nzA(q * vec2(1.7, 0.6)) * 0.35; float line = smoothstep(0.685, 0.7, sn) * (1.0 - smoothstep(0.705, 0.72, sn));
    float taper = smoothstep(0.35, 0.7, nzA(vec2(q.x * 0.5, q.y * 0.25 + 3.0)));                   // strokes break up and taper
    c = mix(c, vec3(1.0, 0.99, 0.96), uGustNow * line * taper * 0.4 * (1.0 - smoothstep(200.0, 600.0, dCam))); }
  // aerial perspective: bluer and lighter with distance, haze pooling at the feet of far mountains; the Hushlands go to ochre haze.
  // ap: clear for the first 220 m, then 1 - exp(-d / 1250 m); plus haze pooling low down beyond 350 m (full below 25 m,
  // thinning upward over about 240 m).
  // The haze colour is cooler in shade and a little brighter in sun, so far ranges keep their light and shade.
  float ap = 1.0 - exp(-max(dCam - 220.0, 0.0) / 1250.0);
  ap += (1.0 - ap) * exp(-max(wp.y - 25.0, 0.0) / 240.0) * smoothstep(350.0, 1600.0, dCam) * 0.5;
  float eastHz = (1.0 - smoothstep(0.35, 0.7, abs(atan(sin(th), cos(th))))) * smoothstep(40.0, 300.0, dRim);
  vec3 hz = mix(uHaze, mix(uSkyHor, vec3(0.86, 0.72, 0.52), 0.55), eastHz * (1.0 - uMirror * 0.5));
  vec3 hzc = hz * mix(mix(vec3(0.84, 0.86, 0.96), uShade, 0.35), vec3(1.05), lit) + snow * 0.08 * lit;
  c = mix(c, hzc, clamp(ap, 0.0, 0.9) * 0.88);`;
  const TER_POST_WET = /* glsl */`
  // wet (the bowl only): gloss, mirrored sky (the dusk mirror at uMirror = 1), a sun glint that twinkles on the held clock
  // (uHeld: 12 drawings a second). The water normal Nw gets faint drifting ripples; frs is the Fresnel term.
  if (gloss > 0.0) {
    float lr = max(0.0, log2(pxw * 0.9 * 256.0));         // explicit mip level for the ripple noise (as LOD() above)
    vec2 rip = vec2(nzL(xz * 0.9 + vec2(uTime * 0.05, 0.0), lr), nzAL(xz * 0.9 - vec2(0.0, uTime * 0.04), lr)) - 0.5;
    vec3 Nw = normalize(vec3(rip.x * 0.05, 1.0, rip.y * 0.05));
    vec3 Rv = reflect(-V, Nw); float ndv = max(dot(Nw, V), 0.0); float frs = pow(1.0 - ndv, 4.0);
    vec3 rc = reflSky(Rv);
    // the next wall up reflects as a dark band along the outer edge: the stepped bands of the flooded terraces.
    // Follow the reflected ray outward to the wall foot (tDOut metres away); if it is still under 3.2 m there, it sees the wall.
    vec2 radial = xz / max(r, 1e-3); float ro = dot(Rv.xz, radial);
    if (ro > 0.01 && tKt < 8.5) { float tw = tDOut / ro; float hh = tw * Rv.y; if (hh < 3.2) rc = wallRefl(hh); }
    float k = gloss * mix(0.3 + 0.6 * frs, 0.88, uMirror);
    c = mix(c, rc, k);
    // the sun's glint: a hard core, and a wider sparkle where a hash of the 33 cm cell and the drawing number says so
    float sp = dot(Rv, uSunDir); float tw2 = h12(floor(xz * 3.0) + floor(uHeld * 12.0));
    c += uSunCol * uSunVis * gloss * (smoothstep(0.997, 0.999, sp) * 2.0 + smoothstep(0.97, 0.99, sp) * 0.3 * step(0.7, tw2)) * (1.0 - cs * 0.7);
  }
  // the young shoots stand out of the mirror as dark little strokes
  c = mix(c, mix(sRGB(vec3(0.16, 0.36, 0.22)), sRGB(vec3(0.3, 0.2, 0.35)), uMirror * 0.6) * mix(uShade, uSunCol, 0.5), shoots * 0.85);
` + TER_POST;

  // ==================================================================================================== pond
  // The pond's water surface: a flat disc at y = 0, cut to the wavy edge R0 = 40 + 0.5 w (the pond lip of FILM.valley).
  // Flat depth bands for the body colour (the depth is read from vGround, 0 at the edge to 0.8 m), ripple rings,
  // the mirrored sky and peaks, anime highlight streaks, a cream line at the stone edge.
  const POND_FS = /* glsl */`${E.COMMON}
${V.GLSL}
${MAP_GLSL}
${SKY_GLSL}
uniform float uRain; uniform int uPondN;
varying vec3 vWP;
float hh(float x){ return fract(sin(x * 78.233) * 43758.5453); }
void main(){
  vec2 xz = vWP.xz; float r = length(xz), th = atan(xz.y, xz.x), w = vWob(th), R0 = 40.0 + 0.5 * w;
  if (r > R0 + 0.05) discard;
  float depth = -vGround(xz); vec3 V = normalize(cameraPosition - vWP); float dCam = length(cameraPosition - vWP);
  // ripple rings: a few plops (frogs, falling beads) at deterministic places and times; more while it rains.
  // Source i is on when i < 2.5 + 4.5 uRain (3 when dry, all 7 in rain) and plops once per period (shorter in rain); every
  // period n picks a new place from a hash. Each plop sends two rings out (0.85 and 1.2 m/s) that fade as exp(-0.9 age).
  vec2 nrm = vec2(0.0); float ring = 0.0;
  for (int i = 0; i < uPondN; i++) { float fi = float(i), on = step(fi, 2.5 + uRain * 4.5);
    float per = 2.6 + hh(fi + 0.3) * 2.4 - uRain * 1.4, tt = uTime + fi * 1.37, n = floor(tt / per), age = tt - n * per;
    float an = hh(n * 3.1 + fi) * 6.2831853, rr = sqrt(hh(n * 7.7 + fi * 1.3)) * (R0 - 6.0); vec2 d = xz - vec2(cos(an), sin(an)) * rr;
    float dl = length(d), fade = exp(-age * 0.9) * on, x1 = (dl - age * 0.85 - 0.05) / (0.045 + age * 0.02), x2 = (dl - age * 1.2 - 0.05) / (0.05 + age * 0.02);
    float k = (exp(-x1 * x1) + 0.55 * exp(-x2 * x2)) * fade; ring += k; nrm += d / max(dl, 1e-3) * k * 0.3; }
  // the water normal: the rings plus slow drifting wavelets
  vec2 wav = vec2(nz(xz * 0.13 + vec2(uTime * 0.02, 0.0)), nzA(xz * 0.17 - vec2(0.0, uTime * 0.025))) - 0.5;
  vec3 N = normalize(vec3(nrm.x + wav.x * 0.05, 1.0, nrm.y + wav.y * 0.05));
  // body colour in flat bands by depth (shallow green-teal at the wall, deep cobalt in the middle)
  float db = depth + (nz(xz * 0.05) - 0.5) * 0.12;
  vec3 shal = pow(vec3(0.42, 0.78, 0.76), vec3(2.2)), mid = pow(vec3(0.23, 0.6, 0.73), vec3(2.2)), deep = pow(vec3(0.14, 0.4, 0.62), vec3(2.2));
  vec3 col = mix(shal, mid, smoothstep(0.18, 0.2, db)); col = mix(col, deep, smoothstep(0.55, 0.57, db));
  // light: the cloud shadow darkens the body colour (its halftone screen is added at the end)
  float cs = cloudShadowAt(xz); col *= mix(1.0, 0.72, cs);
  // mirrored sky and peaks (fr: Fresnel; at dusk, uMirror = 1, the pond is almost all mirror)
  vec3 Rv = reflect(-V, N); float ndv = max(dot(N, V), 0.0); float fr = pow(1.0 - ndv, 3.0);
  vec3 rc = reflSky(Rv); float k = mix(0.22 + 0.62 * fr, 0.85, uMirror);
  col = mix(col, rc, k);
  // horizontal highlight streaks (anime water), redrawn on the held clock (hb = the drawing number, 12 a second)
  float hb = floor(uHeld * 12.0);
  float streak = smoothstep(0.6, 0.64, nz(vec2(xz.x * 0.012 + hh(hb) * 0.02, xz.y * 0.16))) * smoothstep(0.35, 0.9, fr + 0.3);
  col = mix(col, mix(uSkyHor, vec3(1.0), 0.5), streak * 0.45 * (1.0 - cs));
  // the sun's glint: a hard core, and sparkles on some 50 cm cells that change with every drawing
  float sp = dot(Rv, uSunDir); col += uSunCol * uSunVis * (smoothstep(0.994, 0.997, sp) * 3.0 + step(0.82, hh(floor(xz.x * 2.0) * 7.0 + floor(xz.y * 2.0) + hb)) * smoothstep(0.95, 0.985, sp) * 0.8) * (1.0 - cs);
  // ripple rings catch the sky
  col = mix(col, mix(uSkyHor, vec3(1.0), 0.6), clamp(ring, 0.0, 1.0) * 0.55);
  // a cream line where the water meets the stone wall
  float edge = 1.0 - smoothstep(0.08, 0.3, R0 - r + (nz(xz * 0.4 + uTime * 0.03) - 0.5) * 0.12);
  col = mix(col, pow(vec3(0.95, 0.96, 0.9), vec3(2.2)), edge * 0.7);
  // the halftone screen inside cloud shadows, as on the terrain; then the fog
  col = mix(col, col * vec3(0.25, 0.3, 0.45) + vec3(0.02, 0.03, 0.05), 0.18 * halftone(cs) * smoothstep(0.05, 0.4, cs));
  col = fogApply(col, vWP);
  gl_FragColor = vec4(col, 1.0); }`;

  // ==================================================================================================== sky dome
  // the dome's fragment shader: the painted sky in the view direction, plus the sun (a crisp white-hot disc and halos)
  const DOME_FS = /* glsl */`${E.COMMON}
${SKY_GLSL}
varying vec3 vD;
void main(){ vec3 d = normalize(vD); vec3 c = skyPaint(d); float s = max(dot(d, uSunDir), 0.0);
  // the sun: a crisp disc and a soft halo
  c += uSunCol * uSunVis * (pow(s, 900.0) * 1.5 + pow(s, 24.0) * uHalo * 0.35);
  c = mix(c, uSunCol * 3.2 + vec3(1.0, 0.98, 0.9), smoothstep(0.99955, 0.99968, s) * uSunVis);
  gl_FragColor = vec4(c, 1.0); }`;

  // ==================================================================================================== cumulus
  // A cloud is a stack of round lobes (one InstancedMesh for every cloud). Shading blends the lobe's own normal with the
  // whole cloud's normal, so each lobe reads as a bump on one big form: lit cream, lilac-white mid, lilac core, a flat
  // darker base, a cream rim on the sun side, indigo ink at 40% on the shade side (constant width, from fwidth).
  // The mesh is built once; the vertex shader moves every lobe with its cloud (x0 + vx t, z0 + vz t).
  // lobesOf(c): the lobes of one cloud, each [x, y, z, radius, flag]: x and z are offsets from the cloud's centre, y is
  // absolute, flag = 1 for a layer's centre lobe. nL layers up the cloud, each a ring of lobes round a centre lobe, narrowing with height
  // (towers: more layers, leaner); lean tilts the stack; then a cauliflower top. Random choices come from the cloud's seed.
  function lobesOf(c) {
    const r = A.rng((c.seed * 1e5) | 0), L = [], tower = c.kind === 'tower';
    const nL = tower ? 6 : 4, lean = (r() - .5) * c.R * .35;
    for (let l = 0; l < nL; l++) { const v = l / (nL - 1);
      const rad = tower ? (1 - .55 * v * v) * (1 - .15 * Math.sin(v * 9 + c.seed)) : (1 - .45 * v * v);
      const yc = c.base + c.H * (tower ? .1 + v * .72 : .12 + v * .62);
      const m = Math.round(6 + 5 * rad);
      for (let j = 0; j < m; j++) { const a = j / m * TAU + r() * .5 + l * 1.7, rr = rad * (.58 + .22 * r()), lr = c.R * rad * (.32 + .16 * r()) * (tower ? .9 : 1);
        L.push([Math.cos(a) * c.R * rr + lean * v, yc + (r() - .3) * lr * .6, Math.sin(a) * c.rz * rr, lr, 0]); }
      L.push([lean * v, yc, 0, c.R * rad * .62, 1]); }
    // the cauliflower top
    const nt = tower ? 5 : 3; for (let j = 0; j < nt; j++) { const a = j / nt * TAU + r(); const lr = c.R * (tower ? .3 : .38) * (.8 + .4 * r());
      L.push([lean + Math.cos(a) * c.R * .25, c.base + c.H * (tower ? .86 : .8) + r() * c.H * .08, Math.sin(a) * c.rz * .25, lr, 0]); }
    L.push([lean, c.base + c.H * .9, 0, c.R * (tower ? .26 : .34), 0]);
    return L;
  }
  // every lobe of every cloud as one InstancedMesh of spheres (squashed 8% in height). Per-lobe attributes:
  //   aC = (cloud x0, base height, z0, centre-lobe flag)   aS = (R, H, rz, kind: 0 drift, 1 tower, 2 gust)
  //   aM = (vx, vz, seed, lobe radius). The shaders do not read aC.w or aM.w.
  function cloudMesh() {
    const all = []; CL.forEach((c, ci) => lobesOf(c).forEach(l => all.push([c, l])));
    const geo = new THREE.SphereGeometry(1, 18, 12), n = all.length;
    const aC = new Float32Array(n * 4), aS = new Float32Array(n * 4), aM = new Float32Array(n * 4);
    const im = new THREE.InstancedMesh(geo, null, n), m = new THREE.Matrix4();
    all.forEach(([c, l], i) => { m.makeScale(l[3], l[3] * .92, l[3]).setPosition(c.x0 + l[0], l[1], c.z0 + l[2]); im.setMatrixAt(i, m);
      aC.set([c.x0, c.base, c.z0, l[4]], i * 4); aS.set([c.R, c.H, c.rz, c.kind === 'tower' ? 1 : c.kind === 'gust' ? 2 : 0], i * 4); aM.set([c.vx, c.vz, c.seed, l[3]], i * 4); });
    geo.setAttribute('aC', new THREE.InstancedBufferAttribute(aC, 4)); geo.setAttribute('aS', new THREE.InstancedBufferAttribute(aS, 4)); geo.setAttribute('aM', new THREE.InstancedBufferAttribute(aM, 4));
    im.material = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, U, WU),
      vertexShader: /* glsl */`${E.COMMON}
attribute vec4 aC, aS, aM; varying vec3 vWP, vN, vCC, vSz; varying float vBase, vKind, vSeed;
// drift with the cloud; anything below the base height is pressed flat onto it with its normal turned down (the flat,
// darker base); vCC is the centre of the whole cloud (for its overall normal), vBase marks the flattened part
void main(){ vec4 w = instanceMatrix * vec4(position, 1.0); vec2 mv = aM.xy * uTime; w.xz += mv;
  vec3 n = normalize(mat3(instanceMatrix) * normal);
  float below = step(w.y, aC.y); w.y = max(w.y, aC.y); n = normalize(mix(n, vec3(0.0, -1.0, 0.0), below * 0.85));
  vWP = w.xyz; vN = n; vCC = vec3(aC.x + mv.x, aC.y + aS.y * 0.42, aC.z + mv.y); vSz = aS.xyz; vBase = below; vKind = aS.w; vSeed = aM.z;
  gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`${E.COMMON}
${SKY_GLSL}
uniform vec3 cLit, cMid, cCore, cGlow;
varying vec3 vWP, vN, vCC, vSz; varying float vBase, vKind, vSeed;
void main(){ vec3 Nl = normalize(vN); if (!gl_FrontFacing) Nl = -Nl; vec3 V = normalize(cameraPosition - vWP); float dist = length(cameraPosition - vWP);
  // Nc: the normal of the whole cloud as one ellipsoid; h: 0 at the base .. 1 at the top; n1, n2: noise to break the tones
  vec3 Nc = normalize((vWP - vCC) / vec3(vSz.x, vSz.y * 0.55, vSz.z));
  float h = clamp((vWP.y - (vCC.y - vSz.y * 0.42)) / vSz.y, 0.0, 1.0);
  float n1 = nz(vWP.xy / vSz.x * 0.9 + vWP.z / vSz.x * 0.4 + vSeed), n2 = nzA(vWP.zy / vSz.x * 1.7 + vSeed * 0.3);
  // light: the whole cloud's form with every lobe a bump on it (lit cap, shadow crescent below); the lower body sits in its own shade
  vec3 N = normalize(mix(Nc, Nl, 0.62));
  float lv = dot(N, uSunDir) + (n1 - 0.5) * 0.28 + (smoothstep(0.0, 0.55, h) - 0.5) * 0.55 + 0.1;
  // three flat tones with crisp steps: core below lv = -0.33, mid, lit above lv = -0.02
  vec3 c = mix(cCore, cMid, smoothstep(-0.36, -0.29, lv));
  c = mix(c, cLit, smoothstep(-0.05, 0.01, lv + (n2 - 0.5) * 0.18));
  // the flat base: a lilac shelf warmed by light bounced up from the gold valley, lighter toward its rim
  float ndv = abs(dot(Nl, V)), fr = 1.0 - ndv;
  vec3 baseC = mix(mix(cMid, cCore, 0.4), cMid * 1.04, smoothstep(0.15, 0.85, fr) * 0.6) + uBounce * 0.045;
  c = mix(c, baseC * (0.97 + 0.06 * n1), smoothstep(0.5, 0.95, vBase));
  // sky light from above on the tops
  c *= 1.0 + 0.05 * Nl.y;
  // gust clouds: heavy slate
  if (vKind > 1.5) c = mix(c, c * vec3(0.55, 0.62, 0.68), 0.75);
  // ink edge (indigo 40%) on the shade side, cream rim on the sun side, a silver lining round the edges against the sun.
  // e = distance to the silhouette in pixels (ndv over its screen derivative), so the line has the same width at any size.
  float e = ndv / max(fwidth(ndv), 1e-4); float edge = 1.0 - smoothstep(1.0, 2.2, e);
  float sunSide = smoothstep(-0.1, 0.25, dot(Nl, uSunDir));
  c = mix(c, mix(c, pow(vec3(0.165, 0.184, 0.42), vec3(2.2)), 0.4), edge * (1.0 - sunSide) * (1.0 - vBase * 0.6));
  c = mix(c, cLit * 1.12, edge * sunSide * 0.8);
  float toSun = pow(max(dot(-V, uSunDir), 0.0), 3.0);
  c += cGlow * (smoothstep(0.5, 0.82, fr) * (0.1 + 1.7 * toSun) + smoothstep(0.82, 0.95, fr) * toSun * 1.2) * uSunVis;
  // distance: lower parts of far clouds sink into the horizon haze
  vec3 dv = (vWP - cameraPosition) / dist; float el = dv.y;
  float hz = (1.0 - exp(-dist / 6500.0)) * 0.5 + (1.0 - smoothstep(0.0, 0.12, el)) * 0.3 * smoothstep(900.0, 3000.0, dist);
  c = mix(c, mix(wSky(normalize(vec3(dv.x, max(el, 0.02), dv.z))), uSkyHor, 0.4), clamp(hz, 0.0, 0.8));
  c = mix(c, c * 0.85 + uSkyHor * 0.12, uOvercast * 0.3);
  gl_FragColor = vec4(c, 1.0); }`,
    });
    // the clouds move in the shader, so three cannot cull them; drawn early (after the dome, renderOrder -10), no shadow map
    im.frustumCulled = false; im.castShadow = false; im.receiveShadow = false; im.renderOrder = -5;
    return im;
  }

  // ==================================================================================================== geometry helpers
  // M4: a matrix from a position, Euler angles (rad) and a scale (sy and sz default to sx)
  const M4 = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) => new THREE.Matrix4().compose(V3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V3(sx, sy, sz));
  // merge parts {g, m, c, part, x} into one indexed geometry: position, normal, color, aPart, aX (a free vec4 per part).
  // g = a geometry (cloned, then moved by the matrix m), c = its colour (sRGB hex), part = the id the village shader paints
  // by, x = the free vec4. One geometry means one draw call for a whole house or for every prop in the valley.
  function merge(parts) {
    let nv = 0, ni = 0; const gs = parts.map(p => { const g = p.g.clone(); if (p.m) g.applyMatrix4(p.m); nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; return g; });
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), prt = new Float32Array(nv), ax = new Float32Array(nv * 4), idx = new Uint32Array(ni), c = new THREE.Color();
    let ov = 0, oi = 0;
    gs.forEach((g, k) => { const pa = g.attributes.position, na = g.attributes.normal, n = pa.count, p = parts[k], x = p.x || [0, 0, 0, 0]; c.set(p.c || '#ffffff');
      pos.set(pa.array.subarray(0, n * 3), ov * 3); nor.set(na.array.subarray(0, n * 3), ov * 3);
      for (let i = 0; i < n; i++) { const v = ov + i; col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; prt[v] = p.part || 0; ax[v * 4] = x[0]; ax[v * 4 + 1] = x[1]; ax[v * 4 + 2] = x[2]; ax[v * 4 + 3] = x[3]; }
      if (g.index) for (let i = 0; i < g.index.count; i++) idx[oi++] = g.index.getX(i) + ov; else for (let i = 0; i < n; i++) idx[oi++] = ov + i;
      ov += n; g.dispose(); });
    const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3)); out.setAttribute('aPart', new THREE.BufferAttribute(prt, 1)); out.setAttribute('aX', new THREE.BufferAttribute(ax, 4));
    out.setIndex(new THREE.BufferAttribute(idx, 1)); out.computeBoundingSphere(); return out;
  }
  // shorthands: a box (width, height, depth) and a cylinder (top radius, bottom radius, height, sides), centred on the origin
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d), cyl = (rt, rb, h, s = 8) => new THREE.CylinderGeometry(rt, rb, h, s);
  // a round beam between two points (a part for merge())
  const beam = (a, b, r, c, part = 0, seg = 6) => { const d = V3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), L = d.length(); const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.normalize());
    return { g: cyl(r, r, L, seg), m: new THREE.Matrix4().compose(V3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, V3(1, 1, 1)), c, part }; };
  // the house body: a soft superellipse prism (cob walls), slightly drawn in at the top. The outline is
  // |x / hx|^4 + |z / hz|^4 = 1 (x = hx sign(cos a) sqrt|cos a|), walls from the floor (2.5 m) to 4.95 m, 3% narrower at the top;
  // the normal is the gradient of that curve. Open at top and bottom: the floor and the roof cover them.
  function bodyGeo() { const H = V.HOUSE, n = 64, rows = [2.5, 3.2, 4.2, 4.95], pos = [], nor = [], idx = [];
    for (let j = 0; j < rows.length; j++) { const y = rows[j], k = 1 - .03 * (y - 2.5) / 2.45;
      for (let i = 0; i <= n; i++) { const a = i / n * TAU, ca = Math.cos(a), sa = Math.sin(a), x = H.body.hx * k * Math.sign(ca) * Math.sqrt(Math.abs(ca)), z = H.body.hz * k * Math.sign(sa) * Math.sqrt(Math.abs(sa));
        const nx = x ** 3 / H.body.hx ** 4, nz = z ** 3 / H.body.hz ** 4, l = Math.hypot(nx, nz) || 1; pos.push(x, y, z); nor.push(nx / l, .03, nz / l); } }
    for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i, b = a + n + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setIndex(idx); return g; }
  // a tube round an ellipse (the felt eave of a hush-roof): radii rx, rz at height y, tube radius tr (85% of it in height)
  function ellipseTube(rx, rz, y, tr, n = 72, m = 10) { const pos = [], nor = [], idx = [];
    for (let i = 0; i <= n; i++) { const a = i / n * TAU, cx = Math.cos(a) * rx, cz = Math.sin(a) * rz; const tx = -Math.sin(a) * rx, tz = Math.cos(a) * rz, tl = Math.hypot(tx, tz); const ox = tz / tl, oz = -tx / tl;
      for (let j = 0; j <= m; j++) { const b = j / m * TAU, cb = Math.cos(b), sb = Math.sin(b); pos.push(cx + ox * cb * tr, y + sb * tr * .85, cz + oz * cb * tr); nor.push(ox * cb, sb, oz * cb); } }
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { const a = i * (m + 1) + j, b = a + m + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setIndex(idx); return g; }

  // ==================================================================================================== village shaders
  // One cel shader paints the whole village (houses, roofs, cloth, bells, masts, cisterns, channels, the bench), so it costs one
  // program and one ink program. Each vertex carries aPart (what it is) and aX (a free vec4: pivots and times for what moves);
  // houses carry per-instance colours. Parts:
  //   0 wood  1 planks  2 cob wall  3 dark wood  5 cupola moss  6 brass  |  10 roof moss  11 felt eave  12 eave underside
  //   20 door curtain  21 bell sleeve  22 bell  |  30 stone/wood  31 channel trough  32 cistern clay  33 cistern water  34 bronze bar
  // The shaders test parts with ranges (vPart > 19.5 && vPart < 20.5 is part 20), since a float attribute is not exact.
  // GUST_GLSL: the gust envelope gustK (FILM.path GLSL) and GLSL copies of FILM.anim.ring and gustDelay.
  const GUST_GLSL = /* glsl */`
${P.GLSL}
// the ring-out of a damped spring pushed at t0 (f Hz, damping ratio z): FILM.anim.ring
float wRing(float t, float t0, float f, float z){ float x = t - t0; if (x < 0.0) return 0.0; float w = 6.2831853 * f; return exp(-z * w * x) * sin(w * sqrt(1.0 - z * z) * x); }
// M16: seconds until the gust front reaches world x (FILM.world.gustDelay)
float wDelay(float x){ return max(0.0, (x - (${WEST_X.toFixed(3)})) / 18.0); }`;
  // per-house values in the vertex shader (house position, a seed, the M16 delay, the wind in house-local axes)
  const INST = /* glsl */`
#ifdef USE_INSTANCING
  vec3 hX = instanceMatrix[3].xyz; mat3 hM = mat3(instanceMatrix);
#else
  vec3 hX = vec3(0.0); mat3 hM = mat3(1.0);
#endif
  float hSeed = fract(hX.x * 0.1371 + hX.z * 0.0713);
  float hDly = wDelay(hX.x);
  vec3 hWind = normalize(transpose(hM) * vec3(1.0, 0.0, 0.15));`;
  // the cloud shadow on anything drawn with E.toon (an fpre hook): a shadow leaves 20% of the sun
  const CLOUD_PRE = /* glsl */`lightK *= 1.0 - 0.8 * cloudShadowAt(vWP.xz);`;
  // moss as painted cushions: rounded clumps lit on top with soft seams, lighter tufts and a few pale flowers (p in metres,
  // up = 0..1 how much the surface faces the sky)
  const MOSS_GLSL = /* glsl */`
vec3 mossPaint(vec2 p, float up){ float n = nz(p * 0.21), m = nzA(p * 0.6 + 3.7), cl = cells(p * 0.5);
  vec3 c = mix(vec3(0.2, 0.35, 0.09), vec3(0.3, 0.48, 0.12), smoothstep(0.42, 0.46, n + (m - 0.5) * 0.3));   // two-tone clumps, crisp
  c = mix(c, vec3(0.45, 0.62, 0.17), smoothstep(0.6, 0.63, n * 0.6 + m * 0.4 + cl * 0.22) * up);              // lit cushion crowns
  c = mix(c, c * 0.8, (1.0 - smoothstep(0.0, 0.06, cl)) * 0.5);                                                // a hint of the clumps' seams
  c = mix(c, vec3(0.94, 0.88, 0.62), step(0.993, h12(floor(p * 6.0))) * up);                                    // tiny pale flowers
  return c; }`;
  // the village material (E.toon options). The vertex hook moves what moves; P0 is the vertex's rest position in the house's
  // own frame (x along the ridge, z out through the door, y up from the ground). The fragment hook paints each part.
  // Per-house instance attributes: aTint (wall plaster), aFelt (roof and curtain felt), aSlv (sleeve felt),
  // aRB = (the time its bell rings, the time its sleeve comes off), 1e4 for houses whose bell stays silent.
  const VILLAGE = {
    vcol: true, rim: .25, paint: .1,
    vpars: GUST_GLSL + 'attribute float aPart; attribute vec4 aX; attribute vec3 aTint, aFelt, aSlv; attribute vec2 aRB; varying float vPart; varying vec4 vX; varying vec3 vTint, vFelt;',
    vdeform: INST + /* glsl */`
  vPart = aPart; vX = aX; vTint = aTint; vFelt = aPart > 20.5 && aPart < 21.5 ? aSlv : aFelt;
  float g = gustK(uTime - hDly);
  if (aPart > 19.5 && aPart < 20.5) {          // door curtain: hinged at its rod, idle sway, then the snap and the long flutter (M16)
    // hang: 0 at the rod (4.32 m) .. 1 at the hem 1.8 m below; snap: the M16 ring, the same as FILM.world.snap; g: the gust
    float hang = clamp((4.32 - P0.y) / 1.8, 0.0, 1.0), hk = pow(hang, 1.5), snap = wRing(uTime, 36.0 + hDly, 2.1, 0.16);
    float idle = 0.03 * sin(uTime * 1.7 + hSeed * 6.28 + P0.x * 1.3) + 0.018 * sin(uTime * 3.1 + hSeed * 11.0 + P0.x * 2.0);
    float flut = sin(uTime * 13.0 + P0.x * 4.0 + hSeed * 9.0 + hang * 3.0) * 0.07 * g;
    transformed.z += hk * (idle + abs(snap) * 0.75 + g * 0.42 + flut);
    transformed.x += hk * (hWind.x * (snap * 0.35 + g * 0.3) + flut * 0.6);
    transformed.y += hk * hk * (abs(snap) * 0.3 + g * 0.18);
  } else if (aPart > 20.5 && aPart < 21.5) {   // bell sleeve: the hem lifts and streams with the wind; off from aRB.y on the ringing cupolas
    float hang = clamp((8.06 - P0.y) / 0.68, 0.0, 1.0); hang *= hang; float snap = wRing(uTime, 36.0 + hDly, 2.4, 0.15);
    float fl = sin(uTime * 15.0 + hSeed * 7.0 + atan(P0.z, P0.x) * 2.0) * 0.05 * g;
    transformed.xz += hWind.xz * hang * (0.28 * g + 0.22 * snap + fl) + normalize(P0.xz + 1e-4) * hang * abs(snap) * 0.08;
    transformed.y += hang * abs(snap) * 0.08;
    if (uTime > aRB.y) transformed = vec3(0.0, 7.7, 0.0);   // taken off: the sleeve shrinks to a point inside the cupola
  } else if (aPart > 21.5 && aPart < 22.5) {   // bell: swings when it rings (33.0 on the four cupolas), trembles in the gust
    float ang = 0.42 * wRing(uTime, aRB.x, 1.15, 0.09) + 0.05 * g * sin(uTime * 7.0 + hSeed * 9.0);
    // rotate round the x axis through the pivot at 8.1 m (where it hangs in the cupola)
    vec3 pv = vec3(0.0, 8.1, 0.0), q = transformed - pv; float ca = cos(ang), sa = sin(ang);
    transformed = pv + vec3(q.x, q.y * ca - q.z * sa, q.y * sa + q.z * ca);
  } else if (aPart > 33.5) {                    // bronze bar: swings round its cord (rings at aX.w), streams in the gust
    // aX.xyz = its pivot on the cord, 10 cm above the bar (world space); it swings round the z axis there
    float gb = gustK(uTime - wDelay(aX.x)), sd = fract(aX.x * 0.37 + aX.z * 0.71);
    float ang = 0.22 * wRing(uTime, aX.w, 1.6, 0.06) + gb * (0.35 + 0.12 * sin(uTime * 9.0 + sd * 20.0)) + 0.03 * sin(uTime * 1.3 + sd * 6.0);
    vec3 q = transformed - aX.xyz; float ca = cos(ang), sa = sin(ang); transformed = aX.xyz + vec3(q.x * ca - q.y * sa, q.x * sa + q.y * ca, q.z);
  } else if (aPart > 32.5) {                    // cistern water rises to the lip at its overflow time
    // aX = (overflow time, resting level, lip level): it climbs during the 2.5 s before the overflow
    transformed.y += mix(aX.y, aX.z, smoothstep(aX.x - 2.5, aX.x, uTime));
  }`,
    fpars: MAP_GLSL + MOSS_GLSL + 'varying float vPart; varying vec4 vX; varying vec3 vTint, vFelt;',
    fpre: CLOUD_PRE + /* glsl */`
  // o: the rest position in the part's own frame (the house frame for houses, world space for the props); az: angle round it
  vec3 o = vOP; float az = atan(o.z, o.x);
  if (vPart < 9.5) {
    if (vPart > 1.5 && vPart < 2.5) {
      // cob walls (part 2): brushed plaster, a timber band at the floor and under the eave, the door opening, round windows.
      // The five windows (one on each end, two at the front, one at the back) match the sills built in buildVillage().
      base *= vTint * (0.95 + 0.1 * nz(vec2(az * 1.3, o.y * 0.7)));
      base = mix(base, vec3(0.32, 0.2, 0.13), 1.0 - smoothstep(2.62, 2.66, o.y));
      base = mix(base, vec3(0.32, 0.2, 0.13), smoothstep(4.36, 4.4, o.y) * 0.9);
      base = mix(base, vec3(0.07, 0.04, 0.05), step(abs(o.x), 0.54) * step(o.y, 4.32) * step(1.5, o.z));
      vec2 wq = vec2(9.0);
      if (abs(o.x) > 2.2) wq = vec2(o.z, o.y - 3.7); else if (o.z > 1.8) wq = vec2(abs(o.x) - 1.55, o.y - 3.75); else if (o.z < -1.8) wq = vec2(o.x, o.y - 3.75);
      float rr = length(wq), glass = 1.0 - smoothstep(0.27, 0.285, rr), frame = (1.0 - smoothstep(0.33, 0.345, rr)) * (1.0 - glass);
      float lat = (1.0 - smoothstep(0.018, 0.03, min(abs(wq.x), abs(wq.y)))) * glass;
      base = mix(base, vec3(0.1, 0.08, 0.12) + vec3(0.06, 0.05, 0.02) * smoothstep(0.1, -0.2, wq.y), glass);
      base = mix(base, vec3(0.3, 0.19, 0.12), max(frame, lat));
      base = mix(base, vec3(0.42, 0.15, 0.07), glass * step(0.06, wq.y) * 0.85);       // felt shutter, rolled half down
    } else if (vPart < 1.5 && vPart > 0.5) { base *= 0.9 + 0.14 * step(0.5, fract(o.x * 2.6 + 0.3 * sin(o.z * 3.0)));   // planks
    } else if (vPart > 4.5 && vPart < 5.5) { base = mossPaint(o.xz * 3.0, 1.0); }                                      // cupola moss
  } else if (vPart < 19.5) {
    // the hush-roof: moss cushions over felt, a scalloped line where they meet; the quilted felt eave; its dark underside
    if (vPart < 10.5) {
      // yf: 0 at the eave (the roof ellipsoid's centre, 4.7 m) .. 1 at the top; scal: the wavy line where the moss starts
      float yf = (o.y - 4.7) / 2.5;
      float scal = 0.1 + 0.05 * sin(az * 9.0 + vFelt.r * 30.0) + 0.035 * sin(az * 23.0) + 0.05 * (nz(vec2(az * 0.6, 0.3)) - 0.5);
      float moss = smoothstep(scal - 0.012, scal + 0.012, yf);
      vec3 mossC = mossPaint(o.xz * 1.6 + vec2(o.y * 0.7, 0.0), smoothstep(0.2, 0.7, yf));
      vec3 feltC = vFelt * (0.92 + 0.1 * nz(vec2(az * 2.0, yf * 3.0)));
      base = mix(feltC, mossC, moss);
      base *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.025, abs(yf - scal))) * moss;
    } else if (vPart < 11.5) base = vFelt * (1.0 - 0.16 * (1.0 - smoothstep(0.02, 0.05, abs(fract(az * 18.0) - 0.5))));   // eave: quilting seams
    else base *= vFelt * 0.6;                                                                                              // eave underside
  } else if (vPart < 29.5) {
    if (vPart < 20.5) { base = vFelt; float bx = abs(o.x), by = o.y;       // felt door curtain: a darker border and ochre running stitches
      base = mix(base, base * 0.62 + vec3(0.05, 0.04, 0.0), clamp(step(0.42, bx) + step(by, 2.7) + step(4.18, by), 0.0, 1.0) * 0.8);
      base = mix(base, vec3(0.93, 0.86, 0.66), (1.0 - smoothstep(0.035, 0.05, abs(fract(by * 2.2) - 0.5) * bx * 6.0 + abs(bx - 0.25))) * 0.6);
    } else if (vPart < 21.5) { base = vFelt; float q = abs(fract(az * 2.2 + o.y * 3.0) - 0.5) + abs(fract(az * 2.2 - o.y * 3.0) - 0.5);   // quilted sleeve
      base = mix(base, base * vec3(0.3, 0.32, 0.55), (1.0 - smoothstep(0.03, 0.07, abs(q - 0.5))) * 0.8);
      base = mix(base, vec3(0.08, 0.1, 0.25), (1.0 - smoothstep(7.43, 7.46, o.y)) * 0.8);
    } else base = vec3(0.69, 0.37, 0.05);                                                                    // the bronze bell
  } else {
    // the props (parts 30-34), painted in world space
    vec3 ow = vWP;
    if (vPart > 30.5 && vPart < 31.5) {           // trough: the flood runs down it from 75.8
      float fl = smoothstep(75.8, 76.6, uTime) * (1.0 - smoothstep(82.0, 88.0, uTime) * 0.6);
      float sn = smoothstep(0.5, 0.6, nz(vec2(ow.x * 0.3 + ow.z * 0.3, uTime * 1.5 - ow.y * 0.4)));
      base = mix(base, mix(vec3(0.25, 0.6, 0.68), vec3(0.85, 0.97, 1.0), sn), fl * 0.85);
    } else if (vPart > 31.5 && vPart < 32.5) {    // clay: grain, wet runs after the overflow
      base *= 0.9 + 0.12 * nz(ow.xz * 1.3 + ow.y * 0.6);
      float ov = smoothstep(vX.x, vX.x + 0.6, uTime), run = smoothstep(0.45, 0.6, nz(vec2(atan(ow.z, ow.x) * 40.0, ow.y * 0.25 + 0.1 * uTime)));
      base *= mix(1.0, 0.68, ov * (0.5 + 0.5 * run));
    } else if (vPart > 32.5 && vPart < 33.5) { N = vec3(0.0, 1.0, 0.0); }                                   // water: lit as level
  }`,
    // after lighting: cistern water mirrors the sky with faint moving rings; metal (bell, bronze bars, the brass knob) gets a
    // hard highlight and a sheen at its edges; wet clay shines once its cistern has overflowed
    fpost: /* glsl */`
  if (vPart > 32.5 && vPart < 33.5) { vec3 Rr = reflect(-V, vec3(0.0, 1.0, 0.0)); c = mix(c, skyAt(Rr) * 0.9, 0.45 * pow(1.0 - max(V.y, 0.0), 2.0) + 0.15);
    c = mix(c, vec3(0.9, 0.97, 1.0), (1.0 - smoothstep(0.02, 0.05, abs(fract(length(vWP.xz - floor(vWP.xz)) * 3.0 - uTime * 0.8) - 0.5))) * 0.1); }
  else if ((vPart > 21.5 && vPart < 22.5) || vPart > 33.5 || (vPart > 5.5 && vPart < 6.5)) { vec3 Hh = normalize(uSunDir + V);
    c += uSunCol * (smoothstep(0.9, 0.93, dot(N, Hh)) * 0.85 + 0.22 * smoothstep(0.6, 0.66, 1.0 - max(dot(N, V), 0.0))); }
  else if (vPart > 31.5 && vPart < 32.5) { vec3 Hh = normalize(uSunDir + V); c += uSunCol * smoothstep(vX.x, vX.x + 0.6, uTime) * 0.5 * smoothstep(0.9, 0.93, dot(N, Hh)); }`,
  };
  const villageMat = () => E.toon(VILLAGE);   // the same source every time: one shared program

  // ==================================================================================================== the village
  const FELT = ['#C98B2E', '#2F3E7A', '#6F8A4A', '#CDB892', '#9E4E2E', '#B8613A'];   // roof and curtain felts to pick from
  const meshes = {};
  const INK_WOOD = '#3a2620', INK_MOSS = '#203018';                                  // outline colours
  // Every house in FILM.valley.houses is an instance of two meshes (the house, the roof), placed by its position, turn and
  // size; per-house colours and bell times are instance attributes. Pell's house has persimmon felt, the Listeners' hut
  // plain brown.
  function buildVillage(scene) {
    const H = V.HOUSE, hs = V.houses, N = hs.length, r = A.named('world-houses');
    // the four toll-cupolas that ring at 33.0: the same rule as FILM.valley.cupolas, whose positions events.js uses as the
    // sources of their tolls, so the two lists must stay in step
    const cupH = hs.filter(h => h.k >= 6 && !h.hut && !h.pell).sort((a, b) => b.th - a.th).slice(0, 4);
    const mats = hs.map(h => new THREE.Matrix4().compose(V3(...h.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, h.rot, 0)), V3(h.size, h.size, h.size)));
    const felt = hs.map(h => h.pell ? '#E4572E' : h.hut ? '#7A6448' : FELT[Math.floor(r() * FELT.length)]);
    const tint = hs.map(h => h.hut ? '#CFC6B6' : ['#F4E7CF', '#FFF6E8', '#EDE3D6', '#F7EBDA'][Math.floor(r() * 4)]);
    const sleeve = hs.map(() => ['#C98B2E', '#D9A85B', '#B8613A', '#2F3E7A'][Math.floor(r() * 4)]);
    // per(): one instance attribute from a list (f maps an item to its numbers); perHouse(): every attribute a house needs
    // (aRB: the bell rings at 33.0 + 0.09 i and the sleeve comes off at 30.5 on the four cupolas, never elsewhere)
    const per = (geo, name, list, f) => { const k = f(list[0]).length, a = new Float32Array(list.length * k); list.forEach((v, i) => a.set(f(v, i), i * k)); geo.setAttribute(name, new THREE.InstancedBufferAttribute(a, k)); };
    const rgb = c => { const k = new THREE.Color(c); return [k.r, k.g, k.b]; };
    const perHouse = geo => { per(geo, 'aTint', tint, c => rgb(c)); per(geo, 'aFelt', felt, c => rgb(c)); per(geo, 'aSlv', sleeve, c => rgb(c));
      per(geo, 'aRB', hs, h => { const i = cupH.indexOf(h); return i < 0 ? [1e4, 1e4] : [33.0 + i * .09, 30.5]; }); };
    // inst(): an InstancedMesh of one merged geometry, one instance per house, with its ink outline
    const inst = (geo, line) => { const im = new THREE.InstancedMesh(geo, villageMat(), N); mats.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); E.outline(im, line); scene.add(im); return im; };

    // ---- 1. the house: stilts, platform, cob walls, door frame, ladder, braces, sills, the cupola frame and cap; the door curtain,
    //         the cupola's quilted sleeve and its bronze bell
    //         (in the house's own frame: metres, y = 0 at the ground, the door on +z; see FILM.valley.HOUSE)
    const p = [];
    // six stilts, the plank platform (top at 2.5 m), the cob body
    for (const [lx, lz] of [[-2.45, -2.05], [0, -2.05], [2.45, -2.05], [-2.45, 2.05], [0, 2.05], [2.45, 2.05]]) p.push({ g: cyl(.12, .15, 2.55, 7), m: M4(lx, .975, lz), c: '#8A6446', part: 3 });
    p.push({ g: box(5.6, .3, 4.8), m: M4(0, 2.35, 0), c: '#8C6A4C', part: 1 });
    p.push({ g: bodyGeo(), c: '#F1E8D6', part: 2 });
    // the door frame and lintel, the landing, the ladder (two rails, five rungs), cross braces under the platform, window sills
    for (const sx of [-1, 1]) p.push({ g: box(.13, 1.95, .16), m: M4(sx * .6, 3.45, 2.2), c: '#6B4A36', part: 3 });
    p.push({ g: box(1.42, .16, .2), m: M4(0, 4.4, 2.22), c: '#6B4A36', part: 3 });
    p.push({ g: box(1.3, .1, .55), m: M4(0, 2.52, 2.58), c: '#8C6A4C', part: 1 });
    for (const sx of [-1, 1]) p.push(beam([sx * .34, -.1, 3.75], [sx * .34, 2.62, 2.75], .045, '#7A5A40', 3));
    for (let k = 1; k <= 5; k++) { const y = k * .45, z = 3.75 - (y + .1) / 2.72 * 1.0; p.push(beam([-.34, y, z], [.34, y, z], .03, '#7A5A40', 3)); }
    for (const sz of [-1, 1]) { p.push(beam([-2.45, .35, sz * 2.05], [0, 2.15, sz * 2.05], .05, '#7A5A40', 3)); p.push(beam([2.45, .35, sz * 2.05], [0, 2.15, sz * 2.05], .05, '#7A5A40', 3)); }
    for (const sx of [-1, 1]) p.push(beam([sx * 2.45, .35, -2.05], [sx * 2.45, 2.15, 2.05], .05, '#7A5A40', 3));
    for (const [x, y, z, a] of [[2.62, 3.7, 0, 0], [-2.62, 3.7, 0, Math.PI], [1.55, 3.75, 2.14, -Math.PI / 2], [-1.55, 3.75, 2.14, -Math.PI / 2], [0, 3.75, -2.21, Math.PI / 2]])
      p.push({ g: box(.16, .07, .78), m: M4(x, y - .4, z, 0, a, 0), c: '#6B4A36', part: 3 });
    // the toll-cupola on the roof: its base ring, cap, moss dome, brass knob, four posts
    p.push({ g: cyl(.62, .68, .24, 16), m: M4(0, 7.12, 0), c: '#7A5A40', part: 3 }, { g: cyl(.74, .74, .07, 16), m: M4(0, 8.13, 0), c: '#6B4A36', part: 3 },
      { g: new THREE.SphereGeometry(1, 16, 8, 0, TAU, 0, Math.PI / 2), m: M4(0, 8.15, 0, 0, 0, 0, .8, .46, .8), c: '#ffffff', part: 5 },
      { g: new THREE.SphereGeometry(.09, 8, 6), m: M4(0, 8.66, 0), c: '#D9A43A', part: 6 });
    for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + Math.PI / 4; p.push({ g: cyl(.045, .05, .95, 6), m: M4(Math.cos(a) * .5, 7.67, Math.sin(a) * .5), c: '#6B4A36', part: 3 }); }
    // cloth and bell: a felt door curtain (a thin slab, so the ink hull works), the quilted sleeve, the bell
    const crg = new THREE.BoxGeometry(1.04, 1.8, .05, 6, 12, 1); crg.translate(0, 3.42, 2.27);
    p.push({ g: crg, c: '#ffffff', part: 20 });
    p.push({ g: new THREE.LatheGeometry([[0, 8.12], [.12, 8.1], [.24, 8.02], [.3, 7.9], [.34, 7.7], [.38, 7.48], [.41, 7.4], [.39, 7.38]].map(q => new THREE.Vector2(q[0], q[1])), 16), c: '#ffffff', part: 21 });
    p.push({ g: new THREE.LatheGeometry([[0, 8.1], [.05, 8.08], [.1, 8.02], [.17, 7.92], [.21, 7.75], [.25, 7.6], [.3, 7.5], [.31, 7.46], [.26, 7.47], [0, 7.5]].map(q => new THREE.Vector2(q[0], q[1])), 14), c: '#ffffff', part: 22 });
    const hg = merge(p); perHouse(hg);
    meshes.house = inst(hg, { px: 1.7, max: .05, color: INK_WOOD });

    // ---- 2. the hush-roof: exactly the upper half of the roof ellipsoid (so FILM.valley.roofY is true), moss over felt;
    //         the felt eave (the roof's thickness) and its underside. Its own mesh only for its moss-dark ink.
    const rg = merge([{ g: new THREE.SphereGeometry(1, 56, 20, 0, TAU, 0, Math.PI / 2), m: M4(0, H.roof.cy, 0, 0, 0, 0, H.roof.rx, H.roof.ry, H.roof.rz), part: 10 },
      { g: ellipseTube(H.roof.rx - .06, H.roof.rz - .06, H.roof.cy - .08, .21), part: 11 },
      { g: new THREE.CircleGeometry(1, 48), m: M4(0, H.roof.cy - .2, 0, Math.PI / 2, 0, 0, H.roof.rx - .05, H.roof.rz - .05, 1), c: '#5a4a50', part: 12 }]);
    perHouse(rg);
    meshes.roof = inst(rg, { px: 1.9, max: .06, color: INK_MOSS });
    meshes.cupHouses = cupH;
  }

  // ---- masts, bronze bars, stones, spill-channels, the Listeners' bench and the cisterns: one static mesh in the village shader
  //      (an InstancedMesh of one, so it shares the houses' program). aX carries what moves.
  function buildProps(scene) {
    const P0 = [], strips = [], r = A.named('world-props');
    // -- masts (FILM.valley.masts: one per terrace, the three chime masts, the Spillway mast): stones round the foot, the pole,
    //    a cross-bar (cbY) with the bronze bars hanging from it in a row round the bowl (tx, tz = that direction), and a
    //    knob on top (red on the chime masts) or, on the Spillway mast, Pell's platform and climbing pegs
    V.masts.forEach((m, mi) => {
      const [x, y, z] = m.pos, h = m.h, rad = Math.hypot(x, z), tx = -z / rad, tz = x / rad, ry = Math.atan2(tx, tz);
      for (let k = 0; k < 5; k++) { const a = k / 5 * TAU + r(), px = x + Math.cos(a) * .34, pz = z + Math.sin(a) * .34; P0.push({ g: new THREE.DodecahedronGeometry(.22 + r() * .1, 0), m: M4(px, V.ground(px, pz) + .05, pz, r(), r(), r()), c: '#A89A88', part: 30 }); }
      P0.push({ g: cyl(.1, .16, h + .3, 10), m: M4(x, y + h / 2 - .15, z), c: '#B08A5A', part: 30 });
      const cbY = m.spill ? y + 10.9 : y + h - .45;
      P0.push({ g: box(1.7, .1, .1), m: M4(x, cbY, z, 0, ry - Math.PI / 2, 0), c: '#8A6446', part: 30 });
      if (m.spill) {   // the platform Pell stands on (its top is exactly mast + 12) and the pegs she climbs
        P0.push({ g: cyl(.46, .4, .14, 16), m: M4(x, y + h - .07, z), c: '#8A6446', part: 30 });
        P0.push({ g: new THREE.TorusGeometry(.44, .035, 6, 20), m: M4(x, y + h - .02, z, Math.PI / 2, 0, 0), c: '#6B4A36', part: 30 });
        for (let k = 0; k < 24; k++) P0.push({ g: cyl(.032, .032, .66, 6), m: M4(x, y + .7 + k * .45, z, Math.PI / 2, 0, (k % 2 ? .12 : -.12)), c: '#7A5A40', part: 30 });
      } else P0.push({ g: new THREE.SphereGeometry(.2, 10, 6), m: M4(x, y + h + .1, z, 0, 0, 0, 1, .8, 1), c: m.chime != null ? '#C9572E' : '#C98B2E', part: 30 });
      const nb = m.spill ? 5 : 4;    // tuned bronze bars on cords (shorter = higher)
      // a cord, then the bar (part 34): aX = its pivot and the time it rings (the chime toll at 30.0 in FILM.events,
      // 0.05 s apart along the row); bars on the other masts never ring, they only stream in the gust
      for (let k = 0; k < nb; k++) { const off = (k - (nb - 1) / 2) * .34, L = .78 - k * .09, px = x + tx * off, pz = z + tz * off, py = cbY - .08;
        P0.push(Object.assign(beam([px, cbY, pz], [px, py - .1, pz], .01, '#3A2A2A'), { part: 30 }));
        P0.push({ g: cyl(.032, .032, L, 8), m: M4(px, py - .1 - L / 2, pz), c: '#D9A43A', part: 34, x: [px, py, pz, m.chime != null ? 30.0 + .05 * k : 1e4] }); }
      // one streamer per mast, from just under the top (built below)
      strips.push({ root: [x + tx * .1, m.spill ? y + h - .3 : y + h - .1, z + tz * .1], L: m.spill ? 3.4 : 2.4, seed: r(), col: ['#E4572E', '#2F3E7A', '#C98B2E', '#6F8A4A'][mi % 4] });
    });
    // -- spill-channels: stone curbs and a trough down each terrace, a chute frame on each wall. Seven channels at these
    //    angles; on terrace k they run from just past its inner wall (lo) to just before the next wall (hi) in 3 m pieces
    //    (at(rr, lat): the point at radius rr, lat metres to the side of the channel's centre line)
    [-2.95, -2.2, -1.18, .62, 1.25, 2.0, 2.65].forEach(th => { const w = V.wob(th), R = k => 40 + 16.5 * k + w * (.5 + k / 9), B = k => 40 + .5 * w + 16.5 * k, c = Math.cos(th), s = Math.sin(th);
      const at = (rr, lat) => [c * rr - s * lat, s * rr + c * lat], ry = Math.PI / 2 - th;
      for (let k = 1; k <= 9; k++) { const lo = Math.max(R(k - 1), B(k - 1)) + .7, hi = k < 9 ? Math.max(B(k), R(k) - .27) - .1 : R(9) - .4;
        for (let u = lo; u < hi - .5; u += 3.1) { const ue = Math.min(hi, u + 3), mid = (u + ue) / 2, len = ue - u;
          for (const lat of [-.48, .48]) { const q = at(mid, lat); P0.push({ g: box(.26, .26, len), m: M4(q[0], V.ground(q[0], q[1]) + .1, q[1], 0, ry, 0), c: r() < .5 ? '#BCAE96' : '#A99C88', part: 30 }); }
          const q = at(mid, 0); P0.push({ g: box(.72, .04, len), m: M4(q[0], V.ground(q[0], q[1]) + .015, q[1], 0, ry, 0), c: '#8E8274', part: 31 }); }
        if (k < 9) { const wr = Math.max(B(k), R(k) + .2); for (const lat of [-.5, .5]) { const q = at(wr, lat); P0.push({ g: box(.3, 3.3, .5), m: M4(q[0], 3.2 * k + 1.6, q[1], 0, ry, 0), c: '#B3A48E', part: 30 }); } } } });
    // -- the Listeners' bench: a rough slab on two blocks, seat top at bench + 0.45 (Pell sits there in S17)
    { const b = V.places.spillway.bench, th = Math.atan2(b[2], b[0]), tx = -Math.sin(th), tz = Math.cos(th), ry = Math.atan2(tx, tz);
      P0.push({ g: box(.62, .16, 2.3), m: M4(b[0], b[1] + .37, b[2], 0, ry, 0), c: '#B7AA96', part: 30 });
      for (const o of [-.8, .8]) { const x = b[0] + tx * o, z = b[2] + tz * o, g = V.ground(x, z), top = b[1] + .29; P0.push({ g: box(.5, top - g + .3, .42), m: M4(x, (top + g - .3) / 2, z, 0, ry, 0), c: '#A49784', part: 30 }); }
      for (let k = 0; k < 3; k++) { const a = r() * TAU, d = 1.4 + r(), x = b[0] + Math.cos(a) * d, z = b[2] + Math.sin(a) * d; P0.push({ g: new THREE.DodecahedronGeometry(.25 + r() * .2, 0), m: M4(x, V.ground(x, z) + .05, z, r(), r(), r(), 1, .7, 1), c: '#A89A88', part: 30 }); } }
    // -- cisterns: the seven of Cistern Row (they overflow in a chain from 76.6) and a few by the houses
    //    (every third house, beside it where the ground is level with its stilts; each overflows 0.4-0.8 s after its
    //    terrace has filled). t = the overflow time.
    const cs = V.cisterns.map((c, i) => ({ pos: c.pos, size: c.size, t: 76.6 + i * .35 }));
    V.houses.forEach((h, i) => { if (h.hut || h.pell || i % 3) return; const q = V.houseToWorld(h, 3.6 * h.size, 0, 1.2 * h.size), g = V.ground(q[0], q[2]); if (Math.abs(g - h.pos[1]) > .25) return;
      cs.push({ pos: [q[0], g, q[2]], size: .75 + r() * .2, t: 76.2 + .5 * (9 - h.k) + .4 + r() * .4 }); });
    // the bell-shaped clay body as a lathe profile [radius, height] (1.58 m tall at size 1), then per cistern: the body,
    // the pale rim, two dark bands, and the water disc (part 33: aX = overflow time, resting level, lip level)
    const prof = [[0, 0], [.6, 0], [.68, .06], [.76, .3], [.79, .6], [.76, .9], [.67, 1.13], [.57, 1.32], [.52, 1.44], [.56, 1.5], [.61, 1.54], [.59, 1.58], [.5, 1.57], [.47, 1.5], [.45, 1.0]].map(q => new THREE.Vector2(q[0], q[1]));
    const lathe = new THREE.LatheGeometry(prof, 22);
    cs.forEach(c => { const m = M4(c.pos[0], c.pos[1] - .05, c.pos[2], 0, r() * TAU, 0, c.size), at = (g, mm) => new THREE.Matrix4().multiplyMatrices(m, mm);
      P0.push({ g: lathe, m, c: '#B9714A', part: 32, x: [c.t, 0, 0, 0] });
      P0.push({ g: cyl(.695, .735, .13, 22), m: at(null, M4(0, 1.04, 0)), c: '#E9D7B0', part: 32, x: [c.t, 0, 0, 0] });
      for (const [yy, rr] of [[.965, .738], [1.115, .69]]) P0.push({ g: new THREE.TorusGeometry(rr, .014, 4, 24), m: at(null, M4(0, yy, 0, Math.PI / 2, 0, 0)), c: '#5A2A18', part: 32, x: [c.t, 0, 0, 0] });
      P0.push({ g: new THREE.CircleGeometry(.5, 20).rotateX(-Math.PI / 2), m, c: '#3E8FA8', part: 33, x: [c.t, 1.36 * c.size, 1.52 * c.size, 0] }); });
    meshes.cisterns = cs;
    const im = new THREE.InstancedMesh(merge(P0), villageMat(), 1); im.setMatrixAt(0, new THREE.Matrix4()); im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere(); E.outline(im, { px: 1.6, max: .04, color: INK_WOOD }); scene.add(im); meshes.props = im;
    // -- streamers: felt ribbons rebuilt in the vertex shader from their root (a pure function of time and the wind).
    //    Each strip is SEG + 1 pairs of vertices, all sitting at the root: aRoot = (root xyz, length), aU = (0..1 along it,
    //    -1 / +1 for its two edges, seed). The shader lays them out, so the bounding sphere is set by hand.
    const SEG = 20, pos = [], aR = [], aU = [], col = [], idx = [], cc = new THREE.Color();
    strips.forEach(s => { const b = pos.length / 3; cc.set(s.col);
      for (let i = 0; i <= SEG; i++) for (const v of [-1, 1]) { pos.push(...s.root); aR.push(...s.root, s.L); aU.push(i / SEG, v, s.seed); col.push(cc.r, cc.g, cc.b); }
      for (let i = 0; i < SEG; i++) { const a = b + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } });
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); sg.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0), 3));
    sg.setAttribute('aRoot', new THREE.Float32BufferAttribute(aR, 4)); sg.setAttribute('aU', new THREE.Float32BufferAttribute(aU, 3)); sg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); sg.setIndex(idx);
    sg.boundingSphere = new THREE.Sphere(V3(120, 30, -60), 200);
    // The ribbon runs in E.toon's vnormal hook, before three's normal chunks, so it can set objectNormal; vdeform then
    // moves the vertex to rbP. No outline (line: false): the ribbons are too thin for an ink hull.
    const ribbon = /* glsl */`
  // wind: a breeze that comes and goes plus the gust (reaching this mast after its M16 delay). In calm the ribbon hangs
  // down; as the wind rises it streams along the wind. A wave runs down it (ph); the edges sit 8.5 cm either side of
  // the centre line, narrowing toward the tail.
  float u = aU.x, vv = aU.y, sd = aU.z, Lr = aRoot.w;
  float g = gustK(uTime - wDelay(aRoot.x));
  float wind = clamp(0.35 + 0.18 * sin(uTime * 0.55 + sd * 7.0) + 0.12 * sin(uTime * 1.9 + sd * 3.0) + g * 1.1, 0.0, 1.4);
  vec3 dirW = normalize(vec3(1.0, -0.12 + 0.1 * sin(uTime * 0.8 + sd * 5.0), 0.28));
  vec3 dir = normalize(mix(vec3(0.05, -1.0, 0.0), dirW, smoothstep(0.0, 0.9, wind)));
  vec3 side = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.0, 1e-3)), upv = normalize(cross(side, dir));
  float ph = uTime * (4.0 + 9.0 * wind) - u * 8.0 + sd * 6.28;
  rbP = aRoot.xyz + dir * u * Lr + side * sin(ph) * 0.2 * u * (0.3 + wind) + upv * (cos(ph * 0.7) * 0.1 * u * wind + vv * 0.085 * (1.0 - 0.55 * u));
  objectNormal = normalize(side + upv * 0.3 * cos(ph));`;
    meshes.streamers = E.mesh(sg, E.toon({ vcol: true, rim: .3, paint: .08, side: THREE.DoubleSide, vpars: GUST_GLSL + 'attribute vec4 aRoot; attribute vec3 aU; vec3 rbP;',
      vnormal: ribbon, vdeform: 'transformed = rbP;', fpars: MAP_GLSL, fpre: CLOUD_PRE }), { line: false, cast: true });
    meshes.streamers.frustumCulled = false; scene.add(meshes.streamers);
  }

  // ==================================================================================================== FILM.world: API, build steps, update
  const W = F.world = {
    sunOverride: null,          // a shot may set { dir: [x, y, z], col?: '#hex', k?: number } (applied in update and again after the camera)
    fieldShadeK: null,          // override the strength of the rain-field's dappled light (null = by time)
    // the ground height, the cloud shadows (JS and GLSL), the gust delay, the lighting key, the built meshes, the clouds
    groundAt, cloudShadow, CLOUD_GLSL, MAP_GLSL, gustDelay, light, meshes, clouds: CL,
    // the M16 chain snap at world x: an impulse that rings out, and the delayed gust envelope (for any cloth in the valley)
    snap: (x, t) => A.ring(t, 36 + gustDelay(x), 2.1, .16),
    blow: (x, t) => P.gust(t - gustDelay(x)),
    wetAt: (x, z, t) => EV.wetAt(x, z, t),
    // the loading steps, run in order by main.js: [the label on the loading screen (the film's UI is Korean), the work]
    steps(scene) {
      return [
        // 1. the ground: the world map and the skyline texture, then the terrain mesh with its two painters
        ['골짜기 땅을 다지는 중', () => {
          const T0 = performance.now(); buildMap(); WU.tSkyline.value = skylineTex(); const T1 = performance.now();
          // one terrain material: white base (the painter sets the colour), no rim light, a faintly lilac shade, and no
          // E.toon fog (TER_POST does its own aerial perspective); vZone carries the aZone attribute to the fragment
          const tm = (pre, post) => E.toon({ color: '#ffffff', rim: 0, paint: .1, soft: .03, shade: '#f2f0ff', fog: 0, uniforms: WU,
            vpars: 'attribute float aZone; varying float vZone;', vdeform: 'vZone = aZone;', fpars: TER_PARS, fpre: pre, fpost: post });
          // two painters (the bowl, the land past the rim): one shader with both compiles far slower than the two apart
          const tg = terrainGeo(), T2 = performance.now(); W.bootMs = { skyline: Math.round(T1 - T0), terrain: Math.round(T2 - T1) };
          const t = new THREE.Mesh(tg, [tm(TER_BOWL, TER_POST_WET), tm(TER_OUTER, TER_POST)]); t.receiveShadow = true; t.castShadow = false; t.frustumCulled = false; scene.add(t); meshes.terrain = t; }],
        // 2. the sky: the dome (4.5 km, seen from inside, pinned to the far plane and writing no depth, so everything draws
        //    over it), the clouds, and the pond (a disc 8 m wider than the pond, cut to its edge in the shader; the polygon
        //    offset pulls it toward the camera so it wins over the terrain at the water line)
        ['하늘을 칠하는 중', () => {
          const dome = new THREE.Mesh(new THREE.SphereGeometry(4500, 48, 24), new THREE.ShaderMaterial({ uniforms: Object.assign({}, U, WU), side: THREE.BackSide, depthWrite: false,
            vertexShader: /* glsl */`varying vec3 vD; void main(){ vD = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.99999; }`,
            fragmentShader: DOME_FS }));
          dome.renderOrder = -10; dome.frustumCulled = false; scene.add(dome); meshes.dome = dome;
          meshes.clouds = cloudMesh(); scene.add(meshes.clouds);
          const pond = new THREE.Mesh(new THREE.CircleGeometry(V.R0 + 8, 96).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ uniforms: Object.assign({}, U, WU),
            vertexShader: 'varying vec3 vWP; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }', fragmentShader: POND_FS,
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
          scene.add(pond); meshes.pond = pond; }],
        // 3. the houses and roofs; 4. the masts, bars, channels, bench, cisterns and streamers
        ['마을을 세우는 중', () => buildVillage(scene)],
        ['종 기둥과 물독을 세우는 중', () => buildProps(scene)],
      ];
    },
    // every frame, before the shot: the lighting key into the uniforms, the per-moment switches, then the world map
    update(t) {
      // the sun: the shot's override if it set one, else the key; its colour is multiplied by the strength k
      const L = light(t), o = W.sunOverride;
      const sd = o && o.dir ? o.dir : L.sun; U.uSunDir.value.set(sd[0], sd[1], sd[2]).normalize();
      const k = (o && o.k) ?? L.sunK; if (o && o.col) U.uSunCol.value.set(o.col).multiplyScalar(k); else U.uSunCol.value.setRGB(L.sunCol[0] * k, L.sunCol[1] * k, L.sunCol[2] * k);
      // the sky, fog and light colours every material reads (FILM.U), then the world's own (cloud tones, haze, sky extras)
      U.uSkyTop.value.setRGB(...L.top); U.uSkyHor.value.setRGB(...L.hor); U.uSkyLow.value.setRGB(...L.low); WU.uSkyMid.value.setRGB(...L.mid);
      U.uFogCol.value.setRGB(...L.fogCol); U.uFog.value.set(L.fogD, L.fogH, 0, L.fogM);
      U.uBounce.value.setRGB(...L.bounce); U.uSkyFill.value.setRGB(...L.fill); U.uRimCol.value.setRGB(...L.rim);
      WU.cLit.value.setRGB(...L.cLit); WU.cMid.value.setRGB(...L.cMid); WU.cCore.value.setRGB(...L.cCore); WU.cGlow.value.setRGB(...L.cGlow); WU.uHaze.value.setRGB(...L.haze);
      WU.uHalo.value = L.halo; WU.uCirrus.value = L.cirrus; WU.uOvercast.value = L.overcast; WU.uMirror.value = L.mirror; WU.uSunVis.value = L.sunVis;
      // the gust's look (slate shadow, wind streaks) from 36 to 42 s, following the gust envelope; the rain of Act 1
      // (27.5-42 s) and of the fall (70-86 s); the field's dapple until the field falls (69-72 s); the wind vector other
      // modules read (a light breeze, strong in the gust)
      const g = P.gust(t); WU.uGustNow.value = sm(36, 36.8, t) * (1 - sm(41.2, 42, t)) * Math.min(1, g * 1.2);
      WU.uRain.value = Math.max(sm(27.5, 28.5, t) * (1 - sm(38, 42, t)), sm(70, 71, t) * (1 - sm(80, 86, t)));
      WU.uFieldK.value = W.fieldShadeK ?? (.42 * (1 - sm(69, 72, t)));
      U.uWind.value.set(1, 0, .15).normalize().multiplyScalar(.3 + 1.2 * g);
      drawMap();
    },
    // after the shot has placed the camera: a sun override set during the shot's update still lands on this frame
    // (main.js runs world.update before the shot). A colour without k gets the key's strength (sunK), as in update().
    afterCamera(t) {
      const o = W.sunOverride; if (!o || !o.dir) return;
      U.uSunDir.value.set(o.dir[0], o.dir[1], o.dir[2]).normalize();
      if (o.col) U.uSunCol.value.set(o.col).multiplyScalar(o.k ?? light(t).sunK);
      // move the shadow-casting light (E.sun) along the new direction, 3 shadow-frustum half widths from its target
      const sc = E.sun.shadow.camera, rr = sc.right; E.sun.position.copy(E.sun.target.position).addScaledVector(U.uSunDir.value, rr * 3); E.sun.shadow.needsUpdate = true;
      drawMap();   // the cloud shadows follow the sun
    },
  };

  // ==================================================================================================== test views
  // FILM.test.NAME(k, s) returns {cam, look} for view k at film time s.t (node tools/shot.mjs --test NAME --k ... --at T).
  // gradeLook: the colour grade of the shot playing at t (FILM.score.GRADE), so a test view looks like the film there.
  const gradeLook = (t, extra = {}) => { const S = F.score, sh = S.shotAt(t), g = S.GRADE[sh.id]; U.uShade.value.setRGB(1, 1, 1).lerp(new THREE.Color(g.shade), .55);
    return Object.assign({ lift: g.lift, gain: g.gain, sat: g.sat, th: g.th, ink: g.ink, bloom: .4, glow: .16, edge: .55, edgeFar: 160, vig: .28 }, extra); };
  F.test = F.test || {};
  // wide views of the bowl (pick the moment with --at: 8 noon, 31 after the toll, 40 gust, 77 green flood, 89 dusk)
  F.test.valley = (k, s) => {
    const VW = [
      { pos: [10, 50, 222], look: [20, 6, -80], fov: 44 },            // from the south rim over the pond to the village
      { pos: [-118, 17, 42], look: [190, 22, -6], fov: 40 },           // the west terraces (r = 125 m), toward the Spillway notch
      { pos: [150, 36, -100], look: [-40, 0, 70], fov: 46 },           // the toll terrace, across the bowl to the south-west
      { pos: [212, 37, -6], look: [40, 4, -40], fov: 42 },             // the Spillway shoulder looking back into the valley (S14 / S17)
      { pos: [70, 90, 110], look: [-10, 8, -70], fov: 48 },            // a high crane over the terraces
      { pos: [199, 31, 3], look: [520, -55, 12], fov: 44 },            // through the notch to the Hushlands
    ][k % 6];
    E.shadowFit(V3(40, 10, -60), 230);   // fit the shadow map over the whole bowl
    return { cam: VW, look: gradeLook(s.t) };
  };
  // the village close: houses, Pell's roof, the Spillway mast and hut, Cistern Row
  F.test.village = (k, s) => {
    const pr = V.places.pellRoof.house, sp = V.places.spillway, cr = V.places.cisternRow;
    let cam;
    if (k === 0) { const h = V.houses[18]; const c = V.houseToWorld(h, 0, 3, 0); const p = V.houseToWorld(h, -9, 5, 15); cam = { pos: p, look: c, fov: 40 }; E.shadowFit(V3(...c), 30); }
    else if (k === 1) { const c = V.houseToWorld(pr, .9, V.roofY(pr, .9, .7) + .5, .7); cam = { pos: V.houseToWorld(pr, 6, 9.5, 11), look: c, fov: 34 }; E.shadowFit(V3(...c), 18); }
    else if (k === 2) { const m = sp.mast, c = V.onTerrace(9, -.34, .55); cam = { pos: [c[0], c[1] + 5.5, c[2]], look: [m[0], m[1] + 5.5, m[2]], fov: 46 }; E.shadowFit(V3(m[0] - 10, m[1] + 4, m[2] - 12), 32); }   // the Listeners' hut, the bench and the Spillway mast
    else { const a = V.onTerrace(cr.k, lerp(cr.th0, cr.th1, .2), .62), b = V.onTerrace(cr.k, lerp(cr.th0, cr.th1, .75), .9); cam = { pos: [a[0], a[1] + 1.7, a[2]], look: [b[0], b[1] + 1.4, b[2]], fov: 44 }; E.shadowFit(V3(...b), 30); }
    return { cam, look: gradeLook(s.t) };
  };
  // the sky: cumulus from below (a low south terrace), the horizon towers from the south rim, toward the sun from the Spillway
  F.test.sky = (k, s) => {
    const VW = [{ pos: [0, 6, 60], look: [60, 220, -260], fov: 50 }, { pos: [-20, 40, 215], look: [-60, 160, -900], fov: 42 }, { pos: [190, 34, -30], look: [-300, 140, 300], fov: 55 }][k % 3];
    E.shadowFit(V3(40, 10, -60), 230);
    return { cam: VW, look: gradeLook(s.t) };
  };
})();
