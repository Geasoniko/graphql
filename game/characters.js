import * as THREE from './vendor/three.module.min.js';
import { sharedGeo, stdMat, basicMat, sharedMat, canvasTexture, GEO, TEX, wrapAngle, disposeTree } from './util.js';
import { makeItemModel, gripOf, DEFAULT_OUTFIT, ITEMS } from './items.js';

// ------------------------------------------------------------
//  Characters built from primitives + procedural poses
// ------------------------------------------------------------
export const POSE_KEYS = ['hy', 'hrx', 'hry', 'hrz', 'sx', 'sy', 'sz', 'kx', 'ky', 'kz', 'alx', 'aly', 'alz', 'arx', 'ary', 'arz', 'ell', 'elr', 'ellz', 'elrz', 'llx', 'llz', 'lrx', 'lrz', 'knl', 'knr', 'spin', 'skirt', 'skirtY', 'eyes'];
function basePose() {
  const p = {};
  for (const k of POSE_KEYS) p[k] = 0;
  p.skirt = 1; p.skirtY = 1; p.eyes = 1;
  p.alz = 0.1; p.arz = -0.1; p.ell = -0.15; p.elr = -0.15;
  return p;
}

export const PALETTE = {
  girl: { skin: 0xf7d2bd, hair: 0x6b3a22, shoe: 0xffffff, accent: 0xff2d6f, scale: 0.94, longHair: true },
  boy: { skin: 0xeec2a0, hair: 0x2b1d14, shoe: 0x2a2a2a, accent: 0xffffff, scale: 1.0 },
};

const SKINS = [0xf7d2bd, 0xeec2a0, 0xd9a47e, 0xb97d58, 0x8d5a3b, 0xf3c9a8];
const HAIRS = [0x2b1d14, 0x6b3a22, 0xa0682e, 0xe2c27a, 0x111111, 0x7a3b2a, 0x9a9a9a];
const TOPS = [0x4f8fe8, 0xe85f5f, 0x3fae6a, 0xf2b84b, 0x9b6bd6, 0x2f3a56, 0xf5f5f5, 0x1d1b22, 0xff8fb8, 0x47b5c9];
export function randomLook(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const kind = r() < 0.5 ? 'girl' : 'boy';
  const top = pick(TOPS);
  return {
    kind,
    palette: { ...PALETTE[kind], skin: pick(SKINS), hair: pick(HAIRS), longHair: kind === 'girl' ? r() < 0.8 : false, scale: (kind === 'girl' ? 0.9 : 0.96) + r() * 0.08 },
    outfit: { top, bottom: kind === 'girl' && r() < 0.6 ? top : pick([0x2f3a56, 0x222222, 0x3b4252, 0xd8cbb0, 0x5b6b8a]) },
  };
}

function makeLabel(text) {
  const tex = canvasTexture(512, 128, (ctx, w) => {
    ctx.font = 'bold 54px system-ui, sans-serif';
    const tw = Math.min(w - 20, ctx.measureText(text).width + 50);
    ctx.fillStyle = 'rgba(30,16,30,0.6)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect((w - tw) / 2, 22, tw, 84, 42); else ctx.rect((w - tw) / 2, 22, tw, 84);
    ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, 66);
  });
  tex.userData.owned = true;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(0.72, 0.18, 1);
  s.renderOrder = 10;
  return s;
}

const cap = (r, len) => sharedGeo(`cap-${r}-${len}`, () => new THREE.CapsuleGeometry(r, len, 5, 10));
const sph = (r, ws = 14, hs = 10) => sharedGeo(`sph-${r}-${ws}`, () => new THREE.SphereGeometry(r, ws, hs));

/**
 * opts: { name, label (bool|string), palette, outfit, scene }
 */
