import * as THREE from './vendor/three.module.min.js';

// ============================================================
//  Наша галерея — 3D прогулка вдвоём
// ============================================================

const CFG = Object.assign(
  { title: 'Наша история 💕', photos: [], driveApiKey: '', peerServer: null, roomPrefix: 'nasha-galereya-v1-' },
  window.GALLERY_CONFIG || {}
);

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
const wrapAngle = (a) => ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
const angDamp = (a, b, rate, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-rate * dt));
const opposite = (k) => (k === 'girl' ? 'boy' : 'girl');
const now = () => performance.now() / 1000;

const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');

// ------------------------------------------------------------
//  Toast
// ------------------------------------------------------------
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ------------------------------------------------------------
//  Google Drive helpers
// ------------------------------------------------------------
function driveFileId(url) {
  const m = url.match(/\/file\/d\/([\w-]{10,})/) || url.match(/[?&]id=([\w-]{10,})/) || url.match(/googleusercontent\.com\/d\/([\w-]{10,})/);
  return m ? m[1] : null;
}
function driveFolderId(url) {
  const m = url.match(/\/folders\/([\w-]{10,})/);
  return m ? m[1] : null;
}
// Candidate image URLs that allow use as a WebGL texture (CORS).
function textureSources(p) {
  if (p.startsWith('data:')) return [p];
  const id = driveFileId(p);
  if (id) return [`https://lh3.googleusercontent.com/d/${id}=w1600`, `https://drive.google.com/thumbnail?id=${id}&sz=w1600`];
  return [p];
}
function viewSource(p) {
  if (p.startsWith('data:')) return p;
  const id = driveFileId(p);
  return id ? `https://lh3.googleusercontent.com/d/${id}=w2400` : p;
}
async function expandFolders(lines) {
  const out = [];
  for (const line of lines) {
    const folder = driveFolderId(line);
    if (!folder) { out.push(line); continue; }
    if (!CFG.driveApiKey) { toast('Для ссылки на папку нужен driveApiKey в photos.js — или вставьте ссылки на отдельные фото', 5000); continue; }
    try {
      const q = encodeURIComponent(`'${folder}' in parents and mimeType contains 'image/' and trashed = false`);
      let pageToken = '';
      do {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&key=${CFG.driveApiKey}&fields=nextPageToken,files(id,name)&orderBy=createdTime&pageSize=200${pageToken ? '&pageToken=' + pageToken : ''}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        for (const f of data.files || []) out.push(`https://drive.google.com/file/d/${f.id}/view`);
        pageToken = data.nextPageToken || '';
      } while (pageToken);
    } catch (e) {
      toast('Не удалось прочитать папку: ' + e.message, 5000);
    }
  }
  return out;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
async function loadPhotoTexture(p) {
  for (const src of textureSources(p)) {
    try {
      const img = await loadImage(src);
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;
      return { tex, w: img.naturalWidth, h: img.naturalHeight };
    } catch { /* try next source */ }
  }
  return null;
}

// ------------------------------------------------------------
//  Renderer / scene
// ------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.id = 'c';
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a1d26);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 200);

scene.add(new THREE.HemisphereLight(0xfff1e6, 0x7a5a50, 1.6));
const sun = new THREE.DirectionalLight(0xfff0dd, 1.3);
sun.position.set(3, 10, 4);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffd6e8, 0.5);
fill.position.set(-4, 6, -6);
scene.add(fill);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function heartPath(ctx, cx, top, s) {
  ctx.beginPath();
  ctx.moveTo(cx, top + s * 0.3);
  ctx.bezierCurveTo(cx, top, cx - s * 0.5, top, cx - s * 0.5, top + s * 0.32);
  ctx.bezierCurveTo(cx - s * 0.5, top + s * 0.6, cx - s * 0.1, top + s * 0.78, cx, top + s * 0.95);
  ctx.bezierCurveTo(cx + s * 0.1, top + s * 0.78, cx + s * 0.5, top + s * 0.6, cx + s * 0.5, top + s * 0.32);
  ctx.bezierCurveTo(cx + s * 0.5, top, cx, top, cx, top + s * 0.3);
  ctx.closePath();
}

const TEX = {
  floor: canvasTexture(512, 512, (ctx, w, h) => {
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
        ctx.strokeStyle = 'rgba(255,230,200,0.06)';
        for (let g = 0; g < 5; g++) {
          const y = (r * h) / rows + 6 + g * 11;
          ctx.beginPath(); ctx.moveTo(x + 4, y); ctx.bezierCurveTo(x + pw * 0.3, y + 3, x + pw * 0.6, y - 3, x + pw - 4, y + 1); ctx.stroke();
        }
      }
    }
  }),
  wall: canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#f4e7dc'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(214,170,170,0.18)';
    for (let y = 0; y < h; y += 64) for (let x = (y / 64) % 2 ? 32 : 0; x < w; x += 64) { heartPath(ctx, x + 16, y + 10, 14); ctx.fill(); }
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
  placeholder: canvasTexture(512, 384, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#ffd1e3'); g.addColorStop(1, '#e8d4ff');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ff6fa3'; heartPath(ctx, w / 2, 70, 140); ctx.fill();
    ctx.fillStyle = '#6b3a55'; ctx.textAlign = 'center';
    ctx.font = 'bold 34px system-ui, sans-serif'; ctx.fillText('Здесь будет', w / 2, 270);
    ctx.fillText('наше фото', w / 2, 312);
    ctx.font = '20px system-ui, sans-serif'; ctx.fillText('нажмите 🖼️ вверху', w / 2, 350);
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
TEX.floor.wrapS = TEX.floor.wrapT = THREE.RepeatWrapping;
TEX.wall.wrapS = TEX.wall.wrapT = THREE.RepeatWrapping;

// ------------------------------------------------------------
//  Gallery hall
// ------------------------------------------------------------
const W = 12, H = 5, SPACING = 4.6;
let L = 30;
let hall = null;
let obstacles = [];   // AABBs {x0,x1,z0,z1}
let frames = [];      // {slot, mesh, back, glow, index}
let photos = [];      // current photo list (strings)
let floaters = [];    // decorative floating hearts
let buildId = 0;

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  plane: new THREE.PlaneGeometry(1, 1),
};

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry && !Object.values(GEO).includes(o.geometry)) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.map && m.map.userData.photo) m.map.dispose();
        m.dispose();
      }
    }
  });
}

