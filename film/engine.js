// engine.js - the anime renderer on top of three.js: cel materials, ink lines, painted sky and clouds, refracting glass,
// the sun's shadows and the whole post chain. Every other module draws with it; nothing in it knows about the story.
//
// How it works
//   All materials are hand-written THREE.ShaderMaterials. They share the uniform objects in FILM.U: Object.assign copies
//   references to the same { value } boxes, so one write to FILM.U (the clock, the sun, the fog) reaches every material.
//   (A uniform added to FILM.U after a material was made does not reach that material.) The lighting is the film's own:
//   the cel shader reads uSunDir / uSunCol and borrows only three's shadow map, which is why it sets `lights: true`.
//   Colours are given as sRGB hex, THREE.Color turns them into linear light, every pass works in linear half-float
//   targets, and only the final pass turns the picture into sRGB.
//
// Public API at a glance (film/CONTRACT.md, "The engine", has the full option lists)
//   FILM.U            shared uniforms every material reads (clock, sun, sky, shadow tint, fog, noise texture)
//   E.COMMON          GLSL that declares FILM.U and gives nz nzA grain cells h12 tri3 skyAt fogApply
//   E.toon(opts)      cel material: two-tone light with hue-shifted shadows, crisp cast shadows, rim, hair band, paint grain
//   E.outline(mesh)   an inked line round a mesh (inverted hull, constant width on screen, capped in world units far away)
//   E.mesh(geo, mat, {cast, receive, line})   a mesh with shadows and an optional outline
//   E.cloud(opts)     the painted cumulus: three tones, glowing edge against the sun, soft dissolved rim
//   E.skyMat(opts)    the painted sky dome
//   E.glass(opts)     water and glass that bend what is behind them; the mesh goes on layer E.GLASS
//   E.sun, E.addSun(scene), E.shadowFit(center, radius)   the one shadow-casting sun and how to aim its shadow box
//   E.init(renderer), E.resize(w, h, scale), E.size()     set-up, called by main.js
//   E.render(scene, cam, look)   draws one frame; `look` is the shot's post settings (the table above E.render)
//   E.V3, E.col       tiny makers for THREE.Vector3 and THREE.Color
//
// One frame, pass by pass (E.render)
//   1. shadow map   three draws the sun's shadow map once per frame
//   2. opaque scene camera layer 0 into rtScene (half float, 4x MSAA, depth texture)
//   3. glass        layer E.GLASS into rtGlass; glass samples rtScene's colour and depth to bend what is behind it
//   4. composite    scene + glass, ink where the depth jumps, circle of confusion (how blurred) into alpha -> rtComp
//   5. light shafts march bright sky pixels toward the sun's spot on screen, half size, blurred twice -> rtHalf
//   6. bloom        bright pass, six halvings, tent upsamples back up; ups[0] is the bloom, ups[2] (only the wide
//                   levels) the soft anime glow
//   7. final        to the canvas: shock ripples, depth of field, colour fringe, rainbow, light leaks, + shafts, + bloom,
//                   + glow, lens flare, exposure and a soft shoulder, saturation, contrast, lift/gain, vignette, -> sRGB,
//                   speed lines, impact frames, paper and grain, fade, flash, invert, letterbox bars
//
// Reads FILM.anim (rng, ih, lerp, clamp). world.js moves the sun, sky and fog on its light timetable; main.js sets the
// shadow tint from each shot's grade (music/score.js GRADE); each shot in film/scenes/ returns the look.
// To see it: every still goes through it, e.g.  node tools/shot.mjs --t 27.75,85.5 --cols 2 --w 960 --out build/look.jpg
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim;
  const E = F.engine = {};
  const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z), col = c => new THREE.Color(c);
  E.V3 = V3; E.col = col;

  // ------------------------------------------------------------------ shared uniforms
  // The values here are only starting points: world.js rewrites the sun, sky, fog and wind every frame, main.js the clock
  // and the shadow tint, E.render the pixel sizes. events.js later adds its toll table (uEv, uEvP, uEvN) to this object.
  const U = F.U = {
    uTime: { value: 0 }, uHeld: { value: 0 },  // film time in seconds; the same time held on twos (FILM.anim.held)
    uSunDir: { value: V3(-.45, .62, .35).normalize() }, uSunCol: { value: col('#fff6e8') },   // unit vector toward the sun; its colour times its strength
    uShade: { value: col('#8f95d6') },          // what a shadow multiplies a colour by (hue-shifted toward blue-violet)
    uSkyFill: { value: col('#a9d6ff') }, uBounce: { value: col('#ffd9b0') },   // fill in the shadows: from the sky above, bounced up from the ground
    uRimCol: { value: col('#fff2d6') },
    uSkyTop: { value: col('#2f7fe0') }, uSkyHor: { value: col('#c9ecff') }, uSkyLow: { value: col('#eaf6ff') },   // zenith, horizon, below the horizon
    uFogCol: { value: col('#cfe8ff') }, uFog: { value: new THREE.Vector4(.0016, .012, 0, .92) },   // density per m, height falloff per m, base height (m), max amount
    uPx: { value: .001 },                       // world size of one 1080p pixel at distance 1 m (outline width), set by E.render
    uWorld: { value: new THREE.Vector4(0, 0, 0, 0) },   // four free slots for a module's own use (unused at present)
    uWind: { value: new THREE.Vector3(1, 0, 0) },      // wind direction times strength, set by world.js
    uInkFlip: { value: 0 },                     // 0 dark ink .. 1 pale warm rim lines (the backlit climax); from look.ink
    uRes: { value: new THREE.Vector2(1920, 1080) },   // render size in pixels (screen-space patterns: halftone, hatching)
    uLive: { value: 1 },                        // from look.live: 1 while sound is passing, 0 in silence (bible M18)
    tNoise: { value: null },
  };

  // Tiling noise texture, 256 x 256, built once on the CPU so shaders can read noise with one texture fetch.
  // R: fbm (5 octaves of value noise, period 4 cells at the base), G: fine grain (64 and 128 cells),
  // B: cell edges (distance to the second-nearest minus the nearest of 70 random points, wrapped), A: a second fbm.
  // Every octave tiles because the lattice hash wraps at the period p, so the texture repeats without a seam.
  (() => { const N = 256, px = new Uint8Array(N * N * 4), r = A.rng(77), lerp = A.lerp;
    const tv = (x, y, p, s) => { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
      const h = (a, b) => A.ih(((a % p) + p) % p, ((b % p) + p) % p, s);
      return lerp(lerp(h(i, j), h(i + 1, j), u), lerp(h(i, j + 1), h(i + 1, j + 1), u), v); };
    const pts = []; for (let i = 0; i < 70; i++) pts.push([r(), r()]);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const u = x / N, v = y / N, k = (y * N + x) * 4;
      let f = 0, a = .5, p = 4; for (let o = 0; o < 5; o++) { f += a * tv(u * p, v * p, p, o + 1); a *= .5; p *= 2; } f /= .97;
      let f2 = 0; a = .5; p = 6; for (let o = 0; o < 4; o++) { f2 += a * tv(u * p, v * p, p, o + 11); a *= .5; p *= 2; } f2 /= .94;
      const g = .55 * tv(u * 64, v * 64, 64, 21) + .45 * tv(u * 128, v * 128, 128, 22);
      let d1 = 9, d2 = 9; for (const q of pts) { let dx = Math.abs(u - q[0]), dy = Math.abs(v - q[1]); if (dx > .5) dx = 1 - dx; if (dy > .5) dy = 1 - dy; const d = dx * dx + dy * dy; if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
      const c = A.clamp((Math.sqrt(d2) - Math.sqrt(d1)) * 9);
      px[k] = f * 255; px[k + 1] = g * 255; px[k + 2] = c * 255; px[k + 3] = f2 * 255; }
    const t = new THREE.DataTexture(px, N, N, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true; U.tNoise.value = t; })();

  // COMMON: the GLSL every film shader starts with. It declares FILM.U and a few helpers:
  //   nz / nzA / grain / cells   read one channel of the noise texture (p in texture repeats, so 1.0 = one 256 px tile)
  //   h12        a cheap hash of a 2D point -> [0,1)
  //   tri3       triplanar noise: three projections of nz blended by the normal, so paint sticks to any surface
  //   skyAt      the sky colour in a direction (the same gradient as the sky dome)
  //   fogApply   height fog: thicker low down, thinner up high, coloured partly by the sky behind
  const COMMON = /* glsl */`
uniform float uTime, uHeld, uPx, uInkFlip, uLive; uniform vec2 uRes; uniform vec3 uSunDir, uSunCol, uShade, uSkyFill, uBounce, uRimCol, uSkyTop, uSkyHor, uSkyLow, uFogCol, uWind;
uniform vec4 uFog, uWorld; uniform sampler2D tNoise;
float nz(vec2 p){ return texture2D(tNoise, p).r; }
float nzA(vec2 p){ return texture2D(tNoise, p).a; }
float grain(vec2 p){ return texture2D(tNoise, p).g; }
float cells(vec2 p){ return texture2D(tNoise, p).b; }
float h12(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// triplanar: weights |n|^4 keep the blend zones narrow
float tri3(vec3 p, vec3 n, float s){ vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  return nz(p.yz * s) * w.x + nz(p.xz * s) * w.y + nz(p.xy * s) * w.z; }
// horizon -> zenith (pow 0.55 keeps the blue high), then toward uSkyLow just below the horizon
vec3 skyAt(vec3 d){ float y = d.y; vec3 c = mix(uSkyHor, uSkyTop, pow(clamp(y, 0.0, 1.0), 0.55)); c = mix(c, uSkyLow, smoothstep(0.02, -0.25, y)); return c; }
// fog amount 1 - exp(-distance * density), the density cut to 25% well above the base height; capped at uFog.w.
// The fog colour is 45% the sky seen along the same ray, so distant land melts into the sky behind it.
vec3 fogApply(vec3 c, vec3 wp){ vec3 dv = wp - cameraPosition; float d = length(dv);
  float h = exp(-max(wp.y - uFog.z, 0.0) * uFog.y); float f = (1.0 - exp(-d * uFog.x * mix(0.25, 1.0, h))) * uFog.w;
  vec3 fc = mix(uFogCol, skyAt(dv / max(d, 1e-3)), 0.45); return mix(c, fc, f); }
`;
  E.COMMON = COMMON;

  // ------------------------------------------------------------------ cel material
  // opts: color, vcol (use vertex colours), shade (multiplier on top of the global shadow tint), rim, spec (hair band),
  //       paint (strength of the painted grain), grad [y0, y1, amount] (darken toward y0 in object space), soft (terminator
  //       width), wrap (push light round the form), emit, alpha (with transparent), side, transparent, depthWrite, fog (0..1),
  //       shadowK (0 ignores cast shadows), uniforms (extra), line (outline colour, used by E.outline),
  //       GLSL hooks: vpars, vnormal (may change `objectNormal`), vdeform (may change `transformed`; `P0` is the rest position),
  //       fpars, fpre (may change `base`, `N`, `lightK`), fpost (may change `c`).
  // SkinnedMesh and InstancedMesh (with instance colours) work through three's own #ifdef chunks; nothing to switch on.
  const LIGHTS = () => THREE.UniformsUtils.clone(THREE.UniformsLib.lights);
  // The vertex shader, shared by the cel material and its outline (outline = true grows the hull, see lineMat).
  // Varyings: vWP world position, vWN world normal, vOP object-space rest position (so paint and noise stick to a body
  // that bends), vVN view-space normal.
  function vtx(o, outline) {
    return /* glsl */`#include <common>
#include <color_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
${COMMON}
varying vec3 vWP; varying vec3 vWN; varying vec3 vOP; varying vec3 vVN;
uniform float uLinePx, uLineMax;
${o.vpars || ''}
void main(){
  #include <color_vertex>
  #include <beginnormal_vertex>
  vec3 P0 = position;
  ${o.vnormal || ''}
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  ${o.vdeform || ''}
  #include <skinning_vertex>
  vOP = P0;
  vec4 wp4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wp4 = instanceMatrix * wp4;
  #endif
  wp4 = modelMatrix * wp4;
  vWP = wp4.xyz;
  vWN = normalize(inverseTransformDirection(transformedNormal, viewMatrix));
  vVN = normalize(transformedNormal);
  vec4 mvPosition = viewMatrix * wp4;
  ${outline ? `vec3 onv = transformedNormal;
  #ifdef FLIP_SIDED
    onv = -onv;   // three flips normals for back-side materials; the hull must still grow outward
  #endif
  // inverted hull: push each vertex out along its view-space normal by uLinePx pixels (width grows with depth, so it
  // stays constant on screen) but never more than uLineMax metres; then push it a little away from the camera so the
  // hull hides behind the surface and only its rim shows
  float lw = min(uLinePx * uPx * max(-mvPosition.z, 0.1), uLineMax); mvPosition.xyz += normalize(onv) * lw; mvPosition.z -= lw * 0.6;` : ''}
  gl_Position = projectionMatrix * mvPosition;
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
}`;
  }
  function toon(o = {}) {
    const u = Object.assign(LIGHTS(), U, {
      uColor: { value: col(o.color || '#ffffff') }, uShadeM: { value: col(o.shade || '#ffffff') }, uEmit: { value: col(o.emit || '#000000') },
      uRim: { value: o.rim ?? .35 }, uSpec: { value: o.spec ?? 0 }, uPaint: { value: o.paint ?? .12 }, uGrad: { value: V3(...(o.grad || [0, 1, 0])) },
      uSoft: { value: o.soft ?? .035 }, uWrap: { value: o.wrap ?? 0 }, uAlpha: { value: o.alpha ?? 1 }, uShadowK: { value: o.shadowK ?? 1 },
      uFogK: { value: o.fog ?? 1 }, uLinePx: { value: 0 }, uLineMax: { value: 0 },
    }, o.uniforms || {});
    const m = new THREE.ShaderMaterial({
      uniforms: u, lights: true, vertexColors: !!o.vcol, side: o.side ?? THREE.FrontSide, transparent: !!o.transparent, depthWrite: o.depthWrite ?? true,
      vertexShader: vtx(o, false),
      fragmentShader: /* glsl */`#include <common>
#include <packing>
#include <color_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
${COMMON}
varying vec3 vWP; varying vec3 vWN; varying vec3 vOP; varying vec3 vVN;
uniform vec3 uColor, uShadeM, uEmit, uGrad; uniform float uRim, uSpec, uPaint, uSoft, uWrap, uAlpha, uShadowK, uFogK;
${o.fpars || ''}
void main(){
  vec3 base = uColor;
  #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
    base *= vColor;
  #endif
  vec3 N = normalize(vWN);
  #ifdef DOUBLE_SIDED
    N = gl_FrontFacing ? N : -N;
  #endif
  vec3 V = normalize(cameraPosition - vWP);
  float lightK = 1.0;
  ${o.fpre || ''}
  // paint: triplanar noise plus fine grain nudge the flat colour, like a painted cel rather than a printed one
  base *= 1.0 + (tri3(vWP, N, 0.31) - 0.5) * uPaint + (grain(vWP.xz * 0.9 + vWP.y * 0.3) - 0.5) * uPaint * 0.35;
  base *= mix(1.0 - uGrad.z, 1.0, smoothstep(uGrad.x, uGrad.y, vOP.y));
  // two tones: a sharp step (width uSoft) across the terminator, times the cast shadow (hardened to a clean edge)
  float ndl = dot(N, uSunDir) + uWrap;
  float sh = 1.0;
  #ifdef USE_SHADOWMAP
    sh = getShadowMask();
  #endif
  float lit = smoothstep(-uSoft, uSoft, ndl) * mix(1.0, smoothstep(0.3, 0.7, sh), uShadowK) * lightK;
  // the shadow tone is a hue shift of the base (never grey), plus a little sky fill from above and warm bounce from below
  vec3 shadeC = base * uShade * uShadeM;
  shadeC += base * mix(uBounce, uSkyFill, N.y * 0.5 + 0.5) * 0.16;
  vec3 c = mix(shadeC, base * uSunCol, lit);
  // hair band: a thin hard highlight round the half vector, its edge broken by noise
  if (uSpec > 0.0) { vec3 Hh = normalize(uSunDir + V); float s = dot(N, Hh) + (nz(vOP.xy * 2.3 + vOP.z) - 0.5) * 0.12;
    c += uSunCol * mix(base, vec3(1.0), 0.45) * uSpec * smoothstep(0.82, 0.845, s) * (0.25 + 0.75 * lit); }
  // rim light on the silhouette, strongest when the camera looks toward the sun (backlight)
  float fr = 1.0 - max(dot(N, V), 0.0), back = clamp(0.55 - dot(V, uSunDir) * 0.6, 0.0, 1.0);
  c += uRimCol * uRim * smoothstep(0.6, 0.66, fr) * back * (0.35 + 0.65 * lit);
  c += uEmit;
  ${o.fpost || ''}
  c = mix(c, fogApply(c, vWP), uFogK);
  gl_FragColor = vec4(c, uAlpha);
}`,
    });
    m.userData.o = o; m.userData.line = o.line;
    return m;
  }
  E.toon = toon;

  // ------------------------------------------------------------------ ink line (inverted hull)
  // A second copy of the mesh, drawn back faces only and pushed outward, so its rim shows round the silhouette as a line.
  // It is built from the same vertex shader as the cel material (with the same vpars / vdeform hooks), so it bends with the body.
  // px: line width in screen pixels at 1080p; max: never wider than this in metres (keeps far things fine).
  // The line colour turns pale and warm as uInkFlip goes to 1 (look.ink 'pale'), and it fogs like the surface it rims.
  function lineMat(o = {}, src = {}) {
    const u = Object.assign({}, U, { uLine: { value: col(o.color || '#2a2440') }, uLinePx: { value: o.px ?? 2.2 }, uLineMax: { value: o.max ?? .04 }, uFogK: { value: o.fog ?? 1 } }, src.uniforms || {});
    return new THREE.ShaderMaterial({
      uniforms: u, side: THREE.BackSide, vertexColors: !!src.vcol,
      vertexShader: vtx(src, true),
      fragmentShader: /* glsl */`${COMMON}
varying vec3 vWP; uniform vec3 uLine; uniform float uFogK;
void main(){ vec3 c = mix(uLine, vec3(1.0, 0.76, 0.56), uInkFlip); c = mix(c, fogApply(c, vWP), uFogK); gl_FragColor = vec4(c, 1.0); }`,
    });
  }
  // add an outline to a mesh (or SkinnedMesh / InstancedMesh). o: color, px, max, fog. Returns the line mesh (also in
  // mesh.userData.line). Colour defaults to the material's `line` or a darkened base colour.
  function outline(mesh, o = {}) {
    const src = mesh.material.userData && mesh.material.userData.o || {};
    let c = o.color || mesh.material.userData.line;
    // default ink: the base colour with its hue turned back by 0.03 (about 11 degrees), a little less saturated, at 22% of its lightness
    if (!c) { const b = mesh.material.uniforms && mesh.material.uniforms.uColor ? mesh.material.uniforms.uColor.value.clone() : col('#888888');
      const hsl = {}; b.getHSL(hsl); c = new THREE.Color().setHSL((hsl.h + .97) % 1, Math.min(1, hsl.s * .8 + .1), hsl.l * .22); c = '#' + c.getHexString(); }
    const m = lineMat({ color: c, px: o.px, max: o.max, fog: o.fog }, src);
    // share the deform uniforms so the line moves with the body
    if (src.uniforms) for (const k in src.uniforms) m.uniforms[k] = mesh.material.uniforms[k];
    // the line shares the mesh's geometry (and skeleton or instance matrices), so it costs a draw call but no memory
    let ln;
    if (mesh.isSkinnedMesh) { ln = new THREE.SkinnedMesh(mesh.geometry, m); ln.bind(mesh.skeleton, mesh.bindMatrix); ln.bindMode = mesh.bindMode; }
    else if (mesh.isInstancedMesh) { ln = new THREE.InstancedMesh(mesh.geometry, m, mesh.count); ln.instanceMatrix = mesh.instanceMatrix; }
    else ln = new THREE.Mesh(mesh.geometry, m);
    ln.castShadow = false; ln.receiveShadow = false; ln.frustumCulled = mesh.frustumCulled; ln.renderOrder = mesh.renderOrder; ln.userData.isLine = true;
    // a skinned line is a sibling with the same transform (the bones drive both); any other line is simply a child
    if (mesh.isSkinnedMesh) { mesh.parent ? mesh.parent.add(ln) : mesh.add(ln); ln.position.copy(mesh.position); ln.quaternion.copy(mesh.quaternion); ln.scale.copy(mesh.scale); }
    else mesh.add(ln);
    mesh.userData.line = ln; return ln;
  }
  E.outline = outline;
  // convenience: a cel mesh with shadows and (optionally) an outline. o: cast, receive (default true), line (true or outline opts)
  E.mesh = (geo, mat, o = {}) => { const m = new THREE.Mesh(geo, mat); m.castShadow = o.cast ?? true; m.receiveShadow = o.receive ?? true; if (o.line !== false && o.line !== undefined) outline(m, o.line === true ? {} : o.line); return m; };

  // ------------------------------------------------------------------ painted cumulus
  // three tones: sunlit top (warm white), body (cool light), shadow (violet-blue); a glowing rim when the sun is behind,
  // and a dissolved edge (alpha to coverage on the 4x MSAA target: soft without sorting). opts: lit, mid, shade, glow,
  // base (world y of the flat underside, m), size (cloud size in m, scales the noise), fog (0..1, default .6).
  // (The film's own clouds are built in world.js; this material is kept as part of the kit.)
  E.cloud = (o = {}) => new THREE.ShaderMaterial({
    uniforms: Object.assign({}, U, { cLit: { value: col(o.lit || '#fffaf0') }, cMid: { value: col(o.mid || '#e3ecfb') }, cShade: { value: col(o.shade || '#9aa6d8') },
      cGlow: { value: col(o.glow || '#fff1c8') }, uBase: { value: o.base ?? 0 }, uSize: { value: o.size ?? 60 }, uFogK: { value: o.fog ?? .6 } }),
    alphaToCoverage: true, transparent: false,
    vertexShader: /* glsl */`${COMMON} varying vec3 vWP; varying vec3 vWN; varying vec3 vOP;
      void main(){ vOP = position; vec4 w = modelMatrix * vec4(position, 1.0); vWP = w.xyz; vWN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`${COMMON} varying vec3 vWP; varying vec3 vWN; varying vec3 vOP;
      uniform vec3 cLit, cMid, cShade, cGlow; uniform float uBase, uSize, uFogK;
      void main(){ vec3 N = normalize(vWN), V = normalize(cameraPosition - vWP);
        // noise bends the light so the tone borders wander like brush edges
        float n1 = nz(vOP.xy / uSize * 1.7 + vOP.z / uSize * 0.6), n2 = nzA(vOP.zy / uSize * 3.1 + 0.37);
        float ndl = dot(N, uSunDir) + (n1 - 0.5) * 0.55;
        vec3 c = mix(cShade, cMid, smoothstep(-0.12, -0.02, ndl));
        c = mix(c, cLit, smoothstep(0.38, 0.46, ndl + (n2 - 0.5) * 0.3));
        // the flat underside darkens toward uBase
        float under = smoothstep(uBase + uSize * 0.5, uBase, vWP.y); c = mix(c, cShade * 0.92, under * 0.55);
        // silver lining: the silhouette glows, much more when the camera looks toward the sun
        float fr = 1.0 - abs(dot(N, V)); float toSun = pow(max(dot(-V, uSunDir), 0.0), 3.0);
        c += cGlow * smoothstep(0.55, 0.75, fr) * (0.35 + 1.4 * toSun);
        c = mix(c, fogApply(c, vWP), uFogK);
        // the edge dissolves: alpha falls off at grazing angles, broken by noise
        float a = smoothstep(0.98, 0.72, fr + (n2 - 0.5) * 0.55);
        gl_FragColor = vec4(c, a); }`,
  });

  // ------------------------------------------------------------------ painted sky dome
  // gradient zenith -> horizon -> below; sun disc and halo; brushed bands; optional extra (moon etc.) via opts.fpars / opts.fpost.
  // opts: sun (cosine of the disc's angular radius: .9996 is about 1.6 degrees), bands (strength), uniforms, fpars, fpost.
  // Put it on a large sphere round the camera. It writes no depth and sits at the far plane, so the post chain reads
  // "depth = far" as sky (light shafts, lens flare). (stub.js uses it; world.js builds the film's own sky.)
  E.skyMat = (o = {}) => new THREE.ShaderMaterial({
    uniforms: Object.assign({}, U, { uSunSize: { value: o.sun ?? .9996 }, uBands: { value: o.bands ?? .05 } }, o.uniforms || {}),
    side: THREE.BackSide, depthWrite: false,
    vertexShader: /* glsl */`varying vec3 vD; void main(){ vD = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.99999; }`,
    fragmentShader: /* glsl */`${COMMON} varying vec3 vD; uniform float uSunSize, uBands; ${o.fpars || ''}
      void main(){ vec3 d = normalize(vD); vec3 c = skyAt(d);
        // brushed bands: noise stretched along the horizon, only above it
        float b = nz(vec2(atan(d.z, d.x) * 0.25, d.y * 3.0)) - 0.5; c *= 1.0 + b * uBands * smoothstep(0.0, 0.3, d.y);
        // halo: three lobes round the sun (tight, medium, wide); then the disc itself, bright enough to bloom
        float s = dot(d, uSunDir); c += uSunCol * (pow(max(s, 0.0), 180.0) * 0.6 + pow(max(s, 0.0), 12.0) * 0.18 + pow(max(s, 0.0), 3.0) * 0.06);
        c = mix(c, uSunCol * 3.5, smoothstep(uSunSize - 0.00012, uSunSize, s));
        ${o.fpost || ''}
        gl_FragColor = vec4(c, 1.0); }`,
  });

  // ------------------------------------------------------------------ glass / water that refracts
  // Drawn after the opaque scene into its own target: it samples the finished opaque picture (tScene) and its depth, so
  // the valley behind a big rain drop shows bent through it (rain.js's hero drops). It is not real ray tracing: the screen
  // position is pushed along the view-space normal, more at the rim, less far away.
  // opts: tint, deep (colour toward the rim), edge (rim line colour), ior (bend strength in screen uv), spec, side,
  //       uniforms, GLSL hooks vpars / vdeform (may change `transformed`, `objectNormal`), fpars, fpre, fpost (may change `c`).
  // Works with InstancedMesh. Put the mesh on layer E.GLASS: mesh.layers.set(E.GLASS).
  // GLASS_U is shared by every glass material; E.render fills it before the glass pass.
  const GLASS_U = { tScene: { value: null }, tDepthG: { value: null }, uResG: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(.1, 4000) } };
  E.GLASS = 1;   // camera layer of the glass pass (the opaque pass draws layer 0 only)
  E.glass = (o = {}) => {
    const m = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, U, GLASS_U, { uTint: { value: col(o.tint || '#bfeaf2') }, uEdge: { value: col(o.edge || '#5fb7d6') }, uIor: { value: o.ior ?? .12 },
        uSpecK: { value: o.spec ?? 1 }, uDeep: { value: col(o.deep || '#2f86b8') } }, o.uniforms || {}),
      transparent: true, depthWrite: false, side: o.side ?? THREE.FrontSide,
      vertexShader: /* glsl */`${COMMON} varying vec3 vWP; varying vec3 vWN; varying vec3 vOP; varying vec4 vClip; ${o.vpars || ''}
        void main(){ vec3 transformed = position; vec3 objectNormal = normal; vOP = position; ${o.vdeform || ''}
          vec4 w = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            w = instanceMatrix * w; objectNormal = mat3(instanceMatrix) * objectNormal;
          #endif
          w = modelMatrix * w; vWP = w.xyz; vWN = normalize(mat3(modelMatrix) * objectNormal); vClip = projectionMatrix * viewMatrix * w; gl_Position = vClip; }`,
      fragmentShader: /* glsl */`${COMMON} varying vec3 vWP; varying vec3 vWN; varying vec3 vOP; varying vec4 vClip;
        uniform sampler2D tScene, tDepthG; uniform vec2 uResG, uNearFar; uniform vec3 uTint, uEdge, uDeep; uniform float uIor, uSpecK; ${o.fpars || ''}
        // depth buffer value -> distance from the camera in metres
        float linD(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x)); }
        // own depth test against the opaque picture (the glass target has its own depth buffer), with 2 cm of slack
        void main(){ vec2 suv = gl_FragCoord.xy / uResG; float dOpaque = linD(texture2D(tDepthG, suv).x), dMe = linD(gl_FragCoord.z);
          if (dMe > dOpaque + 0.02) discard;
          vec3 N = normalize(vWN); if (!gl_FrontFacing) N = -N; vec3 V = normalize(cameraPosition - vWP); float ndv = max(dot(N, V), 0.0), fr = 1.0 - ndv;
          ${o.fpre || ''}
          // refraction: read the opaque picture at a shifted spot; the shift grows toward the rim and shrinks beyond 20 m
          vec3 vn = normalize((viewMatrix * vec4(N, 0.0)).xyz);
          vec2 off = vn.xy * uIor * (0.35 + fr) * (1.0 / max(dMe * 0.05, 1.0));
          vec3 bg = texture2D(tScene, clamp(suv - off, 0.001, 0.999)).rgb;
          // tint (deeper toward the rim), a coloured edge, some fog
          vec3 c = bg * mix(uTint, uDeep, smoothstep(0.55, 1.0, fr));
          c = mix(c, uEdge * (0.6 + 0.6 * dot(N, uSunDir)), smoothstep(0.78, 0.97, fr) * 0.85);
          c = mix(c, fogApply(c, vWP), 0.6);
          // a hard sun glint with a soft skirt, and a bright rim on the sunlit side
          vec3 Hh = normalize(uSunDir + V); float sp = dot(N, Hh);
          c += uSunCol * uSpecK * (smoothstep(0.975, 0.985, sp) * 2.4 + smoothstep(0.9, 0.93, sp) * 0.25);
          float rimHi = smoothstep(0.86, 0.9, fr) * smoothstep(0.1, 0.5, dot(N, uSunDir)); c += uSunCol * rimHi * 0.6 * uSpecK;
          ${o.fpost || ''}
          // alpha 1 where glass is drawn; the cleared target stays at alpha 0, so the composite knows where glass is
          gl_FragColor = vec4(c, 1.0); }`,
    });
    return m;
  };

  // ------------------------------------------------------------------ renderer, sun and shadows
  // W, H: internal render size in pixels (canvas size x device pixel ratio x scale); the render targets are made in E.resize.
  let R, W = 2, H = 2, scale = 1, dprK = 1, rtScene, rtGlass, rtComp, rtHalf, rtHalf2, blooms = [], ups = [];
  // The sun is a DirectionalLight only so three draws a shadow map for it (4096 px, PCF with a small blur radius).
  // Its colour and strength are not used: the materials light themselves from FILM.U.uSunDir / uSunCol.
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 1.6;
  sun.layers.enableAll(); const sunT = new THREE.Object3D(); sun.target = sunT;
  E.sun = sun;
  // keep the shadow camera on what matters in the shot: a sphere at c (Vector3) with radius r (m). The shadow box is
  // 2r wide, so a small r gives sharp shadows on a close-up and a large one covers a whole terrace. Each shot calls it.
  E.shadowFit = (c, r) => { const d = U.uSunDir.value; sunT.position.copy(c); sun.position.copy(c).addScaledVector(d, r * 3); const s = sun.shadow.camera;
    s.left = -r; s.right = r; s.top = r; s.bottom = -r; s.near = r * .5; s.far = r * 6; s.updateProjectionMatrix(); sun.shadow.needsUpdate = true; };
  E.addSun = scene => { scene.add(sun); scene.add(sunT); E.shadowFit(V3(), 40); };

  // ------------------------------------------------------------------ post
  // Every post pass draws one triangle that covers the screen (cheaper than a quad, no seam) with a ShaderMaterial.
  // DEPTH gives a pass the scene's depth texture and lin(), which turns a depth value into metres from the camera.
  const tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(tri, null); quad.frustumCulled = false; const qs = new THREE.Scene(); qs.add(quad); const qc = new THREE.Camera();
  const VS = 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const mk = (fs, u) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms: u, depthTest: false, depthWrite: false });
  const DEPTH = /* glsl */`uniform sampler2D tDepth; uniform vec2 uNF; float lin(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNF.x * uNF.y / (uNF.y + uNF.x - z * (uNF.y - uNF.x)); }`;
  const du = () => ({ tDepth: { value: null }, uNF: { value: new THREE.Vector2(.1, 4000) } });
  // pass 4, composite: scene + glass, ink on depth edges, circle of confusion in alpha
  const mComp = mk(COMMON + DEPTH + /* glsl */`uniform sampler2D tC, tG; uniform vec2 uT; uniform float uFocus, uAp, uEdge, uEdgeFar, uGlassOn; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tC, vUv).rgb; if (uGlassOn > 0.5) { vec4 g = texture2D(tG, vUv); c = mix(c, g.rgb, g.a); }
      float z = lin(texture2D(tDepth, vUv).x);
      // depth ink: where the four neighbours jump in depth by more than 4.5-9% of the distance, darken toward violet ink
      // (or pale warm lines when uInkFlip is 1); fades out between uEdgeFar / 2 and uEdgeFar metres
      if (uEdge > 0.0) { float zl = lin(texture2D(tDepth, vUv - vec2(uT.x, 0.0)).x), zr = lin(texture2D(tDepth, vUv + vec2(uT.x, 0.0)).x),
          zd = lin(texture2D(tDepth, vUv - vec2(0.0, uT.y)).x), zu = lin(texture2D(tDepth, vUv + vec2(0.0, uT.y)).x);
        float zm = min(min(zl, zr), min(zd, zu)); float e = (max(max(zl, zr), max(zd, zu)) - zm) / max(zm, 0.1);
        float k = smoothstep(0.045, 0.09, e) * uEdge * (1.0 - smoothstep(uEdgeFar * 0.5, uEdgeFar, zm));
        c = mix(c, mix(c * vec3(0.32, 0.3, 0.42), vec3(1.0, 0.76, 0.56) * 1.4, uInkFlip), k); }
      // circle of confusion 0..1: relative distance from the focus plane times the aperture (the final pass blurs by it)
      float coc = clamp(abs(z - uFocus) / max(z, 0.1) * uAp * 110.0, 0.0, 1.0);
      // the clamp at 40 stops single very bright pixels from blowing up the bloom
      gl_FragColor = vec4(min(c, vec3(40.0)), coc); }`, Object.assign(du(), U, { tC: { value: null }, tG: { value: null }, uT: { value: new THREE.Vector2() }, uFocus: { value: 10 }, uAp: { value: 0 }, uEdge: { value: .6 }, uEdgeFar: { value: 120 }, uGlassOn: { value: 0 } }));
  // pass 5, light shafts (crepuscular rays) from the sun: march the sky mask towards the sun's spot on screen, half size.
  //    Each pixel takes 28 samples on the line to the sun; a sample counts if it is sky (depth at the far plane) and bright.
  //    The start of the march is jittered per pixel (interleaved gradient noise); the two blur passes after it hide the jitter.
  const mRays = mk(DEPTH + /* glsl */`uniform sampler2D tC; uniform vec2 uSun; uniform float uK, uAsp; varying vec2 vUv;
    float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    void main(){ if (uK <= 0.0) { gl_FragColor = vec4(0.0); return; } vec2 d = (uSun - vUv); float j = ign(gl_FragCoord.xy); vec3 acc = vec3(0.0);
      for (int i = 0; i < 28; i++) { float s = (float(i) + j) / 28.0; vec2 p = vUv + d * s * 0.92; if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) continue;
        float sky = step(0.99999, texture2D(tDepth, p).x); vec3 c = texture2D(tC, p).rgb; acc += c * sky * smoothstep(0.75, 2.5, dot(c, vec3(0.33))) * (1.0 - s * 0.6); }
      float fall = exp(-length(d * vec2(uAsp, 1.0)) * 1.4); gl_FragColor = vec4(acc / 28.0 * uK * fall, 1.0); }`, Object.assign(du(), { tC: { value: null }, uSun: { value: new THREE.Vector2(.5, .5) }, uK: { value: 0 }, uAsp: { value: 1.78 } }));
  // a 5-tap blur along uDir (used horizontally, then vertically)
  const mBlur = mk(/* glsl */`uniform sampler2D tA; uniform vec2 uDir; varying vec2 vUv; void main(){ vec4 s = texture2D(tA, vUv) * 0.28;
      s += (texture2D(tA, vUv + uDir) + texture2D(tA, vUv - uDir)) * 0.22; s += (texture2D(tA, vUv + uDir * 2.5) + texture2D(tA, vUv - uDir * 2.5)) * 0.14; gl_FragColor = s; }`, { tA: { value: null }, uDir: { value: new THREE.Vector2() } });
  // pass 6, bloom chain (soft knee) -> its wide levels also give the anime "diffusion" glow.
  //    mPre: bright pass at half size (2x2 box filter; a pixel starts to bloom when its brightest channel passes uTh,
  //          fully 0.9 above it; dividing by 1 + 0.12 l tames very bright pixels).
  //    mDown: halve again, 5 taps. mUp: 3x3 tent blur of the smaller level, added onto the larger one.
  const mPre = mk(/* glsl */`uniform sampler2D tC; uniform vec2 uT; uniform float uTh; varying vec2 vUv; void main(){ vec3 s = vec3(0.0);
      for (int i = 0; i < 4; i++) { vec2 o = vec2(i == 0 || i == 2 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0) * uT; vec3 c = texture2D(tC, vUv + o).rgb; float l = max(c.r, max(c.g, c.b)); s += c * smoothstep(uTh, uTh + 0.9, l) / (1.0 + l * 0.12); }
      gl_FragColor = vec4(s * 0.25, 1.0); }`, { tC: { value: null }, uT: { value: new THREE.Vector2() }, uTh: { value: .75 } });
  const mDown = mk(/* glsl */`uniform sampler2D tC; uniform vec2 uT; varying vec2 vUv; void main(){ vec3 s = texture2D(tC, vUv).rgb * 0.5;
      s += (texture2D(tC, vUv + vec2(-1, -1) * uT).rgb + texture2D(tC, vUv + vec2(1, -1) * uT).rgb + texture2D(tC, vUv + vec2(-1, 1) * uT).rgb + texture2D(tC, vUv + vec2(1, 1) * uT).rgb) * 0.125; gl_FragColor = vec4(s, 1.0); }`, { tC: { value: null }, uT: { value: new THREE.Vector2() } });
  const mUp = mk(/* glsl */`uniform sampler2D tC, tB; uniform vec2 uT; uniform float uW; varying vec2 vUv; void main(){ vec3 s = vec3(0.0);
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { float w = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0); s += texture2D(tC, vUv + vec2(float(x), float(y)) * uT).rgb * w; }
      gl_FragColor = vec4(texture2D(tB, vUv).rgb + s / 16.0 * uW, 1.0); }`, { tC: { value: null }, tB: { value: null }, uT: { value: new THREE.Vector2() }, uW: { value: 1 } });
  // pass 7, final: depth of field, fringe, shafts, bloom + glow, lens flare, tone, grade, speed lines, flash, paper, letterbox.
  //    Everything up to the vignette works in linear light; toSRGB comes after it, so speed lines, impact frames, paper,
  //    grain, fade, flash and invert work on display colours (their colours are sRGB values 0..1).
  const mFinal = mk(COMMON + DEPTH + /* glsl */`uniform sampler2D tC, tBl, tGl, tR; uniform vec2 uSunS; uniform float uExp, uBloom, uGlow, uFade, uBars, uSeed, uCA, uSat, uCon, uFlare, uSunVis,
      uSpeed, uSpeedMode, uFlash, uVig, uGrain, uPaper, uInvert, uBow, uImpact, uLeak; uniform vec3 uFadeC, uLift, uGain, uSpeedC, uImpactC; uniform vec4 uShock0, uShock1;
      uniform mat4 uCW; uniform vec2 uTan; varying vec2 vUv;
    // shock ripple: a ring of radius s.z (screen heights) round s.xy, 0.035 thick, bends the picture along the radius (strength s.w)
    vec2 shock(vec2 uv, vec4 s){ if (s.w <= 0.0) return vec2(0.0); vec2 d = (uv - s.xy) * vec2(uRes.x / uRes.y, 1.0); float r = length(d); float x = (r - s.z) / 0.035;
      return normalize(d + 1e-5) * exp(-x * x) * s.w * 0.012 * vec2(uRes.y / uRes.x, 1.0); }
    // a rough rainbow ramp: 0 blue, 0.5 green, 1 red
    vec3 spectrum(float x){ return clamp(vec3(1.5 - abs(4.0 * x - 3.0), 1.5 - abs(4.0 * x - 2.0), 1.5 - abs(4.0 * x - 1.0)), 0.0, 1.0); }
    vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    // tone curve: untouched below 0.72, then a soft shoulder that never quite reaches 1 (highlights roll off, never clip hard)
    vec3 soft(vec3 x){ vec3 k = vec3(0.72); return mix(x, k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k))), step(k, x)); }
    // a soft round spot of radius r (screen heights) at c, for the flare ghosts; s is the softness
    float disc(vec2 p, vec2 c, float r, float s){ return smoothstep(r, r * (1.0 - s), length((p - c) * vec2(uRes.x / uRes.y, 1.0))); }
    void main(){ vec2 uv = vUv + shock(vUv, uShock0) + shock(vUv, uShock1);
      vec4 c0 = texture2D(tC, uv); float coc = c0.a; vec3 c = c0.rgb; float wsum = 1.0;
      // depth of field: 24 samples on a golden-angle spiral, radius up to 7 px; only samples that are blurred
      // themselves count, so a sharp subject does not smear into the blurred background round it
      if (coc > 0.04) { float rad = coc * 7.0; for (int i = 1; i < 24; i++) { float fi = float(i); float a = fi * 2.39996; vec2 o = vec2(cos(a), sin(a)) * sqrt(fi / 24.0) * rad / uRes;
          vec4 s = texture2D(tC, uv + o); float w = smoothstep(0.0, 0.3, s.a); c += s.rgb * w; wsum += w; } c /= wsum; }
      // colour fringe: red and blue read slightly in and out along the radius, growing with the square of the distance
      vec2 dc = vUv - 0.5; float r2 = dot(dc, dc);
      c.r = mix(c.r, texture2D(tC, uv - dc * uCA * r2).r, 0.7); c.b = mix(c.b, texture2D(tC, uv + dc * uCA * r2).b, 0.7);
      // rainbow round the anti-solar point: 42 deg primary, faint 51 deg secondary; sky and far land only.
      // The pixel ray in world space comes from the camera matrix (uCW) and tan(fov / 2) (uTan); ang is its angle to -uSunDir.
      // Bands: primary 40.6-43.2 deg, secondary 50.4-53.6 deg. As in a real bow, the primary is blue inside and red outside
      // (spectrum(p1)), and the fainter secondary is reversed, red inside (spectrum(1 - p2)).
      // It fades in with distance from 60 to 220 m, stays above the horizon, and scales with the brightness behind it.
      if (uBow > 0.0) { vec3 rd = normalize(mat3(uCW) * vec3((vUv * 2.0 - 1.0) * uTan, -1.0)); float ang = degrees(acos(clamp(dot(rd, -uSunDir), -1.0, 1.0)));
        float z = lin(texture2D(tDepth, vUv).x); float far = smoothstep(60.0, 220.0, z);
        float p1 = (ang - 40.6) / 2.6, p2 = (ang - 50.4) / 3.2; vec3 bow = vec3(0.0);
        if (p1 > 0.0 && p1 < 1.0) bow += spectrum(p1) * sin(p1 * 3.1416) * 0.6;
        if (p2 > 0.0 && p2 < 1.0) bow += spectrum(1.0 - p2) * sin(p2 * 3.1416) * 0.2;
        c += bow * uBow * far * smoothstep(-0.05, 0.12, rd.y) * dot(c, vec3(0.3)) * 1.6; }
      // light leaks: two drifting warm and cool edge glows
      if (uLeak > 0.0) { float a = uTime * 0.07; vec2 p1 = vec2(-0.1 + 0.08 * sin(a), 0.85 + 0.1 * cos(a * 1.3)), p2 = vec2(1.08 + 0.05 * cos(a * .8), 0.2 + 0.12 * sin(a));
        c += vec3(1.0, 0.62, 0.38) * exp(-length((vUv - p1) * vec2(1.6, 1.0)) * 3.2) * uLeak * 0.9 + vec3(0.45, 0.9, 1.0) * exp(-length((vUv - p2) * vec2(1.6, 1.0)) * 3.5) * uLeak * 0.6; }
      // light shafts (already scaled by look.rays), bloom, and the wide glow
      c += texture2D(tR, vUv).rgb;
      c += texture2D(tBl, vUv).rgb * uBloom;
      vec3 gl = texture2D(tGl, vUv).rgb; c = c + gl * uGlow;
      // lens flare: four soft round ghosts along the line from the sun through the centre, a horizontal streak and a glow at
      // the sun. occ = how much of a 3x3 patch round the sun's spot is open sky, so the flare dies when something covers it.
      float occ = 0.0; for (int i = 0; i < 9; i++) { vec2 o = vec2(float(i - (i / 3) * 3) - 1.0, float(i / 3) - 1.0) * 0.006; occ += step(0.99999, texture2D(tDepth, clamp(uSunS + o, 0.001, 0.999)).x); } occ /= 9.0;
      if (uFlare > 0.0 && uSunVis * occ > 0.0) { vec2 sv = uSunS - 0.5; float k = uFlare * uSunVis * occ; vec3 fl = vec3(0.0);
        fl += vec3(1.0, 0.75, 0.45) * disc(vUv, 0.5 - sv * 0.5, 0.05, 0.6) * 0.18 + vec3(0.5, 0.9, 1.0) * disc(vUv, 0.5 - sv * 1.1, 0.09, 0.15) * 0.10;
        fl += vec3(0.9, 0.55, 1.0) * disc(vUv, 0.5 - sv * 0.25, 0.025, 0.5) * 0.22 + vec3(0.6, 1.0, 0.7) * disc(vUv, 0.5 + sv * 0.35, 0.035, 0.4) * 0.12;
        vec2 q = (vUv - uSunS) * vec2(uRes.x / uRes.y, 1.0); fl += vec3(1.0, 0.85, 0.7) * exp(-abs(q.y) * 220.0) * exp(-abs(q.x) * 2.2) * 0.55;
        fl += vec3(1.0, 0.9, 0.75) * exp(-length(q) * 9.0) * 0.5; c += fl * k * uSunCol; }
      // tone and grade (linear light): exposure, soft shoulder, saturation round Rec. 709 luminance, contrast round 0.5,
      // gain multiplies, lift raises the dark end toward its colour, vignette; then into sRGB for the screen
      c *= uExp; c = soft(c);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c = (c - 0.5) * uCon + 0.5;
      c = c * uGain + uLift * (1.0 - c);
      c *= 1.0 - smoothstep(0.42, 1.1, length(dc * vec2(1.15, 1.0))) * uVig;
      c = toSRGB(clamp(c, 0.0, 1.0));
      // speed lines: thin radial streaks round uSpeedC, redrawn on twos (a new pattern for every held drawing, 12 a second).
      // Radial: 140 thin wedges, each one on or off by a hash of (wedge, drawing), kept clear of the centre.
      if (uSpeed > 0.0) { float fr12 = floor(uHeld * 12.0);
        if (uSpeedMode < 0.5) { vec2 p = (vUv - uSpeedC.xy) * vec2(uRes.x / uRes.y, 1.0); float a = atan(p.y, p.x), r = length(p);
          float id = floor(a * 70.0 / 6.2831 * 2.0); float h = h12(vec2(id, fr12)); float w = fract(a * 70.0 / 6.2831 * 2.0);
          float ln = step(0.86 + h * 0.12, 1.0 - abs(w - 0.5) * 2.0) * step(0.35 + h * 0.35, r) * step(h, 0.55);
          c = mix(c, vec3(1.0), ln * uSpeed * smoothstep(0.3, 0.8, r)); }
        else { // parallel streaks: 1 = horizontal (wind), 2 = vertical (falling); tapered, heavier at the frame edges
          bool vert = uSpeedMode > 1.5; float across = vert ? vUv.x : vUv.y, along = vert ? vUv.y : vUv.x; float rows = vert ? 160.0 : 110.0;
          float id = floor(across * rows); float h = h12(vec2(id, fr12)), h2 = h12(vec2(id * 1.7, fr12 + 3.0)); float w = fract(across * rows);
          float seg = smoothstep(h2 * 0.6, h2 * 0.6 + 0.08, along) * smoothstep(h2 * 0.6 + 0.5 + h * 0.3, h2 * 0.6 + 0.35, along);
          float edge = vert ? smoothstep(0.18, 0.02, min(vUv.x, 1.0 - vUv.x)) * 0.8 + 0.2 : smoothstep(0.3, 0.05, min(vUv.y, 1.0 - vUv.y)) * 0.7 + 0.3;
          float ln = step(0.8, 1.0 - abs(w - 0.5) * 2.0) * step(h, 0.4) * seg * edge;
          c = mix(c, vec3(1.0), ln * uSpeed); } }
      // impact frames: 1 = inverted two-tone, 2 = flat colour fill with white lines from the picture's edges
      // (two-tone: bright parts become dark violet ink, dark parts cream paper; the lines in 2 come from the colour gradient)
      if (uImpact > 0.5) { float l0 = dot(c, vec3(0.299, 0.587, 0.114));
        if (uImpact < 1.5) c = mix(vec3(1.0, 0.953, 0.878), vec3(0.106, 0.078, 0.251), step(0.5, l0));
        else { vec2 t = 1.5 / uRes; float lx = dot(texture2D(tC, uv + vec2(t.x, 0.0)).rgb - texture2D(tC, uv - vec2(t.x, 0.0)).rgb, vec3(0.33)), ly = dot(texture2D(tC, uv + vec2(0.0, t.y)).rgb - texture2D(tC, uv - vec2(0.0, t.y)).rgb, vec3(0.33));
          float e = smoothstep(0.06, 0.16, length(vec2(lx, ly))); c = mix(uImpactC, vec3(1.0), e); } }
      // paper: the faintest tooth, so flat colour does not look digital
      c *= 1.0 - (grain(vUv * uRes / 380.0) - 0.5) * uPaper - (nz(vUv * vec2(2.3, 1.3)) - 0.5) * uPaper * 0.6;
      // film grain: moves with uSeed (12 or 6 new patterns a second, see E.render), at 35% strength in silence (uLive 0)
      c += (grain(gl_FragCoord.xy / 256.0 + uSeed) - 0.5) * uGrain * mix(0.35, 1.0, uLive);
      c = mix(c, uFadeC, uFade); c = mix(c, vec3(1.0), uFlash); c = mix(c, 1.0 - c, uInvert);
      // letterbox: uBars is the height of each black bar as a fraction of the frame
      float bar = step(abs(vUv.y - 0.5), 0.5 - uBars); c *= bar;
      gl_FragColor = vec4(c, 1.0); }`, Object.assign({}, U, { tC: { value: null }, tBl: { value: null }, tGl: { value: null }, tR: { value: null }, uRes: { value: new THREE.Vector2() }, uSunS: { value: new THREE.Vector2() },
      uExp: { value: 1 }, uBloom: { value: .5 }, uGlow: { value: .18 }, uFade: { value: 0 }, uFadeC: { value: V3() }, uBars: { value: 0 }, uSeed: { value: 0 }, uCA: { value: .01 }, uSat: { value: 1.08 }, uCon: { value: 1.04 },
      uLift: { value: V3(.01, .015, .03) }, uGain: { value: V3(1, 1, 1) }, uFlare: { value: 0 }, uSunVis: { value: 0 }, uSpeed: { value: 0 }, uSpeedC: { value: V3(.5, .5, 0) }, uFlash: { value: 0 },
      uVig: { value: .35 }, uGrain: { value: .018 }, uPaper: { value: .05 }, uInvert: { value: 0 }, uSpeedMode: { value: 0 }, uBow: { value: 0 }, uImpact: { value: 0 }, uImpactC: { value: col('#E4572E') },
      uLeak: { value: 0 }, uShock0: { value: new THREE.Vector4() }, uShock1: { value: new THREE.Vector4() }, uCW: { value: new THREE.Matrix4() }, uTan: { value: new THREE.Vector2(1, 1) }, ...du() }));

  // run one post pass: material m drawn over the whole of target (null = the canvas)
  const pass = (m, target) => { quad.material = m; R.setRenderTarget(target); R.render(qs, qc); };
  const HF = { type: THREE.HalfFloatType, depthBuffer: false };
  // the shadow map is redrawn only when E.render asks (once per frame), not on every render() call
  E.init = (renderer) => { R = renderer; R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFShadowMap; R.shadowMap.autoUpdate = false; R.autoClear = true; E.R = R; };
  // (re)make the render targets for a w x h drawing buffer (device pixels) at internal scale s; main.js lowers s to 0.7
  // when frames are slow. rtScene and rtGlass: full size, 4x MSAA; rtHalf/rtHalf2: half size for the shafts;
  // blooms / ups: 7 levels from half size down (1/2 ... 1/128).
  E.resize = (w, h, s = 1) => { scale = s; W = Math.max(2, Math.round(w * s)); H = Math.max(2, Math.round(h * s));
    [rtScene, rtGlass, rtHalf, rtHalf2, rtComp, ...blooms, ...ups].forEach(t => t && t.dispose());
    rtScene = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 }); rtScene.depthTexture = new THREE.DepthTexture(W, H); rtScene.depthTexture.type = THREE.UnsignedIntType;
    rtGlass = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
    rtHalf = new THREE.WebGLRenderTarget(W >> 1, H >> 1, HF); rtHalf2 = new THREE.WebGLRenderTarget(W >> 1, H >> 1, HF);
    rtComp = new THREE.WebGLRenderTarget(W, H, HF); blooms = []; ups = [];
    let bw = W >> 1, bh = H >> 1; for (let i = 0; i < 7; i++) { blooms.push(new THREE.WebGLRenderTarget(Math.max(1, bw), Math.max(1, bh), HF)); ups.push(new THREE.WebGLRenderTarget(Math.max(1, bw), Math.max(1, bh), HF)); bw >>= 1; bh >>= 1; }
    mFinal.uniforms.uRes.value.set(W, H); GLASS_U.uResG.value.set(W, H); };
  E.size = () => [W, H];

  const sunS = V3(), camDir = V3();
  // ------------------------------------------------------------------ the look keys
  // `look` is a plain object a shot (or test view) returns with its camera. Every key is optional; a missing key takes the
  // default below (set in E.render, not in the uniforms' first values). For lift, gain, sat, th, bars and ink, main.js first
  // fills in the shot's grade from music/score.js GRADE. Screen positions are uv: 0..1, origin bottom left.
  //   key        default          what it does
  //   exp        1                exposure, a multiplier before the soft shoulder
  //   sat        1.08             saturation (0 grey, 1 as lit)
  //   con        1.04             contrast round 0.5 (linear light)
  //   lift       [.01,.014,.03]   colour the dark end is raised toward:  c * gain + lift * (1 - c)
  //   gain       [1,1,1]          colour multiplier on the whole picture
  //   bloom      .45              bloom strength
  //   glow       .16              wide soft glow strength (the anime "diffusion" look)
  //   th         .8               bloom threshold (brightest channel, linear)
  //   rays       0                light shafts from the sun (only while the sun is in or near the frame)
  //   flare      0                lens flare (only while the sun's disc is open sky)
  //   sunVis     1                extra multiplier on how visible the sun counts for the flare
  //   focus      10               focus distance in m
  //   ap         0                aperture: 0 everything sharp; about .004-.02 for a gentle to strong blur
  //   edge       .55              depth-edge ink strength
  //   edgeFar    140              depth ink fades out between edgeFar / 2 and edgeFar (m)
  //   ca         .008             colour fringe toward the frame edges
  //   vig        .32              vignette
  //   grain      .016             film grain (35% of it in silence)
  //   paper      .05              paper tooth
  //   speed      0                speed lines 0..1
  //   speedMode  0                0 radial round speedC, 1 horizontal streaks (wind), 2 vertical streaks (falling)
  //   speedC     [.5,.5]          centre of the radial speed lines (uv)
  //   flash      0                mix toward white
  //   invert     0                mix toward the negative
  //   impact     0                impact frame: 1 inverted two-tone, 2 flat impactC fill with white edge lines
  //   impactC    '#E4572E'        hex colour of the impact 2 fill (used as is: the fill is mixed in display space, after toSRGB)
  //                               THREE.Color stores it linear but it is mixed in after the sRGB step, so it shows darker than the hex

  //   rainbow    0                rainbow strength
  //   leak       0                light leaks: two drifting glows, warm top left and cool right
  //   shock      none             up to two ripples: [[cx, cy, radius in screen heights, strength], ...]
  //   ink        'dark'           'dark' | 'pale' | 0..1: dark violet ink .. pale warm rim lines (FILM.U.uInkFlip)
  //   live       1                bible M18: 1 sound is passing (grain moves 12 times a second), 0 silence (6, and weaker)
  //   fade       0                mix toward fadeC
  //   fadeC      [0,0,0]          fade colour (sRGB 0..1)
  //   bars       0                letterbox bar height, a fraction of the frame per bar (.128 turns 16:9 into 2.39:1)
  //   glass      true             false skips the glass pass
  E.render = (scene, cam, L) => {
    const fov = THREE.MathUtils.degToRad(cam.fov); U.uPx.value = 2 * Math.tan(fov / 2) / 1080;   // lines are sized for 1080 lines
    U.uInkFlip.value = L.ink === 'pale' ? 1 : (typeof L.ink === 'number' ? L.ink : 0); U.uRes.value.set(W, H);
    // passes 1 + 2: the shadow map is drawn once per frame, before the opaque pass (layer 0)
    R.shadowMap.needsUpdate = true;
    cam.layers.set(0); R.setRenderTarget(rtScene); R.setClearColor(0x000000, 1); R.clear(); R.render(scene, cam);
    const nf = [cam.near, cam.far];
    // pass 3: glass (layer E.GLASS) over a transparent clear, reading the opaque picture; no second shadow map
    let glassOn = 0;
    if (L.glass !== false) { cam.layers.set(E.GLASS); GLASS_U.tScene.value = rtScene.texture; GLASS_U.tDepthG.value = rtScene.depthTexture; GLASS_U.uNearFar.value.set(...nf);
      R.setRenderTarget(rtGlass); R.setClearColor(0x000000, 0); R.clear(); R.shadowMap.needsUpdate = false; R.render(scene, cam); cam.layers.set(0); glassOn = 1; }
    R.setClearColor(0x000000, 1);
    // pass 4: composite -> rtComp
    const C = mComp.uniforms; C.tC.value = rtScene.texture; C.tG.value = rtGlass.texture; C.uGlassOn.value = glassOn; C.tDepth.value = rtScene.depthTexture; C.uNF.value.set(...nf);
    C.uT.value.set(1 / W, 1 / H); C.uFocus.value = L.focus ?? 10; C.uAp.value = L.ap ?? 0; C.uEdge.value = L.edge ?? .55; C.uEdgeFar.value = L.edgeFar ?? 140; pass(mComp, rtComp);
    // the sun on screen: a point 1 km along uSunDir, projected to uv (sx, sy). It counts as on screen when the camera faces
    // it and it lies within 0.3 of a frame's width or height outside the frame, so shafts can still pour in from the edge
    sunS.copy(cam.position).addScaledVector(U.uSunDir.value, 1000).project(cam); cam.getWorldDirection(camDir);
    const facing = camDir.dot(U.uSunDir.value) > 0, sx = sunS.x * .5 + .5, sy = sunS.y * .5 + .5, onScr = facing && sx > -.3 && sx < 1.3 && sy > -.3 && sy < 1.3;
    // pass 5: light shafts at half size, then a horizontal and a vertical blur -> rtHalf
    const RY = mRays.uniforms; RY.tC.value = rtComp.texture; RY.tDepth.value = rtScene.depthTexture; RY.uNF.value.set(...nf); RY.uSun.value.set(sx, sy); RY.uK.value = onScr ? (L.rays ?? 0) : 0; RY.uAsp.value = W / H;
    pass(mRays, rtHalf); mBlur.uniforms.tA.value = rtHalf.texture; mBlur.uniforms.uDir.value.set(1.5 / (W >> 1), 0); pass(mBlur, rtHalf2);
    mBlur.uniforms.tA.value = rtHalf2.texture; mBlur.uniforms.uDir.value.set(0, 1.5 / (H >> 1)); pass(mBlur, rtHalf);
    // pass 6: bloom. Bright pass into blooms[0] (half size), halve six times, then add each level back up into ups[]
    mPre.uniforms.tC.value = rtComp.texture; mPre.uniforms.uT.value.set(.5 / W, .5 / H); mPre.uniforms.uTh.value = L.th ?? .8; pass(mPre, blooms[0]);
    for (let i = 1; i < blooms.length; i++) { mDown.uniforms.tC.value = blooms[i - 1].texture; mDown.uniforms.uT.value.set(1 / blooms[i - 1].width, 1 / blooms[i - 1].height); pass(mDown, blooms[i]); }
    let src = blooms[blooms.length - 1];
    for (let i = blooms.length - 1; i > 0; i--) { mUp.uniforms.tC.value = src.texture; mUp.uniforms.tB.value = blooms[i - 1].texture; mUp.uniforms.uT.value.set(1 / src.width, 1 / src.height); mUp.uniforms.uW.value = .9; pass(mUp, ups[i - 1]); src = ups[i - 1]; }
    // pass 7: final, to the canvas. ups[0] holds every bloom level (the bloom), ups[2] only the levels at 1/8 size and
    // smaller (the wide glow). The look keys are read here, each with its default.
    const Fu = mFinal.uniforms; Fu.tC.value = rtComp.texture; Fu.tBl.value = ups[0].texture; Fu.tGl.value = ups[2].texture; Fu.tR.value = rtHalf.texture;
    Fu.uExp.value = L.exp ?? 1; Fu.uBloom.value = L.bloom ?? .45; Fu.uGlow.value = L.glow ?? .16; Fu.uSat.value = L.sat ?? 1.08; Fu.uCon.value = L.con ?? 1.04;
    Fu.uLift.value.set(...(L.lift || [.01, .014, .03])); Fu.uGain.value.set(...(L.gain || [1, 1, 1])); Fu.uCA.value = L.ca ?? .008; Fu.uVig.value = L.vig ?? .32; Fu.uGrain.value = L.grain ?? .016; Fu.uPaper.value = L.paper ?? .05;
    // the flare is full with the sun at the centre, 40% with the sun on the frame edge, and gone about 0.3 beyond it
    Fu.uFlare.value = L.flare ?? 0; Fu.uSunS.value.set(sx, sy); Fu.uSunVis.value = onScr ? A.clamp(1 - Math.max(Math.abs(sx - .5), Math.abs(sy - .5)) * 1.2) * (L.sunVis ?? 1) : 0;
    Fu.uSpeed.value = L.speed || 0; Fu.uSpeedC.value.set(...(L.speedC || [.5, .5]), 0); Fu.uFlash.value = L.flash || 0; Fu.uInvert.value = L.invert || 0;
    Fu.uFade.value = L.fade || 0; Fu.uFadeC.value.set(...(L.fadeC || [0, 0, 0])); Fu.uBars.value = L.bars || 0;
    // film grain gets a new pattern on twos (12 a second) when the world is 'live', on fours (6) in silence (bible M18);
    // the seed comes from film time, so the same moment always shows the same grain. The paper tooth never moves.
    // (M18 in the bible describes a per-pixel mask rebuilt from depth; the engine takes one value per frame from the shot.)
    U.uLive.value = L.live ?? 1; const step = U.uLive.value > .5 ? 12 : 6; Fu.uSeed.value = (Math.floor(U.uTime.value * step) * 7.31) % 1;
    Fu.uSpeedMode.value = L.speedMode || 0; Fu.uBow.value = L.rainbow || 0; Fu.uImpact.value = L.impact || 0; Fu.uImpactC.value.set(L.impactC || '#E4572E').convertLinearToSRGB(); Fu.uLeak.value = L.leak || 0;
    Fu.uShock0.value.set(...(L.shock && L.shock[0] || [0, 0, 0, 0])); Fu.uShock1.value.set(...(L.shock && L.shock[1] || [0, 0, 0, 0]));
    // the camera's world matrix and half-frame tangents let the rainbow rebuild each pixel's ray in world space
    Fu.tDepth.value = rtScene.depthTexture; Fu.uNF.value.set(...nf); Fu.uCW.value.copy(cam.matrixWorld); const ty = Math.tan(fov / 2); Fu.uTan.value.set(ty * cam.aspect, ty);
    pass(mFinal, null);
  };
})();
