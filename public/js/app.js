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

const ROLE_LABELS = { super_admin: 'Супер администратор', admin: 'Администратор', manager: 'Мениджър', driver: 'Шофьор' };

// споделен списък с градове (за падащото меню на служителя и филтъра в
// „Досиета на служители“) — най-големите градове в България по население
const BG_CITIES = [
  'София', 'Пловдив', 'Варна', 'Бургас', 'Русе', 'Стара Загора', 'Плевен',
  'Сливен', 'Добрич', 'Шумен', 'Перник', 'Хасково', 'Ямбол', 'Пазарджик',
  'Благоевград', 'Велико Търново', 'Враца', 'Габрово', 'Асеновград', 'Видин',
  'Казанлък', 'Кюстендил', 'Кърджали', 'Монтана', 'Димитровград', 'Търговище',
  'Ловеч', 'Силистра', 'Дупница', 'Разград', 'Горна Оряховица', 'Свищов',
  'Петрич', 'Смолян', 'Сандански', 'Самоков', 'Севлиево', 'Лом', 'Карлово',
  'Нова Загора', 'Троян', 'Панагюрище', 'Свиленград', 'Първомай', 'Костенец',
  'Айтос', 'Попово', 'Харманли', 'Ботевград', 'Козлодуй', 'Гоце Делчев',
];

