// ============================================================================
// server.js — Dombi Riders / вътрешна система (демо режим)
//
// Чист Node.js HTTP сървър (без външни пакети — работи навсякъде, включително
// в среда без достъп до npm registry). Обслужва статичните HTML/CSS/JS файлове
// от /public и REST API под /api/*, подкрепени от lib/db.js (файлова база
// данни — вижте бележката там за миграция към Supabase).
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./lib/db');
const { callClaudeVision, scanIdCard, scanDriverLicense } = require('./lib/talon-scan');
const docRender = require('./lib/doc-render');
const docTemplates = require('./lib/doc-templates');
const earningsImport = require('./lib/earnings-import');
const docxToPdf = require('./lib/docx-to-pdf');
const esign = require('./lib/esign');
const pdfBuilder = require('./lib/pdf-builder');
const backup = require('./lib/backup');
const mail = require('./lib/mail');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// UPLOADS_DIR дели корена (DATA_DIR) с бекъпите (виж lib/backup.js) — задайте
// env DATA_DIR = точния Mount Path на Render Persistent Disk, за да оцелеят
// и снимките, и бекъпите след redeploy/рестарт. Без DATA_DIR — стар режим
// (локална папка data/ до кода, ефимерна на Render free tier).
const UPLOADS_DIR = path.join(backup.DATA_DIR, 'uploads');
// на чисто монтиран диск (нов DATA_DIR) папката още не съществува — правим я
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// в Render зад HTTPS — задава Secure на session бисквитката; локално (http)
// оставяме изключено, иначе браузърът просто ще я откаже
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Прост in-memory rate limiter — защита срещу brute-force по/паднат login и
// спам към публичната форма за кандидатстване. Памет само за един процес; при
// няколко Render инстанции трябва споделено хранилище (Redis) — виж README.
// ---------------------------------------------------------------------------
const RATE_LIMIT_BUCKETS = new Map();
function rateLimited(key, { max, windowMs }) {
  const now = Date.now();
  const entry = RATE_LIMIT_BUCKETS.get(key);
  if (!entry || now - entry.start > windowMs) {
    RATE_LIMIT_BUCKETS.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}
// периодично изчистване на старите bucket-и, за да не расте паметта неограничено
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of RATE_LIMIT_BUCKETS) {
    if (now - entry.start > 30 * 60 * 1000) RATE_LIMIT_BUCKETS.delete(key);
  }
}, 10 * 60 * 1000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// помощни функции
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Escape на HTML-специални символи в свободен текст, идващ от НЕДОВЕРЕН вход
// (публичната форма /api/apply — всеки в интернет може да я подаде без вход).
// Записваме вече ескейпнатия текст, за да не се налага да поправяме всяко
// място в public/*.html, което го извежда през innerHTML (десетки места) —
// вижда се и си остава коректен текст, само че вече е безопасен за вграждане.
// Полетата от вътрешни, автентикирани форми (напр. бележки на шофьори) не са
// пипнати тук — приемат се за по-нисък риск, но виж README/сигурност за
// препоръка за пълен output-encoding одит преди по-широко публично ползване.
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  if (str == null) return str;
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) { // 25MB лимит (снимки в base64)
        reject(new Error('Заявката е твърде голяма'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// нормализира списък с имейл адреси, разделени със запетая и/или точка и
// запетая ("a@x.com, b@y.com; c@z.com") — подрязва интервалите и премахва
// празните записи, връща обратно единен низ разделен със запетая (форматът,
// който nodemailer/SMTP очакват в To/Cc)
function normalizeEmailList(raw, maxCount) {
  if (!raw) return '';
  const parts = String(raw)
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, maxCount);
  return parts.join(', ');
}

function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  if (!token) return null;
  const session = db.getSession(token);
  if (!session) return null;
  const user = db.findUserById(session.userId);
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
}

function requireAuth(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Не сте влезли в системата' });
    return null;
  }
  return user;
}

function requireRole(req, res, roles) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!roles.includes(user.role)) {
    sendJson(res, 403, { error: 'Нямате права за това действие' });
    return null;
  }
  return user;
}

// достъп до кандидатура: админ вижда/оправлява всички; мениджър — само
// изрично назначените му от админ (виж db.assignApplicationManager). Без
// назначение (manager_id: null) кандидатурата е видима само за админ —
// така админът контролира кой мениджър какво вижда, вместо всичко да е
// видимо по подразбиране за всеки мениджър.
function canAccessApplication(user, app) {
  if (user.role === 'admin') return true;
  return user.role === 'manager' && app.manager_id === user.id;
}

// ---------------------------------------------------------------------------
// автогенерирана първоначална парола по шаблон "име123" (напр. "Иван
// Иванов" -> "ivan123") — ползва се при създаване на потребител, ако админ
// не въведе парола ръчно, и при ръчно нулиране на забравена парола.
// Транслитерацията е опростена (БДС-подобна), достатъчна за читаемa
// временна парола — служителят винаги може да я смени сам след вход
// (виж PUT /api/me/password) или е принуден с must_change_password.
// ---------------------------------------------------------------------------
const CYRILLIC_TO_LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: '', ю: 'yu', я: 'ya',
};
function transliterate(str) {
  return String(str || '').toLowerCase().split('').map(ch => (ch in CYRILLIC_TO_LATIN ? CYRILLIC_TO_LATIN[ch] : ch)).join('');
}
function generateTempPassword(fullName) {
  const firstName = String(fullName || '').trim().split(/\s+/)[0] || '';
  const latinOnly = transliterate(firstName).replace(/[^a-z]/g, '');
  return `${latinOnly || 'user'}123`;
}

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12MB декодирано

function saveBase64Image(dataUrl, prefix) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Невалиден формат на снимката');
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIME.has(mimeType)) throw new Error('Неподдържан тип файл — приемат се само снимки (JPEG/PNG/WEBP)');
  const ext = mimeType.split('/')[1].replace('jpeg', 'jpg');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new Error('Празен файл');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Снимката е твърде голяма (макс. 12MB)');
  const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return { url: `/uploads/${filename}`, mimeType, base64: match[2] };
}

// запазва произволен файл, качен като data: URL (или чист base64), с дадено
// разширение — използва се за качване на .docx шаблони (виж /api/templates)
function saveBase64File(dataUrl, prefix, fallbackExt) {
  const raw = String(dataUrl || '');
  const match = /^data:([\w.+/-]+);base64,(.+)$/.exec(raw);
  const base64 = match ? match[2] : raw;
  const ext = fallbackExt || 'bin';
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('Празен или невалиден файл');
  if (buffer.length > MAX_IMAGE_BYTES * 2) throw new Error('Файлът е твърде голям');
  const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return { url: `/uploads/${filename}`, filename };
}

// чисти вход за витрината на маркетинг сайта — строго whitelist на полета;
// image_url се задава САМО през /image ендпойнта (качване), не директно тук,
// с изключение на null (премахване на вече качена снимка), за да не може
// някой да подсунe произволен външен URL, който да се показва на dombi.bg.
const FLEET_SHOWCASE_CATEGORIES = new Set(['economy', 'comfort', 'eco']);
const FLEET_SHOWCASE_BADGES = new Set([null, 'top', 'new']);
function sanitizeFleetShowcaseInput(body) {
  const out = {};
  if (body.name !== undefined) out.name = String(body.name || '').slice(0, 80);
  if (body.category !== undefined) {
    if (!FLEET_SHOWCASE_CATEGORIES.has(body.category)) throw new Error('Невалидна категория');
    out.category = body.category;
  }
  if (body.fuel !== undefined) out.fuel = String(body.fuel || '').slice(0, 40);
  if (body.transmission !== undefined) out.transmission = String(body.transmission || '').slice(0, 40);
  if (body.seats !== undefined) out.seats = Math.max(1, Math.min(9, Number(body.seats) || 5));
  if (body.badge !== undefined) {
    const badge = body.badge || null;
    if (!FLEET_SHOWCASE_BADGES.has(badge)) throw new Error('Невалиден бадж');
    out.badge = badge;
  }
  if (body.includes !== undefined) {
    if (!Array.isArray(body.includes)) throw new Error('includes трябва да е масив');
    out.includes = body.includes.map(s => String(s).slice(0, 120)).slice(0, 20);
  }
  if (body.requirements !== undefined) {
    if (!Array.isArray(body.requirements)) throw new Error('requirements трябва да е масив');
    out.requirements = body.requirements.map(s => String(s).slice(0, 120)).slice(0, 20);
  }
  if (body.linked_vehicle_ids !== undefined) {
    if (!Array.isArray(body.linked_vehicle_ids)) throw new Error('linked_vehicle_ids трябва да е масив');
    out.linked_vehicle_ids = body.linked_vehicle_ids.map(String).slice(0, 200);
  }
  if (body.active !== undefined) out.active = !!body.active;
  if (body.image_url === null) out.image_url = null;
  return out;
}

function sendBuffer(res, status, buffer, { contentType, filename, disposition } = {}) {
  res.writeHead(status, {
    'content-type': contentType || 'application/octet-stream',
    'content-length': buffer.length,
    'content-disposition': `${disposition || 'attachment'}; filename="${encodeURIComponent(filename || 'file')}"`,
  });
  res.end(buffer);
}

// esign помощник: единна работа с протокол/договор/трудов-граждански договор
// по documentType низ. ⚠️ За 'employment_contract' с contract_type='labor' —
// присъственото/отдалеченото SES разписване тук е само чернова/преглед, НЕ
// заместител на изискуемия по чл. 62 КТ квалифициран електронен подпис (КЕП)
// — виж бележката в lib/doc-builder.js и README.
function esignTarget(documentType) {
  if (documentType === 'protocol') return { get: db.getProtocol, update: db.updateProtocol };
  if (documentType === 'contract') return { get: db.getContract, update: db.updateContract };
  if (documentType === 'employment_contract') return { get: db.getEmploymentContract, update: db.updateEmploymentContract };
  return null;
}

