import * as THREE from './vendor/three.module.min.js';
import {
  $, clamp, damp, angDamp, wrapAngle, opposite, now, fmt, store, toast, TEX,
  driveFileId, driveFolderId, viewSource,
} from './util.js';
import { ITEMS, SHOP_TABS, START_COINS, newItem, itemLabel, gripOf } from './items.js';
import { makeCharacter, removeCharacter, setAnim, setOutfit, setHeld, animateCharacter } from './characters.js';
import { buildWorld, resolveCollision, whereIs, cinemaSeatPos, botSeats, spawnBots, CINEMA } from './world.js';
import { audio, ensureAudio, setMusic, chime, coin, crunch, slurp, beep } from './audio.js';

// ============================================================
//  Наша галерея — 3D прогулка вдвоём
// ============================================================

const CFG = Object.assign(
  { title: 'Наша история 💕', photos: [], driveFolder: '', driveListUrl: '', driveApiKey: '', movies: [], peerServer: null, roomPrefix: 'nasha-galereya-v1-' },
  window.GALLERY_CONFIG || {}
);
const MOVIES = (CFG.movies || []).filter((m) => m && m.title);
while (MOVIES.length < 3) MOVIES.push({ title: `Фильм ${MOVIES.length + 1}`, url: '' });
const SESSIONS = ['18:30', '20:00', '21:45', '23:10'];

const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');

// ------------------------------------------------------------
//  Renderer / scene
// ------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.id = 'c';
document.body.prepend(renderer.domElement);
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a1d26);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 220);

const hemi = new THREE.HemisphereLight(0xfff1e6, 0x7a5a50, 1.6);
const sun = new THREE.DirectionalLight(0xfff0dd, 1.3);
sun.position.set(3, 10, 4);
const fill = new THREE.DirectionalLight(0xffd6e8, 0.5);
fill.position.set(-4, 6, -6);
scene.add(hemi, sun, fill);
const LIGHT_BASE = { hemi: 1.6, sun: 1.3, fill: 0.5 };
let lightLevel = 1;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------
//  State
// ------------------------------------------------------------
const state = {
  started: false,
  mode: 'solo',              // solo | host | guest
  myKind: store.get('lg_kind', 'girl'),
  myName: store.get('lg_name', ''),
  me: null,
  partner: null,
  partnerIsNpc: false,
  joint: null,
  sitting: null,             // {kind:'seat'} | {kind:'cinema', film, row, seat}
  movie: null,               // {film, phase:'wait'|'count'|'play', t}
  cinemaFilm: null,          // film whose audience is in the hall
  takenSeats: {},            // film -> Set('row-seat') bought by players
  cam: { yaw: 0, pitch: 0.32, dist: window.innerHeight > window.innerWidth ? 5.6 : 4.4 },
  lastSend: 0,
  wallet: null,
  openBag: null,
  localFilms: {},
};
let world = null;
let photos = [];

function rebuildWorld() {
  if (world) world.dispose();
  world = buildWorld({ scene, photos, maxAniso, title: CFG.title });
  if (state.cinemaFilm != null) refreshBots();
  for (const ch of [state.me, state.partner]) if (ch && !state.sitting) resolveCollision(world, ch.root.position);
}

// ------------------------------------------------------------
//  Wallet / inventory (saved per character)
// ------------------------------------------------------------
function loadWallet(kind) {
  const w = store.get('lg_wallet_' + kind, null);
  if (w && typeof w.coins === 'number' && Array.isArray(w.items)) {
    w.items = w.items.filter((i) => i && ITEMS[i.type]);
    return w;
  }
  return { coins: START_COINS[kind], items: [], outfit: null, held: null };
}
function saveWallet() { if (state.wallet) store.set('lg_wallet_' + state.myKind, state.wallet); }
const findItem = (uid) => state.wallet.items.find((i) => i.uid === uid);
function allItems() {
  const out = [];
  for (const it of state.wallet.items) { out.push(it); if (it.items) out.push(...it.items); }
  return out;
}
const myTicket = () => allItems().find((i) => i.type === 'ticket');
function applyMyLook() {
  const w = state.wallet, me = state.me;
  if (!me) return;
  const worn = w.outfit && findItem(w.outfit);
  if (!worn) w.outfit = null;
  setOutfit(me, worn ? worn.type : null);
  const held = w.held && findItem(w.held);
  if (!held) w.held = null;
  setHeld(me, held ? held.type : null);
  renderCoins();
}
function renderCoins() {
  const c = '🪙 ' + fmt(state.wallet ? state.wallet.coins : 0);
  for (const id of ['#coins', '#shop-coins', '#kassa-coins', '#inv-coins']) $(id).textContent = c;
}
function removeItem(uid) {
  const w = state.wallet;
  w.items = w.items.filter((i) => i.uid !== uid);
  if (w.held === uid) w.held = null;
  if (w.outfit === uid) w.outfit = null;
}
function addItem(it, autoHold = true) {
  state.wallet.items.push(it);
  if (autoHold && !state.wallet.held && gripOf(it.type) && it.type !== 'ticket') state.wallet.held = it.uid;
  saveWallet();
  applyMyLook();
}
function buy(type, extra = {}) {
  const d = ITEMS[type];
  if (state.wallet.coins < d.price) {
    toast(state.myKind === 'girl' ? 'Не хватает монет 😢 Попросите парня купить 😉' : 'Не хватает монет 😢');
    return null;
  }
  state.wallet.coins -= d.price;
  const it = newItem(type, extra);
  addItem(it, d.cat !== 'clothes');
  coin();
  return it;
}