function mesh(geo, mat, x = 0, y = 0, z = 0, parent = hall) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function heartGeometry(size = 1, depth = 0.2) {
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

function textTexture(text, { w = 1024, h = 256, font = 'bold 110px Georgia, serif', color = '#7a2c4b', bg = null } = {}) {
  return canvasTexture(w, h, (ctx) => {
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(255,255,255,0.7)';
    ctx.shadowBlur = 8;
    ctx.fillText(text, w / 2, h / 2 + 6);
  });
}

function buildHall(list) {
  const myBuild = ++buildId;
  if (hall) { scene.remove(hall); disposeTree(hall); }
  hall = new THREE.Group();
  scene.add(hall);
  obstacles = [];
  frames = [];
  floaters = [];

  const n = list.length;
  const perSide = Math.max(3, Math.ceil(n / 2));
  L = perSide * SPACING + 10;
  const zFront = L / 2, zBack = -L / 2;

  // floor
  const floorTex = TEX.floor.clone();
  floorTex.needsUpdate = true;
  floorTex.repeat.set(W / 1.6, L / 1.6);
  const floor = mesh(GEO.plane, new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.55, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2;
  floor.scale.set(W, L, 1);

  // carpet
  const carpet = mesh(GEO.plane, new THREE.MeshStandardMaterial({ color: 0xa3304d, roughness: 0.95 }), 0, 0.005, 0);
  carpet.rotation.x = -Math.PI / 2;
  carpet.scale.set(2.6, L - 3, 1);
  const carpetEdgeMat = new THREE.MeshStandardMaterial({ color: 0xe8c36a, roughness: 0.6, metalness: 0.4 });
  for (const sx of [-1, 1]) {
    const e = mesh(GEO.plane, carpetEdgeMat, sx * 1.25, 0.007, 0);
    e.rotation.x = -Math.PI / 2;
    e.scale.set(0.08, L - 3, 1);
  }

  // walls
  const wallTex = TEX.wall.clone();
  wallTex.needsUpdate = true;
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 });
  const wainMat = new THREE.MeshStandardMaterial({ color: 0x8c5a4a, roughness: 0.7 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xe8c36a, roughness: 0.4, metalness: 0.5 });
  const addWall = (x, z, ry, len) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    hall.add(g);
    const t = wallTex.clone(); t.needsUpdate = true; t.repeat.set(len / 2, H / 2);
    const wm = wallMat.clone(); wm.map = t;
    const p = mesh(GEO.plane, wm, 0, H / 2, 0, g); p.scale.set(len, H, 1);
    const wa = mesh(GEO.box, wainMat, 0, 0.5, 0.03, g); wa.scale.set(len, 1, 0.06);
    const tr = mesh(GEO.box, trimMat, 0, 1.02, 0.07, g); tr.scale.set(len, 0.06, 0.04);
    const cr = mesh(GEO.box, trimMat, 0, H - 0.1, 0.05, g); cr.scale.set(len, 0.2, 0.1);
  };
  addWall(-W / 2, 0, Math.PI / 2, L);
  addWall(W / 2, 0, -Math.PI / 2, L);
  addWall(0, zBack, 0, W);
  addWall(0, zFront, Math.PI, W);

  // ceiling + light panels
  const ceil = mesh(GEO.plane, new THREE.MeshStandardMaterial({ color: 0xfff6ee, roughness: 1 }), 0, H, 0);
  ceil.rotation.x = Math.PI / 2;
  ceil.scale.set(W, L, 1);
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xfff3dc });
  for (let z = zFront - 4; z > zBack + 2; z -= 6) {
    const p = mesh(GEO.box, panelMat, 0, H - 0.03, z);
    p.scale.set(3, 0.04, 1.2);
  }
  const warm = new THREE.PointLight(0xffd2a8, 30, 0, 2);
  warm.position.set(0, H - 0.6, zBack + 4);
  hall.add(warm);

  // entrance door
  const door = mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0x5b3426, roughness: 0.6 }), 0, 1.4, zFront - 0.04);
  door.scale.set(2.2, 2.8, 0.06);
  const doorTrim = mesh(GEO.box, trimMat, 0, 2.86, zFront - 0.07);
  doorTrim.scale.set(2.5, 0.14, 0.06);
  const signIn = mesh(GEO.plane, new THREE.MeshBasicMaterial({ map: textTexture('Добро пожаловать', { font: 'italic bold 84px Georgia, serif', color: '#7a2c4b' }), transparent: true }), 0, 3.5, zFront - 0.08);
  signIn.rotation.y = Math.PI;
  signIn.scale.set(4.4, 1.1, 1);

  // back wall: title + big heart
  const title = mesh(GEO.plane, new THREE.MeshBasicMaterial({ map: textTexture(CFG.title), transparent: true }), 0, 1.9, zBack + 0.08);
  title.scale.set(6.4, 1.6, 1);
  const bigHeart = mesh(heartGeometry(1.6, 0.25), new THREE.MeshStandardMaterial({ color: 0xff3f7f, emissive: 0xff2a6a, emissiveIntensity: 0.45, roughness: 0.3, metalness: 0.2 }), 0, 3.6, zBack + 0.35);
  floaters.push({ obj: bigHeart, base: 3.6, phase: 0, spin: false, pulse: true });

  // frames on side walls
  for (let i = 0; i < perSide * 2; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const slot = { x: side * (W / 2), z: zFront - 6 - row * SPACING, ry: side < 0 ? Math.PI / 2 : -Math.PI / 2, side };
    frames.push(makeFrame(slot, i < n ? i : -1, n === 0));
  }

  // benches in the middle (between frame pairs)
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a4a2e, roughness: 0.6 });
  const cushionMat = new THREE.MeshStandardMaterial({ color: 0xf2a7c3, roughness: 0.9 });
  for (let row = 0; row < perSide; row += 2) {
    const z = zFront - 6 - row * SPACING;
    const g = new THREE.Group(); g.position.set(0, 0, z); hall.add(g);
    const seat = mesh(GEO.box, woodMat, 0, 0.42, 0, g); seat.scale.set(0.6, 0.08, 2);
    const cush = mesh(GEO.box, cushionMat, 0, 0.5, 0, g); cush.scale.set(0.55, 0.08, 1.9);
    for (const dz of [-0.85, 0.85]) { const leg = mesh(GEO.box, woodMat, 0, 0.2, dz, g); leg.scale.set(0.5, 0.4, 0.08); }
    obstacles.push({ x0: -0.35, x1: 0.35, z0: z - 1.05, z1: z + 1.05 });
  }

  // potted plants in corners
  const potMat = new THREE.MeshStandardMaterial({ color: 0xd9d0c7, roughness: 0.5 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f8f4f, roughness: 0.8 });
  const leafGeo = new THREE.SphereGeometry(0.35, 12, 10);
  const potGeo = new THREE.CylinderGeometry(0.32, 0.24, 0.6, 16);
  for (const [px, pz] of [[-W / 2 + 0.7, zBack + 0.7], [W / 2 - 0.7, zBack + 0.7], [-W / 2 + 0.7, zFront - 0.7], [W / 2 - 0.7, zFront - 0.7]]) {
    mesh(potGeo, potMat, px, 0.3, pz);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const lf = mesh(leafGeo, leafMat, px + Math.cos(a) * 0.18, 0.95 + (k % 2) * 0.25, pz + Math.sin(a) * 0.18);
      lf.scale.setScalar(0.8 + (k % 3) * 0.15);
    }
    mesh(leafGeo, leafMat, px, 1.35, pz);
    obstacles.push({ x0: px - 0.4, x1: px + 0.4, z0: pz - 0.4, z1: pz + 0.4 });
  }

  // floating hearts near the ceiling
  const fhGeo = heartGeometry(0.35, 0.12);
  const fhMats = [0xff6fa3, 0xff9ec4, 0xd77bff].map((c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.35, roughness: 0.4 }));
  for (let z = zFront - 3, k = 0; z > zBack + 3; z -= 3.2, k++) {
    const x = (k % 2 ? 1 : -1) * (1.5 + (k % 3) * 0.8);
    const fh = mesh(fhGeo, fhMats[k % 3], x, 3.8, z);
    floaters.push({ obj: fh, base: 3.6 + (k % 3) * 0.3, phase: k * 1.7, spin: true });
  }

  // load photo textures
  frames.forEach((f) => {
    if (f.index < 0) return;
    loadPhotoTexture(list[f.index]).then((res) => {
      if (myBuild !== buildId) { if (res) res.tex.dispose(); return; }
      if (!res) { f.mesh.material.map = TEX.failed; f.mesh.material.needsUpdate = true; return; }
      res.tex.userData.photo = true;
      f.mesh.material.map = res.tex;
      f.mesh.material.needsUpdate = true;
      const aspect = res.w / res.h;
      let w = 2.6, h = w / aspect;
      if (h > 2.1) { h = 2.1; w = h * aspect; }
      f.setSize(w, h);
    });
  });
}

const frameMat = new THREE.MeshStandardMaterial({ color: 0xd8b25a, roughness: 0.35, metalness: 0.6 });
const lampMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.4, metalness: 0.7 });
function makeFrame(slot, index, placeholder) {
  const g = new THREE.Group();
  g.position.set(slot.x, 2.35, slot.z);
  g.rotation.y = slot.ry;
  hall.add(g);

  const glow = mesh(GEO.plane, new THREE.MeshBasicMaterial({ map: TEX.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 }), 0, 0.15, 0.012, g);
  const back = mesh(GEO.box, frameMat, 0, 0, 0.045, g);
  const mat = new THREE.MeshBasicMaterial({ map: index >= 0 ? TEX.loading : (placeholder ? TEX.placeholder : TEX.placeholder) });
  const pic = mesh(GEO.plane, mat, 0, 0, 0.096, g);
  pic.userData.photoIndex = index;
  const lampArm = mesh(GEO.box, lampMat, 0, 0, 0.2, g);
  const lampHead = mesh(GEO.box, new THREE.MeshBasicMaterial({ color: 0xfff1d0 }), 0, 0, 0.36, g);

  const setSize = (w, h) => {
    pic.scale.set(w, h, 1);
    back.scale.set(w + 0.2, h + 0.2, 0.09);
    glow.scale.set(w * 2.1, h * 2.1, 1);
    lampArm.position.y = h / 2 + 0.3; lampArm.scale.set(0.05, 0.05, 0.4);
    lampHead.position.y = h / 2 + 0.27; lampHead.scale.set(0.5, 0.05, 0.08);
  };
  setSize(2.2, 1.65);
  return { slot, mesh: pic, index, setSize };
}

