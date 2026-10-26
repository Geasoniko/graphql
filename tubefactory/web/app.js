// TubeFactory web UI — plain JS, hash routing, polling for progress.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const view = $("#view");

const STAGE_NAMES = {
  script: "✍️ Сценарий", review: "🧐 Редактура", art: "🎨 Арт-дирекция", seo: "📣 Маркетинг",
  characters: "🖌 Персонажи", audio: "🎙 Озвучка", images: "🖌 Кадры",
  thumbnail: "🖼 Баннер", render: "🎬 Монтаж", upload: "🚀 YouTube",
};
const LANGUAGES = ["English", "Русский", "Қазақша", "Español", "Deutsch"];

let pollTimer = null;
let cache = { channels: [], voices: { edge: [], openai: [] }, settings: {} };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), err ? 7000 : 3500);
}

async function guard(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

function media(pid, rel) {
  return rel ? `/media/${pid}/${rel}?v=${Date.now() % 1e7}` : "";
}

function stageBadge(st) {
  const map = { done: ["ok", "готово"], running: ["run", "идёт"], error: ["err", "ошибка"], stale: ["warn", "устарело"], idle: ["", "—"] };
  const [cls, txt] = map[st.status] || ["", st.status];
  return `<span class="badge ${cls}">${txt}</span>`;
}

function options(list, value) {
  return list.map((o) => {
    const [v, n] = Array.isArray(o) ? o : typeof o === "object" ? [o.id, o.name] : [o, o];
    return `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(n)}</option>`;
  }).join("");
}

function voiceOptions(value) {
  const provider = cache.settings.tts_provider;
  const list = provider === "openai" || provider === "openrouter" ? cache.voices.openai
    : provider === "kokoro" ? cache.voices.kokoro : cache.voices.edge;
  const known = list.some((v) => v.id === value);
  return options(known || !value ? list : [{ id: value, name: value }, ...list], value);
}

const money = (v) => "$" + (v || 0).toFixed(v && v < 0.1 ? 3 : 2);

function agentName(role) {
  const a = (cache.company?.staff || []).find((x) => x.role === role);
  return a ? `${a.emoji} ${a.name}` : role;
}

function costCard(p) {
  const spent = p.cost?.total || 0;
  const est = p.estimate || { total: 0, by_role: {} };
  const roles = [...new Set([...Object.keys(est.by_role), ...Object.keys(p.cost?.by_role || {})])];
  const pct = est.total ? Math.min(100, Math.round(spent / est.total * 100)) : 0;
  return `<div class="card">
    <div class="row"><h2 class="grow" style="margin:0">💰 Деньги на это видео</h2>
      <div class="col" style="align-items:flex-end;gap:0"><div class="stat">${money(spent)}</div>
      <div class="muted small">потрачено · оценка всего видео ~${money(est.total)}${est.live_prices ? "" : " (цены по справочнику)"}</div></div></div>
    <div class="bar ${spent > est.total * 1.2 && est.total ? "err" : "ok"}" style="margin:10px 0"><div style="width:${pct}%"></div></div>
    <details><summary class="small muted">По сотрудникам</summary>
      <table class="small" style="width:100%;margin-top:8px;border-collapse:collapse">
        <tr class="muted"><td>Сотрудник</td><td style="text-align:right">Потрачено</td><td style="text-align:right">Оценка</td></tr>
        ${roles.map((r) => `<tr><td>${esc(agentName(r))}</td><td style="text-align:right">${money(p.cost?.by_role?.[r])}</td><td style="text-align:right" class="muted">${money(est.by_role[r])}</td></tr>`).join("")}
      </table>
      <div class="muted small" style="margin-top:6px">Озвучка Edge и монтаж бесплатны. Перерисовка кадров добавляет к сумме.</div>
    </details>
  </div>`;
}

function lightbox(src) {
  const el = document.createElement("div");
  el.className = "lightbox";
  el.innerHTML = `<img src="${src}">`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}

async function refreshShared() {
  const [channels, voices, settings, projects, queue, company] = await Promise.all([
    api("/api/channels"), api("/api/voices"), api("/api/settings"), api("/api/projects"), api("/api/queue"), api("/api/company"),
  ]);
  cache = { channels, voices, settings, projects, queue, company };
  $("#nav-channels").textContent = channels.length;
  $("#nav-projects").textContent = projects.length;
  $("#nav-queue").textContent = queue.queued.length + (queue.current ? 1 : 0);
  $("#topbar-spend").innerHTML = `💰 потрачено <b>${money(company.total_cost)}</b>`;
  drawLiveJob();
  $("#foot").innerHTML = settings.demo_active
    ? `<span class="badge warn">демо-режим</span><br>Добавьте ключ OpenRouter в Настройках`
    : `<span class="badge ok">OpenRouter подключён</span>`;
}

// ---------------- pages ----------------

const pages = {};

pages.home = async () => {
  const { projects, channels, queue, settings } = cache;
  const ready = projects.filter((p) => p.output).length;
  const uploaded = projects.filter((p) => p.youtube).length;
  const steps = [
    [!settings.demo_active, "Вставить ключ OpenRouter", "#/settings"],
    [modelsChecked(), "Проверить модели сотрудников", "#/company"],
    [channels.length > 0, "Создать канал: ниша, стиль, голос", "#/channels"],
    [projects.length > 0, "Сделать первое видео — кнопка «➕ Новое видео» сверху", null],
    [channels.some((c) => c.connected), "Подключить YouTube к каналу", "#/channels"],
    [channels.some((c) => c.autopilot), "Включить автопилот, когда качество устроит", "#/channels"],
  ];
  const doneCount = steps.filter((x) => x[0]).length;
  view.innerHTML = `
    ${settings.demo_active ? `<div class="card banner">Сейчас <b>демо-режим</b>: вместо ИИ — заглушки. Вставьте ключ <a href="#/settings">OpenRouter в Настройках</a>, чтобы делать настоящие видео.</div>` : ""}
    <div class="grid stats">
      <div class="card"><div class="muted">Готовых видео</div><div class="stat">${ready}<span class="muted small"> из ${projects.length}</span></div></div>
      <div class="card"><div class="muted">На YouTube</div><div class="stat">${uploaded}</div></div>
      <div class="card"><div class="muted">Каналов / на автопилоте</div><div class="stat">${channels.length} / ${channels.filter((c) => c.autopilot).length}</div></div>
      <div class="card"><div class="muted">Потрачено на OpenRouter</div><div class="stat">${money(cache.company.total_cost)}</div></div>
      <div class="card"><div class="muted">В среднем за видео</div><div class="stat">${ready ? money(projects.filter((p) => p.output).reduce((a, p) => a + (p.cost?.total || 0), 0) / ready) : "—"}</div></div>
    </div>
    ${doneCount < steps.length ? `<div class="card">
      <div class="row" style="margin-bottom:10px"><h2 class="grow" style="margin:0">🚀 Запуск компании</h2><span class="badge ${doneCount ? "ok" : ""}">${doneCount} из ${steps.length}</span></div>
      <div class="bar ok" style="margin-bottom:12px"><div style="width:${Math.round(doneCount / steps.length * 100)}%"></div></div>
      <div class="checklist">${steps.map(([ok, label, href], i) => `
        <a class="check-item ${ok ? "done" : ""}" ${href ? `href="${href}"` : `href="#" data-new-video`}><span class="dot">${ok ? "✓" : i + 1}</span><span class="lbl grow">${label}</span>${ok ? "" : "<span class=\"muted\">→</span>"}</a>`).join("")}</div>
    </div>` : ""}
    <div class="card"><div class="row" style="margin-bottom:10px"><h2 class="grow" style="margin:0">Последние видео</h2><a href="#/projects" class="small">все проекты →</a></div>
      ${projects.length ? `<div class="grid">${projects.slice(0, 8).map(projectCard).join("")}</div>` : emptyState("🎬", "Пока нет ни одного видео", "Нажмите «➕ Новое видео» — директор выберет тему, команда сделает остальное.")}</div>
  `;
  $$("[data-new-video]").forEach((a) => a.onclick = (e) => { e.preventDefault(); openNewVideo(); });
};

function emptyState(icon, title, text) {
  return `<div class="empty"><div class="big">${icon}</div><b>${title}</b><div class="small" style="margin-top:4px">${text}</div>
    <button class="btn primary" style="margin-top:14px" onclick="openNewVideo()">➕ Новое видео</button></div>`;
}

function modelsChecked() {
  try { return localStorage.getItem("tf-models-ok") === "1"; } catch { return false; }
}

function projectTitle(pid) {
  return (cache.projects.find((p) => p.id === pid) || {}).title || pid;
}

function projectCard(p) {
  const ch = cache.channels.find((c) => c.id === p.channel_id);
  const running = Object.entries(p.stages).find(([, s]) => s.status === "running");
  const err = Object.entries(p.stages).find(([, s]) => s.status === "error");
  let status = '<span class="badge">черновик</span>';
  if (p.youtube) status = '<span class="badge ok">на YouTube</span>';
  else if (p.output) status = '<span class="badge ok">видео готово</span>';
  if (running) status = `<span class="badge run">${STAGE_NAMES[running[0]]} ${running[1].progress}%</span>`;
  else if (p.busy) status = '<span class="badge run">в очереди</span>';
  else if (err) status = `<span class="badge err">ошибка: ${STAGE_NAMES[err[0]]}</span>`;
  return `<div class="card project-card" onclick="location.hash='#/project/${p.id}'">
    <div class="thumb" style="background-image:url('${media(p.id, p.thumbnail)}')"></div>
    <div class="body"><h3>${esc(p.title)}</h3>
      <div class="row small muted">${status}<span>${p.scenes} сцен</span>${p.cost?.total ? `<span>💰 ${money(p.cost.total)}</span>` : ""}${p.duration ? `<span>${(p.duration / 60).toFixed(1)} мин</span>` : ""}${ch ? `<span>📺 ${esc(ch.name)}</span>` : ""}</div>
    </div></div>`;
}

pages.projects = async () => {
  view.innerHTML = `
    <div class="card row"><div class="col grow" style="gap:2px"><h1>Проекты</h1><div class="muted small">${cache.projects.length} видео · потрачено ${money(cache.projects.reduce((a, p) => a + (p.cost?.total || 0), 0))}</div></div>
      <button class="btn" onclick="location.hash='#/scenarist'">✨ По видео конкурента</button></div>
    ${cache.projects.length ? `<div class="grid">${cache.projects.map(projectCard).join("")}</div>`
      : `<div class="card">${emptyState("🎬", "Проектов пока нет", "Создайте первое видео — это займёт 5–10 минут.")}</div>`}`;
};

pages.scenarist = async () => {
  view.innerHTML = `
    <div class="card muted">Вставьте ссылку на видео конкурента с миллионами просмотров — аналитик разберёт его и предложит идеи. Или просто укажите нишу.</div>
    <div class="card form">
      <label class="wide">Ссылка на YouTube-видео (референс)<input id="sc-url" placeholder="https://www.youtube.com/watch?v=..."></label>
      <label class="wide">…или текст / сценарий референса<textarea id="sc-text" placeholder="Можно вставить транскрипт или описание"></textarea></label>
      <label>Ниша<input id="sc-niche" placeholder="например: history of ancient people"></label>
      <label>Канал<select id="sc-channel"><option value="">— без канала —</option>${options(cache.channels.map((c) => [c.id, c.name]))}</select></label>
      <label>Сколько идей<input id="sc-count" type="number" value="8" min="1" max="20"></label>
      <div class="wide row"><button class="btn primary" id="sc-go">✨ Разбери референс и предложи идеи</button><span id="sc-wait"></span></div>
    </div>
    <div id="sc-result"></div>`;
  $("#sc-channel").onchange = (e) => {
    const ch = cache.channels.find((c) => c.id === e.target.value);
    if (ch && !$("#sc-niche").value) $("#sc-niche").value = ch.niche || "";
  };
  $("#sc-go").onclick = (e) => guard(async () => {
    $("#sc-wait").innerHTML = '<div class="spinner"></div>';
    try {
      const res = await api("/api/scenarist/analyze", {
        body: { url: $("#sc-url").value, text: $("#sc-text").value, niche: $("#sc-niche").value, count: +$("#sc-count").value },
      });
      renderIdeas(res);
    } finally { $("#sc-wait").innerHTML = ""; }
  }, e.target);
};

function renderIdeas(res) {
  const channelId = $("#sc-channel").value;
  const ref = res.reference;
  $("#sc-result").innerHTML = `
    ${ref ? `<div class="card row"><img src="${esc(ref.thumbnail)}" style="width:160px;border-radius:10px">
      <div class="col grow"><h3>${esc(ref.title)}</h3><div class="muted small">${esc(ref.channel)} · ${(ref.views || 0).toLocaleString()} просмотров · ${Math.round((ref.duration || 0) / 60)} мин · транскрипт: ${ref.transcript ? "есть" : "нет"}</div></div></div>` : ""}
    <div class="card"><h2>Разбор</h2><div class="pre">${esc(res.analysis)}</div>
      ${res.style ? `<div class="muted small" style="margin-top:8px">Стиль картинок: ${esc(res.style)}</div>` : ""}</div>
    <div class="grid-2">${(res.ideas || []).map((idea, i) => `
      <div class="card col">
        <h3>${esc(idea.title)}</h3>
        <div class="small">${esc(idea.idea)}</div>
        ${idea.hook ? `<div class="small muted">Хук: «${esc(idea.hook)}»</div>` : ""}
        ${idea.why ? `<div class="small muted">💡 ${esc(idea.why)}</div>` : ""}
        <div class="row"><button class="btn sm primary" data-i="${i}" data-start="1">Создать и запустить</button>
          <button class="btn sm" data-i="${i}">Создать проект</button></div>
      </div>`).join("")}</div>`;
  $$("#sc-result [data-i]").forEach((btn) => btn.onclick = () => guard(async () => {
    const idea = res.ideas[btn.dataset.i];
    const ch = cache.channels.find((c) => c.id === channelId);
    const p = await api("/api/projects", {
      body: {
        idea: `${idea.title}. ${idea.idea}${idea.hook ? ` Hook: ${idea.hook}` : ""}`,
        title: idea.title, channel_id: channelId || null, reference: res.reference_text || "",
        style: (ch && ch.style) || res.style || "", start: !!btn.dataset.start,
      },
    });
    location.hash = `#/project/${p.id}`;
  }, btn));
}

// ---------------- project ----------------

let projectTab = "scenes";

pages.project = async (pid) => {
  const p = await api(`/api/projects/${pid}`);
  renderProject(p);
  pollTimer = setInterval(async () => {
    const fresh = await api(`/api/projects/${pid}`).catch(() => null);
    if (!fresh) return;
    const active = document.activeElement;
    const editing = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
    if (fresh.busy || fresh.updated_at !== p.updated_at) {
      updateProgress(fresh);
      if (!editing && fresh.updated_at !== p.updated_at) { Object.assign(p, fresh); renderProject(p, true); }
    }
  }, 2000);
};

const STEP_STATUS = { done: "готово", running: "идёт", error: "ошибка", stale: "устарело", idle: "ждёт" };

function stepHTML(p, k, st) {
  const locked = p.busy || (!p.script && k !== "script");
  const label = st.status === "running" ? `идёт · ${st.progress}%` : STEP_STATUS[st.status] || st.status;
  return `<div class="step ${st.status} ${locked ? "locked" : ""}" id="stage-${k}" data-step="${k}"
    title="${locked ? "" : st.status === "done" ? "Нажмите, чтобы переделать этап" : "Нажмите, чтобы запустить этап"}">
    <div class="n">${STAGE_NAMES[k]}</div><div class="st">${label}</div>
    <div class="fill" style="width:${st.status === "idle" ? 0 : st.progress}%"></div></div>`;
}

function updateProgress(p) {
  for (const [k, st] of Object.entries(p.stages)) {
    const el = $(`#stage-${k}`);
    if (el) el.outerHTML = stepHTML(p, k, st);
  }
}

function renderProject(p, keepScroll = false) {
  const y = window.scrollY;
  setTitle("🎬 Проект");
  const sc = p.script;
  const chOptions = `<option value="">— без канала —</option>` + options(cache.channels.map((c) => [c.id, c.name]), p.channel_id);
  view.innerHTML = `
    <div class="card row">
      <div class="col grow"><h1>${esc(p.title)}</h1><div class="muted small">Создан ${esc(p.created_at)} · обновлён ${esc(p.updated_at)}</div></div>
      ${p.busy ? `<button class="btn danger" id="p-stop">■ Стоп</button>` : ""}
      <button class="btn primary" id="p-run" ${p.busy ? "disabled" : ""}>▶ ${sc ? "Продолжить генерацию" : "Запустить генерацию"}</button>
      <button class="btn danger sm" id="p-del">Удалить</button>
    </div>

    <div class="card">
      <div class="stepper">${Object.entries(p.stages).map(([k, st]) => stepHTML(p, k, st)).join("")}</div>
      ${Object.entries(p.stages).filter(([, st]) => st.status === "error").map(([k, st]) =>
        `<div class="alert" style="margin-top:10px">⚠️ <b>${STAGE_NAMES[k]}</b>: ${esc(st.error || "")}<div class="small muted" style="margin-top:4px">Нажмите «▶ Продолжить генерацию» — софт продолжит с места ошибки.</div></div>`).join("")}
    </div>

    ${costCard(p)}

    <details class="card" ${sc ? "" : "open"}>
      <summary><b>Настройки проекта</b></summary>
      <div class="form" style="margin-top:12px">
        <label class="wide">Идея<textarea id="f-idea">${esc(p.idea)}</textarea></label>
        <label>Канал<select id="f-channel_id">${chOptions}</select></label>
        <label>Язык озвучки<select id="f-language">${options(LANGUAGES, p.language)}</select></label>
        <label>Голос<select id="f-voice">${voiceOptions(p.voice)}</select></label>
        <label>Кол-во сцен <span id="f-est" class="badge">~${money(p.estimate?.total)}</span><input id="f-scene_count" type="number" min="1" max="200" value="${p.scene_count}"></label>
        <label>Ритм кадров<select id="f-pacing">${options([["calm", "Спокойный: кадр на 2-4 фразы"], ["dynamic", "Динамичный: кадр на каждую фразу"]], p.pacing)}</select></label>
        <label>Формат<select id="f-aspect">${options([["16:9", "16:9 — обычное видео"], ["9:16", "9:16 — Shorts"]], p.aspect)}</select></label>
        <label>Доступ на YouTube<select id="f-privacy">${options([["private", "Приватное"], ["unlisted", "По ссылке"], ["public", "Публичное"]], p.privacy)}</select></label>
        <label>Отложенная публикация (UTC)<input id="f-publish_at" placeholder="2026-10-26T15:00:00Z" value="${esc(p.publish_at || "")}"></label>
        <label class="wide">Стиль картинок (English)<textarea id="f-style">${esc(p.style)}</textarea></label>
        <label class="check"><input type="checkbox" id="f-auto_upload" ${p.auto_upload ? "checked" : ""}> Загрузить на YouTube после сборки</label>
        <div class="wide"><button class="btn" id="p-save">Сохранить настройки</button>
          <span class="muted small">Сцены/язык/ритм применяются при новом сценарии (этап «Сценарий» → ↻ заново).</span></div>
      </div>
    </details>

    ${p.director || p.review ? `<div class="grid-2">
      ${p.director ? `<div class="card"><h2>👔 Решение директора</h2><div class="small pre">${esc(p.director.decision || "")}</div>
        ${p.director.notes_for_team ? `<div class="small muted" style="margin-top:6px">Команде: ${esc(p.director.notes_for_team)}</div>` : ""}</div>` : ""}
      ${p.review ? `<div class="card"><h2>🧐 Шеф-редактор: ${esc(p.review.score)}/10${p.review.originality ? ` · уникальность ${esc(p.review.originality)}/10` : ""}${p.review.rewritten ? ' <span class="badge warn">сценарий переписан</span>' : ""}</h2>
        ${p.review.monetization_risk ? `<div class="small" style="margin-bottom:4px">💵 Риск для монетизации: ${esc(p.review.monetization_risk)}</div>` : ""}
        <div class="small">${esc(p.review.verdict || "")}</div>
        ${(p.review.problems || []).length ? `<div class="small muted" style="margin-top:6px">${p.review.problems.map((x) => "• " + esc(x)).join("<br>")}</div>` : ""}</div>` : ""}
    </div>` : ""}
    ${sc ? `
    <div class="card row">
      <div class="tabs grow">${[["scenes", `Сцены (${sc.scenes.length})`], ["characters", `Персонажи (${sc.characters.length})`], ["video", "Видео и YouTube"], ["log", "Журнал"]]
        .map(([k, n]) => `<button class="btn sm ${projectTab === k ? "active" : ""}" data-tab="${k}">${n}</button>`).join("")}</div>
      ${projectTab === "scenes" ? `<button class="btn sm" id="p-save-scenes">💾 Сохранить правки сцен</button>` : ""}
    </div>
    <div id="tab">${renderTab(p)}</div>` : `<div class="card"><h2>Журнал</h2><div class="log">${esc(p.log.join("\n"))}</div></div>`}
  `;
  bindProject(p);
  if (keepScroll) window.scrollTo(0, y);
}

function renderTab(p) {
  const sc = p.script;
  if (projectTab === "scenes") {
    return `<div class="grid">${sc.scenes.map((s) => `
      <div class="card scene">
        <div class="thumb" data-zoom="${media(p.id, s.image)}">
          ${s.image ? `<img src="${media(p.id, s.image)}" loading="lazy">` : s.status === "running" ? '<div class="spinner"></div>' : '<span class="muted">нет кадра</span>'}
          <span class="badge num">Сцена ${s.idx + 1}${s.duration ? ` · ${s.duration.toFixed(1)}с` : ""}</span>
        </div>
        <div class="body">
          ${s.error ? `<div class="small" style="color:var(--err)">${esc(s.error)}</div>` : ""}
          <textarea data-scene="${s.idx}" data-field="narration" title="Текст озвучки">${esc(s.narration)}</textarea>
          <details><summary class="small muted">Промпт картинки</summary><textarea data-scene="${s.idx}" data-field="image_prompt">${esc(s.image_prompt)}</textarea></details>
          <div class="row">
            <button class="btn sm" data-regen="${s.idx}" data-what="image">🖼 Перерисовать</button>
            <button class="btn sm" data-regen="${s.idx}" data-what="audio">🔊 Переозвучить</button>
            ${s.audio ? `<button class="btn sm" data-play="${media(p.id, s.audio)}">▶</button>` : ""}
          </div>
        </div>
      </div>`).join("")}</div>`;
  }
  if (projectTab === "characters") {
    return `<div class="grid">${sc.characters.map((c, i) => `
      <div class="card scene">
        <div class="thumb" style="aspect-ratio:1" data-zoom="${media(p.id, c.image)}">${c.image ? `<img src="${media(p.id, c.image)}">` : '<span class="muted">нет изображения</span>'}</div>
        <div class="body"><h3>${esc(c.name)} <span class="muted small">(${esc(c.id)})</span></h3>
          <textarea data-char="${i}">${esc(c.description)}</textarea>
          <button class="btn sm" data-save-char="${i}">Сохранить описание</button></div>
      </div>`).join("") || '<div class="card muted">Без персонажей</div>'}</div>
      <div class="muted small" style="margin-top:8px">Картинка персонажа передаётся в модель как референс — так герой выглядит одинаково во всех сценах. После правки описания перезапустите этап «Персонажи», затем «Картинки».</div>`;
  }
  if (projectTab === "video") {
    return `<div class="grid-2">
      <div class="card col">
        <h2>Видео</h2>
        ${p.output ? `<video controls src="${media(p.id, p.output)}"></video>
          <div class="row"><a class="btn sm" href="${media(p.id, p.output)}" download="${esc(sc.title)}.mp4">⬇ Скачать MP4</a>
          ${p.duration ? `<span class="muted small">${(p.duration / 60).toFixed(1)} мин</span>` : ""}</div>` : '<div class="muted">Видео ещё не собрано</div>'}
        ${p.thumbnail ? `<h2 style="margin-top:12px">Превью</h2><img src="${media(p.id, p.thumbnail)}" style="width:100%;border-radius:10px">` : ""}
      </div>
      <div class="card col">
        <h2>YouTube</h2>
        <label>Заголовок<input id="y-title" value="${esc(sc.title)}"></label>
        <label>Описание<textarea id="y-desc" style="min-height:140px">${esc(sc.description)}</textarea></label>
        <label>Теги (через запятую)<input id="y-tags" value="${esc((sc.tags || []).join(", "))}"></label>
        ${(sc.title_variants || []).length ? `<div class="small muted">Варианты маркетолога: ${sc.title_variants.map((t) => `<a href="#" data-title="${esc(t)}">${esc(t)}</a>`).join(" · ")}</div>` : ""}
        <label>Текст на превью<input id="y-thumb" value="${esc(sc.thumbnail_text || "")}"></label>
        ${sc.pinned_comment ? `<label>Закреплённый комментарий<input readonly value="${esc(sc.pinned_comment)}"></label>` : ""}
        <div class="row">
          <button class="btn" id="y-save">Сохранить</button>
          <button class="btn primary" id="y-upload" ${!p.output || !p.channel_id || p.busy ? "disabled" : ""}>⬆ Загрузить на YouTube</button>
        </div>
        ${!p.channel_id ? '<div class="muted small">Выберите канал в настройках проекта.</div>' : ""}
        ${p.youtube ? `<div>✅ Загружено: <a href="${esc(p.youtube.url)}" target="_blank">${esc(p.youtube.url)}</a></div>` : ""}
      </div></div>`;
  }
  return `<div class="card"><div class="log">${esc(p.log.join("\n"))}</div></div>`;
}

function bindProject(p) {
  const pid = p.id;
  const reload = async () => { const fresh = await api(`/api/projects/${pid}`); Object.assign(p, fresh); renderProject(p, true); };
  const run = (stage, force) => guard(async () => {
    await api(`/api/projects/${pid}/run`, { body: { stage, force } });
    toast("Добавлено в очередь"); await reload();
  });
  $("#p-run").onclick = () => run("all", false);
  $("#p-stop") && ($("#p-stop").onclick = () => guard(async () => { await api(`/api/projects/${pid}/stop`, { body: {} }); toast("Останавливаю…"); }));
  $("#p-del").onclick = () => confirm("Удалить проект со всеми файлами?") && guard(async () => {
    await api(`/api/projects/${pid}`, { method: "DELETE" }); location.hash = "#/projects";
  });
  // Delegated: polling replaces the step elements, the container stays.
  $(".stepper").onclick = (e) => {
    const b = e.target.closest("[data-step]");
    if (!b || b.classList.contains("locked")) return;
    const k = b.dataset.step, done = b.classList.contains("done");
    if (confirm(`${done ? "Переделать" : "Запустить"} этап «${STAGE_NAMES[k]}»?${done ? "\nЭто снова потратит деньги на этот этап." : ""}`)) run(k, true);
  };
  $("#p-save").onclick = (e) => guard(async () => {
    const body = {};
    for (const k of ["idea", "channel_id", "language", "voice", "pacing", "aspect", "privacy", "publish_at", "style"]) body[k] = $(`#f-${k}`).value || null;
    body.idea = body.idea || "";
    body.style = body.style || "";
    body.scene_count = +$("#f-scene_count").value;
    body.auto_upload = $("#f-auto_upload").checked;
    await api(`/api/projects/${pid}`, { method: "PUT", body });
    toast("Сохранено"); await reload();
  }, e.target);
  $$("[data-tab]").forEach((b) => b.onclick = () => { projectTab = b.dataset.tab; renderProject(p, true); });
  $("#f-scene_count").oninput = async (e) => {
    const est = await api(`/api/estimate?scenes=${+e.target.value || 1}`).catch(() => null);
    if (est) $("#f-est").textContent = "~" + money(est.total);
  };
  $$("[data-zoom]").forEach((el) => el.dataset.zoom && $("img", el) && (el.onclick = () => lightbox(el.dataset.zoom)));
  $$("[data-play]").forEach((b) => b.onclick = () => new Audio(b.dataset.play).play());
  $$("[data-regen]").forEach((b) => b.onclick = () => guard(async () => {
    await saveScenes(p, false);
    b.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px"></div>';
    await api(`/api/projects/${pid}/scenes/${b.dataset.regen}/regenerate`, { body: { what: b.dataset.what } });
    await reload();
  }, b));
  $("#p-save-scenes") && ($("#p-save-scenes").onclick = () => guard(() => saveScenes(p, true)));
  $$("[data-save-char]").forEach((b) => b.onclick = () => guard(async () => {
    const characters = p.script.characters.map((c, i) => ({ description: i === +b.dataset.saveChar ? $(`[data-char="${i}"]`).value : null }));
    await api(`/api/projects/${pid}`, { method: "PUT", body: { script: { characters } } });
    toast("Сохранено"); await reload();
  }));
  $$("[data-title]").forEach((a) => a.onclick = (e) => { e.preventDefault(); $("#y-title").value = a.dataset.title; });
  $("#y-save") && ($("#y-save").onclick = () => guard(async () => { await saveMeta(p); toast("Сохранено"); await reload(); }));
  $("#y-upload") && ($("#y-upload").onclick = () => guard(async () => { await saveMeta(p); await run("upload", true); }));
}

async function saveScenes(p, notify) {
  const scenes = p.script.scenes.map((s) => ({
    narration: $(`[data-scene="${s.idx}"][data-field="narration"]`)?.value ?? null,
    image_prompt: $(`[data-scene="${s.idx}"][data-field="image_prompt"]`)?.value ?? null,
  }));
  await api(`/api/projects/${p.id}`, { method: "PUT", body: { script: { scenes } } });
  if (notify) toast("Сохранено. Изменённые фразы будут переозвучены при следующем запуске.");
}

function saveMeta(p) {
  return api(`/api/projects/${p.id}`, {
    method: "PUT",
    body: { title: $("#y-title").value, script: {
      title: $("#y-title").value, description: $("#y-desc").value,
      tags: $("#y-tags").value.split(",").map((t) => t.trim()).filter(Boolean), thumbnail_text: $("#y-thumb").value,
    } },
  });
}

// ---------------- company ----------------

pages.company = async () => {
  const draw = async () => {
    const c = await api("/api/company");
    const byDept = {};
    c.staff.forEach((a) => (byDept[a.department] ||= []).push(a));
    const reports = Object.entries(c.reports);
    view.innerHTML = `
      <div class="card row"><div class="col grow"><h1>🏢 Компания</h1>
        <div class="muted">Каждый сотрудник — отдельная ИИ-модель OpenRouter, лучшая в своём деле. Директор решает, что снимать, аналитик следит за просмотрами.</div></div>
        <div class="col" style="align-items:flex-end"><div class="muted small">Потрачено всего</div><div class="stat">${money(c.total_cost)}</div>
          <div class="muted small" id="c-est"></div></div></div>

      <div class="card row">
        <h2 class="grow" style="margin:0">👔 Планёрка</h2>
        <select id="c-channel" style="max-width:260px">${options(cache.channels.map((ch) => [ch.id, ch.name]))}</select>
        <button class="btn primary" id="c-plan" ${cache.channels.length ? "" : "disabled"}>Директор, что снимаем?</button>
        <button class="btn" id="c-analyze" ${cache.channels.length ? "" : "disabled"}>📊 Отчёт аналитика</button>
        <button class="btn sm" id="c-models">Загрузить список моделей</button>
        <button class="btn sm" id="c-check">✅ Проверить модели</button>
        <button class="btn sm" id="c-reset">⭐ Рекомендованные модели</button>
      </div>

      ${Object.entries(byDept).map(([dept, list]) => `
        <div class="card"><h2>${esc(dept)}</h2><div class="grid">${list.map((a) => `
          <div class="card col" style="background:rgba(5,15,40,.35)">
            <div class="row"><span style="font-size:24px">${a.emoji}</span><div class="col grow" style="gap:0"><b>${esc(a.name)}</b>
              <span class="muted small">${a.calls} задач · $${a.cost.toFixed(3)}</span></div></div>
            <div class="small muted">${esc(a.duty)}</div>
            ${a.kind === "tool" ? `<div class="small"><span class="badge">${a.role === "voice" ? "сервис озвучки из Настроек" : a.role === "animator" ? "ffmpeg" : "YouTube API"}</span></div>`
              : `<label>Модель${a.web ? ' <span class="badge">🌐 поиск в интернете</span>' : ""} <span data-check="${a.role}"></span><input data-model="${a.role}" list="${a.kind === "image" ? "m-image" : "m-text"}" value="${esc(a.model)}" placeholder="${esc(a.default_model)}"></label>`}
            ${a.last ? `<div class="small" title="${esc(a.last.time)}">💬 ${esc(a.last.text).slice(0, 140)}</div>` : ""}
          </div>`).join("")}</div></div>`).join("")}
      <datalist id="m-text"></datalist><datalist id="m-image"></datalist>
      <div class="row"><button class="btn primary" id="c-save">💾 Сохранить модели</button></div>

      ${reports.length ? `<div class="card"><h2>📊 Отчёты аналитика</h2>${reports.map(([cid, r]) => {
        const ch = cache.channels.find((x) => x.id === cid);
        return `<div class="card" style="background:rgba(5,15,40,.35);margin-bottom:10px">
          <div class="row"><b class="grow">${esc(ch ? ch.name : cid)}</b><span class="badge ok">лучшее время: ${(r.best_hours || []).join(":00, ")}:00</span><span class="muted small">${esc(r.time)}</span></div>
          <div class="small" style="margin-top:6px">${esc(r.summary || "")}</div>
          <div class="grid-2" style="margin-top:8px">
            <div class="small"><b>Заходит</b><br>${(r.what_works || []).map((x) => "• " + esc(x)).join("<br>")}</div>
            <div class="small"><b>Не заходит</b><br>${(r.what_fails || []).map((x) => "• " + esc(x)).join("<br>")}</div>
            <div class="small"><b>Рекомендации</b><br>${(r.recommendations || []).map((x) => "• " + esc(x)).join("<br>")}</div>
            <div class="small"><b>Следующие темы</b><br>${(r.next_topics || []).map((x) => "• " + esc(x)).join("<br>")}</div>
          </div></div>`;
      }).join("")}</div>` : ""}

      <div class="card"><h2>💬 Лента компании</h2><div class="log" id="c-feed">${feedText(c)}</div></div>`;
    bindCompany();
    api("/api/estimate?scenes=30").then((e) => $("#c-est") && ($("#c-est").textContent = `видео на 30 сцен ≈ ${money(e.total)}`)).catch(() => {});
  };
  const feedText = (c) => c.feed.map((f) => {
    const a = c.staff.find((x) => x.role === f.role);
    return `${esc(f.time.slice(5, 16))}  ${a ? a.emoji + " " + esc(a.name) : esc(f.role)}: ${esc(f.text)}`;
  }).join("\n") || "Пока тихо";

  function bindCompany() {
    $("#c-plan") && ($("#c-plan").onclick = (e) => guard(async () => {
      toast("Исследователь ищет тренды, директор выбирает…");
      const p = await api(`/api/channels/${$("#c-channel").value}/plan`, { body: { start: true } });
      location.hash = `#/project/${p.id}`;
    }, e.target));
    $("#c-analyze") && ($("#c-analyze").onclick = (e) => guard(async () => {
      await api(`/api/channels/${$("#c-channel").value}/analyze`, { body: {} });
      toast("Отчёт готов"); await draw();
    }, e.target));
    $("#c-models").onclick = (e) => guard(async () => {
      const models = await api("/api/models");
      $("#m-text").innerHTML = models.filter((m) => m.output.includes("text") && !m.output.includes("image")).map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
      $("#m-image").innerHTML = models.filter((m) => m.output.includes("image")).map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
      toast(`Моделей: ${models.length}. Начните вводить название в поле модели.`);
    }, e.target);
    $("#c-check").onclick = (e) => guard(async () => {
      const res = await api("/api/agents/check");
      let bad = 0;
      for (const [role, r] of Object.entries(res)) {
        const el = $(`[data-check="${role}"]`);
        if (!r.ok) bad++;
        if (el) el.innerHTML = r.ok ? `<span class="badge ok">есть в OpenRouter</span>` : `<span class="badge err">не найдена — выберите другую</span>`;
      }
      try { localStorage.setItem("tf-models-ok", bad ? "0" : "1"); } catch {}
      toast(bad ? `Не найдено моделей: ${bad}. Сначала сохраните изменения, потом проверьте снова.` : "Все модели есть в OpenRouter");
    }, e.target);
    $("#c-reset").onclick = (e) => confirm("Поставить всем сотрудникам рекомендованные модели (качество за свои деньги)?") && guard(async () => {
      await api("/api/agents/reset", { body: {} });
      toast("Готово: стоят рекомендованные модели"); await draw();
    }, e.target);
    $("#c-save").onclick = (e) => guard(async () => {
      const body = {};
      $$("[data-model]").forEach((el) => body[el.dataset.model] = el.value);
      await api("/api/agents", { method: "PUT", body });
      toast("Модели сохранены");
    }, e.target);
  }

  await draw();
  // Only the feed refreshes live, so edits in the model fields are not lost.
  pollTimer = setInterval(async () => {
    const c = await api("/api/company").catch(() => null);
    if (c && $("#c-feed")) $("#c-feed").innerHTML = feedText(c);
  }, 4000);
};

// ---------------- queue ----------------

pages.queue = async () => {
  const draw = async () => {
    const q = await api("/api/queue");
    const row = (j) => `<div class="row card" style="padding:10px">
      <a class="grow" href="#/project/${j.project_id}">${esc(projectTitle(j.project_id))}</a>
      <span class="badge">${j.stage === "all" ? "весь цикл" : STAGE_NAMES[j.stage]}</span>
      <span class="badge ${j.status === "done" ? "ok" : j.status === "error" ? "err" : j.status === "running" ? "run" : ""}">${j.status}</span>
      <span class="muted small">${esc(j.finished_at || j.started_at || j.queued_at)}</span>
      ${j.error ? `<div class="small" style="color:var(--err);width:100%">${esc(j.error)}</div>` : ""}</div>`;
    view.innerHTML = `
      <div class="card"><h1>Очередь</h1><div class="muted">Проекты обрабатываются по одному; картинки внутри проекта — параллельно.</div></div>
      <div class="card"><h2>Сейчас</h2>${q.current ? row(q.current) : '<div class="muted">Свободно</div>'}</div>
      <div class="card"><h2>Ожидают (${q.queued.length})</h2>${q.queued.map(row).join("") || '<div class="muted">Пусто</div>'}</div>
      <div class="card"><h2>История</h2>${q.history.map(row).join("") || '<div class="muted">Пусто</div>'}</div>`;
  };
  await draw();
  pollTimer = setInterval(() => draw().catch(() => {}), 3000);
};

// ---------------- channels ----------------

pages.channels = async () => {
  cache.styles = await api("/api/styles").catch(() => []);
  view.innerHTML = `
    <div class="card row"><div class="col grow"><h1>Каналы</h1>
      <div class="muted">У каждого канала своя ниша, стиль и голос. Автопилот сам придумывает идеи, делает видео и загружает их по расписанию.</div></div>
      <button class="btn primary" id="ch-new">+ Канал</button></div>
    <div class="col" id="ch-list">${cache.channels.map(channelForm).join("") || '<div class="card muted">Каналов пока нет</div>'}</div>`;
  $("#ch-new").onclick = () => guard(async () => { await api("/api/channels", { body: { name: `Канал ${cache.channels.length + 1}` } }); await reroute(); });
  bindChannels();
};

function channelForm(c) {
  return `<div class="card" data-ch="${c.id}">
    <div class="row" style="margin-bottom:12px"><h2 class="grow" style="margin:0">📺 ${esc(c.name)}</h2>
      ${c.connected ? `<span class="badge ok">YouTube подключён${c.youtube ? `: ${esc(c.youtube.title)}` : ""}</span>` : '<span class="badge warn">YouTube не подключён</span>'}
      <button class="btn sm" data-connect>${c.connected ? "Переподключить" : "Подключить YouTube"}</button>
      <button class="btn sm danger" data-del>Удалить</button></div>
    <div class="form">
      <label>Название<input data-k="name" value="${esc(c.name)}"></label>
      <label class="wide">Ниша (для автопилота и идей)<input data-k="niche" value="${esc(c.niche)}" placeholder="например: how ancient people survived, animated explainer"></label>
      <label>Язык<select data-k="language">${options(LANGUAGES, c.language)}</select></label>
      <label>Голос<select data-k="voice">${voiceOptions(c.voice)}</select></label>
      <label>Сцен в видео<input data-k="scene_count" type="number" value="${c.scene_count}"></label>
      <label>Ритм<select data-k="pacing">${options([["calm", "Спокойный"], ["dynamic", "Динамичный"]], c.pacing)}</select></label>
      <label>Формат<select data-k="aspect">${options([["16:9", "16:9"], ["9:16", "9:16 Shorts"]], c.aspect)}</select></label>
      <label>Доступ<select data-k="privacy">${options([["private", "Приватное"], ["unlisted", "По ссылке"], ["public", "Публичное"]], c.privacy)}</select></label>
      <label class="wide">Стиль картинок (English)<textarea data-k="style" placeholder="simple flat 2D cartoon, thick outlines, muted warm colors">${esc(c.style)}</textarea></label>
      <label class="check"><input type="checkbox" data-k="autopilot" ${c.autopilot ? "checked" : ""}> Автопилот</label>
      <label>Видео в день<input data-k="videos_per_day" type="number" min="1" max="10" value="${c.videos_per_day}"></label>
      <label>Часы публикации (локальные, через запятую)<input data-k="publish_hours" value="${(c.publish_hours || []).join(", ")}"></label>
      <label class="check"><input type="checkbox" data-k="auto_schedule" ${c.auto_schedule !== false ? "checked" : ""}> Аналитик сам выбирает лучшее время${c.best_hours?.length ? ` (сейчас: ${c.best_hours.join(", ")})` : ""}</label>
      <div class="wide row"><button class="btn primary" data-save>Сохранить</button>
        <button class="btn" data-plan>👔 Директор, сними видео</button>
        <button class="btn" data-analyze ${c.connected ? "" : "disabled"}>📊 Отчёт аналитика</button></div>
    </div>
    ${brandBlock(c)}
  </div>`;
}

function brandBlock(c) {
  const b = c.brand;
  const ver = encodeURIComponent(b?.time || "");
  return `<div class="card" style="margin-top:14px;background:rgba(5,15,40,.35)">
    <div class="row" style="margin-bottom:10px"><h2 class="grow" style="margin:0">🖋 Стилист канала</h2>
      ${b ? `<span class="badge ok">${esc(b.style_name || "стиль готов")}</span>` : '<span class="badge">стиль не задан</span>'}</div>
    <div class="form">
      <label>Готовый стиль<select data-preset><option value="">— пусть стилист решит —</option>${options((cache.styles || []).map((x) => [x.id, x.name]), b?.preset)}</select></label>
      <label class="wide">Пожелания или описание примера<textarea data-wish placeholder="например: как на канале с человечками-палочками про древних людей, бумажный фон, красные надписи маркером"></textarea></label>
      <div class="wide muted small" data-preset-about></div>
      <div class="wide"><button class="btn primary" data-stylist>🖋 ${b ? "Переоформить канал" : "Оформить канал"}</button>
        <span class="muted small">Стилист задаст стиль кадров и героя, нарисует шапку и аватар (~$0.15)</span></div>
    </div>
    ${b ? `
      <div style="margin-top:14px;position:relative">
        <img src="/channel-media/${c.id}/banner.jpg?v=${ver}" style="width:100%;max-height:240px;object-fit:cover;border-radius:12px;display:block;cursor:zoom-in" data-zoom-src="/channel-media/${c.id}/banner.jpg?v=${ver}">
        <img src="/channel-media/${c.id}/avatar.jpg?v=${ver}" style="position:absolute;left:18px;bottom:-28px;width:96px;height:96px;border-radius:50%;border:4px solid #0f2252" data-zoom-src="/channel-media/${c.id}/avatar.jpg?v=${ver}">
      </div>
      <div class="grid-2" style="margin-top:40px">
        <div class="col small">
          <div><b>Почему этот стиль:</b> ${esc(b.why || "")}</div>
          <div class="row">${(b.palette || []).map((h) => `<span title="${esc(h)}" style="width:28px;height:28px;border-radius:8px;background:${esc(h)};border:1px solid var(--border)"></span>`).join("")}</div>
          ${b.hero ? `<div><b>Герой канала:</b> ${esc(b.hero.name || "")} — <span class="muted">${esc(b.hero.description || "")}</span></div>` : ""}
          <div><b>Правила превью:</b><br>${(b.thumbnail_rules || []).map((x) => "• " + esc(x)).join("<br>")}</div>
        </div>
        <div class="col small">
          <div><b>Названия для канала:</b> ${(b.channel_names || []).map(esc).join(" · ")}</div>
          <label>Описание канала (вставьте в YouTube Studio → Настройка канала)<textarea readonly style="min-height:110px">${esc(b.description || "")}</textarea></label>
          <div><b>Ключевые слова:</b> <span class="muted">${(b.keywords || []).map(esc).join(", ")}</span></div>
          <div class="muted">Шапку и аватар скачайте (клик → правой кнопкой «Сохранить») и загрузите в YouTube Studio → Настройка канала → Брендинг.</div>
        </div>
      </div>` : ""}
  </div>`;
}

function bindChannels() {
  $$("[data-ch]").forEach((card) => {
    const id = card.dataset.ch;
    $("[data-save]", card).onclick = (e) => guard(async () => {
      const body = { id };
      $$("[data-k]", card).forEach((el) => {
        const k = el.dataset.k;
        if (el.type === "checkbox") body[k] = el.checked;
        else if (el.type === "number") body[k] = +el.value;
        else if (k === "publish_hours") body[k] = el.value.split(",").map((x) => parseInt(x, 10)).filter((x) => x >= 0 && x < 24);
        else body[k] = el.value;
      });
      await api("/api/channels", { body });
      toast("Канал сохранён"); await reroute();
    }, e.target);
    $("[data-del]", card).onclick = () => confirm("Удалить канал?") && guard(async () => { await api(`/api/channels/${id}`, { method: "DELETE" }); await reroute(); });
    const presetSel = $("[data-preset]", card);
    const showAbout = () => { const x = (cache.styles || []).find((st) => st.id === presetSel.value); $("[data-preset-about]", card).textContent = x ? x.about : ""; };
    presetSel.onchange = showAbout; showAbout();
    $$("[data-zoom-src]", card).forEach((img) => img.onclick = () => lightbox(img.dataset.zoomSrc));
    $("[data-stylist]", card).onclick = (e) => guard(async () => {
      e.target.textContent = "🖋 Стилист работает… (около минуты)";
      await api(`/api/channels/${id}/stylist`, { body: { preset: presetSel.value || null, wish: $("[data-wish]", card).value } });
      toast("Канал оформлен: стиль кадров, герой, шапка и аватар готовы"); await reroute();
    }, e.target);
    $("[data-plan]", card).onclick = (e) => guard(async () => {
      toast("Планёрка: исследователь ищет тренды, директор выбирает…");
      const p = await api(`/api/channels/${id}/plan`, { body: { start: true } });
      location.hash = `#/project/${p.id}`;
    }, e.target);
    $("[data-analyze]", card).onclick = (e) => guard(async () => {
      await api(`/api/channels/${id}/analyze`, { body: {} });
      location.hash = "#/company";
    }, e.target);
    $("[data-connect]", card).onclick = () => guard(async () => {
      const r = await api(`/api/channels/${id}/connect`, { body: {} });
      toast(r.message);
    });
  });
}

// ---------------- niches ----------------

pages.niches = async () => {
  view.innerHTML = `
    <div class="card"><h1>Поиск ниш</h1><div class="muted">ИИ предложит ниши для faceless-каналов с высоким RPM (США, Европа).</div></div>
    <div class="card row"><input class="grow" id="n-q" placeholder="например: мультяшные объяснения финансов / история / психология" style="flex:1">
      <button class="btn primary" id="n-go">🔎 Найти</button><span id="n-wait"></span></div>
    <div class="grid-2" id="n-res"></div>`;
  $("#n-go").onclick = (e) => guard(async () => {
    $("#n-wait").innerHTML = '<div class="spinner"></div>';
    try {
      const res = await api("/api/niches", { body: { query: $("#n-q").value } });
      $("#n-res").innerHTML = (res.niches || []).map((n, i) => `
        <div class="card col"><h3>${esc(n.name)}</h3><div class="small">${esc(n.description)}</div>
          <div class="row small"><span class="badge ok">RPM ${esc(n.rpm)}</span><span class="badge">конкуренция: ${esc(n.competition)}</span><span class="badge">${esc(n.format)}</span></div>
          <div class="small muted">Аудитория: ${esc(n.audience)}</div>
          <div class="small">${(n.example_titles || []).map((t) => `• ${esc(t)}`).join("<br>")}</div>
          <div><button class="btn sm primary" data-n="${i}">+ Создать канал с этой нишей</button></div></div>`).join("");
      $$("[data-n]").forEach((b) => b.onclick = () => guard(async () => {
        const n = res.niches[b.dataset.n];
        await api("/api/channels", { body: { name: n.name, niche: `${n.name}: ${n.description}`, style: n.style || "" } });
        toast("Канал создан"); location.hash = "#/channels";
      }));
    } finally { $("#n-wait").innerHTML = ""; }
  }, e.target);
};

// ---------------- settings ----------------

pages.settings = async () => {
  const s = cache.settings;
  view.innerHTML = `
    <div class="card" id="sys-box"><h2>🖥 Ноутбук и модули</h2><div class="muted small">Проверяю ноутбук…</div></div>
    
    <div class="card form">
      <h2 class="wide">ИИ (OpenRouter)</h2>
      <div class="wide muted small">Один ключ <a href="https://openrouter.ai/keys" target="_blank">OpenRouter</a> даёт доступ к Claude, GPT, Gemini и моделям картинок.</div>
      <label class="wide">OpenRouter API key<input id="s-openrouter_api_key" value="${esc(s.openrouter_api_key)}" placeholder="sk-or-v1-..."></label>
      <div class="wide muted small">Модели для каждого сотрудника выбираются на странице <a href="#/company">Компания</a>.</div>
      <label>Параллельных картинок<input id="s-image_workers" type="number" min="1" max="16" value="${s.image_workers}"></label>
      <label class="check"><input type="checkbox" id="s-demo_mode" ${s.demo_mode ? "checked" : ""}> Демо-режим (без ИИ, заглушки)</label>

      <h2 class="wide">Озвучка</h2>
      <label>Сервис<select id="s-tts_provider">${options([["edge", "Edge TTS — бесплатно"], ["kokoro", "Kokoro — бесплатно, на ноутбуке"], ["openrouter", "OpenRouter TTS (тот же ключ)"], ["openai", "OpenAI TTS"], ["elevenlabs", "ElevenLabs"]], s.tts_provider)}</select></label>
      <label>Модель OpenRouter TTS<input id="s-openrouter_tts_model" value="${esc(s.openrouter_tts_model)}"></label>
      <label>OpenAI API key<input id="s-openai_api_key" value="${esc(s.openai_api_key)}"></label>
      <label>ElevenLabs API key<input id="s-elevenlabs_api_key" value="${esc(s.elevenlabs_api_key)}"></label>
      <div class="wide muted small">Для ElevenLabs в поле «Голос» у канала/проекта укажите voice_id.</div>

      <h2 class="wide">Монтаж</h2>
      <label class="check"><input type="checkbox" id="s-subtitles" ${s.subtitles ? "checked" : ""}> Субтитры в видео</label>
      <label class="check"><input type="checkbox" id="s-ken_burns" ${s.ken_burns ? "checked" : ""}> Движение камеры (Ken Burns)</label>
      <label>FPS<input id="s-fps" type="number" value="${s.fps}"></label>
      <label class="wide">Фоновая музыка: путь к mp3 или к папке с треками (каждому видео — случайный)<input id="s-background_music" value="${esc(s.background_music)}" placeholder="C:\\Users\\User\\Music\\youtube"></label>
      <div class="wide muted small">Бесплатная музыка без авторских проблем: YouTube Studio → Фонотека (Audio Library). Скачайте 10–20 спокойных треков в одну папку.</div>
      <label>Громкость музыки<input id="s-music_volume" type="number" step="0.01" value="${s.music_volume}"></label>

      <h2 class="wide">YouTube</h2>
      <label class="wide">Файл OAuth-клиента Google (client_secret.json)<input id="s-youtube_client_secret" value="${esc(s.youtube_client_secret)}"></label>
      <div class="wide"><button class="btn primary" id="s-save">Сохранить</button></div>
    </div>`;
  const drawSys = async () => {
    const r = await api("/api/system").catch(() => null);
    if (!r || !$("#sys-box")) return false;
    const yes = (v) => v ? '<span class="badge ok">есть</span>' : '<span class="badge err">нет</span>';
    const installing = Object.values(r.modules).some((m) => m.install?.status === "running");
    $("#sys-box").innerHTML = `<h2>🖥 Ноутбук и модули</h2>
      <div class="grid stats" style="margin-bottom:12px">
        <div><div class="muted small">Видеокарта</div><b>${r.gpu ? `${esc(r.gpu.name)} · ${r.gpu.vram_gb} ГБ` : "нет NVIDIA (работаем на процессоре)"}</b></div>
        <div><div class="muted small">Память</div><b>${r.ram_gb ?? "?"} ГБ</b></div>
        <div><div class="muted small">Свободно на диске</div><b>${r.disk_free_gb} ГБ</b></div>
        <div><div class="muted small">Python / ffmpeg</div><b>${esc(r.python)}</b> ${yes(r.ffmpeg)}</div>
      </div>
      <div class="col">${Object.entries(r.modules).map(([k, m]) => `
        <div class="row card" style="padding:12px;background:rgba(5,15,40,.35)">
          <div class="col grow" style="gap:2px"><b>${esc(m.name)}</b><span class="muted small">${esc(m.about)}</span>
            ${m.install?.status === "running" ? `<pre class="log" style="max-height:110px;margin-top:6px">${esc(m.install.log || "устанавливаю…")}</pre>` : ""}
            ${m.install?.status === "error" ? `<pre class="log" style="max-height:110px;margin-top:6px;color:var(--err)">${esc(m.install.log)}</pre>` : ""}</div>
          ${m.installed ? '<span class="badge ok">установлен</span>'
            : m.install?.status === "running" ? '<div class="spinner"></div>'
            : `<button class="btn sm primary" data-install="${k}">Установить</button>`}
        </div>`).join("")}</div>
      ${!r.ffmpeg ? '<div class="alert" style="margin-top:10px">Нет ffmpeg — видео не соберётся. В PowerShell: <code>winget install Gyan.FFmpeg</code>, потом перезапустите софт.</div>' : ""}`;
    $$("[data-install]").forEach((b) => b.onclick = () => guard(async () => {
      await api(`/api/system/install/${b.dataset.install}`, { body: {} }); drawSys();
    }, b));
    return installing;
  };
  const sysLoop = async () => { if (await drawSys()) pollTimer = setTimeout(sysLoop, 2500); };
  sysLoop();
  $("#s-save").onclick = (e) => guard(async () => {
    const body = {};
    $$("[id^='s-']").forEach((el) => {
      const k = el.id.slice(2);
      if (el.tagName === "BUTTON") return;
      if (el.type === "checkbox") body[k] = el.checked;
      else if (el.type === "number") body[k] = +el.value;
      else body[k] = el.value;
    });
    await api("/api/settings", { method: "PUT", body });
    toast("Настройки сохранены"); await reroute();
  }, e.target);
};

// ---------------- shell: title, live job, new-video wizard ----------------

const PAGE_TITLES = {
  home: "🏠 Главная", company: "🏢 Компания", projects: "🎬 Проекты", queue: "⏳ Очередь",
  scenarist: "✨ AI-сценарист", channels: "📺 Каналы", niches: "🔎 Поиск ниш", settings: "⚙️ Настройки",
};

function setTitle(text) {
  $("#topbar-title").textContent = text;
  document.title = text.replace(/^\S+\s/, "") + " — TubeFactory";
}

function drawLiveJob() {
  const q = cache.queue;
  const box = $("#live-job");
  if (!q || !q.current) { box.innerHTML = ""; return; }
  const p = cache.projects.find((x) => x.id === q.current.project_id);
  const running = p && Object.entries(p.stages).find(([, st]) => st.status === "running");
  const pct = running ? running[1].progress : 0;
  box.innerHTML = `<div class="live" onclick="location.hash='#/project/${q.current.project_id}'">
    <div class="t"><span class="pulse"></span>${esc(p ? p.title : "Видео")}</div>
    <div class="s">${running ? STAGE_NAMES[running[0]] + " · " + pct + "%" : "готовится…"}${q.queued.length ? ` · ещё ${q.queued.length} в очереди` : ""}</div>
    <div class="bar"><div style="width:${pct}%"></div></div></div>`;
}

// Keeps the sidebar job widget and counters fresh on every page.
setInterval(async () => {
  const [queue, projects] = await Promise.all([api("/api/queue"), api("/api/projects")]).catch(() => [null, null]);
  if (!queue) return;
  Object.assign(cache, { queue, projects });
  $("#nav-queue").textContent = queue.queued.length + (queue.current ? 1 : 0);
  $("#nav-projects").textContent = projects.length;
  drawLiveJob();
}, 4000);

function closeModal() { $("#modal-root").innerHTML = ""; }
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); $$(".lightbox").forEach((x) => x.remove()); }
});