// ------------------------------------------------------------
//  Shop UI
// ------------------------------------------------------------
let shopMode = 'shop', shopTab = 'flowers';
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
function openShop(mode) {
  shopMode = mode;
  if (mode === 'popcorn') shopTab = 'food';
  else if (shopTab === 'food') shopTab = 'flowers';
  $('#shop-title').textContent = mode === 'popcorn' ? '🍿 Попкорн и напитки' : '🛍️ Магазин';
  renderShop();
  $('#shop').hidden = false;
}
function renderShop() {
  renderCoins();
  const tabs = $('#shop-tabs');
  tabs.innerHTML = '';
  if (shopMode === 'shop') {
    for (const t of SHOP_TABS) {
      const b = document.createElement('button');
      b.textContent = t.title;
      b.className = t.id === shopTab ? 'on' : '';
      b.onclick = () => { shopTab = t.id; renderShop(); };
      tabs.appendChild(b);
    }
  }
  const list = $('#shop-list');
  list.innerHTML = '';
  for (const [type, d] of Object.entries(ITEMS)) {
    if (d.cat !== shopTab) continue;
    const card = document.createElement('div');
    card.className = 'item-card';
    const note = d.for ? (d.for === 'girl' ? 'для девушки 👧' : 'для парня 👦') : d.desc || (d.portions ? `${d.portions} порций` : d.capacity ? `вмещает ${d.capacity} вещей` : '');
    const col = d.outfit ? d.outfit.top : d.color;
    card.innerHTML = `<div class="big">${d.icon}${col != null ? `<i class="swatch" style="background:${hex(col)}"></i>` : ''}</div><b>${d.name}</b><small>${note}</small><div class="price">🪙 ${fmt(d.price)}</div>`;
    const btn = document.createElement('button');
    const can = state.wallet.coins >= d.price;
    btn.className = 'btn small ' + (can ? 'primary' : '');
    btn.textContent = can ? 'Купить' : 'Не хватает';
    btn.disabled = !can;
    btn.onclick = () => { if (buy(type)) { toast(`${d.icon} ${d.name} — в 🎒`); renderShop(); } };
    card.appendChild(btn);
    list.appendChild(card);
  }
}

// ------------------------------------------------------------
//  Inventory UI
// ------------------------------------------------------------
function openInv() { renderInv(); $('#inv').hidden = false; }
function partnerNear(max = 4) {
  if (!state.partner) return false;
  const a = state.me.root.position, b = state.partner.root.position;
  return Math.hypot(a.x - b.x, a.z - b.z) <= max;
}
function bagFor(it) {
  // prefer the bag in hand, otherwise any bag with room
  const w = state.wallet;
  const bags = w.items.filter((b) => b !== it && b.items && b.items.length < ITEMS[b.type].capacity);
  return bags.find((b) => b.uid === w.held) || bags[0] || null;
}
function renderInv() {
  renderCoins();
  const w = state.wallet;
  const list = $('#inv-list');
  list.innerHTML = '';
  if (!w.items.length) {
    list.innerHTML = '<p class="hint">Пока пусто. Загляните в 🛍️ магазин или к 🍿 попкорну!</p>';
    return;
  }
  const row = (it, bag) => {
    const d = ITEMS[it.type];
    const el = document.createElement('div');
    el.className = 'inv-row' + (bag ? ' in-bag' : '') + (w.held === it.uid ? ' held' : '');
    el.innerHTML = `<span class="ic">${d.icon}</span><span class="nm">${itemLabel(it)}${w.held === it.uid ? ' <em>✋ в руке</em>' : ''}${w.outfit === it.uid ? ' <em>👗 надето</em>' : ''}</span>`;
    const btns = document.createElement('span');
    btns.className = 'btns';
    const add = (label, fn, cls = '') => { const b = document.createElement('button'); b.className = 'btn small ' + cls; b.textContent = label; b.onclick = fn; btns.appendChild(b); };
    if (bag) {
      add('⬆ Достать', () => { bag.items = bag.items.filter((x) => x !== it); w.items.push(it); saveWallet(); renderInv(); });
      if (it.type === 'ticket') add('👁 Билет', () => showTicket(it));
    } else {
      if (d.cat === 'clothes') {
        if (d.for === state.myKind) add(w.outfit === it.uid ? 'Снять' : '👗 Надеть', () => { w.outfit = w.outfit === it.uid ? null : it.uid; saveWallet(); applyMyLook(); renderInv(); });
      } else if (gripOf(it.type)) {
        add(w.held === it.uid ? '🤲 Убрать' : '✋ В руку', () => { w.held = w.held === it.uid ? null : it.uid; saveWallet(); applyMyLook(); renderInv(); });
      }
      if (d.portions) add(`😋 ${d.verb}`, () => eat(it.uid));
      if (it.type === 'ticket') add('👁 Билет', () => showTicket(it));
      if (d.cat === 'bags') add(state.openBag === it.uid ? 'Закрыть' : '👜 Открыть', () => { state.openBag = state.openBag === it.uid ? null : it.uid; renderInv(); });
      const target = d.cat !== 'bags' && w.outfit !== it.uid ? bagFor(it) : null;
      if (target) {
        add('👜 В сумку', () => {
          removeItem(it.uid);
          target.items.push(it);
          saveWallet(); applyMyLook(); renderInv();
          toast(`${d.icon} в сумке ${ITEMS[target.type].icon}`);
        });
      }
      if (state.partner && w.outfit !== it.uid) add('🎁 Подарить', () => giveItem(it.uid), 'primary');
    }
    el.appendChild(btns);
    list.appendChild(el);
    if (!bag && d.cat === 'bags' && state.openBag === it.uid) {
      if (!it.items.length) {
        const e = document.createElement('div');
        e.className = 'inv-row in-bag';
        e.innerHTML = '<span class="nm hint">Сумка пустая — нажмите «👜 В сумку» у вещи</span>';
        list.appendChild(e);
      }
      for (const sub of it.items) row(sub, it);
    }
  };
  for (const it of w.items) row(it, null);
}

function giveItem(uid) {
  const it = findItem(uid);
  if (!it) return;
  if (!partnerNear(4)) { toast('Подойдите ближе к партнёру, чтобы подарить 🎁'); return; }
  state.me.giveT = 1.2;
  removeItem(uid);
  saveWallet();
  applyMyLook();
  const d = ITEMS[it.type];
  if (state.partnerIsNpc) {
    if (d.cat === 'clothes') { if (d.for === state.partner.kind) setOutfit(state.partner, it.type); }
    else if (gripOf(it.type)) setHeld(state.partner, it.type);
  } else net.send({ t: 'give', item: it });
  const p = state.partner.root.position;
  heartBurst(p.x, 1.6, p.z, 12);
  chime();
  toast(`🎁 Вы подарили: ${d.icon} ${d.name}`);
  $('#inv').hidden = true;
}

