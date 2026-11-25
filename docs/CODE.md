# 코드 해설

「머문 비」가 어떻게 코드로 짜였는지 따라가는 문서다. 영화를 보는 법과 세계의 규칙은 [README](../README.md)에 있고, 여기서는 기법과 코드를 본다.
모듈마다 자세한 표(호출, 옵션, 시험 화면)는 모듈 문서([`film/WORLD.md`](../film/WORLD.md), [`film/RAIN.md`](../film/RAIN.md), [`film/CAST.md`](../film/CAST.md), [`film/LIFE.md`](../film/LIFE.md), [`music/SOUND.md`](../music/SOUND.md))에, 함수 하나하나의 설명은 소스 파일의 주석에 있다. 기획 단계의 설계는 [`film/BIBLE.md`](../film/BIBLE.md)(영문)에 있고, 코드와 다른 곳은 그 파일 맨 앞에 정리되어 있다.

아래 코드 조각은 모두 저장소의 코드를 그대로 옮긴 것이다. 조각마다 파일과 함수 이름을 적었다.

## 읽는 순서

| 순서 | 파일 | 왜 |
|---|---|---|
| 1 | [`film/anim.js`](../film/anim.js) | 시간 도구. 모든 모듈이 쓰고, 150줄쯤이다 |
| 2 | [`music/score.js`](../music/score.js), [`film/events.js`](../film/events.js), [`film/path.js`](../film/path.js) | 영화의 시계, 울림 표, 동선. 그림과 소리가 함께 읽는 표다 |
| 3 | [`film/main.js`](../film/main.js) | 로딩과 한 프레임이 도는 순서 |
| 4 | [`film/scenes/s05.js`](../film/scenes/s05.js) 같은 장면 파일 하나 | 장면이 카메라와 화면 설정을 돌려주는 방식 |
| 5 | [`film/engine.js`](../film/engine.js) | 셀 재질, 외곽선, 후처리 |
| 6 | 큰 모듈 (`world`, `rain`, `cast`, `life`, `crowd`, `synth`) | 각 파일 맨 위의 머리말부터 읽는다 |

## 1. 전체 구조

### 소스에서 HTML 한 장으로

[`tools/build.py`](../tools/build.py)는 파이썬 표준 라이브러리만 쓴다. 하는 일은 세 가지다.

1. `vendor/three.module.min.js`(ES 모듈)를 일반 스크립트로 바꿔 전역 `THREE`를 만든다.
2. 소스 파일을 정해진 순서대로 `<script>` 태그 하나씩에 넣는다. 태그가 따로라서 한 파일에 문법 오류가 나도 나머지는 돈다.
3. `film/index.src.html`의 `<!--THREE-->`, `<!--FILM-->` 자리에 넣어 `dist/stillrain.html`을 쓰고 `index.html`로 복사한다. 다른 호스트를 가리키는 `src=`나 `href=`가 있으면 경고한다.

three.js를 전역으로 바꾸는 방법은 단순하다. 압축된 모듈 끝의 `export{...}` 목록을 잘라 내고, 나머지를 함수로 감싸 내보낸 이름들을 객체로 돌려준다. `tools/build.py`의 `three_global()`:

```python
    mod = read(P("vendor", "three.module.min.js")).strip()
    m = re.search(r"export\s*\{([^}]*)\}\s*;?\s*$", mod)
    if not m:
        sys.exit("could not find the export list at the end of three.module.min.js")
    body, pairs = mod[: m.start()], []
    for item in m.group(1).split(","):
        item = item.strip()
        if item:
            local, name = [x.strip() for x in item.split(" as ")] if " as " in item else (item, item)
            pairs.append(f"{name}:{local}")
    return "var THREE=(function(){'use strict';" + body + ";return{" + ",".join(pairs) + "};})();"
```

넣는 순서는 `main()`에 적혀 있다.

```python
    # the load order: kits and shared tables first (anim, engine, sculpt, score, valley, path, events), then the modules
    # (stub, world, life, rain, cast, crowd), the camera kit and the shots, the sound, the titles, and main.js last
    files = ["film/anim.js", "film/engine.js", "film/sculpt.js", "music/score.js", "film/valley.js", "film/path.js", "film/events.js",
             "film/stub.js", "film/world.js", "film/life.js", "film/rain.js", "film/cast.js", "film/crowd.js", "film/camera.js"]
    files += sorted(os.path.relpath(f, ROOT).replace(os.sep, "/") for f in glob.glob(P("film", "scenes", "s*.js")))
    files += ["music/synth.js", "film/titles.js", "film/main.js"]
```

순서가 중요한 이유: 스크립트는 불러오는 순간에는 앞에 온 파일만 읽을 수 있다. `valley.js`, `path.js`, `events.js`는 불러오자마자 지도와 표를 만들기 때문에 `anim.js` 뒤에, 서로 이 순서로 온다. `events.js`는 `engine.js`가 만든 `FILM.U`에 울림 표를 유니폼으로 넣으므로 `engine.js`보다도 뒤다.
큰 모듈(`world`, `rain`, `cast` …)은 불러올 때 메시를 짓지 않고 자기 객체를 등록한다. 실제로 메시를 짓는 일은 `main.js`가 로딩 단계에서 시킨다. 그때는 모든 파일이 이미 있으므로 서로를 읽을 수 있다. `main.js`는 맨 끝에서 영화를 시작한다.

`--skip film/world.js`처럼 파일을 빼고 빌드할 수도 있다. 땅을 그리는 `world.js`가 빠지면 [`film/stub.js`](../film/stub.js)가 상자 집과 막대 기둥으로 된 임시 골짜기를 그린다. 모듈 하나를 다른 모듈 없이 만들고 볼 수 있게 하려는 장치다(bide의 `stub.js`와 같은 생각).

### FILM 이름공간

모든 파일은 `window.FILM` 객체 하나에 자기 것을 붙인다.

| 이름 | 파일 | 무엇 |
|---|---|---|
| `FILM.anim` | `film/anim.js` | 시간 도구, 장면 등록 함수 `FILM.scene` |
| `FILM.engine`, `FILM.U` | `film/engine.js` | 렌더러, 모든 셰이더가 함께 쓰는 유니폼 |
| `FILM.sculpt` | `film/sculpt.js` | SDF 조각 도구 |
| `FILM.score` | `music/score.js` | 템포, 장면 시각표, 장면별 색 보정 |
| `FILM.valley`, `FILM.path`, `FILM.events` | `film/valley.js`, `path.js`, `events.js` | 지도, 동선, 울림 표 |
| `FILM.world`, `FILM.rain`, `FILM.cast`, `FILM.life`, `FILM.crowd` | 같은 이름의 파일 | 큰 모듈 |
| `FILM.cam`, `FILM.scenes` | `film/camera.js`, `film/scenes/` | 카메라 도구, 장면 17개 |
| `FILM.music` | `music/synth.js` | 소리 |
| `FILM.titles`, `FILM.overlay` | `film/titles.js` | 제목 |
| `FILM.dev`, `FILM.test` | `film/main.js`, 각 모듈 | 확인 도구, 시험 화면 |

큰 모듈은 모두 같은 모양이다. `steps(scene)`은 `[로더에 보일 한국어 이름, 짓는 함수]` 목록을 돌려주고, `update(t, dt, cam)`은 매 프레임, `finalize(scene)`는 모든 모듈이 지어진 뒤 한 번 불린다.

### 로더 뒤에서 일어나는 일

`film/main.js`의 `boot()`는 모듈마다 `steps()`를 받아 한 줄로 세운다.

```js
    const add = m => { if (m && m.steps) { let ss = []; try { ss = m.steps(scene); } catch (e) { console.error(e); } for (const s of ss) steps.push(s); } };
    if (!F.world && F.stub) add(F.stub);      // a plain valley while world.js is missing
    for (const m of ['valley', 'world', 'life', 'rain', 'cast', 'crowd']) add(F[m]);
```

그 뒤에 세 단계가 더 붙고, 모두 차례로 돈다. 단계 사이마다 16 ms를 쉬어서 로더의 막대가 움직인다. 한 단계가 오류를 내면 `FILM.bootErrors`에 적고 그 단계 없이 계속한다.

| 로더에 보이는 이름 | 누가 |
|---|---|
| 골짜기 땅을 다지는 중 · 하늘을 칠하는 중 · 마을을 세우는 중 · 종 기둥과 물독을 세우는 중 | `world` |
| 잎과 갈대를 심는 중 · 개구리를 빚는 중 · 새와 나방을 풀어 놓는 중 | `life` |
| 비 무리를 띄우는 중 · 마을 물방울을 다는 중 · 큰 물방울을 빚는 중 · 소리의 고리를 거는 중 | `rain` |
| 펠을 빚는 중 · 톡과 던을 빚는 중 | `cast` |
| 마을 사람들을 모으는 중 | `crowd` |
| 물방울을 모으는 중 | 모든 모듈의 `finalize` (예: 다른 모듈이 맡긴 안개 방울을 `rain`이 한 세트로 묶는다) |
| 장면을 맞추는 중 | 장면마다 `setup` |
| 셰이더를 굽는 중 | 장면을 8조각으로 나눠 한 번씩 그려서 GPU 프로그램을 미리 컴파일한다 (12장 참고) |

### 장면 등록

장면 파일 17개는 `FILM.scene({...})`을 불러 자기를 등록한다. 등록 함수는 가장 먼저 불러오는 `film/anim.js` 끝에 있다.

