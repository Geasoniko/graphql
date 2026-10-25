import * as THREE from './vendor/three.module.min.js';
import {
  GEO, TEX, stdMat, basicMat, sharedGeo, sharedMat, addMesh, heartGeometry, textTexture, wallpaperTexture,
  disposeTree, loadPhotoTexture, clamp, rng,
} from './util.js';
import { makeItemModel, ITEMS } from './items.js';
import { makeCharacter, animateCharacter, randomLook } from './characters.js';

// ------------------------------------------------------------
//  World layout (top view, metres)
//
//          z<0 :  gallery rooms chained northwards (x -7..7)
//   z 0..24    :  LOBBY x -14..14  (shop west, ticket desk + popcorn east)
//   z 2..22    :  CINEMA x 14..34  (screen on the east wall)
// ------------------------------------------------------------
export const LOBBY = { x0: -14, x1: 14, z0: 0, z1: 24, h: 6 };
export const CINEMA = { x0: 14, x1: 34, z0: 2, z1: 22, h: 7, rows: 6, cols: 10 };
const GALLERY_W = 7;      // half width
const GALLERY_H = 5;
const DOOR_W = 3.4, DOOR_H = 3.3, T = 0.3;
const PER_ROOM = 8;

const STYLES = [
  { base: '#f4e7dc', motif: 'rgba(214,170,170,0.2)', wain: 0x8c5a4a, name: 'Розовый зал' },
  { base: '#efe3f5', motif: 'rgba(170,140,214,0.24)', wain: 0x6e5a8c, name: 'Лавандовый зал' },
  { base: '#e3f2ea', motif: 'rgba(120,190,150,0.24)', wain: 0x4f7a5f, name: 'Мятный зал' },
  { base: '#fbe6dc', motif: 'rgba(230,150,120,0.24)', wain: 0x9a5f48, name: 'Персиковый зал' },
];
const wallTextures = STYLES.map((s) => { const t = wallpaperTexture(s.base, s.motif); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; });

export function cinemaSeatPos(row, seat) {
  return { x: 30 - (row - 1) * 1.7 - 0.06, z: 12 + (seat - 5.5) * 1.05, yaw: Math.PI / 2, h: 0.47 };
}