function eat(uid) {
  const it = findItem(uid);
  if (!it || state.me.eatT > 0) return;
  const d = ITEMS[it.type];
  state.wallet.held = uid;
  applyMyLook();
  state.me.eatT = 2.4;
  const snd = it.type === 'cola' ? slurp : crunch;
  snd(); setTimeout(snd, 900); setTimeout(snd, 1800);
  setTimeout(() => {
    const cur = findItem(uid);
    if (!cur) return;
    cur.left -= 1;
    if (cur.left <= 0) { removeItem(uid); toast(`${d.icon} ${it.type === 'cola' ? 'Кола выпита' : 'Попкорн закончился'} 😋`); }
    saveWallet();
    applyMyLook();
    if (!$('#inv').hidden) renderInv();
  }, 2400);
  $('#inv').hidden = true;
}

function showTicket(t) {
  $('#ticket-film').textContent = (MOVIES[t.film] || {}).title || 'Фильм';
  $('#ticket-r').textContent = t.row;
  $('#ticket-s').textContent = t.seat;
  $('#ticket-time').textContent = t.time || SESSIONS[t.film % 4];
  $('#ticket-view').hidden = false;
}

// ------------------------------------------------------------
//  Ticket desk (касса)
// ------------------------------------------------------------
let kassaFilm = 0;
let selSeats = [];
function takenFor(film) {
  const s = new Set(botSeats(film));
  for (const k of state.takenSeats[film] || []) s.add(k);
  return s;
}
function openKassa() {
  selSeats = [];
  renderKassa();
  $('#kassa').hidden = false;
}
function renderKassa() {
  renderCoins();
  const films = $('#films');
  films.innerHTML = '';
  MOVIES.forEach((m, i) => {
    const b = document.createElement('button');
    b.className = 'film-card' + (i === kassaFilm ? ' on' : '');
    b.innerHTML = `<span>🎬</span><b>${m.title}</b><small>сеанс ${SESSIONS[i % 4]}</small>`;
    b.onclick = () => { kassaFilm = i; selSeats = []; renderKassa(); };
    films.appendChild(b);
  });
  const taken = takenFor(kassaFilm);
  const map = $('#seatmap');
  map.innerHTML = '';
  for (let r = 1; r <= CINEMA.rows; r++) {
    const line = document.createElement('div');
    line.className = 'seat-line';
    line.innerHTML = `<span class="rn">${r}</span>`;
    for (let s = 1; s <= CINEMA.cols; s++) {
      const key = `${r}-${s}`;
      const b = document.createElement('button');
      const sel = selSeats.includes(key);
      b.className = 'seat ' + (taken.has(key) ? 'taken' : sel ? 'sel' : 'free');
      b.textContent = s;
      b.disabled = taken.has(key);
      b.onclick = () => {
        if (sel) selSeats = selSeats.filter((k) => k !== key);
        else if (selSeats.length < 4) selSeats.push(key);
        renderKassa();
      };
      line.appendChild(b);
    }
    map.appendChild(line);
  }
  const btn = $('#buy-tickets');
  const total = selSeats.length * ITEMS.ticket.price;
  btn.disabled = !selSeats.length || state.wallet.coins < total;
  btn.textContent = !selSeats.length ? 'Выберите места' : state.wallet.coins < total ? `Не хватает монет (нужно 🪙 ${fmt(total)})` : `Купить ${selSeats.length} ${selSeats.length === 1 ? 'билет' : 'билета'} · 🪙 ${fmt(total)}`;
}
$('#buy-tickets').onclick = () => {
  const film = kassaFilm;
  const bought = [];
  for (const key of selSeats) {
    const [row, seat] = key.split('-').map(Number);
    if (!buy('ticket', { film, row, seat, time: SESSIONS[film % 4] })) break;
    bought.push(key);
  }
  if (!bought.length) return;
  state.takenSeats[film] = new Set([...(state.takenSeats[film] || []), ...bought]);
  net.send({ t: 'seats', film, list: bought });
  state.cinemaFilm = film;
  refreshBots();
  $('#kassa').hidden = true;
  toast(bought.length > 1 ? '🎟️ Билеты в 🎒 — второй подарите партнёру! Зрители уже в зале 🍿' : '🎟️ Билет в 🎒! Зрители уже садятся в зал 🍿', 4000);
};
function screenIdleText() {
  return state.cinemaFilm != null ? `🎬 ${MOVIES[state.cinemaFilm].title}\nСкоро начало…` : '🎬 Купите билет в кассе';
}
function refreshBots() {
  spawnBots(world, state.cinemaFilm, state.takenSeats[state.cinemaFilm]);
  if (!state.movie) world.cinema.setScreenText(screenIdleText());
}

