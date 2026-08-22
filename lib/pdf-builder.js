// ============================================================================
// lib/pdf-builder.js — генерира истински .pdf документи (протокол, договор)
// директно на сървъра, чрез npm пакетите `pdf-lib` (PDF контейнер/страници)
// и `sharp` (растеризиране на текста).
//
// ЗАЩО РАСТЕРИЗИРАН ТЕКСТ, А НЕ ВЕКТОРЕН PDF ТЕКСТ:
// Стандартните 14 "base PDF" шрифта (Helvetica и т.н.), които pdf-lib може
// да ползва без допълнителни библиотеки, НЯМАТ кирилски глифи — кирилски
// текст излиза като изтрити/грешни символи. За да вградим истински, различен
// TTF шрифт с кирилица в pdf-lib е нужен пакетът `fontkit`, който не е
// наличен в тази среда (npm registry е блокиран за инсталация тук) — затова
// вместо да заложим на нещо непроверимо, всеки ред текст се рисува веднъж
// като малко PNG изображение (чрез вградения в проекта шрифт DejaVu Sans,
// който е Unicode/кирилица-съвместим) и се поставя в PDF-a като картинка.
// Резултатът изглежда като нормален текст, но не е "селектируем" в PDF
// четец — приемлив компромис за протокол/договор за печат и подпис.
// Основният, напълно верен и селектируем текстов формат си остава .docx
// (виж lib/doc-builder.js). PDF пътят тук е допълнителна опция и буфер
// за изпращане към доставчик за електронно разписване (виж lib/esign.js).
//
// Тествано в тази среда: генериран е реален .pdf, после рендериран обратно
// в изображение (pdftoppm) и визуално проверен — кирилицата се вижда коректно.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_REGULAR_PATH = path.join(FONT_DIR, 'DejaVuSans.ttf');
const FONT_BOLD_PATH = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

let FONT_REGULAR_B64 = null;
let FONT_BOLD_B64 = null;
function ensureFonts() {
  if (FONT_REGULAR_B64 && FONT_BOLD_B64) return true;
  try {
    FONT_REGULAR_B64 = fs.readFileSync(FONT_REGULAR_PATH).toString('base64');
    FONT_BOLD_B64 = fs.readFileSync(FONT_BOLD_PATH).toString('base64');
    return true;
  } catch (e) {
    return false;
  }
}

const PAGE_W = 595.28; // A4 at 72dpi (points)
const PAGE_H = 841.89;
const MARGIN = 50;
const MUTED = '#737785';
const DARK = '#15181f';
const LINE = rgb(0.6, 0.6, 0.6);
const SCALE = 3; // растеризираме на 3x за остри ръбове при печат/зуум

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Растеризира един ред текст в PNG (RGBA, прозрачен фон), с фиксирана височина
// спрямо размера на шрифта (за да остане базовата линия еднаква на всички
// редове от един и същ размер), и ширина, изрязана плътно до реалното мастило
// (чрез сканиране на алфа канала), за да можем коректно да центрираме/подравняваме.
async function rasterizeLine(text, { size = 10, bold = false, color = DARK } = {}) {
  if (!sharp || !ensureFonts()) return null;
  const str = String(text == null ? '' : text);
  if (!str.trim()) return null;

  const fam = bold ? 'DVBold' : 'DVReg';
  const fontB64 = bold ? FONT_BOLD_B64 : FONT_REGULAR_B64;
  const px = Math.round(size * SCALE);
  const canvasH = Math.round(px * 1.6);
  const baselineY = Math.round(px * 1.18);
  const canvasW = Math.max(40, Math.round(str.length * px * 0.85) + 40);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">` +
    `<defs><style>@font-face{font-family:'${fam}';src:url(data:font/ttf;base64,${fontB64}) format('truetype');}</style></defs>` +
    `<text x="0" y="${baselineY}" font-family="${fam}" font-size="${px}" fill="${color}">${escapeXml(str)}</text>` +
    `</svg>`;

  const rawRes = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = rawRes;
  const { width, height, channels } = info;
  let maxX = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * channels;
    for (let x = width - 1; x > maxX; x--) {
      if (data[rowStart + x * channels + 3] > 10) { maxX = x; break; }
    }
  }
  const measuredW = Math.min(width, maxX + 4);
  if (measuredW < 2) return null;

  const cropped = await sharp(Buffer.from(svg))
    .extract({ left: 0, top: 0, width: measuredW, height })
    .png()
    .toBuffer();

  return {
    buffer: cropped,
    widthPt: measuredW / SCALE,
    heightPt: height / SCALE,
    baselinePt: baselineY / SCALE,
  };
}