```js
  // the shot registry: each scene file calls FILM.scene({ id, t0, t1, setup?, enter?, update }); main.js sorts them by t0
  // and asks the shot that owns the current time for the camera and the look. It lives here because this file loads first.
  F.scenes = F.scenes || {};
  F.scene = o => { F.scenes[o.id] = o; };
```

장면 하나는 이렇게 생겼다. `film/scenes/s05.js` 전체(주석 머리말 뒤):

```js
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
```

장면은 그림을 그리지 않는다. 카메라(`cam`)와 화면 설정(`look`)을 돌려줄 뿐이다. 인물, 비, 사람들은 모듈이 영화 시각만 보고 알아서 자리를 잡는다.
장면이 모듈에 무언가를 부탁할 때는 대개 그 프레임 동안만 유효한 호출을 쓴다. 예를 들어 `s13`은 `FILM.rain.set({ camVel })`로 카메라 속도를 넘기고, `s10`은 `FILM.cast.pellPose(t, { expr })`로 표정을 정한다. 예외는 `FILM.world.sunOverride`다. `s12`가 이것으로 해를 펠 뒤로 돌리면, 다른 장면이 바꿀 때까지 그대로 남는다(`s13`이 `null`로 되돌린다).

### 한 프레임

`film/main.js`의 `frame(t)` 앞부분:

```js
  function frame(t, dt, noRender) {
    const th = A.held(t);
    F.U.uTime.value = t; F.U.uHeld.value = th;
    for (const m of MODS) { const M = F[m]; if (M && M.update) { try { M.update(t, dt, cam); } catch (e) { if (!errOnce[m]) { errOnce[m] = 1; console.error(m + '.update: ' + (e && e.stack || e)); } } } }
    const sh = shotAt(t); let out = { cam: { pos: [0, 2, 10], look: [0, 1, 0], fov: 35 }, look: {} };
    if (override) out = override({ t, abs: t, held: th, habs: th, dt, cam }) || out;
    else if (sh) { if (sh !== lastShot) { lastShot = sh; sh.enter && sh.enter(); }
      out = sh.update({ t: t - sh.t0, abs: t, u: A.clamp((t - sh.t0) / (sh.t1 - sh.t0)), dur: sh.t1 - sh.t0, held: th - sh.t0, habs: th, dt, cam }) || out; }
```

이어서 장면이 비워 둔 화면 설정을 `FILM.score.GRADE`(장면별 색 보정)로 채우고, 카메라를 놓고, `world.afterCamera`가 해 방향을 한 번 더 맞춘 뒤, `E.render(scene, cam, look)`이 그린다.
모듈 순서(`world` → `life` → `rain` → `cast` → `crowd` → 장면)에도 뜻이 있다. 모듈이 먼저 기본값을 쓰고 장면이 나중에 덮어쓴다.

## 2. 시간

### 모든 것은 영화 시각의 함수다

이 영화의 첫 번째 규칙이다. 어떤 값도 지난 프레임을 기억하지 않는다. 물방울 위치, 망토 자락, 카메라, 소리의 시각이 모두 영화 시각 `t`만으로 정해진다.
그래서 아무 시각으로 건너뛰어도 바로 같은 그림이 나오고, 정지 화면(`shot.mjs`)과 프레임 단위 녹화(`record.py`)가 실시간 재생과 같은 그림을 만든다. 난수도 `Math.random()`을 쓰지 않고 이름 붙은 시드 난수열(`FILM.anim.named('houses')`)만 쓴다. 모듈마다 난수열이 따로라서 한 모듈이 난수를 더 뽑아도 다른 모듈의 배치가 바뀌지 않는다.

값을 시간에 따라 움직이는 기본 도구는 키프레임이다. `film/anim.js`의 `keys()`(bide의 `anim.js`를 따라 썼다):

```js
  function keys(t, ks) {
    if (t <= ks[0][0]) return ks[0][1];
    for (let i = 1; i < ks.length; i++) {
      if (t <= ks[i][0]) {
        const a = ks[i - 1], b = ks[i], x = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        return mixv(a[1], b[1], (ease[b[2] || 'io'])(clamp(x)));
      }
    }
    return ks[ks.length - 1][1];
  }
```

`keys(t, [[0, 0], [1.5, 1, 'snap'], [3, 0, 'io']])`처럼 쓴다. 값은 숫자, 배열, 객체 어느 것이든 되므로 카메라 위치, 조명 키 전체, 자세 객체를 같은 함수로 섞는다. 이징 이름(`io`, `snap`, `antic`, `settle` …)은 그 키로 들어가는 움직임의 모양이다.

### 2콤마: `held`

손으로 그린 애니메이션처럼, 인물과 생물은 초당 12장(24 fps 시트에서 2프레임마다 한 장)으로 움직이고 카메라, 물, 빛은 매 프레임 움직인다. `film/anim.js`:

```js
  const FPS_DRAW = 12;
  // round t down to the last drawing: on a 24 fps sheet, a new drawing every n frames (the 1e-6 guards against float error)
  const twos = (t, n = 2) => Math.floor(t * 24 / n + 1e-6) * n / 24;   // n=2 -> 12 drawings/s, n=3 -> 8
  let heldOn = true;
  // the time people and creatures are posed at (main.js passes it to every shot as `held`, and as FILM.U.uHeld to the
  // shaders); with heldOn off (key 2 in the player) they move every frame instead
  const held = (t, n = 2) => heldOn ? twos(t, n) : t;
```

`main.js`는 매 프레임 `uTime`(그대로의 시각)과 `uHeld`(끊은 시각)를 둘 다 셰이더에 넘긴다. 잎, 갈대, 새싹, 덩굴은 셰이더에서 `uHeld`를 읽고, 인물, 생물, 마을 사람은 JS에서 `held(t)`로 자세를 잡는다. 속도선과 그레인도 그림 한 장마다 바뀐다.
반대로 S08의 도약과 S13의 낙하는 일부러 매 프레임 움직인다(`pellPose(t, { onOnes: true })`). 작화에서 말하는 '1콤마 작화'다. 플레이어에서 `2` 키를 누르면 `heldOn`이 꺼져 모든 것이 매 프레임 움직인다.

### 기록 없는 용수철과 옷자락

흔들림과 출렁임도 시뮬레이션하지 않고 닫힌 식으로 쓴다. 감쇠 용수철의 충격 응답이 `t`의 함수이므로 기록이 필요 없다. `film/anim.js`:

```js
  // ---- springs, solved in closed form so they need no history: a value that was pushed at time t0 and rings out
  // impulse response of a damped spring (frequency f Hz, damping ratio z), 0 before t0. It starts at 0, swings to
  // a peak below 1 and dies away; multiply by the size of the push.
  const ring = (t, t0, f = 2, z = .25) => { const x = t - t0; if (x < 0) return 0; const w = TAU * f, wd = w * Math.sqrt(Math.max(1e-4, 1 - z * z)); return Math.exp(-z * w * x) * Math.sin(wd * x); };
```

`s05`에서 북이 울릴 때 카메라가 흔들리는 것(`A.ring(s.abs, 27, 3, .2)`), 돌풍에 문 커튼이 튕기는 것, 종이 흔들리는 것이 모두 이 식이다(셰이더에는 같은 식의 GLSL 사본 `wRing`이 있다).

펠의 망토, 앞머리, 술 장식도 같은 방식이다. 천을 시뮬레이션하는 대신 '조금 전의 이동 속도'만큼 뒤로 끈다. 그 속도도 동선(`FILM.path.pell`)에서 바로 계산한다. `film/cast.js`:

```js
  // Instead of simulating cloth, each piece is offset by her path velocity a moment ago: the lag is a closed-form function of
  // t, so seeking needs no pre-roll. Note that the velocities come from FILM.path.pell, not from a shot's pos override.
  // pathVel: her velocity in m/s, by a .05 s finite difference; a jump faster than 16 m/s is a cut in the path, read as 0.
  const pathVel = t => { const a = P.pell(t).pos, b = P.pell(t - .05).pos; const v = mul3(sub3(a, b), 20); return len3(v) > 16 ? [0, 0, 0] : v; };
```

`secondary()`는 지금, 0.12초 전, 0.32초 전의 속도를 섞어 망토 자락을 늦게 따라오게 하고, 멈추면 넘어가게 한다. 팔과 몸통을 캡슐로 보고 그 안으로 들어간 점은 밖으로 밀어낸다.

### 장면 시각표와 색 보정

[`music/score.js`](../music/score.js)가 영화의 시계다.

```js
  const BPM = 80, BEAT = 60 / BPM, BAR = BEAT * 4, BARS = 31, LEN = BAR * BARS;
```

80 bpm 4/4라서 한 마디가 3초이고, 31마디가 93초다. 장면 17개(`SHOTS`)의 경계가 모두 마디 선에 있다. 장면마다 색 보정 키(`GRADE`: 그림자 색, lift, gain, 채도, 블룸 문턱, 잉크 색)가 있고, `main.js`가 장면이 정하지 않은 값을 이것으로 채운다.
60–72초의 레터박스(2.39:1)도 여기 `bars(t)`에 있다. 16:9 화면에서 위아래 띠가 각각 12.8%다.

### 시계와 건너뛰기

