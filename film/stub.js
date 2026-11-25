// stub.js - a plain stand-in for the valley, used only while film/world.js is missing (or left out with --skip).
// Sky, the analytic ground with flat toon shading, boxes for houses and poles for masts. Same idea as bide's stub.js
// (ChetasLua/bide, MIT): any module can be built and looked at before the world exists.
// main.js adds its one build step only when FILM.world is absent. Reads FILM.valley (ground, houses, masts, R0) and
// FILM.engine (sky and toon materials, meshes with ink lines).
// See it: python tools/build.py --out build/stub.html --skip film/world.js
//         node tools/shot.mjs --page build/stub.html --t 8 --w 960 --out build/stub.jpg
window.FILM = window.FILM || {};
(function () {
  const F = window.FILM, E = F.engine, V = F.valley;
  // one build step; its Korean label ('a temporary valley') shows on the loader
  F.stub = { steps(scene) { return [['임시 골짜기', () => {
    const sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), E.skyMat()); sky.renderOrder = -10; sky.frustumCulled = false; scene.add(sky);
    // the ground: an 1800 m square grid of 5 m cells, each vertex lifted to FILM.valley.ground()
    const N = 360, R = 900, g = new THREE.PlaneGeometry(2 * R, 2 * R, N, N); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, V.ground(p.getX(i), p.getZ(i))); g.computeVertexNormals();
    const ground = new THREE.Mesh(g, E.toon({ color: '#d9a85b', rim: 0, paint: .25 })); ground.receiveShadow = true; scene.add(ground);
    const pond = new THREE.Mesh(new THREE.CircleGeometry(V.R0 + 2, 64), E.toon({ color: '#5aa7c9', rim: 0, paint: .05 })); pond.rotation.x = -Math.PI / 2; pond.position.y = .02; scene.add(pond);
    // houses: the body (stilts to 2.2, walls to 4.9) as a box and the hush-roof as a half ellipsoid, sizes from valley.js HOUSE
    const hm = E.toon({ color: '#c9b79a' }), rm = E.toon({ color: '#6f8a4a' });
    for (const h of V.houses) { const s = h.size, b = E.mesh(new THREE.BoxGeometry(5.2 * s, 2.7 * s, 4.4 * s), hm, { line: true }); b.position.set(h.pos[0], h.pos[1] + 3.6 * s, h.pos[2]); b.rotation.y = h.rot; scene.add(b);
      const r = E.mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), rm, { line: true }); r.scale.set(3.4 * s, 2.5 * s, 3.0 * s); r.position.set(h.pos[0], h.pos[1] + 4.7 * s, h.pos[2]); r.rotation.y = h.rot; scene.add(r); }
    // masts: plain poles of their height
    const pm = E.toon({ color: '#b08a5a' });
    for (const m of V.masts) { const c = E.mesh(new THREE.CylinderGeometry(.12, .16, m.h, 8), pm, { line: true }); c.position.set(m.pos[0], m.pos[1] + m.h / 2, m.pos[2]); scene.add(c); }
  }]]; } };
})();