export function buildWorld({ scene, photos, maxAniso = 4, title = 'Наша история 💕' }) {
  const root = new THREE.Group();
  scene.add(root);
  const W = {
    root, obstacles: [], blockers: [], frames: [], seats: [], floaters: [], zones: {}, statics: [],
    spawn: { x: 0, z: 21.5, yaw: Math.PI }, zMin: 0, photos, rooms: [],
  };

  // ---------- helpers ----------
  const box = (mat, x, y, z, sx, sy, sz, parent = root) => addMesh(parent, GEO.box, mat, x, y, z, sx, sy, sz);
  const solid = (x0, x1, z0, z1) => W.obstacles.push({ x0, x1, z0, z1 });
  const sign = (text, x, y, z, ry, w = 3.2, h = 0.8, opts = {}) => {
    const tex = textTexture(text, { font: opts.font || 'bold 96px Georgia, serif', color: opts.color || '#7a2c4b', glow: opts.glow });
    tex.userData.owned = true;
    const m = addMesh(root, GEO.plane, new THREE.MeshBasicMaterial({ map: tex, transparent: true }), x, y, z, w, h, 1);
    m.rotation.y = ry;
    return m;
  };
  const wallMaterial = (style, len, h) => {
    if (style === 'cinema') return stdMat(0x3a1a2c, 0.95);
    if (style === 'ext') return stdMat(0xd9cfc6, 0.9);
    const tex = wallTextures[style].clone();
    tex.needsUpdate = true;
    tex.repeat.set(len / 2.5, h / 2.5);
    tex.userData.owned = true;
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
  };
  const trimMat = stdMat(0xe8c36a, 0.4, 0.5);

  // axis 'x': runs along x at z=c; sideA faces -z, sideB faces +z.   axis 'z': along z at x=c; A faces -x, B faces +x.
  function wall(axis, c, from, to, h, styleA, styleB, doors = []) {
    const pieces = [];
    let cur = from;
    for (const d of [...doors].sort((a, b) => a.at - b.at)) {
      pieces.push({ s0: cur, s1: d.at - DOOR_W / 2, y0: 0, y1: h });
      pieces.push({ s0: d.at - DOOR_W / 2, s1: d.at + DOOR_W / 2, y0: DOOR_H, y1: h, lintel: true });
      cur = d.at + DOOR_W / 2;
    }
    pieces.push({ s0: cur, s1: to, y0: 0, y1: h });
    for (const p of pieces) {
      const len = p.s1 - p.s0, ph = p.y1 - p.y0;
      if (len <= 0.01) continue;
      const mid = (p.s0 + p.s1) / 2, ym = (p.y0 + p.y1) / 2;
      const mA = wallMaterial(styleA, len, ph), mB = wallMaterial(styleB, len, ph);
      let mesh;
      if (axis === 'x') {
        mesh = new THREE.Mesh(GEO.box, [trimMat, trimMat, trimMat, trimMat, mB, mA]);
        mesh.position.set(mid, ym, c); mesh.scale.set(len, ph, T);
        if (!p.lintel) solid(p.s0, p.s1, c - T / 2, c + T / 2);
      } else {
        mesh = new THREE.Mesh(GEO.box, [mB, mA, trimMat, trimMat, trimMat, trimMat]);
        mesh.position.set(c, ym, mid); mesh.scale.set(T, ph, len);
        if (!p.lintel) solid(c - T / 2, c + T / 2, p.s0, p.s1);
      }
      root.add(mesh);
      W.blockers.push(mesh);
      // wainscot + rail on the decorated sides
      if (!p.lintel) {
        for (const [style, sgn] of [[styleA, -1], [styleB, 1]]) {
          if (typeof style !== 'number') continue;
          const wm = stdMat(STYLES[style].wain, 0.7);
          const off = sgn * (T / 2 + 0.02);
          if (axis === 'x') { box(wm, mid, 0.5, c + off, len, 1, 0.04); box(trimMat, mid, 1.03, c + off * 1.3, len, 0.06, 0.04); }
          else { box(wm, c + off, 0.5, mid, 0.04, 1, len); box(trimMat, c + off * 1.3, 1.03, mid, 0.04, 0.06, len); }
        }
      }
    }
    // gold door frames
    for (const d of doors) {
      for (const s of [-1, 1]) {
        if (axis === 'x') box(trimMat, d.at + s * (DOOR_W / 2), DOOR_H / 2, c, 0.14, DOOR_H, T + 0.12);
        else box(trimMat, c, DOOR_H / 2, d.at + s * (DOOR_W / 2), T + 0.12, DOOR_H, 0.14);
      }
      if (axis === 'x') box(trimMat, d.at, DOOR_H, c, DOOR_W + 0.28, 0.16, T + 0.12);
      else box(trimMat, c, DOOR_H, d.at, T + 0.12, 0.16, DOOR_W + 0.28);
    }
  }

  function floor(x0, x1, z0, z1, tex, repeat, y = 0) {
    let mat;
    if (tex) {
      const t = tex.clone(); t.needsUpdate = true; t.userData.owned = true;
      t.repeat.set((x1 - x0) / repeat, (z1 - z0) / repeat);
      mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 });
    } else mat = stdMat(0x777777);
    const m = addMesh(root, GEO.plane, mat, (x0 + x1) / 2, y, (z0 + z1) / 2, x1 - x0, z1 - z0, 1);
    m.rotation.x = -Math.PI / 2;
    return m;
  }
  function ceiling(x0, x1, z0, z1, h, color = 0xfff6ee) {
    const m = addMesh(root, GEO.plane, stdMat(color, 1), (x0 + x1) / 2, h, (z0 + z1) / 2, x1 - x0, z1 - z0, 1);
    m.rotation.x = Math.PI / 2;
  }
  function plant(x, z) {
    addMesh(root, sharedGeo('pot', () => new THREE.CylinderGeometry(0.32, 0.24, 0.6, 16)), stdMat(0xd9d0c7, 0.5), x, 0.3, z);
    const leafGeo = sharedGeo('leaf', () => new THREE.SphereGeometry(0.35, 12, 10));
    const lm = stdMat(0x3f8f4f, 0.8);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      addMesh(root, leafGeo, lm, x + Math.cos(a) * 0.18, 0.95 + (k % 2) * 0.25, z + Math.sin(a) * 0.18).scale.setScalar(0.8 + (k % 3) * 0.15);
    }
    addMesh(root, leafGeo, lm, x, 1.35, z);
    solid(x - 0.4, x + 0.4, z - 0.4, z + 0.4);
  }
  function bench(x, z, alongZ = true) {
    const g = new THREE.Group(); g.position.set(x, 0, z); if (!alongZ) g.rotation.y = Math.PI / 2; root.add(g);
    const wood = stdMat(0x7a4a2e, 0.6);
    box(wood, 0, 0.4, 0, 0.62, 0.08, 2.1, g);
    box(stdMat(0xf2a7c3, 0.9), 0, 0.47, 0, 0.58, 0.07, 2.0, g);
    for (const dz of [-0.9, 0.9]) box(wood, 0, 0.2, dz, 0.5, 0.4, 0.08, g);
    if (alongZ) solid(x - 0.34, x + 0.34, z - 1.08, z + 1.08); else solid(x - 1.08, x + 1.08, z - 0.34, z + 0.34);
    for (const side of [-1, 1]) for (const d of [-0.5, 0.5]) {
      if (alongZ) W.seats.push({ x: x + side * 0.14, z: z + d, yaw: side * Math.PI / 2, h: 0.5 });
      else W.seats.push({ x: x + d, z: z + side * 0.14, yaw: side > 0 ? 0 : Math.PI, h: 0.5 });
    }
  }
  function sofa(x, z, yaw, color = 0xc4416b) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = yaw; root.add(g);
    const m = stdMat(color, 0.85);
    box(m, 0, 0.25, 0, 2.6, 0.5, 0.9, g);
    box(m, 0, 0.75, -0.38, 2.6, 0.7, 0.2, g);
    box(m, -1.25, 0.55, 0, 0.2, 0.35, 0.9, g);
    box(m, 1.25, 0.55, 0, 0.2, 0.35, 0.9, g);
    for (const dx of [-0.75, 0, 0.75]) addMesh(g, GEO.box, stdMat(0xe86a95, 0.9), dx, 0.53, 0.02, 0.7, 0.08, 0.75);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const hw = Math.abs(c) * 1.35 + Math.abs(s) * 0.5, hd = Math.abs(s) * 1.35 + Math.abs(c) * 0.5;
    solid(x - hw, x + hw, z - hd, z + hd);
    for (const dx of [-0.75, 0, 0.75]) {
      // local (dx, 0.05) rotated by yaw; sofa faces local +z
      W.seats.push({ x: x + dx * c + 0.05 * s, z: z - dx * s + 0.05 * c, yaw, h: 0.52 });
    }
  }
  function staff(x, z, yaw, text) {
    const ch = makeCharacter(Math.random() < 0.5 ? 'girl' : 'boy', { label: text, palette: { longHair: false, accent: 0xffffff }, outfit: { top: 0x2b2b33, bottom: 0x2b2b33 } });
    ch.root.position.set(x, 0, z);
    ch.yaw = yaw;
    root.add(ch.root);
    W.statics.push(ch);
    return ch;
  }

  // ================= LOBBY =================
  const L = LOBBY;
  floor(L.x0, L.x1, L.z0, L.z1, TEX.marble, 3);
  ceiling(L.x0, L.x1, L.z0, L.z1, L.h);
  wall('x', L.z1, L.x0, L.x1, L.h, 0, 'ext');
  wall('z', L.x0, L.z0, L.z1, L.h, 'ext', 0);
  wall('x', L.z0, L.x0, L.x1, L.h, 0, 0, [{ at: 0 }]);
  wall('z', L.x1, L.z0, L.z1, CINEMA.h, 0, 'cinema', [{ at: 12 }]);
  // entrance + signs
  box(stdMat(0x5b3426, 0.6), 0, 1.5, L.z1 - 0.17, 2.6, 3, 0.05);
  box(trimMat, 0, 3.05, L.z1 - 0.2, 2.9, 0.14, 0.06);
  sign('Добро пожаловать 💕', 0, 3.9, L.z1 - 0.2, Math.PI, 5, 1.25, { font: 'italic bold 84px Georgia, serif' });
  sign('🖼️ Галерея', 0, 4.1, L.z0 + 0.2, 0, 3.6, 0.9);
  sign('🎬 Кинотеатр', L.x1 - 0.2, 4.3, 12, -Math.PI / 2, 3.8, 0.95);
  // chandelier
  const glowMat = basicMat(0xfff3dc);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    addMesh(root, GEO.sphere, glowMat, Math.cos(a) * 1.2, L.h - 0.9, 12 + Math.sin(a) * 1.2, 0.14, 0.14, 0.14);
  }
  addMesh(root, GEO.cyl, trimMat, 0, L.h - 0.45, 12, 0.03, 0.9, 0.03);
  addMesh(root, sharedGeo('ring', () => new THREE.TorusGeometry(1.2, 0.04, 6, 32)), trimMat, 0, L.h - 0.9, 12).rotation.x = Math.PI / 2;
  // centre: heart sculpture + sofas
  addMesh(root, GEO.cyl, stdMat(0xf3ece6, 0.4), 0, 0.45, 12, 0.8, 0.9, 0.8);
  const lobbyHeart = addMesh(root, heartGeometry(1.1, 0.25), new THREE.MeshStandardMaterial({ color: 0xff3f7f, emissive: 0xff2a6a, emissiveIntensity: 0.35, roughness: 0.3, metalness: 0.2 }), 0, 1.75, 12);
  W.floaters.push({ obj: lobbyHeart, base: 1.75, phase: 0, spin: true, amp: 0.08 });
  solid(-0.85, 0.85, 11.15, 12.85);
  sofa(0, 15.4, Math.PI);
  sofa(0, 8.6, 0);
  sofa(-4.4, 12, Math.PI / 2, 0x8c5ad1);
  sofa(4.4, 12, -Math.PI / 2, 0x8c5ad1);
  plant(-13.2, 23.2); plant(13.2, 23.2); plant(-13.2, 0.8); plant(13.2, 0.8); plant(-2.6, 0.8); plant(2.6, 0.8);

  // ---------- SHOP (west) ----------
  const rug = addMesh(root, GEO.plane, stdMat(0xf6c6d6, 0.95), -10, 0.01, 9, 7.2, 13, 1);
  rug.rotation.x = -Math.PI / 2;
  sign('🛍️ Магазин', L.x0 + 0.2, 4.1, 9, Math.PI / 2, 4, 1);
  const shelfMat = stdMat(0xf7efe8, 0.5);
  box(shelfMat, -13.55, 1.25, 9, 0.5, 2.5, 12);
  for (const y of [0.55, 1.15, 1.75]) box(stdMat(0xe2cfc2, 0.5), -13.3, y, 9, 0.62, 0.05, 12);
  solid(-13.9, -12.95, 3, 15);
  const shelfItems = [
    ['roses_8', 1.78, 3.8], ['roses_16', 1.78, 5.2], ['roses_25', 1.78, 6.7], ['roses_51', 1.78, 8.4],
    ['phone_rose', 1.18, 10.4], ['phone_pro', 1.18, 11.2], ['phone_gold', 1.18, 12], ['phone_mint', 1.18, 12.8],
    ['bag_pink', 0.85, 4.3], ['bag_white', 0.85, 5.6], ['bag_black', 0.85, 6.9], ['bag_gold', 0.75, 8.1],
  ];
  for (const [type, y, z] of shelfItems) {
    const m = makeItemModel(type);
    m.position.set(-13.15, y, z);
    m.rotation.y = Math.PI / 2;
    if (type.startsWith('phone')) { m.rotation.x = -0.25; m.scale.setScalar(1.6); }
    root.add(m);
  }
  // clothes racks with hanging outfits
  const rack = (z0, types) => {
    for (const dz of [0, 3.2]) box(trimMat, -10.6, 0.9, z0 + dz, 0.05, 1.8, 0.05);
    box(trimMat, -10.6, 1.8, z0 + 1.6, 0.05, 0.05, 3.3);
    types.forEach((type, i) => {
      const z = z0 + 0.4 + i * (2.4 / Math.max(1, types.length - 1));
      const col = ITEMS[type].outfit.top;
      const g = new THREE.Group(); g.position.set(-10.6, 1.72, z); g.rotation.y = Math.PI / 2; root.add(g);
      addMesh(g, GEO.cyl, trimMat, 0, 0, 0, 0.01, 0.12, 0.01);
      if (ITEMS[type].for === 'girl') {
        addMesh(g, GEO.box, stdMat(col, 0.7), 0, -0.22, 0, 0.26, 0.3, 0.1);
        addMesh(g, sharedGeo('dressSk', () => new THREE.CylinderGeometry(0.13, 0.3, 0.5, 14, 1, true)), sharedMat(`dsk-${col}`, () => new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, side: THREE.DoubleSide })), 0, -0.6, 0);
      } else {
        addMesh(g, GEO.box, stdMat(col, 0.7), 0, -0.35, 0, 0.42, 0.55, 0.1);
        addMesh(g, GEO.box, stdMat(col, 0.7), 0.27, -0.28, 0, 0.12, 0.4, 0.09);
        addMesh(g, GEO.box, stdMat(col, 0.7), -0.27, -0.28, 0, 0.12, 0.4, 0.09);
      }
    });
    solid(-10.85, -10.35, z0 - 0.1, z0 + 3.3);
  };
  rack(3.0, ['dress_red', 'dress_white', 'dress_blue', 'dress_black', 'dress_yellow', 'dress_lilac']);
  rack(11.6, ['shirt_white', 'suit_black', 'hoodie_gray', 'tee_red', 'tee_green']);
  // mannequins
  for (const [z, type, kind] of [[7.8, 'dress_red', 'girl'], [10.2, 'suit_black', 'boy']]) {
    const mq = makeCharacter(kind, { label: false, palette: { skin: 0xf2f2f2, hair: 0xf2f2f2, longHair: false, shoe: 0xf2f2f2 }, outfit: ITEMS[type].outfit });
    mq.root.position.set(-11.8, 0, z); mq.root.rotation.y = Math.PI / 2;
    root.add(mq.root);
    addMesh(root, GEO.cyl, stdMat(0xdddddd, 0.4), -11.8, 0.03, z, 0.35, 0.06, 0.35);
    solid(-12.1, -11.5, z - 0.3, z + 0.3);
  }
  // cash desk + seller
  box(stdMat(0xffffff, 0.4), -8.3, 0.55, 9.5, 0.7, 1.1, 3);
  box(stdMat(0xff8fb8, 0.5), -8.3, 1.12, 9.5, 0.78, 0.05, 3.1);
  solid(-8.7, -7.9, 7.95, 11.05);
  staff(-9.2, 9.5, Math.PI / 2, '🛍️ Продавец');
  // flower stand
  addMesh(root, GEO.cyl, stdMat(0xffffff, 0.5), -8.6, 0.4, 14, 0.7, 0.8, 0.7);
  for (const [type, dx, dz] of [['roses_101', -0.25, -0.2], ['roses_301', 0.2, 0.2]]) {
    const m = makeItemModel(type); m.position.set(-8.6 + dx, 0.9, 14 + dz); root.add(m);
  }
  solid(-9.35, -7.85, 13.25, 14.75);
  W.zones.shop = { x: -7.2, z: 9.5, r: 3.2 };

  // ---------- TICKET DESK + POPCORN (east) ----------
  const booth = (z0, z1, color, text, zoneName) => {
    const zc = (z0 + z1) / 2;
    box(stdMat(color, 0.5), 11.85, 0.55, zc, 0.6, 1.1, z1 - z0);
    box(stdMat(0xffffff, 0.4), 11.85, 1.12, zc, 0.7, 0.05, z1 - z0 + 0.1);
    box(stdMat(color, 0.5), 12.85, 2.9, zc, 1.9, 0.25, z1 - z0);
    sign(text, 11.82, 2.9, zc, -Math.PI / 2, 2.6, 0.65, { color: '#ffffff', glow: 'rgba(0,0,0,0.5)' }).position.x = 11.88 - 0.02;
    solid(11.5, 13.86, z0, z1);
    W.zones[zoneName] = { x: 10.5, z: zc, r: 3.0 };
    return zc;
  };
  const kz = booth(3, 8.2, 0xc4416b, '🎟️ Касса', 'kassa');
  staff(12.8, kz, -Math.PI / 2, '🎟️ Кассир');
  const pz = booth(15.8, 21, 0xe0a030, '🍿 Попкорн', 'popcorn');
  staff(12.8, pz, -Math.PI / 2, '🍿 Бармен');
  // popcorn machine
  const pm = new THREE.Group(); pm.position.set(11.85, 1.15, 17); root.add(pm);
  addMesh(pm, GEO.box, stdMat(0xd8263a, 0.4), 0, 0.03, 0, 0.55, 0.06, 0.55);
  addMesh(pm, GEO.box, new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, roughness: 0.1 }), 0, 0.33, 0, 0.5, 0.55, 0.5);
  addMesh(pm, GEO.box, stdMat(0xfff1b0, 0.9), 0, 0.15, 0, 0.46, 0.2, 0.46);
  addMesh(pm, GEO.box, stdMat(0xd8263a, 0.4), 0, 0.64, 0, 0.58, 0.08, 0.58);
  for (const [type, z] of [['popcorn', 18.3], ['popcorn_big', 19.0], ['cola', 19.7]]) {
    const m = makeItemModel(type); m.position.set(11.75, 1.23, z); root.add(m);
  }

  // ================= GALLERY ROOMS =================
  const n = photos.length;
  const roomCount = Math.max(2, Math.ceil(n / PER_ROOM));
  let zStart = 0;
  for (let r = 0; r < roomCount; r++) {
    const style = r % STYLES.length;
    const list = [];
    const a = Math.round((r * n) / roomCount), b = Math.round(((r + 1) * n) / roomCount);
    for (let i = a; i < b; i++) list.push(i);
    if (!n) for (let i = 0; i < 4; i++) list.push(-1);
    // groups: big, two small stacked, medium … alternating walls
    const groups = [];
    const pattern = ['L', 'SS', 'M'];
    let k = 0;
    for (let i = 0; i < list.length;) {
      let kind = pattern[k++ % pattern.length];
      if (kind === 'SS' && i + 1 >= list.length) kind = 'M';
      if (kind === 'SS') { groups.push({ kind, idx: [list[i], list[i + 1]] }); i += 2; }
      else { groups.push({ kind, idx: [list[i]] }); i += 1; }
    }
    const GW = { L: 3.6, M: 2.8, SS: 2.0 };
    const walls = [[], []];
    groups.forEach((g, i) => walls[i % 2].push(g));
    const wallLen = (gs) => gs.reduce((s, g) => s + GW[g.kind] + 0.8, 0);
    const len = Math.max(12, Math.max(wallLen(walls[0]), wallLen(walls[1])) + 5);
    const zEnd = zStart - len;
    const last = r === roomCount - 1;
    W.rooms.push({ zStart, zEnd, n: r + 1, name: STYLES[style].name });

    floor(-GALLERY_W, GALLERY_W, zEnd, zStart, TEX.parquet, 1.6);
    ceiling(-GALLERY_W, GALLERY_W, zEnd, zStart, GALLERY_H);
    const carpet = addMesh(root, GEO.plane, stdMat([0xa3304d, 0x5b3d8c, 0x2f7a5a, 0xb4573a][style], 0.95), 0, 0.012, (zStart + zEnd) / 2, 2.6, len - 2, 1);
    carpet.rotation.x = -Math.PI / 2;
    wall('z', -GALLERY_W, zEnd, zStart, GALLERY_H, 'ext', style);
    wall('z', GALLERY_W, zEnd, zStart, GALLERY_H, style, 'ext');
    wall('x', zEnd, -GALLERY_W, GALLERY_W, GALLERY_H, last ? 'ext' : (r + 1) % STYLES.length, style, last ? [] : [{ at: 0 }]);
    // room sign on the far wall
    if (!last) {
      sign(`Зал ${r + 2} →`, 0, 4.1, zEnd + 0.2, 0, 2.6, 0.65);
      sign(`Зал ${r + 1}`, 0, 4.15, zStart - 0.2, Math.PI, 2.2, 0.55);
    } else {
      sign(title, 0, 2.1, zEnd + 0.2, 0, 6.4, 1.6);
      const bigHeart = addMesh(root, heartGeometry(1.5, 0.25), new THREE.MeshStandardMaterial({ color: 0xff3f7f, emissive: 0xff2a6a, emissiveIntensity: 0.45, roughness: 0.3, metalness: 0.2 }), 0, 3.75, zEnd + 0.4);
      W.floaters.push({ obj: bigHeart, base: 3.75, phase: 0, pulse: true, amp: 0.1 });
    }
    // ceiling light panels
    for (let z = zStart - 3; z > zEnd + 2; z -= 5) box(glowMat, 0, GALLERY_H - 0.03, z, 3, 0.04, 1.2);
    // frames
    walls.forEach((gs, side) => {
      const x = side === 0 ? -GALLERY_W + T / 2 : GALLERY_W - T / 2;
      const ry = side === 0 ? Math.PI / 2 : -Math.PI / 2;
      let off = 0;
      const total = wallLen(gs);
      const startZ = zStart - (len - total) / 2 - 0.4;
      for (const g of gs) {
        const zc = startZ - off - GW[g.kind] / 2;
        if (g.kind === 'L') W.frames.push(makeFrame(x, 2.45, zc, ry, 3.0, 2.3, g.idx[0]));
        else if (g.kind === 'M') W.frames.push(makeFrame(x, 2.35, zc, ry, 2.3, 1.75, g.idx[0]));
        else { W.frames.push(makeFrame(x, 3.15, zc, ry, 1.55, 1.1, g.idx[0])); W.frames.push(makeFrame(x, 1.75, zc, ry, 1.55, 1.1, g.idx[1])); }
        off += GW[g.kind] + 0.8;
      }
    });
    // benches + plants + floating hearts
    const benches = Math.max(1, Math.floor(len / 9));
    for (let i = 0; i < benches; i++) bench(0, zStart - (len * (i + 1)) / (benches + 1));
    plant(-GALLERY_W + 0.7, zEnd + 0.7); plant(GALLERY_W - 0.7, zEnd + 0.7);
    const fhGeo = sharedGeo('fheart', () => heartGeometry(0.35, 0.12));
    for (let z = zStart - 2.5, i = 0; z > zEnd + 2; z -= 3.4, i++) {
      const col = [0xff6fa3, 0xff9ec4, 0xd77bff][i % 3];
      const fh = addMesh(root, fhGeo, sharedMat(`fh-${col}`, () => new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.35, roughness: 0.4 })), (i % 2 ? 1 : -1) * (1.6 + (i % 3) * 0.7), 3.8, z);
      W.floaters.push({ obj: fh, base: 3.6 + (i % 3) * 0.3, phase: i * 1.7, spin: true, amp: 0.15 });
    }
    zStart = zEnd;
  }
  W.zMin = zStart;

  function makeFrame(x, y, z, ry, bw, bh, index) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = ry;
    root.add(g);
    const glow = addMesh(g, GEO.plane, sharedMat('frameglow', () => new THREE.MeshBasicMaterial({ map: TEX.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 })), 0, 0.1, 0.012);
    const back = addMesh(g, GEO.box, stdMat(0xd8b25a, 0.35, 0.6), 0, 0, 0.045);
    const pic = addMesh(g, GEO.plane, new THREE.MeshBasicMaterial({ map: index >= 0 ? TEX.loading : TEX.placeholder }), 0, 0, 0.096);
    pic.userData.photoIndex = index;
    const lamp = addMesh(g, GEO.box, basicMat(0xfff1d0), 0, 0, 0.3);
    const setSize = (w, h) => {
      pic.scale.set(w, h, 1);
      back.scale.set(w + 0.16, h + 0.16, 0.09);
      glow.scale.set(w * 1.9, h * 1.9, 1);
      lamp.position.y = h / 2 + 0.25; lamp.scale.set(Math.min(0.6, w * 0.3), 0.05, 0.08);
    };
    const fit = (aspect) => {
      let w = bw, h = bw / aspect;
      if (h > bh) { h = bh; w = h * aspect; }
      setSize(w, h);
    };
    fit(4 / 3);
    return { x, z, mesh: pic, index, fit, state: index >= 0 ? 'wait' : 'none' };
  }

  // ================= CINEMA =================
  const C = CINEMA;
  floor(C.x0, C.x1, C.z0, C.z1, TEX.carpet, 1.2, 0.002);
  ceiling(C.x0, C.x1, C.z0, C.z1, C.h, 0x1a0f18);
  wall('x', C.z0, C.x0, C.x1, C.h, 'ext', 'cinema');
  wall('x', C.z1, C.x0, C.x1, C.h, 'cinema', 'ext');
  wall('z', C.x1, C.z0, C.z1, C.h, 'cinema', 'ext');
  // sconces
  for (let x = 16; x < 33; x += 4) {
    box(basicMat(0xffc98a), x, 3.2, C.z0 + 0.2, 0.3, 0.45, 0.06);
    box(basicMat(0xffc98a), x, 3.2, C.z1 - 0.2, 0.3, 0.45, 0.06);
  }
  // screen
  const SW = 12.6, SH = 5.6, SY = 3.7, SX = C.x1 - 0.25;
  box(basicMat(0x050505), SX + 0.05, SY, 12, 0.1, SH + 0.4, SW + 0.4);
  const screenTex = textTexture('🎬 Купите билет в кассе', { w: 1024, h: 460, font: 'bold 64px system-ui, sans-serif', color: '#ffffff', bg: '#1b1220', glow: 'rgba(255,100,160,0.8)' });
  screenTex.userData.owned = true;
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex });
  const screen = addMesh(root, GEO.plane, screenMat, SX - 0.02, SY, 12, SW, SH, 1);
  screen.rotation.y = -Math.PI / 2;
  const curtMat = stdMat(0x9c1230, 0.9);
  for (const zc of [12 - SW / 2 - 0.9, 12 + SW / 2 + 0.9]) {
    for (let i = 0; i < 5; i++) addMesh(root, GEO.cyl, curtMat, SX - 0.2, C.h / 2, zc - 0.6 + i * 0.3, 0.17, C.h, 0.17);
  }
  box(curtMat, SX - 0.2, C.h - 0.2, 12, 0.3, 0.4, SW + 3.6); // valance stays above the screen
  // seats (instanced)
  const seatCount = C.rows * C.cols;
  const seatBase = new THREE.InstancedMesh(GEO.box, stdMat(0xb3123a, 0.8), seatCount);
  const seatBack = new THREE.InstancedMesh(GEO.box, stdMat(0xb3123a, 0.8), seatCount);
  const arms = new THREE.InstancedMesh(GEO.box, stdMat(0x2a1a22, 0.6), C.rows * (C.cols + 1));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  let si = 0, ai = 0;
  for (let r = 1; r <= C.rows; r++) {
    for (let c = 1; c <= C.cols; c++) {
      const p = cinemaSeatPos(r, c);
      m4.compose(v.set(p.x + 0.06, 0.32, p.z), q, s.set(0.6, 0.26, 0.62)); seatBase.setMatrixAt(si, m4);
      m4.compose(v.set(p.x - 0.28, 0.72, p.z), q, s.set(0.12, 0.85, 0.62)); seatBack.setMatrixAt(si, m4);
      si++;
    }
    for (let c = 0; c <= C.cols; c++) {
      const z = 12 + (c - 5) * 1.05;
      m4.compose(v.set(cinemaSeatPos(r, 1).x + 0.03, 0.55, z), q, s.set(0.6, 0.08, 0.08)); arms.setMatrixAt(ai++, m4);
    }
    const rx = cinemaSeatPos(r, 1).x;
    solid(rx - 0.4, rx + 0.4, 12 - 5.3, 12 + 5.3);
    sign(String(r), rx - 0.1, 1.0, 12 - 5.55, Math.PI, 0.5, 0.5, { color: '#ffd27a', glow: 'rgba(0,0,0,0.6)', font: 'bold 160px system-ui, sans-serif' });
  }
  root.add(seatBase, seatBack, arms);
  for (let x = 16; x < 32; x += 2) {
    box(basicMat(0xffb35c), x, 0.02, 12 - 5.9, 0.6, 0.02, 0.05);
    box(basicMat(0xffb35c), x, 0.02, 12 + 5.9, 0.6, 0.02, 0.05);
  }
  W.cinema = {
    bounds: { x0: C.x0, x1: C.x1, z0: C.z0, z1: C.z1 },
    screen, screenMat, size: { SW, SH },
    corners: [
      new THREE.Vector3(SX - 0.02, SY - SH / 2, 12 - SW / 2), new THREE.Vector3(SX - 0.02, SY + SH / 2, 12 - SW / 2),
      new THREE.Vector3(SX - 0.02, SY - SH / 2, 12 + SW / 2), new THREE.Vector3(SX - 0.02, SY + SH / 2, 12 + SW / 2),
    ],
    center: new THREE.Vector3(SX, SY, 12),
    showVideo(tex, w, h) {
      // letterbox the film inside the screen area
      const aspect = w && h ? w / h : 16 / 9;
      let pw = SW, ph = SW / aspect;
      if (ph > SH) { ph = SH; pw = SH * aspect; }
      screen.scale.set(pw, ph, 1);
      const old = screenMat.map;
      screenMat.map = tex;
      screenMat.needsUpdate = true;
      if (old && old.userData.owned) old.dispose();
    },
    setScreenText(text, bg = '#1b1220') {
      screen.scale.set(SW, SH, 1);
      const t = textTexture(text, { w: 1024, h: 460, font: 'bold 64px system-ui, sans-serif', color: '#ffffff', bg, glow: 'rgba(255,100,160,0.8)' });
      t.userData.owned = true;
      const old = screenMat.map;
      screenMat.map = t;
      screenMat.needsUpdate = true;
      if (old && old.userData.owned) old.dispose();
    },
    bots: [],
  };

  // ---------- lazy photo loading ----------
  let buildAlive = true;
  W.loadNear = (px, pz) => {
    for (const f of W.frames) {
      if (f.state !== 'wait') continue;
      if (Math.hypot(px - f.x, pz - f.z) > 28) continue;
      f.state = 'loading';
      loadPhotoTexture(photos[f.index], maxAniso).then((res) => {
        if (!buildAlive) { if (res) res.tex.dispose(); return; }
        if (!res) { f.mesh.material.map = TEX.failed; f.mesh.material.needsUpdate = true; f.state = 'failed'; return; }
        f.mesh.material.map = res.tex;
        f.mesh.material.needsUpdate = true;
        f.fit(res.w / res.h);
        f.state = 'done';
      });
    }
  };
  W.dispose = () => {
    buildAlive = false;
    scene.remove(root);
    disposeTree(root);
  };
  W.update = (t, dt) => {
    for (const f of W.floaters) {
      f.obj.position.y = f.base + Math.sin(t * 0.8 + f.phase) * (f.amp || 0.15);
      if (f.spin) f.obj.rotation.y = t * 0.6 + f.phase;
      if (f.pulse) f.obj.scale.setScalar(1 + Math.max(0, Math.sin(t * 4)) * 0.06);
    }
    for (const ch of W.statics) animateCharacter(ch, dt);
    for (const b of W.cinema.bots) {
      if (b.eatEvery && (b.eatTimer -= dt) < 0) { b.ch.eatT = 2.2; b.eatTimer = b.eatEvery * (0.7 + Math.random() * 0.6); }
      animateCharacter(b.ch, dt);
    }
  };
  return W;
}