소리가 나는 동안에는 소리의 시계가 주인이다. 그림은 `FILM.music.clock()`이 알려 주는 시각을 그린다. 그래서 프레임이 늦어도 그림과 소리가 어긋나지 않는다. `film/main.js`의 `loop()` 앞부분:

```js
  function loop() {
    requestAnimationFrame(loop);
    const now = performance.now(), dt = Math.min((now - prev) / 1000, .1); prev = now;
    if (playing && !paused) { const at = F.music && F.music.clock ? F.music.clock() : null; T = at != null ? at : T + dt; if (T >= LEN()) { T = 0; F.music && F.music.seek(0); } }
    frame(T, paused ? 0 : dt); if (F.overlay) F.overlay(T);
```

`music/synth.js`의 `clock()`은 출력 지연을 뺀다. 스피커에서 실제로 들리는 순간에 그림을 맞추려는 것이다.

```js
    // film time as heard: the context clock minus the output latency, so the picture matches what reaches the speakers
    clock() { if (!L || !L.started || L.paused || L.ctx.state !== 'running') return null; const D = L.desk, lat = L.ctx.outputLatency || L.ctx.baseLatency || 0;
      return D.filmBase + Math.max(0, L.ctx.currentTime - D.base - lat); },
```

건너뛰기(`←` `→`, `R`)는 `T`를 바꾸고 `FILM.music.seek(T)`를 부르는 것뿐이다. `?t=`는 `T`만 정해 두고, 소리는 화면을 눌러 시작할 때 `FILM.music.start()`가 그 `T`에서 시작한다. 그림 쪽은 다음 프레임에 새 `T`로 그리면 끝이다.
`loop()`는 프레임이 30 ms를 넘는 일이 쌓이면 내부 해상도(`dyn`)를 8%씩 낮추고(0.7까지), 빨라지면 다시 올린다.

## 3. 표 한 장: 울림 표와 떨어지는 공식

### 울림 표

[`film/events.js`](../film/events.js)의 표 `T`에 비를 내리는 소리가 모두 들어 있다. 표의 앞부분:

```js
  const T = [];
  const toll = (id, t0, src, note, band, kind, reach, dur = .5, extra = {}) => T.push({ id, t0, src, note, band, kind, reach, dur, hold: kind === 'sustain' ? HOLD : 0, ...extra });
  const masts = V.places.tollTerrace.masts;
  toll('toybell', 13.5, add(P.kid, [0, .9, 0]), 'E6', 2, 'strike', 1.8, .6);                         // S03: a child's toy bell, a tiny ring of mist
  toll('frog', 14.25, add(P.frog, [0, .1, 0]), 'D3', 0, 'sustain', .9, 1.95);                      // S03: the dripfrog's held croak; its drop lets go at about 15.76
  toll('hum', 20.25, P.pellHead(20.25), 'D4', 0, 'sustain', 1.6, 1.8);                            // S04: Pell's hum settles on D; the nose drop lets go at about 21.79
  toll('drum', 27.0, add(V.places.tollTerrace.drum, [0, 1.3, 0]), 'D2', 0, 'strike', 40, 1.2);   // S05: Dun's drum. The bible said 70 m; 40 m leaves about two thirds of the field hanging
```

표 전체(22개)를 정리하면 이렇다. 띠(band)는 0 굵은 비(D), 1 구슬비(A), 2 안개비(E)다. 소리가 나는 자리(`src`)는 `path.js`(펠의 머리와 손, 아이, 개구리)와 `valley.js`(북, 종 기둥, 지붕 종)에서 가져온다.

| id | 시각 (s) | 음 | 띠 | 종류 | 닿는 거리 (m) | 무엇 |
|---|---|---|---|---|---|---|
| `toybell` | 13.5 | E6 | 2 | strike | 1.8 | 아이의 장난감 종 |
| `frog` | 14.25 | D3 | 0 | sustain | 0.9 | 개구리의 긴 울음 (1.95초) |
| `hum` | 20.25 | D4 | 0 | sustain | 1.6 | 펠의 콧노래 → 코끝의 방울 |
| `drum` | 27.0 | D2 | 0 | strike | 40 | 던의 큰북 |
| `chime0`–`2` | 30.0 | A4 | 1 | strike | 45 | 종 기둥 세 개 |
| `cupola0`–`3` | 33.0 + 0.09 i | E6 | 2 | strike | 55 | 지붕 종 네 개 |
| `bell0`–`5` | 54.0 … 56.625 | E6 | 2 | strike | 4 | 펠의 손종 (안개 조금) |
| `testhum` | 64.5 | D4 | 0 | sustain | 1.2 | 0.45초뿐이라 방울은 떨기만 한다 |
| `voiceA` | 66.0 | A4 | 1 | strike | 120 | 펠의 노래, 첫 음 |
| `voiceD` | 67.5 | D5 | 0 | sustain | 120 | 두 번째 음, 3.5초 끔 |
| `tock` | 69.0 | E6 | 2 | strike | 60 | 톡의 지저귐 |
| `palm` | 88.5 | D4 | 0 | sustain | 0.95 | 벤치의 콧노래 → 손바닥의 방울 |

`strike`는 그 띠의 제 옥타브라서 소리가 닿는 순간 놓고, `sustain`은 다른 옥타브라서 닿은 뒤 1.5초(`HOLD`)를 끌어야 놓는다. 1.5초보다 짧은 `sustain`은 방울을 떨게만 한다.

### 떨어지는 시각: 같은 식을 JS와 GLSL로 두 번

방울 하나가 떨어지는 시각은 `소리 시각 + 거리 / 30 m/s + 끄는 시간 + 0.08 × 방울의 씨앗`이다. 그 방울의 띠에 맞는 소리 가운데 가장 먼저 닿는 것이 이긴다. JS 쪽 `releaseTime()`:

```js
  function releaseTime(local, drifting, band, seed = 0, since = -1) {
    let tr = 1e9;
    for (const e of T) { if (e.band !== band) continue; const d = dist(posAt(local, drifting, e.t0), e.src); if (d > e.reach) continue;
      if (e.hold > 0 && e.dur < e.hold) continue; if (e.t0 + d / C_SOUND < since) continue; tr = Math.min(tr, e.t0 + d / C_SOUND + e.hold + .08 * seed); }
    return tr;
  }
```

같은 파일의 문자열 `GLSL`에 같은 이름의 셰이더 함수가 있다.

```glsl
float releaseTime(vec3 local, float drifting, float band, float seed, float since){
  float tr = 1e9;
  for (int k = 0; k < 24; k++) { if (k >= uEvN) break; if (!evHas(k, band)) continue;
    vec3 p = local + drifting * fieldC(uEv[k].w); float d = distance(p, uEv[k].xyz);
    if (d > uEvP[k].y) continue; if (uEvP[k].z > 0.0 && uEvP[k].w < uEvP[k].z) continue;
    float ta = uEv[k].w + d / C_SOUND; if (ta < since) continue;
    tr = min(tr, ta + uEvP[k].z + 0.08 * seed); }
  return tr; }
```

표는 유니폼 배열 두 개(`uEv[k] = (소리 x, y, z, t0)`, `uEvP[k] = (띠 비트마스크, 닿는 거리, 끄는 시간, 길이)`, 24칸에 22개)로 셰이더에 들어간다. 이 유니폼은 `FILM.U`에 있으므로 어느 재질이든 `FILM.events.GLSL`을 셰이더 앞에 붙이기만 하면 표를 읽을 수 있다.
JS 사본은 방울마다 놓이는 시각을 미리 계산하고(6장) 소리를 예약하는 데 쓴다. GLSL 쪽에서는 낙하 식(`fallDist`, `hitTau`)과 무리 중심(`fieldC`)을 `rain.js`의 정점 셰이더가 쓰고, 표 유니폼은 잎이 소리 쪽으로 돌거나(8장) 소리가 지나가며 방울이 반짝이는 것처럼 셰이더가 소리를 직접 읽는 곳에서 쓴다. 셰이더판 `releaseTime()`은 JS판과 나란히 읽으라고 같은 모양으로 두었고, 지금 방울은 그것을 셰이더에서 다시 계산하지 않고 불러올 때 계산한 값을 속성으로 받는다.

두 사본은 손으로 맞춰야 한다. 그래서 확인 장치가 있다. `rain.js`는 불러올 때 방울 64개를 골라 저장한 시각과 `FILM.events.releaseTime()`을 비교하고(`FILM.rain.checkBad`, 0이어야 한다), `synth.js`는 97개마다 하나씩 같은 비교를 한다(`FILM.music.stats.releaseMismatch`).

### 떨어지는 모양

놓인 뒤의 낙하는 공기 저항이 있는 자유 낙하다. 속도가 0에서 출발해 띠마다의 종단 속도(14, 9, 2.2 m/s)에 다가간다. 중력은 영화만의 값 6 m/s²다. 거꾸로 '이만큼 떨어지는 데 몇 초'(`hitTau`)도 닫힌 식이라, 땅에 닿는 시각을 바로 안다.

```js
  // metres fallen tau seconds after release (0 before it), and its inverse: seconds to fall dh metres
  const fall = (tau, band = 0) => { const vt = VT[band]; return tau <= 0 ? 0 : (vt * vt / G) * Math.log(Math.cosh(G * tau / vt)); };
  const hitTau = (dh, band = 0) => { const vt = VT[band]; return (vt / G) * Math.acosh(Math.exp(G * Math.max(0, dh) / (vt * vt))); };
```

### 흐르는 비 무리도 닫힌 식