function resolveCollision(p, r = 0.3) {
  p.x = clamp(p.x, -W / 2 + 0.35 + r * 0.3, W / 2 - 0.35 - r * 0.3);
  p.z = clamp(p.z, -L / 2 + 0.4, L / 2 - 0.4);
  for (const o of obstacles) {
    const cx = clamp(p.x, o.x0, o.x1), cz = clamp(p.z, o.z0, o.z1);
    const dx = p.x - cx, dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r; p.z = cz + (dz / d) * r;
      } else {
        // inside the box: push out along the shortest axis
        const opts = [[o.x0 - r - p.x, 0], [o.x1 + r - p.x, 0], [0, o.z0 - r - p.z], [0, o.z1 + r - p.z]];
        opts.sort((a, b) => Math.abs(a[0] + a[1]) - Math.abs(b[0] + b[1]));
        p.x += opts[0][0]; p.z += opts[0][1];
      }
    }
  }
}

// ------------------------------------------------------------
//  Characters
// ------------------------------------------------------------
const POSE_KEYS = ['hy', 'hrx', 'hry', 'hrz', 'sx', 'sy', 'sz', 'kx', 'ky', 'kz', 'alx', 'aly', 'alz', 'arx', 'ary', 'arz', 'ell', 'elr', 'ellz', 'elrz', 'llx', 'llz', 'lrx', 'lrz', 'knl', 'knr', 'spin', 'skirt', 'eyes'];
function basePose() {
  const p = {};
  for (const k of POSE_KEYS) p[k] = 0;
  p.skirt = 1; p.eyes = 1;
  p.alz = 0.1; p.arz = -0.1; p.ell = -0.15; p.elr = -0.15;
  return p;
}

const PALETTE = {
  girl: { skin: 0xf7d2bd, hair: 0x6b3a22, top: 0xff7eb0, bottom: 0xff7eb0, shoe: 0xffffff, accent: 0xff2d6f, scale: 0.94 },
  boy: { skin: 0xeec2a0, hair: 0x2b1d14, top: 0x4f8fe8, bottom: 0x2f3a56, shoe: 0x2a2a2a, accent: 0xffffff, scale: 1.0 },
};

function makeLabel(text) {
  const tex = canvasTexture(512, 128, (ctx, w, h) => {
    ctx.font = 'bold 54px system-ui, sans-serif';
    const tw = Math.min(w - 20, ctx.measureText(text).width + 50);
    ctx.fillStyle = 'rgba(30,16,30,0.6)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect((w - tw) / 2, 22, tw, 84, 42); else ctx.rect((w - tw) / 2, 22, tw, 84);
    ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, 66);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(0.72, 0.18, 1);
  s.renderOrder = 10;
  return s;
}

function makeCharacter(kind, name) {
  const C = PALETTE[kind];
  const girl = kind === 'girl';
  const M = (color, rough = 0.7) => new THREE.MeshStandardMaterial({ color, roughness: rough });
  const skin = M(C.skin, 0.6), hair = M(C.hair, 0.5), top = M(C.top), bottom = M(C.bottom), shoe = M(C.shoe, 0.4);
  const black = new THREE.MeshBasicMaterial({ color: 0x1a1010 });

  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(C.scale);
  root.add(body);

  const shadow = new THREE.Mesh(GEO.plane, new THREE.MeshBasicMaterial({ map: TEX.shadow, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01; shadow.scale.set(0.9, 0.9, 1);
  root.add(shadow);

  const hips = new THREE.Group(); hips.position.y = 0.92; body.add(hips);
  const spine = new THREE.Group(); spine.position.y = 0.04; hips.add(spine);

  const cap = (r, len, mat, parent, y) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 12), mat);
    m.position.y = y; parent.add(m); return m;
  };
  const sph = (r, mat, parent, x, y, z, ws = 16, hs = 12) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, ws, hs), mat);
    m.position.set(x, y, z); parent.add(m); return m;
  };

  // torso
  const torso = cap(girl ? 0.145 : 0.165, 0.3, top, spine, 0.27);
  torso.scale.set(1, 1, 0.78);
  if (girl) {
    // dress belt + bow
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 16), M(0xffffff));
    belt.position.y = 0.1; belt.scale.z = 0.8; spine.add(belt);
  } else {
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.05, 14), M(0xffffff));
    collar.position.y = 0.5; spine.add(collar);
  }
  // pelvis
  const pelvis = sph(0.155, girl ? top : bottom, hips, 0, 0.0, 0);
  pelvis.scale.set(1, 0.7, 0.8);

  // skirt
  let skirt = null;
  if (girl) {
    skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.36, 0.46, 20, 1, true), new THREE.MeshStandardMaterial({ color: C.top, roughness: 0.7, side: THREE.DoubleSide }));
    skirt.position.y = -0.18;
    hips.add(skirt);
    const hem = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.018, 6, 28), M(0xffffff));
    hem.rotation.x = Math.PI / 2; hem.position.y = -0.23; skirt.add(hem);
  }

  // neck & head
  const neck = cap(0.05, 0.06, skin, spine, 0.52);
  neck.scale.y = 1;
  const head = new THREE.Group(); head.position.y = 0.58; spine.add(head);
  const skull = sph(0.165, skin, head, 0, 0.15, 0, 24, 18);
  skull.scale.set(1, 1.04, 0.98);
  const eyes = new THREE.Group(); eyes.position.set(0, 0.16, 0.148); head.add(eyes);
  const eyeL = sph(0.022, black, eyes, 0.058, 0, 0, 10, 8);
  const eyeR = sph(0.022, black, eyes, -0.058, 0, 0, 10, 8);
  eyeL.scale.z = eyeR.scale.z = 0.5;
  const shine = new THREE.MeshBasicMaterial({ color: 0xffffff });
  sph(0.007, shine, eyeL, 0.008, 0.008, 0.012, 6, 4);
  sph(0.007, shine, eyeR, 0.008, 0.008, 0.012, 6, 4);
  const blushMat = new THREE.MeshBasicMaterial({ color: 0xff8fa8, transparent: true, opacity: 0.55 });
  const bl = sph(0.03, blushMat, head, 0.095, 0.105, 0.125, 10, 8); bl.scale.set(1, 0.6, 0.3);
  const br = sph(0.03, blushMat, head, -0.095, 0.105, 0.125, 10, 8); br.scale.set(1, 0.6, 0.3);
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.006, 6, 12, Math.PI), new THREE.MeshBasicMaterial({ color: girl ? 0xd6336c : 0x8a3b3b }));
  mouth.position.set(0, 0.095, 0.158); mouth.rotation.z = Math.PI; head.add(mouth);
  sph(0.03, skin, head, 0.16, 0.14, 0, 8, 6).scale.set(0.5, 1, 0.8); // ears
  sph(0.03, skin, head, -0.16, 0.14, 0, 8, 6).scale.set(0.5, 1, 0.8);

  // hair
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.178, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
  hairCap.position.set(0, 0.165, -0.008); hairCap.rotation.x = -0.25; head.add(hairCap);
  if (girl) {
    const back = cap(0.15, 0.3, hair, head, 0.0);
    back.position.set(0, 0.02, -0.07); back.scale.set(1.12, 1, 0.6);
    const bangs = sph(0.12, hair, head, 0, 0.27, 0.09, 16, 10); bangs.scale.set(1.3, 0.45, 0.6);
    // bow
    const bowMat = M(C.accent, 0.4);
    const bowL = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.09, 10), bowMat);
    bowL.position.set(0.065, 0.31, -0.03); bowL.rotation.z = Math.PI / 2; head.add(bowL);
    const bowR = bowL.clone(); bowR.position.x = 0.155; bowR.rotation.z = -Math.PI / 2; head.add(bowR);
    sph(0.022, bowMat, head, 0.11, 0.31, -0.03, 8, 6);
  } else {
    const fringe = sph(0.13, hair, head, 0.02, 0.27, 0.08, 16, 10); fringe.scale.set(1.25, 0.4, 0.7); fringe.rotation.z = -0.2;
  }

  // arms
  const makeArm = (side) => {
    const sh = new THREE.Group();
    sh.position.set(side * (girl ? 0.19 : 0.22), 0.45, 0);
    spine.add(sh);
    cap(girl ? 0.045 : 0.052, 0.2, girl ? skin : top, sh, -0.13);
    const el = new THREE.Group(); el.position.y = -0.27; sh.add(el);
    cap(girl ? 0.04 : 0.046, 0.18, skin, el, -0.12);
    sph(0.05, skin, el, 0, -0.26, 0, 10, 8);
    if (girl) { const puff = sph(0.07, top, sh, 0, -0.02, 0, 12, 10); puff.scale.set(1, 0.8, 1); }
    return { sh, el };
  };
  const armL = makeArm(1), armR = makeArm(-1);

  // legs
  const makeLeg = (side) => {
    const hp = new THREE.Group(); hp.position.set(side * 0.085, -0.02, 0); hips.add(hp);
    cap(girl ? 0.06 : 0.07, 0.3, girl ? skin : bottom, hp, -0.22);
    const kn = new THREE.Group(); kn.position.y = -0.44; hp.add(kn);
    cap(girl ? 0.052 : 0.06, 0.28, girl ? skin : bottom, kn, -0.2);
    const sh = new THREE.Mesh(GEO.box, shoe);
    sh.scale.set(0.11, 0.08, 0.22); sh.position.set(0, -0.44, 0.04); kn.add(sh);
    return { hp, kn };
  };
  const legL = makeLeg(1), legR = makeLeg(-1);

  const label = makeLabel((girl ? '👧 ' : '👦 ') + (name || (girl ? 'Девушка' : 'Парень')));
  label.position.y = girl ? 1.92 : 2.02;
  root.add(label);

  scene.add(root);
  return {
    kind, name, root, body, label, skirt, eyes,
    j: { hips, spine, head, shL: armL.sh, elL: armL.el, shR: armR.sh, elR: armR.el, hipL: legL.hp, knL: legL.kn, hipR: legR.hp, knR: legR.kn },
    cur: basePose(),
    anim: 'idle', animT: 0, phase: 0, stride: 0, speed: 0,
    yaw: Math.PI, blink: 2 + Math.random() * 3,
  };
}

