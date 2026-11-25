// main.js - the projector: builds the valley behind the loader, then runs one clock for picture and sound.
// It is the last script on the page (tools/build.py), so every module already exists when it runs.
//
// Boot (boot() below), one step at a time behind the loader so its bar can move:
//   1. every module's steps(scene): a list of [Korean label, build function] (world, life, rain, cast, crowd; stub.js
//      instead of the world when world.js is left out). A step that throws is logged in FILM.bootErrors and the film goes
//      on without it, so one broken module cannot stop the rest.
//   2. finalize(scene) of every module (e.g. rain.js gathers the beads other modules registered with FILM.rain.addBeads)
//   3. setup(scene) of every shot (film/scenes/sNN.js registers itself with FILM.scene)
//   4. shader warm-up: draw the scene in 8 slices so every GPU program compiles now, not in the middle of the film
//   5. wait for a click or key (the browser only starts sound after a user gesture), or start at once with ?t= / ?shots,
//      or record with ?rec=
// A frame (frame(t) below, t in film seconds):
//   FILM.U.uTime / uHeld -> each module's update(t, dt, cam) (valley, world, life, rain, cast, crowd) -> the shot that owns t
//   returns { cam: { pos, look, fov, roll?, near? }, look: { post settings } } -> the shot's grade from FILM.score.GRADE fills
//   in what the shot left out -> the camera is placed -> world.afterCamera -> engine.render(scene, camera, look)
// People and creatures are posed at held times (FILM.anim.held, 12 drawings a second); camera, light, water, rain every frame.
// The clock: while the sound plays, the picture follows the audio clock (FILM.music.clock()), so they cannot drift apart.
//
// URL options:  ?t=SECONDS start there (no loader prompt)   &still paused   ?shots the mode tools/shot.mjs uses
//               ?rec=1920x1080&fps=30[&from=S&dur=S] render every frame at a fixed step and post it to tools/record.py
// Keys: Space pause, Left/Right previous / next shot, R from the start, M mute, F full screen, 2 drawings on twos or ones,
//       H hide the hints.
// FILM.dev (for tools/shot.mjs and the browser console; nothing in the film depends on it):
//   still(t, w) and sheet(times, cols, w) -> JPEG data URL of one moment / a labelled contact sheet
//   sheetTest(name, ks, cols, w, t) -> a sheet of a module's test view FILM.test[name](k, s) for each k
//   override = s => ({ cam, look })   take over the camera (null gives it back)      T (get / set the film time)
//   sweep(step) -> { n, hits }   checks every camera of the film (see below)        time(n) -> ms per frame
//   frame, scene, cam, renderer, dyn (render scale), bootMs (ms per boot step), shots, LEN
(function () {
  const F = window.FILM, A = F.anim, E = F.engine;
  const $ = id => document.getElementById(id);
  const canvas = $('film');
  const qs = new URLSearchParams(location.search);
  const REC = (qs.get('rec') || '').split('x').map(Number).filter(n => n > 0);   // [w, h] in record mode, else []
  // preserveDrawingBuffer only for ?shots, so the shot tool can copy the canvas after a frame is drawn
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: qs.has('shots') }); }
  catch (e) { $('st').textContent = 'WebGL 2를 쓸 수 없습니다 · WebGL 2 is not available'; throw e; }
  const dpr = REC.length === 2 ? 1 : Math.min(window.devicePixelRatio || 1, 2); renderer.setPixelRatio(dpr);
  E.init(renderer);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 6000);
  scene.add(cam); E.addSun(scene);
  F.three = { scene, cam, renderer };
  // dyn: the internal render scale (.7..1), lowered when frames are slow (see loop); T: the film time now
  let dyn = 1, T = 0, playing = false, paused = false, hud = true;
  // the canvas fills the window (or is exactly the record size); the engine's render targets follow at dyn
  const resize = () => { const w = REC.length === 2 ? REC[0] : (canvas.clientWidth || innerWidth), h = REC.length === 2 ? REC[1] : (canvas.clientHeight || innerHeight);
    renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); E.resize(w * dpr, h * dpr, dyn); };
  addEventListener('resize', resize); resize();

  // ---- shots: every scene file registers itself with FILM.scene({id, t0, t1, ...}); they are sorted by start time
  const order = () => Object.values(F.scenes).sort((a, b) => a.t0 - b.t0);
  let SHOTS = [];
  const LEN = () => (F.score && F.score.LEN) || (SHOTS.length ? SHOTS[SHOTS.length - 1].t1 : 60);
  const shotAt = t => { let k = 0; for (let i = 0; i < SHOTS.length; i++) if (t >= SHOTS[i].t0) k = i; return SHOTS[k]; };

  // ---- loading: every module offers steps [label, fn]; they run one by one behind the loader
  const steps = [];
  const bootMs = [];
  async function boot() {
    const add = m => { if (m && m.steps) { let ss = []; try { ss = m.steps(scene); } catch (e) { console.error(e); } for (const s of ss) steps.push(s); } };
    if (!F.world && F.stub) add(F.stub);      // a plain valley while world.js is missing
    for (const m of ['valley', 'world', 'life', 'rain', 'cast', 'crowd']) add(F[m]);
    SHOTS = order(); F.shots = SHOTS;
    // after every module has built: a last pass (e.g. rain gathers the beads other modules registered with FILM.rain.addBeads)
    steps.push(['물방울을 모으는 중', () => { for (const m of MODS) { const M = F[m]; if (M && M.finalize) { try { M.finalize(scene); } catch (e) { console.error(m + '.finalize: ' + (e && e.stack || e)); } } } }]);
    steps.push(['장면을 맞추는 중', () => SHOTS.forEach(s => s.setup && s.setup(scene))]);
    // shaders: the GPU (ANGLE on Direct3D) compiles each program at its first draw, one by one, so the first visit takes a while.
    // Draw the scene in slices (hidden objects too, so nothing stalls mid-film) and move the bar between slices.
    // Later visits reuse the browser's shader cache and take well under a second.
    steps.push(['셰이더를 굽는 중', async () => { const t0 = qs.has('t') ? +qs.get('t') : 0, kids = scene.children.filter(o => !o.isLight && !o.isCamera), N = 8;
      frame(t0, 1 / 60, true); const vis0 = kids.map(o => o.visible);   // put every object back as the modules left it
      for (let g = 0; g < N; g++) { const part = new Set(kids.slice(Math.floor(g * kids.length / N), Math.floor((g + 1) * kids.length / N)));
        $('st').textContent = `셰이더를 굽는 중 ${g + 1}/${N} · 처음 한 번만 오래 걸려요`; $('bar').firstChild.style.width = ((steps.length - 1 + g / N) / steps.length * 100) + '%';
        await new Promise(r => setTimeout(r, 16));
        preRender = () => { for (const o of kids) o.visible = part.has(o); };
        try { frame(t0, 1 / 60); } catch (e) { console.error('compile slice ' + g + ': ' + (e && e.stack || e)); } }
      preRender = null; kids.forEach((o, i) => { o.visible = vis0[i]; }); frame(t0, 1 / 60); renderer.compile(scene, cam); }]);
    for (let i = 0; i < steps.length; i++) { $('st').textContent = steps[i][0]; $('bar').firstChild.style.width = (i / steps.length * 100) + '%';
      await new Promise(r => setTimeout(r, 16)); const t0 = performance.now();
      // one module failing to build must not stop the others (the error is logged and the film goes on without it)
      try { const r = steps[i][1](); if (r && r.then) await r; } catch (e) { console.error('step failed: ' + steps[i][0] + ': ' + (e && e.stack || e)); F.bootErrors = (F.bootErrors || []).concat(steps[i][0] + ': ' + e.message); }
      bootMs.push([steps[i][0], Math.round(performance.now() - t0)]); }
    $('bar').firstChild.style.width = '100%';
    frame(0, 1 / 60);
    // start: record, or play at once (?t= / ?shots; the sound starts on the first click), or wait for a click or key
    if (REC.length === 2) { $('ld').remove(); return record(+qs.get('fps') || 30, +qs.get('from') || 0, +qs.get('dur') || LEN()); }
    if (qs.has('t') || qs.has('shots')) { $('ld').remove(); playing = true; T = +qs.get('t') || 0; paused = qs.has('still') || qs.has('shots');
      canvas.addEventListener('pointerdown', () => F.music && F.music.start(), { once: true }); F.ready = true; loop(); return; }
    $('st').textContent = '눌러서 시작 · 소리가 납니다'; $('ld').classList.add('ready');
    const go = () => { $('ld').removeEventListener('pointerdown', go); removeEventListener('keydown', key1); F.music && F.music.start(); $('ld').style.opacity = 0; setTimeout(() => $('ld').remove(), 1000);
      playing = true; T = 0; showHud('Space 멈춤 · ←/→ 장면 · R 처음부터 · M 소리 · F 전체 화면 · 2 원화 간격 · H 안내 숨기기'); };
    const key1 = e => { if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); go(); } };
    $('ld').addEventListener('pointerdown', go); addEventListener('keydown', key1);
    F.ready = true; loop();
  }
  // the loader's hanging drops
  (() => { const d = $('drops'); if (!d) return; for (let i = 0; i < 46; i++) { const s = document.createElement('s'), r = A.hash(i, 3);
    s.style.left = (A.hash(i, 1) * 100) + '%'; s.style.top = (A.hash(i, 2) * 100) + '%'; const k = .5 + r * 1.6; s.style.width = s.style.height = (4 + r * 9) + 'px';
    s.style.opacity = .25 + .5 * A.hash(i, 4); s.style.animationDelay = (-A.hash(i, 5) * 3) + 's'; s.style.animationDuration = (2.4 + k) + 's'; d.appendChild(s); } })();

  // ---- one frame
  const lookAt = V => Array.isArray(V) ? new THREE.Vector3(...V) : V;
  const shadeTmp = new THREE.Color();
  // override: a function that replaces the shot (test views, FILM.dev.override); preRender: a hook run just before drawing
  // (the shader warm-up uses it to show one slice of the scene at a time)
  let lastShot = null, override = null, preRender = null; const MODS = ['valley', 'world', 'life', 'rain', 'cast', 'crowd'], errOnce = {};
  F.test = F.test || {};   // test views: FILM.test[name] = (k, s) => ({cam, look}); tools/shot.mjs --test name --k 0,1,2
  // Draw film time t (dt: seconds since the last frame, 0 when paused; noRender: pose everything but do not draw).
  // A module that throws in update() is reported once and skipped, so the film keeps running.
  // The shot gets s = { t: seconds into the shot, abs: film time, u: 0..1 through the shot, dur, held / habs: the same
  // two times on twos, dt, cam } and returns { cam, look, keepShade? }.
  function frame(t, dt, noRender) {
    const th = A.held(t);
    F.U.uTime.value = t; F.U.uHeld.value = th;
    for (const m of MODS) { const M = F[m]; if (M && M.update) { try { M.update(t, dt, cam); } catch (e) { if (!errOnce[m]) { errOnce[m] = 1; console.error(m + '.update: ' + (e && e.stack || e)); } } } }
    const sh = shotAt(t); let out = { cam: { pos: [0, 2, 10], look: [0, 1, 0], fov: 35 }, look: {} };
    if (override) out = override({ t, abs: t, held: th, habs: th, dt, cam }) || out;
    else if (sh) { if (sh !== lastShot) { lastShot = sh; sh.enter && sh.enter(); }
      out = sh.update({ t: t - sh.t0, abs: t, u: A.clamp((t - sh.t0) / (sh.t1 - sh.t0)), dur: sh.t1 - sh.t0, held: th - sh.t0, habs: th, dt, cam }) || out; }
    // the grade of the shot (score.GRADE), under whatever the shot asks for: a value the shot set itself wins.
    // The shadow tint uShade goes 55% of the way from white to the shot's shade colour, unless the shot keeps its own.
    const gk = sh && F.score.GRADE && F.score.GRADE[sh.id];
    if (gk) { const L = out.look || (out.look = {});
      if (L.lift == null) L.lift = gk.lift; if (L.gain == null) L.gain = gk.gain; if (L.sat == null) L.sat = gk.sat; if (L.th == null) L.th = gk.th;
      if (L.bars == null) L.bars = F.score.bars(t); if (L.ink == null) L.ink = gk.ink;
      if (!out.keepShade) { shadeTmp.set(gk.shade); F.U.uShade.value.setRGB(1, 1, 1).lerp(shadeTmp, .55); } }
    // place the camera: position, aim (y up), then roll, lens and near plane only when they change
    const c = out.cam;
    if (c) { cam.position.copy(lookAt(c.pos)); cam.up.set(0, 1, 0); cam.lookAt(lookAt(c.look));
      if (c.roll) cam.rotateZ(c.roll); if (c.fov && c.fov !== cam.fov) { cam.fov = c.fov; cam.updateProjectionMatrix(); }
      if (c.near && c.near !== cam.near) { cam.near = c.near; cam.updateProjectionMatrix(); } }
    cam.updateMatrixWorld();
    if (F.world && F.world.afterCamera) F.world.afterCamera(t, cam);
    if (preRender) preRender();
    if (!noRender) E.render(scene, cam, out.look || {});
    return out;
  }
  // dev: run the whole film without drawing and list every moment the camera is somewhere it must not be, or loses Pell.
  // FILM.dev.sweep() -> { n, hits: [{ what, t0, t1 }] }. Pell must be on screen in the shots that are about her.
  // Every 1/8 s it checks: a NaN camera; the camera under the ground (+ .2 m), inside a house's roof or walls, inside Pell
  // or her hood brim; and, in her shots, that a point at her knees, waist or chest projects inside the frame.
  // Hits next to each other merge into one span. 0 hits is the goal.
  const PELL_SHOTS = new Set(['s04', 's08', 's09', 's10', 's11', 's12', 's13', 's16', 's17']);
  const POV = [[22.5, 23.3]];   // s04's reverse is her point of view: she is meant to be off screen there
  function sweep(step = 1 / 8) {
    const V = F.valley, P = F.path, hits = [], v = new THREE.Vector3(), saved = T;
    const add = (t, what) => { const h = hits.find(h => h.what === what && t - h.t1 < step * 1.6); if (h) h.t1 = +t.toFixed(3); else hits.push({ what, t0: +t.toFixed(3), t1: +t.toFixed(3) }); };
    for (let t = 0; t < LEN(); t += step) { frame(t, step, true); const c = cam.position, sh = shotAt(t);
      if (!isFinite(c.x + c.y + c.z)) { add(t, 'camera NaN'); continue; }
      if (c.y < V.ground(c.x, c.z) + .2) add(t, 'camera in ground (' + sh.id + ')');
      for (const h of V.houses) { const dx = c.x - h.pos[0], dz = c.z - h.pos[2]; if (dx * dx + dz * dz > 64) continue; const co = Math.cos(h.rot), si = Math.sin(h.rot), lx = dx * co - dz * si, lz = dx * si + dz * co, ly = c.y - h.pos[1];
        const ry = V.roofY(h, lx, lz); if ((ry != null && ly < ry && ly > 2.2 * h.size) || (Math.abs(lx) < V.HOUSE.body.hx * h.size && Math.abs(lz) < V.HOUSE.body.hz * h.size && ly > 2.2 * h.size && ly < 4.9 * h.size)) add(t, 'camera in house (' + sh.id + ')'); }
      const pp = P.pell(t).pos, d = Math.hypot(c.x - pp[0], c.y - pp[1] - .7, c.z - pp[2]); if (d < .3) add(t, 'camera in Pell (' + sh.id + ')');
      { const hh = P.pellHead(t); if (Math.hypot(c.x - hh[0], c.y - hh[1], c.z - hh[2]) < .45) add(t, 'camera in her hood brim (' + sh.id + ')'); }
      if (PELL_SHOTS.has(sh.id) && !POV.some(([a, b]) => t >= a && t < b)) { let seen = false; for (const hy of [.35, .75, 1.15]) { v.set(pp[0], pp[1] + hy, pp[2]).project(cam); if (v.z < 1 && Math.abs(v.x) < 1.02 && Math.abs(v.y) < 1.02) seen = true; }
        if (!seen) add(t, 'Pell off screen (' + sh.id + ')'); } }
    T = saved; frame(T, 1 / 60); return { n: hits.length, hits };
  }

  // ---- the hint line at the bottom (fades after 6.5 s) and the keys
  let hudT; function showHud(s) { const h = $('hud'); h.textContent = s; h.style.opacity = hud ? 1 : 0; clearTimeout(hudT); hudT = setTimeout(() => (h.style.opacity = 0), 6500); }
  addEventListener('keydown', e => { if (!playing) return; const k = e.key.toLowerCase();
    if (e.code === 'Space') { paused = !paused; F.music && F.music.pause(paused); showHud(paused ? '멈춤' : '재생'); e.preventDefault(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const i = SHOTS.indexOf(shotAt(T)), n = SHOTS[A.clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, SHOTS.length - 1)]; T = n.t0 + .001; F.music && F.music.seek(T); showHud((n.title || n.id)); }
    else if (k === 'r') { T = 0; F.music && F.music.seek(0); showHud('처음부터'); }
    else if (k === 'm') showHud(F.music && F.music.mute() ? '소리 끔' : '소리 켬');
    else if (k === '2') { A.heldOn = !A.heldOn; showHud(A.heldOn ? '원화 간격: 2프레임(애니메이션처럼)' : '원화 간격: 매 프레임'); }
    else if (k === 'h') { hud = !hud; $('hud').style.opacity = hud ? 1 : 0; }
    else if (k === 'f') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); } });

  // ---- the clock. Sound leads when it is playing (the picture follows the audio clock); internal resolution gives way when slow
  // The film loops at LEN. Resolution: frames over 30 ms for about 2 s in total lower dyn by 8% (not below .7); frames
  // under 21 ms for 1.5 s raise it again. Hidden tabs, long hitches (> .12 s) and paused or ?shots runs do not count.
  let prev = performance.now(), prevRaw = prev, slow = 0, fast = 0;
  document.addEventListener('visibilitychange', () => { slow = 0; fast = 0; });
  function loop() {
    requestAnimationFrame(loop);
    const now = performance.now(), dt = Math.min((now - prev) / 1000, .1); prev = now;
    if (playing && !paused) { const at = F.music && F.music.clock ? F.music.clock() : null; T = at != null ? at : T + dt; if (T >= LEN()) { T = 0; F.music && F.music.seek(0); } }
    frame(T, paused ? 0 : dt); if (F.overlay) F.overlay(T);
    const raw = (now - prevRaw) / 1000; prevRaw = now;
    if (!document.hidden && raw < .12 && playing && !paused && !qs.has('shots')) {
      if (raw > .03) { slow += raw; fast = Math.max(0, fast - raw); } else if (raw < .021) { fast += raw; slow = Math.max(0, slow - raw); }
      if (slow > 2 && dyn > .7) { dyn = Math.max(.7, dyn * .92); slow = 0; fast = 0; resize(); }
      else if (fast > 1.5 && dyn < 1) { dyn = Math.min(1, dyn * 1.1); fast = 0; resize(); } }
  }

  // ---- recording: every frame at a fixed step posted as raw RGBA to tools/record.py (which pipes it to ffmpeg), then the score as WAV
  // wav(): an AudioBuffer -> a 16-bit PCM WAV file (44-byte RIFF header, then interleaved samples)
  const wav = b => { const n = b.length, ch = b.numberOfChannels, dv = new DataView(new ArrayBuffer(44 + n * ch * 2)), w = (o, str) => [...str].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, b.sampleRate, true);
    dv.setUint32(28, b.sampleRate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
    const cs = [...Array(ch)].map((_, c) => b.getChannelData(c)); let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { dv.setInt16(o, Math.max(-1, Math.min(1, cs[c][i])) * 32767, true); o += 2; } return dv.buffer; };
  // the protocol with tools/record.py: POST /begin (size, fps), POST /frame per frame (titles drawn on top), POST /audio
  // (the score rendered offline for the same span), POST /end (the server muxes video and sound). Progress shows in the tab title.
  async function record(fps, from = 0, dur = LEN()) { const [W, H] = REC, c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const g2 = c2.getContext('2d', { willReadFrequently: true });
    const post = (u, body) => fetch(u, { method: 'POST', body }).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); });
    await post(`/begin?w=${W}&h=${H}&fps=${fps}`); const N = Math.floor(Math.min(dur, LEN() - from) * fps), t0 = performance.now();
    for (let k = 0; k < N; k++) { const t = from + k / fps; T = t; frame(t, k ? 1 / fps : 1 / 60); g2.drawImage(canvas, 0, 0, W, H); if (F.titles) F.titles(g2, t, W, H);
      await post('/frame', g2.getImageData(0, 0, W, H).data); if (k % 15 === 0) document.title = `REC ${k}/${N} ${((performance.now() - t0) / 1000).toFixed(0)}s`; }
    if (F.music && F.music.offline) { document.title = 'REC audio'; await post('/audio', wav(await F.music.offline(48000, from, dur))); }
    document.title = 'REC muxing'; await post('/end'); document.title = 'REC done'; }

  // ---- a handle for tools/shot.mjs and the console; nothing in the film depends on it
  F.dev = { bootMs, sweep, get T() { return T; }, set T(v) { T = v; }, frame, scene, cam, renderer, get dyn() { return dyn; }, set dyn(v) { dyn = v; resize(); },
    // draw a moment and return it as a JPEG data URL (w px wide)
    still(t, w = 960) { frame(t, 1 / 60); const c = document.createElement('canvas'), h = Math.round(w * canvas.height / canvas.width); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(canvas, 0, 0, w, h); if (F.titles) F.titles(g, t, w, h); return c.toDataURL('image/jpeg', .9); },
    // a contact sheet: many moments on one image, labelled with their times
    sheet(times, cols = 4, w = 480) { const h = Math.round(w * canvas.height / canvas.width), rows = Math.ceil(times.length / cols), c = document.createElement('canvas'); c.width = cols * w; c.height = rows * h; const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.font = '600 13px system-ui'; times.forEach((t, i) => { frame(t, 1 / 60); const x = (i % cols) * w, y = Math.floor(i / cols) * h; g.drawImage(canvas, x, y, w, h); if (F.titles) { g.save(); g.translate(x, y); F.titles(g, t, w, h); g.restore(); }
        const sh = shotAt(t); const lab = `${t.toFixed(2)}s ${sh ? sh.id : ''}`; g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x, y, g.measureText(lab).width + 10, 19); g.fillStyle = '#ffe28a'; g.fillText(lab, x + 5, y + 14); });
      return c.toDataURL('image/jpeg', .88); },
    // the same for a test view (k values instead of times; t = film time for everything that moves)
    sheetTest(name, ks, cols = 4, w = 480, t = 0) { const h = Math.round(w * canvas.height / canvas.width), rows = Math.ceil(ks.length / cols), c = document.createElement('canvas'); c.width = cols * w; c.height = rows * h; const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.font = '600 13px system-ui'; ks.forEach((k, i) => { override = s => F.test[name](k, s); frame(t, 1 / 60); override = null; const x = (i % cols) * w, y = Math.floor(i / cols) * h; g.drawImage(canvas, x, y, w, h);
        const lab = `${name} k=${k}`; g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x, y, g.measureText(lab).width + 10, 19); g.fillStyle = '#9fe8ff'; g.fillText(lab, x + 5, y + 14); });
      return c.toDataURL('image/jpeg', .88); },
    // take over the camera: fn(s) -> { cam, look } replaces the shot's answer until set back to null
    set override(fn) { override = fn; }, get override() { return override; },
    // ms per frame at the current T: n frames between two 1-pixel readPixels, which wait for the GPU to finish
    time(n = 10) { const gl = renderer.getContext(), px = new Uint8Array(4); frame(T, 1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); const t0 = performance.now();
      for (let i = 0; i < n; i++) frame(T, 1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return (performance.now() - t0) / n; },
    get shots() { return SHOTS.map(s => [s.id, s.t0, s.t1, s.title || '']); }, LEN };
  boot().catch(e => { console.error(e); $('st').textContent = '오류: ' + e.message; });
})();
