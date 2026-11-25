# CONTRACT — how the modules of STILLRAIN fit together

> **About this file.** This is the build contract, written before the modules were built: how the code is split, what
> each module offers the others, the shared conventions and the budgets. The "owner" column, the editing rule and the
> report section at the end record how the work was divided between the module builders. **The code is the final word:**
> each file's header comment and the Korean module docs (`film/WORLD.md`, `film/RAIN.md`, `film/CAST.md`, `film/LIFE.md`,
> `music/SOUND.md`) describe what was built. `film/BIBLE.md` lists where the film departs from the plan.

Read `film/BIBLE.md` first (the world, cast, places, motions, shot list, music, look). This file says how the code is split
and what every module must offer. The film is one HTML page: pure three.js r170 (global `THREE`, no addons), zero assets
(no images, models, fonts or sound files: everything is made by code at load), Web Audio for sound, no network.

## Layout and ownership

| file | owner | what |
|---|---|---|
| `film/anim.js` `film/engine.js` `film/sculpt.js` `film/main.js` `film/stub.js` | lead | timing kit, renderer + anime materials + post, SDF sculpting, projector |
| `music/score.js` `film/valley.js` `film/path.js` `film/events.js` | lead | clock + shots + grades, the map, the choreography, the toll table |
| `film/world.js` (+ `film/WORLD.md`) | world | terrain, terraces and walls, pond, village, masts, cisterns, peaks, sky, clouds, light by time |
| `film/rain.js` (+ `film/RAIN.md`) | rain | the rain-field, strands, local beads, story drops, hero drops, splashes, sound rings |
| `film/cast.js` (+ `film/CAST.md`) | cast | Pell, Tock, Old Dun: sculpted, rigged, face shader, poses |
| `film/life.js` `film/crowd.js` (+ `film/LIFE.md`) | life | cup-leaves, reeds, sprouts, sky-vines, frogs, snails, chimewings, moths; villagers, fanners, Listeners, the hush-cloth |
| `music/synth.js` `tools/listen.mjs` (+ `music/SOUND.md`) | sound | every sound, scheduled from the same tables |
| `film/scenes/sNN.js` `film/camera.js` `film/titles.js` | lead (later) | the 17 shots, the camera kit they share, the title |

**Only edit the files you own.** If a shared file is wrong or missing something you need, work round it in your own file
and say exactly what you need in your report. Never edit `engine.js`, `main.js`, `valley.js`, `path.js`, `events.js`, `score.js`, `build.py`, `shot.mjs`.

## Build and look (every module must be checked by looking at real frames)

```bash
cd stillrain
python tools/build.py --check --out build/<you>.html --skip <other modules' files, comma separated>
node tools/shot.mjs --page build/<you>.html --test <view> --k 0,1,2,3 --cols 2 --w 800 --out build/<you>-<view>.jpg [--at <film time>]
node tools/shot.mjs --page build/<you>.html --t 12,27.5 --cols 2 --w 800 --out build/<you>-t.jpg     # film moments (once scenes exist)
```

- `--skip` the other modules while they are being written (their files may be half done). With `film/world.js` skipped, `film/stub.js` draws a plain valley so you still have ground and sky.
- The shot tool runs headless Chrome on the real GPU and prints JSON: boot times per step, a frame time in ms (`ms`), and console errors (`logs`). **Fix every error it prints.** Open the JPG with the Read tool and look at it. Judge it as an anime background artist / animator would.
- `--eval "js"` runs code before shooting; `--print "js"` prints a value after. `FILM.dev.override = s => ({cam, look})` takes over the camera.
- Test views: register `FILM.test['<view>'] = (k, s) => ({ cam: { pos: [x,y,z], look: [x,y,z], fov }, look: { ... } })`. Inside it you may also pose your objects for that k. `s.t` is the film time given by `--at`. Keep your test views in your file: they stay useful for everyone.

## Conventions