// Average narration per scene: calm = 2-4 sentences, dynamic = one phrase.
const SECONDS_PER_SCENE = { calm: 11, dynamic: 4 };

function sceneMinutes(ch) {
  const m = Math.round((ch.scene_count || 20) * SECONDS_PER_SCENE[ch.pacing || "calm"] / 60);
  return Math.min(20, Math.max(3, m));
}

function openNewVideo() {
  if (!cache.channels.length) {
    toast("Сначала создайте канал: у него ниша, стиль и голос для видео");
    location.hash = "#/channels";
    return;
  }
  const ch0 = cache.channels[0];
  $("#modal-root").innerHTML = `<div class="modal-back" id="nv-back"><div class="modal">
    <h2>➕ Новое видео</h2>
    <div class="col" style="gap:14px">
      <label>Канал<select id="nv-channel">${options(cache.channels.map((c) => [c.id, c.name]))}</select></label>
      <div class="choice">
        <label><input type="radio" name="nv-mode" value="director" checked><span><b>👔 Тему выберет директор</b><br><span class="muted small">Исследователь найдёт тренды, директор выберет лучшее</span></span></label>
        <label><input type="radio" name="nv-mode" value="idea"><span><b>💡 Своя идея</b><br><span class="muted small">Опишите тему видео сами</span></span></label>
      </div>
      <label id="nv-idea-box" style="display:none">Идея видео (лучше на английском)<textarea id="nv-idea" placeholder="How ancient people navigated without maps"></textarea></label>
      <div class="col" style="gap:6px"><div class="slider-label">Длина видео: <b id="nv-min"></b> мин · <b id="nv-n"></b> сцен</div>
        <input type="range" id="nv-len" min="3" max="20" step="1" value="${sceneMinutes(ch0)}"></div>
      <div class="est-box"><div><div class="muted small">Оценка стоимости</div><div class="small muted" id="nv-est-note">тексты + картинки, озвучка бесплатно</div></div><div class="stat" id="nv-est">…</div></div>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="nv-cancel">Отмена</button><button class="btn primary big" id="nv-go">🚀 Запустить</button></div>
    </div></div></div>`;
  const chosen = () => cache.channels.find((c) => c.id === $("#nv-channel").value) || ch0;
  const scenesFor = (min) => Math.max(3, Math.round(min * 60 / SECONDS_PER_SCENE[chosen().pacing || "calm"]));
  const upd = async () => {
    const min = +$("#nv-len").value, n = scenesFor(min);
    $("#nv-min").textContent = min;
    $("#nv-n").textContent = n;
    const e = await api(`/api/estimate?scenes=${n}`).catch(() => null);
    if (e) $("#nv-est").textContent = "~" + money(e.total);
  };
  $("#nv-len").oninput = upd;
  $("#nv-channel").onchange = () => { $("#nv-len").value = sceneMinutes(chosen()); upd(); };
  $$("[name=nv-mode]").forEach((r) => r.onchange = () => { $("#nv-idea-box").style.display = r.value === "idea" && r.checked ? "" : "none"; });
  $("#nv-cancel").onclick = closeModal;
  $("#nv-back").onclick = (e) => { if (e.target.id === "nv-back") closeModal(); };
  $("#nv-go").onclick = (e) => guard(async () => {
    const cid = $("#nv-channel").value, scene_count = scenesFor(+$("#nv-len").value);
    const mode = $("[name=nv-mode]:checked").value;
    let p;
    if (mode === "idea") {
      const idea = $("#nv-idea").value.trim();
      if (!idea) { toast("Напишите идею видео", true); return; }
      p = await api("/api/projects", { body: { idea, channel_id: cid, scene_count, start: true } });
    } else {
      e.target.textContent = "👔 Директор думает…";
      p = await api(`/api/channels/${cid}/plan`, { body: { start: true, scene_count } });
    }
    closeModal();
    toast("Команда взялась за работу");
    location.hash = `#/project/${p.id}`;
  }, e.target);
  upd();
}
window.openNewVideo = openNewVideo;
$("#new-video").onclick = openNewVideo;

// ---------------- router ----------------

async function reroute() {
  clearInterval(pollTimer);
  const [, page = "home", arg] = location.hash.split("/");
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === page || (page === "project" && a.dataset.page === "projects")));
  setTitle(PAGE_TITLES[page] || PAGE_TITLES.home);
  try {
    await refreshShared();
    await (pages[page] || pages.home)(arg);
  } catch (e) {
    view.innerHTML = `<div class="card">Ошибка: ${esc(e.message)}</div>`;
  }
}

window.addEventListener("hashchange", () => { projectTab = "scenes"; reroute(); });
reroute();