비 무리는 동쪽으로 초속 2 m쯤 흐르다가 36초의 돌풍 뒤 남동쪽 스필웨이로 미끄러진다. 속도가 36–39초 사이에 부드럽게 바뀌는데, 위치를 프레임마다 더해 가면 지난 프레임에 기대게 된다. 그래서 속도 섞기의 적분을 손으로 풀어 썼다. [`film/path.js`](../film/path.js):

```js
  const C0 = [96, FIELD.base, -74], V0 = [2.0, 0, .15], VG = [.55, 0, 1.3];
  // closed form: C(t) = C0 + V0 t + (VG - V0) S(t), S = integral of smoothstep(36, 39, t)
  // The velocity blends from V0 to VG along smoothstep(36, 39, t); S is the integral of that blend (seconds). With
  // x = (t - 36) / 3 the integral of 3x^2 - 2x^3 over 3 s is 3 (x^3 - x^4 / 2); after 39 it grows by 1 per second.
  // On top, the field breathes up and down 0.6 m (y).
  const S = t => { if (t <= 36) return 0; const x = (t - 36) / 3; return x < 1 ? 3 * (x * x * x - x * x * x * x / 2) : 1.5 + (t - 39); };
  const fieldC = t => { const s = S(t); return [C0[0] + V0[0] * t + (VG[0] - V0[0]) * s, C0[1] + .6 * Math.sin(t * .21), C0[2] + V0[2] * t + (VG[2] - V0[2]) * s]; };
```

비 무리의 방울은 이 중심을 기준으로 한 '무리 좌표'로 저장된다. 그래서 무리 전체가 흘러도 방울마다 위치를 다시 쓸 필요가 없다. 떠다니는 방울의 거리는 소리가 울린 순간(`t0`)의 무리 위치에서 잰다. 무리는 초속 2 m, 소리는 초속 30 m라 오차가 작고, JS와 GLSL이 똑같이 그렇게 한다.

펠의 동선 `pell(t)`도 같은 생각이다. 지붕, 달리기, 도약, 기둥 오르기, 물방울 징검다리, 낙하, 천, 벤치까지 시간 구간마다 위치를 식으로 정한다. 징검다리 물방울 10개(`hops`)는 '펠이 그 위에 내려앉는 순간 발밑에 오도록' 무리 좌표를 거꾸로 계산해 두고, 착지 0.75초 뒤에 놓인다. 그래서 `rain.js`가 그리는 방울과 펠의 발이 정확히 맞는다.

### 누가 표를 읽나

| 모듈 | 표에서 얻는 것 |
|---|---|
| `rain.js` | 방울마다 놓이는 시각(불러올 때 한 번 계산), 떨림, 섬광, 소리의 고리 |
| `life.js` | 잎이 소리 쪽으로 도는 시각(셰이더가 표를 돈다), 개구리 방울 |
| `cast.js`, `crowd.js` | 소리가 지나갈 때 술 장식과 구슬이 떠는 시각(`cast.js`는 `arrivals()`, `crowd.js`는 같은 계산의 `lastFront()`) |
| `world.js`, `life.js` | 땅이 젖는 시각(`wetAt()`): 비취색 땅, 물 찬 잎, 새싹 |
| `synth.js` | 울림마다의 소리, 방울마다의 '똑', 비 소리의 크기 |

## 4. 렌더링 (`film/engine.js`)

### 모든 재질은 손으로 쓴 셰이더

three.js의 기본 재질은 쓰지 않는다. 재질은 모두 `THREE.ShaderMaterial`이고, three.js에서는 장면 그래프, 기하와 수학 도구, 그림자 맵, 스키닝·인스턴싱 셰이더 조각, 렌더 타깃을 빌린다.
모든 재질은 `FILM.U`의 유니폼 객체를 함께 쓴다. `Object.assign`이 `{ value }` 상자의 참조를 복사하므로 `FILM.U`에 한 번 쓰면(시각, 해, 안개) 모든 재질에 닿는다. 색은 sRGB 16진수로 적고, 계산은 선형 공간의 half-float 타깃에서 하고, 마지막 패스에서만 sRGB로 바꾼다.

### 셀 재질 `E.toon`

빛을 계단으로 나누는 셀 셰이딩이다. 핵심은 몇 줄이다. `toon()`의 조각 셰이더:

```glsl
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
```

그림자는 회색으로 어두워지지 않고 `uShade`(푸른 보랏빛, 장면마다 색 보정이 바꾼다)를 곱해 색이 바뀐다. three.js의 그림자 맵은 `getShadowMask()`로 읽기만 하고, 0.3–0.7 사이를 잘라 경계를 또렷하게 만든다.

`E.toon`은 GLSL을 끼워 넣을 자리(hook)를 열어 둔다. 모듈은 재질을 새로 쓰지 않고 이 자리만 채운다.

| 자리 | 어디 | 무엇을 바꿀 수 있나 |
|---|---|---|
| `vpars`, `fpars` | 정점·조각 셰이더 맨 앞 | 속성, 유니폼, 함수 선언 |
| `vnormal`, `vdeform` | 정점 셰이더 | `objectNormal`, `transformed`(정점 위치). `P0`은 원래 위치 |
| `fpre` | 조명 계산 전 | `base`(색), `N`, `lightK`(빛의 양) |
| `fpost` | 조명 계산 후 | `c`(최종 색) |

외곽선은 같은 정점 셰이더로 만들어지므로 `vdeform`으로 휜 몸을 외곽선도 따라간다. `cast.js`의 세 인물(펠, 톡, 던)은 이 자리(`fpost`)를 써서 중간 밝기 띠를 하나 더한다. 그래서 배경, 소품, 마을 사람들은 두 단계, 이 세 인물은 세 단계다. `film/cast.js`의 `MID`:

```js
  const MID = /* glsl */`
  // the mid band: lit pixels whose (wrapped) N.L is below uMidAt get 40% of the shadow colour; then +14% saturation in shadow
  { float mb = lit * (1.0 - smoothstep(uMidAt - 0.02, uMidAt + 0.02, ndl)) * uMidK;
    c = mix(c, mix(base * uSunCol, shadeC, 0.4), mb);
    float sl = dot(c, vec3(0.299, 0.587, 0.114)); c = mix(c, mix(vec3(sl), c, 1.14), 1.0 - lit); }`;
```

구름 그림자도 자리 하나로 받는다. `world.js`의 마을은 `fpre`에 `lightK *= 1.0 - 0.8 * cloudShadowAt(vWP.xz);`를 넣는다.

### 잉크 선 두 가지

**뒤집은 껍데기.** 메시를 한 벌 더 그리되 뒷면만, 법선 방향으로 조금 부풀려 그린다. 앞면 뒤로 껍데기의 가장자리만 삐져나와 선이 된다. 부풀리는 양을 카메라 거리에 비례시켜 화면에서 폭이 일정하다. `vtx()`의 외곽선 부분:

```glsl
  // inverted hull: push each vertex out along its view-space normal by uLinePx pixels (width grows with depth, so it
  // stays constant on screen) but never more than uLineMax metres; then push it a little away from the camera so the
  // hull hides behind the surface and only its rim shows
  float lw = min(uLinePx * uPx * max(-mvPosition.z, 0.1), uLineMax); mvPosition.xyz += normalize(onv) * lw; mvPosition.z -= lw * 0.6;` : ''}
```

선 색은 검정이 아니다. 따로 정하지 않으면 바탕색의 색상을 약 11도 돌리고 명도를 22%로 낮춘 색이 된다. 66–72초의 역광 장면에서는 `look.ink = 'pale'`이 선을 밝고 따뜻한 테두리 빛으로 바꾼다.

**깊이 차이.** 합성 패스에서 이웃 픽셀의 깊이가 거리의 4.5–9% 넘게 뛰는 곳을 어둡게 칠한다. 껍데기가 없는 땅의 담 모서리나 겹친 산등성이에 선이 생긴다. `mComp`:

```glsl
      if (uEdge > 0.0) { float zl = lin(texture2D(tDepth, vUv - vec2(uT.x, 0.0)).x), zr = lin(texture2D(tDepth, vUv + vec2(uT.x, 0.0)).x),
          zd = lin(texture2D(tDepth, vUv - vec2(0.0, uT.y)).x), zu = lin(texture2D(tDepth, vUv + vec2(0.0, uT.y)).x);
        float zm = min(min(zl, zr), min(zd, zu)); float e = (max(max(zl, zr), max(zd, zu)) - zm) / max(zm, 0.1);
        float k = smoothstep(0.045, 0.09, e) * uEdge * (1.0 - smoothstep(uEdgeFar * 0.5, uEdgeFar, zm));
        c = mix(c, mix(c * vec3(0.32, 0.3, 0.42), vec3(1.0, 0.76, 0.56) * 1.4, uInkFlip), k); }