// ------------------------------------------------------------
//  Sitting
// ------------------------------------------------------------
function seatFree(x, z) {
  const pt = state.partner;
  return !(pt && Math.hypot(pt.root.position.x - x, pt.root.position.z - z) < 0.35);
}
function sitOn(ch, x, z, yaw, h) {
  ch.root.position.set(x, 0, z);
  ch.yaw = yaw;
  ch.seatH = h;
  ch.speed = 0;
  setAnim(ch, 'sit');
}
function trySit() {
  if (state.sitting) { standUp(); return; }
  const p = state.me.root.position;
  let best = null, bd = 2.2;
  for (const s of world.seats) {
    const d = Math.hypot(p.x - s.x, p.z - s.z);
    if (d < bd && seatFree(s.x, s.z)) { bd = d; best = s; }
  }
  if (!best) { toast('Подойдите к скамейке или дивану 🪑'); return; }
  if (state.joint) cancelJoint(true);
  sitOn(state.me, best.x, best.z, best.yaw, best.h);
  state.sitting = { kind: 'seat' };
  if (state.partnerIsNpc && state.partner) {
    let nb = null, nd = 1.7;
    for (const s of world.seats) {
      if (s === best) continue;
      const d = Math.hypot(s.x - best.x, s.z - best.z);
      if (d < nd && Math.abs(wrapAngle(s.yaw - best.yaw)) < 0.1) { nd = d; nb = s; }
    }
    if (nb) sitOn(state.partner, nb.x, nb.z, nb.yaw, nb.h);
  }
}
function sitCinema(ticket) {
  if (state.joint) cancelJoint(true);
  const p = cinemaSeatPos(ticket.row, ticket.seat);
  sitOn(state.me, p.x, p.z, p.yaw, p.h);
  state.sitting = { kind: 'cinema', film: ticket.film, row: ticket.row, seat: ticket.seat };
  if (state.cinemaFilm !== ticket.film) { state.cinemaFilm = ticket.film; refreshBots(); }
  if (state.partnerIsNpc && state.partner) {
    const taken = takenFor(ticket.film);
    const s2 = [ticket.seat + 1, ticket.seat - 1, ticket.seat + 2, ticket.seat - 2].find((s) => s >= 1 && s <= CINEMA.cols && !taken.has(`${ticket.row}-${s}`));
    if (s2) { const q = cinemaSeatPos(ticket.row, s2); sitOn(state.partner, q.x, q.z, q.yaw, q.h); }
  }
  checkMovieStart();
}
function standUp() {
  if (!state.sitting) return;
  const wasCinema = state.sitting.kind === 'cinema';
  state.sitting = null;
  setAnim(state.me, 'idle');
  const p = state.me.root.position;
  p.x += Math.sin(state.me.yaw) * 0.45;
  p.z += Math.cos(state.me.yaw) * 0.45;
  resolveCollision(world, p);
  if (state.partnerIsNpc && state.partner && state.partner.anim === 'sit') {
    setAnim(state.partner, 'idle');
    const q = state.partner.root.position;
    q.x += Math.sin(state.partner.yaw) * 0.45; q.z += Math.cos(state.partner.yaw) * 0.45;
    resolveCollision(world, q);
  }
  if (wasCinema) stopMovie();
}

// ------------------------------------------------------------
//  Movie session: sit → (wait for partner) → 3-2-1 → film
// ------------------------------------------------------------
function checkMovieStart() {
  const s = state.sitting;
  if (!s || s.kind !== 'cinema' || state.movie) return;
  const pt = state.partner;
  if (pt && !state.partnerIsNpc && net.connected && pt.net.tk === s.film && pt.net.cs !== s.film) {
    state.movie = { film: s.film, phase: 'wait' };
    world.cinema.setScreenText(`🎬 ${MOVIES[s.film].title}\n⏳ Ждём партнёра…`);
    toast('⏳ Ждём, когда партнёр сядет на своё место');
    return;
  }
  startCountdown(s.film, true);
}
function startCountdown(film, broadcast) {
  if (state.movie && state.movie.phase !== 'wait') return;
  state.movie = { film, phase: 'count', start: now(), shown: 0 };
  if (broadcast && net.connected) net.send({ t: 'movie', film });
}
function updateMovie(dt) {
  const mv = state.movie;
  const target = mv && mv.phase === 'play' ? 0.18 : mv && mv.phase === 'count' ? 0.45 : 1;
  lightLevel = damp(lightLevel, target, 2, dt);
  hemi.intensity = LIGHT_BASE.hemi * lightLevel;
  sun.intensity = LIGHT_BASE.sun * lightLevel;
  fill.intensity = LIGHT_BASE.fill * lightLevel;
  if (!mv) return;
  if (mv.phase === 'count') {
    const el = now() - mv.start; // wall clock, so both players count in step even on slow phones
    const n = 3 - Math.floor(el);
    if (n !== mv.shown && n >= 1) {
      mv.shown = n;
      const box = $('#countdown');
      box.hidden = false;
      box.textContent = n;
      box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop');
      world.cinema.setScreenText(String(n), '#000000');
      beep(false);
    }
    if (el >= 3) {
      $('#countdown').hidden = true;
      beep(true);
      mv.phase = 'play';
      playFilm(mv.film);
    }
  }
  if (mv.phase === 'play') positionFilm();
}
function filmEmbed(film) {
  const m = MOVIES[film] || {};
  const url = state.localFilms[film] || m.url || '';
  const body = $('#film-body');
  body.innerHTML = '';
  if (!url) {
    body.innerHTML = `<div class="film-empty"><p>🎬 «${m.title}» ещё не добавлен</p><label class="btn small primary">📁 Выбрать видео с устройства<input type="file" accept="video/*" hidden></label><p class="hint small">или вставьте ссылку в photos.js → movies</p></div>`;
    body.querySelector('input').onchange = (e) => {
      const f = e.target.files[0];
      if (!f) return;
      state.localFilms[film] = URL.createObjectURL(f);
      filmEmbed(film);
    };
    return;
  }
  const id = !url.startsWith('blob:') && driveFileId(url);
  const yt = url.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/);
  if (id || yt) {
    const f = document.createElement('iframe');
    f.src = id ? `https://drive.google.com/file/d/${id}/preview` : `https://www.youtube.com/embed/${yt[1]}?autoplay=1&rel=0`;
    f.allow = 'autoplay; fullscreen; encrypted-media';
    f.allowFullscreen = true;
    body.appendChild(f);
  } else {
    const v = document.createElement('video');
    v.src = url; v.controls = true; v.autoplay = true; v.playsInline = true;
    body.appendChild(v);
    v.play().catch(() => {});
  }
}
function playFilm(film) {
  $('#film-title').textContent = '🎬 ' + MOVIES[film].title;
  $('#film').hidden = false;
  if (window.innerHeight > window.innerWidth) $('#film').classList.add('full');
  world.cinema.setScreenText(' ', '#000000');
  filmEmbed(film);
  setMusic(null);
}
const _v = new THREE.Vector3();
function positionFilm() {
  const el = $('#film');
  if (el.classList.contains('full')) { el.removeAttribute('style'); return; }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const c of world.cinema.corners) {
    _v.copy(c).project(camera);
    const x = (_v.x * 0.5 + 0.5) * window.innerWidth, y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(window.innerWidth, x1); y1 = Math.min(window.innerHeight - 56, y1);
  el.style.left = x0 + 'px';
  el.style.top = y0 + 'px';
  el.style.width = Math.max(120, x1 - x0) + 'px';
  el.style.height = Math.max(80, y1 - y0) + 'px';
}
function stopMovie() {
  state.movie = null;
  $('#countdown').hidden = true;
  $('#film').hidden = true;
  $('#film').classList.remove('full');
  $('#film-body').innerHTML = '';
  if (world) world.cinema.setScreenText(screenIdleText());
}
$('#film-full').onclick = () => $('#film').classList.toggle('full');
$('#film-exit').onclick = () => standUp();

