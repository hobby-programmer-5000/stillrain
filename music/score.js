// score.js - the film's clock: tempo, bars, the shot list and the grade of every shot.
// 80 bpm, 4/4, a bar is 3.000 s, 31 bars = 93.0 s. Every cut lands on a bar line.
// The tolls (what sounds, where, and which rain it brings down) live in film/events.js; music/synth.js plays the
// score and the tolls on this clock.
//
// Public API (FILM.score):
//   BPM 80, BEAT .75 s, BAR 3 s, BARS 31, LEN 93 s        tb(bar, beat) -> film seconds (bar 0-based)
//   midi('D4') -> 62, hz('A4') -> 440, pc(note) -> pitch class 0..11 (0 = C)
//   WET, DRY        D Lydian split in two (pitch classes): WET notes bring rain, DRY notes bring nothing (bible section 7)
//   SHOTS [{ id, t0, t1, ko, en }], shotAt(t)              the 17 shots with Korean and English titles
//   GRADE[id] { shade, lift, gain, sat, th, ink }         the colour grade of each shot      bars(t)  letterbox bar height
// Read by film/main.js (LEN, GRADE, bars), film/world.js (GRADE) and music/synth.js (tempo, notes, shots).
// The scene files (film/scenes/sNN.js) state their own t0 / t1 too; they match SHOTS.
// See it: the grade is in every frame, e.g. node tools/shot.mjs --t 3,40,67,90 --cols 2 --out build/grades.jpg
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM;
  const BPM = 80, BEAT = 60 / BPM, BAR = BEAT * 4, BARS = 31, LEN = BAR * BARS;
  const tb = (bar, beat = 0) => (bar + beat / 4) * BAR;      // bar 0-based
  // notes: 'D4' -> MIDI 62 (C4 = 60, A4 = 69) -> Hz (A4 = 440, equal temperament)
  const NAMES = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
  const midi = s => { const m = s.match(/^([A-G]#?)(-?\d)$/); return 12 * (+m[2] + 1) + NAMES[m[1]]; };
  const hz = s => 440 * Math.pow(2, ((typeof s === 'number' ? s : midi(s)) - 69) / 12);
  // D Lydian, split: WET notes bring rain, DRY notes bring nothing
  // (pitch classes: WET D E A, DRY F# G# B C#; the bands of events.js answer D, A and E)
  const WET = new Set([2, 4, 9]), DRY = new Set([6, 8, 11, 1]);
  const pc = s => (typeof s === 'number' ? s : midi(s)) % 12;

  // ---- the shot list (17 shots). id, start, end, Korean title, English title
  const SHOTS = [
    ['s01', 0, 6, '물방울 하나', 'One Drop'],
    ['s02', 6, 12, '홀로미어', 'Hollowmere'],
    ['s03', 12, 18, '쉿, 의 마을', 'Life Under the Hush'],
    ['s04', 18, 24, '코끝의 비', 'Nose Drop'],
    ['s05', 24, 33, '울림', 'The Toll'],
    ['s06', 33, 36, '초록 번짐', 'Green Flash'],
    ['s07', 36, 42, '돌풍', 'The Gust'],
    ['s08', 42, 48, '달리기', 'The Run'],
    ['s09', 48, 54, '징검다리', 'Stepping Stones'],
    ['s10', 54, 60, '종', 'The Bell'],
    ['s11', 60, 66, '마(間)', 'Ma'],
    ['s12', 66, 69, '한 음', 'The Note'],
    ['s13', 69, 72, '떨어지는 계단', 'The Falling Staircase'],
    ['s14', 72, 75, '비의 장막', 'Curtain'],
    ['s15', 75, 81, '초록 홍수', 'Green Flood'],
    ['s16', 81, 87, '소리를 내도 좋은 날', 'Noise Allowed'],
    ['s17', 87, 93, '머문 비', 'Stays'],
  ].map(([id, t0, t1, ko, en]) => ({ id, t0, t1, ko, en }));
  const shotAt = t => { let s = SHOTS[0]; for (const x of SHOTS) if (t >= x.t0) s = x; return s; };

  // ---- grade per shot (bible §8): shadow tint, lift, gain, saturation, bloom threshold, ink
  // shade: the hue the shadows lean to (main.js blends it 55% into FILM.U.uShade); lift raises the darks toward its rgb and gain
  // multiplies (engine.js); sat: saturation; th: how bright a pixel must be to bloom; ink: line colour, 'dark' or the
  // 'pale' warm rim lines of the backlit climax. A shot's own look values win over these (main.js).
  const G = (shade, lift, gain, sat, th, ink = 'dark', extra = {}) => ({ shade, lift, gain, sat, th, ink, ...extra });
  const NOON = G('#5B5A9E', [.02, .02, .04], [1.04, 1.0, .94], 1.08, .85);
  const GRADE = {
    s01: NOON, s02: NOON, s03: NOON, s04: NOON, s05: NOON, s06: NOON,                                 // noon, gold
    s07: G('#4C6B7A', [.03, .04, .06], [.96, 1.0, 1.04], .92, .9),                                    // the gust: slate-teal
    s08: G('#56609E', [.02, .02, .04], [1.02, 1.0, .98], 1.05, .82), s09: G('#56609E', [.02, .02, .04], [1.02, 1.0, .98], 1.05, .82), s10: G('#56609E', [.02, .02, .04], [1.02, 1.0, .98], 1.05, .82),
    s11: G('#5E6AA8', [.04, .04, .06], [1.0, 1.0, 1.0], .85, .8),                                     // ma: quiet, less colour
    s12: G('#7A6AA8', [.05, .04, .06], [1.08, 1.02, .96], 1.1, .65, 'pale'), s13: G('#7A6AA8', [.05, .04, .06], [1.08, 1.02, .96], 1.1, .65, 'pale'),   // backlit climax
    s14: G('#5B5A9E', [.03, .03, .05], [1.02, 1.0, .98], 1.0, .75),
    s15: G('#4E6A8E', [.02, .03, .04], [1.06, 1.03, .95], 1.12, .8), s16: G('#4E6A8E', [.02, .03, .04], [1.06, 1.03, .95], 1.12, .8),   // jade after the rain
    s17: G('#6B4E8E', [.05, .03, .07], [1.1, .98, .95], 1.0, .7),                                      // dusk
  };
  // letterbox 2.39:1 from 60.0 to 72.0 (eased in over 1.5 s, half a bar; gone at the hard cut to s14)
  // the value is each bar's height as a fraction of the screen: 2.39:1 inside 16:9 leaves (1 - (16/9) / 2.39) / 2 = 12.8%
  const bars = t => { const k = t < 60 ? 0 : t < 72 ? Math.min(1, (t - 60) / 1.5) : 0; return k * (.5 - .5 * (16 / 9) / 2.39); };

  F.score = { BPM, BEAT, BAR, BARS, LEN, tb, midi, hz, pc, WET, DRY, SHOTS, shotAt, GRADE, bars };
})();