// ---------------------------------------------------------------------------
// статични файлове
// ---------------------------------------------------------------------------
function serveStatic(req, res, urlPath) {
  let filePath;
  if (urlPath.startsWith('/uploads/')) {
    filePath = path.join(UPLOADS_DIR, urlPath.replace('/uploads/', ''));
  } else {
    // "/" вече показва публичния маркетинг сайт (index.html), не login.html —
    // за да може dombi.bg (custom domain, сочещ насам) да показва началната
    // страница, а не служебния login. Служителите влизат директно на
    // /login.html (връзката не се е променила, само голото "/" вече значи
    // друго).
    filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  }
  const resolved = path.normalize(filePath);
  if (!resolved.startsWith(PUBLIC_DIR) && !resolved.startsWith(UPLOADS_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Не е намерено');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// API рутер
// ---------------------------------------------------------------------------
// Публичните "кандидатствай"-ендпойнти трябва да са викаеми и от маркетинг
// сайта (отделен домейн — Render Static Site), затова тук им слагаме CORS.
// Умишлено НЕ слагаме CORS глобално — всички останали /api/* ендпойнти
// изискват сесийна бисквитка (HttpOnly, SameSite=Lax) и остават достъпни
// само от същия произход, за да не отваряме излишна повърхност за атака.
// формуляр за кандидатстване — валидни стойности за селектите (виж apply.html / apply-details.html)
const VALID_CITIES = new Set(['sofia', 'plovdiv', 'varna', 'burgas']);
const VALID_WORK_VEHICLES = new Set(['own_car', 'company_car', 'bicycle', 'scooter']);
const VALID_NATIONALITIES = new Set(['bulgarian', 'ukrainian', 'uzbek', 'other']);

// качва всички снимки на кандидатурата (ЛК лице/гръб, селфи, книжка лице/гръб,
// документи за чужди граждани), ако присъстват в тялото — общ хелпър за
// POST /api/apply и POST /api/apply/details/:token
function saveApplyPhotos(body) {
  const out = {};
  const map = {
    id_card_photo_front: ['id_card_photo_front_url', 'apply-idcard-front'],
    id_card_photo_back: ['id_card_photo_back_url', 'apply-idcard-back'],
    selfie_photo: ['selfie_photo_url', 'apply-selfie'],
    driver_license_photo_front: ['driver_license_photo_front_url', 'apply-license-front'],
    driver_license_photo_back: ['driver_license_photo_back_url', 'apply-license-back'],
    protection_status_photo: ['protection_status_photo_url', 'apply-protection'],
    residence_permit_photo: ['residence_permit_photo_url', 'apply-residence'],
    nap_certificate_photo: ['nap_certificate_photo_url', 'apply-nap'],
  };
  for (const [bodyKey, [outKey, prefix]] of Object.entries(map)) {
    if (body[bodyKey]) out[outKey] = saveBase64Image(body[bodyKey], prefix).url;
  }
  return out;
}

const PUBLIC_CORS_PATHS = new Set([
  '/api/apply', '/api/apply/id-card-scan', '/api/apply/license-scan',
  // витрината с коли на dombi.bg (Render Static Site, отделен произход) чете
  // само тук — публично, без сесия, без регистрационни номера (виж db.js)
  '/api/public/fleet-showcase',
  // съдържанието на началната страница (текстове, редактирани от админ панела
  // „Начална страница (сайт)“) — публичният сайт го чете без сесия
  '/api/site-content',
  // формата „Заяви наем на кола“ на публичния сайт — POST без сесия
  '/api/rent-requests',
]);

async function handleApi(req, res, pathname, query) {
  if (PUBLIC_CORS_PATHS.has(pathname)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }
  try {
    // ---- ВИТРИНА НА МАРКЕТИНГ САЙТА (публично, без сесия) ----------------
    if (pathname === '/api/public/fleet-showcase' && req.method === 'GET') {
      return sendJson(res, 200, { cars: db.getPublicFleetShowcase() });
    }

    // ---- СЪДЪРЖАНИЕ НА НАЧАЛНАТА СТРАНИЦА (dombi.bg) ----------------------
    // GET е публичен (без сесия, CORS) — четe го маркетинг сайтът. PUT е само
    // за админ/мениджър — вика се от /site-editor.html (същия произход).
    if (pathname === '/api/site-content' && req.method === 'GET') {
      return sendJson(res, 200, { content: db.getSiteContent() });
    }
    if (pathname === '/api/site-content' && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, { content: db.updateSiteContent(body) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- ЗАПИТВАНИЯ ЗА НАЕМ (форма „Заяви наем на кола“, dombi.bg) --------
    if (pathname === '/api/rent-requests' && req.method === 'POST') {
      if (rateLimited(`rent:${clientIp(req)}`, { max: 8, windowMs: 30 * 60 * 1000 })) {
        return sendJson(res, 429, { error: 'Твърде много запитвания от този адрес. Опитайте по-късно.' });
      }
      const body = await readJsonBody(req);
      if (!body.name || !body.phone) {
        return sendJson(res, 400, { error: 'Липсват задължителни полета (име, телефон)' });
      }
      const VALID_RENT_PURPOSE = new Set(['dombi', 'other-work', 'personal']);
      const rec = db.createRentRequest({
        name: escapeHtml(String(body.name).slice(0, 200)),
        phone: escapeHtml(String(body.phone).slice(0, 30)),
        email: body.email ? escapeHtml(String(body.email).slice(0, 200)) : null,
        city: body.city ? escapeHtml(String(body.city).slice(0, 100)) : null,
        car_id: body.car_id ? escapeHtml(String(body.car_id).slice(0, 80)) : null,
        car_name: body.car_name ? escapeHtml(String(body.car_name).slice(0, 120)) : null,
        purpose: VALID_RENT_PURPOSE.has(body.purpose) ? body.purpose : null,
        rent_period: body.rent_period ? escapeHtml(String(body.rent_period).slice(0, 120)) : null,
        message: body.message ? escapeHtml(String(body.message).slice(0, 1000)) : null,
      });
      // известяваме офиса по имейл — best-effort: заявката се записва и връща
      // успешно дори ако пощата не е конфигурирана/се провали
      try {
        await mail.sendMail({
          to: 'office@dombi.bg',
          subject: 'Ново запитване за наем на кола — dombi.bg',
          text: `Ново запитване за наем на кола:\n\nИме: ${rec.name}\nТелефон: ${rec.phone}\nИмейл: ${rec.email || '-'}\nГрад: ${rec.city || '-'}\nКола: ${rec.car_name || '-'}\nЦел: ${rec.purpose || '-'}\nПериод: ${rec.rent_period || '-'}\nСъобщение: ${rec.message || '-'}\n\nВсички запитвания: https://dombi-riders-backend.onrender.com/site-editor.html`,
        });
      } catch (err) {
        console.error('Грешка при изпращане на имейл известие за запитване за наем:', err.message);
      }
      return sendJson(res, 201, { request: { id: rec.id } });
    }
    if (pathname === '/api/rent-requests' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, { requests: db.listRentRequests() });
    }

    // ---- ВИТРИНА НА МАРКЕТИНГ САЙТА (админ панел) -------------------------
    if (pathname === '/api/admin/fleet-showcase' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, { items: db.listFleetShowcase() });
    }
    if (pathname === '/api/admin/fleet-showcase' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 201, { item: db.createFleetShowcaseItem(sanitizeFleetShowcaseInput(body)) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (pathname === '/api/admin/fleet-showcase/reorder' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      if (!Array.isArray(body.ids)) return sendJson(res, 400, { error: 'Липсва ids (масив)' });
      return sendJson(res, 200, { items: db.reorderFleetShowcase(body.ids) });
    }
    const fleetShowcaseItemMatch = pathname.match(/^\/api\/admin\/fleet-showcase\/([\w-]+)$/);
    if (fleetShowcaseItemMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, { item: db.updateFleetShowcaseItem(fleetShowcaseItemMatch[1], sanitizeFleetShowcaseInput(body)) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (fleetShowcaseItemMatch && req.method === 'DELETE') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      try {
        db.deleteFleetShowcaseItem(fleetShowcaseItemMatch[1]);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const fleetShowcaseImageMatch = pathname.match(/^\/api\/admin\/fleet-showcase\/([\w-]+)\/image$/);
    if (fleetShowcaseImageMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const item = db.getFleetShowcaseItem(fleetShowcaseImageMatch[1]);
      if (!item) return sendJson(res, 404, { error: 'Записът от витрината не е намерен' });
      const body = await readJsonBody(req);
      try {
        const { url } = saveBase64Image(body.file_base64, 'fleet-showcase');
        return sendJson(res, 200, { item: db.updateFleetShowcaseItem(fleetShowcaseImageMatch[1], { image_url: url }) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- AUTH ------------------------------------------------------------
    if (pathname === '/api/login' && req.method === 'POST') {
      const ipKey = `login:${clientIp(req)}`;
      if (rateLimited(ipKey, { max: 10, windowMs: 10 * 60 * 1000 })) {
        return sendJson(res, 429, { error: 'Твърде много опити за вход. Опитайте отново след няколко минути.' });
      }
      const { email, password } = await readJsonBody(req);
      const user = db.findUserByEmail(email || '');
      if (!user || !db.verifyPassword(password || '', user.password)) {
        return sendJson(res, 401, { error: 'Грешен имейл или парола' });
      }
      if (user.status !== 'active') {
        return sendJson(res, 403, { error: 'Акаунтът не е активен — свържете се с администратор' });
      }
      const token = db.createSession(user.id);
      const secureFlag = IS_PROD ? '; Secure' : '';
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secureFlag}`);
      const { password: _pw, ...safe } = user;
      return sendJson(res, 200, { user: safe });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies.session) db.destroySession(cookies.session);
      const secureFlag = IS_PROD ? '; Secure' : '';
      res.setHeader('Set-Cookie', `session=; HttpOnly; Path=/; Max-Age=0${secureFlag}`);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const user = getCurrentUser(req);
      return sendJson(res, 200, { user });
    }

    // ---- НАСТРОЙКИ НА МЕНЮТО (навигация) -------------------------------
    // Само label/ред се пазят в базата — href/икона/roles винаги идват от
    // кода (NAV масива в app.js), за да не може конфигурацията да бъде
    // ползвана за ескалиране на видимост на страници по роля.
    if (pathname === '/api/nav-config' && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return sendJson(res, 200, { config: db.getNavConfig() });
    }
    if (pathname === '/api/nav-config' && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      const groups = body.groups;
      if (!Array.isArray(groups)) return sendJson(res, 400, { error: 'Липсва groups (масив)' });
      const cleanGroups = [];
      for (const g of groups) {
        if (!g || typeof g !== 'object') return sendJson(res, 400, { error: 'Невалидна група' });
        const baseGroup = String(g.base_group || g.group || '').slice(0, 60);
        if (!baseGroup) return sendJson(res, 400, { error: 'Липсва base_group на групата' });
        const groupLabel = String(g.label || baseGroup).slice(0, 60);
        if (!Array.isArray(g.items)) return sendJson(res, 400, { error: 'Липсват елементи в група' });
        const cleanItems = [];
        for (const it of g.items) {
          if (!it || typeof it !== 'object' || !it.href) return sendJson(res, 400, { error: 'Невалиден елемент от менюто' });
          cleanItems.push({ href: String(it.href).slice(0, 200), label: String(it.label || '').slice(0, 80) });
        }
        cleanGroups.push({ base_group: baseGroup, label: groupLabel, items: cleanItems });
      }
      return sendJson(res, 200, { config: db.setNavConfig({ groups: cleanGroups }) });
    }
    if (pathname === '/api/nav-config/reset' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      db.resetNavConfig();
      return sendJson(res, 200, { config: null });
    }

    // ---- USERS (admin) -----------------------------------------------
    if (pathname === '/api/users' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, { users: db.listUsers() });
    }
    if (pathname === '/api/users' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      // ако админ не въведе парола, генерираме автоматично по шаблон "име123"
      // (виж generateTempPassword) — връщаме я еднократно в отговора, за да
      // може админът да я копира/сподели със служителя
      const autoGenerated = !body.password;
      const password = body.password || generateTempPassword(body.full_name);
      try {
        const created = db.createUser({ ...body, password });
        return sendJson(res, 201, { user: created, temp_password: autoGenerated ? password : undefined });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const userMatch = pathname.match(/^\/api\/users\/([\w-]+)$/);
    if (userMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      const updated = db.updateUser(userMatch[1], body);
      return sendJson(res, 200, { user: updated });
    }
    // ръчно нулиране на паролата на служител от админ (напр. забравена
    // парола) — по избор с конкретна нова парола, иначе автогенерирана по
    // шаблон "име123"; винаги маркира профила да поиска смяна при вход.
    const userResetPasswordMatch = pathname.match(/^\/api\/users\/([\w-]+)\/reset-password$/);
    if (userResetPasswordMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const target = db.findUserById(userResetPasswordMatch[1]);
      if (!target) return sendJson(res, 404, { error: 'Потребителят не е намерен' });
      const body = await readJsonBody(req);
      const newPassword = (body.password && String(body.password).length >= 4)
        ? body.password
        : generateTempPassword(target.full_name);
      const updated = db.updateUser(target.id, { password: newPassword, must_change_password: true });
      return sendJson(res, 200, { user: updated, temp_password: newPassword });
    }
    // самостоятелна смяна на собствена парола (всяка роля) — изисква
    // текущата парола за потвърждение; премахва флага must_change_password
    if (pathname === '/api/me/password' && req.method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const newPassword = String(body.new_password || '');
      if (newPassword.length < 4) return sendJson(res, 400, { error: 'Новата парола трябва да е поне 4 символа' });
      const full = db.findUserById(user.id);
      if (!full || !db.verifyPassword(body.current_password || '', full.password)) {
        return sendJson(res, 400, { error: 'Грешна текуща парола' });
      }
      db.updateUser(user.id, { password: newPassword, must_change_password: false });
      return sendJson(res, 200, { ok: true });
    }

    // ---- VEHICLES -------------------------------------------------------
    if (pathname === '/api/vehicles' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { vehicles: db.listVehicles() });
    }
    if (pathname === '/api/vehicles' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const vehicle = db.createVehicle({ ...body, created_by: user.id });
      return sendJson(res, 201, { vehicle });
    }

    const vehicleMatch = pathname.match(/^\/api\/vehicles\/([\w-]+)$/);
    if (vehicleMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const vehicle = db.getVehicle(vehicleMatch[1]);
      if (!vehicle) return sendJson(res, 404, { error: 'Не е намерена' });
      return sendJson(res, 200, { vehicle });
    }
    if (vehicleMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const vehicle = db.updateVehicle(vehicleMatch[1], body);
      return sendJson(res, 200, { vehicle });
    }
    if (vehicleMatch && req.method === 'DELETE') {
      // само admin — трайно изтриване на кола (напр. чистене на демо данни)
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      try {
        const vehicle = db.deleteVehicle(vehicleMatch[1]);
        return sendJson(res, 200, { ok: true, vehicle });
      } catch (err) {
        return sendJson(res, err.code === 'VEHICLE_HAS_HISTORY' ? 409 : 400, { error: err.message });
      }
    }

    // пробег (одометър) — история от всички източници + ръчно въвеждане
    const odoMatch = pathname.match(/^\/api\/vehicles\/([\w-]+)\/odometer$/);
    if (odoMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, {
        current_km: db.getCurrentOdometer(odoMatch[1]),
        last_service_km: db.getLastServiceOdometer(odoMatch[1]),
        logs: db.listOdometerLogs(odoMatch[1]),
      });
    }
    if (odoMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      if (body.km == null || isNaN(Number(body.km))) {
        return sendJson(res, 400, { error: 'Липсва валидна стойност за пробег (км)' });
      }
      const log = db.addOdometerLog(odoMatch[1], { km: Number(body.km), note: body.note || null, recorded_by: user.id });
      return sendJson(res, 201, { log, current_km: db.getCurrentOdometer(odoMatch[1]) });
    }

    // equipment
    const eqListMatch = pathname.match(/^\/api\/vehicles\/([\w-]+)\/equipment$/);
    if (eqListMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { equipment: db.listEquipment(eqListMatch[1]) });
    }
    if (eqListMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const item = db.addEquipment(eqListMatch[1], body);
      return sendJson(res, 201, { equipment: item });
    }

    // service records (сервизна книжка)
    const srListMatch = pathname.match(/^\/api\/vehicles\/([\w-]+)\/service-records$/);
    if (srListMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { records: db.listServiceRecords(srListMatch[1]) });
    }
    if (srListMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.addServiceRecord(srListMatch[1], { ...body, created_by: user.id });
      return sendJson(res, 201, { record: rec });
    }

    // месечен преглед (задължителен чек лист: външно/вътрешно/техническо
    // състояние + отговорник)
    const inspListMatch = pathname.match(/^\/api\/vehicles\/([\w-]+)\/inspections$/);
    if (inspListMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { inspections: db.listInspections(inspListMatch[1]) });
    }
    if (inspListMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.inspector_id) {
        return sendJson(res, 400, { error: 'Липсва отговорник (inspector_id) за прегледа' });
      }
      try {
        const rec = db.createInspection(inspListMatch[1], body);
        return sendJson(res, 201, { inspection: rec });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // recurring costs
    const rcListMatch = pathname.match(/^\/api\/vehicles\/([\w-]+)\/recurring-costs$/);
    if (rcListMatch && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, { costs: db.listRecurringCosts(rcListMatch[1]) });
    }
    if (rcListMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.addRecurringCost(rcListMatch[1], body);
      return sendJson(res, 201, { cost: rec });
    }

    // talon photo -> AI extraction, ПРЕДИ да съществува запис за колата
    // (използва се от формата "Нова кола", където vehicle_id още няма)
    if (pathname === '/api/talon-scan-preview' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const { mimeType, base64 } = saveBase64Image(body.photo, 'talon-preview');
      try {
        const extracted = await callClaudeVision(base64, mimeType);
        return sendJson(res, 200, { extracted });
      } catch (err) {
        if (err.message === 'NO_API_KEY') {
          return sendJson(res, 200, {
            extracted: null,
            warning: 'AI разчитането не е активно — задайте ANTHROPIC_API_KEY в Render. Въведете данните ръчно.',
          });
        }
        return sendJson(res, 200, { extracted: null, warning: err.message });
      }
    }

    // talon photo -> AI extraction
    const talonMatch = pathname.match(/^\/api\/vehicles\/([\w-]+)\/talon-scan$/);
    if (talonMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const { url, mimeType, base64 } = saveBase64Image(body.photo, 'talon');
      db.updateVehicle(talonMatch[1], { talon_photo_url: url });
      try {
        const extracted = await callClaudeVision(base64, mimeType);
        db.updateVehicle(talonMatch[1], { talon_data: extracted, talon_confirmed: false });
        return sendJson(res, 200, { photo_url: url, extracted });
      } catch (err) {
        if (err.message === 'NO_API_KEY') {
          return sendJson(res, 200, {
            photo_url: url,
            extracted: null,
            warning:
              'Снимката е качена, но AI разчитането не е активно — задайте ANTHROPIC_API_KEY в Render, за да се разчитат данните автоматично. Междувременно въведете полетата ръчно.',
          });
        }
        return sendJson(res, 200, { photo_url: url, extracted: null, warning: err.message });
      }
    }

    const talonConfirmMatch = pathname.match(/^\/api\/vehicles\/([\w-]+)\/talon-confirm$/);
    if (talonConfirmMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const vehicle = db.updateVehicle(talonConfirmMatch[1], {
        talon_data: body.talon_data,
        talon_confirmed: true,
        ...(body.apply_to_fields || {}),
      });
      return sendJson(res, 200, { vehicle });
    }

    // ---- ASSIGNMENTS ------------------------------------------------------
    if (pathname === '/api/assignments' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { assignments: db.listAssignments({ vehicleId: query.vehicle_id, driverId: query.driver_id }) });
    }
    if (pathname === '/api/assignments' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      // Протоколът и договорът за наем са ЗАДЪЛЖИТЕЛНИ при всяко зачисляване
      // на кола (не само през "1 клик" бутона) — затова минаваме винаги през
      // createAssignmentWithPaperwork, което ги създава атомарно и връща
      // и трите записа накуп.
      try {
        const result = db.createAssignmentWithPaperwork({ ...body, created_by: user.id });
        return sendJson(res, 201, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const endAssignMatch = pathname.match(/^\/api\/assignments\/([\w-]+)\/end$/);
    if (endAssignMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.endAssignment(endAssignMatch[1], body);
      return sendJson(res, 200, { assignment: rec });
    }

    // едно кликване: зачисляване на кола под наем към шофьор + автоматично
    // съставяне на договор за наем и приемо-предавателен протокол (готови
    // за разписване от esign панела, вместо да се съставят на отделни стъпки)
    if (pathname === '/api/assignments/one-click' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.vehicle_id || !body.driver_id) {
        return sendJson(res, 400, { error: 'Липсва кола или шофьор' });
      }
      try {
        const result = db.oneClickAssignVehicle({
          vehicleId: body.vehicle_id, driverId: body.driver_id,
          rateAmount: body.rate_amount, ratePeriod: body.rate_period,
          depositAmount: body.deposit_amount, createdBy: user.id,
        });
        return sendJson(res, 201, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- HANDOVER PROTOCOLS ------------------------------------------------
    if (pathname === '/api/protocols' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { protocols: db.listProtocols({ vehicleId: query.vehicle_id }) });
    }
    if (pathname === '/api/protocols' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const photos = (body.photos || []).map((dataUrl, i) => {
        const saved = saveBase64Image(dataUrl, 'protocol');
        return { url: saved.url, position: i };
      });
      const rec = db.createProtocol({ ...body, photos, created_by: user.id });
      return sendJson(res, 201, { protocol: rec });
    }
    const protocolMatch = pathname.match(/^\/api\/protocols\/([\w-]+)$/);
    if (protocolMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const rec = db.getProtocol(protocolMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'Не е намерен' });
      return sendJson(res, 200, { protocol: rec });
    }
    if (protocolMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.updateProtocol(protocolMatch[1], body);
      return sendJson(res, 200, { protocol: rec });
    }

    // изтегляне на протокол като .docx / .pdf (вградена бланка или качен шаблон)
    const protocolDocMatch = pathname.match(/^\/api\/protocols\/([\w-]+)\/(docx|pdf)$/);
    if (protocolDocMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const rec = db.getProtocol(protocolDocMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'Не е намерен' });
      const result = await docRender.renderDocument('protocol', rec, protocolDocMatch[2]);
      return sendBuffer(res, 200, result.buffer, { contentType: result.contentType, filename: result.filename });
    }

    // ---- RENTAL CONTRACTS ---------------------------------------------
    if (pathname === '/api/contracts' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, { contracts: db.listContracts({ vehicleId: query.vehicle_id }) });
    }
    if (pathname === '/api/contracts' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.createContract({ ...body, created_by: user.id });
      return sendJson(res, 201, { contract: rec });
    }
    const contractMatch = pathname.match(/^\/api\/contracts\/([\w-]+)$/);
    if (contractMatch && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const rec = db.getContract(contractMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'Не е намерен' });
      return sendJson(res, 200, { contract: rec });
    }
    if (contractMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.updateContract(contractMatch[1], body);
      return sendJson(res, 200, { contract: rec });
    }

    // изтегляне на договор като .docx / .pdf (вградена бланка или качен шаблон)
    const contractDocMatch = pathname.match(/^\/api\/contracts\/([\w-]+)\/(docx|pdf)$/);
    if (contractDocMatch && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const rec = db.getContract(contractDocMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'Не е намерен' });
      const result = await docRender.renderDocument('contract', rec, contractDocMatch[2]);
      return sendBuffer(res, 200, result.buffer, { contentType: result.contentType, filename: result.filename });
    }

    // ---- PAYMENTS (приходи/разходи) -----------------------------------
    if (pathname === '/api/payments' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, { payments: db.listPayments({ vehicleId: query.vehicle_id }) });
    }
    if (pathname === '/api/payments' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.addPayment(body);
      return sendJson(res, 201, { payment: rec });
    }

    // ---- ПОРТФЕЙЛИ (Wallet) ----------------------------------------------
    // Вътрешна счетоводна книга (не истински банков превод) — салдото винаги
    // се извежда от сбора на транзакциите, никога не се пази директно.

    // лек списък с потребители (само id/име/роля) — достъпен за всеки вписан
    // потребител, за да може да избере получател на превод (за разлика от
    // /api/users, който е само за admin/manager и връща пълния запис)
    if (pathname === '/api/wallet/directory' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const directory = db.listUsers()
        .filter(u => u.status === 'active')
        .map(u => ({ id: u.id, full_name: u.full_name, role: u.role }));
      return sendJson(res, 200, { users: directory });
    }

    if (pathname === '/api/wallet' && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return sendJson(res, 200, {
        balance: db.getWalletBalance(user.id),
        transactions: db.listWalletTransactions(user.id),
        can_approve_transfers: db.canApproveTransfers(user),
      });
    }

    // преглед на всички портфейли (само админ/мениджър) — за общ преглед
    if (pathname === '/api/wallet/users' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const wallets = db.listUsers().map(u => ({
        user_id: u.id, full_name: u.full_name, role: u.role,
        balance: db.getWalletBalance(u.id),
      }));
      return sendJson(res, 200, { wallets });
    }

    const walletUserMatch = pathname.match(/^\/api\/wallet\/users\/([\w-]+)$/);
    if (walletUserMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = walletUserMatch[1];
      if (targetId !== user.id && !['admin', 'manager'].includes(user.role)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      return sendJson(res, 200, {
        balance: db.getWalletBalance(targetId),
        transactions: db.listWalletTransactions(targetId),
      });
    }

    if (pathname === '/api/wallet/transfers' && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const canSeeAll = db.canApproveTransfers(user);
      const filter = { status: query.status || undefined };
      if (!(canSeeAll && query.scope === 'all')) filter.userId = user.id;
      return sendJson(res, 200, { transfers: db.listWalletTransfers(filter) });
    }

    if (pathname === '/api/wallet/transfers' && req.method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.to_user_id) return sendJson(res, 400, { error: 'Липсва получател' });
      try {
        const rec = db.createWalletTransfer({
          from_user_id: user.id, to_user_id: body.to_user_id,
          amount: body.amount, note: body.note, requested_by: user.id,
        });
        // ако подателят сам има право да одобрява преводи, одобряваме веднага
        if (db.canApproveTransfers(user)) {
          const decided = db.decideWalletTransfer(rec.id, { approve: true, decided_by: user.id, decision_note: 'Автоматично одобрен (подателят има права)' });
          return sendJson(res, 201, { transfer: decided });
        }
        return sendJson(res, 201, { transfer: rec });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    const walletDecideMatch = pathname.match(/^\/api\/wallet\/transfers\/([\w-]+)\/decide$/);
    if (walletDecideMatch && req.method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!db.canApproveTransfers(user)) return sendJson(res, 403, { error: 'Нямате права да одобрявате преводи' });
      const body = await readJsonBody(req);
      try {
        const rec = db.decideWalletTransfer(walletDecideMatch[1], { approve: !!body.approve, decided_by: user.id, decision_note: body.decision_note });
        return sendJson(res, 200, { transfer: rec });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    const walletCancelMatch = pathname.match(/^\/api\/wallet\/transfers\/([\w-]+)\/cancel$/);
    if (walletCancelMatch && req.method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      try {
        const rec = db.cancelWalletTransfer(walletCancelMatch[1], user.id);
        return sendJson(res, 200, { transfer: rec });
      } catch (err) {
        if (user.role === 'admin') {
          // админ може да отменя чужди чакащи заявки (отхвърля ги вместо одобрение)
          try {
            const forced = db.decideWalletTransfer(walletCancelMatch[1], { approve: false, decided_by: user.id, decision_note: 'Отменено от админ' });
            return sendJson(res, 200, { transfer: forced });
          } catch (err2) { return sendJson(res, 400, { error: err2.message }); }
        }
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ръчна корекция на баланс (само админ) — депозит/тегление/корекция
    if (pathname === '/api/wallet/adjustments' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.user_id || body.amount == null || isNaN(Number(body.amount))) {
        return sendJson(res, 400, { error: 'Липсва потребител или невалидна сума' });
      }
      const rec = db.addWalletAdjustment({
        user_id: body.user_id, amount: Number(body.amount),
        type: body.type || 'admin_adjustment', note: body.note, created_by: user.id,
      });
      return sendJson(res, 201, { transaction: rec, balance: db.getWalletBalance(body.user_id) });
    }

    // ---- СЧЕТОВОДСТВО (общ финансов отчет + ръчна счетоводна книга) -------
    if (pathname === '/api/finance/report' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const report = db.getCompanyFinanceReport({ from: query.from, to: query.to });
      return sendJson(res, 200, report);
    }
    if (pathname === '/api/finance/entries' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, { entries: db.listFinanceEntries({ from: query.from, to: query.to }) });
    }
    if (pathname === '/api/finance/entries' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        const rec = db.addFinanceEntry({
          entry_date: body.entry_date, direction: body.direction,
          category: body.category ? escapeHtml(String(body.category).slice(0, 100)) : null,
          amount: body.amount, note: body.note ? escapeHtml(String(body.note).slice(0, 500)) : null,
          created_by: user.id,
        });
        return sendJson(res, 201, { entry: rec });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const financeEntryMatch = pathname.match(/^\/api\/finance\/entries\/([\w-]+)$/);
    if (financeEntryMatch && req.method === 'DELETE') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      try {
        db.deleteFinanceEntry(financeEntryMatch[1]);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- БЕКЪПИ (автоматични резервни копия на базата, виж lib/backup.js) -
    if (pathname === '/api/backups' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      return sendJson(res, 200, { backups: backup.listBackups(), dataDir: backup.DATA_DIR });
    }
    if (pathname === '/api/backups/run' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      try {
        const filename = backup.writeBackup(db.readDb(), { reason: 'manual' });
        return sendJson(res, 201, { ok: true, filename });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const backupDownloadMatch = pathname.match(/^\/api\/backups\/([\w.-]+)\/download$/);
    if (backupDownloadMatch && req.method === 'GET') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      try {
        const raw = backup.readBackupFile(decodeURIComponent(backupDownloadMatch[1]));
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${backupDownloadMatch[1]}"`,
        });
        return res.end(raw);
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
    }
    const backupRestoreMatch = pathname.match(/^\/api\/backups\/([\w.-]+)\/restore$/);
    if (backupRestoreMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      try {
        const raw = backup.readBackupFile(decodeURIComponent(backupRestoreMatch[1]));
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.data || typeof parsed.data !== 'object') throw new Error('Повреден файл с бекъп');
        // предпазен бекъп на ТЕКУЩОТО състояние точно преди да го презапишем
        backup.writeBackup(db.readDb(), { reason: 'pre-restore' });
        db.writeDb(parsed.data);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- ПОЩЕНСКА КУТИЯ (office@dombi.bg през Zoho Mail, виж lib/mail.js) -
    if (pathname === '/api/mail/inbox' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      try {
        const limit = Math.min(Math.max(parseInt(query.limit, 10) || 30, 1), 100);
        const messages = await mail.listInbox({ limit });
        return sendJson(res, 200, { messages });
      } catch (err) {
        return sendJson(res, err.code === 'MAIL_NOT_CONFIGURED' ? 503 : 502, { error: err.message });
      }
    }
    if (pathname === '/api/mail/sent' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      try {
        const limit = Math.min(Math.max(parseInt(query.limit, 10) || 30, 1), 100);
        const messages = await mail.listSent({ limit });
        return sendJson(res, 200, { messages });
      } catch (err) {
        return sendJson(res, err.code === 'MAIL_NOT_CONFIGURED' ? 503 : 502, { error: err.message });
      }
    }
    const mailMessageMatch = pathname.match(/^\/api\/mail\/message\/([\w-]+)$/);
    if (mailMessageMatch && req.method === 'GET') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      try {
        const folder = query.folder || 'INBOX';
        const message = await mail.getMessage(mailMessageMatch[1], folder);
        return sendJson(res, 200, { message });
      } catch (err) {
        const status = err.code === 'MAIL_NOT_CONFIGURED' ? 503 : (err.code === 'MAIL_NOT_FOUND' ? 404 : 502);
        return sendJson(res, status, { error: err.message });
      }
    }
    const mailAttachmentMatch = pathname.match(/^\/api\/mail\/message\/([\w-]+)\/attachment\/(\d+)$/);
    if (mailAttachmentMatch && req.method === 'GET') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      try {
        const folder = query.folder || 'INBOX';
        const att = await mail.getAttachment(mailAttachmentMatch[1], parseInt(mailAttachmentMatch[2], 10), folder);
        res.writeHead(200, {
          'content-type': att.contentType,
          'content-disposition': `attachment; filename="${att.filename.replace(/"/g, '')}"`,
        });
        return res.end(att.content);
      } catch (err) {
        const status = err.code === 'MAIL_NOT_CONFIGURED' ? 503 : (err.code === 'MAIL_NOT_FOUND' ? 404 : 502);
        return sendJson(res, status, { error: err.message });
      }
    }
    if (pathname === '/api/mail/send' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.to || !body.subject || !body.text) {
        return sendJson(res, 400, { error: 'Липсва получател, тема или текст на писмото' });
      }
      const to = normalizeEmailList(String(body.to).slice(0, 2000), 25);
      const cc = body.cc ? normalizeEmailList(String(body.cc).slice(0, 2000), 25) : '';
      if (!to) {
        return sendJson(res, 400, { error: 'Липсва валиден получател' });
      }
      // прикачени файлове при препращане — идват от клиента вече като base64
      // (свалени преди това от оригиналното писмо през /attachment route)
      let attachments;
      if (Array.isArray(body.attachments) && body.attachments.length) {
        attachments = body.attachments.slice(0, 10).map(a => ({
          filename: String(a.filename || 'прикачен-файл').slice(0, 255),
          contentType: a.contentType ? String(a.contentType).slice(0, 120) : undefined,
          content: String(a.content || ''),
        })).filter(a => a.content);
      }
      try {
        const result = await mail.sendMail({
          to,
          cc: cc || undefined,
          subject: String(body.subject).slice(0, 300),
          text: String(body.text).slice(0, 20000),
          inReplyTo: body.inReplyTo || undefined,
          references: body.references || undefined,
          attachments,
        });
        return sendJson(res, 200, { ok: true, messageId: result.messageId });
      } catch (err) {
        return sendJson(res, err.code === 'MAIL_NOT_CONFIGURED' ? 503 : 502, { error: err.message });
      }
    }

    // ---- ЛИЧНИ ДОСИЕТА (HR картотека на документите) ---------------------
    // Служебна карта на служителя: лична карта, шофьорска книжка, трудови/
    // граждански договори, договори за наем и протоколи, на едно място +
    // изтичащи документи (виж getEmployeeDocumentAlerts, обединено в /api/dashboard).
    if (pathname === '/api/hr/personnel' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const alerts = db.getEmployeeDocumentAlerts();
      const nextAlertByProfile = {};
      alerts.forEach(a => { if (!nextAlertByProfile[a.profile_id]) nextAlertByProfile[a.profile_id] = a; });
      // платформи (Bolt/Glovo), на които служителят реално има внесена заработка —
      // изведени от седмичните записи в заплати (payroll_entries), а не от еднократното
      // поле glovo_bolt_platform от кандидатурата (което е само историческа справка)
      const platformsByProfile = {};
      db.listPayrollEntries().forEach(p => {
        const set = platformsByProfile[p.profile_id] || (platformsByProfile[p.profile_id] = new Set());
        if (p.platform_breakdown) {
          Object.keys(p.platform_breakdown).forEach(k => set.add(k));
        } else if (p.source === 'bolt+glovo') {
          set.add('bolt'); set.add('glovo');
        } else if (p.source === 'bolt' || p.source === 'glovo') {
          set.add(p.source);
        }
      });
      const employees = db.listUsers().map(u => ({
        id: u.id, full_name: u.full_name, email: u.email, phone: u.phone || '', role: u.role, status: u.status,
        manager_id: u.manager_id || null,
        city: u.city || null,
        blacklisted: !!u.blacklisted,
        id_card_expiry: u.id_card_expiry || null,
        driver_license_expiry: u.driver_license_expiry || null,
        next_alert: nextAlertByProfile[u.id] || null,
        platforms: platformsByProfile[u.id] ? [...platformsByProfile[u.id]] : [],
      }));
      return sendJson(res, 200, { employees });
    }

    const personnelMatch = pathname.match(/^\/api\/hr\/personnel\/([\w-]+)$/);
    if (personnelMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = personnelMatch[1];
      if (targetId !== user.id && !['admin', 'manager'].includes(user.role)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      try {
        const file = db.getPersonnelFile(targetId);
        return sendJson(res, 200, file);
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
    }
    if (personnelMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const allowed = ['egn', 'address', 'city', 'manager_id', 'full_name', 'phone', 'status',
        'id_card_number', 'id_card_expiry', 'driver_license_number', 'driver_license_expiry',
        'start_date', 'end_date'];
      // смяна на роля и имейл — само admin (по-чувствителни полета)
      if (user.role === 'admin') allowed.push('role', 'email');
      const patch = {};
      allowed.forEach(k => { if (k in body) patch[k] = body[k]; });
      if (patch.email && db.listUsers().some(u => u.id !== personnelMatch[1] && u.email.toLowerCase() === String(patch.email).toLowerCase())) {
        return sendJson(res, 400, { error: 'Вече има потребител с този имейл' });
      }
      try {
        const updated = db.updateUser(personnelMatch[1], patch);
        return sendJson(res, 200, { profile: updated });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    // трайно изтриване на служител (само admin) — блокирано, ако има свързана история
    if (personnelMatch && req.method === 'DELETE') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      if (personnelMatch[1] === user.id) {
        return sendJson(res, 400, { error: 'Не можете да изтриете собствения си профил.' });
      }
      try {
        const removed = db.deleteUser(personnelMatch[1]);
        return sendJson(res, 200, { ok: true, profile: removed });
      } catch (err) {
        return sendJson(res, err.code === 'EMPLOYEE_HAS_HISTORY' ? 409 : 400, { error: err.message });
      }
    }
    // черен списък (само admin)
    const personnelBlacklistMatch = pathname.match(/^\/api\/hr\/personnel\/([\w-]+)\/blacklist$/);
    if (personnelBlacklistMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        const updated = db.setUserBlacklist(personnelBlacklistMatch[1], {
          blacklisted: !!body.blacklisted, reason: body.reason, actor_id: user.id,
        });
        return sendJson(res, 200, { profile: updated });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    // с 1 клик: генерира уникален линк, по който служителят сам допълва/обновява
    // ЛК/книжка/ЕГН/адрес/телефон — без вход в системата (виж и линка за кандидатури по-долу)
    const personnelSendLinkMatch = pathname.match(/^\/api\/hr\/personnel\/([\w-]+)\/send-link$/);
    if (personnelSendLinkMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      try {
        const profile = db.generatePersonnelLink(personnelSendLinkMatch[1]);
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers.host;
        const link = `${proto}://${host}/personnel-details.html?token=${profile.personnel_token}`;
        return sendJson(res, 200, { link });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // side='front'|'back' — качват се отделно (виж и apply.html/apply-details.html,
    // където кандидатите вече качват лице/гръб поотделно при кандидатстване)
    const personnelIdPhotoMatch = pathname.match(/^\/api\/hr\/personnel\/([\w-]+)\/id-card-photo$/);
    if (personnelIdPhotoMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const { url } = saveBase64Image(body.photo, 'idcard');
      const field = body.side === 'back' ? 'id_card_photo_back_url' : 'id_card_photo_url';
      const updated = db.updateUser(personnelIdPhotoMatch[1], { [field]: url });
      return sendJson(res, 200, { profile: updated });
    }
    const personnelLicensePhotoMatch = pathname.match(/^\/api\/hr\/personnel\/([\w-]+)\/license-photo$/);
    if (personnelLicensePhotoMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const { url } = saveBase64Image(body.photo, 'license');
      const field = body.side === 'back' ? 'driver_license_photo_back_url' : 'driver_license_photo_url';
      const updated = db.updateUser(personnelLicensePhotoMatch[1], { [field]: url });
      return sendJson(res, 200, { profile: updated });
    }
    const personnelSelfiePhotoMatch = pathname.match(/^\/api\/hr\/personnel\/([\w-]+)\/selfie-photo$/);
    if (personnelSelfiePhotoMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const { url } = saveBase64Image(body.photo, 'selfie');
      const updated = db.updateUser(personnelSelfiePhotoMatch[1], { selfie_photo_url: url });
      return sendJson(res, 200, { profile: updated });
    }

    // трудови / граждански договори (седмични удръжки по подразбиране, ръчно променими)
    if (pathname === '/api/hr/deduction-defaults' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, { defaults: db.getDeductionDefaults() });
    }
    if (pathname === '/api/hr/deduction-defaults' && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      return sendJson(res, 200, { defaults: db.setDeductionDefaults(body) });
    }

    const employmentContractsMatch = pathname === '/api/hr/employment-contracts';
    if (employmentContractsMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = query.profile_id;
      if (!targetId) return sendJson(res, 400, { error: 'Липсва profile_id' });
      if (targetId !== user.id && !['admin', 'manager'].includes(user.role)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      return sendJson(res, 200, { contracts: db.listEmploymentContracts(targetId) });
    }
    if (employmentContractsMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.profile_id || !body.contract_type || !body.start_date) {
        return sendJson(res, 400, { error: 'Липсват задължителни полета' });
      }
      const rec = db.createEmploymentContract({ ...body, created_by: user.id });
      return sendJson(res, 201, { contract: rec });
    }
    const employmentContractMatch = pathname.match(/^\/api\/hr\/employment-contracts\/([\w-]+)$/);
    if (employmentContractMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.updateEmploymentContract(employmentContractMatch[1], body);
      return sendJson(res, 200, { contract: rec });
    }

    // изтегляне на трудов/граждански договор като .docx / .pdf — достъпен и за
    // самия служител (за да си свали/прегледа собствения договор), не само админ/мениджър
    const employmentContractDocMatch = pathname.match(/^\/api\/hr\/employment-contracts\/([\w-]+)\/(docx|pdf)$/);
    if (employmentContractDocMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const rec = db.getEmploymentContract(employmentContractDocMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'Не е намерен' });
      if (rec.profile_id !== user.id && !['admin', 'manager'].includes(user.role)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const result = await docRender.renderDocument('employment_contract', rec, employmentContractDocMatch[2]);
      return sendBuffer(res, 200, result.buffer, { contentType: result.contentType, filename: result.filename });
    }

    // прикачване на скенер на вече подписан (извън системата, на хартия) трудов/
    // граждански договор към съществуващ запис. createEmploymentContract вече
    // покрива определянето на удръжката по вид на договора или ръчно — тук само
    // добавяме доказателство (снимка/PDF) на хартиения оригинал към записа.
    const employmentContractScanMatch = pathname.match(/^\/api\/hr\/employment-contracts\/([\w-]+)\/scan$/);
    if (employmentContractScanMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const rec = db.getEmploymentContract(employmentContractScanMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'Договорът не е намерен' });
      const body = await readJsonBody(req);
      const raw = String(body.file_base64 || '');
      const mimeMatch = /^data:([\w.+/-]+);base64,/.exec(raw);
      const mimeType = mimeMatch ? mimeMatch[1].toLowerCase() : '';
      const EXT_BY_MIME = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
      const ext = EXT_BY_MIME[mimeType];
      if (!ext) return sendJson(res, 400, { error: 'Неподдържан формат — приемат се снимка (JPEG/PNG/WEBP) или PDF' });
      try {
        const { url } = saveBase64File(body.file_base64, 'contract-scan', ext);
        const updated = db.updateEmploymentContract(employmentContractScanMatch[1], { scan_url: url });
        return sendJson(res, 200, { contract: updated });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- СЕДМИЧНИ ЗАПЛАТИ (Payroll) ---------------------------------------
    // ⚠️ Разписването тук потвърждава ИЗРИЧНО САМО броя поръчки за седмицата —
    // никога паричната стойност (виж buildPayrollConfirmationPdf в
    // lib/pdf-builder.js, което е единственият документ, подаван към esign
    // хеширането оттук — не renderDocument, за да няма как случайно да се
    // включи сума в подписания документ).
    if (pathname === '/api/hr/payroll' && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetProfileId = query.profile_id;
      if (targetProfileId && targetProfileId !== user.id && !['admin', 'manager'].includes(user.role)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const profileId = targetProfileId || (['admin', 'manager'].includes(user.role) ? undefined : user.id);
      let entries = db.listPayrollEntries({ profileId, weekStart: query.week_start });
      // ако заявителят е самият шофьор и админ не му е разрешил да вижда
      // заработката, оставяме само броя поръчки — сумите се скриват изцяло
      const viewingOwnWithoutEarnings = profileId === user.id && !['admin', 'manager'].includes(user.role) && !db.canViewEarnings(user);
      if (viewingOwnWithoutEarnings) {
        entries = entries.map(e => ({
          ...e, gross_earnings: null, deduction_amount: null, net_amount: null,
        }));
      }
      return sendJson(res, 200, { entries, earnings_visible: !viewingOwnWithoutEarnings });
    }
    if (pathname === '/api/hr/payroll' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.profile_id || !body.week_start || !body.week_end) {
        return sendJson(res, 400, { error: 'Липсват задължителни полета (служител, начало/край на седмица)' });
      }
      const rec = db.upsertPayrollEntry({
        profile_id: body.profile_id, week_start: body.week_start, week_end: body.week_end,
        order_count: Number(body.order_count) || 0, gross_earnings: Number(body.gross_earnings) || 0,
        deduction_amount: body.deduction_amount != null ? Number(body.deduction_amount) : undefined,
        source: body.source || 'manual',
      });
      return sendJson(res, 200, { entry: rec });
    }

    // ---- Импорт на реални седмични заработки от Bolt/Glovo Excel файл -----
    // Двустъпков поток от UI-то на "Заплати":
    //  1) POST .../import/preview  -> само разчита файла, съпоставя по телефон
    //     със съществуващи профили (role=driver), НИЩО не записва.
    //  2) POST .../import/apply    -> действително пише payroll_entries; за
    //     несъпоставени по телефон куриери, по избор на администратора,
    //     създава нови профили (role=driver, временна парола) ИЛИ ги пропуска.
    // Ако платформата за дадена (профил, седмица) вече има запис от ДРУГАТА
    // платформа, сумите се СЪБИРАТ в един запис (source: 'bolt+glovo') —
    // както при еднократния бекфил на историята.
    if (pathname === '/api/hr/payroll/import/status' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, { available: earningsImport.isAvailable() });
    }

    function matchDriverByPhone(phone, driverProfiles) {
      if (!phone) return null;
      return driverProfiles.find(p => earningsImport.normPhone(p.phone) === phone) || null;
    }

    function parseImportFile(platform, fileBase64) {
      const buffer = Buffer.from(String(fileBase64 || '').replace(/^data:[^,]*,/, ''), 'base64');
      if (!buffer.length) throw new Error('Празен или невалиден файл');
      if (platform === 'bolt') {
        const { records, errors } = earningsImport.parseBoltWorkbook(buffer);
        return [{ week_start: null, week_end: null, records, errors, needs_week_input: true }];
      }
      if (platform === 'glovo') {
        return earningsImport.parseGlovoWorkbook(buffer).map(w => ({ ...w, needs_week_input: !w.week_start }));
      }
      throw new Error('Невалидна платформа — очаква се "bolt" или "glovo"');
    }

    if (pathname === '/api/hr/payroll/import/preview' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      if (!earningsImport.isAvailable()) {
        return sendJson(res, 503, { error: 'Импортът изисква пакета "xlsx", който не е наличен в тази среда (виж бележката в lib/earnings-import.js).' });
      }
      const body = await readJsonBody(req);
      let weeks;
      try { weeks = parseImportFile(body.platform, body.file_base64); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }

      const driverProfiles = db.listUsers().filter(p => p.role === 'driver');
      const outWeeks = weeks.map(wk => {
        const matched = [];
        const unmatched = [];
        wk.records.forEach(r => {
          const profile = matchDriverByPhone(r.phone, driverProfiles);
          const row = { ...r, profile_id: profile ? profile.id : null, profile_name: profile ? profile.full_name : null };
          (profile ? matched : unmatched).push(row);
        });
        return { week_start: wk.week_start, week_end: wk.week_end, needs_week_input: wk.needs_week_input, matched, unmatched, errors: wk.errors };
      });
      return sendJson(res, 200, { platform: body.platform, weeks: outWeeks });
    }

    if (pathname === '/api/hr/payroll/import/apply' && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      if (!earningsImport.isAvailable()) {
        return sendJson(res, 503, { error: 'Импортът изисква пакета "xlsx", който не е наличен в тази среда.' });
      }
      const body = await readJsonBody(req);
      let weeks;
      try { weeks = parseImportFile(body.platform, body.file_base64); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }

      // ако Bolt файлът не носи седмица в себе си, администраторът я подава ръчно
      const overrideWeekStart = body.week_start;
      const overrideWeekEnd = body.week_end;
      const createMissing = !!body.create_missing_profiles;

      let archivedFile = null;
      try { archivedFile = saveBase64File(body.file_base64, `payroll-import-${body.platform}`, 'xlsx'); }
      catch (e) { /* архивирането на оригиналния файл е best-effort, не блокира импорта */ }

      const driverProfiles = db.listUsers().filter(p => p.role === 'driver');
      const created = [];
      const stillUnmatched = [];
      const writtenEntries = [];

      for (const wk of weeks) {
        const weekStart = wk.week_start || overrideWeekStart;
        const weekEnd = wk.week_end || overrideWeekEnd;
        if (!weekStart || !weekEnd) {
          return sendJson(res, 400, { error: 'Липсва седмица (начало/край) — Bolt файлът не я съдържа, подайте week_start/week_end.' });
        }
        for (const r of wk.records) {
          let profile = matchDriverByPhone(r.phone, driverProfiles);
          if (!profile && createMissing) {
            const placeholderEmail = r.email || `${(r.courier_uid || r.courier_id || '').toLowerCase()}@imported.dombi.bg`;
            try {
              profile = db.createUser({
                full_name: (r.name || `${r.first_name || ''} ${r.last_name || ''}`).trim() || '(без име)',
                email: placeholderEmail,
                password: crypto.randomBytes(9).toString('base64url'),
                phone: earningsImport.fmtPhone(r.phone),
                role: 'driver',
              });
              db.updateUser(profile.id, { egn: r.egn || '', status: 'active', source: `import_${body.platform}_${weekStart}` });
              driverProfiles.push(profile);
              created.push({ id: profile.id, full_name: profile.full_name });
            } catch (e) {
              stillUnmatched.push({ ...r, reason: 'Неуспешно създаване на профил: ' + e.message });
              continue;
            }
          }
          if (!profile) {
            stillUnmatched.push(r);
            continue;
          }

          const existing = db.listPayrollEntries({ profileId: profile.id, weekStart }).find(e => e.week_start === weekStart);
          const otherPlatform = existing && existing.platform_breakdown ? { ...existing.platform_breakdown } : {};
          otherPlatform[r.platform] = r.gross_earnings;
          const sources = Object.keys(otherPlatform);
          const combinedGross = Math.round(Object.values(otherPlatform).reduce((a, b) => a + Number(b || 0), 0) * 100) / 100;
          const combinedOrders = (existing && existing.source !== r.platform ? Number(existing.order_count || 0) : 0) + Number(r.order_count || 0);

          const rec = db.upsertPayrollEntry({
            profile_id: profile.id, week_start: weekStart, week_end: weekEnd,
            order_count: r.order_count_unknown && existing ? existing.order_count : combinedOrders,
            gross_earnings: combinedGross,
            deduction_amount: existing ? existing.deduction_amount : undefined,
            source: sources.length > 1 ? 'bolt+glovo' : r.platform,
            platform_breakdown: otherPlatform,
            needs_review: !!r.needs_review || (existing ? !!existing.needs_review : false),
            order_count_unknown: !!r.order_count_unknown,
            import_file: archivedFile ? archivedFile.url : (existing ? existing.import_file : null),
          });
          writtenEntries.push(rec.id);
        }
      }

      return sendJson(res, 200, {
        written_entries: writtenEntries.length,
        created_profiles: created,
        unmatched: stillUnmatched,
      });
    }

    const payrollEsignMatch = pathname.match(/^\/api\/hr\/payroll\/([\w-]+)\/esign-events$/);
    if (payrollEsignMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const entry = db.getPayrollEntry(payrollEsignMatch[1]);
      if (!entry) return sendJson(res, 404, { error: 'Записът не е намерен' });
      if (entry.profile_id !== user.id && !['admin', 'manager'].includes(user.role)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      return sendJson(res, 200, { events: db.listEsignEvents('payroll', entry.id) });
    }

    const payrollSignMatch = pathname.match(/^\/api\/hr\/payroll\/([\w-]+)\/sign$/);
    if (payrollSignMatch && req.method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const entry = db.getPayrollEntry(payrollSignMatch[1]);
      if (!entry) return sendJson(res, 404, { error: 'Записът не е намерен' });
      if (entry.profile_id !== user.id && !['admin', 'manager'].includes(user.role)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const body = await readJsonBody(req);
      if (!body.signer_name) return sendJson(res, 400, { error: 'Липсва име на подписващия' });
      const employee = db.findUserById(entry.profile_id);

      let signatureImageUrl = null;
      if (body.signature_image) {
        try { signatureImageUrl = saveBase64Image(body.signature_image, 'signature').url; }
        catch (e) { /* позволяваме подпис само с изписано име, без картинка */ }
      }

      const docBuffer = await pdfBuilder.buildPayrollConfirmationPdf({
        entry, employeeName: employee ? employee.full_name : entry.profile_id,
      });
      const result = esign.recordInPersonSignature({
        documentBuffer: docBuffer,
        signerName: body.signer_name,
        signerRole: 'Служител',
        signatureImageUrl,
        ipAddress: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
        userAgent: req.headers['user-agent'] || null,
      });
      const event = db.addEsignEvent({ document_type: 'payroll', document_id: entry.id, ...result });
      const signed = db.signPayrollEntry(entry.id, { signed_by_name: result.signer_name });
      return sendJson(res, 200, { event, entry: signed });
    }

    const payrollPaidMatch = pathname.match(/^\/api\/hr\/payroll\/([\w-]+)\/mark-paid$/);
    if (payrollPaidMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.markPayrollPaid(payrollPaidMatch[1], body.paid !== false);
      return sendJson(res, 200, { entry: rec });
    }

    // ---- ОТПУСКИ (Leave) --------------------------------------------------
    // Заявка → одобрение от прекия мениджър/админ → приспадане от баланса.
    // DEFAULT_ANNUAL_LEAVE_DAYS (20) следва минимума по чл. 155 КТ — не е
    // правен съвет, виж README за пълния коментар по темата.
    if (pathname === '/api/hr/leave/balance' && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = query.profile_id || user.id;
      if (targetId !== user.id && !['admin', 'manager'].includes(user.role)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const year = Number(query.year) || new Date().getFullYear();
      const balance = db.getLeaveBalance(targetId, year);
      const usedAnnualDays = db.getUsedLeaveDays(targetId, year, 'annual');
      const remainingDays = (Number(balance.entitled_days) + Number(balance.carried_over_days)) - usedAnnualDays;
      return sendJson(res, 200, { balance, used_annual_days: usedAnnualDays, remaining_days: remainingDays });
    }

    const leaveBalanceSetMatch = pathname.match(/^\/api\/hr\/leave\/balance\/([\w-]+)$/);
    if (leaveBalanceSetMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      const year = Number(body.year) || new Date().getFullYear();
      const patch = {};
      if (body.entitled_days != null) patch.entitled_days = Number(body.entitled_days);
      if (body.carried_over_days != null) patch.carried_over_days = Number(body.carried_over_days);
      if ('notes' in body) patch.notes = body.notes || null;
      const rec = db.setLeaveBalance(leaveBalanceSetMatch[1], year, patch);
      return sendJson(res, 200, { balance: rec });
    }

    if (pathname === '/api/hr/leave/requests' && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      let filter = { status: query.status || undefined };
      if (user.role === 'admin') {
        filter.profileId = query.profile_id || undefined;
      } else if (user.role === 'manager') {
        if (query.scope === 'team') filter.managerId = user.id;
        else filter.profileId = user.id;
      } else {
        filter.profileId = user.id;
      }
      return sendJson(res, 200, { requests: db.listLeaveRequests(filter) });
    }

    if (pathname === '/api/hr/leave/requests' && req.method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const profileId = (body.profile_id && ['admin', 'manager'].includes(user.role)) ? body.profile_id : user.id;
      if (!body.start_date || !body.end_date || body.days == null) {
        return sendJson(res, 400, { error: 'Липсват задължителни полета (начална/крайна дата, брой дни)' });
      }
      const rec = db.createLeaveRequest({
        profile_id: profileId,
        type: body.type || 'annual',
        start_date: body.start_date,
        end_date: body.end_date,
        days: Number(body.days),
        note: body.note || null,
      });
      return sendJson(res, 201, { request: rec });
    }

    const leaveDecideMatch = pathname.match(/^\/api\/hr\/leave\/requests\/([\w-]+)\/decide$/);
    if (leaveDecideMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const target = db.getLeaveRequest(leaveDecideMatch[1]);
      if (!target) return sendJson(res, 404, { error: 'Заявката не е намерена' });
      if (user.role === 'manager') {
        const requester = db.findUserById(target.profile_id);
        if (!requester || requester.manager_id !== user.id) {
          return sendJson(res, 403, { error: 'Можете да одобрявате само заявки на служители от вашия екип' });
        }
      }
      const body = await readJsonBody(req);
      try {
        const rec = db.decideLeaveRequest(leaveDecideMatch[1], { approve: !!body.approve, decided_by: user.id, decision_note: body.decision_note });
        return sendJson(res, 200, { request: rec });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    const leaveCancelMatch = pathname.match(/^\/api\/hr\/leave\/requests\/([\w-]+)\/cancel$/);
    if (leaveCancelMatch && req.method === 'POST') {
      const user = requireAuth(req, res);
      if (!user) return;
      try {
        const rec = db.cancelLeaveRequest(leaveCancelMatch[1], user.id);
        return sendJson(res, 200, { request: rec });
      } catch (err) {
        if (user.role === 'admin') {
          try {
            const forced = db.decideLeaveRequest(leaveCancelMatch[1], { approve: false, decided_by: user.id, decision_note: 'Отменено от админ' });
            return sendJson(res, 200, { request: forced });
          } catch (err2) { return sendJson(res, 400, { error: err2.message }); }
        }
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- ПАРТНЬОРСКИ КОМИСИОННИ (реферални/посреднически партньори) ------
    // Партньорите/посредниците се моделират като профили с роля 'manager'
    // (могат едновременно да работят и като шофьори), с шофьори, зачислени
    // към тях (виж profiles.manager_id). Компенсацията е % или фиксирана
    // сума на период. Статистиката за "пари, донесени на компанията" засега
    // се изчислява от заработката (gross_earnings) в модул Заплати на екипа
    // им — приблизителна демонстрационна база, докато не бъде готов реалният
    // импорт на таблиците с поръчки/приходи (виж db.getPartnerStats).
    if (pathname === '/api/hr/partners' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const partners = db.listUsers()
        .filter(u => u.role === 'manager')
        .map(u => ({
          id: u.id, full_name: u.full_name, email: u.email, status: u.status,
          commission: db.getPartnerCommissionProfile(u.id),
          team_size: db.listTeamProfiles(u.id).length,
        }));
      return sendJson(res, 200, { partners });
    }

    const partnerMatch = pathname.match(/^\/api\/hr\/partners\/([\w-]+)$/);
    if (partnerMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = partnerMatch[1];
      if (targetId !== user.id && user.role !== 'admin') {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const profile = db.findUserById(targetId);
      if (!profile || profile.role !== 'manager') return sendJson(res, 404, { error: 'Партньорът не е намерен' });
      const { password: _pw, ...safeProfile } = profile;
      return sendJson(res, 200, {
        profile: safeProfile,
        commission: db.getPartnerCommissionProfile(targetId),
        team: db.listTeamProfiles(targetId),
      });
    }
    if (partnerMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const targetId = partnerMatch[1];
      const profile = db.findUserById(targetId);
      if (!profile || profile.role !== 'manager') return sendJson(res, 404, { error: 'Партньорът не е намерен' });
      const body = await readJsonBody(req);
      const allowed = ['comp_type', 'percentage', 'fixed_amount', 'fixed_period', 'comp_base', 'per_driver_amount', 'qualifying_threshold', 'active', 'notes'];
      const patch = {};
      allowed.forEach(k => { if (k in body) patch[k] = body[k]; });
      const rec = db.setPartnerCommissionProfile(targetId, patch);
      return sendJson(res, 200, { commission: rec });
    }

    const partnerStatsMatch = pathname.match(/^\/api\/hr\/partners\/([\w-]+)\/stats$/);
    if (partnerStatsMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = partnerStatsMatch[1];
      if (targetId !== user.id && user.role !== 'admin') {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const stats = db.getPartnerStats(targetId, { from: query.from, to: query.to });
      return sendJson(res, 200, stats);
    }

    // ---- САМОКАНДИДАТСТВАНЕ (публична форма, без вход) --------------------
    // Кандидатът качва снимки на лична карта/книжка → AI ги разчита и предварително
    // попълва формата (същият механизъм като разчитането на талон в автопарка).
    if (pathname === '/api/apply/id-card-scan' && req.method === 'POST') {
      if (rateLimited(`apply-scan:${clientIp(req)}`, { max: 20, windowMs: 10 * 60 * 1000 })) {
        return sendJson(res, 429, { error: 'Твърде много опити. Опитайте отново по-късно.' });
      }
      const body = await readJsonBody(req);
      const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(body.photo || '');
      if (!match) return sendJson(res, 400, { error: 'Невалиден формат на снимката' });
      try {
        const extracted = await scanIdCard(match[2], match[1]);
        return sendJson(res, 200, { extracted });
      } catch (err) {
        if (err.message === 'NO_API_KEY') {
          return sendJson(res, 200, { extracted: null, warning: 'AI разчитането не е активно — въведете данните ръчно.' });
        }
        return sendJson(res, 200, { extracted: null, warning: err.message });
      }
    }
    if (pathname === '/api/apply/license-scan' && req.method === 'POST') {
      if (rateLimited(`apply-scan:${clientIp(req)}`, { max: 20, windowMs: 10 * 60 * 1000 })) {
        return sendJson(res, 429, { error: 'Твърде много опити. Опитайте отново по-късно.' });
      }
      const body = await readJsonBody(req);
      const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(body.photo || '');
      if (!match) return sendJson(res, 400, { error: 'Невалиден формат на снимката' });
      try {
        const extracted = await scanDriverLicense(match[2], match[1]);
        return sendJson(res, 200, { extracted });
      } catch (err) {
        if (err.message === 'NO_API_KEY') {
          return sendJson(res, 200, { extracted: null, warning: 'AI разчитането не е активно — въведете данните ръчно.' });
        }
        return sendJson(res, 200, { extracted: null, warning: err.message });
      }
    }

    if (pathname === '/api/apply' && req.method === 'POST') {
      if (rateLimited(`apply:${clientIp(req)}`, { max: 8, windowMs: 30 * 60 * 1000 })) {
        return sendJson(res, 429, { error: 'Твърде много кандидатури от този адрес. Опитайте по-късно.' });
      }
      const body = await readJsonBody(req);
      if (!body.full_name || !body.phone) {
        return sendJson(res, 400, { error: 'Липсват задължителни полета (име, телефон)' });
      }
      let photos;
      try {
        photos = saveApplyPhotos(body);
      } catch (err) {
        return sendJson(res, 400, { error: 'Невалиден формат на качен файл: ' + err.message });
      }
      // публична, неавтентикирана форма — escape-ваме свободния текст преди
      // запис, за да не се отвори stored-XSS през по-нататъшните админ екрани
      const rec = db.createJobApplication({
        full_name: escapeHtml(String(body.full_name).slice(0, 200)),
        egn: body.egn ? escapeHtml(String(body.egn).slice(0, 20)) : null,
        phone: escapeHtml(String(body.phone).slice(0, 30)),
        email: body.email ? escapeHtml(String(body.email).slice(0, 200)) : null,
        address: body.address ? escapeHtml(String(body.address).slice(0, 300)) : null,
        id_card_number: body.id_card_number ? escapeHtml(String(body.id_card_number).slice(0, 30)) : null,
        id_card_expiry: body.id_card_expiry || null,
        id_card_photo_front_url: photos.id_card_photo_front_url,
        id_card_photo_back_url: photos.id_card_photo_back_url,
        selfie_photo_url: photos.selfie_photo_url,
        driver_license_number: body.driver_license_number ? escapeHtml(String(body.driver_license_number).slice(0, 30)) : null,
        driver_license_expiry: body.driver_license_expiry || null,
        driver_license_photo_front_url: photos.driver_license_photo_front_url,
        driver_license_photo_back_url: photos.driver_license_photo_back_url,
        desired_contract_type: body.desired_contract_type === 'civil' ? 'civil' : 'labor',
        desired_hours_per_day: body.desired_hours_per_day ? Number(body.desired_hours_per_day) : null,
        notes: body.notes ? escapeHtml(String(body.notes).slice(0, 1000)) : null,
        had_glovo_bolt_account: body.had_glovo_bolt_account === 'yes' ? 'yes' : (body.had_glovo_bolt_account === 'no' ? 'no' : null),
        glovo_bolt_platform: body.glovo_bolt_platform ? escapeHtml(String(body.glovo_bolt_platform).slice(0, 100)) : null,
        city: VALID_CITIES.has(body.city) ? body.city : null,
        work_vehicle_type: VALID_WORK_VEHICLES.has(body.work_vehicle_type) ? body.work_vehicle_type : null,
        nationality: VALID_NATIONALITIES.has(body.nationality) ? body.nationality : null,
        nationality_other: body.nationality_other ? escapeHtml(String(body.nationality_other).slice(0, 100)) : null,
        protection_status_photo_url: photos.protection_status_photo_url,
        residence_permit_photo_url: photos.residence_permit_photo_url,
        nap_certificate_photo_url: photos.nap_certificate_photo_url,
      });
      return sendJson(res, 201, { application: { id: rec.id, status: rec.status } });
    }

    // ---- ЛИНК ЗА ДОВЪРШВАНЕ НА КАНДИДАТУРАТА (публично, по token) ---------
    // Кандидатът, подал КРАТКАТА форма (маркетинг сайт), получава от админа
    // линк към /apply-details.html?token=... — тук той/тя допълва ЛК/книжка/
    // ЕГН/адрес/избор на договор върху СЪЩИЯ вече съществуващ запис.
    const applyDetailsMatch = pathname.match(/^\/api\/apply\/details\/([a-f0-9]+)$/);
    if (applyDetailsMatch && req.method === 'GET') {
      const app = db.getJobApplicationByToken(applyDetailsMatch[1]);
      if (!app) return sendJson(res, 404, { error: 'Невалиден, изтекъл или вече обработен линк.' });
      return sendJson(res, 200, {
        application: {
          full_name: app.full_name, phone: app.phone, email: app.email,
          egn: app.egn, address: app.address,
          id_card_number: app.id_card_number, id_card_expiry: app.id_card_expiry,
          driver_license_number: app.driver_license_number, driver_license_expiry: app.driver_license_expiry,
          desired_contract_type: app.desired_contract_type, desired_hours_per_day: app.desired_hours_per_day,
          notes: app.notes, status: app.status,
          had_glovo_bolt_account: app.had_glovo_bolt_account, glovo_bolt_platform: app.glovo_bolt_platform,
          city: app.city, work_vehicle_type: app.work_vehicle_type,
          nationality: app.nationality, nationality_other: app.nationality_other,
        },
      });
    }
    if (applyDetailsMatch && req.method === 'POST') {
      if (rateLimited(`apply-details:${clientIp(req)}`, { max: 20, windowMs: 30 * 60 * 1000 })) {
        return sendJson(res, 429, { error: 'Твърде много опити от този адрес. Опитайте по-късно.' });
      }
      const body = await readJsonBody(req);
      let photos;
      try {
        photos = saveApplyPhotos(body);
      } catch (err) {
        return sendJson(res, 400, { error: 'Невалиден формат на качен файл: ' + err.message });
      }
      const patch = {
        egn: body.egn ? escapeHtml(String(body.egn).slice(0, 20)) : null,
        address: body.address ? escapeHtml(String(body.address).slice(0, 300)) : null,
        id_card_number: body.id_card_number ? escapeHtml(String(body.id_card_number).slice(0, 30)) : null,
        id_card_expiry: body.id_card_expiry || null,
        driver_license_number: body.driver_license_number ? escapeHtml(String(body.driver_license_number).slice(0, 30)) : null,
        driver_license_expiry: body.driver_license_expiry || null,
        desired_contract_type: body.desired_contract_type === 'civil' ? 'civil' : 'labor',
        desired_hours_per_day: body.desired_hours_per_day ? Number(body.desired_hours_per_day) : null,
        notes: body.notes ? escapeHtml(String(body.notes).slice(0, 1000)) : null,
        had_glovo_bolt_account: body.had_glovo_bolt_account === 'yes' ? 'yes' : (body.had_glovo_bolt_account === 'no' ? 'no' : null),
        glovo_bolt_platform: body.glovo_bolt_platform ? escapeHtml(String(body.glovo_bolt_platform).slice(0, 100)) : null,
        city: VALID_CITIES.has(body.city) ? body.city : null,
        work_vehicle_type: VALID_WORK_VEHICLES.has(body.work_vehicle_type) ? body.work_vehicle_type : null,
        nationality: VALID_NATIONALITIES.has(body.nationality) ? body.nationality : null,
        nationality_other: body.nationality_other ? escapeHtml(String(body.nationality_other).slice(0, 100)) : null,
        ...photos,
      };
      try {
        const app = db.completeApplicationDetails(applyDetailsMatch[1], patch);
        return sendJson(res, 200, { application: { id: app.id, status: app.status } });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- ЛИНК ЗА ДОПЪЛВАНЕ НА ДОСИЕ (СЪЩЕСТВУВАЩ СЛУЖИТЕЛ, публично, по token) ---
    // Служителят отваря /personnel-details.html?token=... (генериран от
    // POST /api/hr/personnel/:id/send-link) и допълва/обновява собствените
    // си ЛК/книжка/ЕГН/адрес/телефон — без вход в системата.
    const personnelDetailsMatch = pathname.match(/^\/api\/personnel-details\/([a-f0-9]+)$/);
    if (personnelDetailsMatch && req.method === 'GET') {
      const profile = db.getUserByPersonnelToken(personnelDetailsMatch[1]);
      if (!profile) return sendJson(res, 404, { error: 'Невалиден линк.' });
      return sendJson(res, 200, {
        profile: {
          full_name: profile.full_name, phone: profile.phone,
          egn: profile.egn, address: profile.address,
          id_card_number: profile.id_card_number, id_card_expiry: profile.id_card_expiry,
          id_card_photo_url: profile.id_card_photo_url, id_card_photo_back_url: profile.id_card_photo_back_url,
          driver_license_number: profile.driver_license_number, driver_license_expiry: profile.driver_license_expiry,
          driver_license_photo_url: profile.driver_license_photo_url, driver_license_photo_back_url: profile.driver_license_photo_back_url,
          selfie_photo_url: profile.selfie_photo_url,
        },
      });
    }
    if (personnelDetailsMatch && req.method === 'POST') {
      if (rateLimited(`personnel-details:${clientIp(req)}`, { max: 20, windowMs: 30 * 60 * 1000 })) {
        return sendJson(res, 429, { error: 'Твърде много опити от този адрес. Опитайте по-късно.' });
      }
      const body = await readJsonBody(req);
      const patch = {
        phone: body.phone ? escapeHtml(String(body.phone).slice(0, 30)) : undefined,
        egn: body.egn ? escapeHtml(String(body.egn).slice(0, 20)) : undefined,
        address: body.address ? escapeHtml(String(body.address).slice(0, 300)) : undefined,
        id_card_number: body.id_card_number ? escapeHtml(String(body.id_card_number).slice(0, 30)) : undefined,
        id_card_expiry: body.id_card_expiry || undefined,
        driver_license_number: body.driver_license_number ? escapeHtml(String(body.driver_license_number).slice(0, 30)) : undefined,
        driver_license_expiry: body.driver_license_expiry || undefined,
      };
      Object.keys(patch).forEach(k => { if (patch[k] === undefined) delete patch[k]; });
      try {
        const profile = db.completePersonnelDetails(personnelDetailsMatch[1], patch);
        return sendJson(res, 200, { ok: true, full_name: profile.full_name });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const personnelDetailsPhotoMatch = pathname.match(/^\/api\/personnel-details\/([a-f0-9]+)\/(id-card-photo|license-photo|selfie-photo)$/);
    if (personnelDetailsPhotoMatch && req.method === 'POST') {
      if (rateLimited(`personnel-details-photo:${clientIp(req)}`, { max: 30, windowMs: 30 * 60 * 1000 })) {
        return sendJson(res, 429, { error: 'Твърде много опити от този адрес. Опитайте по-късно.' });
      }
      const token = personnelDetailsPhotoMatch[1];
      const kind = personnelDetailsPhotoMatch[2];
      const body = await readJsonBody(req);
      let url;
      try {
        ({ url } = saveBase64Image(body.photo, `personnel-${kind}`));
      } catch (err) {
        return sendJson(res, 400, { error: 'Невалиден формат на качен файл: ' + err.message });
      }
      const fieldMap = {
        'id-card-photo': body.side === 'back' ? 'id_card_photo_back_url' : 'id_card_photo_url',
        'license-photo': body.side === 'back' ? 'driver_license_photo_back_url' : 'driver_license_photo_url',
        'selfie-photo': 'selfie_photo_url',
      };
      try {
        const profile = db.completePersonnelDetails(token, { [fieldMap[kind]]: url });
        return sendJson(res, 200, { ok: true, url, full_name: profile.full_name });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- КАНДИДАТУРИ (админ преглед и одобрение) --------------------------
    // мениджър вижда само кандидатурите, назначени му от админ (виж
    // canAccessApplication/db.assignApplicationManager) — назначението е
    // начинът, по който админът решава кой мениджър какво вижда и оправлява.
    if (pathname === '/api/hr/applications' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      let applications = db.listJobApplications({ status: query.status });
      if (user.role === 'manager') applications = applications.filter(a => a.manager_id === user.id);
      return sendJson(res, 200, { applications });
    }
    const applicationMatch = pathname.match(/^\/api\/hr\/applications\/([\w-]+)$/);
    if (applicationMatch && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const app = db.getJobApplication(applicationMatch[1]);
      if (!app) return sendJson(res, 404, { error: 'Не е намерена' });
      if (!canAccessApplication(user, app)) return sendJson(res, 403, { error: 'Нямате права за тази кандидатура' });
      return sendJson(res, 200, { application: app });
    }
    // назначава/премахва отговорния мениджър за кандидатурата — само админ
    // (виж canAccessApplication по-горе); manager_id: null/отсъстващо = без
    // назначение (видима само за админ)
    if (applicationMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const app = db.getJobApplication(applicationMatch[1]);
      if (!app) return sendJson(res, 404, { error: 'Не е намерена' });
      const body = await readJsonBody(req);
      if (!('manager_id' in body)) return sendJson(res, 400, { error: 'Липсва manager_id' });
      if (body.manager_id) {
        const manager = db.findUserById(body.manager_id);
        if (!manager || !['admin', 'manager'].includes(manager.role)) {
          return sendJson(res, 400, { error: 'Невалиден мениджър' });
        }
      }
      const updated = db.assignApplicationManager(applicationMatch[1], body.manager_id || null);
      return sendJson(res, 200, { application: updated });
    }
    const applicationApproveMatch = pathname.match(/^\/api\/hr\/applications\/([\w-]+)\/approve$/);
    if (applicationApproveMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.email) return sendJson(res, 400, { error: 'Нужен е имейл за новия профил' });
      // генерираме паролата тук (не в lib/db.js), за да можем да я върнем еднократно
      // в отговора — db.approveJobApplication връща профила без парола, както
      // всички останали функции с потребители, за да не изтича никъде другаде
      const tempPassword = body.temp_password || crypto.randomBytes(5).toString('hex');
      try {
        const result = db.approveJobApplication(applicationApproveMatch[1], {
          reviewed_by: user.id, email: body.email, temp_password: tempPassword, manager_id: body.manager_id || null,
        });
        return sendJson(res, 200, { ...result, temp_password: tempPassword });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const applicationRejectMatch = pathname.match(/^\/api\/hr\/applications\/([\w-]+)\/reject$/);
    if (applicationRejectMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const existing = db.getJobApplication(applicationRejectMatch[1]);
      if (!existing) return sendJson(res, 404, { error: 'Не е намерена' });
      if (!canAccessApplication(user, existing)) return sendJson(res, 403, { error: 'Нямате права за тази кандидатура' });
      const body = await readJsonBody(req);
      const app = db.rejectJobApplication(applicationRejectMatch[1], { reviewed_by: user.id, decision_note: body.decision_note });
      return sendJson(res, 200, { application: app });
    }
    // с 1 клик: генерира уникален линк за довършване на кандидатурата (ЛК/
    // книжка/ЕГН/адрес/избор на договор) И го изпраща директно на имейла на
    // кандидата през вградената фирмена поща (виж lib/mail.js — office@dombi.bg
    // през Zoho SMTP). Ако кандидатът няма посочен имейл, или пощата не е
    // конфигурирана (липсват MAIL_USER/MAIL_PASSWORD в Render), линкът пак се
    // генерира и връща в отговора, за да може админът да го копира/изпрати
    // ръчно (Viber/SMS) — изпращането никога не блокира генерирането на линка.
    const applicationSendLinkMatch = pathname.match(/^\/api\/hr\/applications\/([\w-]+)\/send-link$/);
    if (applicationSendLinkMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const existingApp = db.getJobApplication(applicationSendLinkMatch[1]);
      if (!existingApp) return sendJson(res, 404, { error: 'Не е намерена' });
      if (!canAccessApplication(user, existingApp)) return sendJson(res, 403, { error: 'Нямате права за тази кандидатура' });
      const body = await readJsonBody(req);
      try {
        // назначаването на мениджър от този диалог е позволено само на админ —
        // мениджър не може да преназначава кандидатури през send-link
        if (user.role === 'admin' && 'manager_id' in body) {
          db.assignApplicationManager(applicationSendLinkMatch[1], body.manager_id || null);
        }
        const app = db.generateApplicationLink(applicationSendLinkMatch[1]);
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers.host;
        const link = `${proto}://${host}/apply-details.html?token=${app.application_token}`;
        let emailed = false;
        let emailError = null;
        if (app.email) {
          try {
            await mail.sendMail({
              to: app.email,
              subject: 'Довършете кандидатурата си — Dombi Riders',
              text: `Здравейте, ${app.full_name || ''}!\n\n` +
                `Почти сте готови — остана само да качите снимки на личната си карта и книжка и да изберете вид договор.\n\n` +
                `Довършете кандидатурата си тук: ${link}\n\n` +
                `Линкът е личен — не го споделяйте с други хора.\n\n` +
                `Екипът на Dombi Riders`,
            });
            emailed = true;
          } catch (err) {
            emailError = err.message;
          }
        }
        return sendJson(res, 200, { application: app, link, emailed, email_error: emailError });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- ШАБЛОНИ НА БЛАНКИ (протокол / договор / трудов-граждански договор) ---
    // employment_contract_labor и employment_contract_civil се пазят отделно,
    // защото съдържанието им е различно по същество (виж lib/doc-render.js).
    const templateMatch = pathname.match(/^\/api\/templates\/(protocol|contract|employment_contract_labor|employment_contract_civil)$/);
    if (templateMatch && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const template = db.getDocumentTemplate(templateMatch[1]);
      const sofficeAvailable = await docxToPdf.checkSoffice();
      return sendJson(res, 200, {
        template,
        tier2_available: docTemplates.isAvailable(),
        soffice_available: sofficeAvailable,
      });
    }
    if (templateMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      const patch = { source: 'builtin', content: body.content || '', file_url: null, file_name: null, updated_by: user.id };
      const template = db.setDocumentTemplate(templateMatch[1], patch);
      return sendJson(res, 200, { template });
    }
    const templateUploadMatch = pathname.match(/^\/api\/templates\/(protocol|contract|employment_contract_labor|employment_contract_civil)\/upload$/);
    if (templateUploadMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.file_base64) return sendJson(res, 400, { error: 'Липсва файл' });
      const ext = (body.file_name || '').toLowerCase().endsWith('.docx') ? 'docx' : 'docx';
      const saved = saveBase64File(body.file_base64, `template-${templateUploadMatch[1]}`, ext);
      const template = db.setDocumentTemplate(templateUploadMatch[1], {
        source: 'docx',
        file_url: saved.url,
        file_name: body.file_name || saved.filename,
        updated_by: user.id,
      });
      return sendJson(res, 200, {
        template,
        tier2_available: docTemplates.isAvailable(),
        warning: docTemplates.isAvailable()
          ? null
          : 'Файлът е качен и запазен, но попълването му (docxtemplater/pizzip) не е активно на този сървър — изтеглянията ще използват вградената бланка, докато модулите не бъдат инсталирани.',
      });
    }

    // ---- ЕЛЕКТРОННО РАЗПИСВАНЕ (протоколи / договори за наем) -------------
    // documentType: 'protocol' | 'contract' (НЕ трудови договори — виж бележката в lib/esign.js)
    const esignListMatch = pathname.match(/^\/api\/esign\/(protocol|contract|employment_contract)\/([\w-]+)$/);
    if (esignListMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const [, documentType, documentId] = esignListMatch;
      return sendJson(res, 200, { events: db.listEsignEvents(documentType, documentId) });
    }

    const esignInPersonMatch = pathname.match(/^\/api\/esign\/(protocol|contract|employment_contract)\/([\w-]+)\/in-person$/);
    if (esignInPersonMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const [, documentType, documentId] = esignInPersonMatch;
      const target = esignTarget(documentType);
      const rec = target.get(documentId);
      if (!rec) return sendJson(res, 404, { error: 'Документът не е намерен' });
      const body = await readJsonBody(req);
      if (!body.signer_name) return sendJson(res, 400, { error: 'Липсва име на подписващия' });

      let signatureImageUrl = null;
      if (body.signature_image) {
        try { signatureImageUrl = saveBase64Image(body.signature_image, 'signature').url; }
        catch (e) { /* позволяваме подпис само с изписано име, без картинка */ }
      }

      const { buffer: docBuffer } = await docRender.renderDocument(documentType, rec, 'pdf');
      const result = esign.recordInPersonSignature({
        documentBuffer: docBuffer,
        signerName: body.signer_name,
        signerRole: body.signer_role,
        signatureImageUrl,
        ipAddress: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
        userAgent: req.headers['user-agent'] || null,
      });
      const event = db.addEsignEvent({ document_type: documentType, document_id: documentId, ...result });
      const updated = target.update(documentId, {
        signature_status: 'signed_in_person',
        signature_method: 'in_person',
        signed_at: result.completed_at,
        signed_by_name: result.signer_name,
      });
      return sendJson(res, 200, { event, document: updated });
    }

    const esignRemoteSendMatch = pathname.match(/^\/api\/esign\/(protocol|contract|employment_contract)\/([\w-]+)\/remote\/send$/);
    if (esignRemoteSendMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const [, documentType, documentId] = esignRemoteSendMatch;
      const target = esignTarget(documentType);
      const rec = target.get(documentId);
      if (!rec) return sendJson(res, 404, { error: 'Документът не е намерен' });
      const body = await readJsonBody(req);
      if (!body.signer_email) return sendJson(res, 400, { error: 'Липсва имейл на подписващия' });

      const { buffer: pdfBuffer, filename } = await docRender.renderDocument(documentType, rec, 'pdf');
      try {
        const sendResult = await esign.sendForRemoteSigning({
          pdfBuffer, filename, signerEmail: body.signer_email, signerName: body.signer_name,
          subject: body.subject, message: body.message,
        });
        const event = db.addEsignEvent({
          document_type: documentType, document_id: documentId, method: 'remote', provider: 'signnow',
          status: 'sent_remote', signer_name: body.signer_name || null, signer_role: body.signer_role || null,
          external_envelope_id: sendResult.envelope_id,
        });
        const updated = target.update(documentId, {
          signature_status: 'sent_remote', signature_method: 'remote',
          esign_provider: 'signnow', esign_envelope_id: sendResult.envelope_id,
        });
        return sendJson(res, 200, { event, document: updated });
      } catch (err) {
        if (err.code === 'NO_API_KEY') {
          return sendJson(res, 200, {
            event: null,
            warning: 'Отдалеченото разписване през SignNow не е активно — задайте SIGNNOW_ACCESS_TOKEN в Render. Използвайте присъствен подпис междувременно.',
          });
        }
        return sendJson(res, 200, { event: null, warning: err.message });
      }
    }

    const esignRemoteRefreshMatch = pathname.match(/^\/api\/esign\/(protocol|contract|employment_contract)\/([\w-]+)\/remote\/refresh$/);
    if (esignRemoteRefreshMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      const [, documentType, documentId] = esignRemoteRefreshMatch;
      const target = esignTarget(documentType);
      const rec = target.get(documentId);
      if (!rec || !rec.esign_envelope_id) return sendJson(res, 400, { error: 'Няма изпратен документ за проверка' });
      try {
        const statusResult = await esign.checkRemoteStatus(rec.esign_envelope_id);
        const events = db.listEsignEvents(documentType, documentId);
        const latest = events.find(e => e.external_envelope_id === rec.esign_envelope_id);
        if (latest) db.updateEsignEvent(latest.id, { status: statusResult.status, completed_at: statusResult.status === 'signed_remote' ? db.nowIso() : latest.completed_at });
        const updated = target.update(documentId, { signature_status: statusResult.status });
        return sendJson(res, 200, { document: updated, status: statusResult.status });
      } catch (err) {
        if (err.code === 'NO_API_KEY') {
          return sendJson(res, 200, { warning: 'Отдалеченото разписване през SignNow не е активно — задайте SIGNNOW_ACCESS_TOKEN в Render.' });
        }
        return sendJson(res, 200, { warning: err.message });
      }
    }

    // ---- STATS ----------------------------------------------------------
    if (pathname === '/api/stats' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, db.getFleetStats());
    }

    // ---- DASHBOARD (начало) ---------------------------------------------
    if (pathname === '/api/dashboard' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin', 'manager']);
      if (!user) return;
      return sendJson(res, 200, db.getDashboardData());
    }

    // ---- ACTIVITY LOG (дневник на активността) ---------------------------
    if (pathname === '/api/activity' && req.method === 'GET') {
      const user = requireRole(req, res, ['admin']);
      if (!user) return;
      return sendJson(res, 200, { items: db.getActivityFeed(80) });
    }

    sendJson(res, 404, { error: 'Няма такъв маршрут' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message || 'Вътрешна грешка' });
  }
}

// ---------------------------------------------------------------------------
// HTTP сървър
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams.entries());

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, query);
    return;
  }
  serveStatic(req, res, pathname);
});

// Стартова последователност (АСИНХРОННА, затова е обвита в IIFE):
//  1) db.initDb() — ако DATABASE_URL е зададен, свързва се с Postgres/Supabase
//     и зарежда/засява kv_store (виж lib/db.js); иначе е no-op и оставаме на
//     локалния файл data/db.json, точно както досега.
//  2) еднократна самолечебна миграция на нехеширани пароли (демо семена).
//  3) server.listen — ЕДВА СЛЕД като горните две приключат, за да не поемем
//     заявки, докато базата все още не е заредена.
(async () => {
  try {
    await db.initDb();
  } catch (e) {
    console.error('Грешка при инициализация на базата данни:', e.message);
  }

  try {
    const migrated = db.migratePlaintextPasswords();
    if (migrated) console.log('Мигрирани нехеширани пароли → scrypt хеш.');
  } catch (e) {
    console.error('Грешка при миграция на пароли:', e.message);
  }

  try {
    backup.scheduleAutoBackups(() => db.readDb());
    console.log(`Автоматични бекъпи: включени (папка ${backup.BACKUPS_DIR}).`);
  } catch (e) {
    console.error('Грешка при стартиране на автоматичните бекъпи:', e.message);
  }

  server.listen(PORT, () => {
    console.log(`Dombi Riders backend слуша на http://localhost:${PORT}`);
  });
})();