function removeCharacter(ch) {
  if (!ch) return;
  scene.remove(ch.root);
  disposeTree(ch.root);
}

function setAnim(ch, anim) {
  if (!ch || ch.anim === anim) return;
  ch.anim = anim;
  ch.animT = 0;
}

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
    case 'dance1': { // party bounce, hands up
      const b = t * Math.PI * 4; // 120 bpm
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
    case 'dance2': { // disco: point up / down, step & twist, spin every few bars
      const b = t * Math.PI * 4;
      const side = Math.sin(b / 4); // -1..1 swaps every 2 beats
      const up = side > 0;
      P.alz = up ? 2.4 : 0.5; P.alx = up ? -0.4 : -0.3; P.ell = up ? -0.15 : -1.6; P.ellz = up ? 0 : -0.6;
      P.arz = up ? -0.5 : -2.4; P.arx = up ? -0.3 : -0.4; P.elr = up ? -1.6 : -0.15; P.elrz = up ? 0.6 : 0;
      P.hrz = Math.sin(b) * 0.12; P.sz = -P.hrz;
      P.hy = -Math.abs(Math.sin(b)) * 0.05;
      P.llz = Math.max(0, Math.sin(b)) * 0.3; P.lrz = -Math.max(0, -Math.sin(b)) * 0.3;
      P.knl = Math.max(0, -Math.sin(b)) * 0.4; P.knr = Math.max(0, Math.sin(b)) * 0.4;
      P.kz = side * 0.15; P.ky = side * 0.3;
      const cycle = t % 8; // spin on the last two seconds of each 8 s
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
      const b = t * Math.PI * 2 * (168 / 60 / 3); // one sway per 3/4 bar
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
  return P;
}

function animateCharacter(ch, dt) {
  ch.animT += dt;
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
  if (ch.skirt) ch.skirt.scale.set(c.skirt, 1, c.skirt);

  // blinking
  ch.blink -= dt;
  let blink = 1;
  if (ch.blink < 0.12) blink = 0.1;
  if (ch.blink < 0) ch.blink = 2 + Math.random() * 3.5;
  ch.eyes.scale.y = Math.max(0.08, c.eyes * blink);

  ch.root.rotation.y = ch.yaw;
}

// ------------------------------------------------------------
//  Particles
// ------------------------------------------------------------
const particles = [];
function spawnParticle(tex, x, y, z, opts = {}) {
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending });
  const s = new THREE.Sprite(mat);
  s.position.set(x, y, z);
  const size = opts.size || 0.25;
  s.scale.set(size, size, 1);
  scene.add(s);
  const life = opts.life || 2;
  particles.push({ s, life, max: life, vx: opts.vx || 0, vy: opts.vy ?? 0.6, vz: opts.vz || 0, size, wob: Math.random() * 6 });
}
function heartBurst(x, y, z, n = 12) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 0.5;
    spawnParticle(TEX.heart, x + Math.cos(a) * r, y + Math.random() * 0.3, z + Math.sin(a) * r, {
      vx: Math.cos(a) * 0.3, vz: Math.sin(a) * 0.3, vy: 0.6 + Math.random() * 0.6, size: 0.14 + Math.random() * 0.16, life: 1.6 + Math.random(),
    });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      scene.remove(p.s); p.s.material.dispose(); particles.splice(i, 1); continue;
    }
    p.wob += dt * 3;
    p.s.position.x += (p.vx + Math.sin(p.wob) * 0.15) * dt;
    p.s.position.y += p.vy * dt;
    p.s.position.z += p.vz * dt;
    const f = p.life / p.max;
    p.s.material.opacity = Math.min(1, f * 2);
    const sc = p.size * (0.6 + (1 - f) * 0.6);
    p.s.scale.set(sc, sc, 1);
  }
}

// ------------------------------------------------------------
//  Audio (tiny WebAudio synth)
// ------------------------------------------------------------
const audio = { ctx: null, master: null, on: store.get('lg_sound', true), mode: null, next: 0, step: 0, noise: null };
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
function ensureAudio() {
  try {
    if (!audio.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audio.ctx = new AC();
      audio.master = audio.ctx.createGain();
      audio.master.gain.value = 0.32;
      audio.master.connect(audio.ctx.destination);
      const len = audio.ctx.sampleRate * 0.5;
      audio.noise = audio.ctx.createBuffer(1, len, audio.ctx.sampleRate);
      const d = audio.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
  } catch { /* audio unavailable */ }
}
function tone(freq, t, dur, type = 'sine', vol = 0.2) {
  const { ctx, master } = audio;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}
function kick(t) {
  const { ctx, master } = audio;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
  g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  o.connect(g).connect(master); o.start(t); o.stop(t + 0.25);
}
function hat(t, vol = 0.12) {
  const { ctx, master } = audio;
  const s = ctx.createBufferSource(); s.buffer = audio.noise;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
  const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + 0.06);
}
const DANCE_BASS = [45, 45, 57, 45, 43, 43, 55, 43, 41, 41, 53, 41, 43, 43, 55, 47];
const DANCE_CHORDS = [[57, 60, 64], [55, 59, 62], [53, 57, 60], [55, 59, 62]];
const WALTZ = [ // [bass, chord, melody x3] per bar, key of C
  [48, [64, 67, 72], [76, 79, 84]], [48, [64, 67, 72], [83, 81, 79]], [43, [65, 67, 71], [77, 76, 74]], [43, [65, 67, 71], [74, 0, 0]],
  [43, [65, 67, 71], [71, 74, 79]], [43, [65, 67, 71], [77, 76, 74]], [48, [64, 67, 72], [72, 76, 79]], [48, [64, 67, 72], [84, 0, 0]],
  [41, [65, 69, 72], [81, 79, 77]], [41, [65, 69, 72], [76, 77, 81]], [48, [64, 67, 72], [79, 76, 72]], [45, [64, 69, 72], [76, 0, 0]],
  [50, [65, 69, 74], [77, 76, 74]], [43, [65, 67, 71], [74, 76, 77]], [48, [64, 67, 72], [76, 74, 72]], [48, [64, 67, 72], [72, 0, 0]],
];
function playStep(mode, step, t) {
  if (mode === 'dance') {
    if (step % 2 === 0) kick(t); else hat(t);
    if (step % 4 === 2) hat(t, 0.2);
    tone(midi(DANCE_BASS[step % 16]), t, 0.22, 'square', 0.06);
    if (step % 4 === 0) DANCE_CHORDS[Math.floor(step / 4) % 4].forEach((n) => tone(midi(n + 12), t, 0.18, 'sawtooth', 0.025));
  } else if (mode === 'waltz') {
    const bar = WALTZ[Math.floor(step / 3) % WALTZ.length];
    const beat = step % 3;
    if (beat === 0) tone(midi(bar[0]), t, 0.6, 'triangle', 0.22);
    else bar[1].forEach((n) => tone(midi(n), t, 0.28, 'triangle', 0.05));
    const m = bar[2][beat];
    if (m) tone(midi(m), t, beat === 0 && !bar[2][1] ? 1.0 : 0.4, 'sine', 0.11);
  }
}
const stepDur = (mode) => (mode === 'dance' ? 0.25 : 60 / 168);
setInterval(() => {
  if (!audio.ctx || !audio.mode || !audio.on) return;
  if (audio.next < audio.ctx.currentTime) audio.next = audio.ctx.currentTime + 0.05;
  while (audio.next < audio.ctx.currentTime + 0.15) {
    playStep(audio.mode, audio.step, audio.next);
    audio.next += stepDur(audio.mode);
    audio.step++;
  }
}, 30);
function setMusic(mode) {
  if (audio.mode === mode) return;
  audio.mode = mode;
  audio.step = 0;
  if (audio.ctx) audio.next = audio.ctx.currentTime + 0.05;
}
function chime() {
  if (!audio.ctx || !audio.on) return;
  const t = audio.ctx.currentTime + 0.02;
  [76, 79, 83, 88].forEach((n, i) => tone(midi(n), t + i * 0.09, 0.8, 'sine', 0.12));
}

