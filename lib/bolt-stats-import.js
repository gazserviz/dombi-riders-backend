// ============================================================================
// lib/bolt-stats-import.js — седмична СТАТИСТИКА на шофьорите от Bolt Food
// (отделно от заплатите, виж lib/earnings-import.js за паричния импорт).
// Целта тук е проследимост на дейността във времето (поръчки, активност,
// баланси), не плащане — вижте новата страница /bolt-stats.html.
//
// Bolt публикува тези отчети през партньорския панел всяка седмица; взети са
// 3 от 5-те реални файла за седмица 2026-W39, останалите 2 (фактурни разходи
// на ниво ФИРМА, не по шофьор) не носят информация "по шофьор" за тенденции
// и съзнателно не се разчитат тук:
//   courier_orders_2026_W39.xlsx                    — предложени/приети/доставени + %
//   courier_activity_periods_2026_W39.xlsx           — смени: онлайн/оползотворено време
//   fleet_courier_earnings_and_balances_2026_W39_2.xlsx — заработка/бакшиши/баланси (РАЗШИРЕНА версия)
//
// За разлика от старата (фиксирани индекси) версия на parseBoltWorkbook в
// earnings-import.js, тук колоните се търсят по ИМЕ на хедъра (вижте
// COLUMN_ALIASES по-долу) — поуката от Glovo форматната драма по-рано:
// Bolt също може да пренарежда/добавя колони без предупреждение.
// ============================================================================

function loadXlsx() {
  try { return require('xlsx'); } catch (e) { return null; }
}
function isAvailable() { return !!loadXlsx(); }
function notAvailableError() {
  const err = new Error('Пакетът "xlsx" не е наличен в тази среда.');
  err.code = 'MODULE_NOT_AVAILABLE';
  return err;
}

function normPhone(v) {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v);
  if (s.endsWith('.0')) s = s.slice(0, -2);
  let digits = s.replace(/\D/g, '');
  if (digits.startsWith('359') && digits.length >= 12) digits = digits.slice(3);
  else if (digits.startsWith('0') && digits.length === 10) digits = digits.slice(1);
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace('%', '').trim());
  return Number.isFinite(n) ? n : 0;
}

// "HH:MM:SS" (или "H:MM:SS") -> секунди; невалиден/празен вход -> 0
function hmsToSeconds(v) {
  if (!v) return 0;
  const s = String(v).trim();
  const m = s.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
function secondsToHms(total) {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function findHeaderRowIndex(rows, requiredHeaderNorm) {
  const limit = Math.min(rows.length, 10);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    if (row.some(c => String(c || '').trim().toLowerCase() === requiredHeaderNorm)) return i;
  }
  return -1;
}

function buildColumnMap(headerRow, aliasLists) {
  const norm = headerRow.map(h => String(h || '').trim().toLowerCase());
  const cols = {};
  for (const [field, aliases] of Object.entries(aliasLists)) {
    for (const alias of aliases) {
      const idx = norm.indexOf(alias.toLowerCase());
      if (idx !== -1) { cols[field] = idx; break; }
    }
  }
  return cols;
}

function sheetRows(XLSX, ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
}

// --- courier_orders.xlsx -----------------------------------------------
const ORDERS_ALIASES = {
  courierUid: ['courier uid'], city: ['city'],
  firstName: ['first name'], lastName: ['last name'], phone: ['phone'], email: ['email'],
  proposed: ['orders proposed'], accepted: ['accepted orders'], delivered: ['delivered orders'],
  acceptanceRate: ['acceptance rate'], completionRate: ['completion rate'],
};
function parseOrdersWorkbook(buffer) {
  const XLSX = loadXlsx();
  if (!XLSX) throw notAvailableError();
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = sheetRows(XLSX, ws);
  const headerIdx = findHeaderRowIndex(rows, 'courier uid');
  if (headerIdx === -1) return {};
  const cols = buildColumnMap(rows[headerIdx], ORDERS_ALIASES);
  const byUid = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const uid = cols.courierUid !== undefined ? row[cols.courierUid] : null;
    if (!uid) continue;
    byUid[String(uid)] = {
      courier_uid: String(uid), city: cols.city !== undefined ? row[cols.city] : null,
      first_name: cols.firstName !== undefined ? row[cols.firstName] : '',
      last_name: cols.lastName !== undefined ? row[cols.lastName] : '',
      phone: normPhone(cols.phone !== undefined ? row[cols.phone] : null),
      email: ((cols.email !== undefined ? row[cols.email] : '') || '').toString().trim(),
      orders_proposed: toNum(cols.proposed !== undefined ? row[cols.proposed] : 0),
      orders_accepted: toNum(cols.accepted !== undefined ? row[cols.accepted] : 0),
      orders_delivered: toNum(cols.delivered !== undefined ? row[cols.delivered] : 0),
      acceptance_rate: toNum(cols.acceptanceRate !== undefined ? row[cols.acceptanceRate] : 0),
      completion_rate: toNum(cols.completionRate !== undefined ? row[cols.completionRate] : 0),
    };
  }
  return byUid;
}

