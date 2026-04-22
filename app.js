const SIGNIN_URL = 'https://01yessenov.yu.edu.kz/api/auth/signin';
const GQL_URL    = 'https://01yessenov.yu.edu.kz/api/graphql-engine/v1/graphql';

function getToken() { return localStorage.getItem('jwt'); }
function setToken(t) { localStorage.setItem('jwt', t); }
function clearToken() { localStorage.removeItem('jwt'); }

function parseJWT(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    return JSON.parse(atob(b64));
  } catch { return {}; }
}

async function doLogin() {
  const identifier = document.getElementById('identifier').value.trim();
  const password    = document.getElementById('password').value;
  const errorEl     = document.getElementById('error-msg');
  const btn         = document.getElementById('login-btn');

  errorEl.style.display = 'none';
  if (!identifier || !password) {
    showError('Please enter your credentials.'); return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const credentials = btoa(`${identifier}:${password}`);
    const res = await fetch(SIGNIN_URL, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}` }
    });

    if (!res.ok) {
      showError('Invalid credentials. Please try again.');
      return;
    }

    const token = await res.json();
    const jwt = typeof token === 'string' ? token : (token.token || token.access_token || JSON.stringify(token));

    setToken(jwt);
    showDashboard();
  } catch (err) {
    showError('Network error. Check your connection.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In →';
  }
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
}

function doLogout() {
  clearToken();
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('password').value = '';
  document.getElementById('error-msg').style.display = 'none';
  document.getElementById('main-content').innerHTML = `
    <div class="loader" id="dashboard-loader">
      <div class="spinner"></div>Loading your data…
    </div>`;
}

document.getElementById('password').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('identifier').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

const Q_USER = `{
  user {
    id
    login
    createdAt
    auditRatio
    totalUp
    totalDown
  }
}`;

const Q_XP = `{
  transaction(
    where: { type: { _eq: "xp" } }
    order_by: { createdAt: asc }
  ) {
    id
    amount
    createdAt
    path
    object {
      name
      type
    }
  }
}`;

const Q_RESULTS = `{
  result(
    order_by: { createdAt: desc }
    limit: 100
  ) {
    id
    grade
    createdAt
    path
    type
    object {
      id
      name
      type
    }
  }
}`;

const Q_SKILLS = `{
  transaction(
    where: { type: { _like: "skill_%" } }
    order_by: [{ type: desc }, { amount: desc }]
    distinct_on: type
  ) {
    type
    amount
  }
}`;

const Q_USER_BY_ID = `query GetUser($id: Int!) {
  user(where: { id: { _eq: $id } }) {
    id
    login
    createdAt
    auditRatio
    totalUp
    totalDown
  }
}`;

async function showDashboard() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';

  try {

    const [userData, xpData, resultsData, skillsData] = await Promise.all([
      gql(Q_USER),
      gql(Q_XP),
      gql(Q_RESULTS),
      gql(Q_SKILLS)
    ]);

    const user     = userData.user[0];
    const txns     = xpData.transaction;
    const results  = resultsData.result;
    const skills   = skillsData.transaction;

    const userById = await gql(Q_USER_BY_ID, { id: user.id });

    renderDashboard(user, txns, results, skills);
  } catch (err) {
    document.getElementById('main-content').innerHTML = `
      <div class="loader">
        <div style="color:var(--fail);font-size:14px">
          Failed to load data: ${err.message}
        </div>
        <button class="btn" style="width:auto;padding:10px 24px;margin-top:16px" onclick="doLogout()">
          Back to login
        </button>
      </div>`;
  }
}

function renderDashboard(user, txns, results, skills) {
  const totalXP = txns.reduce((s, t) => s + t.amount, 0);

  const ratioVal = user.auditRatio || 0;
  let ratioClass = 'pass-c'; 

  let ratioColor = 'var(--pass)';

  if (ratioVal < 1.0) {
    ratioClass = 'fail-c';   

    ratioColor = 'var(--fail)';
  } else if (ratioVal < 1.3) {
    ratioClass = 'amber';    

    ratioColor = 'var(--accent)';
  }

  const auditRatio = ratioVal.toFixed(2);
  const totalUp    = user.totalUp   ? formatBytes(user.totalUp)   : '—';
  const totalDown  = user.totalDown ? formatBytes(user.totalDown) : '—';

  const passCount = results.filter(r => r.grade >= 1).length;
  const failCount = results.filter(r => r.grade < 1 && r.grade !== null).length;
  const totalDone = passCount + failCount;

  const login = user.login || 'unknown';
  const memberSince = user.createdAt ? new Date(user.createdAt).toLocaleDateString('en-US', { year:'numeric', month:'short' }) : '—';

  const timelineData = buildXPTimeline(txns);
  const topProjects = buildTopProjects(txns, 8);

  document.getElementById('topbar-login').textContent = login;
  document.getElementById('avatar-initials').textContent = login.slice(0,2).toUpperCase();

  document.getElementById('main-content').innerHTML = `
    <div class="section-header fade-up">
      <span class="section-title">Overview</span>
      <div class="section-line"></div>
    </div>

    <div class="cards-row fade-up delay-1">
      <div class="stat-card amber">
        <div class="stat-label">Total XP</div>
        <div class="stat-value amber">${formatXP(totalXP)}</div>
        <div class="stat-sub">${txns.length} transactions</div>
      </div>

      <div class="stat-card ${ratioClass}">
        <div class="stat-label">Audit Ratio</div>
        <div class="stat-value ${ratioClass}">${auditRatio}</div>
        <div class="stat-sub">↑ ${totalUp} / ↓ ${totalDown}</div>
      </div>

      <div class="stat-card pass-c">
        <div class="stat-label">Passed</div>
        <div class="stat-value pass-c">${passCount}</div>
        <div class="stat-sub">${totalDone} total evaluated</div>
      </div>
      <div class="stat-card fail-c">
        <div class="stat-label">Failed</div>
        <div class="stat-value fail-c">${failCount}</div>
        <div class="stat-sub">${totalDone > 0 ? ((failCount/totalDone)*100).toFixed(0) : 0}% fail rate</div>
      </div>
    </div>

    <div class="section-header fade-up delay-2">
      <span class="section-title">Profile</span>
      <div class="section-line"></div>
    </div>

    <div class="info-grid fade-up delay-2">
      <div class="info-card">
        <div class="info-card-title">Identification</div>
        <div class="info-row"><span class="info-key">Login</span><span class="info-val">${login}</span></div>
        <div class="info-row"><span class="info-key">User ID</span><span class="info-val">#${user.id}</span></div>
        <div class="info-row"><span class="info-key">Member since</span><span class="info-val">${memberSince}</span></div>
      </div>

      <div class="info-card">
        <div class="info-card-title">Audit Status</div>
        <div class="info-row">
          <span class="info-key">Ratio</span>
          <span class="info-val" style="color:${ratioColor}">${auditRatio}</span>
        </div>
        <div class="info-row">
          <span class="info-key">Given (Up)</span>
          <span class="info-val" style="color:var(--pass)">${totalUp}</span>
        </div>
        <div class="info-row">
          <span class="info-key">Received (Down)</span>
          <span class="info-val" style="color:var(--fail)">${totalDown}</span>
        </div>
      </div>
    </div>

    <div class="section-header fade-up delay-3">
      <span class="section-title">Statistics</span>
      <div class="section-line"></div>
    </div>

    <div class="charts-row fade-up delay-3">
      <div class="chart-card">
        <div class="chart-title">XP Progress Over Time <span>cumulative</span></div>
        <div id="chart-xp-timeline"></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Pass / Fail <span>${totalDone} projects</span></div>
        <div id="chart-pass-fail"></div>
      </div>
    </div>

    <div class="chart-card fade-up delay-4" style="margin-bottom:32px">
      <div class="chart-title">Top Projects by XP <span>earned per project</span></div>
      <div id="chart-top-projects"></div>
    </div>
    <div class="section-header fade-up delay-4">
      <span class="section-title">Skills</span>
      <div class="section-line"></div>
    </div>

    <div class="skills-wrap fade-up delay-4" id="skills-wrap"></div>
  `;

  requestAnimationFrame(() => {
    renderXPTimeline(timelineData);
    renderPassFail(passCount, failCount);
    renderTopProjects(topProjects);
    renderSkills(skills);
  });
}

function buildXPTimeline(txns) {
  let cum = 0;
  return txns.map(t => {
    cum += t.amount;
    return { date: new Date(t.createdAt), xp: cum, amount: t.amount, name: t.object?.name || t.path?.split('/').pop() };
  });
}

function renderXPTimeline(data) {
  const container = document.getElementById('chart-xp-timeline');
  if (!data.length) { container.innerHTML = '<p style="color:var(--muted);font-size:13px">No XP data</p>'; return; }

  const W = container.clientWidth || 500;
  const H = 200;
  const PL = 54, PR = 16, PT = 12, PB = 36;
  const cW = W - PL - PR;
  const cH = H - PT - PB;

  const minDate = data[0].date.getTime();
  const maxDate = data[data.length-1].date.getTime();
  const maxXP   = data[data.length-1].xp;

  const toX = d => PL + ((d.date.getTime() - minDate) / (maxDate - minDate || 1)) * cW;
  const toY = d => PT + (1 - d.xp / maxXP) * cH;

  const linePath = data.map((d,i) => `${i===0?'M':'L'}${toX(d)},${toY(d)}`).join(' ');
  const areaPath = `${linePath} L${toX(data[data.length-1])},${PT+cH} L${toX(data[0])},${PT+cH} Z`;

  const ySteps = 4;
  const yLabels = Array.from({length: ySteps+1}, (_,i) =>
    `<text x="${PL-6}" y="${PT + (1 - i/ySteps)*cH + 4}" text-anchor="end" font-size="9" opacity="0.6">${formatXP(Math.round(maxXP * i/ySteps))}</text>`
  ).join('');

  const fmtDate = d => d.toLocaleDateString('en-US', { month:'short', year:'2-digit' });
  const xLabels = `
    <text x="${PL}" y="${PT+cH+20}" text-anchor="middle" font-size="9" opacity="0.6">${fmtDate(data[0].date)}</text>
    <text x="${PL+cW}" y="${PT+cH+20}" text-anchor="middle" font-size="9" opacity="0.6">${fmtDate(data[data.length-1].date)}</text>
  `;

  const step = Math.max(1, Math.floor(data.length / 20));
  const dots = data.filter((_,i) => i % step === 0 || i === data.length-1).map(d =>
    `<circle cx="${toX(d)}" cy="${toY(d)}" r="3" fill="var(--accent)" opacity="0.7"
      data-xp="${formatXP(d.xp)}" data-name="${d.name}" data-amount="+${formatXP(d.amount)}"
      class="xp-dot" style="cursor:pointer"/>`
  ).join('');

  const gridLines = Array.from({length: ySteps}, (_,i) => {
    const y = PT + (i/ySteps)*cH;
    return `<line x1="${PL}" y1="${y}" x2="${PL+cW}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="overflow:visible">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
        <clipPath id="lineClip">
          <rect x="${PL}" y="${PT}" width="${cW}" height="${cH}"/>
        </clipPath>
      </defs>
      ${gridLines}
      ${yLabels}
      ${xLabels}
      <path d="${areaPath}" fill="url(#areaGrad)" clip-path="url(#lineClip)"/>
      <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" clip-path="url(#lineClip)"/>
      ${dots}
    </svg>`;

  container.querySelectorAll('.xp-dot').forEach(dot => {
    dot.addEventListener('mouseenter', e => {
      const tt = document.getElementById('tooltip');
      tt.textContent = `${dot.dataset.name || 'project'} • ${dot.dataset.amount} • total: ${dot.dataset.xp}`;
      tt.style.display = 'block';
    });
    dot.addEventListener('mousemove', e => {
      const tt = document.getElementById('tooltip');
      tt.style.left = (e.pageX + 12) + 'px';
      tt.style.top  = (e.pageY - 28) + 'px';
    });
    dot.addEventListener('mouseleave', () => {
      document.getElementById('tooltip').style.display = 'none';
    });
  });
}

function renderPassFail(passCount, failCount) {
  const container = document.getElementById('chart-pass-fail');
  const total = passCount + failCount;

  if (total === 0) {
    container.innerHTML = '<p style="color:var(--muted);font-size:13px">No result data</p>';
    return;
  }

  const W = 220, H = 200;
  const cx = W/2, cy = H/2 - 10, r = 72, stroke = 22;
  const pct = passCount / total;
  const failPct = failCount / total;

  const circle = (fraction, color, offset) => {
    const circ = 2 * Math.PI * r;
    const dash = fraction * circ;
    return `<circle cx="${cx}" cy="${cy}" r="${r}"
      fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-dasharray="${dash} ${circ - dash}"
      stroke-dashoffset="${offset}"
      transform="rotate(-90 ${cx} ${cy})"
      style="transition: stroke-dasharray 0.8s ease"
    />`;
  };

  const passCirc = 2 * Math.PI * r;
  const passOffset = 0;
  const failOffset = -(pct * passCirc); 

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="overflow:visible">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${stroke}"/>
      ${circle(pct, 'var(--pass)', passOffset)}
      ${circle(failPct, 'var(--fail)', -( pct * (2*Math.PI*r) ))}
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"
        font-size="22" font-weight="700" fill="var(--text)">${Math.round(pct*100)}%</text>
      <text x="${cx}" y="${cy+20}" text-anchor="middle" font-size="10" fill="var(--muted)">pass rate</text>
      <rect x="${cx-60}" y="${H-24}" width="10" height="10" rx="2" fill="var(--pass)"/>
      <text x="${cx-46}" y="${H-15}" font-size="10" fill="var(--muted)">Pass (${passCount})</text>
      <rect x="${cx+10}" y="${H-24}" width="10" height="10" rx="2" fill="var(--fail)"/>
      <text x="${cx+24}" y="${H-15}" font-size="10" fill="var(--muted)">Fail (${failCount})</text>
    </svg>`;
}

function buildTopProjects(txns, limit) {
  const map = {};
  txns.forEach(t => {
    const name = t.object?.name || t.path?.split('/').pop() || 'unknown';
    map[name] = (map[name] || 0) + t.amount;
  });
  return Object.entries(map)
    .sort((a,b) => b[1]-a[1])
    .slice(0, limit)
    .map(([name, xp]) => ({ name, xp }));
}

function renderTopProjects(projects) {
  const container = document.getElementById('chart-top-projects');
  if (!projects.length) { container.innerHTML = '<p style="color:var(--muted);font-size:13px">No project data</p>'; return; }

  const W = container.clientWidth || 700;
  const H = 180;
  const PL = 120, PR = 24, PT = 8, PB = 28;
  const cW = W - PL - PR;
  const cH = H - PT - PB;
  const barH = Math.min(18, (cH / projects.length) - 4);
  const gap = (cH - barH * projects.length) / (projects.length - 1 || 1);
  const maxXP = projects[0].xp;

  const bars = projects.map((p, i) => {
    const y = PT + i * (barH + gap);
    const bW = Math.max(2, (p.xp / maxXP) * cW);
    const truncName = p.name.length > 18 ? p.name.slice(0,16)+'…' : p.name;
    return `
      <text x="${PL-8}" y="${y + barH/2 + 4}" text-anchor="end" font-size="10">${truncName}</text>
      <rect x="${PL}" y="${y}" width="${bW}" height="${barH}" rx="3"
        fill="var(--accent2)" opacity="0.8"
        data-name="${p.name}" data-xp="${formatXP(p.xp)}" class="proj-bar" style="cursor:default"/>
      <text x="${PL + bW + 6}" y="${y + barH/2 + 4}" font-size="9" fill="var(--accent2)">${formatXP(p.xp)}</text>
    `;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      ${bars}
    </svg>`;
}

function renderSkills(skills) {
  const wrap = document.getElementById('skills-wrap');
  if (!skills || !skills.length) {
    wrap.innerHTML = '<p style="color:var(--muted);font-size:13px">No skill data found.</p>';
    return;
  }
  const maxAmt = Math.max(...skills.map(s => s.amount));
  const top = skills.slice(0, 12);
  wrap.innerHTML = top.map(s => {
    const label = s.type.replace('skill_', '');
    const pct = Math.round((s.amount / maxAmt) * 100);
    return `
      <div class="skill-bar-row">
        <span class="skill-name">${label}</span>
        <div class="skill-track">
          <div class="skill-fill" style="width:${pct}%"></div>
        </div>
        <span class="skill-pct">${s.amount}</span>
      </div>`;
  }).join('');
}

function formatXP(n) {
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n/1_000).toFixed(1) + 'k';
  return n.toString();
}

function formatBytes(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1) + 'MB';
  if (n >= 1_000)     return (n/1_000).toFixed(1) + 'kB';
  return n + 'B';
}

(function init() {
  if (getToken()) {
    showDashboard();
  }
})();
