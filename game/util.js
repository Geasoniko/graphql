import * as THREE from './vendor/three.module.min.js';

export const $ = (s) => document.querySelector(s);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const wrapAngle = (a) => ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
export const angDamp = (a, b, rate, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-rate * dt));
export const opposite = (k) => (k === 'girl' ? 'boy' : 'girl');
export const now = () => performance.now() / 1000;
export const fmt = (n) => Math.floor(n).toLocaleString('ru-RU');

// small deterministic RNG so both players see the same random things
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function heartPath(ctx, cx, top, s) {
  ctx.beginPath();
  ctx.moveTo(cx, top + s * 0.3);
  ctx.bezierCurveTo(cx, top, cx - s * 0.5, top, cx - s * 0.5, top + s * 0.32);
  ctx.bezierCurveTo(cx - s * 0.5, top + s * 0.6, cx - s * 0.1, top + s * 0.78, cx, top + s * 0.95);
  ctx.bezierCurveTo(cx + s * 0.1, top + s * 0.78, cx + s * 0.5, top + s * 0.6, cx + s * 0.5, top + s * 0.32);
  ctx.bezierCurveTo(cx + s * 0.5, top, cx, top, cx, top + s * 0.3);
  ctx.closePath();
}

export function textTexture(text, { w = 1024, h = 256, font = 'bold 110px Georgia, serif', color = '#7a2c4b', bg = null, glow = 'rgba(255,255,255,0.7)' } = {}) {
  return canvasTexture(w, h, (ctx) => {
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 10;
    const lines = String(text).split('\n');
    const lh = h / (lines.length + 0.2);
    lines.forEach((l, i) => ctx.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * lh + 6));
  });
}