// ------------------------------------------------------------
//  Game state
// ------------------------------------------------------------
const state = {
  started: false,
  mode: 'solo',          // solo | host | guest
  myKind: store.get('lg_kind', 'girl'),
  myName: store.get('lg_name', ''),
  me: null,
  partner: null,
  partnerIsNpc: false,
  joint: null,           // {type, cx, cz, a0, t, dur}
  cam: { yaw: 0, pitch: 0.32, dist: window.innerHeight > window.innerWidth ? 5.6 : 4.4 },
  lastSend: 0,
  nearFrame: null,
};

function spawnPoint(offsetX = 0) {
  return { x: offsetX, z: L / 2 - 2.5 };
}

function createMe() {
  removeCharacter(state.me);
  const old = state.me;
  state.me = makeCharacter(state.myKind, state.myName);
  const p = old ? { x: old.root.position.x, z: old.root.position.z } : spawnPoint(state.mode === 'guest' ? -0.7 : state.mode === 'host' ? 0.7 : state.myKind === 'girl' ? 0.6 : -0.6);
  state.me.root.position.set(p.x, 0, p.z);
  state.me.yaw = old ? old.yaw : Math.PI;
}

function createPartner(kind, name, npc) {
  removeCharacter(state.partner);
  state.partner = makeCharacter(kind, name);
  state.partnerIsNpc = npc;
  const mp = state.me.root.position;
  state.partner.root.position.set(mp.x + (kind === 'girl' ? 1 : -1), 0, mp.z + 0.3);
  state.partner.yaw = Math.PI;
  state.partner.net = { x: state.partner.root.position.x, z: state.partner.root.position.z, yaw: Math.PI, anim: 'idle', speed: 0 };
}

function removePartner() {
  removeCharacter(state.partner);
  state.partner = null;
  if (state.joint) endJoint();
}

// ------------------------------------------------------------
//  Emotes & joint actions
// ------------------------------------------------------------
const SOLO_EMOTES = ['dance1', 'dance2', 'wave'];
function doEmote(kind) {
  ensureAudio();
  const me = state.me;
  if (!me) return;
  if (kind === 'hearts') {
    const p = me.root.position;
    heartBurst(p.x, 1.6, p.z, 16);
    chime();
    net.send({ t: 'e', k: 'hearts' });
    return;
  }
  if (kind === 'waltz' || kind === 'kiss') { requestJoint(kind); return; }
  if (state.joint) cancelJoint(true);
  setAnim(me, me.anim === kind ? 'idle' : kind);
  if (kind === 'wave' && me.anim === 'wave') setTimeout(() => { if (me.anim === 'wave') setAnim(me, 'idle'); }, 2600);
  if (state.partnerIsNpc && state.partner && kind !== 'wave') {
    setTimeout(() => { if (state.partner && !state.joint) setAnim(state.partner, me.anim === 'idle' ? 'idle' : kind); }, 350);
  }
}

function requestJoint(type) {
  const { me, partner } = state;
  if (!partner) { toast('Партнёр ещё не пришёл 💌 Отправьте ему код комнаты'); return; }
  if (state.joint && state.joint.type === type) { cancelJoint(true); return; }
  const mp = me.root.position, pp = partner.root.position;
  const d = Math.hypot(mp.x - pp.x, mp.z - pp.z);
  if (d > 6) { toast('Подойдите ближе к партнёру 💕'); return; }
  const boy = me.kind === 'boy' ? me : partner;
  const girl = boy === me ? partner : me;
  const bp = boy.root.position, gp = girl.root.position;
  const c = { x: (bp.x + gp.x) / 2, z: (bp.z + gp.z) / 2 };
  resolveCollision(c, 1.0);
  const a0 = d > 0.05 ? Math.atan2(gp.x - bp.x, gp.z - bp.z) : 0;
  startJoint(type, c.x, c.z, a0, false);
}

function startJoint(type, cx, cz, a0, fromNet) {
  state.joint = { type, cx, cz, a0, t: 0, dur: type === 'kiss' ? 6 : 18 };
  setAnim(state.me, type);
  if (state.partner) setAnim(state.partner, type);
  if (!fromNet) net.send({ t: 'j', type, cx, cz, a0 });
  if (type === 'kiss') chime();
}

function endJoint() {
  state.joint = null;
  if (state.me) setAnim(state.me, 'idle');
  if (state.partner) setAnim(state.partner, 'idle');
}

function cancelJoint(broadcast) {
  if (!state.joint) return;
  endJoint();
  if (broadcast) net.send({ t: 'jc' });
}

function jointTarget(ch, j) {
  const isBoy = ch.kind === 'boy';
  let cx = j.cx, cz = j.cz, a = j.a0, d;
  if (j.type === 'kiss') {
    d = 0.56;
  } else {
    d = 0.5;
    a = j.a0 - j.t * 1.1;
    const R = 1.1, w = 0.35;
    cx += R * Math.sin(j.t * w);
    cz += R * (1 - Math.cos(j.t * w)) * (cz > 0 ? -1 : 1);
    const c = { x: cx, z: cz };
    resolveCollision(c, 0.9);
    cx = c.x; cz = c.z;
  }
  const ux = Math.sin(a), uz = Math.cos(a);
  const s = isBoy ? -0.5 : 0.5;
  return { x: cx + ux * d * s, z: cz + uz * d * s, yaw: isBoy ? a : a + Math.PI };
}

function updateJoint(dt) {
  const j = state.joint;
  if (!j) return;
  j.t += dt;
  const rate = j.t < 1 ? 5 : 12;
  for (const ch of [state.me, state.partner]) {
    if (!ch) continue;
    const tg = jointTarget(ch, j);
    const p = ch.root.position;
    p.x = damp(p.x, tg.x, rate, dt);
    p.z = damp(p.z, tg.z, rate, dt);
    ch.yaw = angDamp(ch.yaw, tg.yaw, rate, dt);
  }
  // particles
  const mp = state.me.root.position, pp = state.partner ? state.partner.root.position : mp;
  const mx = (mp.x + pp.x) / 2, mz = (mp.z + pp.z) / 2;
  if (j.type === 'kiss' && j.t > 0.9 && Math.random() < dt * 9) {
    spawnParticle(TEX.heart, mx + (Math.random() - 0.5) * 0.3, 1.65, mz + (Math.random() - 0.5) * 0.3, { vy: 0.5 + Math.random() * 0.4, size: 0.12 + Math.random() * 0.14, life: 2 });
  }
  if (j.type === 'waltz' && Math.random() < dt * 14) {
    const a = Math.random() * Math.PI * 2, r = 0.6 + Math.random() * 0.6;
    spawnParticle(TEX.spark, mx + Math.cos(a) * r, 0.2 + Math.random() * 1.6, mz + Math.sin(a) * r, { vy: 0.25, size: 0.12, life: 1.4, additive: true });
  }
  if (j.t >= j.dur) endJoint();
}