export function makeCharacter(kind, opts = {}) {
  const girl = kind === 'girl';
  const C = { ...PALETTE[kind], ...(opts.palette || {}) };
  const outfit = opts.outfit || DEFAULT_OUTFIT[kind];
  // per-character materials that outfits recolor
  const topMat = new THREE.MeshStandardMaterial({ color: outfit.top, roughness: 0.7 });
  const bottomMat = new THREE.MeshStandardMaterial({ color: outfit.bottom, roughness: 0.7 });
  const skirtMat = new THREE.MeshStandardMaterial({ color: outfit.bottom, roughness: 0.7, side: THREE.DoubleSide });
  const skin = stdMat(C.skin, 0.6), hair = stdMat(C.hair, 0.5), shoe = stdMat(C.shoe, 0.4);
  const black = basicMat(0x1a1010);
  const white = stdMat(0xffffff, 0.7);

  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(C.scale);
  root.add(body);

  const shadow = new THREE.Mesh(GEO.plane, sharedMat('shadow', () => new THREE.MeshBasicMaterial({ map: TEX.shadow, transparent: true, depthWrite: false })));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01; shadow.scale.set(0.9, 0.9, 1);
  root.add(shadow);

  const add = (geo, mat, parent, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };

  const hips = new THREE.Group(); hips.position.y = 0.92; body.add(hips);
  const spine = new THREE.Group(); spine.position.y = 0.04; hips.add(spine);

  add(cap(girl ? 0.145 : 0.165, 0.3), topMat, spine, 0, 0.27).scale.set(1, 1, 0.78);
  if (girl) add(sharedGeo('belt', () => new THREE.CylinderGeometry(0.15, 0.15, 0.05, 16)), white, spine, 0, 0.1).scale.z = 0.8;
  else add(sharedGeo('collar', () => new THREE.CylinderGeometry(0.09, 0.12, 0.05, 14)), white, spine, 0, 0.5);
  add(sph(0.155), girl ? topMat : bottomMat, hips).scale.set(1, 0.7, 0.8);

  let skirt = null;
  if (girl) {
    skirt = add(sharedGeo('skirt', () => new THREE.CylinderGeometry(0.15, 0.36, 0.46, 20, 1, true).translate(0, -0.23, 0)), skirtMat, hips, 0, 0.05);
    const hem = add(sharedGeo('hem', () => new THREE.TorusGeometry(0.36, 0.018, 6, 28)), white, skirt, 0, -0.46);
    hem.rotation.x = Math.PI / 2;
  }

  add(cap(0.05, 0.06), skin, spine, 0, 0.52);
  const head = new THREE.Group(); head.position.y = 0.58; spine.add(head);
  add(sph(0.165, 22, 16), skin, head, 0, 0.15).scale.set(1, 1.04, 0.98);
  const eyes = new THREE.Group(); eyes.position.set(0, 0.16, 0.148); head.add(eyes);
  const eyeL = add(sph(0.022, 10, 8), black, eyes, 0.058);
  const eyeR = add(sph(0.022, 10, 8), black, eyes, -0.058);
  eyeL.scale.z = eyeR.scale.z = 0.5;
  add(sph(0.007, 6, 4), basicMat(0xffffff), eyeL, 0.008, 0.008, 0.012);
  add(sph(0.007, 6, 4), basicMat(0xffffff), eyeR, 0.008, 0.008, 0.012);
  const blush = sharedMat('blush', () => new THREE.MeshBasicMaterial({ color: 0xff8fa8, transparent: true, opacity: 0.55 }));
  add(sph(0.03, 10, 8), blush, head, 0.095, 0.105, 0.125).scale.set(1, 0.6, 0.3);
  add(sph(0.03, 10, 8), blush, head, -0.095, 0.105, 0.125).scale.set(1, 0.6, 0.3);
  const mouth = add(sharedGeo('mouth', () => new THREE.TorusGeometry(0.025, 0.006, 6, 12, Math.PI)), basicMat(girl ? 0xd6336c : 0x8a3b3b), head, 0, 0.095, 0.158);
  mouth.rotation.z = Math.PI;
  add(sph(0.03, 8, 6), skin, head, 0.16, 0.14).scale.set(0.5, 1, 0.8);
  add(sph(0.03, 8, 6), skin, head, -0.16, 0.14).scale.set(0.5, 1, 0.8);

  const hairCap = add(sharedGeo('haircap', () => new THREE.SphereGeometry(0.178, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.55)), hair, head, 0, 0.165, -0.008);
  hairCap.rotation.x = -0.25;
  if (C.longHair) {
    add(cap(0.15, 0.3), hair, head, 0, 0.02, -0.07).scale.set(1.12, 1, 0.6);
    add(sph(0.12), hair, head, 0, 0.27, 0.09).scale.set(1.3, 0.45, 0.6);
  } else {
    const fr = add(sph(0.13), hair, head, 0.02, 0.27, 0.08);
    fr.scale.set(1.25, 0.4, 0.7); fr.rotation.z = -0.2;
  }
  if (girl && !opts.palette) {
    const bowMat = stdMat(C.accent, 0.4);
    const bowGeo = sharedGeo('bow', () => new THREE.ConeGeometry(0.05, 0.09, 10));
    add(bowGeo, bowMat, head, 0.065, 0.31, -0.03).rotation.z = Math.PI / 2;
    add(bowGeo, bowMat, head, 0.155, 0.31, -0.03).rotation.z = -Math.PI / 2;
    add(sph(0.022, 8, 6), bowMat, head, 0.11, 0.31, -0.03);
  }

  const makeArm = (side) => {
    const sh = new THREE.Group();
    sh.position.set(side * (girl ? 0.19 : 0.22), 0.45, 0);
    spine.add(sh);
    add(cap(girl ? 0.045 : 0.052, 0.2), girl ? skin : topMat, sh, 0, -0.13);
    const el = new THREE.Group(); el.position.y = -0.27; sh.add(el);
    add(cap(girl ? 0.04 : 0.046, 0.18), skin, el, 0, -0.12);
    add(sph(0.05, 10, 8), skin, el, 0, -0.26);
    const hand = new THREE.Group(); hand.position.y = -0.27; el.add(hand);
    if (girl) add(sph(0.07, 12, 10), topMat, sh, 0, -0.02).scale.set(1, 0.8, 1);
    return { sh, el, hand };
  };
  const armL = makeArm(1), armR = makeArm(-1);

  const makeLeg = (side) => {
    const hp = new THREE.Group(); hp.position.set(side * 0.085, -0.02, 0); hips.add(hp);
    add(cap(girl ? 0.06 : 0.07, 0.3), girl ? skin : bottomMat, hp, 0, -0.22);
    const kn = new THREE.Group(); kn.position.y = -0.44; hp.add(kn);
    add(cap(girl ? 0.052 : 0.06, 0.28), girl ? skin : bottomMat, kn, 0, -0.2);
    const sh = add(GEO.box, shoe, kn, 0, -0.44, 0.04); sh.scale.set(0.11, 0.08, 0.22);
    return { hp, kn };
  };
  const legL = makeLeg(1), legR = makeLeg(-1);

  let label = null;
  if (opts.label !== false) {
    label = makeLabel(typeof opts.label === 'string' ? opts.label : (girl ? '👧 ' : '👦 ') + (opts.name || (girl ? 'Девушка' : 'Парень')));
    label.position.y = girl ? 1.92 : 2.02;
    root.add(label);
  }

  if (opts.scene) opts.scene.add(root);
  return {
    kind, name: opts.name || '', root, body, label, skirt, eyes, scale: C.scale,
    mats: { top: topMat, bottom: bottomMat, skirt: skirtMat },
    j: { hips, spine, head, shL: armL.sh, elL: armL.el, shR: armR.sh, elR: armR.el, hipL: legL.hp, knL: legL.kn, hipR: legR.hp, knR: legR.kn, handL: armL.hand, handR: armR.hand },
    cur: basePose(),
    anim: 'idle', animT: 0, phase: 0, stride: 0, speed: 0,
    yaw: Math.PI, blink: 2 + Math.random() * 3,
    seatH: 0.45, eatT: 0, giveT: 0, heldType: null, heldModel: null, outfitType: null,
  };
}