- Metres, y up, east +x, north −z. The valley is a bowl centred on the origin (see `film/valley.js`). The sun is high in the south-ish.
- Time: film seconds 0–93. **Everything is a pure function of film time** (no state that needs the previous frame), so any frame can be drawn on its own (seeking, stills, recording). Simulations, if any, must be closed-form or re-run deterministically from a fixed start.
- Characters, creatures, crowd, cup-leaves and sprouts are posed at **held time** `FILM.anim.held(t)` (12 drawings a second, "on twos"); camera, water, drops, cloth tassels and light move every frame. `FILM.U.uHeld` is the held time for shaders.
- Randomness: `FILM.anim.named('your-stream')` gives a seeded generator. Never `Math.random()`.
- Colours: sRGB hex in, the engine lights in linear and grades at the end. Anime look: flat cel bands, hue-shifted shadows (never grey), coloured ink lines (never black), painted texture, strong silhouettes. Reference: bible §8.

## A module

```js
window.FILM = window.FILM || {};
(function () {
  const F = FILM, A = F.anim, E = F.engine, V = F.valley, P = F.path, EV = F.events, S = F.sculpt;
  F.rain = {
    steps(scene) { return [['비 무리를 띄우는 중', () => { /* build, scene.add(...) */ }]]; },  // Korean label shown on the loader
    update(t, dt, cam) { /* per frame, pure function of t */ },
    finalize(scene) { /* optional: after every module has built */ },
    /* ...your public API, documented in your .md... */
  };
  F.test['field'] = (k, s) => ({ cam: { pos: [..], look: [..], fov: 40 }, look: { rays: .4 } });
})();
```

Build order (each file its own `<script>`): anim, engine, sculpt, score, valley, path, events, stub, world, life, rain, cast, crowd, camera, scenes, synth, titles, main.
So `rain.js` can read `F.world` and `F.life` at *build-step* time, but not at script-load time; always check that another module exists before using it.

## The engine (film/engine.js)

- `FILM.U`: shared uniforms. `uTime uHeld uSunDir uSunCol uShade uSkyFill uBounce uRimCol uSkyTop uSkyHor uSkyLow uFogCol uFog(vec4 density,heightFalloff,baseY,max) uPx uWorld(vec4 free) uWind uInkFlip uRes uLive tNoise`, plus from events.js `uEv uEvP uEvN`.
  `E.COMMON` (GLSL) declares them and gives `nz nzA grain cells h12 tri3 skyAt fogApply`.
- `E.toon(opts)`: cel material with three's shadow map. opts: `color vcol shade rim spec paint grad[y0,y1,amount] soft wrap emit alpha side transparent shadowK fog uniforms`
  and GLSL hooks `vpars vnormal vdeform` (vertex: change `transformed`, `objectNormal`; `P0` is the rest position) and `fpars fpre fpost` (fragment: `fpre` may change `base`, `N`, `lightK`; `fpost` may change `c`). Supports `InstancedMesh` (instanceMatrix, instanceColor) and `SkinnedMesh`. Varyings `vWP` (world pos), `vWN` (world normal), `vOP` (object pos).
- `E.outline(mesh, {color, px, max})`: inverted-hull ink, `px` screen pixels at 1080p (1.6–2.4), `max` world cap. Uses the same `vdeform` as the mesh. Default colour is a darkened, violet-shifted base.
- `E.mesh(geo, mat, {cast, receive, line})`. `E.cloud(opts)`, `E.skyMat(opts)`, `E.glass(opts)` + layer `E.GLASS` (refracts the opaque picture; set `mesh.layers.set(E.GLASS)`).
- `E.sun` (DirectionalLight with a 4096 shadow map), `E.shadowFit(centerVector3, radius)` (the shots call this; a module may call it in its test views).
- `look` (what a shot or test view returns): `exp sat con lift gain bloom glow th rays flare sunVis focus ap edge edgeFar ca vig grain paper speed speedMode speedC flash invert impact impactC rainbow leak shock ink live fade fadeC bars glass`.