// Грубо приблизително измерване на ширина на текст (без реално рендериране) —
// използва се само за пренасяне на текст на нов ред (word-wrap) и за
// центриране на кратки надписи; не изисква точност до пиксел.
function estimateWidth(text, size, bold) {
  const avg = bold ? 0.62 : 0.56; // усреднен коефициент спрямо размера, за DejaVu Sans
  return String(text).length * size * avg;
}

function wrapText(text, size, maxWidth, bold = false) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  words.forEach(w => {
    const test = cur ? cur + ' ' + w : w;
    if (estimateWidth(test, size, bold) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  });
  if (cur) lines.push(cur);
  return lines;
}

class PageCursor {
  constructor(doc) {
    this.doc = doc;
    this.page = doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
    this._imgCache = new Map();
  }

  async _embedLine(text, opts) {
    if (!sharp) return null;
    const key = JSON.stringify([text, opts.size, opts.bold, opts.color]);
    if (this._imgCache.has(key)) return this._imgCache.get(key);
    const raster = await rasterizeLine(text, opts);
    if (!raster) return null;
    const png = await this.doc.embedPng(raster.buffer);
    const result = { png, ...raster };
    this._imgCache.set(key, result);
    return result;
  }

  ensureSpace(h) {
    if (this.y - h < MARGIN) {
      this.page = this.doc.addPage([PAGE_W, PAGE_H]);
      this.y = PAGE_H - MARGIN;
    }
  }

  async _drawText(text, x, size, bold, color) {
    const line = await this._embedLine(text, { size, bold, color });
    if (!line) return 0;
    this.page.drawImage(line.png, {
      x, y: this.y - line.baselinePt, width: line.widthPt, height: line.heightPt,
    });
    return line.widthPt;
  }

  async title(text) {
    this.ensureSpace(30);
    await this._drawText(text, MARGIN, 19, true, DARK);
    this.y -= 26;
  }
  async subtitle(text) {
    this.ensureSpace(18);
    await this._drawText(text, MARGIN, 10, false, MUTED);
    this.y -= 16;
  }
  hr() {
    this.ensureSpace(14);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 1.2, color: LINE });
    this.y -= 20;
  }
  async heading(text) {
    this.ensureSpace(24);
    await this._drawText(text, MARGIN, 12.5, true, DARK);
    this.y -= 18;
  }
  async kv(label, value) {
    this.ensureSpace(16);
    const v = value == null || value === '' ? '—' : String(value);
    await this._drawText(label, MARGIN, 9.5, false, MUTED);
    await this._drawText(v, MARGIN + 180, 10.5, true, DARK);
    this.y -= 16;
  }
  async paragraph(text) {
    const lines = wrapText(text, 10, PAGE_W - MARGIN * 2, false);
    for (const line of lines) {
      this.ensureSpace(15);
      await this._drawText(line, MARGIN, 10, false, DARK);
      this.y -= 14;
    }
    this.y -= 4;
  }
  async signatureRow(leftLabel, rightLabel) {
    this.ensureSpace(60);
    this.y -= 30;
    const colW = (PAGE_W - MARGIN * 2) / 2;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + colW - 30, y: this.y }, thickness: 0.8, color: LINE });
    this.page.drawLine({ start: { x: MARGIN + colW + 20, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.8, color: LINE });
    this.y -= 12;
    await this._drawText(leftLabel, MARGIN, 8.5, false, MUTED);
    await this._drawText(rightLabel, MARGIN + colW + 20, 8.5, false, MUTED);
  }
}

async function newDoc() {
  const doc = await PDFDocument.create();
  return { doc, cursor: new PageCursor(doc) };
}

const PDF_FONTS_AVAILABLE = () => !!sharp && ensureFonts();

// ---------------------------------------------------------------------------
// Готови документи (огледални на buildProtocolDocx / buildContractDocx от
// lib/doc-builder.js), но като .pdf буфер.
// ---------------------------------------------------------------------------