```

### 하늘, 구름, 구름 그림자

하늘 돔(반지름 4.5 km)은 깊이를 쓰지 않고 먼 평면에 붙어 있어서 모든 것이 그 위에 그려진다. 후처리는 '깊이 = 가장 멂'을 하늘로 읽는다(빛줄기, 렌즈 플레어).
적운은 덩어리(lobe) 여러 개로 지은 메시에 세 가지 톤(햇빛 닿는 꼭대기, 중간, 그늘진 속)과 해를 등진 테두리 빛을 칠한다.

구름 그림자는 구름 목록에서 바로 계산한다(움직이는 타원, 가장자리를 사인으로 흔듦). 같은 식이 JS(`cloudShadow()`)와 GLSL(`CLOUD_GLSL`)에 있다. 그런데 구름 목록을 도는 계산을 모든 재질이 픽셀마다 하면 비싸고 셰이더 컴파일도 느려진다.
그래서 `world.js`는 매 프레임 한 번, 골짜기 위 2000 m 사방을 덮는 768 × 768 텍스처(세계 지도: R 구름 그림자, G 소리가 남긴 젖음)에 그려 두고, 재질은 그 텍스처를 한 번 읽는다.
그림자 안에는 만화의 망점을 찍는다. 화면 픽셀 기준이라 거리와 상관없이 점 크기가 같다. `film/world.js`의 `MAP_GLSL`:

```glsl
float halftone(float k){
  float px = 5.0 * uRes.y / 1080.0; vec2 g = gl_FragCoord.xy / px; g = vec2(g.x + g.y, g.y - g.x) * 0.70710678;
  float d = length(fract(g) - 0.5); float rad = 0.42 * sqrt(clamp(k, 0.0, 1.0)); float aa = 0.7 / px;
  return 1.0 - smoothstep(rad - aa, rad + aa, d); }`;
```

### 유리 패스

큰 물방울은 뒤의 풍경을 굴절시킨다. 불투명한 장면을 먼저 다 그린 뒤, 카메라 층 1(`E.GLASS`)에 놓인 유리 메시만 따로 그린다. 유리 셰이더는 방금 그린 장면의 색과 깊이 텍스처를 읽어, 화면 위치를 법선 방향으로 밀어 낸 곳의 색을 가져온다(진짜 광선 추적이 아니다).
깊이 버퍼가 따로라서 유리는 장면의 깊이와 직접 비교해(2 cm 여유) 가려진 부분을 버린다. `rain.js`의 영웅 물방울은 여기에 더해, 방울 안에 뒤집힌 풍경을 그리려고 방울 중심을 지나 뒤집은 좌표로 장면을 읽는다.

### 후처리 사슬

`E.render(scene, cam, look)` 한 번이 이 순서로 그린다.

| 패스 | 하는 일 | 크기 |
|---|---|---|
| 1 그림자 맵 | 해의 그림자 맵(4096², 프레임마다 한 번) | |
| 2 불투명 장면 | 카메라 층 0 | 전체, half-float, MSAA 4×, 깊이 텍스처 |
| 3 유리 | 층 `E.GLASS`, 2의 색과 깊이를 읽음 | 전체 |
| 4 합성 | 장면 + 유리, 깊이 잉크, 흐림 정도(CoC)를 알파에 | 전체 |
| 5 빛줄기 | 밝은 하늘 픽셀을 해 쪽으로 28번 샘플링, 블러 두 번 | 절반 |
| 6 블룸 | 밝은 부분, 6번 절반으로 줄였다가 다시 키움. 넓은 단계만 모은 것이 '빛 번짐(glow)' | 1/2 … 1/128 |
| 7 마무리 | 충격파 일그러짐, 피사계 심도, 색 번짐, 무지개, 빛 새기, 빛줄기, 블룸, 렌즈 플레어, 노출, 색 보정, 비네트 → sRGB → 속도선, 임팩트 프레임, 종이 결, 그레인, 페이드, 레터박스 | 화면 |

장면은 `look` 객체의 키로 이 사슬을 조절한다. 키의 기본값과 뜻은 `E.render` 바로 위의 표에 있다. 자주 쓰는 것만 추리면:

| 키 | 뜻 |
|---|---|
| `focus`, `ap` | 초점 거리(m)와 조리개. `ap` 0이면 전부 또렷하다 |
| `rays`, `flare`, `bloom`, `glow` | 빛줄기, 렌즈 플레어, 블룸, 넓은 빛 번짐 |
| `speed`, `speedMode` | 속도선. 0 방사형, 1 가로(돌풍·질주), 2 세로(낙하) |
| `impact`, `impactC` | 임팩트 프레임. 1 반전 두 색, 2 단색 바탕에 흰 윤곽 (57.0, 66.0) |
| `ink` | `'dark'` 또는 `'pale'`(역광의 밝은 선) |
| `live` | 1이면 그레인이 초당 12번, 0(정적)이면 6번 바뀌고 약해진다 |
| `rainbow`, `leak`, `shock` | 무지개, 빛 새기, 목소리 고리의 충격파(최대 2개) |
| `fade`, `bars` | 페이드, 레터박스 |

그림자 맵은 하나다. 장면마다 `E.shadowFit(중심, 반지름)`으로 그림자 상자를 보이는 곳에 맞춘다. 가까운 장면은 반지름을 작게 잡아 그림자가 또렷하고, 넓은 장면은 계단 전체를 덮는다.

## 5. 땅과 마을

### 식으로 된 땅 (`film/valley.js`)

골짜기는 원점을 중심으로 한 사발이다. 반지름 40 m의 연못, 그 바깥에 폭 16.5 m, 높이 3.2 m인 계단 9단, 그 너머 테두리와 산이 있다. 높이는 `ground(x, z)` 함수 하나로 정해지고 메시 데이터는 없다.
계단의 둥근 경계는 텍스처 없이 사인 세 개로 흔든다. 그래서 GLSL 사본(`vGround`)도 똑같이 쓸 수 있다.

```js
  // how far the rings wobble at angle th (m, within about ±5.3): three sines, so the GLSL copy is exact
  const wob = th => 3.0 * Math.sin(3 * th + .7) + 2.0 * Math.sin(5 * th + 1.9) + 1.2 * Math.sin(9 * th + .4);
  // outer radius of ring k; the wobble grows outward (x0.5 at the pond, x1.5 at the rim)
  const ringR = (k, th) => R0 + DEPTH * k + wob(th) * (.5 + k / NT);           // k = 0..9
```

이름 붙은 장소(북이 있는 9단, 스필웨이 기둥과 벤치, 물독 길, 펠의 지붕)와 집 44채(시드 난수열 `'houses'`)도 여기서 정한다. 다른 모듈은 모두 이 지도를 읽으므로, 펠의 발이 지붕 위에 정확히 놓이고 카메라 검사(`sweep`)가 집 안으로 들어간 카메라를 찾을 수 있다.

### 땅 메시와 칠 (`film/world.js`)

땅은 극좌표 메시 하나다. 640열(테두리에서 약 1.9 m 간격)이 모두 같은 표본 목록(연못, 담마다 7점, 계단 윗면마다 9점, 테두리, 산맥)을 가진다. 그래서 3.2 m 담의 단차가 이웃 열끼리 어긋나지 않는다.
칠은 셰이더 두 개가 나눠 한다(사발 안, 테두리 밖). 하나로 합치면 컴파일이 1.5배쯤 느려서 나눴다. 짚단 무늬, 돌담의 줄눈, 이끼, 먼 산의 푸른 공기원근은 모두 셰이더가 그린다.

### 시간대별 빛

조명은 시간대마다 '키'(해 방향·색·세기, 하늘 네 색, 안개, 구름 톤, 흐림 …)를 하나씩 두고 `keys()`로 섞는다. 키 두 개를 0.02초 간격으로 두면 컷이 된다.

```js
  const TL = [[0, 'noon'], [36.0, 'noon'], [37.2, 'gust', 'io'], [41.98, 'gust'], [42.0, 'run', 'lin'], [59.98, 'run'], [60.0, 'ma', 'lin'], [65.98, 'ma'], [66.0, 'climax', 'lin'],
    [71.98, 'climax'], [72.0, 'curtain', 'lin'], [74.98, 'curtain'], [75.0, 'after0', 'lin'], [84.6, 'after0'], [86.0, 'after', 'io'], [86.98, 'after'], [87.0, 'dusk', 'lin'], [93, 'dusk']]
    .map(([t, s, e]) => [t, ST[s], e]);
  const light = t => keys(t, TL);   // the blended key at film time t (same fields as BASE, colours as linear rgb arrays)
```

`world.update(t)`는 이 키와 그 순간의 스위치(돌풍, 비, 바람)를 유니폼에 쓰고 세계 지도를 다시 그린다. 움직임은 모두 셰이더가 `uTime`으로 계산한다. 장면이 해를 직접 돌리고 싶으면(`s12`의 역광) `FILM.world.sunOverride`를 쓴다.

### 셰이더 안에서 움직이는 마을

집, 지붕, 문 커튼, 종, 기둥, 물독은 메시 몇 개로 합쳐 셀 재질 하나로 칠한다(GPU 프로그램 하나 + 잉크 하나). 정점마다 부품 번호(`aPart`)와 자유 vec4(`aX`: 회전축, 시각)가 있어서, 무엇이 언제 어떻게 움직이는지 셰이더가 안다.
돌풍은 서쪽 테두리에서 초속 18 m로 건너오므로 집마다 지연(`hDly`)이 있고, 문 커튼이 서쪽부터 차례로 튕긴다. `VILLAGE.vdeform`의 문 커튼:

```glsl
  if (aPart > 19.5 && aPart < 20.5) {          // door curtain: hinged at its rod, idle sway, then the snap and the long flutter (M16)
    // hang: 0 at the rod (4.32 m) .. 1 at the hem 1.8 m below; snap: the M16 ring, the same as FILM.world.snap; g: the gust
    float hang = clamp((4.32 - P0.y) / 1.8, 0.0, 1.0), hk = pow(hang, 1.5), snap = wRing(uTime, 36.0 + hDly, 2.1, 0.16);
    float idle = 0.03 * sin(uTime * 1.7 + hSeed * 6.28 + P0.x * 1.3) + 0.018 * sin(uTime * 3.1 + hSeed * 11.0 + P0.x * 2.0);
    float flut = sin(uTime * 13.0 + P0.x * 4.0 + hSeed * 9.0 + hang * 3.0) * 0.07 * g;
    transformed.z += hk * (idle + abs(snap) * 0.75 + g * 0.42 + flut);
    transformed.x += hk * (hWind.x * (snap * 0.35 + g * 0.3) + flut * 0.6);
    transformed.y += hk * hk * (abs(snap) * 0.3 + g * 0.18);
```

비가 그친 뒤의 '초록 홍수'(75.5초부터 위 계단부터 차례로 비취색)는 `FILM.events.wetAt()`의 규칙을 땅 셰이더와 잎, 새싹이 함께 읽어서 맞는다.

## 6. 비 (`film/rain.js`)

### 얼마나, 어떻게 담나

`FILM.rain.counts()`로 잰 개수다.

| 세트 | 개수 | 그리기 |
|---|---|---|
| `big`: 굵은 방울 + 비 무리의 물방울 줄 150개 | 21,244 (굵은 방울 5,600, 줄 구슬 15,644) | 카메라를 향한 사각형 |
| `marble`: 구슬비 | 36,000 | 사각형 |
| `mist`: 안개비 | 92,000 | `gl.POINTS` (1–3 px 점) |
| `local`: 마을 위에 고정된 방울 | 3,136 | 사각형 |
| `beads`: 다른 모듈이 맡긴 방울 (새의 날갯짓, 웃음 이슬비) | 26,084 | 사각형 |
| `body`: 멀리서 덩어리를 보여 주는 반투명 구름 조각 | 210 | 큰 스프라이트 |

방울 하나는 인스턴스 속성 몇 개다. 쉴 때의 위치(`aRest`, 흐르는 방울은 무리 좌표), 띠·반지름·씨앗·플래그(`aInfo`), 생긴 때·사라질 때·**놓이는 시각**·줄에서의 깊이(`aLife`), 떨림이 시작하고 끝나는 때와 줄 정보(`aAux`), 착지 높이(`aGnd`).
놓이는 시각은 불러올 때 방울마다 한 번, `FILM.events.releaseTime()`과 같은 식으로 계산해 속성에 담는다. 정점 셰이더가 정점마다 울림 표를 도는 일을 없애려는 것이다. 착지 높이도 미리 어림해 둔다.

### 방울의 일생은 정점 셰이더 하나

매달림 → 떨림 → 놓임 → 낙하 → 착지가 `RAIN_CORE`의 `rainState()` 하나에 들어 있다.

```glsl
vec3 rainState(vec3 R, float drift, float band, float r, float seed, float ss, float h, float cur, float tr, vec2 aux, float gEst, float t, out vec4 st, out float trem, out vec3 ph){
  st = vec4(0.0); trem = 0.0;
  vec3 p = rainHang(R, drift, r, seed, ss, h, cur, min(t, tr)); ph = p;
  float tau = t - tr;
  if (tau < 0.0) { float x = (t - aux.x) / EV_HOLD; trem = (x > 0.0 && x < aux.y) ? x * x : 0.0; float a = seed * 37.0;
    p += vec3(cos(a), 0.4 * sin(a * 1.7), sin(a)) * (0.06 + 0.25 * r) * trem * sin(RTAU * (14.0 + 6.0 * seed) * t);
    st = vec4(0.0, tau, 0.0, tr); return p; }
  float y0 = p.y, th = hitTau(y0 - gEst, band), tt = min(tau, th);
  p.xz += drift * (fieldC(tr + tt).xz - fieldC(tr).xz);
  p.y = y0 - fallDist(tt, band);
  st = vec4(tau < th ? 1.0 : 2.0, tau, tau - th, tr);
  return p; }
```

`rainHang(…, min(t, tr))`가 요점이다. 매달린 동안의 흔들림(숨쉬기, 컬 노이즈 떼 움직임, 돌풍의 전단, 부채 자국, 펠이 지나간 자리의 구슬 커튼)을 놓인 순간의 시각으로 계산하므로, 떨어지는 방울은 놓인 자리에서 출발한다. 기록 없이 그렇게 된다.
떨어지는 방울은 카메라에 대한 속도 방향으로 늘어나 꼬리가 되고(`s13`처럼 카메라가 함께 떨어지면 `set({ camVel })`로 넘긴다), 땅에 닿으면 넷 중 하나쯤 물왕관을 남긴다.

### 그 밖의 기법

- **정렬 없는 투명.** 방울 사각형은 블렌딩 대신 알파 투 커버리지(MSAA 4×)를 쓴다. 수만 개를 깊이순으로 정렬하지 않아도 된다. 세트마다 세 번 그린다: 0 작은 방울·꼬리·물왕관(깊이 안 씀), 1 화면에서 반지름이 10 px보다 큰 방울(깊이를 써서 피사계 심도와 잉크 선이 잡힌다), 2 렌즈에 가까운 보케 원.
- **방울 얼굴은 2D 도형.** 콩팥 모양 하이라이트, 네 갈래 별, 올챙이는 조각 셰이더의 2D 거리 함수(`DRAW2D`의 `crescent`, `starShape`, `tadpole`)로 그린다.
- **JS 거울.** `hangJS`, `stateJS`가 셰이더의 식을 한 줄씩 옮겨 두었다. 달팽이가 줄 구슬을 타고 오르거나(`beadAt()`) 시험 화면의 카메라가 방울 하나를 겨눌 때, GPU에서 값을 읽어 오지 않고 JS로 같은 답을 얻는다.
- **영웅 물방울 16개.** 징검다리 10개, 심장 방울, 이야기 방울 5개(접사, 개구리, 코, 얼굴, 손바닥)는 진짜 유리 메시(`E.glass`)다. 발을 디디면 르장드르 다항식 두 개(`a2`, `a3`)로 젤리처럼 눌린다. 깊이만 쓰는 1.5% 작은 대역을 불투명 장면에 함께 그려서 피사계 심도가 방울을 안다.
- **소리의 고리.** 닿는 거리가 30 m를 넘는 울림마다 반지름 `30·(t − t0)`인 구면이 퍼지며, 비 무리 층을 지나는 부분만 빛난다.

## 7. 인물 (`film/sculpt.js` + `film/cast.js`)

### 조각: SDF를 부드럽게 합치기

인물의 몸은 기본 도형을 붙이지 않고 '빚는다'. 캡슐과 타원체마다 부호 있는 거리 함수(SDF: 표면까지의 거리, 안쪽은 음수)를 만들고, 부드러운 최솟값(smooth min)으로 합쳐 이음매를 둥글게 메운다. `film/sculpt.js`:

```js
  const smin = (a, b, k) => { if (k <= 0) return Math.min(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
  // distance from a point to a bounding sphere b: never more than the distance to the part inside it
  const far = (b, x, y, z) => hyp(x - b[0], y - b[1], z - b[2]) - b[3];
  // smooth union of a list of shapes. The speed trick: when a part's bounding sphere is already k or more farther than the
  // distance found so far, smin could not change the result, so the part is skipped without being evaluated.
  // The union gets a bounding sphere of its own when all its members have one, so unions can nest.
  const union = (fs, k = 0) => { const f = (x, y, z) => { let d = fs[0](x, y, z); for (let i = 1; i < fs.length; i++) { const b = fs[i].b; if (b && far(b, x, y, z) >= d + k) continue; d = smin(d, fs[i](x, y, z), k); } return d; };
    if (fs.every(g => g.b)) { const c = [0, 0, 0]; fs.forEach(g => { c[0] += g.b[0] / fs.length; c[1] += g.b[1] / fs.length; c[2] += g.b[2] / fs.length; });
      f.b = [...c, Math.max(...fs.map(g => far(g.b, ...c) + 2 * g.b[3])) + k * 0.25]; }
    return f; };
```

몸은 부품 목록이다. 부품마다 모양, 색, 그 부품을 움직일 뼈, 앞 부품과 섞이는 폭(m)이 있다. `film/cast.js`의 `pellBodyParts()` 첫 부분:

```js
  function pellBodyParts(ix) {
    const C = PAL, out = [], add = (f, col, bone, k = .03) => out.push({ f, col, bone: ix[bone], k });
    add(S.ell([0, .86, -.008], [.102, .095, .076]), C.tunic, 'chest');
    add(S.ell([0, .73, -.002], [.092, .09, .072]), C.tunic, 'chest', .05);
    add(S.ell([0, .6, 0], [.098, .072, .078]), C.tunic, 'hips', .05);
    add(S.cut(S.cap([0, .68, 0], [0, .47, .005], .1, .13), (x, y, z) => y - .5, .004), C.tunic, 'hips', .03);   // a short flared tunic skirt, a flat hem
```

### 메시로 바꾸기: surface nets