// ------------------------------------------------------------
//  Characters
// ------------------------------------------------------------
function createMe() {
  const old = state.me;
  const x0 = state.mode === 'guest' ? -0.8 : state.mode === 'host' ? 0.8 : state.myKind === 'girl' ? 0.6 : -0.6;
  const p = old ? { x: old.root.position.x, z: old.root.position.z } : { x: x0, z: world.spawn.z };
  removeCharacter(scene, old);
  state.me = makeCharacter(state.myKind, { name: state.myName, scene });
  state.me.root.position.set(p.x, 0, p.z);
  state.me.yaw = old ? old.yaw : world.spawn.yaw;
  state.wallet = loadWallet(state.myKind);
  state.me.outfitType = undefined; // force outfit refresh
  applyMyLook();
}
function createPartner(kind, name, npc) {
  removeCharacter(scene, state.partner);
  state.partner = makeCharacter(kind, { name, scene });
  state.partner.outfitType = undefined;
  setOutfit(state.partner, null);
  state.partnerIsNpc = npc;
  const mp = state.me.root.position;
  state.partner.root.position.set(mp.x + (kind === 'girl' ? 1 : -1), 0, mp.z + 0.3);
  state.partner.yaw = Math.PI;
  state.partner.net = { x: state.partner.root.position.x, z: state.partner.root.position.z, yaw: Math.PI, anim: 'idle', speed: 0, tk: -1, cs: -1 };
}
function removePartner() {
  removeCharacter(scene, state.partner);
  state.partner = null;
  if (state.joint) endJoint();
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
    if (p.life <= 0) { scene.remove(p.s); p.s.material.dispose(); particles.splice(i, 1); continue; }
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
//  Emotes & joint actions
// ------------------------------------------------------------
function doEmote(kind) {
  ensureAudio();
  const me = state.me;
  if (!me) return;
  if (kind === 'sit') { trySit(); return; }
  if (kind === 'hearts') {
    const p = me.root.position;
    heartBurst(p.x, 1.6, p.z, 16);
    chime();
    net.send({ t: 'e', k: 'hearts' });
    return;
  }
  if (kind === 'waltz' || kind === 'kiss') { requestJoint(kind); return; }
  if (state.sitting) standUp();
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
  if (state.sitting) standUp();
  if (partner.anim === 'sit' && state.partnerIsNpc) setAnim(partner, 'idle');
  const boy = me.kind === 'boy' ? me : partner;
  const girl = boy === me ? partner : me;
  const bp = boy.root.position, gp = girl.root.position;
  const c = { x: (bp.x + gp.x) / 2, z: (bp.z + gp.z) / 2 };
  resolveCollision(world, c, 1.0);
  const a0 = d > 0.05 ? Math.atan2(gp.x - bp.x, gp.z - bp.z) : 0;
  startJoint(type, c.x, c.z, a0, false);
}
function startJoint(type, cx, cz, a0, fromNet) {
  if (state.sitting) standUp();
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
  if (j.type === 'kiss') d = 0.56;
  else {
    d = 0.5;
    a = j.a0 - j.t * 1.1;
    const c = { x: cx + 1.1 * Math.sin(j.t * 0.35), z: cz + 1.1 * (1 - Math.cos(j.t * 0.35)) * (cz > 12 ? -1 : 1) };
    resolveCollision(world, c, 0.9);
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
const drag = { id: null, x: 0, y: 0, t: 0, moved: 0 };
const touches = new Map();
let pinchDist = 0;
const anyOverlay = () => [...document.querySelectorAll('.overlay')].some((o) => !o.hidden);

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (!state.started) return;
  if (!$('#viewer').hidden) {
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
    return;
  }
  if (e.key === 'Escape') { document.querySelectorAll('.overlay').forEach((o) => { o.hidden = true; }); $('#film').classList.remove('full'); return; }
  if (anyOverlay()) return;
  keys.add(e.code);
  const map = { Digit1: 'dance1', Digit2: 'dance2', Digit3: 'waltz', Digit4: 'kiss', Digit5: 'sit', Digit6: 'wave', Digit7: 'hearts' };
  if (map[e.code] && !e.repeat) doEmote(map[e.code]);
  if (e.code === 'KeyE' && !e.repeat && currentActions.length) currentActions[0].fn();
  if (e.code === 'KeyI' && !e.repeat) openInv();
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
  if (joy.id !== null) { x = joy.x; y = -joy.y; run = Math.hypot(joy.x, joy.y) > 0.92; }
  return { x, y, run };
}

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
  drag.x = e.clientX; drag.y = e.clientY;
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
  if (!state.started || !world) return;
  raycaster.setFromCamera(new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1), camera);
  raycaster.far = 14;
  const hits = raycaster.intersectObjects(world.frames.map((f) => f.mesh).concat(world.blockers), false);
  raycaster.far = Infinity;
  if (!hits.length || hits[0].object.userData.photoIndex === undefined) return;
  const idx = hits[0].object.userData.photoIndex;
  if (idx >= 0) openViewer(idx);
  else openPhotosPanel();
}

