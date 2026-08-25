// ============================================================================
// public/js/app.js — общи помощни функции: API извиквания, sidebar навигация
// по роля, форматиране.
// ============================================================================

const Api = {
  async call(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Грешка ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get(url) { return this.call('GET', url); },
  post(url, body) { return this.call('POST', url, body); },
  put(url, body) { return this.call('PUT', url, body); },
  del(url) { return this.call('DELETE', url); },
};

const ROLE_LABELS = { admin: 'Администратор', manager: 'Мениджър', driver: 'Шофьор' };

const NAV = [
  { group: 'Автопарк', items: [
    { href: '/home.html', icon: '🏠', label: 'Начало', roles: ['admin','manager'] },
    { href: '/vehicles.html', icon: '🚗', label: 'Коли', roles: ['admin','manager','driver'] },
    { href: '/talons.html', icon: '🪪', label: 'Картотека на талони', roles: ['admin','manager'] },
    { href: '/assignments.html', icon: '🧾', label: 'Зачисления', roles: ['admin','manager','driver'] },
    { href: '/protocol-new.html', icon: '📋', label: 'Нов протокол', roles: ['admin','manager'] },
    { href: '/contracts.html', icon: '📄', label: 'Договори за наем', roles: ['admin','manager'] },
    { href: '/templates.html', icon: '🧾', label: 'Бланки и шаблони', roles: ['admin','manager'] },
    { href: '/stats.html', icon: '📊', label: 'Статистики', roles: ['admin','manager'] },
    { href: '/fleet-showcase.html', icon: '🖼️', label: 'Витрина на сайта (коли)', roles: ['admin','manager'] },
  ]},
  { group: 'HR', items: [
    { href: '/wallet.html', icon: '👛', label: 'Портфейл', roles: ['admin','manager','driver'] },
    { href: '/personnel.html', icon: '🗂️', label: 'Досиета на служители', roles: ['admin','manager'] },
    { href: '/personnel-detail.html', icon: '🪪', label: 'Моето досие', roles: ['driver'] },
    { href: '/applications.html', icon: '📥', label: 'Кандидатури', roles: ['admin','manager'] },
    { href: '/payroll.html', icon: '💶', label: 'Заплати', roles: ['admin','manager','driver'] },
    { href: '/leave.html', icon: '🏖️', label: 'Отпуски', roles: ['admin','manager','driver'] },
    { href: '/partners.html', icon: '🤝', label: 'Партньорски комисионни', roles: ['admin'] },
  ]},
  { group: 'Финанси', items: [
    { href: '/finance.html', icon: '💰', label: 'Счетоводство', roles: ['admin','manager'] },
  ]},
  { group: 'Поща', items: [
    { href: '/mail.html', icon: '📧', label: 'Пощенска кутия', roles: ['admin'] },
    { href: 'https://mail.zoho.eu', icon: '↗️', label: 'Zoho Webmail', roles: ['admin'] },
  ]},
  { group: 'Администрация', items: [
    { href: '/users.html', icon: '👤', label: 'Потребители и роли', roles: ['admin'] },
    { href: '/activity.html', icon: '🕘', label: 'Дневник на активността', roles: ['admin'] },
    { href: '/backups.html', icon: '💾', label: 'Резервни копия', roles: ['admin'] },
    { href: '/nav-settings.html', icon: '🧭', label: 'Навигация на менюто', roles: ['admin'] },
  ]},
];

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// слепва запазена в базата конфигурация на менюто (само label + ред) върху
// базовия NAV масив от кода. href/икона/roles ВИНАГИ идват от кода — конфиг
// може само да преименува и пренарежда, никога да не разкрие/скрие страница
// по роля. Групите се съпоставят по оригиналното (кодовото) им име
// (base_group), а не по показваното, за да работи дори след преименуване.
function mergeNavConfig(baseNav, config) {
  if (!config || !Array.isArray(config.groups) || !config.groups.length) return baseNav;
  const baseByGroup = new Map(baseNav.map(g => [g.group, g]));
  const usedGroups = new Set();
  const result = [];
  config.groups.forEach(cg => {
    const base = baseByGroup.get(cg.base_group || cg.group);
    if (!base) return; // групата вече не съществува в кода — пропускаме
    usedGroups.add(base.group);
    const baseItemsByHref = new Map(base.items.map(i => [i.href, i]));
    const usedHrefs = new Set();
    const items = [];
    (Array.isArray(cg.items) ? cg.items : []).forEach(ci => {
      const baseItem = baseItemsByHref.get(ci.href);
      if (!baseItem) return; // страницата вече не съществува — пропускаме
      usedHrefs.add(ci.href);
      items.push({ ...baseItem, label: ci.label || baseItem.label });
    });
    // добавяме нови елементи от кода, липсващи в запазената конфигурация
    base.items.forEach(bi => { if (!usedHrefs.has(bi.href)) items.push(bi); });
    result.push({ group: cg.label || base.group, items });
  });
  // добавяме нови групи от кода, липсващи в запазената конфигурация
  baseNav.forEach(bg => { if (!usedGroups.has(bg.group)) result.push(bg); });
  return result;
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('bg-BG', { maximumFractionDigits: 0 }) + ' €';
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const VEHICLE_STATUS_LABELS = {
  available: ['Свободна', 'badge-green'],
  assigned: ['Зачислена', 'badge-warn'],
  rented: ['Отдадена под наем', 'badge-warn'],
  in_service: ['На сервиз', 'badge-danger'],
  inactive: ['Неактивна', 'badge-muted'],
};

function vehicleStatusBadge(status) {
  const [label, cls] = VEHICLE_STATUS_LABELS[status] || [status, 'badge-muted'];
  return `<span class="badge ${cls}">${label}</span>`;
}

// ---------------------------------------------------------------------------
// зареждане на shell (sidebar + topbar) в страници, които имат
// <div id="app-shell" data-active="/vehicles.html" data-title="Коли"></div>
// ---------------------------------------------------------------------------
async function mountShell() {
  // #app-shell се заменя изцяло (outerHTML) при първото мontиране, затова при
  // всяко следващо повикване (напр. презареждане на данни след запис на форма)
  // елементът с id="app-shell" вече не съществува в DOM-а. В такъв случай само
  // валидираме сесията наново и връщаме текущия потребител, без да пресъздаваме
  // sidebar-а/topbar-а отново (те вече са монтирани и не трябва да мигат).
  const mountPoint = document.getElementById('app-shell');
  if (!mountPoint) {
    let me;
    try {
      me = await Api.get('/api/me');
    } catch (e) {
      window.location.href = '/login.html';
      return null;
    }
    if (!me.user) {
      window.location.href = '/login.html';
      return null;
    }
    return me.user;
  }

  let me;
  try {
    me = await Api.get('/api/me');
  } catch (e) {
    window.location.href = '/login.html';
    return null;
  }
  if (!me.user) {
    window.location.href = '/login.html';
    return null;
  }
  const user = me.user;
  const activeHref = mountPoint.dataset.active || '';
  const title = mountPoint.dataset.title || '';

  let effectiveNav = NAV;
  try {
    const { config } = await Api.get('/api/nav-config');
    effectiveNav = mergeNavConfig(NAV, config);
  } catch (e) { /* без запазена конфигурация — ползваме менюто по подразбиране */ }

  const navHtml = effectiveNav.map(group => {
    const items = group.items.filter(i => i.roles.includes(user.role));
    if (!items.length) return '';
    return `
      <div class="nav-group">
        <div class="nav-label">${escapeHtml(group.group)}</div>
        ${items.map(i => {
          const isExternal = /^https?:\/\//.test(i.href);
          const extraAttrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
          return `
          <a class="nav-link ${i.href === activeHref ? 'active' : ''}" href="${i.href}"${extraAttrs}>
            <span class="ic">${i.icon}</span>${escapeHtml(i.label)}
          </a>`;
        }).join('')}
      </div>`;
  }).join('');

  mountPoint.outerHTML = `
    <div class="app-shell">
      <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-logo"><span class="dot"></span><span>Dombi Riders</span></div>
        <nav>${navHtml}</nav>
        <div class="sidebar-user">
          <div class="name">${user.full_name}</div>
          <div class="role">${ROLE_LABELS[user.role] || user.role}</div>
          <button class="btn btn-ghost btn-sm btn-block" id="logoutBtn">Изход</button>
        </div>
      </aside>
      <div class="main">
        <div class="topbar">
          <button class="btn btn-ghost btn-sm" id="burgerBtn" aria-label="Меню">☰</button>
          <div>
            <div class="breadcrumb">Dombi Riders · Вътрешна система</div>
            <h1 style="margin:0;">${title}</h1>
          </div>
        </div>
        <div class="content" id="app-content"></div>
      </div>
    </div>`;

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await Api.post('/api/logout');
    window.location.href = '/login.html';
  });

  // мобилна навигация: burger бутон отваря/затваря sidebar-а (виж CSS —
  // бутонът и цялото поведение са скрити над 820px, където sidebar-ът вече
  // е винаги видим). Затваря се и с тап извън менюто (backdrop) или при
  // избор на линк от менюто.
  const sidebarEl = document.getElementById('sidebar');
  const backdropEl = document.getElementById('sidebarBackdrop');
  const burgerBtn = document.getElementById('burgerBtn');
  function closeSidebar() {
    sidebarEl.classList.remove('open');
    backdropEl.classList.remove('show');
  }
  function toggleSidebar() {
    sidebarEl.classList.toggle('open');
    backdropEl.classList.toggle('show');
  }
  burgerBtn.addEventListener('click', toggleSidebar);
  backdropEl.addEventListener('click', closeSidebar);
  sidebarEl.querySelectorAll('.nav-link').forEach(a => a.addEventListener('click', closeSidebar));

  return user;
}