export function removeCharacter(scene, ch) {
  if (!ch) return;
  scene.remove(ch.root);
  disposeTree(ch.root);
}

export function setAnim(ch, anim) {
  if (!ch || ch.anim === anim) return;
  ch.anim = anim;
  ch.animT = 0;
}

export function setOutfit(ch, type) {
  if (!ch || ch.outfitType === type) return;
  ch.outfitType = type;
  const o = (type && ITEMS[type] && ITEMS[type].outfit) || DEFAULT_OUTFIT[ch.kind];
  ch.mats.top.color.setHex(o.top);
  ch.mats.bottom.color.setHex(o.bottom);
  ch.mats.skirt.color.setHex(o.bottom);
}

export function setHeld(ch, type) {
  if (!ch || ch.heldType === type) return;
  if (ch.heldModel) { ch.heldModel.parent.remove(ch.heldModel); disposeTree(ch.heldModel); ch.heldModel = null; }
  ch.heldType = type || null;
  if (!type) return;
  const m = makeItemModel(type);
  if (!m) { ch.heldType = null; return; }
  ch.heldModel = m;
  ch.j.handL.add(m);
}

const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

function computePose(ch) {
  const P = basePose();
  const t = ch.animT;
  const girl = ch.kind === 'girl';
  switch (ch.anim) {
    case 'idle': {
      P.sx = Math.sin(t * 1.8) * 0.015;
      P.kz = Math.sin(t * 0.7) * 0.04;
      P.ky = Math.sin(t * 0.37) * 0.2;
      P.alz = 0.1 + Math.sin(t * 1.8) * 0.02; P.arz = -P.alz;
      if (girl) { P.lrx = -0.05; P.knr = 0.15; P.hrz = 0.04; P.ell = -0.3; P.elr = -0.3; }
      break;
    }
    case 'walk': {
      const ph = ch.phase, a = ch.stride;
      P.llx = -Math.sin(ph) * 0.55 * a; P.lrx = Math.sin(ph) * 0.55 * a;
      P.knl = 0.05 + Math.max(0, Math.cos(ph)) * 0.85 * a;
      P.knr = 0.05 + Math.max(0, -Math.cos(ph)) * 0.85 * a;
      P.alx = Math.sin(ph) * 0.5 * a; P.arx = -Math.sin(ph) * 0.5 * a;
      P.alz = 0.12; P.arz = -0.12; P.ell = -0.25 - 0.3 * a; P.elr = P.ell;
      P.hy = -0.035 * a + Math.abs(Math.cos(ph)) * 0.035 * a;
      P.hry = Math.sin(ph) * 0.12 * a; P.sy = -Math.sin(ph) * 0.2 * a;
      P.sx = 0.04 * a + (a > 1.1 ? 0.08 : 0);
      break;
    }
    case 'sit': {
      // hips sit on a seat of height seatH (world units)
      P.hy = (ch.seatH + 0.1) / ch.scale - 0.92;
      P.llx = P.lrx = -1.45; P.knl = P.knr = 1.45;
      P.llz = 0.06; P.lrz = -0.06;
      if (girl) { P.llz = -0.02; P.lrz = 0.02; }
      P.sx = -0.06 + Math.sin(t * 1.6) * 0.01;
      P.alx = P.arx = -0.55; P.ell = P.elr = -0.65; P.alz = 0.18; P.arz = -0.18;
      P.ky = Math.sin(t * 0.3) * 0.25; P.kz = Math.sin(t * 0.5) * 0.04;
      P.skirt = 1.25; P.skirtY = 0.42;
      break;
    }
    case 'dance1': {
      const b = t * Math.PI * 4;
      const sq = Math.abs(Math.sin(b / 2));
      P.hy = -sq * 0.08;
      P.hrz = Math.sin(b / 2) * 0.14; P.sz = -P.hrz * 0.8;
      P.hry = Math.sin(b / 4) * 0.25;
      P.alz = 2.55 + Math.sin(b) * 0.3; P.arz = -(2.55 + Math.sin(b + Math.PI) * 0.3);
      P.alx = -0.2; P.arx = -0.2;
      P.ell = -0.5 - Math.max(0, Math.sin(b)) * 0.5; P.elr = -0.5 - Math.max(0, -Math.sin(b)) * 0.5;
      P.kx = Math.sin(b) * 0.12; P.kz = Math.sin(b / 2) * 0.1;
      P.llx = P.lrx = -sq * 0.35; P.knl = P.knr = sq * 0.7;
      P.llz = 0.08; P.lrz = -0.08;
      break;
    }
    case 'dance2': {
      const b = t * Math.PI * 4;
      const side = Math.sin(b / 4);
      const up = side > 0;
      P.alz = up ? 2.4 : 0.5; P.alx = up ? -0.4 : -0.3; P.ell = up ? -0.15 : -1.6; P.ellz = up ? 0 : -0.6;
      P.arz = up ? -0.5 : -2.4; P.arx = up ? -0.3 : -0.4; P.elr = up ? -1.6 : -0.15; P.elrz = up ? 0.6 : 0;
      P.hrz = Math.sin(b) * 0.12; P.sz = -P.hrz;
      P.hy = -Math.abs(Math.sin(b)) * 0.05;
      P.llz = Math.max(0, Math.sin(b)) * 0.3; P.lrz = -Math.max(0, -Math.sin(b)) * 0.3;
      P.knl = Math.max(0, -Math.sin(b)) * 0.4; P.knr = Math.max(0, Math.sin(b)) * 0.4;
      P.kz = side * 0.15; P.ky = side * 0.3;
      const cycle = t % 8;
      P.spin = cycle > 6 ? ((cycle - 6) / 2) * Math.PI * 2 : 0;
      P.skirt = 1 + (cycle > 6 ? 0.25 : 0.05);
      break;
    }
    case 'wave': {
      P.arz = -2.5; P.arx = -0.25; P.elr = -0.5; P.elrz = Math.sin(t * 10) * 0.55;
      P.kz = 0.12; P.ky = -0.1; P.sz = 0.04;
      if (girl) { P.lrx = 0.2; P.knr = 0.6; }
      break;
    }
    case 'waltz': {
      const b = t * Math.PI * 2 * (168 / 60 / 3);
      P.hy = -0.03 + Math.sin(b) * 0.035;
      P.llx = Math.sin(b) * 0.3; P.lrx = -Math.sin(b) * 0.3;
      P.knl = 0.12 + Math.max(0, Math.sin(b)) * 0.3; P.knr = 0.12 + Math.max(0, -Math.sin(b)) * 0.3;
      if (!girl) {
        P.alx = -0.55; P.alz = 1.2; P.ell = -1.35;
        P.arx = -0.95; P.arz = 0.35; P.elr = -1.15; P.elrz = 0.3;
        P.kz = -0.06; P.ky = 0.2; P.sx = -0.03;
      } else {
        P.arx = -0.55; P.arz = -1.2; P.elr = -1.35;
        P.alx = -1.45; P.alz = -0.1; P.ell = -0.85;
        P.kz = 0.2; P.ky = -0.35; P.sx = -0.08; P.kx = -0.08;
        P.skirt = 1.22 + Math.sin(b) * 0.05;
      }
      break;
    }
    case 'kiss': {
      const e = Math.min(1, t / 1.0);
      const s = e * e * (3 - 2 * e);
      P.sx = 0.17 * s; P.eyes = 1 - 0.88 * s;
      if (!girl) {
        P.kx = 0.2 * s; P.kz = -0.14 * s;
        P.alx = -0.85; P.alz = -0.25; P.ell = -0.8;
        P.arx = -0.85; P.arz = 0.25; P.elr = -0.8;
      } else {
        P.hy = 0.04 * s; P.kx = -0.24 * s; P.kz = 0.16 * s;
        P.alx = -2.0; P.alz = 0.5; P.ell = -0.7; P.ellz = -0.7;
        P.arx = -2.0; P.arz = -0.5; P.elr = -0.7; P.elrz = 0.7;
        P.lrx = 0.25 * s; P.knr = 1.3 * s;
      }
      break;
    }
  }

  // ---- upper-body overlays ----
  const free = ['idle', 'walk', 'sit'].includes(ch.anim);
  if (ch.heldType && free) {
    const grip = gripOf(ch.heldType);
    if (grip === 'bouquet') { P.alx = -0.75; P.ell = -1.35; P.alz = 0.05; }
    else if (grip === 'bag') { P.alx = ch.anim === 'walk' ? P.alx * 0.3 : -0.05; P.ell = -0.25; P.alz = 0.22; }
    else { P.alx = -0.5; P.ell = -1.25; P.alz = 0.1; }
    if (ch.anim === 'sit' && grip !== 'bag') { P.alx = -0.7; P.ell = -1.1; }
  }
  if (ch.eatT > 0 && free) {
    const f = 0.5 - 0.5 * Math.cos(ch.eatT * 5.5);
    P.arx = -0.55 - 0.35 * f; P.elr = -1.0 - 1.25 * f; P.arz = 0.25 + 0.2 * f; P.elrz = 0.1;
    P.kx = 0.05 * f;
  }
  if (ch.giveT > 0) {
    P.alx = -1.35; P.ell = -0.15; P.alz = 0.0; P.sx += 0.06;
  }
  return P;
}

