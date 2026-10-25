import * as THREE from './vendor/three.module.min.js';
import { sharedGeo, stdMat, basicMat, addMesh, GEO, TEX, sharedMat } from './util.js';

// ------------------------------------------------------------
//  Catalog
// ------------------------------------------------------------
export const START_COINS = { girl: 5, boy: 99999 };

export const DEFAULT_OUTFIT = {
  girl: { top: 0xff7eb0, bottom: 0xff7eb0 },
  boy: { top: 0x4f8fe8, bottom: 0x2f3a56 },
};

const roses = (n, price) => ({ name: `Букет ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'роза' : 'роз'}`, icon: '💐', price, cat: 'flowers', roses: n, desc: n >= 101 ? 'Огромный букет 😍' : 'Красные розы' });

export const ITEMS = {
  roses_8: roses(8, 800),
  roses_16: roses(16, 1600),
  roses_25: roses(25, 2500),
  roses_51: roses(51, 5100),
  roses_101: roses(101, 10100),
  roses_301: roses(301, 30100),

  dress_red: { name: 'Красное платье', icon: '👗', price: 1500, cat: 'clothes', for: 'girl', outfit: { top: 0xd61f3c, bottom: 0xd61f3c } },
  dress_white: { name: 'Белое платье', icon: '👗', price: 2000, cat: 'clothes', for: 'girl', outfit: { top: 0xf7f3ee, bottom: 0xf7f3ee } },
  dress_blue: { name: 'Голубое платье', icon: '👗', price: 1500, cat: 'clothes', for: 'girl', outfit: { top: 0x6fb3ff, bottom: 0x6fb3ff } },
  dress_black: { name: 'Чёрное вечернее платье', icon: '👗', price: 2500, cat: 'clothes', for: 'girl', outfit: { top: 0x1d1b22, bottom: 0x1d1b22 } },
  dress_yellow: { name: 'Жёлтый сарафан', icon: '👗', price: 1200, cat: 'clothes', for: 'girl', outfit: { top: 0xffd54a, bottom: 0xffd54a } },
  dress_lilac: { name: 'Сиреневое платье', icon: '👗', price: 1800, cat: 'clothes', for: 'girl', outfit: { top: 0xb98cff, bottom: 0xb98cff } },
  shirt_white: { name: 'Белая рубашка', icon: '👔', price: 1200, cat: 'clothes', for: 'boy', outfit: { top: 0xf5f5f5, bottom: 0x2f3a56 } },
  suit_black: { name: 'Чёрный костюм', icon: '🤵', price: 5000, cat: 'clothes', for: 'boy', outfit: { top: 0x1f1f24, bottom: 0x1f1f24 } },
  hoodie_gray: { name: 'Серое худи', icon: '🧥', price: 1500, cat: 'clothes', for: 'boy', outfit: { top: 0x8a8f99, bottom: 0x3b4252 } },
  tee_red: { name: 'Красная футболка', icon: '👕', price: 900, cat: 'clothes', for: 'boy', outfit: { top: 0xd63a3a, bottom: 0x2f3a56 } },
  tee_green: { name: 'Зелёная футболка', icon: '👕', price: 900, cat: 'clothes', for: 'boy', outfit: { top: 0x3fae6a, bottom: 0xd8cbb0 } },

  phone_rose: { name: 'Смартфон Rose', icon: '📱', price: 900, cat: 'phones', color: 0xffb6cf },
  phone_pro: { name: 'Смартфон Pro Max', icon: '📱', price: 1500, cat: 'phones', color: 0x2a2a30 },
  phone_gold: { name: 'Смартфон Gold', icon: '📱', price: 2500, cat: 'phones', color: 0xd9b45a },
  phone_mint: { name: 'Смартфон Mint', icon: '📱', price: 1100, cat: 'phones', color: 0x9be3c8 },

  bag_pink: { name: 'Розовая сумочка', icon: '👜', price: 1200, cat: 'bags', color: 0xff8fb8, capacity: 10 },
  bag_white: { name: 'Белая сумка', icon: '👜', price: 1800, cat: 'bags', color: 0xf3efe8, capacity: 12 },
  bag_black: { name: 'Чёрная сумка', icon: '👜', price: 2200, cat: 'bags', color: 0x26222a, capacity: 12 },
  bag_gold: { name: 'Золотой клатч', icon: '👛', price: 3000, cat: 'bags', color: 0xd9b45a, capacity: 6 },

  popcorn: { name: 'Попкорн', icon: '🍿', price: 5, cat: 'food', portions: 8, verb: 'Съесть' },
  popcorn_big: { name: 'Большой попкорн', icon: '🍿', price: 10, cat: 'food', portions: 16, verb: 'Съесть', model: 'popcorn', scale: 1.3 },
  cola: { name: 'Кола', icon: '🥤', price: 3, cat: 'food', portions: 6, verb: 'Выпить' },

  ticket: { name: 'Билет в кино', icon: '🎟️', price: 300, cat: 'ticket' },
};