async function buildProtocolPdf({ protocol, vehicle, driverLabel, termsText }) {
  const { doc, cursor: c } = await newDoc();

  await c.title('Приемо-предавателен протокол');
  await c.subtitle(`№ ${protocol.protocol_number} · ${protocol.type === 'handover' ? 'Предаване на автомобил' : 'Приемане на автомобил'}`);
  await c.subtitle(`Dombi Riders ЕООД · ${new Date(protocol.date).toLocaleString('bg-BG')}`);
  c.hr();

  await c.heading('Автомобил');
  await c.kv('Рег. номер', vehicle ? vehicle.plate_number : protocol.vehicle_id);
  await c.kv('Марка / Модел', vehicle ? `${vehicle.make} ${vehicle.model}` : '—');
  await c.kv('VIN / Рама', vehicle ? vehicle.vin : '—');
  await c.kv('Година', vehicle ? vehicle.year : '—');

  await c.heading('Състояние при предаването');
  await c.kv('Пробег', protocol.odometer_km != null ? `${protocol.odometer_km} км` : '—');
  await c.kv('Ниво на гориво', protocol.fuel_level_pct != null ? `${protocol.fuel_level_pct}%` : '—');
  await c.kv('Шофьор / наемател', driverLabel || '—');

  if (protocol.exterior_notes) {
    await c.heading('Външно състояние — забележки');
    await c.paragraph(protocol.exterior_notes);
  }
  if (protocol.interior_notes) {
    await c.heading('Вътрешно състояние — забележки');
    await c.paragraph(protocol.interior_notes);
  }
  if (termsText) {
    await c.heading('Общи условия');
    await c.paragraph(termsText);
  }

  await c.signatureRow('Предал (подпис)', 'Приел (подпис)');

  return doc.save();
}

async function buildContractPdf({ contract, vehicle, renterName, termsText }) {
  const RATE_PERIOD_LABELS = { day: 'ден', week: 'седмица', month: 'месец' };
  const STATUS_LABELS = { draft: 'Чернова', active: 'Активен', completed: 'Приключен', terminated: 'Прекратен' };
  const { doc, cursor: c } = await newDoc();

  await c.title('Договор за наем на автомобил');
  await c.subtitle(`№ ${contract.contract_number} · Статус: ${STATUS_LABELS[contract.status] || contract.status}`);
  await c.subtitle(`Dombi Riders ЕООД · Дата на съставяне: ${new Date(contract.created_at).toLocaleDateString('bg-BG')}`);
  c.hr();

  await c.heading('Наемодател');
  await c.paragraph('Dombi Riders ЕООД, гр. София, действащ чрез оправомощен представител.');

  await c.heading('Наемател');
  await c.kv('Име', renterName);
  await c.kv('Тип', contract.renter_type === 'dombi_courier' ? 'Куриер на Dombi Riders' : contract.renter_type === 'other_platform' ? 'Друга платформа' : 'Лично ползване');
  if (contract.renter_egn) await c.kv('ЕГН', contract.renter_egn);
  if (contract.renter_phone) await c.kv('Телефон', contract.renter_phone);
  if (contract.renter_email) await c.kv('Имейл', contract.renter_email);
  if (contract.renter_address) await c.kv('Адрес', contract.renter_address);

  await c.heading('Предмет на договора');
  await c.kv('Рег. номер', vehicle ? vehicle.plate_number : contract.vehicle_id);
  await c.kv('Марка / Модел', vehicle ? `${vehicle.make} ${vehicle.model}` : '—');
  await c.kv('VIN / Рама', vehicle ? vehicle.vin : '—');

  await c.heading('Условия на наема');
  await c.kv('Начална дата', contract.start_date);
  await c.kv('Крайна дата', contract.end_date || 'безсрочен');
  await c.kv('Наемна цена', `${contract.rate_amount} € / ${RATE_PERIOD_LABELS[contract.rate_period] || contract.rate_period}`);
  await c.kv('Депозит', `${contract.deposit_amount || 0} €`);
  if (contract.start_odometer_km) await c.kv('Пробег при предаване', `${contract.start_odometer_km} км`);
  if (contract.end_odometer_km) await c.kv('Пробег при връщане', `${contract.end_odometer_km} км`);

  if (termsText) {
    await c.heading('Общи условия');
    await c.paragraph(termsText);
  }

  await c.signatureRow('Наемодател (подпис)', 'Наемател (подпис)');

  return doc.save();
}

