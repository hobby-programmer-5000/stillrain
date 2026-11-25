# STILLRAIN · 머문 비 — World Bible (build spec)

> **About this file.** This is the design bible, written before any code: the world, the cast, the shot list, the music and
> the look, as planned. The concept was picked from four candidates (A–D; the "graft from A / C / D" notes mark ideas taken
> from the others). The modules were then built from this spec and from `film/CONTRACT.md`. **The code is the final word:**
> where the two differ, the code is what the film does. The list below names the differences confirmed in the code.
> `README.md` explains how the code is laid out.

### Built differently (confirmed in the code)

- **Layout.** A bide-style tree (`film/`, `music/`, `tools/`, one file per shot in `film/scenes/`), not numbered `src/` modules. The module map at the end of §9 shows where each planned module went.
- **Reach of the tolls** (`film/events.js`). Dun's drum reaches 40 m, not 70, so about two thirds of the field still hangs after it. The four cupola bells reach 55 m, not 35, and ring 0.09 s apart, so they reach the mist veil 40–50 m above them. The small sustains carry a little further: frog 0.9 m (0.6), hum 1.6 m (1.4), test hum 1.2 m (1.0), palm hum 0.95 m (0.9).
- **The toll table** has 22 entries (one per mast chime, cupola and bell strike) in 24 uniform slots, not 16. Each toll also has a duration: a sustain that stops before its 1.5 s hold only makes the drops tremble. There is no GUSTS list: the gust is one envelope, `FILM.path.gust(t)` (it tears in at 36 s and settles to a steady wind by 44 s).
- **The field** (`film/path.js`). Base 44 m (about 15 m above terrace 9); strata heavy 0–14 m, marble 12–26 m, mist 24–38 m. It hangs over the north-east terraces from the start (it does not drift in over the west rim in S02), drifts east at about 2 m/s, and after the gust slides toward the Spillway at about 1.4 m/s (not 2.4).
- **The staircase** is 10 drops plus the heart drop (`FILM.path.hops`, `H`), not about 30.
- **Pell's fall** runs at 0.81 of the drops' fall (`PELL_FALL_K`), so the rain sinks past her: the fallback of §9.8, a little stronger than the 10% planned.
- **Old Dun** stays at her drum on terrace 9 from 22 to 81 s (she is not down on terrace 3 in S07).
- **The cast** (`film/sculpt.js`, `film/cast.js`). Bodies are sculpted from smooth-union SDF parts meshed with surface nets on the main thread, and bent by a skeleton: one `SkinnedMesh` per body. Not marching cubes in a worker, and not rigid parts without skinning.
- **Counts** (`film/life.js`, `FILM.life.counts()`): about 5.9k cup-leaves (planned 8k), 2.6k chime-reeds (3k), 4.2k sprouts (6k).
- **Shadows.** One 4096 sun shadow map (`film/engine.js`), refitted every shot with `E.shadowFit`.
- **Shots re-framed** (`film/scenes/`). S03 cuts to an insert on the dripfrog at 15.45. S04 has no rack focus to Dun; it cuts to a point-of-view reverse on Dun 22.5–23.3. S11's push ends under the hood brim, looking up into her eye. S14 is a 28 mm wide from the east rim by the Spillway, looking west (not 35 mm from the west rim). S16 cranes up and widens to 22 mm for the rainbow from 84.5. S17 holds a near-profile on the palm, pulls back from 90.4; the title writes itself 90.5–92.35 and the fade runs 92.4–93.0.
- **The check.** `FILM.dev.sweep()` (`film/main.js`) runs the film every 1/8 s and flags a NaN camera, a camera inside the ground, a house, Pell or her hood brim, and Pell off screen in her shots. The JS-vs-GLSL readback, audio and band-count checks of §9.9 are not part of it (`music/synth.js` checks toll timing itself).

---

Base candidate: **B — STILLRAIN**. It has the best combined judge total (B 118, C 116, A 115, D 80) and is both the most feasible and spectacular. Grafts from A, C and D are folded in only where they strengthen B. The film is pure three.js r170 (vendored, no addons), one HTML file, zero assets, and a Web Audio synth. It is built as `film/`, `music/` and `tools/` (one file per shot), with `tools/build.py`, `?t=` seek, and a `FILM.dev.sweep()` check that must return 0.

---

## 1. Title and logline

**STILLRAIN / 머문 비** (Meomun Bi, "the rain that stays")

**Logline:** In a highland valley where rain hangs in the air until a sound of its own pitch shakes it loose, the smallest apprentice rain-toller chases a runaway rain-field to the valley's rim. When her little bell cracks, she brings the sky down with her own voice.

**로그라인:** 비가 제 음높이의 소리를 들어야만 떨어지는 고원 계곡에서, 가장 작은 견습 종지기 소녀가 계곡 끝으로 흘러가 버리는 비를 쫓아간다. 작은 종이 깨지자 소녀는 자기 목소리로 하늘의 비를 내린다.

**Film constants** (shared by JS and GLSL; one source of truth in `film/events.js`; tempo and key in `music/score.js`):

```
LENGTH   = 93.0 s  = 31 bars          BPM = 80, 4/4, BAR = 3.000 s, BEAT = 0.750 s
DRAW     = 12 fps (on twos) for characters/creatures; boil+grain 12 fps when "live", 6 fps (fours) in silence
C_SOUND  = 30 m/s                     G_FILM = 6.0 m/s^2
VT       = { HEAVY: 14, MARBLE: 9, MIST: 2.2 } m/s   (terminal velocity per band)
HOLD     = 1.5 s                      (sustain needed for an off-octave note to release its band)
STEP_HOLD= 0.75 s                     (how long a heavy drop holds a light step)
KEY      = D Lydian; WET notes = D, E, A; DRY notes = F#, G#, B, C#
```

---

## 2. The rules of the world and their consequences

### Rule 1: Still water
Water condensed in the air does not fall by itself. Rain forms as glassy beads that hang where they formed. Wind drifts them as a loose, shimmering mass called a **rain-field**, which leans, stretches and folds like a flock of starlings. A drop falls only when a sound of its pitch reaches it. Each size answers one pitch class in any octave:

| Band | Size | Answers | Home octave (one strike releases) | Position in a field |
|---|---|---|---|---|
| HEAVY | 0.18–0.45 m (fist to melon) | **D** | D2 (73.4 Hz), the big drum | bottom stratum, plus hanging strands |
| MARBLE | 2–6 cm | **A** | A4 (440 Hz), the mast chimes | middle stratum |
| MIST | 2–8 mm | **E** | E6 (1318.5 Hz), the handbells | top veil, plus a thin haze throughout |

- **Strike vs. sustain.** A struck note in the band's home octave releases the band as soon as the sound arrives. A note in any other octave has to be **held for 1.5 s** after it arrives. Until then the drops only tremble harder and harder. A frog's long croak works this way, and so does a hum.
- **Loudness = reach.** A toy bell reaches about 2 m, Pell's handbell 4 m, a mast chime 45 m, Old Dun's drum 70 m.
- **A field is a resonator.** A note sustained *inside* a field is carried bead to bead to the field's edge (about 120 m). That makes it the strongest toll there is and the most dangerous, which is why nobody does it.

### Rule 2: Slow sound
Sound travels at about **30 m/s**. You can watch a note cross a field as a ring of releasing drops. Each drop flashes white-gold as the front passes, then lets go. Conversation across a terrace has a visible delay, so people sign instead of talking. (Film convention: audio plays at source time. The release-plink cascade is heard as the ring passes the camera.)