// съставя <option> списък от BG_CITIES + текущата стойност (ако липсва в
// списъка, за да не се губи вече въведен град при редактиране)
function cityOptions(selected) {
  const cities = BG_CITIES.includes(selected) || !selected ? BG_CITIES : [selected, ...BG_CITIES];
  return `<option value="">— няма —</option>` +
    cities.map(c => `<option value="${escapeHtml(c)}" ${c === selected ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
}

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
    { href: '/site-editor.html', icon: '🏠', label: 'Начална страница (сайт)', roles: ['admin','manager'] },
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
    { href: '/permissions.html', icon: '🔐', label: 'Права и достъпи', roles: ['super_admin'] },
  ]},
];

// ---------------------------------------------------------------------------
// roles по-горе е само fallback (ползва се, ако /api/me по някаква причина
// не върне nav_access — виж mountShell). Истинската, конфигурируема от
// супер администратора видимост идва от сървъра (lib/permissions-catalog.js
// + lib/db.js:getNavAccessMap), за да може супер администраторът реално да
// променя кой какво вижда, без redeploy на кода.
// ---------------------------------------------------------------------------

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
  // nav_access: конфигурируема от супер администратора видимост по страница
  // (виж /api/me в server.js + lib/db.js:getNavAccessMap). Ако по някаква
  // причина сървърът не я върне (стар кеш и т.н.), падаме обратно към
  // хардкоднатите roles в NAV масива по-горе, за да не счупим достъпа.
  const navAccess = me.nav_access || null;
  function hrefAllowed(item) {
    if (navAccess && Object.prototype.hasOwnProperty.call(navAccess, item.href)) return navAccess[item.href];
    return item.roles.includes(user.role);
  }
  const activeHref = mountPoint.dataset.active || '';
  const title = mountPoint.dataset.title || '';

  let effectiveNav = NAV;
  try {
    const { config } = await Api.get('/api/nav-config');
    effectiveNav = mergeNavConfig(NAV, config);
  } catch (e) { /* без запазена конфигурация — ползваме менюто по подразбиране */ }

  const navHtml = effectiveNav.map(group => {
    const items = group.items.filter(hrefAllowed);
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
          <div class="name">${escapeHtml(user.full_name)}</div>
          <div class="role">${ROLE_LABELS[user.role] || user.role}</div>
          <button class="btn btn-ghost btn-sm btn-block" id="changePasswordBtn" style="margin-bottom:6px;">🔑 Смени парола</button>
          <button class="btn btn-ghost btn-sm btn-block" id="logoutBtn">Изход</button>
        </div>
      </aside>
      <div class="main">
        ${user.must_change_password ? `
        <div class="must-change-pw-banner" id="mustChangePwBanner">
          Влизате с временна парола — препоръчваме да я смените сега.
          <button type="button" class="btn btn-primary btn-sm" id="mustChangePwBtn">Смени сега</button>
        </div>` : ''}
        <div class="topbar">
          <button class="btn btn-ghost btn-sm" id="burgerBtn" aria-label="Меню">☰</button>
          <div>
            <div class="breadcrumb">Dombi Riders · Вътрешна система</div>
            <h1 style="margin:0;">${title}</h1>
          </div>
        </div>
        <div class="content" id="app-content"></div>
      </div>
    </div>
    <div class="modal-overlay" id="changePasswordModal">
      <div class="modal-box">
        <h2 style="margin-top:0;">Смяна на парола</h2>
        <div class="error-box" id="cpwError"></div>
        <div class="success-box" id="cpwSuccess"></div>
        <form id="changePasswordForm">
          <div class="field"><label>Текуща парола</label><input type="password" name="current_password" required autocomplete="current-password"></div>
          <div class="field"><label>Нова парола</label><input type="password" name="new_password" required minlength="4" autocomplete="new-password"></div>
          <div class="field"><label>Повтори новата парола</label><input type="password" name="new_password_confirm" required minlength="4" autocomplete="new-password"></div>
          <div class="toolbar" style="margin-top:10px;">
            <button type="submit" class="btn btn-primary btn-sm">Запази новата парола</button>
            <button type="button" class="btn btn-ghost btn-sm" id="cpwCancelBtn">Отказ</button>
          </div>
        </form>
      </div>
    </div>`;

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await Api.post('/api/logout');
    window.location.href = '/login.html';
  });

  // ---- смяна на собствена парола (достъпно от всяка страница) -----------
  const cpwModal = document.getElementById('changePasswordModal');
  const cpwForm = document.getElementById('changePasswordForm');
  const cpwError = document.getElementById('cpwError');
  const cpwSuccess = document.getElementById('cpwSuccess');
  function openChangePasswordModal() {
    cpwError.classList.remove('show');
    cpwSuccess.classList.remove('show');
    cpwForm.reset();
    cpwModal.classList.add('show');
  }
  function closeChangePasswordModal() { cpwModal.classList.remove('show'); }
  document.getElementById('changePasswordBtn').addEventListener('click', openChangePasswordModal);
  const mustChangeBtn = document.getElementById('mustChangePwBtn');
  if (mustChangeBtn) mustChangeBtn.addEventListener('click', openChangePasswordModal);
  document.getElementById('cpwCancelBtn').addEventListener('click', closeChangePasswordModal);
  cpwModal.addEventListener('click', (e) => { if (e.target === cpwModal) closeChangePasswordModal(); });
  cpwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    cpwError.classList.remove('show');
    cpwSuccess.classList.remove('show');
    const data = Object.fromEntries(new FormData(cpwForm).entries());
    if (data.new_password !== data.new_password_confirm) {
      cpwError.textContent = 'Новите пароли не съвпадат.';
      cpwError.classList.add('show');
      return;
    }
    try {
      await Api.put('/api/me/password', { current_password: data.current_password, new_password: data.new_password });
      cpwSuccess.textContent = 'Паролата е сменена успешно.';
      cpwSuccess.classList.add('show');
      const banner = document.getElementById('mustChangePwBanner');
      if (banner) banner.remove();
      setTimeout(closeChangePasswordModal, 1200);
    } catch (err) {
      cpwError.textContent = err.message;
      cpwError.classList.add('show');
    }
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

  // достъп до самата страница (не само видимостта на линка в менюто) —
  // конфигурируем от супер администратора (виж navAccess по-горе). Ако
  // потребителят стигне тук по директен URL до страница, която не му е
  // разрешена, показваме съобщение вместо да рендираме съдържанието и
  // връщаме null — всяка страница вече проверява `if (!user) return;` веднага
  // след mountShell(), така че инициализацията ѝ спира естествено тук.
  if (activeHref && navAccess && Object.prototype.hasOwnProperty.call(navAccess, activeHref) && !navAccess[activeHref]) {
    document.getElementById('app-content').innerHTML =
      `<div class="error-box show">Нямате достъп до тази страница. Ако смятате, че е грешка, свържете се със супер администратор.</div>`;
    return null;
  }

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
// единен етикет "Седмица N · дата — дата" за отчети (заплати, партньорска
// статистика и др.) — показва номера на седмицата ВИНАГИ, независимо дали
// периодът е избран чрез бутон/номер на седмица или чрез ръчен избор на
// дати от календарче (номерът се извежда от самата дата, не от начина на
// избор). weekEnd е по избор — при липса се показва само началото.
function weekRangeLabel(weekStart, weekEnd) {
  if (!weekStart) return '—';
  const wn = isoWeekNumber(weekStart);
  return weekEnd ? `Седмица ${wn} · ${fmtDate(weekStart)} — ${fmtDate(weekEnd)}` : `Седмица ${wn} · ${fmtDate(weekStart)}`;
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

// ---------------------------------------------------------------------------
// печат/изтегляне на ЕДИН прикачен документ (снимка или PDF) — общо за
// талони, лични карти, шофьорски книжки, сканирани договори и т.н., навсякъде
// в системата, за да не се дублира логиката за отваряне на нов прозорец,
// изчакване снимката да се зареди, или задаване на "download" атрибут.
// ---------------------------------------------------------------------------
function isPdfUrl(url) {
  return /\.pdf(\?|#|$)/i.test(url || '');
}

function printDocumentUrl(url, title) {
  if (!url) return;
  if (isPdfUrl(url)) {
    // браузърът показва PDF файлове във вградения си четец, който вече си
    // има собствени бутони "Печат"/"Изтегли" — просто го отваряме.
    window.open(url, '_blank', 'noopener');
    return;
  }
  const w = window.open('', '_blank', 'noopener');
  if (!w) { alert('Браузърът блокира изскачащия прозорец за печат — разрешете изскачащи прозорци за този сайт.'); return; }
  const safeTitle = escapeHtml(title || 'Документ');
  w.document.write(`<!DOCTYPE html><html><head><title>${safeTitle}</title>
    <meta charset="UTF-8">
    <style>@page{margin:10mm;} body{margin:0;background:#fff;display:flex;justify-content:center;} img{max-width:100%;height:auto;display:block;}</style>
    </head><body><img src="${url}" onload="setTimeout(function(){window.print();},150)" onerror="document.body.textContent='Файлът не можа да се зареди.'"></body></html>`);
  w.document.close();
}

function downloadDocumentUrl(url, filename) {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// малък HTML фрагмент с бутони "Печат"/"Изтегли" за един прикачен документ —
// ползва се навсякъде, където показваме снимка/PDF на талон, лична карта,
// шофьорска книжка или сканиран договор. Кликовете се хващат централно от
// делегирания listener по-долу, така че страницата не трябва сама да закача
// event listener-и за тях.
function docActionButtons(url, filename, title) {
  if (!url) return '';
  const safeUrl = escapeHtml(url);
  const safeFilename = escapeHtml(filename || '');
  const safeTitle = escapeHtml(title || '');
  return `<span class="doc-actions" style="display:inline-flex;gap:4px;">` +
    `<button type="button" class="btn btn-ghost btn-sm doc-print-btn" data-url="${safeUrl}" data-title="${safeTitle}" style="padding:2px 8px;font-size:.72rem;">🖨 Печат</button>` +
    `<button type="button" class="btn btn-ghost btn-sm doc-download-btn" data-url="${safeUrl}" data-filename="${safeFilename}" style="padding:2px 8px;font-size:.72rem;">⬇ Изтегли</button>` +
    `</span>`;
}

document.addEventListener('click', (e) => {
  const printBtn = e.target.closest('.doc-print-btn');
  if (printBtn) { printDocumentUrl(printBtn.dataset.url, printBtn.dataset.title); return; }
  const downloadBtn = e.target.closest('.doc-download-btn');
  if (downloadBtn) { downloadDocumentUrl(downloadBtn.dataset.url, downloadBtn.dataset.filename); return; }
});