// ------------------------------------------------------------
//  Input
// ------------------------------------------------------------
const keys = new Set();
const joy = { id: null, x: 0, y: 0 };
const drag = { id: null, x: 0, y: 0, sx: 0, sy: 0, t: 0, moved: 0 };
const touches = new Map();
let pinchDist = 0;

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (!state.started) return;
  if (!$('#viewer').hidden) {
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
    return;
  }
  keys.add(e.code);
  const map = { Digit1: 'dance1', Digit2: 'dance2', Digit3: 'waltz', Digit4: 'kiss', Digit5: 'wave', Digit6: 'hearts' };
  if (map[e.code] && !e.repeat) doEmote(map[e.code]);
  if (e.code === 'KeyE' && state.nearFrame) openViewer(state.nearFrame.index);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function getInput() {
  let x = 0, y = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  let run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  if (joy.id !== null) {
    x = joy.x; y = -joy.y;
    run = Math.hypot(joy.x, joy.y) > 0.92;
  }
  return { x, y, run };
}

// joystick
const joyEl = $('#joystick'), stickEl = $('#stick');
joyEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  ensureAudio();
  joy.id = e.pointerId;
  try { joyEl.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  moveJoy(e);
});
joyEl.addEventListener('pointermove', (e) => { if (e.pointerId === joy.id) moveJoy(e); });
const endJoy = (e) => {
  if (e.pointerId !== joy.id) return;
  joy.id = null; joy.x = joy.y = 0;
  stickEl.style.transform = '';
};
joyEl.addEventListener('pointerup', endJoy);
joyEl.addEventListener('pointercancel', endJoy);
function moveJoy(e) {
  const r = joyEl.getBoundingClientRect();
  const R = r.width / 2 - 10;
  let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy);
  if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
  joy.x = dx / R; joy.y = dy / R;
  stickEl.style.transform = `translate(${dx}px, ${dy}px)`;
}

// camera drag / tap on photo
const cv = renderer.domElement;
cv.addEventListener('pointerdown', (e) => {
  ensureAudio();
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    drag.id = null;
    return;
  }
  if (drag.id !== null) return;
  drag.id = e.pointerId;
  drag.x = drag.sx = e.clientX; drag.y = drag.sy = e.clientY;
  drag.t = performance.now(); drag.moved = 0;
  try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
});
cv.addEventListener('pointermove', (e) => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) state.cam.dist = clamp(state.cam.dist * (pinchDist / d), 1.8, 9);
    pinchDist = d;
    return;
  }
  if (e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  const sens = isTouch ? 0.008 : 0.005;
  state.cam.yaw -= dx * sens;
  state.cam.pitch = clamp(state.cam.pitch + dy * sens, -0.1, 1.2);
});
const endDrag = (e) => {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinchDist = 0;
  if (e.pointerId !== drag.id) return;
  drag.id = null;
  if (e.type === 'pointerup' && drag.moved < 10 && performance.now() - drag.t < 450) tapAt(e.clientX, e.clientY);
};
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.cam.dist = clamp(state.cam.dist * (1 + Math.sign(e.deltaY) * 0.1), 1.8, 9);
}, { passive: false });

const raycaster = new THREE.Raycaster();
function tapAt(x, y) {
  if (!state.started) return;
  const v = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(v, camera);
  const hits = raycaster.intersectObjects(frames.map((f) => f.mesh), false);
  if (!hits.length || hits[0].distance > 14) return;
  const idx = hits[0].object.userData.photoIndex;
  if (idx >= 0) openViewer(idx);
  else openPhotosPanel();
}

// ------------------------------------------------------------
//  Update loop
// ------------------------------------------------------------
const tmpV = new THREE.Vector3();
const camTarget = new THREE.Vector3();
let camInit = false;

function updateMe(dt) {
  const me = state.me;
  const inp = getInput();
  const mag = Math.hypot(inp.x, inp.y);
  if (state.joint) {
    if (mag > 0.25) cancelJoint(true);
    else return;
  }
  if (mag > 0.1) {
    const yaw = state.cam.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let mx = fx * inp.y + rx * inp.x, mz = fz * inp.y + rz * inp.x;
    const ml = Math.hypot(mx, mz);
    mx /= ml; mz /= ml;
    const speed = (inp.run ? 5.2 : 2.6) * Math.min(1, mag);
    const p = me.root.position;
    p.x += mx * speed * dt;
    p.z += mz * speed * dt;
    resolveCollision(p);
    me.yaw = angDamp(me.yaw, Math.atan2(mx, mz), 12, dt);
    me.speed = speed;
    setAnim(me, 'walk');
  } else {
    me.speed = 0;
    if (me.anim === 'walk') setAnim(me, 'idle');
  }
  advanceStride(me, dt);
}

function advanceStride(ch, dt) {
  const target = ch.speed > 0.1 ? clamp(ch.speed / 2.6, 0.4, 1.35) : 0;
  ch.stride = damp(ch.stride, target, 10, dt);
  ch.phase += ch.speed * dt * (ch.speed > 3.5 ? 2.4 : 3.0);
}

function updatePartner(dt) {
  const pt = state.partner;
  if (!pt) return;
  if (state.joint) { pt.speed = 0; advanceStride(pt, dt); return; }
  if (state.partnerIsNpc) {
    // follow the player loosely
    const mp = state.me.root.position, p = pt.root.position;
    const side = pt.kind === 'girl' ? 1 : -1;
    const tx = mp.x + Math.cos(state.me.yaw) * 0.9 * side - Math.sin(state.me.yaw) * 0.4;
    const tz = mp.z - Math.sin(state.me.yaw) * 0.9 * side - Math.cos(state.me.yaw) * 0.4;
    const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    if (d > 0.6) {
      const speed = clamp(d * 1.6, 1.2, 5.2);
      p.x += (dx / d) * speed * dt; p.z += (dz / d) * speed * dt;
      resolveCollision(p);
      pt.yaw = angDamp(pt.yaw, Math.atan2(dx, dz), 8, dt);
      pt.speed = speed;
      setAnim(pt, 'walk');
    } else {
      pt.speed = 0;
      if (pt.anim === 'walk') { setAnim(pt, 'idle'); }
      if (pt.anim === 'idle') pt.yaw = angDamp(pt.yaw, state.me.yaw, 3, dt);
    }
  } else {
    const n = pt.net, p = pt.root.position;
    p.x = damp(p.x, n.x, 12, dt);
    p.z = damp(p.z, n.z, 12, dt);
    pt.yaw = angDamp(pt.yaw, n.yaw, 12, dt);
    pt.speed = n.speed;
    setAnim(pt, n.anim);
  }
  advanceStride(pt, dt);
}

function updateCamera(dt) {
  const me = state.me;
  const p = me.root.position;
  let tx = p.x, tz = p.z;
  if (state.joint && state.partner) {
    tx = (p.x + state.partner.root.position.x) / 2;
    tz = (p.z + state.partner.root.position.z) / 2;
  }
  const want = tmpV.set(tx, 1.35, tz);
  if (!camInit) { camTarget.copy(want); camInit = true; }
  camTarget.x = damp(camTarget.x, want.x, 10, dt);
  camTarget.y = damp(camTarget.y, want.y, 10, dt);
  camTarget.z = damp(camTarget.z, want.z, 10, dt);
  const { yaw, pitch, dist } = state.cam;
  let cx = camTarget.x + Math.sin(yaw) * Math.cos(pitch) * dist;
  let cy = camTarget.y + Math.sin(pitch) * dist;
  let cz = camTarget.z + Math.cos(yaw) * Math.cos(pitch) * dist;
  cx = clamp(cx, -W / 2 + 0.25, W / 2 - 0.25);
  cz = clamp(cz, -L / 2 + 0.25, L / 2 - 0.25);
  cy = clamp(cy, 0.3, H - 0.25);
  camera.position.set(cx, cy, cz);
  camera.lookAt(camTarget);
}