`mesh()`는 거리장을 격자로 재고, 표면이 지나는 칸마다 정점 하나를 둔다(칸의 모서리 교차점들의 평균, 그다음 기울기 방향으로 한 번 표면에 당김). 표면이 지나는 격자 모서리마다 그 모서리를 공유하는 네 칸의 정점으로 사각형을 만든다.
계산을 줄이는 장치가 하나 있다. 먼저 3배 성긴 격자로 재고, 표면에서 먼 점은 가까운 성긴 값을 그대로 쓴다(거기서는 부호만 중요하다). 그래서 진짜 거리장은 표면 둘레의 얇은 껍질에서만 잰다.
정점의 색은 부품 색을 거리에 따라 섞고(`exp(-거리 / blend)`; `blend`는 `mesh()`의 옵션으로, 기본값은 3 cm이지만 펠의 몸은 0.5 cm, 머리는 0.6 cm처럼 메시마다 따로 준다), 뼈 가중치도 같은 방식으로 부품이 가리킨 뼈에서 얻어 가장 센 넷만 남긴다. 그래서 조각한 몸 하나가 `SkinnedMesh` 하나로 휜다. 이 작업은 로딩 때 한 번이다(펠, 톡, 던, 개구리).

### 뼈대와 두 마디 IK

펠과 던은 뼈 15개(엉덩이, 가슴, 목, 팔 둘, 다리 둘)다. 손과 발은 목표 위치를 주면 두 마디 IK가 팔꿈치와 무릎을 정한다. 코사인 법칙 그대로다.

```js
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
```

자세는 평범한 객체다. `pellPose(t, opts)`는 기본 자세(`basePose()`)에서 출발해, `FILM.path.pell(t)`가 주는 상태(`run`, `leap`, `bell` …)마다의 함수가 채우고, 장면의 옵션(표정, 시선, 팔 목표 …)을 얹은 뒤 `applyPell()`이 뼈에 옮긴다.

### 셰이더로 그린 얼굴

펠의 얼굴에는 텍스처가 없다. 머리의 조각 셰이더가 머리 좌표(미터)에서 눈, 속눈썹, 하이라이트, 눈썹, 입, 주근깨, 볼 빗금을 거리 함수로 그린다. 그래서 얼마나 가까이 가도 선이 또렷하다. 표정은 유니폼 몇 개다. `FACE_PARS`:

```glsl
uniform vec4 uEyeA;    // lid left, lid right (0 open .. 1 shut), gaze x, gaze y
uniform vec4 uEyeB;    // wide (stunned: small pupils), happy (shut eyes arch like ^), sparkle, dull
uniform vec4 uBrowA;   // raise, furrow, sad
uniform vec4 uMouthA;  // open 0..1, half width (m), top roundness, smile
uniform vec4 uMouthB;  // teeth, -, -, -
uniform vec4 uCheekA;  // blush, freckles, -, force dot eyes
```

`pellPose()`가 표정 키(`neutral`, `determined`, `singing` …)와 입 모양 키를 이 값으로 바꾼다. 눈 폭이 화면에서 몇 픽셀로 줄면 점 눈으로 바뀐다. 깜빡임은 평균 3.5초마다, 그림 3장에 걸쳐 한다.
소리가 지나갈 때 술 장식과 구슬이 떠는 것(`meter()`)은 `FILM.events.arrivals()`가 주는 도착 시각에서 감쇠 사인으로 계산한다.

## 8. 생물과 사람들 (`film/life.js`, `film/crowd.js`)

### 식물: 움직임은 모두 정점 셰이더에

컵잎 약 5.9천, 방울갈대 약 2.6천, 새싹 약 4.2천은 인스턴스 메시다. JS는 불러올 때 한 번 자리만 정하고(모듈의 시드 난수열), 움직임은 모두 정점 셰이더가 계산한다.
컵잎은 소리가 닿으면 그쪽으로 돌았다가 돌아온다. 셰이더가 울림 표를 직접 돈다. `LEAF_GL`의 `leafLook()` 앞부분:

```glsl
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
```

'돌아갔다가 돌아오기'를 용수철 계단 응답 두 개의 차(`lfM7(τ) − lfM7(τ − 길이)`)로 쓴 것이 요점이다. `h`는 `uHeld`라서 잎도 2콤마로 움직인다.

### 생물: 그림 한 장마다 JS로

개구리 12마리, 새 2무리 80마리, 나방 30마리는 그림 한 장마다 JS에서 자세(새는 정해진 비행 경로 위의 위치)를 계산해 인스턴스 행렬과 작은 인스턴스 속성에 쓴다. 새의 날갯짓은 정점 셰이더가 한다. 물독에 떨어지는 올챙이 20마리는 떨어지는 것이라 매 프레임 움직인다. 개구리는 `sculpt.js`로 빚는다.
새는 날갯짓마다 지나온 길에 안개 방울 12개를 점선처럼 남긴다. 이 방울은 `FILM.rain.addBeads()`로 비 모듈에 맡겨서, 비와 같은 셰이더로 그려지고 같은 방식으로 떨어진다.

### 사람들: 인형 하나, 인스턴스 81개

마을 사람 80명(과 `cast.js`가 없을 때의 펠 대역 하나)은 펠트 인형 메시 하나를 `InstancedMesh` 하나로 그린다. 부채, 박 장대, 장난감 종 같은 소품도 메시 안에 있고, 들고 있지 않으면 셰이더가 접어 숨긴다.
사람마다 자세는 인스턴스 속성 vec4 네 개(16채널)다. `crowd.js`의 `GL`:

```glsl
// aPose0: arm L pitch (forward), arm L raise, arm R pitch, arm R raise
// aPose1: lean (forward), side roll, head pitch (up), head yaw (to its left)
// aPose2: bob (m), squash (1 = rest), prop pitch | bell swing, prop roll | bell slip
// aPose3: gait phase, gait amount (>1 lifts high: stomps), time the last sound front passed (tassel meter), prop twist
```

`update(t)`는 그림 한 장마다 사람마다의 짧은 대본을 돌려 이 16개 값을 쓴다. 대본은 층으로 쌓인다: 기본 자세 위에 걷기와 몸짓(쉿, 숨 내쉬기, 돌풍에 비틀거림, 웃음, 발구르기)을 더하고, 마을 전체가 함께 하는 일(25초 위를 봄, 33초 숨 내쉬기, 39초 모든 두건이 동쪽으로)을 더한다.
술 장식의 떨림은 '마지막 소리가 지나간 시각'(`aPose3.z`)만 넘기고, 셰이더가 매 프레임 감쇠 사인으로 떤다.

## 9. 소리 (`music/synth.js`)

### 악보를 미리 다 써 두기

소리 파일은 없다. 모든 소리는 Web Audio의 오실레이터, 필터, 엔벨로프와 시드 잡음으로 만든 버퍼다. 재생할 때 즉흥으로 정하는 것은 없다.
불러온 뒤 쉬는 틈에 두 가지를 한 번 계산한다. **큐 시트**(어느 영화 시각에 어느 악기가 어떤 인자로 울리는지, 954개)와 **레인**(바람, 비, 음악 크기, 잔향 같은 느린 제어 곡선)이다. 둘 다 공유 표(`score`, `events`, `path`, `rain.sets` …)의 함수이므로, 실시간 재생, 건너뛰기, 오프라인 렌더가 모두 같은 시각에 같은 소리를 낸다.

스케줄러는 25 ms마다 깨어나 약 180 ms 앞까지의 큐를 AudioContext 시각으로 예약한다(탭이 숨으면 브라우저가 타이머를 늦추므로 2.5초 앞까지).

```js
  function schedule(D, until) {
    const C = PREP.cues, now = D.ctx.currentTime;
    while (D.ci < C.length && C[D.ci].t < until) { const c = C[D.ci++]; let w = ctxT(D, c.t), off = 0; if (w < now) { off = now - w; w = now; } play(D, c, w, off); }
  }
```

시각이 이미 지난 큐는 `off`초 늦게, 소리 중간부터 들어간다. 건너뛰기는 이전 '세대'의 버스를 40 ms에 걸쳐 끄고 새 세대를 켠 뒤, 그 시각에 아직 울리고 있어야 할 긴 소리를 중간부터 다시 넣는다. 그래서 클릭 잡음이 나지 않는다.

### 그림과 같은 식에서 나오는 '똑'

방울이 놓일 때 나는 '똑'(plink)은 그림과 같은 놓임 시각에서 나온다. 귀(장면의 주인공) 30 m 안에서 놓이는 방울을 그 방울을 놓은 울림마다(종 기둥 세 개처럼 같은 종류는 한 묶음) 모아, 거리순으로 늘어놓고 고르게 최대 60개(지붕 종, 손종, 톡은 30개)를 고른다. 가까운 것과 먼 것이 함께 들린다.

```js
    // ---------------- release plinks of the field, from the release math. Per toll at most 60 (30 for the cupola bells,
    // Pell's bell and Tock, whose tolls come close together), picked evenly along the list sorted by distance, so near
    // and far drops are both heard. Level falls with distance (1 / (1 + d / 7)); far ones are duller (a.far).
    // NOTE: the note a drop rings as it lets go: its band's wet note, an octave lower for a big drop
    // (heavy D4 / D5, marble A5 / A6, mist E7)
    const NOTE = (band, size) => band === 0 ? (size > .33 ? 'D4' : 'D5') : band === 1 ? (size > .04 ? 'A5' : 'A6') : 'E7';
```

비 소리의 크기도 같다. 방울마다 놓여서 땅에 닿을 때까지 0.1초 간격으로 귀와의 거리를 재서 더한 곡선(10 Hz)이 빗소리 침대의 크기가 된다.

### 화성 규칙과 확인

