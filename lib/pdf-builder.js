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
const ACCENT = '#15803d';
const LINE = rgb(0.6, 0.6, 0.6);
const ACCENT_LINE = rgb(0x15 / 255, 0x80 / 255, 0x3d / 255);
const SCALE = 3; // растеризираме на 3x за остри ръбове при печат/зуум

const COMPANY = {
  name: 'ДОМБИ РАЙДЪРС ЕООД',
  city: 'гр. София, България',
  phone: '0887 25 27 27',
  manager: 'Димчо Петров',
};
const FUEL_TYPE_LABELS = { petrol: 'Бензин', diesel: 'Дизел', gas_petrol: 'Газ + Бензин', electric: 'Електрическа', hybrid: 'Хибрид' };

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
    await this._drawText(text, MARGIN, 12.5, true, ACCENT);
    this.y -= 18;
  }
  // Фирмено заглавие ("letterhead"): име/град/телефон вляво, номер+дата на
  // документа вдясно, центрирано заглавие на документа, и акцентна черта.
  async letterhead(docTitle, docSubtitle, rightLines) {
    this.ensureSpace(70);
    const topY = this.y;
    await this._drawText(COMPANY.name, MARGIN, 13, true, DARK);
    this.y -= 15;
    await this._drawText(COMPANY.city, MARGIN, 9, false, MUTED);
    this.y -= 12;
    await this._drawText(`тел. ${COMPANY.phone}`, MARGIN, 9, false, MUTED);

    let ry = topY;
    for (const line of (rightLines || [])) {
      const w = await this._drawTextRightAligned(line, PAGE_W - MARGIN, 9, false, MUTED, ry);
      ry -= 12;
    }

    this.y = Math.min(this.y, ry) - 18;
    await this._centeredText(docTitle.toUpperCase(), 17, true, DARK);
    this.y -= 20;
    if (docSubtitle) {
      await this._centeredText(docSubtitle, 10, false, MUTED);
      this.y -= 16;
    }
    this.ensureSpace(10);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 2, color: ACCENT_LINE });
    this.y -= 22;
  }
  async _drawTextRightAligned(text, rightX, size, bold, color, y) {
    const line = await this._embedLine(text, { size, bold, color });
    if (!line) return 0;
    this.page.drawImage(line.png, { x: rightX - line.widthPt, y: y - line.baselinePt, width: line.widthPt, height: line.heightPt });
    return line.widthPt;
  }
  async _centeredText(text, size, bold, color) {
    const line = await this._embedLine(text, { size, bold, color });
    if (!line) return;
    const x = MARGIN + ((PAGE_W - MARGIN * 2) - line.widthPt) / 2;
    this.page.drawImage(line.png, { x, y: this.y - line.baselinePt, width: line.widthPt, height: line.heightPt });
  }
  // Номерирана клауза "Чл. N. ЗАГЛАВИЕ" + текст (низ или масив от редове).
  async clause(number, title, body) {
    this.ensureSpace(24);
    await this._drawText(`Чл. ${number}. ${title}`, MARGIN, 10.5, true, DARK);
    this.y -= 15;
    const lines = Array.isArray(body) ? body : [body];
    for (const line of lines) {
      await this.paragraph(line);
    }
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

  await c.letterhead(
    'Приемо-предавателен протокол',
    protocol.type === 'handover' ? 'Предаване на автомобил' : 'Приемане на автомобил',
    [`№ ${protocol.protocol_number}`, new Date(protocol.date).toLocaleString('bg-BG')]
  );

  await c.heading('1. Данни за автомобила');
  await c.kv('Рег. номер', vehicle ? vehicle.plate_number : protocol.vehicle_id);
  await c.kv('Марка / Модел', vehicle ? `${vehicle.make} ${vehicle.model}` : '—');
  await c.kv('VIN / Рама', vehicle ? vehicle.vin : '—');
  await c.kv('Година', vehicle ? vehicle.year : '—');

  await c.heading('2. Състояние при предаването');
  await c.kv('Пробег', protocol.odometer_km != null ? `${protocol.odometer_km} км` : '—');
  await c.kv('Вид гориво', FUEL_TYPE_LABELS[protocol.fuel_type] || '—');
  await c.kv(protocol.fuel_type === 'gas_petrol' ? 'Ниво на бензин' : 'Ниво на гориво', protocol.fuel_level_pct != null ? `${protocol.fuel_level_pct}%` : '—');
  if (protocol.fuel_type === 'gas_petrol') {
    await c.kv('Ниво на газ (доп.)', protocol.fuel_level_secondary_pct != null ? `${protocol.fuel_level_secondary_pct}%` : '—');
  }
  await c.kv('Шофьор / наемател', driverLabel || '—');

  await c.heading('3. Външен и вътрешен оглед');
  await c.kv('Външно състояние', protocol.exterior_notes || 'Без забележки');
  await c.kv('Вътрешно състояние', protocol.interior_notes || 'Без забележки');
  await c.kv('Приложени снимки', `${(protocol.photos || []).length} бр.`);

  await c.heading('4. Общи условия');
  await c.paragraph(termsText ||
    'Приемащата страна декларира, че е прегледала автомобила и е съгласна с описаното по-горе състояние. ' +
    'При установяване на нови повреди при връщането, различни от описаните в настоящия протокол, отговорност носи страната, ползвала автомобила през съответния период.'
  );

  await c.signatureRow('Предал (подпис)', 'Приел (подпис)');

  return doc.save();
}