// ------------------------------------------------------------
//  Update
// ------------------------------------------------------------
const camTarget = new THREE.Vector3();
const camDir = new THREE.Vector3();
const camWant = new THREE.Vector3();
let camInit = false;

function updateMe(dt) {
  const me = state.me;
  const inp = getInput();
  const mag = Math.hypot(inp.x, inp.y);
  if (state.joint) {
    if (mag > 0.25) cancelJoint(true);
    else return;
  }
  if (state.sitting) {
    if (mag > 0.4) standUp();
    else { me.speed = 0; advanceStride(me, dt); return; }
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
    resolveCollision(world, p);
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
    if (pt.anim === 'sit') { pt.speed = 0; advanceStride(pt, dt); return; }
    const me = state.me, mp = me.root.position, p = pt.root.position;
    const side = pt.kind === 'girl' ? 1 : -1;
    const tx = mp.x + Math.cos(me.yaw) * 0.9 * side - Math.sin(me.yaw) * 0.4;
    const tz = mp.z - Math.sin(me.yaw) * 0.9 * side - Math.cos(me.yaw) * 0.4;
    const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    if (d > 8) { p.x = tx; p.z = tz; resolveCollision(world, p); }
    else if (d > 0.6) {
      const speed = clamp(d * 1.6, 1.2, 5.2);
      p.x += (dx / d) * speed * dt; p.z += (dz / d) * speed * dt;
      resolveCollision(world, p);
      pt.yaw = angDamp(pt.yaw, Math.atan2(dx, dz), 8, dt);
      pt.speed = speed;
      setAnim(pt, 'walk');
    } else {
      pt.speed = 0;
      if (pt.anim === 'walk') setAnim(pt, 'idle');
      if (pt.anim === 'idle') pt.yaw = angDamp(pt.yaw, me.yaw, 3, dt);
    }
  } else {
    const n = pt.net, p = pt.root.position;
    const snap = Math.hypot(p.x - n.x, p.z - n.z) > 6 || n.anim === 'sit';
    p.x = snap ? n.x : damp(p.x, n.x, 12, dt);
    p.z = snap ? n.z : damp(p.z, n.z, 12, dt);
    pt.yaw = n.anim === 'sit' ? n.yaw : angDamp(pt.yaw, n.yaw, 12, dt);
    pt.speed = n.speed;
    pt.seatH = n.sh || 0.45;
    setAnim(pt, n.anim);
    if (n.ea) pt.eatT = Math.max(pt.eatT, 0.25);
  }
  advanceStride(pt, dt);
}

function updateCamera(dt) {
  const me = state.me;
  const p = me.root.position;
  if (state.sitting && state.sitting.kind === 'cinema') {
    camTarget.lerp(world.cinema.center, 1 - Math.exp(-4 * dt));
    const portrait = window.innerHeight > window.innerWidth;
    camWant.set(p.x - (portrait ? 2.8 : 1.3), portrait ? 2.4 : 1.95, p.z);
    camera.position.lerp(camWant, 1 - Math.exp(-4 * dt));
    camera.lookAt(camTarget);
    return;
  }
  let tx = p.x, tz = p.z;
  if (state.joint && state.partner) {
    tx = (p.x + state.partner.root.position.x) / 2;
    tz = (p.z + state.partner.root.position.z) / 2;
  }
  const ty = state.sitting ? 1.0 : 1.35;
  if (!camInit) { camTarget.set(tx, ty, tz); camInit = true; }
  camTarget.x = damp(camTarget.x, tx, 10, dt);
  camTarget.y = damp(camTarget.y, ty, 10, dt);
  camTarget.z = damp(camTarget.z, tz, 10, dt);
  const { yaw, pitch, dist } = state.cam;
  camDir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  let d = dist;
  raycaster.set(camTarget, camDir);
  raycaster.far = dist + 0.3;
  const hit = raycaster.intersectObjects(world.blockers, false)[0];
  raycaster.far = Infinity;
  if (hit) d = Math.max(0.6, hit.distance - 0.3);
  camera.position.copy(camTarget).addScaledVector(camDir, d);
  camera.position.y = Math.min(camera.position.y, (whereIs(world, p.x, p.z) === 'gallery' ? 5 : 6) - 0.25);
  camera.lookAt(camTarget);
}

// ---------- context actions (buttons near things) ----------
let currentActions = [];
let actionsKey = '';
function computeActions() {
  const acts = [];
  const p = state.me.root.position;
  const near = (z) => z && Math.hypot(p.x - z.x, p.z - z.z) < z.r;
  const where = whereIs(world, p.x, p.z);
  if (state.sitting) {
    acts.push({ id: 'stand', label: '⬆ Встать', fn: standUp });
  } else {
    if (near(world.zones.shop)) acts.push({ id: 'shop', label: '🛍️ Магазин', fn: () => openShop('shop') });
    if (near(world.zones.popcorn)) acts.push({ id: 'popcorn', label: '🍿 Попкорн', fn: () => openShop('popcorn') });
    if (near(world.zones.kassa)) acts.push({ id: 'kassa', label: '🎟️ Касса', fn: openKassa });
    if (where === 'cinema') {
      const t = myTicket();
      if (t) acts.push({ id: 'seat' + t.uid, label: `💺 Моё место: ряд ${t.row}, место ${t.seat}`, fn: () => sitCinema(t) });
      else acts.push({ id: 'noticket', label: '🎟️ Нужен билет', fn: () => toast('Купите билет в 🎟️ кассе у входа в кинотеатр') });
    }
    if (where === 'gallery') {
      let best = null, bd = 3.2;
      for (const f of world.frames) {
        if (f.index < 0) continue;
        const d = Math.hypot(p.x - f.x, p.z - f.z);
        if (d < bd) { bd = d; best = f; }
      }
      if (best) acts.push({ id: 'photo' + best.index, label: '🔍 Смотреть фото', fn: () => openViewer(best.index) });
    }
    if (world.seats.some((s) => Math.hypot(p.x - s.x, p.z - s.z) < 1.4)) acts.push({ id: 'sit', label: '🪑 Сесть', fn: trySit });
  }
  const held = state.wallet.held && findItem(state.wallet.held);
  if (held && ITEMS[held.type].portions) acts.push({ id: 'eat' + held.uid, label: `😋 ${ITEMS[held.type].verb}`, fn: () => eat(held.uid) });
  if (held && state.partner && partnerNear(3)) acts.push({ id: 'give' + held.uid, label: `🎁 Подарить ${ITEMS[held.type].icon}`, fn: () => giveItem(held.uid) });
  currentActions = acts;
  const key = acts.map((a) => a.id + a.label).join('|');
  if (key === actionsKey) return;
  actionsKey = key;
  const box = $('#actions');
  box.innerHTML = '';
  for (const a of acts) {
    const b = document.createElement('button');
    b.className = 'pill';
    b.textContent = a.label;
    b.onclick = () => { ensureAudio(); a.fn(); };
    box.appendChild(b);
  }
}