// ------------------------------------------------------------
//  Collision: circle vs AABBs
// ------------------------------------------------------------
export function resolveCollision(W, p, r = 0.3) {
  for (let iter = 0; iter < 2; iter++) {
    for (const o of W.obstacles) {
      if (p.x < o.x0 - r || p.x > o.x1 + r || p.z < o.z0 - r || p.z > o.z1 + r) continue;
      const cx = clamp(p.x, o.x0, o.x1), cz = clamp(p.z, o.z0, o.z1);
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r; p.z = cz + (dz / d) * r;
      } else {
        const opts = [[o.x0 - r - p.x, 0], [o.x1 + r - p.x, 0], [0, o.z0 - r - p.z], [0, o.z1 + r - p.z]];
        opts.sort((a, b) => Math.abs(a[0] + a[1]) - Math.abs(b[0] + b[1]));
        p.x += opts[0][0]; p.z += opts[0][1];
      }
    }
  }
  p.x = clamp(p.x, LOBBY.x0 + 0.3, CINEMA.x1 - 0.3);
  p.z = clamp(p.z, W.zMin + 0.3, LOBBY.z1 - 0.3);
}

export function whereIs(W, x, z) {
  if (x > CINEMA.x0 && x < CINEMA.x1 && z > CINEMA.z0 && z < CINEMA.z1) return 'cinema';
  if (z < 0) return 'gallery';
  return 'lobby';
}