// Shared geometries / materials are flagged so disposeTree() leaves them alone.
const geoCache = new Map();
export function sharedGeo(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); g.userData.shared = true; geoCache.set(key, g); }
  return g;
}
const matCache = new Map();
export function sharedMat(key, make) {
  let m = matCache.get(key);
  if (!m) { m = make(); m.userData.shared = true; matCache.set(key, m); }
  return m;
}
export const stdMat = (color, rough = 0.7, metal = 0) =>
  sharedMat(`std-${color}-${rough}-${metal}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
export const basicMat = (color) => sharedMat(`basic-${color}`, () => new THREE.MeshBasicMaterial({ color }));

export const GEO = {
  box: sharedGeo('box', () => new THREE.BoxGeometry(1, 1, 1)),
  plane: sharedGeo('plane', () => new THREE.PlaneGeometry(1, 1)),
  sphere: sharedGeo('sphere', () => new THREE.SphereGeometry(1, 16, 12)),
  cyl: sharedGeo('cyl', () => new THREE.CylinderGeometry(1, 1, 1, 16)),
};

export function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (m.userData.shared) continue;
      if (m.map && m.map.userData.owned) m.map.dispose();
      m.dispose();
    }
  });
}

export function addMesh(parent, geo, mat, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  parent.add(m);
  return m;
}

export function heartGeometry(size = 1, depth = 0.2) {
  const s = new THREE.Shape();
  s.moveTo(0, -0.45);
  s.bezierCurveTo(-0.15, -0.3, -0.55, -0.05, -0.55, 0.22);
  s.bezierCurveTo(-0.55, 0.5, -0.2, 0.62, 0, 0.35);
  s.bezierCurveTo(0.2, 0.62, 0.55, 0.5, 0.55, 0.22);
  s.bezierCurveTo(0.55, -0.05, 0.15, -0.3, 0, -0.45);
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 4, curveSegments: 18 });
  g.translate(0, 0, -depth / 2);
  g.scale(size, size, size);
  return g;
}

export const TEX = {
  parquet: canvasTexture(512, 512, (ctx, w, h) => {
    const rows = 8, pw = w / 2;
    for (let r = 0; r < rows; r++) {
      for (let i = -1; i < 3; i++) {
        const x = i * pw + (r % 2) * pw * 0.5;
        const shade = 0.85 + ((r * 7 + i * 13) % 5) * 0.04;
        ctx.fillStyle = `rgb(${Math.round(176 * shade)},${Math.round(122 * shade)},${Math.round(84 * shade)})`;
        ctx.fillRect(x, (r * h) / rows, pw, h / rows);
        ctx.strokeStyle = 'rgba(60,30,15,0.45)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, (r * h) / rows, pw, h / rows);
      }
    }
  }),
  marble: canvasTexture(512, 512, (ctx, w, h) => {
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#efe6e0' : '#f8f2ee';
      ctx.fillRect(x * w / 2, y * h / 2, w / 2, h / 2);
    }
    ctx.strokeStyle = 'rgba(160,130,120,0.25)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 14; i++) {
      ctx.beginPath();
      const x0 = (i * 97) % w, y0 = (i * 53) % h;
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(x0 + 60, y0 + 30, x0 + 20, y0 + 90, x0 + 120, y0 + 140);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(200,170,100,0.6)';
    ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.strokeRect(w / 2, 0, 1, h); ctx.strokeRect(0, h / 2, w, 1);
  }),
  carpet: canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#5a1530'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,200,120,0.18)';
    for (let y = 0; y < h; y += 32) for (let x = (y / 32) % 2 ? 16 : 0; x < w; x += 32) { ctx.beginPath(); ctx.arc(x + 8, y + 8, 3, 0, Math.PI * 2); ctx.fill(); }
  }),
  heart: canvasTexture(128, 128, (ctx, w) => {
    const g = ctx.createLinearGradient(0, 0, 0, w);
    g.addColorStop(0, '#ff8fb8'); g.addColorStop(1, '#ff2d6f');
    ctx.fillStyle = g;
    ctx.shadowColor = 'rgba(255,255,255,0.8)'; ctx.shadowBlur = 10;
    heartPath(ctx, 64, 14, 104); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.ellipse(40, 42, 10, 6, -0.6, 0, Math.PI * 2); ctx.fill();
  }),
  spark: canvasTexture(64, 64, (ctx, w) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,230,160,0.9)'); g.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
  }),
  glow: canvasTexture(128, 128, (ctx, w) => {
    const g = ctx.createRadialGradient(64, 54, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,240,215,0.75)'); g.addColorStop(1, 'rgba(255,240,215,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
  }),
  shadow: canvasTexture(64, 64, (ctx, w) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
  }),
  popcorn: canvasTexture(128, 128, (ctx, w, h) => {
    for (let i = 0; i < 8; i++) { ctx.fillStyle = i % 2 ? '#ffffff' : '#e3263b'; ctx.fillRect((i * w) / 8, 0, w / 8, h); }
  }),
  placeholder: canvasTexture(512, 384, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#ffd1e3'); g.addColorStop(1, '#e8d4ff');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ff6fa3'; heartPath(ctx, w / 2, 70, 140); ctx.fill();
    ctx.fillStyle = '#6b3a55'; ctx.textAlign = 'center';
    ctx.font = 'bold 34px system-ui, sans-serif'; ctx.fillText('Здесь будет', w / 2, 270);
    ctx.fillText('наше фото', w / 2, 312);
  }),
  loading: canvasTexture(256, 192, (ctx, w, h) => {
    ctx.fillStyle = '#efe4ea'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#a07890'; ctx.textAlign = 'center'; ctx.font = '22px system-ui, sans-serif';
    ctx.fillText('загрузка…', w / 2, h / 2 + 8);
  }),
  failed: canvasTexture(512, 384, (ctx, w, h) => {
    ctx.fillStyle = '#f2e6ea'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#c0607f'; heartPath(ctx, w / 2, 60, 110); ctx.fill();
    ctx.fillStyle = '#6b3a55'; ctx.textAlign = 'center';
    ctx.font = 'bold 28px system-ui, sans-serif'; ctx.fillText('Нажмите, чтобы открыть', w / 2, 240);
    ctx.font = '19px system-ui, sans-serif';
    ctx.fillText('(в Drive включите доступ', w / 2, 285);
    ctx.fillText('«всем, у кого есть ссылка»)', w / 2, 312);
  }),
};
for (const k of ['parquet', 'marble', 'carpet']) TEX[k].wrapS = TEX[k].wrapT = THREE.RepeatWrapping;

export function wallpaperTexture(base, motif) {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = motif;
    for (let y = 0; y < h; y += 64) for (let x = (y / 64) % 2 ? 32 : 0; x < w; x += 64) { heartPath(ctx, x + 16, y + 10, 14); ctx.fill(); }
  });
}

// ---------- Google Drive helpers ----------
export function driveFileId(url) {
  const m = url.match(/\/file\/d\/([\w-]{10,})/) || url.match(/[?&]id=([\w-]{10,})/) || url.match(/googleusercontent\.com\/d\/([\w-]{10,})/);
  return m ? m[1] : null;
}
export function driveFolderId(url) {
  const m = String(url || '').match(/\/folders\/([\w-]{10,})/);
  return m ? m[1] : null;
}
// wsrv.nl is a free image proxy that always sends CORS headers — the fallback when Google's own hosts don't
const proxy = (u) => `https://wsrv.nl/?url=${encodeURIComponent(u)}&w=1400&output=jpg`;
export function textureSources(p) {
  if (p.startsWith('data:')) return [p];
  const id = driveFileId(p);
  if (id) {
    return [
      `https://lh3.googleusercontent.com/d/${id}=w1400`,
      `https://drive.google.com/thumbnail?id=${id}&sz=w1400`,
      proxy(`https://lh3.googleusercontent.com/d/${id}=w1400`),
      proxy(`https://drive.google.com/uc?export=view&id=${id}`),
    ];
  }
  return [p, proxy(p)];
}
export function viewSource(p) {
  if (p.startsWith('data:')) return p;
  const id = driveFileId(p);
  return id ? `https://lh3.googleusercontent.com/d/${id}=w2400` : p;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    const timer = setTimeout(() => { img.src = ''; reject(new Error('timeout')); }, 12000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = (e) => { clearTimeout(timer); reject(e); };
    img.src = src;
  });
}
export async function loadPhotoTexture(p, maxAniso = 4) {
  for (const src of textureSources(p)) {
    try {
      const img = await loadImage(src);
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;
      tex.needsUpdate = true;
      tex.userData.owned = true;
      return { tex, w: img.naturalWidth, h: img.naturalHeight };
    } catch { /* try next source */ }
  }
  return null;
}