export const SHOP_TABS = [
  { id: 'flowers', title: '💐 Цветы' },
  { id: 'clothes', title: '👗 Одежда' },
  { id: 'phones', title: '📱 Смартфоны' },
  { id: 'bags', title: '👜 Сумки' },
];

let uidSeq = 0;
export function newItem(type, extra = {}) {
  const def = ITEMS[type];
  const it = { uid: Date.now().toString(36) + (uidSeq++).toString(36) + Math.random().toString(36).slice(2, 5), type, ...extra };
  if (def.portions) it.left = def.portions;
  if (def.cat === 'bags') it.items = [];
  return it;
}

export function itemLabel(it) {
  const d = ITEMS[it.type];
  if (!d) return '???';
  let s = d.name;
  if (d.portions) s += ` (${it.left}/${d.portions})`;
  if (it.type === 'ticket') s += ` — ряд ${it.row}, место ${it.seat}`;
  if (d.cat === 'bags') s += ` (${it.items.length}/${d.capacity})`;
  return s;
}

// ------------------------------------------------------------
//  3D models. Origin = where the hand holds it, +y up, +z forward.
// ------------------------------------------------------------
const roseGeo = sharedGeo('rose', () => new THREE.SphereGeometry(1, 10, 8));
const roseMat = sharedMat('rose', () => new THREE.MeshStandardMaterial({ color: 0xd0102b, roughness: 0.45 }));
const leafMat = stdMat(0x2f8a3a, 0.7);

function bouquetModel(n) {
  const g = new THREE.Group();
  const R = 0.07 + 0.019 * Math.sqrt(n);
  const H = 0.22 + R * 0.7;
  const wrap = new THREE.Mesh(sharedGeo('wrap', () => new THREE.ConeGeometry(1, 1, 18, 1, true)), sharedMat('wrap', () => new THREE.MeshStandardMaterial({ color: 0xfbe3ec, roughness: 0.8, side: THREE.DoubleSide })));
  wrap.rotation.x = Math.PI;
  wrap.scale.set(R * 1.15, H, R * 1.15);
  wrap.position.y = H * 0.25;
  g.add(wrap);
  const ribbon = addMesh(g, GEO.cyl, stdMat(0xff4f8b, 0.4), 0, 0, 0, 0.035, 0.03, 0.035);
  ribbon.position.y = -H * 0.05;
  const shown = Math.min(n, 70);
  const inst = new THREE.InstancedMesh(roseGeo, roseMat, shown);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const rr = Math.max(0.03, R / Math.sqrt(shown) * 1.35);
  for (let i = 0; i < shown; i++) {
    // golden-angle spiral over a dome
    const t = (i + 0.5) / shown;
    const a = i * 2.39996;
    const rad = Math.sqrt(t) * R;
    p.set(Math.cos(a) * rad, H * 0.75 + Math.cos((rad / R) * 1.2) * R * 0.45, Math.sin(a) * rad);
    s.setScalar(rr);
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
  }
  g.add(inst);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const lf = addMesh(g, GEO.sphere, leafMat, Math.cos(a) * R * 1.05, H * 0.66, Math.sin(a) * R * 1.05, R * 0.25, R * 0.12, R * 0.4);
    lf.rotation.y = -a;
  }
  g.position.z = R * 0.5;
  const outer = new THREE.Group();
  outer.add(g);
  return outer;
}