function updateNearFrame() {
  const p = state.me.root.position;
  let best = null, bd = 3.4;
  for (const f of frames) {
    const d = Math.hypot(p.x - f.slot.x, p.z - f.slot.z);
    if (d < bd) { bd = d; best = f; }
  }
  if (best && best.index < 0) best = null;
  if (best !== state.nearFrame) {
    state.nearFrame = best;
    $('#btn-view').hidden = !best;
  }
}

function updateEmoteButtons() {
  const a = state.me ? state.me.anim : '';
  document.querySelectorAll('#emotes button').forEach((b) => b.classList.toggle('active', b.dataset.emote === a));
}

let last = now();
function frame() {
  requestAnimationFrame(frame);
  const t = now();
  const dt = Math.min(0.05, t - last);
  last = t;

  for (const f of floaters) {
    f.obj.position.y = f.base + Math.sin(t * 0.8 + f.phase) * 0.15;
    if (f.spin) f.obj.rotation.y = t * 0.6 + f.phase;
    if (f.pulse) { const s = 1 + Math.max(0, Math.sin(t * 4)) * 0.06; f.obj.scale.setScalar(s); }
  }

  if (state.started && state.me) {
    updateMe(dt);
    updatePartner(dt);
    updateJoint(dt);
    animateCharacter(state.me, dt);
    if (state.partner) animateCharacter(state.partner, dt);
    updateCamera(dt);
    updateNearFrame();
    updateEmoteButtons();

    const a = state.me.anim;
    setMusic(a === 'dance1' || a === 'dance2' ? 'dance' : a === 'waltz' ? 'waltz' : null);

    if (net.connected && t - state.lastSend > 1 / 15) {
      state.lastSend = t;
      const p = state.me.root.position;
      net.send({ t: 's', k: state.me.kind, n: state.myName, x: +p.x.toFixed(3), z: +p.z.toFixed(3), r: +state.me.yaw.toFixed(3), a: state.me.anim, v: +state.me.speed.toFixed(2) }, true);
    }
  } else {
    // menu backdrop: slow orbit
    const a = t * 0.08;
    camera.position.set(Math.sin(a) * 4, 2.6, Math.cos(a) * 6 + 2);
    camera.lookAt(0, 2, -L / 2);
  }
  updateParticles(dt);
  renderer.render(scene, camera);
}

// ------------------------------------------------------------
//  Networking (PeerJS / WebRTC)
// ------------------------------------------------------------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

const net = {
  peer: null,
  conn: null,
  connected: false,
  lastRecv: 0,
  code: '',
  send(msg) {
    if (!this.connected || !this.conn || !this.conn.open) return;
    try { this.conn.send(msg); } catch { /* channel closing */ }
  },
};

function peerOptions() {
  const o = { debug: 1 };
  if (CFG.peerServer) Object.assign(o, CFG.peerServer);
  return o;
}

function hostRoom(onReady, onError, attempt = 0) {
  if (typeof Peer === 'undefined') { onError('Не загрузилась библиотека для игры вдвоём (PeerJS)'); return; }
  const code = randomCode();
  const peer = new Peer(CFG.roomPrefix + code, peerOptions());
  net.peer = peer;
  peer.on('open', () => { net.code = code; onReady(code); });
  peer.on('connection', (c) => {
    if (net.conn && net.conn.open) { c.on('open', () => { c.send({ t: 'full' }); setTimeout(() => c.close(), 500); }); return; }
    setupConn(c);
  });
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id' && attempt < 3) { peer.destroy(); hostRoom(onReady, onError, attempt + 1); return; }
    if (state.started) toast('Связь: ' + (e.type || e.message));
    else onError(netErrorText(e));
  });
}

function joinRoom(code, onError) {
  if (typeof Peer === 'undefined') { onError('Не загрузилась библиотека для игры вдвоём (PeerJS)'); return; }
  const peer = new Peer(peerOptions());
  net.peer = peer;
  net.code = code;
  let opened = false;
  peer.on('open', () => {
    const c = peer.connect(CFG.roomPrefix + code, { reliable: true });
    setupConn(c, () => { opened = true; });
    setTimeout(() => { if (!opened) onError('Комната не отвечает. Проверьте код 🙏'); }, 12000);
  });
  peer.on('error', (e) => {
    if (e.type === 'peer-unavailable') onError('Комната «' + code + '» не найдена. Проверьте код 🙏');
    else if (state.started) toast('Связь: ' + (e.type || e.message));
    else onError(netErrorText(e));
  });
}

function netErrorText(e) {
  if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') return 'Нет связи с сервером. Проверьте интернет.';
  if (e.type === 'browser-incompatible') return 'Браузер не поддерживает WebRTC 😢';
  return 'Ошибка связи: ' + (e.type || e.message);
}

function setupConn(c, onOpen) {
  c.on('open', () => {
    if (net.connected && net.conn !== c) { c.close(); return; }
    net.conn = c;
    net.connected = true;
    net.lastRecv = now();
    if (onOpen) onOpen();
    c.send({ t: 'hello', k: state.myKind, n: state.myName, host: state.mode === 'host' });
    if (state.mode === 'host') c.send({ t: 'p', list: photos });
    updateRoomInfo();
  });
  c.on('data', (m) => { net.lastRecv = now(); onNetData(m); });
  c.on('close', () => dropConn(c));
  c.on('error', () => {});
}

function dropConn(c) {
  if (!c || net.conn !== c) return;
  net.conn = null;
  net.connected = false;
  try { c.close(); } catch { /* already closed */ }
  if (!state.started) return;
  removePartner();
  toast(state.mode === 'guest' ? 'Связь потеряна… переподключаемся 🔄' : 'Партнёр вышел 💔 Ждём, когда вернётся', 3500);
  updateRoomInfo();
  if (state.mode === 'guest') reconnectGuest(0);
}

function reconnectGuest(attempt) {
  if (net.connected || attempt > 15 || !net.peer || net.peer.destroyed) return;
  if (net.peer.disconnected) net.peer.reconnect();
  setupConn(net.peer.connect(CFG.roomPrefix + net.code, { reliable: true }));
  setTimeout(() => reconnectGuest(attempt + 1), 4000);
}

// keep-alive that also runs (throttled) in background tabs
setInterval(() => {
  if (!net.connected) return;
  net.send({ t: 'hb' });
  if (now() - net.lastRecv > 20) dropConn(net.conn);
}, 1000);
window.addEventListener('pagehide', () => { if (net.conn) try { net.conn.close(); } catch { /* ignore */ } });

function onNetData(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'hello': {
      let kind = m.k === 'boy' ? 'boy' : 'girl';
      if (kind === state.myKind) {
        if (state.mode === 'guest') {
          // the host keeps their character; the guest takes the other one
          state.myKind = opposite(state.myKind);
          if (state.started) { createMe(); toast('Этот персонаж уже занят — вы играете за ' + (state.myKind === 'girl' ? 'девушку 👧' : 'парня 👦')); }
          net.send({ t: 'hello', k: state.myKind, n: state.myName });
        } else {
          kind = opposite(state.myKind);
        }
      }
      if (state.started) {
        createPartner(kind, String(m.n || '').slice(0, 16), false);
        toast((kind === 'girl' ? '👧 ' : '👦 ') + (m.n || 'Партнёр') + ' пришёл в галерею 💕');
      } else {
        state.pendingPartner = { kind, name: String(m.n || '').slice(0, 16) };
      }
      break;
    }
    case 's': {
      const pt = state.partner;
      if (!pt) break;
      const kind = m.k === state.myKind ? opposite(state.myKind) : m.k;
      if (kind !== pt.kind) { createPartner(kind, m.n, false); break; }
      if (typeof m.x === 'number') {
        pt.net.x = m.x; pt.net.z = m.z; pt.net.yaw = m.r; pt.net.speed = m.v || 0;
        if (!state.joint) pt.net.anim = ['idle', 'walk', 'dance1', 'dance2', 'wave'].includes(m.a) ? m.a : 'idle';
      }
      break;
    }
    case 'j':
      if (state.partner && (m.type === 'kiss' || m.type === 'waltz')) startJoint(m.type, m.cx, m.cz, m.a0, true);
      break;
    case 'jc':
      if (state.joint) endJoint();
      if (state.partner) state.partner.net.anim = 'idle';
      break;
    case 'e':
      if (m.k === 'hearts' && state.partner) {
        const p = state.partner.root.position;
        heartBurst(p.x, 1.6, p.z, 16);
        chime();
      }
      break;
    case 'p':
      if (Array.isArray(m.list)) setPhotos(m.list.filter((x) => typeof x === 'string'), false);
      break;
    case 'full':
      toast('В комнате уже двое 🙈');
      break;
  }
}