let placeKey = '';
function updatePlace() {
  const p = state.me.root.position;
  const where = whereIs(world, p.x, p.z);
  let label = where === 'cinema' ? '🎬 Кинотеатр' : where === 'lobby' ? '🏛️ Холл' : '🖼️ Галерея';
  if (where === 'gallery') {
    const r = world.rooms.find((rm) => p.z <= rm.zStart && p.z > rm.zEnd);
    if (r) label = `🖼️ Зал ${r.n} · ${r.name}`;
  }
  if (label !== placeKey) { placeKey = label; $('#place').textContent = label; }
}

function updateEmoteButtons() {
  const a = state.me ? state.me.anim : '';
  document.querySelectorAll('#emotes button').forEach((b) => b.classList.toggle('active', b.dataset.emote === a));
}

let last = now();
let slowTick = 0;
function frame() {
  requestAnimationFrame(frame);
  const t = now();
  const dt = Math.min(0.05, t - last);
  last = t;
  if (!world) return;
  world.update(t, dt);

  if (state.started && state.me) {
    updateMe(dt);
    updatePartner(dt);
    updateJoint(dt);
    animateCharacter(state.me, dt);
    if (state.partner) animateCharacter(state.partner, dt);
    updateCamera(dt);
    updateMovie(dt);
    const inSeat = !!(state.sitting && state.sitting.kind === 'cinema');
    for (const ch of [state.me, state.partner]) if (ch && ch.label) ch.label.visible = !inSeat;
    slowTick -= dt;
    if (slowTick < 0) {
      slowTick = 0.25;
      world.loadNear(state.me.root.position.x, state.me.root.position.z);
      computeActions();
      updatePlace();
      updateEmoteButtons();
    }
    const a = state.me.anim;
    if (!state.movie) setMusic(a === 'dance1' || a === 'dance2' ? 'dance' : a === 'waltz' ? 'waltz' : null);

    if (net.connected && t - state.lastSend > 1 / 15) {
      state.lastSend = t;
      const p = state.me.root.position;
      const tk = myTicket();
      net.send({
        t: 's', k: state.me.kind, n: state.myName, x: +p.x.toFixed(3), z: +p.z.toFixed(3), r: +state.me.yaw.toFixed(3),
        a: state.me.anim, v: +state.me.speed.toFixed(2), sh: state.me.seatH, o: state.me.outfitType || null, h: state.me.heldType,
        ea: state.me.eatT > 0 ? 1 : 0, tk: tk ? tk.film : -1, cs: state.sitting && state.sitting.kind === 'cinema' ? state.sitting.film : -1,
      });
    }
  } else {
    const a = t * 0.08;
    camera.position.set(Math.sin(a) * 6, 3, 18 + Math.cos(a) * 3);
    camera.lookAt(0, 2, 6);
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
  peer: null, conn: null, connected: false, code: '', lastRecv: 0,
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
    setupConn(peer.connect(CFG.roomPrefix + code, { reliable: true }), () => { opened = true; });
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
    c.send({ t: 'hello', k: state.myKind, n: state.myName });
    if (state.mode === 'host') c.send({ t: 'p', list: photos });
    for (const [film, set] of Object.entries(state.takenSeats)) c.send({ t: 'seats', film: +film, list: [...set] });
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
          state.myKind = opposite(state.myKind);
          if (state.started) { createMe(); toast('Этот персонаж уже занят — вы играете за ' + (state.myKind === 'girl' ? 'девушку 👧' : 'парня 👦')); }
          net.send({ t: 'hello', k: state.myKind, n: state.myName });
        } else kind = opposite(state.myKind);
      }
      if (state.started) {
        createPartner(kind, String(m.n || '').slice(0, 16), false);
        toast((kind === 'girl' ? '👧 ' : '👦 ') + (m.n || 'Партнёр') + ' пришёл 💕');
      } else state.pendingPartner = { kind, name: String(m.n || '').slice(0, 16) };
      break;
    }
    case 's': {
      const pt = state.partner;
      if (!pt) break;
      const kind = m.k === state.myKind ? opposite(state.myKind) : m.k;
      if (kind !== pt.kind) { createPartner(kind, m.n, false); break; }
      if (typeof m.x !== 'number') break;
      const n = pt.net;
      n.x = m.x; n.z = m.z; n.yaw = m.r; n.speed = m.v || 0; n.sh = m.sh; n.ea = m.ea;
      n.tk = typeof m.tk === 'number' ? m.tk : -1;
      n.cs = typeof m.cs === 'number' ? m.cs : -1;
      if (!state.joint) n.anim = ['idle', 'walk', 'dance1', 'dance2', 'wave', 'sit'].includes(m.a) ? m.a : 'idle';
      setOutfit(pt, ITEMS[m.o] ? m.o : null);
      setHeld(pt, ITEMS[m.h] ? m.h : null);
      if (state.movie && state.movie.phase === 'wait' && n.cs === state.movie.film) startCountdown(state.movie.film, true);
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
    case 'give': {
      const it = m.item;
      if (!it || !ITEMS[it.type] || !state.wallet) break;
      if (Array.isArray(it.items)) it.items = it.items.filter((x) => x && ITEMS[x.type]);
      addItem(it, true);
      const d = ITEMS[it.type];
      const p = state.me.root.position;
      heartBurst(p.x, 1.6, p.z, 16);
      chime();
      toast(`💝 Вам подарили: ${d.icon} ${d.name}!${d.cat === 'clothes' ? ' Наденьте в 🎒' : ''}`, 3500);
      if (!$('#inv').hidden) renderInv();
      break;
    }
    case 'seats': {
      if (typeof m.film !== 'number' || !Array.isArray(m.list)) break;
      state.takenSeats[m.film] = new Set([...(state.takenSeats[m.film] || []), ...m.list.map(String)]);
      state.cinemaFilm = m.film;
      if (world) refreshBots();
      break;
    }
    case 'movie':
      if (state.sitting && state.sitting.kind === 'cinema' && state.sitting.film === m.film) startCountdown(m.film, false);
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
  photos = [...new Set(list)].slice(0, 400);
  store.set('lg_photos', photos.filter((p) => !p.startsWith('data:')));
  rebuildWorld();
  if (broadcast) net.send({ t: 'p', list: photos });
}