// --- courier_activity_periods.xlsx (много редове на куриер — смени) ----
const ACTIVITY_ALIASES = {
  courierUid: ['courier uid'], city: ['city'],
  firstName: ['first name'], lastName: ['last name'], phone: ['phone'], email: ['email'],
  onlineTime: ['online time'], utilizedTime: ['utilized time'],
};
function parseActivityWorkbook(buffer) {
  const XLSX = loadXlsx();
  if (!XLSX) throw notAvailableError();
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = sheetRows(XLSX, ws);
  const headerIdx = findHeaderRowIndex(rows, 'courier uid');
  if (headerIdx === -1) return {};
  const cols = buildColumnMap(rows[headerIdx], ACTIVITY_ALIASES);
  const byUid = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const uid = cols.courierUid !== undefined ? row[cols.courierUid] : null;
    if (!uid) continue;
    const key = String(uid);
    if (!byUid[key]) {
      byUid[key] = {
        courier_uid: key, city: cols.city !== undefined ? row[cols.city] : null,
        first_name: cols.firstName !== undefined ? row[cols.firstName] : '',
        last_name: cols.lastName !== undefined ? row[cols.lastName] : '',
        phone: normPhone(cols.phone !== undefined ? row[cols.phone] : null),
        email: ((cols.email !== undefined ? row[cols.email] : '') || '').toString().trim(),
        online_seconds: 0, utilized_seconds: 0, shift_count: 0,
      };
    }
    const rec = byUid[key];
    rec.online_seconds += hmsToSeconds(cols.onlineTime !== undefined ? row[cols.onlineTime] : null);
    rec.utilized_seconds += hmsToSeconds(cols.utilizedTime !== undefined ? row[cols.utilizedTime] : null);
    rec.shift_count += 1;
  }
  Object.values(byUid).forEach(rec => {
    rec.online_hms = secondsToHms(rec.online_seconds);
    rec.utilized_hms = secondsToHms(rec.utilized_seconds);
    rec.utilization_rate = rec.online_seconds > 0
      ? Math.round((rec.utilized_seconds / rec.online_seconds) * 10000) / 100 : 0;
  });
  return byUid;
}

