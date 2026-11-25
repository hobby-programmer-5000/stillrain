// sculpt.js - SCULPT: bodies are not built from primitives but sculpted. A skeleton of capsules and ellipsoids is merged with a
//      smooth union, so no joint shows, then meshed with surface nets. Each part keeps its own colour, blended where parts
//      flow into each other. With `opt.bones` every vertex also gets skin weights from the bones its parts name, so one
//      sculpted body bends like a drawn one. The idea of merging a skeleton's capsules into one shape comes from bide's cast.js
//      (ChetasLua/bide, MIT): "skeleton -> a few merged masses -> one contour". Here it is done in 3D.
//
// How it works
//   A shape is a signed distance function (SDF): f(x, y, z) is the distance to the surface in metres, negative inside.
//   Shapes combine with smooth min (smin), which rounds the crease where two parts meet over a width k (metres).
//   mesh() samples the field on a grid of cell size h, puts one vertex in every cell the surface crosses (surface nets),
//   joins them into quads, and takes normals, colours and bone weights from the field and the parts. It runs once, while
//   the film loads: cast.js sculpts Pell, Tock and Dun with it, life.js the frogs.
//
// Public API (FILM.sculpt)
//   primitives  sph(c, r), ell(c, [rx, ry, rz]), cap(a, b, ra, rb), chain(points, radii, k), box(c, half, round, euler),
//               torus(c, R, r, axis)
//   operators   smin(a, b, k), union([f...], k), cut(f, g, k) (f minus g), inter(f, g, k), bump(f, amp, freq, seed)
//   meshing     mesh(parts, bmin, bmax, h, opt) -> THREE.BufferGeometry; fieldOf(parts) -> the combined SDF
//   other       mx(p) mirrors a point across x = 0; stats lists [ms, vertices] for every mesh built (tuning load time)
// A part is { f, k, col, tag, bone, bw }; see the comment above fieldOf. Units are metres.
// To see it: the bodies built with it, e.g.  node tools/shot.mjs --test pell --k 0,1 --cols 2 --out build/pell.jpg
//   (and --test frog); after a shot, --print "FILM.sculpt.stats" shows what each mesh cost.
window.FILM = window.FILM || {};
FILM.sculpt = (() => {
  const vn3 = FILM.anim.vn3, col = c => new THREE.Color(c);
  const hyp = (a, b, c = 0) => Math.sqrt(a * a + b * b + c * c);   // Math.hypot is several times slower in V8
  // ---- primitives: each returns (x,y,z) -> signed distance
  // each primitive also carries a bounding sphere f.b = [x, y, z, r], so a field can skip parts that are far away
  const B = (f, b) => { f.b = b; return f; };
  const sph = (c, r) => B((x, y, z) => hyp(x - c[0], y - c[1], z - c[2]) - r, [c[0], c[1], c[2], r]);
  // ellipsoid with radii r = [rx, ry, rz]: a close approximation of the distance (exact on the axes), good enough to blend
  const ell = (c, r) => B((x, y, z) => { const X = (x - c[0]) / r[0], Y = (y - c[1]) / r[1], Z = (z - c[2]) / r[2], k0 = hyp(X, Y, Z), k1 = hyp(X / r[0], Y / r[1], Z / r[2]); return k0 * (k0 - 1) / (k1 || 1e-6); }, [c[0], c[1], c[2], Math.max(r[0], r[1], r[2]) * 1.05]);
  // capsule whose radius runs from ra at a to rb at b (the radius is taken at the nearest point of the axis, a cheap
  // stand-in for an exact cone; fine while ra and rb are close)
  const cap = (a, b, ra, rb = ra) => { const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2], l2 = bx * bx + by * by + bz * bz || 1e-9;
    return B((x, y, z) => { const px = x - a[0], py = y - a[1], pz = z - a[2]; const t = Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / l2));
      return hyp(px - bx * t, py - by * t, pz - bz * t) - (ra + (rb - ra) * t); }, [a[0] + bx / 2, a[1] + by / 2, a[2] + bz / 2, Math.sqrt(l2) / 2 + Math.max(ra, rb)]); };
  // a smooth chain of capsules through points with radii
  const chain = (pts, rad, k = 0.05) => { const cs = []; for (let i = 0; i < pts.length - 1; i++) cs.push(cap(pts[i], pts[i + 1], rad[i], rad[i + 1])); return union(cs, k); };
  // rounded box: centre c, half sizes h = [hx, hy, hz], corner radius r, rotation as Euler angles [x, y, z].
  // It carries no bounding sphere, so union() and fieldOf() always evaluate it.
  const box = (c, h, r = 0, rot = [0, 0, 0]) => { const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot)).setPosition(...c).invert(), e = m.elements;
    return (x, y, z) => { const lx = e[0] * x + e[4] * y + e[8] * z + e[12], ly = e[1] * x + e[5] * y + e[9] * z + e[13], lz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const qx = Math.abs(lx) - h[0] + r, qy = Math.abs(ly) - h[1] + r, qz = Math.abs(lz) - h[2] + r; return hyp(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r; }; };
  // torus: ring radius R, tube radius r, round the given axis ('y': the ring lies flat in the xz plane)
  const torus = (c, R, r, axis = 'y') => B((x, y, z) => { x -= c[0]; y -= c[1]; z -= c[2]; const [a, b, h] = axis === 'y' ? [x, z, y] : axis === 'z' ? [x, y, z] : [y, z, x]; return hyp(hyp(a, b) - R, h) - r; }, [c[0], c[1], c[2], R + r]);
  // ---- operators
  // smooth min (polynomial): equal to min(a, b) once a and b differ by k or more; closer than that it dips below both,
  // which fills the crease between two shapes with a fillet about k wide
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
  const cut = (f, g, k = 0) => (x, y, z) => -smin(-f(x, y, z), g(x, y, z), k);          // f minus g
  const inter = (f, g, k = 0) => (x, y, z) => -smin(-f(x, y, z), -g(x, y, z), k);      // only where both are
  // lumpy surface: value noise of frequency freq (cycles per metre) moves the surface in and out by up to amp metres
  const bump = (f, amp, freq, seed = 0) => (x, y, z) => f(x, y, z) - amp * (vn3(x * freq + seed, y * freq, z * freq) - 0.5) * 2;

  // ---- a model is a list of named parts: { f, k (how softly it merges into what came before), col, tag }
  //      f: the part's SDF; k: blend width in metres (default 0.08); col: hex colour; tag: a number written to aId
  //      (default: the part's index); bone: index of the bone that moves it (with opt.bones); bw: that bone's pull (default 1).
  // mesh(parts, bmin, bmax, h, opt) -> BufferGeometry with position, normal, color, uv (all zero), and `aId` (the tag of the
  //      dominant part, so a shader can tell skin from cloth), plus skinIndex / skinWeight with opt.bones.
  //      bmin, bmax: corners of the box to mesh (m); h: grid cell size (m), the detail level and the cost (cubic in 1/h).
  //      opt: post(d, x, y, z) -> d (a last edit of the field), blend (colour blend width, .03 m), bones (bone count),
  //      skinBlend (bone weight falloff, .05 m).
  const fieldOf = parts => (x, y, z) => { let d = parts[0].f(x, y, z); for (let i = 1; i < parts.length; i++) { const p = parts[i], k = p.k ?? 0.08, b = p.f.b; if (b && far(b, x, y, z) >= d + k) continue; d = smin(d, p.f(x, y, z), k); } return d; };
  const stats = [];   // [ms, vertices] per mesh, for tuning load time
  function mesh(parts, bmin, bmax, h, opt = {}) { const T0 = performance.now();
    const nx = Math.ceil((bmax[0] - bmin[0]) / h) + 1, ny = Math.ceil((bmax[1] - bmin[1]) / h) + 1, nz = Math.ceil((bmax[2] - bmin[2]) / h) + 1;
    const field = fieldOf(parts);
    const sdf = opt.post ? (x, y, z) => opt.post(field(x, y, z), x, y, z) : field;
    const F = new Float32Array(nx * ny * nz), I = (i, j, k) => i + nx * (j + ny * k);
    // narrow band: sample a grid 3x coarser first (CK); a fine point whose nearest coarse sample is far from the surface keeps
    // that sample's value (only its sign matters there), so the full field is evaluated only in a shell round the surface.
    // The band (1.7 coarse cells) is wider than the gap between a fine point and its nearest coarse sample (0.87 at most),
    // so a copied value always has the right sign.
    const CK = 3, cx = Math.ceil((nx - 1) / CK) + 1, cy = Math.ceil((ny - 1) / CK) + 1, cz = Math.ceil((nz - 1) / CK) + 1, FC = new Float32Array(cx * cy * cz), band = CK * h * 1.7;
    for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) FC[i + cx * (j + cy * k)] = sdf(bmin[0] + i * CK * h, bmin[1] + j * CK * h, bmin[2] + k * CK * h);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const dc = FC[Math.min(cx - 1, Math.round(i / CK)) + cx * (Math.min(cy - 1, Math.round(j / CK)) + cy * Math.min(cz - 1, Math.round(k / CK)))];
      F[I(i, j, k)] = Math.abs(dc) > band ? dc : sdf(bmin[0] + i * h, bmin[1] + j * h, bmin[2] + k * h); }
    // one vertex per cell that the surface crosses, at the mean of its edge crossings, then pulled onto the surface
    // (one Newton step along the field's gradient, at most 0.6 cells). VI maps a cell to its vertex index (-1: none).
    // Corner c of a cell is (c & 1, c >> 1 & 1, c >> 2 & 1); E lists the 12 cell edges as pairs of corners.
    const VI = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1), C = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
    const pos = [], E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]], cd = new Float32Array(8);
    for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      let mask = 0; for (let c = 0; c < 8; c++) { cd[c] = F[I(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))]; if (cd[c] < 0) mask |= 1 << c; }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const [a, b] of E) { const da = cd[a], db = cd[b]; if ((da < 0) === (db < 0)) continue; const t = da / (da - db);
        sx += (a & 1) + (((b & 1) - (a & 1)) * t); sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t); sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t); n++; }
      let x = bmin[0] + (i + sx / n) * h, y = bmin[1] + (j + sy / n) * h, z = bmin[2] + (k + sz / n) * h;
      { const d = sdf(x, y, z), e = h * 0.25, gx = (sdf(x + e, y, z) - d) / e, gy = (sdf(x, y + e, z) - d) / e, gz = (sdf(x, y, z + e) - d) / e, g2 = gx * gx + gy * gy + gz * gz || 1;
        const k = Math.max(-0.6 * h, Math.min(0.6 * h, d / Math.sqrt(g2))) / Math.sqrt(g2); x -= k * gx; y -= k * gy; z -= k * gz; }
      VI[C(i, j, k)] = pos.length / 3; pos.push(x, y, z);
    }
    // a quad for every grid edge the surface crosses: the four cells that share that edge each hold one vertex.
    // Three loops, one per edge direction (x, y, z); the inside/outside order of the edge's ends picks the winding.
    const idx = [];
    const quad = (a, b, c, d, flip) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (flip) idx.push(a, b, c, a, c, d); else idx.push(a, c, b, a, d, c); };
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = F[I(i, j, k)] < 0, b = F[I(i + 1, j, k)] < 0; if (a === b) continue;
      quad(VI[C(i, j - 1, k - 1)], VI[C(i, j, k - 1)], VI[C(i, j, k)], VI[C(i, j - 1, k)], a); }
    for (let k = 1; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) { const a = F[I(i, j, k)] < 0, b = F[I(i, j + 1, k)] < 0; if (a === b) continue;
      quad(VI[C(i - 1, j, k - 1)], VI[C(i - 1, j, k)], VI[C(i, j, k)], VI[C(i, j, k - 1)], a); }
    for (let k = 0; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) { const a = F[I(i, j, k)] < 0, b = F[I(i, j, k + 1)] < 0; if (a === b) continue;
      quad(VI[C(i - 1, j - 1, k)], VI[C(i, j - 1, k)], VI[C(i, j, k)], VI[C(i - 1, j, k)], a); }
    // normals from the field, colours from the parts (soft-min weights so colours blend where the shapes blend).
    // A part's colour weight is exp(-distance / blend): full on its own surface, fading over a few `blend` widths.
    // Parts far away (by their bounding sphere) use that bound instead of their full SDF.
    const skin = !!opt.bones, sb = opt.skinBlend || 0.05, bw = new Float32Array(opt.bones || 1);
    const bl = opt.blend || 0.03, nv = pos.length / 3, sIdx = new Uint16Array(skin ? nv * 4 : 0), sW = new Float32Array(skin ? nv * 4 : 0), nrm = new Float32Array(nv * 3), colr = new Float32Array(nv * 3), ids = new Float32Array(nv), c = new THREE.Color(), cs = parts.map(p => col(p.col || '#ffffff'));
    for (let v = 0; v < nv; v++) { const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2], e = h * 0.35;
      // tetrahedral gradient: four samples instead of six
      const a = sdf(x + e, y - e, z - e), b = sdf(x - e, y - e, z + e), c4 = sdf(x - e, y + e, z - e), d4 = sdf(x + e, y + e, z + e);
      const gx = a - b - c4 + d4, gy = -a - b + c4 + d4, gz = -a + b - c4 + d4, gl = hyp(gx, gy, gz) || 1;
      nrm[v * 3] = gx / gl; nrm[v * 3 + 1] = gy / gl; nrm[v * 3 + 2] = gz / gl;
      let wsum = 0, best = 1e9, bi = 0; c.setRGB(0, 0, 0);
      for (let p = 0; p < parts.length; p++) { const b = parts[p].f.b, fd = b ? far(b, x, y, z) : 0, d = fd > bl * 14 ? fd : parts[p].f(x, y, z); if (d < best) { best = d; bi = p; } const w = Math.exp(-Math.max(0, d) / bl); wsum += w; c.r += cs[p].r * w; c.g += cs[p].g * w; c.b += cs[p].b * w; }
      colr[v * 3] = c.r / wsum; colr[v * 3 + 1] = c.g / wsum; colr[v * 3 + 2] = c.b / wsum; ids[v] = parts[bi].tag ?? bi;
      if (skin) { // bone weights: every part names its bone; a part's pull falls off with distance (wider than the colour blend)
        bw.fill(0); for (let p = 0; p < parts.length; p++) { const bo = parts[p].bone; if (bo == null) continue; const b = parts[p].f.b, fd = b ? far(b, x, y, z) : 0, d = fd > sb * 10 ? fd : parts[p].f(x, y, z); bw[bo] += Math.exp(-Math.max(0, d) / sb) * (parts[p].bw ?? 1); }
        // keep the four strongest bones (insertion into a sorted list of four), then make their weights sum to 1
        const top = [0, 0, 0, 0], tw = [0, 0, 0, 0]; for (let b = 0; b < bw.length; b++) { const w = bw[b]; if (w <= tw[3]) continue; let k = 3; while (k > 0 && w > tw[k - 1]) { tw[k] = tw[k - 1]; top[k] = top[k - 1]; k--; } tw[k] = w; top[k] = b; }
        const ts = tw[0] + tw[1] + tw[2] + tw[3] || 1; for (let k = 0; k < 4; k++) { sIdx[v * 4 + k] = top[k]; sW[v * 4 + k] = tw[k] / ts; } } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colr, 3)); g.setAttribute('aId', new THREE.BufferAttribute(ids, 1));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nv * 2), 2)); g.setIndex(idx);
    if (skin) { g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sIdx, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sW, 4)); } g.computeBoundingSphere(); stats.push([Math.round(performance.now() - T0), nv]); return g;
  }
  // mirror a point across x = 0 (for left/right pairs)
  const mx = p => [-p[0], p[1], p[2]];
  return { sph, ell, cap, chain, box, torus, smin, union, cut, inter, bump, mesh, fieldOf, stats, mx };
})();