async function listFolder(folderId) {
  if (CFG.driveListUrl) {
    const url = CFG.driveListUrl + (CFG.driveListUrl.includes('?') ? '&' : '?') + 'folder=' + encodeURIComponent(folderId);
    const data = await (await fetch(url)).json();
    if (data.error) throw new Error(data.error);
    const files = Array.isArray(data) ? data : data.files || [];
    return files.map((f) => `https://drive.google.com/file/d/${typeof f === 'string' ? f : f.id}/view`);
  }
  if (CFG.driveApiKey) {
    const out = [];
    const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
    let pageToken = '';
    do {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&key=${CFG.driveApiKey}&fields=nextPageToken,files(id)&orderBy=createdTime&pageSize=200${pageToken ? '&pageToken=' + pageToken : ''}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      for (const f of data.files || []) out.push(`https://drive.google.com/file/d/${f.id}/view`);
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  throw new Error('нужен driveListUrl (скрипт Google) — см. README');
}
async function expandFolders(lines) {
  const out = [];
  for (const line of lines) {
    const folder = driveFolderId(line);
    if (!folder) { out.push(line); continue; }
    try { out.push(...(await listFolder(folder))); } catch (e) { toast('Папка не прочиталась: ' + e.message, 6000); }
  }
  return out;
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
  for (const f of [...e.target.files]) { const d = await downscale(f); if (d) uploads.push(d); }
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
  $('#viewer-img').src = viewSource(photos[viewIndex]);
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

// ------------------------------------------------------------
//  UI wiring
// ------------------------------------------------------------
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { b.closest('.overlay').hidden = true; }));
document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o && o.id !== 'viewer') o.hidden = true; }));
$('#btn-photos').addEventListener('click', openPhotosPanel);
$('#btn-inv').addEventListener('click', openInv);
$('#btn-help').addEventListener('click', () => { $('#help').hidden = false; });
const soundBtn = $('#btn-sound');
const renderSound = () => { soundBtn.textContent = audio.on ? '🔊' : '🔇'; };
renderSound();
soundBtn.addEventListener('click', () => { audio.on = !audio.on; store.set('lg_sound', audio.on); renderSound(); ensureAudio(); });
document.querySelectorAll('#emotes button').forEach((b) => b.addEventListener('click', () => doEmote(b.dataset.emote)));

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
function readName() { state.myName = nameEl.value.trim().slice(0, 16); store.set('lg_name', state.myName); }
const inviteLink = () => location.origin + location.pathname + '?room=' + net.code;
function updateRoomInfo() {
  const el = $('#room-info');
  if (state.mode === 'solo') { el.innerHTML = '🚶 Прогулка в одиночку'; return; }
  const on = net.connected;
  el.innerHTML = `<span class="dot ${on ? 'on' : ''}"></span>${on ? 'Вы вдвоём 💕' : 'Ждём партнёра…'} · код <b>${net.code}</b>` + (on ? '' : '<br><button id="copy-link">📋 Скопировать приглашение</button>');
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
  const t = myTicket();
  if (t && state.cinemaFilm == null) { state.cinemaFilm = t.film; refreshBots(); }
  if (mode === 'solo') createPartner(opposite(state.myKind), '', true);
  if (state.pendingPartner) {
    createPartner(state.pendingPartner.kind, state.pendingPartner.name, false);
    toast((state.pendingPartner.kind === 'girl' ? '👧 ' : '👦 ') + (state.pendingPartner.name || 'Партнёр') + ' уже здесь 💕');
    state.pendingPartner = null;
  }
  updateRoomInfo();
  if (!store.get('lg_seen_help2', false)) { $('#help').hidden = false; store.set('lg_seen_help2', true); }
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
    if (net.connected) { done = true; clearInterval(wait); setMenuBusy(false); menuStatus(''); startGame('guest'); }
  }, 100);
});
codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });

// ------------------------------------------------------------
//  Boot
// ------------------------------------------------------------
const saved = store.get('lg_photos', null);
// photos from photos.js always hang in the gallery; links added in-game are appended after them
photos = [...new Set([...(CFG.photos || []), ...(saved || [])])].filter((p) => typeof p === 'string' && p.trim());
rebuildWorld();
requestAnimationFrame(frame);
if (CFG.driveFolder && driveFolderId(CFG.driveFolder)) {
  listFolder(driveFolderId(CFG.driveFolder))
    .then((list) => { if (list.length) setPhotos([...photos, ...list], state.mode === 'host' && net.connected); })
    .catch((e) => toast('Папка Google Drive не прочиталась: ' + e.message, 6000));
}

// for debugging in the console
window.__game = { state, net, setPhotos, doEmote, startGame, buy, sitCinema, openShop, openInv, openKassa, get world() { return world; } };