// --- fleet_courier_earnings_and_balances (разширена версия с баланси) --
const EARNINGS_ALIASES = {
  courierUid: ['courier uid'], city: ['city'],
  firstName: ['first name'], lastName: ['last name'], phone: ['phone'], email: ['email'],
  earningsNoVat: ['courier earnings (without vat)'],
  waitingCompNoVat: ['waiting time compensations (without vat)'],
  adjustments: ['courier adjustments'],
  campaignBonus: ['campaign bonus'],
  tipsNoVat: ['courier tips (without vat)'],
  adjustedWithTipsNoVat: ['adjusted earnings with courier tips (without vat)'],
  cashReceived: ['cash received from clients'],
  overdueCashDebt: ['overdue courier cash debt'],
  cashPaidToProviders: ['cash paid to providers'],
  balanceBefore: ['balance before period'],
  balanceAfter: ['balance after period'],
};
function parseEarningsBalancesWorkbook(buffer) {
  const XLSX = loadXlsx();
  if (!XLSX) throw notAvailableError();
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = sheetRows(XLSX, ws);
  const headerIdx = findHeaderRowIndex(rows, 'courier uid');
  if (headerIdx === -1) return {};
  const cols = buildColumnMap(rows[headerIdx], EARNINGS_ALIASES);
  const byUid = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const uid = cols.courierUid !== undefined ? row[cols.courierUid] : null;
    if (!uid) continue;
    const g = (f) => (cols[f] !== undefined ? toNum(row[cols[f]]) : 0);
    byUid[String(uid)] = {
      courier_uid: String(uid), city: cols.city !== undefined ? row[cols.city] : null,
      first_name: cols.firstName !== undefined ? row[cols.firstName] : '',
      last_name: cols.lastName !== undefined ? row[cols.lastName] : '',
      phone: normPhone(cols.phone !== undefined ? row[cols.phone] : null),
      email: ((cols.email !== undefined ? row[cols.email] : '') || '').toString().trim(),
      earnings_no_vat: g('earningsNoVat'),
      waiting_compensation: g('waitingCompNoVat'),
      adjustments: g('adjustments'),
      campaign_bonus: g('campaignBonus'),
      tips_no_vat: g('tipsNoVat'),
      total_earnings_with_tips: g('adjustedWithTipsNoVat'),
      cash_received_from_clients: g('cashReceived'),
      overdue_cash_debt: g('overdueCashDebt'),
      cash_paid_to_providers: g('cashPaidToProviders'),
      balance_before: g('balanceBefore'),
      balance_after: g('balanceAfter'),
    };
  }
  return byUid;
}

// Обединява трите файла по Courier UID -> масив от записи, по избор
// съпоставени с профил по телефон (матчингът по телефон се прави в
// server.js, както при импорта на заплати, за да е на едно място логиката
// за "кой профил на кой шофьор отговаря").
function mergeByCourierUid({ orders, activity, earnings }) {
  const uids = new Set([
    ...Object.keys(orders || {}), ...Object.keys(activity || {}), ...Object.keys(earnings || {}),
  ]);
  const records = [];
  for (const uid of uids) {
    const o = (orders || {})[uid] || {};
    const a = (activity || {})[uid] || {};
    const e = (earnings || {})[uid] || {};
    const phone = o.phone || a.phone || e.phone || null;
    records.push({
      courier_uid: uid,
      first_name: o.first_name || a.first_name || e.first_name || '',
      last_name: o.last_name || a.last_name || e.last_name || '',
      city: o.city || a.city || e.city || null,
      phone,
      email: o.email || a.email || e.email || '',
      orders_proposed: o.orders_proposed ?? null,
      orders_accepted: o.orders_accepted ?? null,
      orders_delivered: o.orders_delivered ?? null,
      acceptance_rate: o.acceptance_rate ?? null,
      completion_rate: o.completion_rate ?? null,
      online_seconds: a.online_seconds ?? null,
      utilized_seconds: a.utilized_seconds ?? null,
      online_hms: a.online_hms ?? null,
      utilized_hms: a.utilized_hms ?? null,
      utilization_rate: a.utilization_rate ?? null,
      shift_count: a.shift_count ?? null,
      earnings_no_vat: e.earnings_no_vat ?? null,
      waiting_compensation: e.waiting_compensation ?? null,
      adjustments: e.adjustments ?? null,
      campaign_bonus: e.campaign_bonus ?? null,
      tips_no_vat: e.tips_no_vat ?? null,
      total_earnings_with_tips: e.total_earnings_with_tips ?? null,
      cash_received_from_clients: e.cash_received_from_clients ?? null,
      overdue_cash_debt: e.overdue_cash_debt ?? null,
      cash_paid_to_providers: e.cash_paid_to_providers ?? null,
      balance_before: e.balance_before ?? null,
      balance_after: e.balance_after ?? null,
    });
  }
  return records;
}

module.exports = {
  isAvailable, normPhone,
  parseOrdersWorkbook, parseActivityWorkbook, parseEarningsBalancesWorkbook,
  mergeByCourierUid,
};
