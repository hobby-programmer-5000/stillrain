// titles.js - the title, written with a brush by code: no fonts. STILLRAIN, then 머문 비 beneath it (bible S17).
// Every letter is a few hand-placed strokes; each stroke is drawn as a tapered brush with bristles that run dry at the end,
// one stroke after another. Drawn on a 2D canvas over the film (and into recorded frames by main.js).
//
// How it works: a stroke is a list of points in a letter box (Catmull-Rom smoothed when marked c: 1). brush() resamples it
// to 49 points and draws nine thin bristle lines side by side across the stroke width. Pressure swells in at the start and
// thins toward the end, each bristle wobbles a little, and past the middle of the stroke bristles start to skip (dry brush).
// word() hands each stroke an equal slice of the writing time, so the title appears in the order it would be written.
// Timing (film seconds): STILLRAIN 90.5-91.8, 머문 비 91.7-92.35, both fade out 92.4-93.0. (The bible lists
// 90.0 / 91.5 / 92.25-93.0; this file uses the times above.)
// API: FILM.titles(g, t, W, H) draws the card for film time t into a 2D context of W x H px (used for stills and recording);
//      FILM.overlay(t) keeps a transparent canvas over the live page and draws into it (main.js calls it every frame).
// Sizes scale with H (designed at 1080 px). Reads FILM.anim (clamp, sm, lerp, hash, crPoint, ease).
// To see it:  node tools/shot.mjs --t 91,91.8,92.3 --cols 3 --w 640 --out build/title.jpg
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, A = F.anim, { clamp, sm, lerp } = A;
  // letters in a box 1 wide, 1.36 tall (y down). Each letter: list of strokes; a stroke: list of points (smooth = curve)
  // { p: points, c: 1 } is a curve through the points; without c the points are joined by straight lines.
  // Only the letters of STILLRAIN are needed.
  const L = {
    S: [{ c: 1, p: [[.86, .2], [.56, .02], [.2, .14], [.22, .46], [.62, .66], [.86, .98], [.62, 1.3], [.12, 1.18]] }],
    T: [{ p: [[.02, .06], [.98, .02]] }, { p: [[.5, .04], [.5, 1.32]] }],
    I: [{ p: [[.5, .04], [.5, 1.32]] }],
    L: [{ p: [[.16, .04], [.16, 1.28], [.9, 1.26]] }],
    R: [{ p: [[.16, .04], [.16, 1.32]] }, { c: 1, p: [[.16, .05], [.58, .04], [.86, .24], [.78, .56], [.5, .68], [.18, .68]] }, { p: [[.46, .68], [.9, 1.32]] }],
    A: [{ p: [[.5, .02], [.08, 1.32]] }, { p: [[.5, .02], [.94, 1.32]] }, { p: [[.26, .86], [.76, .84]] }],
    N: [{ p: [[.12, 1.32], [.12, .04]] }, { p: [[.12, .04], [.88, 1.32]] }, { p: [[.88, 1.32], [.88, .04]] }],
  };
  // hangul in a box 1 x 1 (each syllable's strokes in writing order: top to bottom, left to right)
  const K = {
    '머': [{ p: [[.08, .26], [.08, .74]] }, { p: [[.08, .26], [.5, .24], [.48, .74]] }, { p: [[.09, .74], [.48, .74]] }, { p: [[.82, .04], [.82, .98]] }, { p: [[.56, .5], [.81, .5]] }],
    '문': [{ p: [[.24, .05], [.24, .32]] }, { p: [[.24, .05], [.76, .04], [.75, .32]] }, { p: [[.25, .32], [.75, .32]] }, { p: [[.05, .49], [.95, .47]] }, { p: [[.5, .48], [.5, .66]] }, { p: [[.2, .72], [.2, .95], [.86, .94]] }],
    '비': [{ p: [[.1, .1], [.1, .9]] }, { p: [[.52, .1], [.52, .9]] }, { p: [[.1, .46], [.52, .46]] }, { p: [[.1, .9], [.52, .9]] }, { p: [[.84, .04], [.84, 1.0]] }],
  };
  // n + 1 points spread along a stroke: along the Catmull-Rom curve if smooth, else evenly by length along the polyline
  const resample = (pts, smooth, n) => { const out = []; if (smooth) for (let i = 0; i <= n; i++) out.push(A.crPoint(pts, i / n));
    else { const seg = []; let tot = 0; for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); tot += d; }
      for (let i = 0; i <= n; i++) { let s = i / n * tot, j = 0; while (j < seg.length - 1 && s > seg[j]) { s -= seg[j]; j++; } const k = seg[j] ? s / seg[j] : 0; out.push([lerp(pts[j][0], pts[j + 1][0], k), lerp(pts[j][1], pts[j + 1][1], k)]); } }
    return out; };
  // one brush stroke, drawn up to fraction k, in box (x, y, w, h); width in px
  // (x, y) is the top-left corner of the letter box; seed makes each stroke's bristles and dry gaps its own
  function brush(g, st, x, y, w, h, wid, k, seed) {
    const pts = resample(st.p, st.c, 48).map(q => [x + q[0] * w, y + q[1] * h]); const n = Math.max(1, Math.floor(k * (pts.length - 1))); if (k <= 0) return;
    const B = 9;   // bristles across the stroke
    // each bristle is its own path, offset sideways from the centre line (off -0.5 .. 0.5 of the width)
    for (let b = 0; b < B; b++) { const off = (b / (B - 1) - .5), dry = A.hash(seed, b, 3); g.beginPath();
      for (let i = 0; i <= n; i++) { const p = pts[i], a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)], dx = c[0] - a[0], dy = c[1] - a[1], l = Math.hypot(dx, dy) || 1;
        // pressure: rises over the first 8% of the stroke, falls to 45% over the last 40%, with a slight wave
        const u = i / (pts.length - 1), press = Math.min(1, u / .08) * (1 - .55 * sm(.6, 1, u)) * (.85 + .15 * Math.sin(u * 9 + seed));
        const ww = wid * press, nx = -dy / l, ny = dx / l, jit = (A.hash(seed, b, i) - .5) * wid * .06;
        const gap = u > .55 + dry * .4 && A.hash(seed * 3, b, Math.floor(i / 3)) < (u - .55) * 1.2;   // the brush running dry
        const X = p[0] + nx * (off * ww + jit), Y = p[1] + ny * (off * ww + jit);
        if (i === 0 || gap) g.moveTo(X, Y); else g.lineTo(X, Y); }
      // bristles overlap (1.9x their share of the width); the middle ones carry more ink than the edges
      g.lineWidth = wid / B * 1.9; g.globalAlpha = .55 + .4 * (1 - Math.abs(off) * 1.6); g.stroke(); }
    g.globalAlpha = 1;
  }
  // draw a word: letters drawn stroke by stroke over [t0, t1]
  // glyphs: characters (a ' ' has no strokes but keeps its slot); set: L or K; cx: centre of the word; cy: top of the
  // letters; size in px (a hangul box is size x size; a latin box .72 size wide, .98 size tall); gapK: advance per letter
  // as a fraction of the box width. The brush is .17 size wide for latin letters, .15 size for hangul.
  // Stroke i starts at its share of [t0, t1] and takes that share plus 0.08 s, so strokes overlap slightly.
  function word(g, glyphs, set, t, t0, t1, cx, cy, size, gapK, seed) {
    const strokes = []; glyphs.forEach((ch, li) => (set[ch] || []).forEach(s => strokes.push({ s, li })));
    const n = strokes.length, wbox = size * (set === L ? .72 : 1), adv = wbox * gapK, total = adv * (glyphs.length - 1) + wbox, x0 = cx - total / 2;
    strokes.forEach((o, i) => { const a = lerp(t0, t1, i / n), b = lerp(t0, t1, (i + 1) / n) + .08, k = clamp((t - a) / (b - a)); if (k <= 0) return;
      brush(g, o.s, x0 + o.li * adv, cy, wbox, size * (set === L ? 1.36 * .72 : 1), size * (set === L ? .17 : .15), A.ease.out(k), seed + i); });
  }
  // the whole title card for film time t on a canvas of W x H: cream ink with a soft violet drop shadow,
  // the top of STILLRAIN at 27% of the height, 머문 비 128 px (at 1080) lower
  function draw(g, t, W, H) {
    if (t < 90.4) return; const s = H / 1080, fade = 1 - sm(92.4, 93, t);
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
    g.shadowColor = 'rgba(60,30,70,.35)'; g.shadowBlur = 18 * s; g.shadowOffsetY = 3 * s;
    g.strokeStyle = `rgba(255,248,236,${fade})`;
    word(g, [...'STILLRAIN'], L, t, 90.5, 91.8, W / 2, H * .27, 100 * s, 1.02, 11);
    g.strokeStyle = `rgba(255,236,214,${fade})`;
    word(g, ['머', '문', ' ', '비'], K, t, 91.7, 92.35, W / 2, H * .27 + 128 * s, 80 * s, 1.15, 71);
    g.restore();
  }
  // the overlay on the live page: a fixed canvas above the film (made on first use, never catches the mouse), sized to
  // the window at up to 2x device pixels
  let cv = null, g = null;
  F.titles = draw;
  F.overlay = t => { if (!cv) { cv = document.createElement('canvas'); cv.id = 'ink'; cv.setAttribute('aria-hidden', 'true'); Object.assign(cv.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 2 }); document.body.appendChild(cv); g = cv.getContext('2d'); }
    const W = Math.round(innerWidth * Math.min(2, devicePixelRatio || 1)), H = Math.round(innerHeight * Math.min(2, devicePixelRatio || 1)); if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    g.clearRect(0, 0, W, H); if (t >= 89.9) { // keep the 16:9 picture's proportions inside the window
      const ph = Math.min(H, W * 9 / 16), oy = (H - ph) / 2; g.save(); g.translate((W - ph * 16 / 9) / 2, oy); draw(g, t, ph * 16 / 9, ph); g.restore(); } };
})();