`score.js`가 D 리디안을 둘로 나눈다. 젖은 음 D, E, A는 비를 내리고, 마른 음 F#, G#, B, C#은 아무것도 내리지 않는다. 배경 음악은 비가 보일 때만 젖은 음을 쓴다. 그래서 27초 북 전까지 배경 음악에는 D가 없다.
`FILM.music.check()`는 울림 22개마다 그 시각(1 ms 안)에 시작하는 소리가 있는지 본다. 긴 버퍼(잡음, 빗소리, 잔향 임펄스, 칼림바)는 인라인 Blob 워커에서 만든다. 같은 코드와 같은 시드라 메인 스레드에서 만들어도 샘플이 같다.

## 10. 카메라와 장면 (`film/camera.js`, `film/scenes/`)

[`film/camera.js`](../film/camera.js)는 장면들이 함께 쓰는 작은 도구다. 모두 평범한 배열을 돌려주므로 `keys()`로 바로 섞인다.

```js
  // a full-frame lens: focal length in mm -> vertical field of view in degrees (24 mm tall sensor). 35 mm -> 37.8 deg, 85 mm -> 16.1 deg
  const mm = f => 2 * Math.atan(12 / f) * 180 / Math.PI;
```

`orbit(중심, 거리, 방위, 높이각)`은 대상 둘레의 한 점, `hand(t, 크기, 빠르기)`는 손에 든 카메라의 작은 떨림(`wobble` 잡음, 매 프레임), `whip`은 휙 돌리기, `along`은 Catmull-Rom 경로다.
장면 파일은 머리 주석에 그 장면의 느낌(`Feeling`)과 카메라(`Camera`)를 적고, 장면에 따라 연기(`Action`), 시선의 흐름(`Eye`), 소리(`Sound`), 화면 설정(`Look`)을 덧붙인다. 코드는 15줄 안팎이다. 카메라가 따라갈 대상은 거의 언제나 `FILM.path`의 함수(`pell(t)`, `pellHead(t)`)다. 펠이 움직이는 식과 카메라가 겨누는 식이 같은 곳에서 나오므로 따로 맞출 일이 없다.

## 11. 제목 (`film/titles.js`)

마지막의 STILLRAIN과 머문 비는 글꼴 없이 붓으로 쓴다. 글자마다 획 몇 개를 점 목록으로 적어 두었다(곡선 획은 Catmull-Rom). `brush()`는 획을 49점으로 다시 나누고, 획 폭을 가로질러 가는 선 9가닥(붓털)을 나란히 그린다. 압력은 처음 8%에서 올라가고 마지막 40%에서 줄며, 획 뒤쪽에서는 붓털이 군데군데 끊긴다(갈필).

```js
        // pressure: rises over the first 8% of the stroke, falls to 45% over the last 40%, with a slight wave
        const u = i / (pts.length - 1), press = Math.min(1, u / .08) * (1 - .55 * sm(.6, 1, u)) * (.85 + .15 * Math.sin(u * 9 + seed));
        const ww = wid * press, nx = -dy / l, ny = dx / l, jit = (A.hash(seed, b, i) - .5) * wid * .06;
        const gap = u > .55 + dry * .4 && A.hash(seed * 3, b, Math.floor(i / 3)) < (u - .55) * 1.2;   // the brush running dry
```

제목은 영화 위에 겹친 2D 캔버스에 그린다. 정지 화면과 녹화 프레임에는 `FILM.titles(g, t, W, H)`가 같은 그림을 직접 그려 넣는다.

## 12. 확인 도구

| 도구 | 하는 일 |
|---|---|
| `python tools/build.py --check` | 묶기 전에 파일마다 `node --check`로 문법을 본다 |
| `python tools/build.py --out build/x.html --skip film/world.js` | 시험용 빌드. 파일을 빼면 `stub.js`나 모듈 안의 대역이 대신한다 |
| `node tools/shot.mjs` | 헤드리스 Chrome을 실제 GPU로 띄워 아무 시각의 화면, 여러 시각의 밀착 인화, 모듈의 시험 화면을 찍는다. 로딩 단계별 시간, 프레임 시간, 콘솔 오류를 JSON으로 출력한다 |
| `node tools/listen.mjs` | 같은 방식으로 소리를 오프라인 렌더해 WAV로 쓰고 음량(LUFS), 최고값, 클릭, 스펙트럼, 시작점을 잰다 |
| `python tools/record.py` | 프레임을 고정 간격으로 그려 받아 ffmpeg로 MP4를 만든다. 느린 컴퓨터에서도 프레임이 빠지지 않는다 |
| `FILM.dev.sweep()` | 영화 전체를 1/8초마다 그리지 않고 돌려, 카메라가 NaN이거나 땅·집·펠·후드 챙 안에 있거나, 펠이 주인공인 장면에서 펠이 화면 밖에 있는 구간을 찾는다. 0건이 목표다 |
| `FILM.dev.still(t)`, `sheet(times)`, `time(n)`, `override` | 한 장면 찍기, 밀착 인화, 프레임 시간 재기, 카메라 빼앗기 |

### 시험 화면

모듈은 자기 파일 안에 `FILM.test['이름'] = (k, s) => ({ cam, look })`로 시험 화면을 등록한다. `shot.mjs --test 이름 --k 0,1,2,3`이 k마다 한 칸씩 찍는다. 장면 파일이 없어도 모듈을 볼 수 있고, 다른 사람의 모듈을 고친 뒤에도 같은 자리에서 비교할 수 있다.

| 모듈 | 시험 화면 |
|---|---|
| `world.js` | `valley`, `village`, `sky` |
| `rain.js` | `field`, `drops`, `drop`, `release`, `hops`, `fall`, `story`, `voice` |
| `cast.js` | `pell`, `face`, `tock`, `dun` |
| `life.js`, `crowd.js` | `leaves`, `frog`, `birds`, `small`, `tadpoles`, `crowd`, `cloth` |

### 첫 로딩이 느린 이유: 셰이더 컴파일

이 영화는 GPU 프로그램을 150개쯤 쓴다(재질, 잉크, 그림자용 깊이 셰이더, 후처리; `FILM.dev.renderer.info.programs.length`로 셀 수 있다). Windows의 Chrome과 Edge는 WebGL을 ANGLE로 Direct3D에 옮기는데, 프로그램을 처음 그리는 순간에 컴파일한다. 미리 `renderer.compile()`을 불러도 그 시간이 숨겨지지 않는다.
그래서 로딩의 마지막 단계('셰이더를 굽는 중')가 장면의 물체를 8조각으로 나눠 한 조각씩 그린다. 영화 도중에 처음 보이는 물체 때문에 화면이 멈추지 않게 하려는 것이고, 조각 사이마다 로더의 막대가 움직인다. 첫 방문은 이 단계 때문에 15~20초쯤 걸리고, 그 뒤에는 브라우저가 컴파일한 셰이더를 캐시에 두므로 5초 안팎이다. 걸리는 시간은 GPU와 드라이버에 따라 다르다.

컴파일 시간을 줄이려고 코드에서 한 일:

- **루프 횟수를 유니폼으로.** `rain.js`의 셰이더는 `for (int k = 0; k < uEvN; k++)`처럼 유니폼 횟수로 돈다. 상수 횟수면 컴파일러가 루프를 풀어 버려 컴파일이 크게 느려진다.
- **목록을 텍스처로.** 구름 그림자와 젖음은 모든 재질이 계산하지 않고 '세계 지도' 텍스처를 한 번 읽는다.
- **셰이더 나누기와 합치기.** 땅은 칠하는 셰이더를 둘로 나눴고(하나로 합치면 1.5배쯤 느리다), 마을은 집·지붕·천·종·물독을 셰이더 하나로 합쳤다.
- `shot.mjs --profile 폴더`는 Chrome 프로필을 남겨 셰이더 캐시를 다음 실행에 다시 쓴다.

## 13. 바꿔 보기

코드를 읽은 뒤 직접 바꿔 보기 좋은 곳이다. 바꾼 뒤에는 `python tools/build.py`로 다시 묶고 `index.html`을 연다.

| 바꿀 곳 | 무엇 | 알아둘 것 |
|---|---|---|
| `film/events.js`의 `toll('drum', …)` | 북이 닿는 거리 40 m | 늘리면 27초에 더 많은 비가 떨어진다. 소리와 잎과 사람들의 반응도 표를 따라 함께 바뀐다 |
| `film/events.js`의 `C_SOUND` | 소리의 빠르기 30 m/s | JS 상수와 같은 파일 `GLSL` 문자열 안의 `C_SOUND = 30.0`을 함께 바꿔야 한다. `world.js`의 젖음 셰이더(`WET_EV_GLSL`)에도 `/ 30.0`이 따로 적혀 있다. 다른 모듈은 `FILM.events`에서 읽으므로 따라 바뀐다 |
| `music/score.js`의 `GRADE` | 장면별 그림자 색, lift, gain, 채도 | 장면이 `look`에서 직접 정한 값이 이긴다 |
| 장면 파일의 `look` | 초점, 블룸, 속도선 … | `film/engine.js`의 `E.render` 위에 키 목록이 있다 |
| 브라우저 콘솔 | `FILM.dev.override = s => ({ cam: { pos: [0, 60, 200], look: [0, 0, 0], fov: 40 }, look: {} })` | 카메라를 빼앗아 아무 곳에서나 본다. `null`로 돌려준다 |