async function buildContractPdf({ contract, vehicle, renterName, termsText }) {
  const RATE_PERIOD_LABELS = { day: 'ден', week: 'седмица', month: 'месец' };
  const STATUS_LABELS = { draft: 'Чернова', active: 'Активен', completed: 'Приключен', terminated: 'Прекратен' };
  const RENTER_TYPE_LABELS = { dombi_courier: 'Куриер на Dombi Riders', other_platform: 'Друга платформа', personal_use: 'Лично ползване' };
  const { doc, cursor: c } = await newDoc();

  await c.letterhead(
    'Договор за наем на моторно превозно средство',
    `Статус: ${STATUS_LABELS[contract.status] || contract.status}`,
    [`№ ${contract.contract_number}`, `Дата: ${new Date(contract.created_at).toLocaleDateString('bg-BG')}`]
  );

  await c.paragraph(
    `Днес, ${new Date(contract.created_at).toLocaleDateString('bg-BG')}, в ${COMPANY.city}, между ${COMPANY.name}, ` +
    `представлявано от управителя ${COMPANY.manager}, наричано по-долу „НАЕМОДАТЕЛ“, и ${renterName}` +
    `${contract.renter_egn ? ', ЕГН ' + contract.renter_egn : ''}, наричан/а по-долу „НАЕМАТЕЛ“, се сключи настоящият договор за наем на моторно превозно средство при следните условия:`
  );

  await c.clause(1, 'ПРЕДМЕТ НА ДОГОВОРА',
    `Наемодателят предоставя на Наемателя, а Наемателят приема да ползва срещу възнаграждение лек автомобил ` +
    `${vehicle ? `марка/модел ${vehicle.make} ${vehicle.model}, рег. № ${vehicle.plate_number}${vehicle.vin ? ', VIN ' + vehicle.vin : ''}` : `с рег. № ${contract.vehicle_id}`}, ` +
    `предаден в изправно техническо и визуално състояние съгласно подписан приемо-предавателен протокол.`
  );
  await c.clause(2, 'СРОК НА ДОГОВОРА',
    `Договорът влиза в сила от ${contract.start_date} и е ${contract.end_date ? `със срок до ${contract.end_date}` : 'безсрочен, до прекратяването му по реда на настоящия договор'}.`
  );
  await c.clause(3, 'НАЕМНА ЦЕНА И НАЧИН НА ПЛАЩАНЕ', [
    `Наемната цена е в размер на ${contract.rate_amount} € на ${RATE_PERIOD_LABELS[contract.rate_period] || contract.rate_period}, платима авансово.`,
    `Целта на ползване на автомобила е декларирана като: ${RENTER_TYPE_LABELS[contract.renter_type] || contract.renter_type}.`,
  ]);
  await c.clause(4, 'ДЕПОЗИТ',
    `Наемателят внася депозит в размер на ${contract.deposit_amount || 0} € като обезпечение по настоящия договор. ` +
    `Депозитът се възстановява при прекратяване на договора, след приспадане на евентуални дължими суми за щети, глоби или неплатен наем.`
  );
  await c.clause(5, 'ЗАДЪЛЖЕНИЯ НА НАЕМАТЕЛЯ', [
    'Да ползва автомобила грижливо, по предназначение и съгласно правилата за движение по пътищата.',
    'Да не преотстъпва автомобила на трети лица без писменото съгласие на Наемодателя.',
    'Да заплаща своевременно дължимите наемни вноски, глоби и такси, възникнали през периода на ползване.',
    'Да уведомява незабавно Наемодателя при ПТП, повреда или кражба на автомобила.',
  ]);
  await c.clause(6, 'ЗАДЪЛЖЕНИЯ НА НАЕМОДАТЕЛЯ', [
    'Да предаде автомобила в изправно техническо състояние, с валидни документи и застраховки.',
    'Да осигурява своевременно техническо обслужване на автомобила извън случаите на повреда по вина на Наемателя.',
  ]);
  await c.clause(7, 'ОТГОВОРНОСТ ПРИ ЩЕТИ',
    'Наемателят носи имуществена отговорност за щети по автомобила, настъпили през периода на ползване по негова вина, ' +
    'както и за всички глоби и санкции, наложени във връзка с управлението на автомобила през този период.'
  );
  await c.clause(8, 'ПРЕКРАТЯВАНЕ',
    'Договорът може да бъде прекратен по взаимно съгласие, с едностранно писмено предизвестие от всяка от страните, ' +
    'или незабавно при съществено неизпълнение на задълженията по настоящия договор.'
  );

  await c.heading('9. Данни за автомобила и наемателя');
  await c.kv('Рег. номер', vehicle ? vehicle.plate_number : contract.vehicle_id);
  await c.kv('Марка / Модел', vehicle ? `${vehicle.make} ${vehicle.model}` : '—');
  await c.kv('VIN / Рама', vehicle ? vehicle.vin : '—');
  await c.kv('Наемател', renterName);
  if (contract.renter_egn) await c.kv('ЕГН', contract.renter_egn);
  if (contract.renter_phone) await c.kv('Телефон', contract.renter_phone);
  if (contract.renter_license_number) await c.kv('№ на книжка', contract.renter_license_number);
  if (contract.start_odometer_km) await c.kv('Пробег при предаване', `${contract.start_odometer_km} км`);
  if (contract.end_odometer_km) await c.kv('Пробег при връщане', `${contract.end_odometer_km} км`);

  if (termsText) {
    await c.heading('10. Допълнителни условия');
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
  const employeeName = profile ? profile.full_name : contract.profile_id;
  const { doc, cursor: c } = await newDoc();

  await c.letterhead(
    EC_TYPE_LABELS[contract.contract_type] || contract.contract_type,
    `Статус: ${EC_STATUS_LABELS[contract.status] || contract.status}`,
    [`№ ${contract.contract_number}`, `Дата: ${new Date(contract.created_at).toLocaleDateString('bg-BG')}`]
  );

  if (isLabor) {
    await c.paragraph('ВНИМАНИЕ: Чернова за преглед. Действителен трудов договор изисква квалифициран електронен подпис (КЕП) от работодателя по чл. 62 КТ — не е правен съвет, консултирайте се с адвокат/счетоводител.');
  }

  await c.paragraph(
    `Днес, ${new Date(contract.created_at).toLocaleDateString('bg-BG')}, в ${COMPANY.city}, между ${COMPANY.name}, ` +
    `представлявано от управителя ${COMPANY.manager}, наричано по-долу „${isLabor ? 'РАБОТОДАТЕЛ' : 'ВЪЗЛОЖИТЕЛ'}“, и ${employeeName}` +
    `${profile && profile.egn ? ', ЕГН ' + profile.egn : ''}, наричан/а по-долу „${isLabor ? 'РАБОТНИК/СЛУЖИТЕЛ' : 'ИЗПЪЛНИТЕЛ'}“, ` +
    `се сключи настоящият ${isLabor ? 'трудов договор на основание чл. 67 във вр. с чл. 70 от Кодекса на труда' : 'граждански договор на основание чл. 258 и сл. от Закона за задълженията и договорите'} при следните условия:`
  );

  if (isLabor) {
    await c.clause(1, 'ПРЕДМЕТ И ДЛЪЖНОСТ', 'Работодателят възлага, а Работникът/Служителят приема да изпълнява длъжността „Куриер“ в дейността на дружеството.');
    await c.clause(2, 'МЯСТО НА РАБОТА', `Работата се изпълнява на територията на ${COMPANY.city} и прилежащите райони на обслужване.`);
    await c.clause(3, 'РАБОТНО ВРЕМЕ', `Установява се непълно/пълно работно време от ${contract.hours_per_day || '—'} часа на ден, при 5-дневна работна седмица, съгласно утвърден график.`);
    await c.clause(4, 'ТРУДОВО ВЪЗНАГРАЖДЕНИЕ', `Седмичното възнаграждение/удръжка е в размер на ${contract.weekly_deduction_amount || 0} €, изплащано съгласно вътрешните правила на дружеството.`);
    await c.clause(5, 'СРОК НА ДОГОВОРА', `Договорът е сключен считано от ${contract.start_date} и е ${contract.end_date ? `срочен — до ${contract.end_date}` : 'безсрочен'}.`);
    await c.clause(6, 'ПРАВА И ЗАДЪЛЖЕНИЯ НА СТРАНИТЕ', [
      'Работникът/Служителят се задължава да изпълнява възложената работа добросъвестно, да спазва трудовата дисциплина и правилата за безопасност на движението.',
      'Работодателят се задължава да осигури условия за изпълнение на работата и да заплаща уговореното възнаграждение в срок.',
    ]);
    await c.clause(7, 'ПРЕКРАТЯВАНЕ', 'Договорът се прекратява при условията и по реда на Кодекса на труда.');
  } else {
    await c.clause(1, 'ПРЕДМЕТ НА ДОГОВОРА', 'Възложителят възлага, а Изпълнителят приема да извършва куриерски услуги за нуждите на Възложителя, съгласно неговите указания.');
    await c.clause(2, 'ВЪЗНАГРАЖДЕНИЕ', `Възнаграждението по настоящия договор е в размер на ${contract.weekly_deduction_amount || 0} € седмично, определено съобразно изпълнените поръчки.`);
    await c.clause(3, 'СРОК НА ДОГОВОРА', `Договорът е в сила от ${contract.start_date} и е ${contract.end_date ? `до ${contract.end_date}` : 'безсрочен'}.`);
    await c.clause(4, 'ПРАВА И ЗАДЪЛЖЕНИЯ НА СТРАНИТЕ', [
      'Изпълнителят извършва възложената работа лично, като организира сам работното си време, без да е обвързан с трудова дисциплина.',
      'Възложителят заплаща уговореното възнаграждение съобразно реално извършената работа.',
    ]);
    await c.clause(5, 'ОТГОВОРНОСТ', 'Изпълнителят носи отговорност за качественото и срочно изпълнение на възложената работа съгласно общите правила на гражданското право.');
    await c.clause(6, 'ПРЕКРАТЯВАНЕ', 'Договорът се прекратява с изтичане на срока, по взаимно съгласие или с писмено предизвестие от всяка от страните.');
  }

  await c.heading(`${isLabor ? '8' : '7'}. Данни за страните`);
  await c.kv('Име', employeeName);
  if (profile && profile.egn) await c.kv('ЕГН', profile.egn);
  if (profile && profile.address) await c.kv('Адрес', profile.address);
  if (profile && profile.phone) await c.kv('Телефон', profile.phone);
  if (profile && profile.email) await c.kv('Имейл', profile.email);

  if (termsText) {
    await c.heading(isLabor ? 'Допълнителни клаузи' : 'Допълнителни условия');
    await c.paragraph(termsText);
  }

  await c.signatureRow(isLabor ? 'Работодател (подпис)' : 'Възложител (подпис)', isLabor ? 'Работник (подпис)' : 'Изпълнител (подпис)');

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