// ---------------------------------------------------------------------------
// период/седмица picker — бързи бутони (Тази седмица / Миналата седмица /
// Този месец) + номерирана селекция на седмица, монтирани над чифт date
// inputs, за да не се налага ръчно чоплене на дати при всяко въвеждане.
// По подразбиране навсякъде сочим предходната (последната приключила)
// седмица — тя е и най-често търсената при въвеждане на заплати/импорт.
// Седмиците следват ISO 8601 (понеделник — начало), както реалните данни
// от Bolt/Glovo (week_start винаги е понеделник).
// ---------------------------------------------------------------------------
function isoDateOnly(dt) { return dt.toISOString().slice(0, 10); }
function addDaysStr(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return isoDateOnly(d); }
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = (d.getDay() + 6) % 7; // Пон=0 .. Нед=6
  d.setDate(d.getDate() - day);
  return isoDateOnly(d);
}
function isoWeekNumber(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}
function todayStr() { return isoDateOnly(new Date()); }
function currentWeekStart() { return mondayOf(todayStr()); }
function previousWeekStart() { return addDaysStr(currentWeekStart(), -7); }
function monthStartStr(dateStr) { const d = new Date(dateStr + 'T00:00:00'); return isoDateOnly(new Date(d.getFullYear(), d.getMonth(), 1)); }
function monthEndStr(dateStr) { const d = new Date(dateStr + 'T00:00:00'); return isoDateOnly(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }

// последните `count` седмици (най-новата първа), номерирани по ISO седмица
function recentWeekOptions(count) {
  const opts = [];
  let ws = currentWeekStart();
  for (let i = 0; i < count; i++) {
    const we = addDaysStr(ws, 6);
    opts.push({ start: ws, end: we, label: `Седмица ${isoWeekNumber(ws)} (${fmtDate(ws)} – ${fmtDate(we)})` });
    ws = addDaysStr(ws, -7);
  }
  return opts;
}

// монтира лентата в `host` (елемент) и я свързва към чифт date inputs.
// wireWeekEnd: при промяна на start автоматично слага end = start+6 дни
// (стриктно седмични полета — напр. заплати).
// useMonthPreset: добавя бутон "Този месец" (по-широки периоди — напр.
// партньорска статистика, която не е задължително подравнена по седмица).
// onApply(start, end): по избор — извиква се веднага след всеки бърз избор.
// weekPresetMode: 'range' (по подразбиране) — "Тази/Миналата седмица" слагат
// end = start+6 дни (истинския календарен край на седмицата, за стриктно
// седмични полета). 'single' — end = start (двете полета са независими
// week_start граници на филтър, напр. партньорска статистика).
function mountPeriodPicker(host, startInput, endInput, opts) {
  opts = opts || {};
  const wireWeekEnd = opts.wireWeekEnd !== false;
  const useMonthPreset = !!opts.useMonthPreset;
  const weekPresetMode = opts.weekPresetMode || 'range';
  const onApply = opts.onApply;
  const weeks = recentWeekOptions(20);
  host.innerHTML = `
    <div class="period-picker">
      <button type="button" class="btn btn-ghost btn-sm" data-pp="this-week">Тази седмица</button>
      <button type="button" class="btn btn-ghost btn-sm" data-pp="last-week">Миналата седмица</button>
      ${useMonthPreset ? '<button type="button" class="btn btn-ghost btn-sm" data-pp="this-month">Този месец</button>' : ''}
      <select class="pp-week-select">
        <option value="">— избери седмица по номер —</option>
        ${weeks.map(w => `<option value="${w.start}|${w.end}">${w.label}</option>`).join('')}
      </select>
    </div>`;
  function apply(start, end) {
    startInput.value = start;
    endInput.value = end;
    if (onApply) onApply(start, end);
  }
  host.querySelector('[data-pp="this-week"]').addEventListener('click', () => {
    const s = currentWeekStart(); apply(s, weekPresetMode === 'single' ? s : addDaysStr(s, 6));
  });
  host.querySelector('[data-pp="last-week"]').addEventListener('click', () => {
    const s = previousWeekStart(); apply(s, weekPresetMode === 'single' ? s : addDaysStr(s, 6));
  });
  const monthBtn = host.querySelector('[data-pp="this-month"]');
  if (monthBtn) {
    monthBtn.addEventListener('click', () => {
      const t = todayStr(); apply(monthStartStr(t), monthEndStr(t));
    });
  }
  host.querySelector('.pp-week-select').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const [s, en] = e.target.value.split('|');
    apply(s, weekPresetMode === 'single' ? s : en);
  });
  if (wireWeekEnd) {
    startInput.addEventListener('change', () => {
      if (startInput.value) endInput.value = addDaysStr(startInput.value, 6);
    });
  }
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------------------------------------------------------------------------
// експорт в CSV (за отваряне в Excel/Google Sheets) — работи навсякъде,
// без нужда от бекенд endpoint. Добавя BOM, за да се четат кирилски букви
// коректно в Excel.
// ---------------------------------------------------------------------------
function downloadCsv(filename, headers, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(esc).join(',')].concat(
    rows.map(r => r.map(esc).join(','))
  );
  const csv = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// парсване на CSV (за импорт) — поддържа кавички/запетаи в стойностите и
// пропуска UTF-8 BOM, ако е налично (напр. от Excel или от нашия downloadCsv).
// ---------------------------------------------------------------------------
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip — обработва се от \n
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