export function animateCharacter(ch, dt) {
  ch.animT += dt;
  if (ch.eatT > 0) ch.eatT = Math.max(0, ch.eatT - dt);
  if (ch.giveT > 0) ch.giveT = Math.max(0, ch.giveT - dt);
  const P = computePose(ch);
  const c = ch.cur;
  const k = 1 - Math.exp(-14 * dt);
  for (const key of POSE_KEYS) {
    if (key === 'spin') c.spin = wrapAngle(c.spin) + wrapAngle(P.spin - wrapAngle(c.spin)) * k;
    else c[key] += (P[key] - c[key]) * k;
  }
  const J = ch.j;
  J.hips.position.y = 0.92 + c.hy;
  J.hips.rotation.set(c.hrx, c.hry, c.hrz);
  J.spine.rotation.set(c.sx, c.sy, c.sz);
  J.head.rotation.set(c.kx, c.ky, c.kz);
  J.shL.rotation.set(c.alx, c.aly, c.alz);
  J.shR.rotation.set(c.arx, c.ary, c.arz);
  J.elL.rotation.set(c.ell, 0, c.ellz);
  J.elR.rotation.set(c.elr, 0, c.elrz);
  J.hipL.rotation.set(c.llx, 0, c.llz);
  J.hipR.rotation.set(c.lrx, 0, c.lrz);
  J.knL.rotation.x = c.knl;
  J.knR.rotation.x = c.knr;
  ch.body.rotation.y = c.spin;
  if (ch.skirt) ch.skirt.scale.set(c.skirt, c.skirtY, c.skirt);

  ch.blink -= dt;
  let blink = 1;
  if (ch.blink < 0.12) blink = 0.1;
  if (ch.blink < 0) ch.blink = 2 + Math.random() * 3.5;
  ch.eyes.scale.y = Math.max(0.08, c.eyes * blink);

  ch.root.rotation.y = ch.yaw;

  // held items stay upright no matter how the arm is bent
  if (ch.heldModel) {
    ch.root.updateMatrixWorld(true);
    J.handL.getWorldQuaternion(_q1);
    ch.root.getWorldQuaternion(_q2);
    ch.heldModel.quaternion.copy(_q1.invert().multiply(_q2));
  }
}