## The shared tables

- `FILM.score`: `BPM 80, BEAT .75, BAR 3, LEN 93, tb(bar, beat), hz(note), midi(note), pc(), WET, DRY, SHOTS[{id,t0,t1,ko,en}], shotAt(t), GRADE, bars(t)`.
- `FILM.valley`: `ground(x,z)` (JS) and `GLSL` (`float vGround(vec2 xz)`, identical), `ringR(k, th)`, `onTerrace(k, th, u)`, `terraceAt(x,z)`, `normalAt`, `TH 3.2`, `R0 40`, `NT 9`, `places` (`tollTerrace{drum, masts}`, `spillway{mast, mastH, bench, hut, notch}`, `cisternRow{k, th0, th1}`, `pellRoof{house}`), `houses[{k, th, pos, size, rot, seed, pell?, hut?}]`, `HOUSE` anatomy, `roofY(house, lx, lz)`, `houseToWorld(house, lx, ly, lz)`, `masts[{k,pos,h,chime?,spill?}]`, `cisterns[{pos,size}]`, `cupolas[[x,y,z]]`.
- `FILM.path`: `FIELD {base 44, rx 80, rz 55, heavy [0,14], marble [12,26], mist [24,38]}`, `fieldC(t)`, `gust(t)`, `GLSL` (`fieldC`, `gustK`), `pell(t) → {pos, yaw, state, air, on}`, `PELL_H 1.38`, `pellHead(t)`, `pellHand(t)`, `hops[{local, r, ts, tr}]`, `H {local, r, ts 54, tr 69}`, `topOf(drop, t)`, `jelly(tau) → [a2, a3]`, `fallY`, `dun(t)`, `fans(t)`, `FANS_ON(t)`, `cloth {pos, r, ground}`, `kid`, `frog`, `special {macro, frog, nose, face, palm}`, `palmPos`, `mastTop`, `pellRoofSpot`.
  Pell's states: `roof run watch walk grip sprint leap crouch climb step hop bell still sing fall land sit stand bench`.
- `FILM.events`: `T` (22 tolls `{id, t0, src, note, band 0 heavy|1 marble|2 mist, kind, reach, dur, hold}`), `releaseTime(local, drifting, band, seed, since)`, `fall(tau, band)`, `hitTau(dh, band)`, `arrivals(p, t)`, `wetAt(x, z, t)`, `VT [14, 9, 2.2]`, `C_SOUND 30`, and `GLSL` with the same `releaseTime(local, drifting, band, seed, since)`, `fallDist`, `fallVel`, `hitTau`, `evFlash(p, t, w)`, `evTremble(p, t, band)`, `evSince(p, t)` (include `FILM.path`'s GLSL is already inside it). Add `FILM.events.GLSL` (and `FILM.valley.GLSL` if you need the ground) to your shader's pars; the uniforms are already in `FILM.U`.

## Budgets (RTX 2070 Max-Q, 1080p, all modules together must hold about 60 fps in the field shots)

| module | boot | frame (GPU) | draw calls |
|---|---|---|---|
| world | ≤ 900 ms | ≤ 3 ms | ≤ 80 |
| rain | ≤ 600 ms | ≤ 5 ms | ≤ 30 |
| cast | ≤ 1500 ms | ≤ 1.5 ms | ≤ 40 |
| life + crowd | ≤ 900 ms | ≤ 2.5 ms | ≤ 50 |

## Your report (what to return at the end)

1. What you built, file by file, and anything from the bible you left out or changed (and why).
2. Your public API (also written in your `.md`, which is the module's reference, like bide's `WORLD.md` / `CAST.md`: one table of calls, options and anchors, short examples).
3. Your test views and the paths of your best stills.
4. Measured boot ms and frame ms.
5. Anything you need from the lead or another module (exact names).