// ------------------------------------------------------------
//  Cinema audience bots (deterministic per film)
// ------------------------------------------------------------
export function botSeats(film) {
  const r = rng(1000 + film * 77);
  const taken = new Set();
  for (let row = 1; row <= CINEMA.rows; row++) {
    for (let s = 1; s <= CINEMA.cols; s++) {
      const centre = Math.abs(s - 5.5) < 2 && (row === 3 || row === 4);
      if (r() < (centre ? 0.2 : 0.38)) taken.add(`${row}-${s}`);
    }
  }
  return taken;
}

export function spawnBots(W, film, exclude) {
  for (const b of W.cinema.bots) { W.root.remove(b.ch.root); disposeTree(b.ch.root); }
  W.cinema.bots = [];
  if (film == null) return;
  const r = rng(5000 + film * 31);
  for (const key of botSeats(film)) {
    if (exclude && exclude.has(key)) continue;
    const [row, seat] = key.split('-').map(Number);
    const lk = randomLook(rng(row * 100 + seat + film * 7));
    const ch = makeCharacter(lk.kind, { label: false, palette: lk.palette, outfit: lk.outfit });
    const p = cinemaSeatPos(row, seat);
    ch.root.position.set(p.x, 0, p.z);
    ch.yaw = p.yaw;
    ch.seatH = p.h;
    ch.anim = 'sit';
    ch.animT = r() * 10;
    const eats = r() < 0.45;
    if (eats) {
      ch.heldType = null;
      const m = makeItemModel(r() < 0.7 ? 'popcorn' : 'cola');
      ch.j.handL.add(m); ch.heldModel = m; ch.heldType = 'popcorn';
    }
    W.root.add(ch.root);
    W.cinema.bots.push({ ch, eatEvery: eats ? 4 + r() * 6 : 0, eatTimer: r() * 5 });
  }
}