### Rule 3: The held step
A drop larger than a fist can hold a light step for about one heartbeat (0.75 s). It squashes like jelly, wobbles, then lets go. A felt-booted child can cross the air on stepping stones of rain, but only if she keeps moving.

### Corollaries (the world's physics, all on screen or implied)
- **Thunder is broadband**: every band falls at once. It means both flash flood and harvest.
- **Hanging fields evaporate** slowly in hot sun and shrink. That is the drought pressure: a field has to be rung down before it shrinks or drifts away.
- **The Hushlands**: beyond the Spillway notch lie dry plains where nobody lives to make a sound. A field that drifts there hangs uselessly until thunder.
- **Afterhang**: after any toll, a thin veil of stray mist stays at roof height. Laughter shakes it down as sparkles.
- **Wet notes and dry notes.** The D Lydian scale divides into WET (D, E, A), which bring rain, and DRY (F#, G#, B, C#), which bring nothing. Everyday music, lullabies and reed whistles use only dry notes. A child who hums a wet note gets a drop on the nose, the village's gentlest scolding.

### Consequences
- **Architecture.** Hollowmere is a bowl valley cut into nine stepped terraces of straw-gold earth held up by dry-stone walls. Houses stand on stilts under thick, rounded **hush-roofs** of felt and moss, so voices indoors never trigger drizzle. Doors are heavy felt curtains, because a slammed door rains on the doorstep. Every roof carries a small **toll-cupola** whose bell is muffled in a quilted sleeve; the sleeve comes off only when that house needs water. **Toll-masts** with tuned bronze bars stand on every terrace, each terrace with its own pitch. The tallest mast stands at the **Spillway**, a notch in the east rim where the wind leaves the valley. Bell-shaped clay **cisterns** catch runoff, and terraces have stone spill-channels for thunder floods.
- **Tools.** Toll-staffs carry tuned tines or a handbell. Drum-packs ring heavy rain. **Hush-fans** are 3 m felt paddles that teams sweep in unison to steer a field with wind, the way shepherds steer a flock. **Drop-pickers' gourds** on long poles pluck drinking water from low strands. **Hush-cloths** are great felt sheets that damp sound and break falls. **Mittens for bells** are the most common object in the village.
- **Jobs.** Rain-tollers, fanners, drop-pickers, muffle-weavers (felt makers), cistern-keepers, and the **Listeners**: elders who sit on the rim all day listening for thunder.
- **Clothing.** Quilted indigo cotton and thick felt, padded boots, wide drip-brim hoods, hair bound tight so it never rustles. Apprentices wear **persimmon-dyed hoods** so they can be spotted from the rim, since you cannot shout for a lost child. Hood brims carry felt tassels and a string of small glass beads. *(Graft from C: they work as a meter. They shiver for a few frames whenever a sound front passes the wearer.)*
- **Customs.** Hush culture. The greeting is a finger to the lips, then an open palm. Loud laughter is saved for after a Toll, because laughter means rain. Cradles have tiny felt canopies, since a crying baby gets a drizzle. Children learn the dry scale first.
- **Flora.** **Cup-leaves**: broad bowl-shaped leaves that swivel toward any sound to catch what it drops. **Chime-reeds**: hollow stems that whistle dry notes in the wind (F#, C#). **Hush-moss** grows thick on roofs and walls. **Sky-vines** spiral up hanging drop-strands like beans up a pole.
- **Fauna.**
  - **Dripfrogs** swell a throat-sac into a sustained D croak and drink the one drop it brings down.
  - **Bead-snails** climb drop-strands to graze the beads.
  - **Chimewings** are swallow-like birds whose wingbeats ring E. Each leaves a dotted line of mist drizzle that sinks slowly, like a pencil line being erased.
  - **Hushmoths** have felted, silent wings.
  - **Tocks** are fist-sized round birds with brass bell-throats. Each "tock-tink" call shakes down a pinch of mist, and children keep them as pets.
  - **Drop-tadpoles** (graft from D, kept tiny and amphibian) are dripfrog young that live inside big hanging drops and fall into cisterns when those drops are rung down.
- **Weather.** Towering cumulus with flat bases. Rain-fields drift in over the west rim on the prevailing wind. **Drop-strands** (vertical chains of beads left by old updrafts) hang from a field's underside to 2–3 m above the terraces like roots. The field casts soft, drifting dappled light on the terraces. Gusts steal fields, and thunder is feared and hoped for in equal measure.
- **Sound.** The default soundscape is tiny and close: felt steps, plips, a frog, reeds, wind, and bowl-valley echo. The village's music is literally its irrigation.

---

## 3. Cast

### PELL, 12, smallest apprentice rain-toller (hero; the only close-up character)
- **Silhouette** (must read as a black shape): a big round persimmon hood with a wide drip-brim (a bell or mushroom shape), a short triangular cape, fat felt boots, and a **2.0 m toll-staff** that towers over her 1.38 m height. Head about 1:4.6 of her height.
- **Hair:** russet-black `#3E2422` in two short, tight looped braids under the hood. One fringe lock escapes and is the only hair with secondary motion. Angel-ring highlight `#8E5A4A`.
- **Face** (shader decal):
  - Large amber eyes: iris `#9A5A1E` at the top grading to `#F6C66A`, with an `#E8A53A` mid band.
  - Two highlights (a large upper-left oval and a small lower-right dot), a thick plum upper lash line `#3A1F33` with a flick, and two soft lower lash strokes.
  - Five freckles per cheek `#C9846A`, plus blush hatch.
  - Skin `#F6DCC4`, with shadow hue-shifted to `#D9A3A0`.
- **Outfit:**

| Part | Color |
|---|---|
| Hood | persimmon `#E4572E`, moss lining `#6F9A3B` |
| Brim | 3 moss tassels and a string of 7 glass beads (the meter) |
| Cape | quilted indigo `#2F3E7A`, ochre diamond stitching |
| Undertunic | oat-white `#EFE6D2` |
| Trousers | moss felt `#6F8A4A` |
| Boots | oatmeal felt `#CDB892`, soles `#6B5A48` |

- **Props:** an ash toll-staff `#B08A5A` with a crook top, holding a small brass handbell `#D9A43A` in a moss felt mitten. Tock perches on the crook.
- **Personality through motion** (no dialogue, ever):
  - *Eager:* rocks heel to toe on twos, quick 2-drawing head turns, grips the staff with both hands.
  - *Sidelined:* shoulders drop over a 3-drawing hold. She starts to kick a pebble, stops herself mid-kick (hush culture), and puts her foot down silently.
  - *Reckless:* low forward-lean sprint, arms back, 3-frame anticipation crouches, smear frames on launches.
  - *Broken:* total stillness; the staff hangs from one hand; only the fringe lock and tassels move.
  - *Resolved:* one big inhale (chest rise held 3 drawings), feet planted, chin up.
  - *Joyful:* full laugh key, head thrown back, arms flung wide, a hop.
- **Build:** SDF parts (smooth-union capsules and ellipsoids) meshed at load by a hand-written marching cubes at 64³ per part. Hood = sphere minus inner sphere, plus a flattened torus brim. Rigid parts hang on an `Object3D` bone hierarchy; no skinning.
  - Poses are keyframed and sampled at `floor(t*12)/12`.
  - The cape is a parametric sheet (not SDF). It and the tassels run *on ones*, with lag computed analytically from the path derivative (`-k·vel(t-0.12)` plus a damped sine of acceleration). No verlet, so seeking needs no pre-roll.
  - Mouth keys: closed, small-o, ah (singing), oh, laugh. Brow keys: neutral, raised, furrowed, sad. Blink: 3 drawings.

### TOCK, her tock bird (companion)
- 0.11 m round body, sky blue `#7EC8F0` with a white belly `#F4F8FF`. A flared brass bell-throat `#D9A43A` under a tiny apricot cone beak, black bead eyes with one highlight each, and stub paddle wings.
- **Acting:** hops on twos and tilts his head in 3-drawing holds. He puffs up to 1.3× when startled, as comic relief. At the climax he opens his bell-throat and trills E6, harmonizing with her and bringing the mist veil down.
- **Build:** SDF sphere, ellipsoid throat, cone beak, two flat wing quads flapped in the vertex shader.

### OLD DUN, head toller
- 1.55 m, broad as a barrel. She carries a huge drum on her back: 0.9 m hide `#E3CFA6` with an oxblood hoop `#8A3B2A`. Thick grey braid `#B8B4AE` to the waist, patched ochre felt shawl `#C98B2E` with indigo squares, moss-brown robe `#6B5A3A`, felt mallet.
- **Acting:** slow and weighty, with 2-drawing anticipations. Finger to lips; open palm meaning "wait". At the end she wraps Pell in the shawl and taps her forehead.
- **Face:** narrow smiling ink-line eyes, wrinkle lines in the decal.

### Supporting life (simple procedural builds)
- **Villagers (80, InstancedMesh).**
  - Parts: capsule body 0.9–1.2 m, a cone hood with a brim disk, and an optional prop (fan paddle, gourd pole, mittened toy bell).
  - Felt palette: ochre `#C98B2E`, indigo `#2F3E7A`, moss `#6F8A4A`, oat `#CDB892`, rust `#9E4E2E`.
  - Children have dot eyes; adults are faceless under the brim shadow.
  - Per-instance role and phase. Vertex-shader cycles on twos: walk, sign, sweep, stomp, laugh-bounce, look-up.
  - The 18 fanners (3 teams of 6) also carry the hush-cloth, plus 2 more bearers.
- **Listeners (6 elders on the rim; graft from A).** Glacially slow held poses: one key pose every 4–6 s, eased in over 8 drawings. They act as a living clock against Pell's quick stepping.
- **Dripfrogs (12).** 0.12 m olive-jade `#6FA35A` with a cream belly, SDF-meshed. The throat-sac sphere `#F0D9C0` scales on a croak curve.
- **Bead-snails (60).** 3 cm pale-pink twisted-lathe shell. They crawl up strands at 1 cm/s, and when a strand is rung down they ride their bead down.
- **Chimewings (2 flocks of 40).** 0.2 m span, indigo back `#2A3570`, white belly, forked tail. They fly analytic splines with per-bird offsets and flap in the vertex shader.
- **Hushmoths (30).** Grey-lilac felt quads with a slow flutter, around houses.
- **Drop-tadpoles.** One heavy drop in 40 contains a 2 cm dark comma, drawn *inside the drop's fragment shader* (a 2D sprite on a circular path).
- **Cup-leaves (8k).** Instanced curved cards, olive-jade `#7FA84A` with pale undersides `#B9C97A`.
- **Chime-reeds (3k)**, thin instanced tubes. **Sprouts (6k)**, instanced, popping in Act 3. **Sky-vines (40)**, TubeGeometry helices.

---

## 4. Places

1. **Hollowmere Bowl** (establishing, the whole valley)
   - **Layout:** about 190 m rim radius. A floor pond of 40 m radius at y=0. Nine terrace rings, each 3.2 m high and 14–18 m deep, wobbled with noise; the rim sits at about 30 m. Stilt houses (about 45) on the south-facing slope. Masts on every terrace, cisterns along the paths. Peaks rise to 140 m around the bowl, with the Spillway notch on the east rim.
   - **Palette:** straw-gold `#D9A85B`, warm stone `#C9B79A`, violet-blue shadow `#5B5A9E`, cobalt zenith `#2F6FD6`, mint horizon `#CFE7F2`.
   - **Act 3:** wet jade `#3FAE7A` over deep moss `#2E6B4F`, with mirror-wet stone.
2. **Cistern Row** (life under the hush, terrace 6 path)
   - **Layout:** a 3 m path between a dry-stone wall and a row of bell cisterns, houses on stilts above. Drop-strands hang to 2.5 m over the path. Cup-leaf beds sit along the wall foot.
   - **Palette:** warm stone, felt indigo and ochre, olive cup-leaves, and silver-cyan strand beads catching sun.
3. **The Toll Terrace** (terrace 9, just under the rim)
   - **Layout:** a broad top terrace with Dun's drum station and three chime masts spaced 40 m apart, plus the fanners' staging ground.
   - **Palette:** brightest straw-gold, white glare. In Act 3 it flips first to jade and is where the hush-cloth catch happens.
4. **The Spillway Shoulder** (east rim; climax launch point and dusk coda)
   - **Layout:** a 22 m wide notch, 9 m deep in the rim. Beyond it is a cliff falling to the ochre-hazed Hushlands `#D8B98A`. The **Spillway mast** (12 m, bronze bars, rungs) stands on the shoulder, with the Listeners' stone bench beside it.
   - **Palette:** Act 2 has slate-teal `#4C6B7A` under cloud shadow, with white wind streaks. The dusk coda goes peach `#F2B48A` to lilac `#B39AD6`, with flooded terraces mirroring the sky in stepped bands.
5. **The Field** (aloft; the hero sequence)
   - **Layout:** about 160 m across after the gust. Base about 22 m above the rim. Heavy stratum 0–12 m, marble 10–24 m, mist veil 20–34 m, plus a thin haze throughout. Interior drop-strands form "bead curtains".
   - **Palette:** silver-cyan beads `#BFEFFF` with thin cyan rims `#5FC8E0`, white four-point star glints, and prismatic fringes when backlit. The village below is a gold disc. Strictly daylight; no warm points of light.

---

## 5. Signature motions, each with a procedural recipe

**Shared core (GLSL chunk with a JS mirror; every drop is a pure function of t):**

```glsl
// uEv[k]  = vec4(source.xyz, t0);  uEvP[k] = vec4(bandBits, radius, hold, kind)
float releaseTime(vec3 rest, float band, float seed){
  float tr = 1e9;
  for (int k = 0; k < 16; k++){ if (k >= uEvCount) break;
    vec3  p = rest + groupDrift(uEv[k].w);          // cheap analytic path only; lean ignored (<0.07 s error)
    float d = distance(p, uEv[k].xyz);
    if (d > uEvP[k].y) continue;
    if (mod(floor(uEvP[k].x / exp2(band)), 2.0) < 0.5) continue;
    tr = min(tr, uEv[k].w + d / C_SOUND + uEvP[k].z + 0.08 * seed);   // z = 0 (strike) or HOLD (sustain)
  }
  return tr;
}
// after release (tau = t - tr):  y = yRel - (VT*VT/G)*log(cosh(G*tau/VT))
// ground hit:                    tauHit = (VT/G)*acosh(exp(G*dh/(VT*VT)))  -> hide + splash crown 0.25 s
```

The release math is mirrored in JS. Instance attributes (rest position, band, size, seed) are generated in JS, so the audio and sweep systems know every drop exactly.

- **M1 RING-FALL.**
  - Each macro event draws an expanding world-space sphere shell of radius `C_SOUND·(t−t0)`: an additive fresnel at 0.08 alpha that also writes 2 px of refraction into a half-res distortion buffer.
  - Matching drops flash `#FFF3C8` for 0.2 s at `tArr`, then fall.
  - Non-matching drops shimmer at 0.05.
  - The result is a falling "necklace" ring, not uniform rain.
- **M2 CHORD STRATIFICATION.** Drum D2, then chimes A4, then bells E6 in successive bars peel the field in horizontal bands (`bandBits` per event). Because strata overlap only slightly, each peel reads as one layer of sky coming away.
- **M3 BEAD BREATHING + MURMURATION.**
  - Idle bob per drop: `0.015·s·sin(2π(0.25+0.2·seed)t + 6.28·seed)`.
  - Field motion: `drift = W(t) + shear·(y−yc)·ŵ·G(t) + 2.0·curl3(p·0.025 + (0,0,0.07t))·(0.3+G(t))`.
  - `curl3` comes from three analytic sine-sum potentials (no textures). `G(t)` is the gust envelope from the GUSTS list.
- **M4 HUSH-FAN SHEPHERDING.** For each fan k: `Δp = n̂_k·3.0·exp(−|p−F_k(t)|²/36)·(0.5+0.5·sin(2πt/1.5 − 0.8k))`. The sweep period is 2 beats, so each whoosh lands on a beat, and the felt-whoosh audio uses the same phase. The result is a visible fan-shaped dent in the bead mass.
- **M5 DROP-HOPPING (jelly steps; graft from D's wobble modes).**
  - About 30 hero icosphere drops (detail 3) along Pell's spline: `r(θ) = R[1 + a2(τ)P2(cosθ) + a3(τ)P3(cosθ)]`, with θ measured from the contact normal.
  - `a2 = −0.32e^{−5τ}cos(2π·3τ)`, `a3 = 0.08e^{−6τ}sin(2π·4.6τ)`.
  - Release at `τ = 0.75 s` (Rule 3) with a D plink.
  - Hero drops sample the opaque scene render target with a normal offset, so each holds a real inverted miniature of the valley.
- **M6 SUSTAIN TREMBLE.** For sustain events, between `tArr` and `tArr+HOLD`: `offset = 0.03·size·((t−tArr)/HOLD)²·sin(2π(14+6·seed)t)·dir(seed)`, plus a silver-to-white tint ramp. Used by the frog (S03), the nose drop (S04), the realization hum (S11), the climax (S12) and the palm drop (S17).
- **M7 CUP-LEAF WAVE (graft from C's damped springs).**
  - `yaw = base + Δ·(1 − e^{−ζωτ}cos(ω_d τ))` with `τ = t − tArr(leaf)`, `ω = 8`, `ζ = 0.3`, then a second spring back after 2.5 s.
  - The cup fills (brightens, adds a water disc) once rain lands.
  - Evaluated on twos.
- **M8 DRIPFROG GULP.** Sac scale `1 + 0.9·smoothstep(0, 1.5, τ)`, with a FM croak on the same envelope. The strand-tip drop trembles (M6), falls, and the mouth opens 2 drawings before impact. On the catch the body squashes flat 0.7× for 3 drawings and settles.
- **M9 CHIMEWING DRIZZLE TRAILS.** The bird spline `B(u(t))` emits a micro-release of 12 mist beads at each wingbeat time `t_k`, at `B(u(t_k))`. Each bead sinks at `VT_MIST`. The result is a dotted line that sinks and fades, which reads like an ink stroke.
- **M10 BEAD CURTAINS PARTING.** Strand beads get a lateral offset `±0.8·exp(−d_xz²/2)` from Pell's position, on a damped spring (so they swing aside and close behind her). Snails ride their bead.
- **M11 FALLING STAIRCASE.** The camera and Pell follow the *same* fall equation from `tr = 69.0`. Neighbour drops at distance d lag by d/30 s, so near rain seems to hang while the outer rings drift slowly upward relative to her. The terraces and the hush-cloth rush up below. The horizon is locked in the upper third.
- **M12 GREEN FLOOD.**
  - Wetness `w(x,z,t) = max(direct, cascade)`. *Direct* uses the hit time of the column above `(x,z)` from the same release math. *Cascade*: terrace index k turns wet at `75.5 + 0.5·(9−k)`.
  - Color = mix(straw, jade, w), plus gloss, sky reflection, and a darker 0.6 m water-line band at the front.
  - Sprouts: `s(τ) = 1 − e^{−6τ}cos(12τ)` sampled at `floor(τ·12)/12`.
  - Sky-vines: helix TubeGeometry (r 0.25 m, pitch 0.6 m) whose `drawRange` grows over 3 s on twos.
  - Cisterns overflow in a staggered chain, with tadpoles plopping in.
- **M13 LAUGHTER DRIZZLE.** Each laughing villager has an emitter 2.2 m above the head that releases 40 afterhang mist beads over the laugh's duration, each bead with a star glint.
- **M14 BELL CRACK.**
  - The smear mesh is the bell's vertices offset `−0.4·velocity` for 2 frames.
  - Impact frame A (57.000–57.083): post output is an inverted two-tone (`#1B1440` / `#FFF3E0`).
  - Impact frame B (57.083–57.167, graft from A): flat persimmon `#E4572E` fill with white Sobel lines.
  - The shard and clapper then tumble on slow analytic arcs.
- **M15 VOICE SHOCKWAVE.** At 66.0 and again at 67.5, a bright shell (M1 at ×4 intensity, plus star sparkles spawned on the shell) expands past the camera with 6 px refraction. The 66.0 onset gets the same 2-drawing impact pair as M14, but in pale gold.
- **M16 CHAIN SNAP (graft from C's petal-roof ripple).** Felt door-curtains and cupola sleeves flap on a spring with delay `dist(item, gust line)/18 m/s` at 36.0, rippling down the terraces.
- **M17 CLOTHING METER (graft from C).** Tassel and bead-string angle `0.25e^{−8τ}sin(2π·11τ)` at each front arrival, on ones, on every character. The sound ring therefore shows on people, not only on drops.
- **M18 THE DRAWING OBEYS THE RULE (graft from A).**
  - Post computes `live = max_k exp(−(t − tArr_k(p))/2.0)` per pixel, using the world position rebuilt from depth (a loop over at most 16 events).
  - `live > 0.5`: line boil, grain and drop twinkle refresh at 12 fps at full amplitude.
  - Otherwise they refresh at 6 fps at 30% amplitude.
  - Silence looks held; sound brings the drawing to life.

---

## 6. Shot list (17 shots, 93.0 s, every cut on a bar line at 80 bpm)

**S01 · 0.0–6.0 · bars 1–2 · "One Drop"**
- **Camera:** extreme macro, FOV 12°, on a heavy strand-tip drop. Dolly out 0.5 m to 14 m while FOV widens to 40° (cubic ease). Fade from black 0.0–0.75.
- **Action:** the drop bobs, holding the inverted golden valley (hero refraction), and a tadpole flicks inside. The pull reveals more drops, then thousands, in glinting strata.
- **Background:** slow field drift; cloud shadows crossing the far terraces; twinkle on fours (silence).
- **Sound:** at 0.75 one dry glass chime, B5. Wind tone fades in. At 3.0 a dry pad (B1, F#2, C#3). Nothing falls.

**S02 · 6.0–12.0 · bars 3–4 · "Hollowmere"**
- **Camera:** 28 mm crane from behind a terrace wall (foreground wall and blurred cup-leaves as a multiplane layer), rising 2 m to 40 m and tilting up.
- **Action:** the bowl valley, straw-gold terraces, stilt houses with round moss roofs, masts and cisterns. The vast field drifts in over the west rim, breathing like a flock. At 9.0 a chimewing flock crosses, leaving dotted drizzle lines: the first visible case of sound becoming rain.
- **Background:** cloud shadows, reeds swaying, tiny villagers on twos, cup-leaves twitching toward the birds.
- **Sound:** dry pad continues; reed whistles F#5 and C#6; tiny E7 wing-rings, each followed by a sparkle hiss.

**S03 · 12.0–18.0 · bars 5–6 · "Life Under the Hush"**
- **Camera:** 50 mm lateral truck along Cistern Row at 1.2 m/s. Crowd on twos.
- **Action:**
  - Villagers greet (finger to lips, open palm), and a drop-picker hooks a bead into her gourd.
  - **13.5:** a child's toy bell slips its mitten and jingles (E6, 1.8 m reach). A tiny sparkling ring of mist falls on two kids, and the other child shushes.
  - **14.25:** a dripfrog swells and croaks a sustained D3. The strand drop above it trembles, releases at 15.75, and drops into its mouth at 16.1; the frog squashes flat, content.
- **Background:** bead-snails climbing a strand, hushmoths, distant fanners carrying paddles uphill (setup).
- **Sound:** felt thumps, toy-bell jingle plus mist hiss, swelling FM frog croak, plip, gulp. Dry kalimba-like ostinato enters (F#, B, C#, G#).

**S04 · 18.0–24.0 · bars 7–8 · "Nose Drop"**
- **Camera:** 85 mm close push-in on Pell on a hush-roof ridge. Rack focus to Dun at 22.5.
- **Action:**
  - Pell mittens her bell, rocking on her toes; Tock hops onto the crook.
  - She hums idly in dry notes (F#4, G#4, B4). **20.25:** the hum slides down onto D4 and holds.
  - A strand drop above her trembles, releases at 21.75, and hits her nose at 22.4 (splash crown, 2-drawing squash blink). Setup for the climax.
  - **22.5:** Dun shushes, finger to lips, then raises an open palm toward Pell: wait, not you. Pell's shoulders drop (3-drawing hold).
- **Background:** fanners lifting paddles, Dun strapping on her drum, Listeners still on the rim.
- **Sound:** Pell's hum in the formant voice at −18 dB (this plants the climax timbre), plop, Tock's "tock-tink", felt-muffled drum taps.

**S05 · 24.0–33.0 · bars 9–11 · "The Toll"**
- **Camera:** 35 mm high tracking shot behind the fan teams, craning down to a low angle under the field by 27.0.
- **Action:**
  - The fanners sweep in staggered unison, and the field bulges over the top terrace with fan-shaped dents. Pell runs alongside, empty-handed.
  - **27.0:** Dun strikes D2. A visible ring crosses the field at 30 m/s, beads flash and the heavy layer comes down as an expanding falling curtain onto the top terrace. Every villager's tassels shiver as the front passes.
  - **30.0:** three masts ring A4, and a second, finer band peels away.
- **Background:** cup-leaf waves; wet patches darken.
- **Sound:** felt whooshes on beats 1 and 3. At 27.0 the D2 boom, the first tonic of the film. A D plink cascade rolls outward with a rush of heavy rain. At 30.0 an A4 bronze chord and a lighter hiss.

**S06 · 33.0–36.0 · bar 12 · "Green Flash"**
- **Camera:** 40 mm wide over the terraces, slow pan.
- **Action:** **33.0:** cupola bells ring E6 and the mist veil sinks as glittering haze. Cup-leaves swivel in spreading waves and fill. Wet patches flash jade. Villagers exhale together (shoulders drop on twos), and tadpoles plop into a cistern.
- **Background:** about two thirds of the field still hangs overhead.
- **Sound:** E6 bell cluster, mist hiss, leaf swish, a frog. The first wet-note fragment in the underscore (D4 E4 A4), allowed because rain is falling.

**S07 · 36.0–42.0 · bars 13–14 · "The Gust"**
- **Camera:** whip-pan 36.0–36.5 with horizontal speed lines, resolving to a 24 mm wide from mid-valley.
- **Action:**
  - The wind shifts. A cloud shadow races in (halftone inside it), with white streaks. Felt curtains and cupola sleeves snap in a chain down the terraces (M16).
  - The rest of the field tears loose and slides east toward the Spillway at 2.4 m/s, leaning like a flock. Fanners stumble and paddles twist.
  - Dun is far down on terrace 3. **39.0:** every hood turns east, staggered on twos. Pell, alone near the rim, grips her staff.
- **Background:** chimewings scatter in drizzle trails, reeds flatten, cup-leaves flip.
- **Sound:** gust roar; the pad sinks to a dry G#1/B1/C#2 cluster; scattered E rings; then only wind.

**S08 · 42.0–48.0 · bars 15–16 · "The Run"**
- **Camera:** 85 mm side-on track at a constant 6 m/s on ones, with foreground wall parallax. Tilts up from 45.0.
- **Action:** Pell sprints along the terrace-9 wall (body on twos), bounces off a hush-roof (moss squish) and lands on the Spillway mast at 44.25: 3-drawing crouch, then a 2-frame smear *on ones*. She climbs in two big smeared scrambles. **46.5:** she leaps from the mast top onto the first melon-sized drop, which squashes like jelly (M5). Tock flaps after her.
- **Background:** the field's edge sliding overhead, villagers turning below.
- **Sound:** pulse returns as a rising dry arpeggio in 8ths (B, C#, F#, G#); felt footfalls; rung "tok" clicks; a fat jelly "bloop".

**S09 · 48.0–54.0 · bars 17–18 · "Stepping Stones"**
- **Camera:** 35 mm ascending orbit, limited to 120° and always at a 3/4 front angle. Pell no more than 30% of frame height.
- **Action:** she drop-hops up a staircase of heavy drops into the field's heart. Each drop squashes, holds 0.75 s and falls behind her as a streak. Bead curtains part and close (M10); snails cling on; a tadpole spins in a drop she passes. Chimewings burst away in drizzle trails. Sun flares through the beads (star glints).
- **Background:** the strata above, and the valley as a gold disc far below.
- **Sound:** a D plink 0.75 s after each step (D4/D5); the arpeggio moves to 16ths; a dry bowed-glass pad swells; Tock's wings.

**S10 · 54.0–60.0 · bars 19–20 · "The Bell"**
- **Camera:** 50 mm close-up, slight low angle; the bell sits in the foreground with a rack between bell and face.
- **Action:**
  - **54.0:** she unmittens the bell and rings it (E6, 4 m reach). Only a small puff of mist falls around her. Background drops show the field still drifting.
  - She strikes faster and harder: 54.0, 54.75, 55.5, 55.875, 56.25, 56.625. Her face tightens.
  - **57.0:** the bell CRACKS (M14: smear, inverted frame, flat frame). The shard and clapper tumble away slowly, and she stares at the dead bell. 57.0–60.0 is silent.
- **Background:** Tock puffs up; the field's leading edge crosses the rim far below.
- **Sound:** a thin E6 handbell tuned +14 cents sharp, slightly out of the chord. At 57.0 an inharmonic crack and a dead tick, then **the score stops**.

**S11 · 60.0–66.0 · bars 21–22 · "Ma"**
- **Camera:** letterbox 2.39 eases in at 60.0. A 24 mm extreme wide from deep in the field pushes continuously in to an ECU on her eye by 64.5.
- **Action:**
  - Pell stands on a single drop at the heart of the glittering field. Far below are tiny hoods on dry gold; Dun looks up; a team runs uphill carrying the hush-cloth (planted).
  - **63.0:** her eye holds the whole field and the tiny village (graft from C; a 256² render from her eye).
  - **64.5:** a tiny test hum escapes her (D4, short). The drop beside her face shivers (M6 without release), and her brows lift.
  - **65.25:** she inhales, a 3-drawing hold.
- **Background:** only the bead bob; boil and grain on fours.
- **Sound:** near silence: wind at −30 dB, her breath, a distant plip at 62.25, the tiny hum at 64.5.

**S12 · 66.0–69.0 · bar 23 · "The Note"**
- **Camera:** 50 mm frontal close-up, backlit (sun behind her), slow push. Ink flips to pale rim lines; light leaks on.
- **Action:**
  - **66.0:** she sings A4. A ring of light bursts out (M15 plus the impact pair). Marble beads flash and fall away in an expanding ring.
  - **67.5:** the note lifts to D5, with a second, brighter ring. Every heavy drop trembles harder and harder (M6). Tock opens his bell-throat. Tassels and beads shiver continuously.
- **Background:** marble rain falling away below in a widening ring; rainbow fringes in the backlit beads.
- **Sound:**
  - Formant voice A4 ("ah"), lifting to D5 ("oh") with vibrato delayed 0.4 s.
  - A dry choir swells under it (B3, F#4, C#5).
  - An A plink cascade, and a rising glass tremolo for the trembling drops.

**S13 · 69.0–72.0 · bar 24 · "The Falling Staircase"**
- **Camera:** 28 mm, locked to Pell on the fall equation (M11), horizon tilt no more than 5°.
- **Action:** **69.0:** Tock trills E6 and the heavy band lets go. The whole field falls in concentric rings. Pell runs across the falling drops toward the cloth, *on ones* (sakuga), her cape and tassels streaming upward. Vertical speed lines frame the edges, and the terraces and cloth rush up.
- **Background:** the mist veil falling slower above; outer rings lagging.
- **Sound:** **first full wet tutti**: D2 sub plus a D Lydian choir (D3 A3 E4 F#4 D5). The rain roar builds, Tock's trill sits on top, and the voice holds D5 until 71.0.

**S14 · 72.0–75.0 · bar 25 · "Curtain"**
- **Camera:** hard cut to a 35 mm wide from the west rim; letterbox opens to full frame. Static, then a slight crane up.
- **Action:** a vast silver curtain pours across the upper valley in still-expanding rings. The leading fringe spills over the Spillway notch as a thin veil to the Hushlands. **73.0:** tiny Pell drops into the hush-cloth held by 20 villagers, with a squash-stretch bounce on ones over 4 frames. Splash crowns everywhere.
- **Background:** cup-leaves on every terrace swivel up.
- **Sound:** rain roar at its peak; villagers' felt drums on D2/D3 at 72.0 and 73.5; a deep soft thud at 73.0.

**S15 · 75.0–81.0 · bars 26–27 · "Green Flood"**
- **Camera:** 28 mm low wide at cloth level, then a crane up and back over the terraces.
- **Action:** Pell sits up soaked and blinking, hood flattened; Tock shakes off water with a smear. **75.5:** the GREEN FLOOD cascades down the terraces, gold to jade, one terrace every 0.5 s (M12). Sprouts pop on twos, sky-vines corkscrew up the remaining strands, cisterns overflow in a chain, tadpoles plop in.
- **Background:** late rain thinning to sparse big drops; the afterhang veil at roof height.
- **Sound:** rain on felt thinning; plucks for each pop (F#5 G#5 B5 C#6); low cistern glugs; the choir sustaining D.

**S16 · 81.0–87.0 · bars 28–29 · "Noise Allowed"**
- **Camera:** 50 mm handheld feel (noise sway on ones), moving along the crowd to Pell and Dun. The camera faces east with the sun behind it.
- **Action:**
  - Children stomp puddles, frogs chorus, and every laugh shakes a sparkling drizzle from the afterhang (M13).
  - **82.5:** Dun wraps Pell in the ochre shawl and taps her forehead.
  - **84.0:** Pell laughs out loud, and a little sparkle shower forms over her own head.
  - **84.75:** the sun breaks through, and a rainbow arcs over the Spillway behind them.
- **Background:** crowd on twos, dripping cup-leaves, chimewings returning with drizzle trails, Listeners slowly raising their hands.
- **Sound:** frog chorus on D3, children's formant yips, laughter, and the **full theme** in D Lydian.

**S17 · 87.0–93.0 · bars 30–31 · "Stays"**
- **Camera:** dusk. A slow pull-back crane, 35 mm to 24 mm.
- **Action:**
  - Hours later, under a peach-lilac sky. The flooded terraces mirror it in stepped bands. Pell sits on the Spillway bench with the cracked bell in her lap and Tock on her hood.
  - A fresh field glints cool lilac-silver over the north peaks.
  - **88.5:** she hums D4. The one stray drop before her trembles and falls into her cupped palm at 90.3. Inside it is the inverted dusk valley, rhyming with S01.
  - **90.0:** STILLRAIN draws itself stroke by stroke, then 머문 비 beneath it at 91.5. Fade to black 92.25–93.0.
- **Background:** frogs, mirror ripples from a few drips, Listeners walking home.
- **Sound:** music-box reprise of the hush motif (B5, C#6, F#5), answered after the palm drop by the toll motif (A5, E5, D5): the film's last resolution to D lands with the drop. Her hum echoes once around the valley. Silence at 93.0.

---

## 7. Music

- **Tempo and form.**
  - **Meter:** 80 bpm, 4/4, 3.0 s bars, 31 bars.
  - **Key:** D Lydian, split into **WET (D, E, A)** and **DRY (F#, G#, B, C#)**.
  - **Harmonic idea:** the film withholds its tonic. D first sounds as a full chord at the first Toll (27.0), arrives in full only at the fall (69.0), and resolves last on the palm drop (90.3). **Tonic = rain.**
- **Motifs:**
  - Hush (dry): B, C#, F#.
  - Toll (wet, falling): A, E, D.
  - Pell's line: F#, G#, B, sliding to D.
  - Theme (bars 28–29): `D5 E5 F#5 A5 | G#5 F#5 E5 D5`, over Dadd9, E/D, Bm11, Dmaj9.
- **Form by bars:**

| Bars | Section | Music |
|---|---|---|
| 1–4 | Hush | dry pad |
| 5–8 | Life | dry kalimba ostinato; small wet tastes from the frog D3 and the hum D4 |
| 9–12 | Toll | whoosh pulse; D2, A4, E6 on downbeats |
| 13–14 | Gust | dry cluster |
| 15–18 | Run | dry arpeggio, 8ths then 16ths, plus D plinks |
| 19–20 | Bell | the crack cuts everything |
| 21–22 | Ma | silence |
| 23 | Voice | voice over dry choir |
| 24–25 | Fall | wet tutti |
| 26–27 | Green | plucks and choir |
| 28–29 | Laughter | theme |
| 30–31 | Dusk | music box and hum |

- **Instruments** (all synthesized; buffers pre-rendered in JS at load where noted):

| Instrument | Recipe |
|---|---|
| Dun's drum D2 | sine with pitch drop 2.2×→1× over 60 ms + lowpassed noise burst + felt thump |
| Felt drums | the same at D2/D3, softer attack |
| Mast chimes A4 | free-bar partials 1, 2.756, 5.404, 8.933; exponential decay 3.5 s, upper partials faster |
| Handbells E6 | 1, 1.19, 1.5, 2.0, 2.66; Pell's bell +14 cents |
| Bell crack | detuned partials spread inharmonically, noise click, 80 ms |
| Pell's voice | saw + pulse (duty 0.35) → three parallel bandpass formants, "ah" (800/1150/2900 Hz) morphing to "oh" (450/800/2830 Hz), Q 8–12; 5.5 Hz vibrato at 25 cents, delayed 0.4 s; breath noise 2–4 kHz; 120 ms attack. **Fallback:** ocarina (sine + 0.15 second harmonic + breath) |
| Choir | 6 detuned saws per note → lowpass 1.8 kHz, slow attack |
| Kalimba plucks | Karplus-Strong buffers rendered at load |
| Bowed glass | sine pairs detuned by 0.7 Hz, slow swell |
| Reeds | sine + bandpassed noise on F#/C# |
| Wind and gust | filtered noise with LFO |
| Rain | noise through 1.5–6 kHz bandpass + lowpassed rumble; gain follows the analytic count of falling drops near the camera, baked at load into a 10 Hz curve and applied with `setValueCurveAtTime` |
| Release plinks | sine sweeping 1.6f→f over 25 ms, 120 ms decay, pitched to the band's pitch class at an octave set by size |
| Frog | FM, carrier D3, ratio 1.5, index following the sac |
| Tock | wood click + E6 bell sine |
| Chimewings | tiny E7 FM bells |
| Music box | partials 1 and 4.2, fast decay |
| Reverb | ConvolverNode with a generated 3.2 s stereo exponential-noise "bowl" impulse, plus a 1.2 s lowpassed valley echo |

- **How the score drives the picture.** One **TOLLS** table in `film/events.js` is both uploaded as shader uniforms (at most 16 events) and scheduled on the AudioContext. Sight and sound cannot drift apart.

```
id        t0     source              pitch  pc band   kind     reach  hold
toybell   13.50  child, Cistern Row  E6     E  MIST   strike    1.8   0
frog      14.25  frog, cistern rim   D3     D  HEAVY  sustain   0.6   1.5
hum       20.25  Pell head           D4     D  HEAVY  sustain   1.4   1.5
drum      27.00  Dun, terrace 9      D2     D  HEAVY  strike   70     0
chimes    30.00  masts ×3            A4     A  MARBLE strike   45     0
cupolas   33.00  cupolas ×4          E6     E  MIST   strike   35     0
bell1..6  54.00–56.625 Pell bell     E6     E  MIST   strike    4     0
voiceA    66.00  Pell (in field)     A4     A  MARBLE strike  120     0      // home octave
voiceD    67.50  Pell (in field)     D5     D  HEAVY  sustain 120     1.5    // releases 69.0 + d/30
tock      69.00  Tock                E6     E  MIST   strike   60     0
testhum   64.50  Pell                D4     D  HEAVY  sustain   1.0   1.5    // ends early: tremble only
palm      88.50  Pell                D4     D  HEAVY  sustain   0.9   1.5
GUSTS: {t0: 36.0, line: west rim, speed: 18 m/s, envelope 36–41}
```

  - **Micro emitters** (chimewing rings, laughs, footstep releases) are computed by their owner systems from the same deterministic functions, which also schedule their audio.
  - **Plink cascades:** at load, each macro event samples the drops within 30 m of that shot's camera path and schedules up to 60 plinks at their exact release times, with gain falling off by distance.
  - Cup-leaves, clothing meters (M17), and the live-drawing mask (M18) all read the same table.
- **Mixing laws.**
  1. The non-diegetic underscore never plays a wet note unless rain is visibly falling in frame.
  2. Every diegetic wet note releases something on screen.
  3. Silence (bars 21–22) is absolute apart from wind, breath and the one plip.
- **Scheduler:** 100 ms lookahead, driven by film time. On `?t=` seek it cancels and reschedules. A drawn ▶ glyph (canvas paths, no font) supplies the user gesture that starts the AudioContext.

---

## 8. Anime look spec

- **Shading.**
  - **Characters:** 3-band toon. Lit when N·L > 0.45; mid band 0.10–0.45 (40% shadow tint); shadow band below 0.10. Band edges smoothstep over 0.015.
  - **Shadow color:** base × act shadow tint, saturation +12%. Never grey.
  - **Environment:** 2-band toon plus painted ramps: height-based color drift, brush-noise breakup of ±4% hue and value, stone courses and straw streaks drawn in shader, baked wall AO lines.
  - **Rim light:** fresnel^3, thresholded at 0.6, sun-side only, `#FFE6B0`.
  - **Hair:** angel-ring band.
- **Shadows.** One 2048 directional shadow map for characters and near props only, band-stepped. Terrain gets analytic cloud shadows from the same blob function as the cloud sprites. The field's underside casts soft, drifting dappled light.
- **Halftone (graft from A).** In cloud-shadow regions: 45° screen dots, period 5 px at 1080p, radius proportional to shadow, opacity 0.18 in the ink color.
- **Outlines.**
  - **Inverted hull** on characters, houses, masts, cisterns and props: 1.6 px at 1080p, distance-clamped.
  - **Sobel pass** on depth, normal and object ID (MRT `WebGLRenderTarget` with `count: 2`; attachment 1 holds the encoded normal plus ID). 1 px.
  - **Ink color** = base value × 0.38, hue shifted 15° toward violet, saturation +10%. Never black. Land umber `#4A2E2A`, characters plum `#3A1F33`, Pell's hood `#8A2A1A`, cloud edges indigo `#2A2F6B` at 40%.
  - **ID mask:** the Sobel skips drops, mist, particles, grass, reeds and sprouts.
  - **Ink flip (graft from C):** during the backlit climax (66–72) ink turns to pale warm rim lines `#FFE2C4`.
- **Drops** (the most important material; validate with still frames first).
  - Kidney-shaped highlight upper-left, a small secondary glint lower-right, a thin darker cyan rim `#5FC8E0`, and an inverted sky-over-ground gradient inside.
  - Four-point star glints `pow(max(0, R·L), 64)` on the boil clock.
  - Alpha-test bodies with additive-only highlights.
  - Near-camera drops become soft bokeh discs, clamped to 180 px.
  - Hero drops refract the opaque scene RT. Mist renders as `gl.POINTS` of 1–3 px.
- **Sky and clouds.**
  - **Dome:** zenith `#2F6FD6`, mid `#5DB2F0`, horizon `#CFE7F2`, overlaid with horizontal brush-stroke fbm stretched 8:1 at ±3%. Sun disk `#FFF6D8` with halo.
  - **Cumulus:** about 30 billboards with fbm-threshold silhouettes, edge smoothstep 0.48–0.50, three tones (lit cream `#FFF8EC`, mid `#E6DDF0`, lilac core `#9A8FC9`). Flat bases (density × smoothstep at the base plane), sun-side rim, towering 3–5 sprite stacks on the horizon.
- **Effects.**
  - **Bloom:** quarter-res, 5 levels.
  - **Light leaks:** two drifting edge gradients, peach `#FFC79A` and cyan `#A8F0FF`, additive 0.15, in backlit shots.
  - **Lens flare:** 5 ghost discs along the sun-to-center axis, gated by a 9-tap depth occlusion test.
  - **Speed lines:** parallel (gust), vertical (fall), radial (whip); tapered strokes stepped on twos.
  - **Impact frames:** at 57.0 and 66.0.
  - **Shockwave refraction.**
  - **Rainbow:** a post effect around the anti-solar point. 42° ± 1°, red outside, alpha 0.35, with a secondary bow at 51° at alpha 0.12. Masked to sky and rain only; S15–S16.
  - **Letterbox:** 2.39, from 60.0 to 72.0.
  - **Grain** (blue-noise hash, amplitude 0.035) and vignette.
- **On-twos rules.**
  - Characters, crowd, creatures, cup-leaves and sprouts: pose time = `floor(t·12)/12`.
  - Camera, drops, mist, cloth, tassels and light: on ones.
  - Sakuga on ones: the S08 launch and leap, the whole of S13, the S14 bounce.
  - Holds: 3 drawings of anticipation before every leap and before the note. Smears: 1–2 frames on leaps, the bell strike and Tock's shake.
  - Boil and grain follow M18.
- **Title.** Brush strokes are hand-authored polylines in code for S T I L R A N and 머문 비. Hangul's straight strokes are easy to author. Each stroke is rendered as an SDF brush with bristle noise and drawn on in sequence. No fonts.
- **Per-shot grade keys** (lift/gamma/gain uniforms on the timeline; graft from C):

| Shots | Shadow tint | Lift (rgb) | Gain (rgb) | Sat | Bloom thr | Ink |
|---|---|---|---|---|---|---|
| S01–S06 noon | `#5B5A9E` | .02 .02 .04 | 1.04 1.00 .94 | 1.08 | 0.85 | dark |
| S07 gust | `#4C6B7A` | .03 .04 .06 | .96 1.00 1.04 | 0.92 | 0.90 | dark |
| S08–S10 run, bell | `#56609E` | .02 .02 .04 | 1.02 1.00 .98 | 1.05 | 0.82 | dark |
| S11 ma | `#5E6AA8` | .04 .04 .06 | 1.00 1.00 1.00 | 0.85 | 0.80 | dark |
| S12–S13 backlit | `#7A6AA8` | .05 .04 .06 | 1.08 1.02 .96 | 1.10 | 0.65 | pale `#FFE2C4` |
| S14 wide | `#5B5A9E` | .03 .03 .05 | 1.02 1.00 .98 | 1.00 | 0.75 | dark |
| S15–S16 jade | `#4E6A8E` | .02 .03 .04 | 1.06 1.03 .95 | 1.12 | 0.80 | dark |
| S17 dusk | `#6B4E8E` | .05 .03 .07 | 1.10 .98 .95 | 1.00 | 0.70 | dark |

Gamma is 1.0 throughout, except 0.95 for S11.

---

## 9. Risks and fallbacks

1. **Echo of the reference film's lantern flight** (a hero among thousands of glints in the sky).
   - Daylight only; cool silver-cyan refractive water; no night; no warm points of light. The dusk field is lilac-silver.
   - Field shots are dominated by falling streaks and ring releases, not floating.
   - No mount, market, balloons, lanterns, tea, underwater, whales or lighthouses.
2. **Adjacency to a well-known weather-girl anime.** No prayer, shrine, city, sky realm or "chosen one". Pell is an apprentice of a craft, and the mechanics (sound physics, felt hush culture, fans, masts, a rural terraced valley) stay front and center.
3. **Drops reading as snow, glitter or bokeh noise.** The drop material in §8 is mandatory. Validate S01, S05 and S09 as still frames before building motion. Fallback: fewer mist points, more heavy drops near the camera, stronger cyan rims.
4. **Overdraw at 1080p on the RTX 2070 Max-Q.**
   - Budget: heavy drops 6k instanced quads, marble 40k quads (≤ 24 px), mist 100k points, 8k strand beads included.
   - Alpha-test bodies, additive highlights only, near-size clamp, distance LOD.
   - Pixel ratio 1; about 180 draw calls; post = ink + composite, quarter-res bloom, half-res distortion, grade.
   - Profile S09 and S13 in week one. Fallback: render mist in a half-res pass.
5. **A cheap-sounding synth voice at the climax.** The voice is planted early at low level (S04) so the ear accepts it. It sounds for only about 5 s (66–71) and sits inside the dry choir and Tock's trill. A/B test it against the ocarina fallback in week one.
6. **Hero face quality.** Close-ups (S04, S10, S11 ECU, S12) are frontal or 3/4 only, with no profiles. The S09 orbit is capped at 120° with Pell small in frame. Test the face shader at four angles in days 1–3; beyond 12 m switch to dot eyes.
7. **Rule legibility in the first 30 s.** The rule is taught in order, with a triple cue each time (motion, a white-gold flash, a plink):
   - wingbeat drizzle (9.0)
   - the toy-bell mini-ring and shush (13.5)
   - the frog's sustain (14.25–16.1)
   - the nose drop (20.25–22.4)
   - the first big ring (27.0)

   Fallback: louder plinks, brighter flashes, a longer frog tremble.
8. **The falling staircase reading as a static camera.** Keep the horizon in the upper third, terraces rushing up, vertical speed lines, tassels streaming up and outer rings visibly lagging, then the hard cut to the wide at 72.0. Fallback: the camera falls 10% slower than the drops so the rain sinks past her slightly. The shot stays at 3 s for motion comfort.
9. **Determinism.** Everything is a pure function of t, including cape and tassel lag (analytic, no verlet), so seeking needs no pre-roll. `FILM.dev.sweep()` samples every 0.5 s and must report 0 failures:
   - NaN checks;
   - Pell's on-screen bounding box in every shot she is in;
   - JS-vs-GLSL release-time mismatches at 64 probe drops (readback);
   - every TOLLS entry having a scheduled audio node within 1 ms;
   - band counts invariant (no drop released twice);
   - frame cost.
10. **Load time.** Marching cubes runs in a Blob Web Worker from inline source, 64³ per part, cached. Target under 2.5 s to first frame.
11. **Act 1 pacing.** The sidelined beat and the voice setup are merged (S04), and the shepherding is merged into the Toll (S05). If it still sags, S03 drops to one bar and S02 absorbs the frog.
12. **Hood color.** Persimmon is chosen so Pell reads against gold (Act 1), cyan (Act 2) and jade (Act 3). It must never be desaturated by grading: protect it with a hue-locked saturation term.

**Build order to retire risks:**
1. Drop material stills.
2. TOLLS table + release math + sweep.
3. Face shader.
4. Voice synth.
5. Field LOD profiling.
6. Terrain and village.
7. Characters and crowd.
8. Shots S11–S14 (climax) first, then the rest in order.
9. Post and grade polish.

**Module map** (as planned, with the file each part became):
- `00_util` (hash, noise, springs, fall math) → `film/anim.js`; the fall math in `film/events.js`
- `02_look` (toon and ink materials, palette, grade keys) → `film/engine.js`; grade keys in `music/score.js`
- `03_sculpt` (SDF and marching-cubes worker) → `film/sculpt.js` (surface nets, no worker)
- `05_events` (TOLLS, GUSTS, GLSL chunk and JS mirror) → `film/events.js`; the gust in `film/path.js`
- `06_score` → `music/score.js`
- `08_path` (cameras, Pell's spline) → `film/path.js`; cameras in `film/camera.js` and `film/scenes/`
- `10_valley` (terraces, wetness) → `film/valley.js` (the map); `film/world.js` draws it
- `20_village` (houses, masts, cisterns, curtains) → `film/world.js`
- `24_flora` (cup-leaves, reeds, sprouts, sky-vines) → `film/life.js`
- `30_field` (drops, mist, strands, splashes, hero drops) → `film/rain.js`
- `40_pell` (Pell, Tock, Dun, face shader) → `film/cast.js`
- `44_life` (crowd, frogs, snails, chimewings, moths, tadpoles) → `film/life.js` (creatures) and `film/crowd.js` (people)
- `50_sky` (dome, clouds, shadows) → `film/world.js`
- `70_film` (shot table) → `music/score.js` (the list) and `film/scenes/s01.js` … `s17.js` (+ `film/titles.js`)
- `80_post`, `85_audio`, `90_main` → `film/engine.js`, `music/synth.js`, `film/main.js`
- `tools/build.py` inlines vendored r170 into a single `dist/stillrain.html`.