const EC_TYPE_LABELS = { labor: 'Трудов договор', civil: 'Граждански договор' };
const EC_STATUS_LABELS = { draft: 'Чернова', active: 'Активен', terminated: 'Прекратен' };

// огледално на buildEmploymentContractDocx — виж бележката за КЕП там
async function buildEmploymentContractPdf({ contract, profile, termsText }) {
  const isLabor = contract.contract_type === 'labor';
  const { doc, cursor: c } = await newDoc();

  await c.title(EC_TYPE_LABELS[contract.contract_type] || contract.contract_type);
  await c.subtitle(`№ ${contract.contract_number} · Статус: ${EC_STATUS_LABELS[contract.status] || contract.status}`);
  await c.subtitle(`Dombi Riders ЕООД · Дата на съставяне: ${new Date(contract.created_at).toLocaleDateString('bg-BG')}`);
  c.hr();

  if (isLabor) {
    await c.paragraph('⚠️ Чернова за преглед. Действителен трудов договор изисква квалифициран електронен подпис (КЕП) от работодателя по чл. 62 КТ — не е правен съвет, консултирайте се с адвокат/счетоводител.');
  }

  await c.heading('Работодател');
  await c.paragraph('Dombi Riders ЕООД, гр. София, действащ чрез оправомощен представител.');

  await c.heading(isLabor ? 'Работник' : 'Изпълнител');
  await c.kv('Име', profile ? profile.full_name : contract.profile_id);
  if (profile && profile.egn) await c.kv('ЕГН', profile.egn);
  if (profile && profile.address) await c.kv('Адрес', profile.address);
  if (profile && profile.phone) await c.kv('Телефон', profile.phone);
  if (profile && profile.email) await c.kv('Имейл', profile.email);

  await c.heading('Условия');
  await c.kv('Вид договор', EC_TYPE_LABELS[contract.contract_type] || contract.contract_type);
  if (isLabor) await c.kv('Часове на ден', contract.hours_per_day);
  await c.kv('Начална дата', contract.start_date);
  await c.kv('Крайна дата', contract.end_date || 'безсрочен');
  await c.kv('Седмична удръжка', `${contract.weekly_deduction_amount || 0} €`);

  if (termsText) {
    await c.heading(isLabor ? 'Клаузи' : 'Общи условия');
    await c.paragraph(termsText);
  }

  await c.signatureRow('Работодател (подпис)', isLabor ? 'Работник (подпис)' : 'Изпълнител (подпис)');

  return doc.save();
}

// ---------------------------------------------------------------------------
// Потвърждение за седмица (заплати) — ИЗРИЧНО САМО брой поръчки, НИКОГА сума
// (нито gross_earnings, нито net_amount, нито deduction_amount). Разписването
// на шофьора потвърждава единствено броя изпълнени поръчки за седмицата — не
// стойността им. Затова тук НЯМА параметър/поле за пари, и няма редактируем
// шаблон/токени (за да не може админ случайно да добави сума в текста).
async function buildPayrollConfirmationPdf({ entry, employeeName }) {
  const { doc, cursor: c } = await newDoc();

  await c.title('Потвърждение на брой поръчки за седмица');
  await c.subtitle(`Седмица: ${entry.week_start} — ${entry.week_end}`);
  await c.subtitle('Dombi Riders ЕООД');
  c.hr();

  await c.heading('Служител');
  await c.kv('Име', employeeName);

  await c.heading('Потвърждение');
  await c.kv('Брой изпълнени поръчки', entry.order_count);
  await c.paragraph('С полагането на подпис по-долу служителят потвърждава единствено броя изпълнени поръчки за посочената седмица. Този документ НЕ съдържа и не представлява потвърждение на паричната стойност/заплащане.');

  await c.signatureRow('Работодател (подпис)', 'Служител (подпис)');

  return doc.save();
}

module.exports = {
  newDoc, PageCursor, wrapText, rasterizeLine, PDF_FONTS_AVAILABLE,
  buildProtocolPdf, buildContractPdf, buildEmploymentContractPdf, buildPayrollConfirmationPdf,
};