// ------------------------------------------------------------
//  Photos
// ------------------------------------------------------------
function setPhotos(list, broadcast) {
  photos = list.slice(0, 120);
  store.set('lg_photos', photos.filter((p) => !p.startsWith('data:')));
  buildHall(photos);
  if (state.me) resolveCollision(state.me.root.position);
  if (state.partner) resolveCollision(state.partner.root.position);
  if (broadcast) net.send({ t: 'p', list: photos });
}

let uploads = [];
function openPhotosPanel() {
  uploads = photos.filter((p) => p.startsWith('data:'));
  $('#photo-links').value = photos.filter((p) => !p.startsWith('data:')).join('\n');
  updateUploadCount();
  $('#photos-panel').hidden = false;
}
function updateUploadCount() {
  $('#upload-count').textContent = uploads.length ? `Загружено с устройства: ${uploads.length}` : '';
  $('#clear-uploads').hidden = !uploads.length;
}
function downscale(file, max = 1280) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
$('#photo-files').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  for (const f of files) {
    const d = await downscale(f);
    if (d) uploads.push(d);
  }
  e.target.value = '';
  updateUploadCount();
});
$('#clear-uploads').addEventListener('click', () => { uploads = []; updateUploadCount(); });
$('#photos-save').addEventListener('click', async () => {
  const btn = $('#photos-save');
  btn.disabled = true;
  const lines = $('#photo-links').value.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
  const links = await expandFolders(lines);
  btn.disabled = false;
  setPhotos([...links, ...uploads], true);
  $('#photos-panel').hidden = true;
  toast(`В галерее ${photos.length} фото ✨`);
});

let viewIndex = 0;
function openViewer(i) {
  if (!photos.length) return;
  viewIndex = (i + photos.length) % photos.length;
  const img = $('#viewer-img');
  img.src = viewSource(photos[viewIndex]);
  $('#viewer-caption').textContent = `${viewIndex + 1} / ${photos.length}`;
  $('#viewer').hidden = false;
  keys.clear();
}
function stepViewer(d) { openViewer(viewIndex + d); }
function closeViewer() { $('#viewer').hidden = true; $('#viewer-img').src = ''; }
$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer-prev').addEventListener('click', () => stepViewer(-1));
$('#viewer-next').addEventListener('click', () => stepViewer(1));
$('#viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(); });
$('#btn-view').addEventListener('click', () => { if (state.nearFrame) openViewer(state.nearFrame.index); });

// ------------------------------------------------------------
//  UI wiring
// ------------------------------------------------------------
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { b.closest('.overlay').hidden = true; }));
document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o && o.id !== 'viewer') o.hidden = true; }));
$('#btn-photos').addEventListener('click', openPhotosPanel);
$('#btn-help').addEventListener('click', () => { $('#help').hidden = false; });
const soundBtn = $('#btn-sound');
const renderSound = () => { soundBtn.textContent = audio.on ? '🔊' : '🔇'; };
renderSound();
soundBtn.addEventListener('click', () => {
  audio.on = !audio.on;
  store.set('lg_sound', audio.on);
  renderSound();
  ensureAudio();
});
document.querySelectorAll('#emotes button').forEach((b) => {
  b.addEventListener('click', () => doEmote(b.dataset.emote));
});

// menu
const charBtns = document.querySelectorAll('.char-btn');
const renderChar = () => charBtns.forEach((b) => b.classList.toggle('selected', b.dataset.kind === state.myKind));
renderChar();
charBtns.forEach((b) => b.addEventListener('click', () => { state.myKind = b.dataset.kind; store.set('lg_kind', state.myKind); renderChar(); }));
const nameEl = $('#name');
nameEl.value = state.myName;
const codeEl = $('#code');
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) codeEl.value = urlRoom.toUpperCase();

function menuStatus(text, error = false) {
  const el = $('#menu-status');
  el.textContent = text;
  el.classList.toggle('error', error);
}
function setMenuBusy(b) { ['#btn-host', '#btn-join', '#btn-solo'].forEach((s) => { $(s).disabled = b; }); }
function readName() {
  state.myName = nameEl.value.trim().slice(0, 16);
  store.set('lg_name', state.myName);
}

function inviteLink() {
  return location.origin + location.pathname + '?room=' + net.code;
}
function updateRoomInfo() {
  const el = $('#room-info');
  if (state.mode === 'solo') {
    el.innerHTML = '🚶 Прогулка в одиночку';
    return;
  }
  const on = net.connected;
  el.innerHTML = `<span class="dot ${on ? 'on' : ''}"></span>${on ? 'Вы вдвоём 💕' : 'Ждём партнёра…'}<br>Код комнаты: <b>${net.code}</b><br>` + (on ? '' : '<button id="copy-link">📋 Скопировать приглашение</button>');
  const cb = $('#copy-link');
  if (cb) cb.addEventListener('click', async () => {
    const text = `Заходи ко мне в нашу галерею 💕 Код: ${net.code}\n${inviteLink()}`;
    try {
      if (navigator.share && isTouch) await navigator.share({ title: 'Наша галерея', text });
      else { await navigator.clipboard.writeText(text); toast('Ссылка скопирована 📋'); }
    } catch { prompt('Скопируйте ссылку:', inviteLink()); }
  });
}

function startGame(mode) {
  state.mode = mode;
  state.started = true;
  $('#menu').hidden = true;
  $('#hud').hidden = false;
  createMe();
  state.cam.yaw = 0;
  camInit = false;
  if (mode === 'solo') createPartner(opposite(state.myKind), '', true);
  if (state.pendingPartner) {
    createPartner(state.pendingPartner.kind, state.pendingPartner.name, false);
    toast((state.pendingPartner.kind === 'girl' ? '👧 ' : '👦 ') + (state.pendingPartner.name || 'Партнёр') + ' уже в галерее 💕');
    state.pendingPartner = null;
  }
  updateRoomInfo();
  if (!store.get('lg_seen_help', false)) { $('#help').hidden = false; store.set('lg_seen_help', true); }
}

$('#btn-solo').addEventListener('click', () => { ensureAudio(); readName(); startGame('solo'); });
$('#btn-host').addEventListener('click', () => {
  ensureAudio(); readName();
  setMenuBusy(true);
  menuStatus('Создаём комнату…');
  hostRoom((code) => {
    setMenuBusy(false);
    menuStatus('');
    startGame('host');
    toast('Комната ' + code + ' создана! Отправьте код партнёру 💌', 4000);
  }, (err) => { setMenuBusy(false); menuStatus(err, true); });
});
$('#btn-join').addEventListener('click', () => {
  ensureAudio(); readName();
  const code = codeEl.value.trim().toUpperCase();
  if (code.length < 4) { menuStatus('Введите код комнаты', true); return; }
  setMenuBusy(true);
  menuStatus('Подключаемся…');
  state.mode = 'guest';
  let done = false;
  joinRoom(code, (err) => {
    if (done) return;
    done = true;
    setMenuBusy(false);
    menuStatus(err, true);
    if (net.peer) net.peer.destroy();
  });
  const wait = setInterval(() => {
    if (done) { clearInterval(wait); return; }
    if (net.connected) {
      done = true;
      clearInterval(wait);
      setMenuBusy(false);
      menuStatus('');
      startGame('guest');
    }
  }, 100);
});
codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });

// ------------------------------------------------------------
//  Boot
// ------------------------------------------------------------
const saved = store.get('lg_photos', null);
photos = (saved && saved.length ? saved : CFG.photos || []).filter((p) => typeof p === 'string' && p.trim());
buildHall(photos);
requestAnimationFrame(frame);

// for debugging in the console
window.__game = { state, net, setPhotos, doEmote, startGame };