function phoneModel(color) {
  const g = new THREE.Group();
  addMesh(g, GEO.box, stdMat(color, 0.3, 0.5), 0, 0.05, 0.05, 0.075, 0.155, 0.012);
  const scr = addMesh(g, GEO.plane, basicMat(0x8fd3ff), 0, 0.05, 0.0435, 0.066, 0.14, 1);
  scr.rotation.y = Math.PI;
  addMesh(g, GEO.cyl, basicMat(0x111111), 0.022, 0.11, 0.057, 0.008, 0.004, 0.008).rotation.x = Math.PI / 2;
  return g;
}

function bagModel(color, small) {
  const g = new THREE.Group();
  const mat = stdMat(color, 0.45, 0.1);
  const w = small ? 0.22 : 0.3, h = small ? 0.13 : 0.22;
  addMesh(g, GEO.box, mat, 0, -0.1 - h / 2, 0, w, h, 0.1);
  addMesh(g, GEO.box, stdMat(0xd9b45a, 0.3, 0.7), 0, -0.1 - h * 0.2, 0.052, 0.04, 0.025, 0.01);
  const handle = new THREE.Mesh(sharedGeo('handle', () => new THREE.TorusGeometry(0.08, 0.012, 6, 16, Math.PI)), mat);
  handle.position.y = -0.1;
  g.add(handle);
  return g;
}

function popcornModel(scale = 1) {
  const g = new THREE.Group();
  const cup = new THREE.Mesh(sharedGeo('pcup', () => new THREE.CylinderGeometry(0.09, 0.065, 0.18, 16, 1, true)),
    sharedMat('pcup', () => new THREE.MeshStandardMaterial({ map: TEX.popcorn, roughness: 0.7, side: THREE.DoubleSide })));
  g.add(cup);
  const kernels = new THREE.InstancedMesh(sharedGeo('kernel', () => new THREE.IcosahedronGeometry(1, 0)), stdMat(0xfff1b0, 0.8), 22);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < 22; i++) {
    const a = i * 2.4, r = Math.sqrt((i + 0.5) / 22) * 0.08;
    p.set(Math.cos(a) * r, 0.1 + (0.08 - r) * 0.5, Math.sin(a) * r);
    q.setFromEuler(new THREE.Euler(i, i * 2, 0));
    s.setScalar(0.022);
    m.compose(p, q, s);
    kernels.setMatrixAt(i, m);
  }
  g.add(kernels);
  g.scale.setScalar(scale);
  return g;
}

function colaModel() {
  const g = new THREE.Group();
  addMesh(g, sharedGeo('colacup', () => new THREE.CylinderGeometry(0.05, 0.04, 0.16, 14)), stdMat(0xd8263a, 0.5), 0, 0, 0);
  addMesh(g, GEO.cyl, stdMat(0xffffff, 0.5), 0, 0.085, 0, 0.052, 0.012, 0.052);
  const straw = addMesh(g, GEO.cyl, stdMat(0xffffff, 0.5), 0.01, 0.15, 0, 0.006, 0.13, 0.006);
  straw.rotation.z = -0.2;
  return g;
}

function ticketModel() {
  const g = new THREE.Group();
  addMesh(g, GEO.box, stdMat(0xf5c542, 0.6), 0, 0.03, 0.04, 0.16, 0.07, 0.004);
  return g;
}

export function makeItemModel(type) {
  const d = ITEMS[type];
  if (!d) return null;
  if (d.roses) return bouquetModel(d.roses);
  if (d.cat === 'phones') return phoneModel(d.color);
  if (d.cat === 'bags') return bagModel(d.color, type === 'bag_gold');
  if (type === 'popcorn' || d.model === 'popcorn') return popcornModel(d.scale || 1);
  if (type === 'cola') return colaModel();
  if (type === 'ticket') return ticketModel();
  return null;
}

// grip style decides the arm pose
export function gripOf(type) {
  const d = ITEMS[type];
  if (!d) return null;
  if (d.roses) return 'bouquet';
  if (d.cat === 'bags') return 'bag';
  return 'hand';
}
