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
const boltStatsImport = require('./lib/bolt-stats-import');
const bankImport = require('./lib/bank-import');
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

// заменя requireRole() навсякъде, където достъпът трябва да е конфигурируем
// от супер администратора (виж lib/permissions-catalog.js за каталога на
// модули/действия и public/permissions.html за самата настройка). super_admin
// винаги минава — виж db.hasPermission().
function requirePermission(req, res, moduleKey, actionKey) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!db.hasPermission(user, moduleKey, actionKey)) {
    sendJson(res, 403, { error: 'Нямате права за това действие' });
    return null;
  }
  return user;
}

// super_admin трябва винаги да има поне правата на admin/manager. Много от
// маршрутите по-долу проверяват достъп до ЧУЖД запис (не собствения профил)
// с твърд списък от роли, вместо през configurable requirePermission/
// hasPermission — ползвайте тези помощни функции там, за да не остава
// super_admin случайно извън тях (виж "Fix super_admin lockout" за фона).
function isAdminOrAbove(user) {
  return user.role === 'admin' || user.role === 'super_admin';
}
function isManagerOrAbove(user) {
  return user.role === 'admin' || user.role === 'manager' || user.role === 'super_admin';
}

// само за конфигурацията на самата система за права/роли — НЕ минава през
// матрицата (не може супер администраторският контрол да бъде изключен през
// собствената си настройка).
function requireSuperAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'super_admin') {
    sendJson(res, 403, { error: 'Само супер администратор може да прави това' });
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
  if (isAdminOrAbove(user)) return true;
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
const ALLOWED_TALON_MIME = new Set([...ALLOWED_IMAGE_MIME, 'application/pdf']);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12MB декодирано
const MAX_TALON_BYTES = 20 * 1024 * 1024; // 20MB декодирано (PDF сканове са по-обемисти от снимки)

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

// като saveBase64Image, но за талони — освен снимка приема и PDF файл
// (сканирано свидетелство за регистрация), който AI-то може да прочете директно.
function saveBase64Talon(dataUrl, prefix) {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Невалиден формат на файла');
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_TALON_MIME.has(mimeType)) throw new Error('Неподдържан тип файл — приемат се снимки (JPEG/PNG/WEBP) или PDF');
  const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1].replace('jpeg', 'jpg');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new Error('Празен файл');
  if (buffer.length > MAX_TALON_BYTES) throw new Error('Файлът е твърде голям (макс. 20MB)');
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
  if (body.daily_rate !== undefined) {
    out.daily_rate = body.daily_rate === '' || body.daily_rate === null ? null : Math.max(0, Number(body.daily_rate) || 0);
  }
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
  // booking търсачката и формата за резервация на новия рент-а-кар сайт
  // (отделен произход/домейн) — GET наличност + POST заявка, без сесия
  '/api/public/availability',
  '/api/public/reservations',
  // съдържанието на новия рент-а-кар сайт (отделен произход/домейн) — GET
  // без сесия, четено от rent-a-car-site/index.html
  '/api/rentacar-site-content',
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
      const user = requirePermission(req, res, 'site_editor', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, { content: db.updateSiteContent(body) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- СЪДЪРЖАНИЕ НА НОВИЯ РЕНТ-А-КАР САЙТ (rent-a-car-site) -------------
    // GET е публичен (без сесия, CORS) — четe го rent-a-car-site/index.html.
    // PUT е само за админ/мениджър — вика се от /rentacar-site-editor.html.
    if (pathname === '/api/rentacar-site-content' && req.method === 'GET') {
      return sendJson(res, 200, { content: db.getRentacarSiteContent() });
    }
    if (pathname === '/api/rentacar-site-content' && req.method === 'PUT') {
      const user = requirePermission(req, res, 'rentacar_site', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, { content: db.updateRentacarSiteContent(body) });
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
      const user = requirePermission(req, res, 'site_editor', 'view');
      if (!user) return;
      return sendJson(res, 200, { requests: db.listRentRequests() });
    }
    // трайно изтрива заявка за наем — прилага срока на съхранение (до 6
    // месеца за заявки без сключен договор) и правото на изтриване от
    // Политиката за поверителност (viж /privacy.html, т. 8.2 и т. 10).
    const rentRequestMatch = pathname.match(/^\/api\/rent-requests\/([\w-]+)$/);
    if (rentRequestMatch && req.method === 'DELETE') {
      const user = requirePermission(req, res, 'site_editor', 'manage');
      if (!user) return;
      try {
        db.deleteRentRequest(rentRequestMatch[1]);
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
      return sendJson(res, 200, { deleted: true });
    }

    // ---- РЕЗЕРВАЦИИ (booking календар на новия сайт "рент-а-кар") ---------
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    function validateBookingDates(pickupDate, returnDate) {
      if (!DATE_RE.test(pickupDate || '') || !DATE_RE.test(returnDate || '')) {
        return 'Невалиден формат на дата (очаква се ГГГГ-ММ-ДД).';
      }
      const today = db.nowIso().slice(0, 10);
      if (pickupDate < today) return 'Датата на вземане не може да е в миналото.';
      if (returnDate < pickupDate) return 'Датата на връщане трябва да е след датата на вземане.';
      return null;
    }

    // публично — GET наличност на витринните карти за конкретен период (за
    // booking търсачката на новия сайт), без сесия, CORS
    if (pathname === '/api/public/availability' && req.method === 'GET') {
      const err = validateBookingDates(query.pickup_date, query.return_date);
      if (err) return sendJson(res, 400, { error: err });
      return sendJson(res, 200, { cars: db.getShowcaseAvailability(query.pickup_date, query.return_date) });
    }

    // публично — POST нова резервация (заявка, изисква ръчно потвърждение от
    // администратор — виж PUT /api/reservations/:id по-долу)
    if (pathname === '/api/public/reservations' && req.method === 'POST') {
      if (rateLimited(`reservation:${clientIp(req)}`, { max: 8, windowMs: 30 * 60 * 1000 })) {
        return sendJson(res, 429, { error: 'Твърде много заявки от този адрес. Опитайте по-късно.' });
      }
      const body = await readJsonBody(req);
      const dateErr = validateBookingDates(body.pickup_date, body.return_date);
      if (dateErr) return sendJson(res, 400, { error: dateErr });
      if (!body.showcase_item_id || !body.customer_name || !body.customer_phone) {
        return sendJson(res, 400, { error: 'Липсват задължителни полета (кола, име, телефон).' });
      }
      if (!db.isShowcaseItemAvailable(body.showcase_item_id, body.pickup_date, body.return_date)) {
        return sendJson(res, 409, { error: 'За съжаление избраната кола вече не е свободна за тези дати — опитайте друг период или друг модел.' });
      }
      const rec = db.createReservation({
        showcase_item_id: escapeHtml(String(body.showcase_item_id).slice(0, 80)),
        car_name: body.car_name ? escapeHtml(String(body.car_name).slice(0, 120)) : null,
        pickup_date: body.pickup_date,
        return_date: body.return_date,
        pickup_location: body.pickup_location ? escapeHtml(String(body.pickup_location).slice(0, 200)) : null,
        customer_name: escapeHtml(String(body.customer_name).slice(0, 200)),
        customer_phone: escapeHtml(String(body.customer_phone).slice(0, 30)),
        customer_email: body.customer_email ? escapeHtml(String(body.customer_email).slice(0, 200)) : null,
        notes: body.notes ? escapeHtml(String(body.notes).slice(0, 1000)) : null,
        source: 'website',
      });
      try {
        await mail.sendMail({
          to: 'office@dombi.bg',
          subject: 'Нова резервация — рент-а-кар сайт',
          text: `Нова заявка за резервация:\n\nКола: ${rec.car_name || rec.showcase_item_id}\nПериод: ${rec.pickup_date} — ${rec.return_date}\nМясто на вземане: ${rec.pickup_location || '-'}\n\nИме: ${rec.customer_name}\nТелефон: ${rec.customer_phone}\nИмейл: ${rec.customer_email || '-'}\nБележка: ${rec.notes || '-'}\n\nВсички резервации: https://dombi-riders-backend.onrender.com/reservations.html`,
        });
      } catch (err) {
        console.error('Грешка при изпращане на имейл известие за резервация:', err.message);
      }
      return sendJson(res, 201, { reservation: { id: rec.id } });
    }

    // администраторски панел — наличност (за ръчно вписване на телефонна резервация)
    if (pathname === '/api/admin/availability' && req.method === 'GET') {
      const user = requirePermission(req, res, 'reservations', 'view');
      if (!user) return;
      const err = validateBookingDates(query.pickup_date, query.return_date);
      if (err) return sendJson(res, 400, { error: err });
      return sendJson(res, 200, { cars: db.getShowcaseAvailability(query.pickup_date, query.return_date) });
    }

    if (pathname === '/api/reservations' && req.method === 'GET') {
      const user = requirePermission(req, res, 'reservations', 'view');
      if (!user) return;
      return sendJson(res, 200, { reservations: db.listReservations({ status: query.status, from: query.from, to: query.to }) });
    }
    if (pathname === '/api/reservations' && req.method === 'POST') {
      const user = requirePermission(req, res, 'reservations', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const dateErr = validateBookingDates(body.pickup_date, body.return_date);
      if (dateErr) return sendJson(res, 400, { error: dateErr });
      if (!body.customer_name || !body.customer_phone) {
        return sendJson(res, 400, { error: 'Липсват задължителни полета (име, телефон).' });
      }
      const rec = db.createReservation({
        showcase_item_id: body.showcase_item_id || null,
        car_name: body.car_name || null,
        pickup_date: body.pickup_date,
        return_date: body.return_date,
        pickup_location: body.pickup_location || null,
        customer_name: body.customer_name,
        customer_phone: body.customer_phone,
        customer_email: body.customer_email || null,
        notes: body.notes || null,
        status: body.status === 'confirmed' ? 'confirmed' : 'pending',
        assigned_vehicle_id: body.assigned_vehicle_id || null,
        source: 'phone',
        created_by: user.id,
      });
      return sendJson(res, 201, { reservation: rec });
    }
    const reservationMatch = pathname.match(/^\/api\/reservations\/([\w-]+)$/);
    if (reservationMatch && req.method === 'PUT') {
      const user = requirePermission(req, res, 'reservations', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const patch = {};
      const VALID_STATUSES = new Set(['pending', 'confirmed', 'declined', 'cancelled', 'completed']);
      if (body.status !== undefined) {
        if (!VALID_STATUSES.has(body.status)) return sendJson(res, 400, { error: 'Невалиден статус' });
        patch.status = body.status;
        patch.decided_by = user.id;
        patch.decided_at = db.nowIso();
      }
      if (body.assigned_vehicle_id !== undefined) patch.assigned_vehicle_id = body.assigned_vehicle_id || null;
      if (body.admin_notes !== undefined) patch.admin_notes = body.admin_notes;
      if (body.pickup_date !== undefined) patch.pickup_date = body.pickup_date;
      if (body.return_date !== undefined) patch.return_date = body.return_date;
      try {
        const rec = db.updateReservation(reservationMatch[1], patch);
        return sendJson(res, 200, { reservation: rec });
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
    }

    // ---- ВИТРИНА НА МАРКЕТИНГ САЙТА (админ панел) -------------------------
    if (pathname === '/api/admin/fleet-showcase' && req.method === 'GET') {
      const user = requirePermission(req, res, 'site_editor', 'view');
      if (!user) return;
      return sendJson(res, 200, { items: db.listFleetShowcase() });
    }
    if (pathname === '/api/admin/fleet-showcase' && req.method === 'POST') {
      const user = requirePermission(req, res, 'site_editor', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 201, { item: db.createFleetShowcaseItem(sanitizeFleetShowcaseInput(body)) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (pathname === '/api/admin/fleet-showcase/reorder' && req.method === 'POST') {
      const user = requirePermission(req, res, 'site_editor', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      if (!Array.isArray(body.ids)) return sendJson(res, 400, { error: 'Липсва ids (масив)' });
      return sendJson(res, 200, { items: db.reorderFleetShowcase(body.ids) });
    }
    const fleetShowcaseItemMatch = pathname.match(/^\/api\/admin\/fleet-showcase\/([\w-]+)$/);
    if (fleetShowcaseItemMatch && req.method === 'PUT') {
      const user = requirePermission(req, res, 'site_editor', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, { item: db.updateFleetShowcaseItem(fleetShowcaseItemMatch[1], sanitizeFleetShowcaseInput(body)) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (fleetShowcaseItemMatch && req.method === 'DELETE') {
      const user = requirePermission(req, res, 'site_editor', 'manage');
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
      const user = requirePermission(req, res, 'site_editor', 'manage');
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
      // nav_access: кои страници от менюто вижда точно ТОЗИ потребител според
      // конфигурируемата от супер администратора матрица (виж
      // lib/db.js:getNavAccessMap) — ползва се от mountShell() в app.js както
      // за да построи sidebar-а, така и за да заключи самата страница, ако
      // потребителят стигне до нея по директен линк без да я вижда в менюто.
      const nav_access = user ? db.getNavAccessMap(user) : {};
      return sendJson(res, 200, { user, nav_access });
    }

    // ---- ПРАВА И ДОСТЪПИ (само супер администратор) ---------------------
    if (pathname === '/api/permissions-matrix' && req.method === 'GET') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      return sendJson(res, 200, { matrix: db.getPermissionsMatrix(), catalog: db.getPermissionsCatalog() });
    }
    if (pathname === '/api/permissions-matrix' && req.method === 'PUT') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const matrix = db.savePermissionsMatrix(body);
      return sendJson(res, 200, { matrix });
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
      const user = requirePermission(req, res, 'nav_settings', 'manage');
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
      const user = requirePermission(req, res, 'nav_settings', 'manage');
      if (!user) return;
      db.resetNavConfig();
      return sendJson(res, 200, { config: null });
    }

    // ---- USERS (admin) -----------------------------------------------
    if (pathname === '/api/users' && req.method === 'GET') {
      const user = requirePermission(req, res, 'users', 'view');
      if (!user) return;
      return sendJson(res, 200, { users: db.listUsers() });
    }
    if (pathname === '/api/users' && req.method === 'POST') {
      const user = requirePermission(req, res, 'users', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      // само супер администратор може да създава друг супер администратор —
      // иначе обикновен админ би могъл сам да си "издаде" най-високо ниво
      if (body.role === 'super_admin' && user.role !== 'super_admin') {
        return sendJson(res, 403, { error: 'Само супер администратор може да задава роля "Супер администратор"' });
      }
      if (body.role && !db.ROLES.includes(body.role)) {
        return sendJson(res, 400, { error: 'Невалидна роля' });
      }
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
      const user = requirePermission(req, res, 'users', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const target = db.findUserById(userMatch[1]);
      if (!target) return sendJson(res, 404, { error: 'Потребителят не е намерен' });
      // защита срещу ескалация/саботаж на супер администраторското ниво:
      //  - само супер администратор може да ЗАДАВА ролята super_admin,
      //  - само супер администратор може да РЕДАКТИРА вече съществуващ
      //    супер администратор (роля, статус, права) — обикновен админ не
      //    може да го спре/понижи/размени правата му,
      //  - не може да се остане без нито един супер администратор в системата.
      if (body.role === 'super_admin' && user.role !== 'super_admin') {
        return sendJson(res, 403, { error: 'Само супер администратор може да задава роля "Супер администратор"' });
      }
      if (body.role && !db.ROLES.includes(body.role)) {
        return sendJson(res, 400, { error: 'Невалидна роля' });
      }
      if (target.role === 'super_admin' && user.role !== 'super_admin') {
        return sendJson(res, 403, { error: 'Само супер администратор може да редактира супер администратор' });
      }
      const removesLastSuperAdmin = target.role === 'super_admin'
        && ((body.role && body.role !== 'super_admin') || (body.status && body.status !== 'active'))
        && db.countSuperAdmins(db.readDb()) <= 1;
      if (removesLastSuperAdmin) {
        return sendJson(res, 400, { error: 'Не може да останете без нито един супер администратор в системата' });
      }
      try {
        const updated = db.updateUser(userMatch[1], body);
        return sendJson(res, 200, { user: updated });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    // ръчно нулиране на паролата на служител от админ (напр. забравена
    // парола) — по избор с конкретна нова парола, иначе автогенерирана по
    // шаблон "име123"; винаги маркира профила да поиска смяна при вход.
    const userResetPasswordMatch = pathname.match(/^\/api\/users\/([\w-]+)\/reset-password$/);
    if (userResetPasswordMatch && req.method === 'POST') {
      const user = requirePermission(req, res, 'users', 'manage');
      if (!user) return;
      const target = db.findUserById(userResetPasswordMatch[1]);
      if (!target) return sendJson(res, 404, { error: 'Потребителят не е намерен' });
      if (target.role === 'super_admin' && user.role !== 'super_admin') {
        return sendJson(res, 403, { error: 'Само супер администратор може да нулира паролата на супер администратор' });
      }
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
      const user = requirePermission(req, res, 'vehicles', 'manage');
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
      const user = requirePermission(req, res, 'vehicles', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const vehicle = db.updateVehicle(vehicleMatch[1], body);
      return sendJson(res, 200, { vehicle });
    }
    if (vehicleMatch && req.method === 'DELETE') {
      // само admin — трайно изтриване на кола (напр. чистене на демо данни)
      const user = requirePermission(req, res, 'vehicles', 'delete');
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
      const user = requirePermission(req, res, 'vehicles', 'manage');
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
      const user = requirePermission(req, res, 'vehicles', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const item = db.addEquipment(eqListMatch[1], body);
      return sendJson(res, 201, { equipment: item });
    }
    const eqItemMatch = pathname.match(/^\/api\/vehicles\/([\w-]+)\/equipment\/([\w-]+)$/);
    if (eqItemMatch && req.method === 'PUT') {
      const user = requirePermission(req, res, 'vehicles', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        const item = db.updateEquipment(eqItemMatch[2], {
          name: body.name, serial_number: body.serial_number || null, notes: body.notes || null,
        });
        return sendJson(res, 200, { equipment: item });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (eqItemMatch && req.method === 'DELETE') {
      const user = requirePermission(req, res, 'vehicles', 'manage');
      if (!user) return;
      try {
        db.deleteEquipment(eqItemMatch[2]);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // service records (сервизна книжка)
    const srListMatch = pathname.match(/^\/api\/vehicles\/([\w-]+)\/service-records$/);
    if (srListMatch && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { records: db.listServiceRecords(srListMatch[1]) });
    }
    if (srListMatch && req.method === 'POST') {
      const user = requirePermission(req, res, 'vehicles', 'manage');
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
      const user = requirePermission(req, res, 'vehicles', 'manage');
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
      const user = requirePermission(req, res, 'vehicles', 'view');
      if (!user) return;
      return sendJson(res, 200, { costs: db.listRecurringCosts(rcListMatch[1]) });
    }
    if (rcListMatch && req.method === 'POST') {
      const user = requirePermission(req, res, 'vehicles', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.addRecurringCost(rcListMatch[1], body);
      return sendJson(res, 201, { cost: rec });
    }

    // talon photo -> AI extraction, ПРЕДИ да съществува запис за колата
    // (използва се от формата "Нова кола", където vehicle_id още няма)
    if (pathname === '/api/talon-scan-preview' && req.method === 'POST') {
      const user = requirePermission(req, res, 'vehicles', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const { mimeType, base64 } = saveBase64Talon(body.photo, 'talon-preview');
      try {
        const extracted = await callClaudeVision(base64, mimeType);
        if (extracted && extracted.owner_name) extracted.owner_name = db.normalizeOwnerName(extracted.owner_name);
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
      const user = requirePermission(req, res, 'vehicles', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const { url, mimeType, base64 } = saveBase64Talon(body.photo, 'talon');
      db.updateVehicle(talonMatch[1], { talon_photo_url: url });
      try {
        const extracted = await callClaudeVision(base64, mimeType);
        if (extracted && extracted.owner_name) extracted.owner_name = db.normalizeOwnerName(extracted.owner_name);
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
      const user = requirePermission(req, res, 'vehicles', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const talonData = body.talon_data ? { ...body.talon_data } : body.talon_data;
      if (talonData && talonData.owner_name) talonData.owner_name = db.normalizeOwnerName(talonData.owner_name);
      // "Дата на следваща регистрация" (поле I от талона) е ЧИСТО информативно
      // поле, разчетено от AI — НЕ Го прилагаме върху основния запис на колата.
      // Основното (вградено) поле vehicle.registration_expiry вече се ползва
      // за съвсем друго нещо (реалната дата "рег. до", въвеждана ръчно/през
      // CSV импорт) и захранва таблото "Изтичащи документи" — ако тук го
      // презапишем с несигурна AI стойност, се получават абсурдни аларми
      // (напр. "Просрочено с 739856 дни" при грешно разчетена година).
      const applyToFields = { ...(body.apply_to_fields || {}) };
      delete applyToFields.registration_expiry;
      const vehicle = db.updateVehicle(talonConfirmMatch[1], {
        talon_data: talonData,
        talon_confirmed: true,
        ...applyToFields,
      });
      return sendJson(res, 200, { vehicle });
    }

    // ---- ASSIGNMENTS ------------------------------------------------------
    if (pathname === '/api/assignments' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { assignments: db.listAssignments({ vehicleId: query.vehicle_id, driverId: query.driver_id }) });
    }
    if (pathname === '/api/assignments' && req.method === 'POST') {
      const user = requirePermission(req, res, 'assignments', 'manage');
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
      const user = requirePermission(req, res, 'assignments', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.endAssignment(endAssignMatch[1], body);
      return sendJson(res, 200, { assignment: rec });
    }

    // едно кликване: зачисляване на кола под наем към шофьор + автоматично
    // съставяне на договор за наем и приемо-предавателен протокол (готови
    // за разписване от esign панела, вместо да се съставят на отделни стъпки)
    if (pathname === '/api/assignments/one-click' && req.method === 'POST') {
      const user = requirePermission(req, res, 'assignments', 'manage');
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
      const user = requirePermission(req, res, 'protocols', 'manage');
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
      const user = requirePermission(req, res, 'protocols', 'manage');
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
      const user = requirePermission(req, res, 'contracts', 'view');
      if (!user) return;
      return sendJson(res, 200, { contracts: db.listContracts({ vehicleId: query.vehicle_id }) });
    }
    if (pathname === '/api/contracts' && req.method === 'POST') {
      const user = requirePermission(req, res, 'contracts', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.createContract({ ...body, created_by: user.id });
      return sendJson(res, 201, { contract: rec });
    }
    const contractMatch = pathname.match(/^\/api\/contracts\/([\w-]+)$/);
    if (contractMatch && req.method === 'GET') {
      const user = requirePermission(req, res, 'contracts', 'view');
      if (!user) return;
      const rec = db.getContract(contractMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'Не е намерен' });
      return sendJson(res, 200, { contract: rec });
    }
    if (contractMatch && req.method === 'PUT') {
      const user = requirePermission(req, res, 'contracts', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.updateContract(contractMatch[1], body);
      return sendJson(res, 200, { contract: rec });
    }

    // изтегляне на договор като .docx / .pdf (вградена бланка или качен шаблон)
    const contractDocMatch = pathname.match(/^\/api\/contracts\/([\w-]+)\/(docx|pdf)$/);
    if (contractDocMatch && req.method === 'GET') {
      const user = requirePermission(req, res, 'contracts', 'view');
      if (!user) return;
      const rec = db.getContract(contractDocMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'Не е намерен' });
      const result = await docRender.renderDocument('contract', rec, contractDocMatch[2]);
      return sendBuffer(res, 200, result.buffer, { contentType: result.contentType, filename: result.filename });
    }

    // Депозит по договор за наем — вземане/връщане в брой. По изрично искане
    // на потребителя (2026-09-07) достъпът е разширен от само super_admin и
    // към admin/manager (твърд списък от роли, а не през конфигурируемата
    // матрица с права — виж repair-entry/bank-movements/adjustments по-горе
    // за същия подход при други касови действия).
    const contractDepositTakeMatch = pathname.match(/^\/api\/contracts\/([\w-]+)\/deposit\/take$/);
    if (contractDepositTakeMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager', 'super_admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        const result = db.addContractDeposit({
          contractId: contractDepositTakeMatch[1], amount: body.amount, note: body.note, createdBy: user.id,
        });
        return sendJson(res, 201, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const contractDepositReturnMatch = pathname.match(/^\/api\/contracts\/([\w-]+)\/deposit\/return$/);
    if (contractDepositReturnMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['admin', 'manager', 'super_admin']);
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        const result = db.returnContractDeposit({
          contractId: contractDepositReturnMatch[1], amount: body.amount, note: body.note, createdBy: user.id,
        });
        return sendJson(res, 201, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- PAYMENTS (приходи/разходи) -----------------------------------
    if (pathname === '/api/payments' && req.method === 'GET') {
      const user = requirePermission(req, res, 'contracts', 'view');
      if (!user) return;
      return sendJson(res, 200, { payments: db.listPayments({ vehicleId: query.vehicle_id }) });
    }
    if (pathname === '/api/payments' && req.method === 'POST') {
      const user = requirePermission(req, res, 'contracts', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.addPayment({ ...body, created_by: user.id });
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
      const user = requirePermission(req, res, 'wallet', 'view');
      if (!user) return;
      const wallets = db.listUsers().map(u => ({
        user_id: u.id, full_name: u.full_name, role: u.role,
        balance: db.getWalletBalance(u.id),
        // ЕГН/Bolt/Glovo ID — за да се вижда шофьорът навсякъде (виж driverIdLine в app.js)
        egn: u.egn || null, external_ids: u.external_ids || null,
      }));
      return sendJson(res, 200, { wallets });
    }

    const walletUserMatch = pathname.match(/^\/api\/wallet\/users\/([\w-]+)$/);
    if (walletUserMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = walletUserMatch[1];
      if (targetId !== user.id && !isManagerOrAbove(user)) {
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
        if (isAdminOrAbove(user)) {
          // админ (и super_admin) може да отменя чужди чакащи заявки (отхвърля ги вместо одобрение)
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
      const user = requirePermission(req, res, 'wallet', 'adjust');
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

    // ---- ОБЩА КАСА ---------------------------------------------------------
    // Един избран профил (обикновено мениджър), чийто портфейл служи за
    // общата фирмена каса. Тук постъпват само РЕАЛНИ движения на пари в брой:
    // изплатени заплати (markPayrollPaid), наеми от външни наематели
    // (addPayment), ремонти (repair-entry), ръчни корекции и платени
    // комисионни — виж коментара над CASHIER_TX_TYPES в lib/db.js. Наемът на
    // кола/удръжката по договор НЕ участват тук, а са чиста статистика (виж
    // /api/finance/non-cash-payroll-stats). Кой е касиерът се избира САМО от
    // супер администратора; ръчните движения по касата също са заключени само
    // за super_admin — нарочно НЕ минават през configurable permissions
    // matrix, за да няма как да бъдат отворени за друга роля.
    if (pathname === '/api/cashier' && req.method === 'GET') {
      const user = requirePermission(req, res, 'cashier', 'view');
      if (!user) return;
      const cashierId = db.getCashierProfileId();
      if (!cashierId) return sendJson(res, 200, { cashier: null, balance: 0, transactions: [] });
      const cashier = db.findUserById(cashierId);
      return sendJson(res, 200, {
        cashier: cashier ? { id: cashier.id, full_name: cashier.full_name, role: cashier.role } : null,
        balance: db.getCashierBalance(cashierId),
        transactions: db.listCashierTransactions(cashierId, { from: query.from, to: query.to }),
      });
    }
    // връща и списък мениджъри/админи, измежду които супер администраторът
    // може да избере касиер — само super_admin вижда/пипа тази настройка
    if (pathname === '/api/cashier/settings' && req.method === 'GET') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      const candidates = db.listUsers()
        .filter(u => ['admin', 'manager'].includes(u.role) && u.status === 'active')
        .map(u => ({ id: u.id, full_name: u.full_name, role: u.role }));
      return sendJson(res, 200, { cashier_profile_id: db.getCashierProfileId(), candidates });
    }
    if (pathname === '/api/cashier/settings' && req.method === 'PUT') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        const cashierId = db.setCashierProfileId(body.profile_id || null);
        return sendJson(res, 200, { cashier_profile_id: cashierId });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    // "Друго" — общ ръчен приход/разход по касата; описанието вече е
    // ЗАДЪЛЖИТЕЛНО (по изрично изискване — трябва да има опис за какво е)
    if (pathname === '/api/cashier/adjustments' && req.method === 'POST') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      const cashierId = db.getCashierProfileId();
      if (!cashierId) return sendJson(res, 400, { error: 'Няма избран касиер — задайте го от настройките на касата.' });
      const body = await readJsonBody(req);
      if (body.amount == null || isNaN(Number(body.amount)) || Number(body.amount) === 0) {
        return sendJson(res, 400, { error: 'Невалидна сума' });
      }
      if (!body.note || !String(body.note).trim()) {
        return sendJson(res, 400, { error: 'Нужен е опис за какво е движението' });
      }
      const rec = db.addWalletAdjustment({
        user_id: cashierId, amount: Number(body.amount),
        type: 'cashier_manual', note: body.note, created_by: user.id,
      });
      return sendJson(res, 201, { transaction: rec, balance: db.getCashierBalance(cashierId) });
    }
    // Ремонт/разход по кола, платен директно от касата — създава едновременно
    // запис в сервизната книжка (км по избор) и касов разход
    if (pathname === '/api/cashier/repair-entry' && req.method === 'POST') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        const result = db.addCashierRepairEntry({
          vehicleId: body.vehicle_id, amount: body.amount, description: body.description,
          odometerKm: body.odometer_km, serviceDate: body.service_date, createdBy: user.id,
        });
        return sendJson(res, 201, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    // Движения по банкова сметка — отделен дневник от касата в брой
    if (pathname === '/api/cashier/bank-movements' && req.method === 'GET') {
      const user = requirePermission(req, res, 'cashier', 'view');
      if (!user) return;
      return sendJson(res, 200, { movements: db.listBankMovements({ from: query.from, to: query.to }) });
    }
    if (pathname === '/api/cashier/bank-movements' && req.method === 'POST') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        const rec = db.addBankMovement({
          direction: body.direction, amount: body.amount, description: body.description,
          movement_date: body.movement_date, created_by: user.id,
        });
        return sendJson(res, 201, { movement: rec });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    // ---- Качване на банково извлечение (CSV/Excel) — preview → apply, по
    // същия двустъпков модел като Bolt/Glovo импорта на заработки (виж по-
    // горе и lib/bank-import.js). Заключено само за super_admin — както
    // всички останали РЪЧНИ движения по касата/банката (виж коментара над
    // addBankMovement в lib/db.js).
    if (pathname === '/api/cashier/bank-statement/imports' && req.method === 'GET') {
      const user = requirePermission(req, res, 'cashier', 'view');
      if (!user) return;
      return sendJson(res, 200, { imports: db.listBankStatementImports() });
    }
    if (pathname === '/api/cashier/bank-statement/preview' && req.method === 'POST') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const buffer = Buffer.from(String(body.file_base64 || '').replace(/^data:[^,]*,/, ''), 'base64');
      if (!buffer.length) return sendJson(res, 400, { error: 'Празен или невалиден файл' });
      let parsed;
      try { parsed = bankImport.parseBankStatementFile(buffer, body.column_map); }
      catch (e) {
        const status = e.code === 'MODULE_NOT_AVAILABLE' ? 503 : 400;
        return sendJson(res, status, { error: e.message, code: e.code || null });
      }
      // за всеки успешно разчетен ред — предложение за съпоставка (ако има) +
      // проверка дали вече е качен преди (по external_ref, ако банката го дава)
      const rows = parsed.rows.map((r) => {
        if (r.error) return r;
        const duplicate = r.external_ref ? db.findBankMovementByExternalRef(r.external_ref) : null;
        const suggestion = duplicate ? null : db.suggestBankMatch(r);
        return { ...r, duplicate: !!duplicate, suggested_match: suggestion };
      });
      const reconciliation = body.statement_closing_balance != null
        ? db.getBankBalanceReconciliation(body.statement_closing_balance)
        : null;
      return sendJson(res, 200, {
        headers: parsed.headers, detected: parsed.detected, errors: parsed.errors, rows, reconciliation,
      });
    }
    if (pathname === '/api/cashier/bank-statement/apply' && req.method === 'POST') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      const body = await readJsonBody(req);
      const buffer = Buffer.from(String(body.file_base64 || '').replace(/^data:[^,]*,/, ''), 'base64');
      if (!buffer.length) return sendJson(res, 400, { error: 'Празен или невалиден файл' });
      let parsed;
      try { parsed = bankImport.parseBankStatementFile(buffer, body.column_map); }
      catch (e) {
        const status = e.code === 'MODULE_NOT_AVAILABLE' ? 503 : 400;
        return sendJson(res, status, { error: e.message, code: e.code || null });
      }

      // rowOverrides (по избор): { [row_index]: { skip: true } | { category: '...' } } —
      // идва от преглед/потвърждение на администратора в UI-то, например
      // "пропусни този ред" или ръчно избрана категория за несъпоставен ред.
      const rowOverrides = body.row_overrides || {};
      let archivedFile = null;
      try { archivedFile = saveBase64File(body.file_base64, 'bank-statement-import', 'csv'); }
      catch (e) { /* архивирането на оригиналния файл е best-effort, не блокира импорта */ }

      // първо подготвяме КОИ редове реално ще се запишат (и с какъв
      // matched_type) — без да пипаме базата — за да можем да създадем
      // bank_statement_imports записа с правилните броячи ПРЕДИ движенията,
      // и после да подадем готовия import_batch_id директно при създаването
      // им (вместо да го допълваме със late мутация след запис, което в
      // Postgres режим НЕ би се отразило трайно, защото writeDb вече е
      // извикан — виж addBankMovement/writeDb в lib/db.js).
      let skippedDuplicates = 0, skippedErrors = 0;
      const toWrite = [];
      // следим external_ref-овете, вече избрани за запис В ТОЗИ ПАКЕТ — иначе
      // два реда със еднакъв external_ref В ЕДИН И СЪЩИ файл (напр. банката
      // случайно е изнесла една транзакция два пъти) минават проверката по-
      // долу (която гледа само вече ЗАПИСАНИ движения в базата) и се
      // записват и двата, задвоявайки сумата (открит и потвърден бъг при одита).
      const seenRefsInBatch = new Set();
      for (const r of parsed.rows) {
        const override = rowOverrides[r.row_index] || {};
        if (r.error || override.skip) { skippedErrors += r.error ? 1 : 0; continue; }
        if (r.external_ref && (db.findBankMovementByExternalRef(r.external_ref) || seenRefsInBatch.has(r.external_ref))) { skippedDuplicates++; continue; }
        if (r.external_ref) seenRefsInBatch.add(r.external_ref);
        const suggestion = db.suggestBankMatch(r);
        const matchedType = override.matched_type || (suggestion ? suggestion.matched_type : 'unmatched');
        const matchedRefId = override.matched_ref_id || (suggestion ? suggestion.matched_ref_id : null);
        toWrite.push({
          row: r, matchedType, matchedRefId,
          description: r.description || override.category || (suggestion ? suggestion.label : 'Банкова транзакция'),
          category: override.category || null,
        });
      }

      const importRec = db.addBankStatementImport({
        bank_name: body.bank_name || 'Пощенска банка', account_label: body.account_label || null,
        period_from: body.period_from || null, period_to: body.period_to || null,
        statement_closing_balance: body.statement_closing_balance,
        file_url: archivedFile ? archivedFile.url : null, imported_by: user.id,
        row_count: parsed.rows.length,
        matched_count: toWrite.filter(x => x.matchedType && x.matchedType !== 'unmatched').length,
        unmatched_count: toWrite.filter(x => !x.matchedType || x.matchedType === 'unmatched').length,
      });

      const createdMovements = toWrite.map(x => db.addBankMovement({
        direction: x.row.direction, amount: x.row.amount, description: x.description,
        movement_date: x.row.date, created_by: user.id,
        source: 'import', import_batch_id: importRec.id, external_ref: x.row.external_ref,
        matched_type: x.matchedType, matched_ref_id: x.matchedRefId, category: x.category,
      }));
      const written = createdMovements.length;

      const reconciliation = body.statement_closing_balance != null
        ? db.getBankBalanceReconciliation(body.statement_closing_balance)
        : null;
      return sendJson(res, 201, {
        import: importRec, written, skipped_duplicates: skippedDuplicates, skipped_errors: skippedErrors,
        reconciliation,
      });
    }

    // обобщение за период (ден/седмица/месец — просто from/to дати): всичко,
    // което реално мина през касата + банковите движения = ясна печалба
    if (pathname === '/api/cashier/period-summary' && req.method === 'GET') {
      const user = requirePermission(req, res, 'cashier', 'view');
      if (!user) return;
      return sendJson(res, 200, db.getCashierPeriodSummary({ from: query.from, to: query.to }));
    }
    // статистика (НЕ касова!) за наем на коли + удръжки по договор — виж
    // коментара над CASHIER_TX_TYPES/upsertPayrollEntry в lib/db.js
    if (pathname === '/api/cashier/non-cash-payroll-stats' && req.method === 'GET') {
      const user = requirePermission(req, res, 'cashier', 'view');
      if (!user) return;
      return sendJson(res, 200, db.getNonCashPayrollStats({ from: query.from, to: query.to }));
    }

    // ---- Автоматични седмични отчети (вж. ensureLastCompletedWeeklyReport в
    // lib/db.js) — "ensure-latest" генерира (само ако липсва) отчета за
    // последната завършена седмица; вика се best-effort при отваряне на
    // /profit.html, не блокира самото табло ако пропадне.
    if (pathname === '/api/reports/weekly' && req.method === 'GET') {
      const user = requirePermission(req, res, 'cashier', 'view');
      if (!user) return;
      return sendJson(res, 200, { reports: db.listWeeklyReports() });
    }
    if (pathname === '/api/reports/weekly/ensure-latest' && req.method === 'POST') {
      const user = requirePermission(req, res, 'cashier', 'view');
      if (!user) return;
      try {
        return sendJson(res, 200, { report: db.ensureLastCompletedWeeklyReport(user.id) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- Подробен седмичен финансов отчет ("всеки петък") — виж коментара
    // над buildDetailedWeeklyFinancialReport в lib/db.js. Отделен от простото
    // табло "Печалба" по-горе — този е поименно детайлен и се генерира
    // автоматично от самия сървър (виж checkAndGenerateWeeklyFinancialReport
    // по-долу), не само при отваряне на страница.
    if (pathname === '/api/reports/weekly-financial' && req.method === 'GET') {
      const user = requirePermission(req, res, 'weekly_financial_report', 'view');
      if (!user) return;
      // пестим трафик при списъка — само числови обобщения, без пълните
      // редове (виж /detail за цял отчет по избрана седмица)
      const reports = db.listWeeklyFinancialReports().map(r => ({
        id: r.id, week_start: r.week_start, week_end: r.week_end,
        expense_week_start: r.data.expense_week_start, expense_week_end: r.data.expense_week_end,
        generated_at: r.generated_at,
        payouts_total: r.data.payouts_total, revenue_total: r.data.revenue_total,
        total_profit: r.data.total_profit, accrual_profit: r.data.accrual_profit,
        expenses_total: r.data.expenses.accrual_total,
      }));
      return sendJson(res, 200, { reports });
    }
    if (pathname === '/api/reports/weekly-financial/detail' && req.method === 'GET') {
      const user = requirePermission(req, res, 'weekly_financial_report', 'view');
      if (!user) return;
      if (!query.week_start) return sendJson(res, 400, { error: 'Липсва week_start' });
      const report = db.getWeeklyFinancialReport(query.week_start);
      if (!report) return sendJson(res, 404, { error: 'Няма отчет за тази седмица' });
      return sendJson(res, 200, { report });
    }
    if (pathname === '/api/reports/weekly-financial/ensure-latest' && req.method === 'POST') {
      const user = requirePermission(req, res, 'weekly_financial_report', 'view');
      if (!user) return;
      try {
        return sendJson(res, 200, { report: db.ensureLatestWeeklyFinancialReport(user.id) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (pathname === '/api/reports/weekly-financial/regenerate' && req.method === 'POST') {
      const user = requirePermission(req, res, 'weekly_financial_report', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.week_start) return sendJson(res, 400, { error: 'Липсва week_start' });
      try {
        return sendJson(res, 200, { report: db.regenerateWeeklyFinancialReport(body.week_start, user.id) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (pathname === '/api/reports/weekly-financial/export' && req.method === 'GET') {
      const user = requirePermission(req, res, 'weekly_financial_report', 'view');
      if (!user) return;
      if (!query.week_start) return sendJson(res, 400, { error: 'Липсва week_start' });
      const report = db.getWeeklyFinancialReport(query.week_start);
      if (!report) return sendJson(res, 404, { error: 'Няма отчет за тази седмица' });
      try {
        const buf = db.buildWeeklyFinancialReportWorkbook(report);
        res.writeHead(200, {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': `attachment; filename="sedmichen-finansov-otchet-${report.week_start}.xlsx"`,
          'content-length': buf.length,
        });
        return res.end(buf);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // ---- СЧЕТОВОДСТВО (общ финансов отчет + ръчна счетоводна книга) -------
    if (pathname === '/api/finance/report' && req.method === 'GET') {
      const user = requirePermission(req, res, 'finance', 'view');
      if (!user) return;
      const report = db.getCompanyFinanceReport({ from: query.from, to: query.to });
      return sendJson(res, 200, report);
    }
    if (pathname === '/api/finance/entries' && req.method === 'GET') {
      const user = requirePermission(req, res, 'finance', 'view');
      if (!user) return;
      return sendJson(res, 200, { entries: db.listFinanceEntries({ from: query.from, to: query.to }) });
    }
    if (pathname === '/api/finance/entries' && req.method === 'POST') {
      const user = requirePermission(req, res, 'finance', 'manage');
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
      const user = requirePermission(req, res, 'finance', 'manage');
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
      const user = requirePermission(req, res, 'backups', 'view');
      if (!user) return;
      return sendJson(res, 200, { backups: backup.listBackups(), dataDir: backup.DATA_DIR });
    }
    if (pathname === '/api/backups/run' && req.method === 'POST') {
      const user = requirePermission(req, res, 'backups', 'manage');
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
      const user = requirePermission(req, res, 'backups', 'view');
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
      const user = requirePermission(req, res, 'backups', 'manage');
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

    // ---- READ RECEIPT PIXEL (виж sendMail/trackingPixelUrl в lib/mail.js) --
    // НАРОЧНО БЕЗ requirePermission — браузърът/пощенският клиент на ПОЛУЧАТЕЛЯ
    // е този, който зарежда тази картинка (няма наша сесийна бисквитка), затова
    // route-ът трябва да е публичен. Винаги връща валидно изображение, дори
    // при непознат токен — за да не издава на подателя на случаен имейл дали
    // дадена стойност е истински токен (виж markMailOpened в lib/db.js).
    const mailTrackMatch = pathname.match(/^\/api\/mail\/track\/([\w-]+)\.png$/);
    if (mailTrackMatch && req.method === 'GET') {
      try { db.markMailOpened(mailTrackMatch[1]); } catch (e) { /* тихо — пикселът трябва да се върне във всеки случай */ }
      // прозрачен 1x1 GIF (43 байта) — най-малкият валиден "pixel", стандартна
      // практика при read-receipt тракери (виж research бележката в mail.html)
      const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64');
      res.writeHead(200, {
        'content-type': 'image/gif',
        'content-length': pixel.length,
        'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
        pragma: 'no-cache',
      });
      return res.end(pixel);
    }

    // ---- ПОЩЕНСКА КУТИЯ (office@dombi.bg през Zoho Mail, виж lib/mail.js) -
    if (pathname === '/api/mail/inbox' && req.method === 'GET') {
      const user = requirePermission(req, res, 'mail', 'view');
      if (!user) return;
      try {
        const limit = Math.min(Math.max(parseInt(query.limit, 10) || 30, 1), 100);
        const messages = await mail.listInbox({ limit });
        return sendJson(res, 200, { messages });
      } catch (err) {
        return sendJson(res, err.code === 'MAIL_NOT_CONFIGURED' ? 503 : 502, { error: err.message });
      }
    }
    // лек брояч на непрочетени — за индикатора в sidebar-а (вика се на всяка
    // страница, на интервал, виж startNotificationBadges в app.js); нарочно
    // НЕ хвърля грешка при неконфигурирана/недостъпна поща, за да не чупи
    // менюто на страници, различни от самата "Пощенска кутия" — просто
    // показва 0 (бадж-ът остава скрит).
    if (pathname === '/api/mail/unread-count' && req.method === 'GET') {
      const user = requirePermission(req, res, 'mail', 'view');
      if (!user) return;
      try {
        const unread = await mail.getUnreadCount();
        return sendJson(res, 200, { unread });
      } catch (err) {
        return sendJson(res, 200, { unread: 0, error: err.message });
      }
    }
    if (pathname === '/api/mail/sent' && req.method === 'GET') {
      const user = requirePermission(req, res, 'mail', 'view');
      if (!user) return;
      try {
        const limit = Math.min(Math.max(parseInt(query.limit, 10) || 30, 1), 100);
        const messages = await mail.listSent({ limit });
        // "прочетено от получателя" — съпоставяме по Message-ID с нашите
        // read-receipt записи (виж recordMailSent в lib/mail.js sendMail());
        // писма, изпратени преди тази функция (или през самия Zoho Webmail),
        // просто нямат запис — read: null означава "няма данни", не "непрочетено"
        const tracking = db.getMailTrackingByMessageIds(messages.map(m => m.messageId));
        const enriched = messages.map(m => {
          const t = m.messageId ? tracking[m.messageId] : null;
          return { ...m, read: t ? { opened: t.opened, openedAt: t.opened_at, openCount: t.open_count } : null };
        });
        return sendJson(res, 200, { messages: enriched });
      } catch (err) {
        return sendJson(res, err.code === 'MAIL_NOT_CONFIGURED' ? 503 : 502, { error: err.message });
      }
    }
    const mailMessageMatch = pathname.match(/^\/api\/mail\/message\/([\w-]+)$/);
    if (mailMessageMatch && req.method === 'GET') {
      const user = requirePermission(req, res, 'mail', 'view');
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
    // ръчно маркиране прочетено/непрочетено (напр. "Маркирай като непрочетено"
    // в detail изгледа — обратното вече става автоматично при отваряне, виж
    // getMessage() в lib/mail.js); body: {folder, seen: true|false}
    const mailSeenMatch = pathname.match(/^\/api\/mail\/message\/([\w-]+)\/seen$/);
    if (mailSeenMatch && req.method === 'POST') {
      const user = requirePermission(req, res, 'mail', 'view');
      if (!user) return;
      const body = await readJsonBody(req);
      const folder = body.folder || 'INBOX';
      const seen = body.seen !== false;
      try {
        await mail.setSeen(mailSeenMatch[1], folder, seen);
        return sendJson(res, 200, { ok: true, seen });
      } catch (err) {
        const status = err.code === 'MAIL_NOT_CONFIGURED' ? 503 : (err.code === 'MAIL_NOT_FOUND' ? 404 : 502);
        return sendJson(res, status, { error: err.message });
      }
    }
    const mailAttachmentMatch = pathname.match(/^\/api\/mail\/message\/([\w-]+)\/attachment\/(\d+)$/);
    if (mailAttachmentMatch && req.method === 'GET') {
      const user = requirePermission(req, res, 'mail', 'view');
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
      const user = requirePermission(req, res, 'mail', 'manage');
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
      // read-receipt токен за тази заявка — вграждаме го като невидим pixel
      // в HTML версията на писмото (виж trackingPixelUrl в lib/mail.js); ако
      // изпращането успее, пазим токена в lib/db.js, за да можем после да
      // съпоставим "Изпратени" (по Message-ID) с "отворено ли е"
      const trackingToken = crypto.randomBytes(16).toString('hex');
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host;
      const trackingPixelUrl = `${proto}://${host}/api/mail/track/${trackingToken}.png`;
      try {
        const result = await mail.sendMail({
          to,
          cc: cc || undefined,
          subject: String(body.subject).slice(0, 300),
          text: String(body.text).slice(0, 20000),
          inReplyTo: body.inReplyTo || undefined,
          references: body.references || undefined,
          attachments,
          replyToUid: body.replyToUid || undefined,
          replyToFolder: body.replyToFolder || undefined,
          trackingPixelUrl,
        });
        try {
          db.recordMailSent({ token: trackingToken, messageId: result.messageId, to, subject: body.subject });
        } catch (e) { /* писмото вече е изпратено успешно — не проваляме отговора заради това */ }
        return sendJson(res, 200, { ok: true, messageId: result.messageId });
      } catch (err) {
        return sendJson(res, err.code === 'MAIL_NOT_CONFIGURED' ? 503 : 502, { error: err.message });
      }
    }

    // ---- ФИНАНСОВИ СИГНАЛИ — автоматичен анализ за финансови грешки/
    // разминавания (каса, банка, заплати, договори за наем), изрично искане
    // на потребителя: "системата сама трябва да прави анализ и да алармира
    // за финансови грешки". Само в системата (без имейли) — виж
    // db.getFinanceAlerts() + бадж в менюто (finance_alerts в app.js).
    if (pathname === '/api/finance/alerts' && req.method === 'GET') {
      const user = requirePermission(req, res, 'finance_alerts', 'view');
      if (!user) return;
      return sendJson(res, 200, { alerts: db.getFinanceAlerts() });
    }
    if (pathname === '/api/finance/alerts/count' && req.method === 'GET') {
      const user = requirePermission(req, res, 'finance_alerts', 'view');
      if (!user) return;
      return sendJson(res, 200, { count: db.getFinanceAlerts().length });
    }

    // ---- ЛИЧНИ ДОСИЕТА (HR картотека на документите) ---------------------
    // Служебна карта на служителя: лична карта, шофьорска книжка, трудови/
    // граждански договори, договори за наем и протоколи, на едно място +
    // изтичащи документи (виж getEmployeeDocumentAlerts, обединено в /api/dashboard).
    if (pathname === '/api/hr/personnel' && req.method === 'GET') {
      const user = requirePermission(req, res, 'hr_personnel', 'view');
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
        // ЕГН/Bolt/Glovo ID — за списъка "Всички служители" (виж driverIdLine
        // в app.js); ЕГН се маскира на клиента, external_ids се показват изцяло
        egn: u.egn || null,
        external_ids: u.external_ids || null,
      }));
      return sendJson(res, 200, { employees });
    }

    // ---- "ВСЕКИ ШОФЬОР ДА Е ЗАЧИСЛЕН КЪМ НЯКОЙ" — незачислени шофьори + ---
    // масово зачисляване наведнъж (вместо отделна редакция на всяко досие)
    if (pathname === '/api/hr/personnel/unassigned-drivers' && req.method === 'GET') {
      const user = requirePermission(req, res, 'hr_personnel', 'view');
      if (!user) return;
      return sendJson(res, 200, { drivers: db.listUnassignedDrivers() });
    }
    if (pathname === '/api/hr/personnel/bulk-assign-manager' && req.method === 'POST') {
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        const result = db.bulkAssignManager(body.driver_ids, body.manager_id);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    const personnelMatch = pathname.match(/^\/api\/hr\/personnel\/([\w-]+)$/);
    if (personnelMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = personnelMatch[1];
      if (targetId !== user.id && !isManagerOrAbove(user)) {
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
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const allowed = ['egn', 'address', 'city', 'manager_id', 'full_name', 'phone', 'status',
        'id_card_number', 'id_card_expiry', 'driver_license_number', 'driver_license_expiry',
        'start_date', 'end_date',
        // за Приложение 1 (ГДПР декларация) и "Декларация за осигуряване" към
        // гражданския договор „Реклама и пренос на стока“ — вж. lib/pdf-builder.js
        // buildCivilAdContractPdf/Docx и изричното искане на потребителя за
        // пълно внедряване на реалния шаблон с приложения
        'id_card_issue_date', 'id_card_issued_by',
        'insurance_status', 'insurance_gross_amount'];
      // смяна на роля и имейл — само admin/super_admin (по-чувствителни полета)
      if (isAdminOrAbove(user)) allowed.push('role', 'email');
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
      const user = requirePermission(req, res, 'hr_personnel', 'delete');
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
      const user = requirePermission(req, res, 'hr_personnel', 'delete');
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
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
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
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const { url } = saveBase64Image(body.photo, 'idcard');
      const field = body.side === 'back' ? 'id_card_photo_back_url' : 'id_card_photo_url';
      const updated = db.updateUser(personnelIdPhotoMatch[1], { [field]: url });
      return sendJson(res, 200, { profile: updated });
    }
    const personnelLicensePhotoMatch = pathname.match(/^\/api\/hr\/personnel\/([\w-]+)\/license-photo$/);
    if (personnelLicensePhotoMatch && req.method === 'POST') {
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const { url } = saveBase64Image(body.photo, 'license');
      const field = body.side === 'back' ? 'driver_license_photo_back_url' : 'driver_license_photo_url';
      const updated = db.updateUser(personnelLicensePhotoMatch[1], { [field]: url });
      return sendJson(res, 200, { profile: updated });
    }
    const personnelSelfiePhotoMatch = pathname.match(/^\/api\/hr\/personnel\/([\w-]+)\/selfie-photo$/);
    if (personnelSelfiePhotoMatch && req.method === 'POST') {
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const { url } = saveBase64Image(body.photo, 'selfie');
      const updated = db.updateUser(personnelSelfiePhotoMatch[1], { selfie_photo_url: url });
      return sendJson(res, 200, { profile: updated });
    }

    // премахване на качена по грешка/сгрешена/разменена снимка на документ —
    // просто изчиства полето (URL-а), без да пипа останалите данни на
    // служителя; ?side=front|back за ЛК/книжка (front по подразбиране)
    if (personnelIdPhotoMatch && req.method === 'DELETE') {
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
      if (!user) return;
      const field = query.side === 'back' ? 'id_card_photo_back_url' : 'id_card_photo_url';
      const updated = db.updateUser(personnelIdPhotoMatch[1], { [field]: null });
      return sendJson(res, 200, { profile: updated });
    }
    if (personnelLicensePhotoMatch && req.method === 'DELETE') {
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
      if (!user) return;
      const field = query.side === 'back' ? 'driver_license_photo_back_url' : 'driver_license_photo_url';
      const updated = db.updateUser(personnelLicensePhotoMatch[1], { [field]: null });
      return sendJson(res, 200, { profile: updated });
    }
    if (personnelSelfiePhotoMatch && req.method === 'DELETE') {
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
      if (!user) return;
      const updated = db.updateUser(personnelSelfiePhotoMatch[1], { selfie_photo_url: null });
      return sendJson(res, 200, { profile: updated });
    }

    // трудови / граждански договори (седмични удръжки по подразбиране, ръчно променими)
    if (pathname === '/api/hr/deduction-defaults' && req.method === 'GET') {
      const user = requirePermission(req, res, 'payroll', 'view');
      if (!user) return;
      return sendJson(res, 200, { defaults: db.getDeductionDefaults() });
    }
    if (pathname === '/api/hr/deduction-defaults' && req.method === 'PUT') {
      const user = requirePermission(req, res, 'payroll', 'finalize');
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
      if (targetId !== user.id && !isManagerOrAbove(user)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      return sendJson(res, 200, { contracts: db.listEmploymentContracts(targetId) });
    }
    if (employmentContractsMatch && req.method === 'POST') {
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
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
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
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
      if (rec.profile_id !== user.id && !isManagerOrAbove(user)) {
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
      const user = requirePermission(req, res, 'hr_personnel', 'manage');
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

    // ---- НАСТРОЙКИ ----------------------------------------------------------
    // Засега само avg_km_per_order (вж. db.getSettings/updateSettings) —
    // средна стойност км/поръчка за изчисляване на оценъчния пробег в
    // седмичните протоколи за заплати (buildPayrollConfirmationPdf), които
    // служат и като документална база за фактурите по гориво/части.
    if (pathname === '/api/settings' && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      return sendJson(res, 200, { settings: db.getSettings() });
    }
    if (pathname === '/api/settings' && req.method === 'PUT') {
      const user = requirePermission(req, res, 'payroll', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const settings = db.updateSettings(body);
      return sendJson(res, 200, { settings });
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
      if (targetProfileId && targetProfileId !== user.id && !isManagerOrAbove(user)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const profileId = targetProfileId || (isManagerOrAbove(user) ? undefined : user.id);
      let entries = db.listPayrollEntries({ profileId, weekStart: query.week_start });
      // ако заявителят е самият шофьор и админ не му е разрешил да вижда
      // заработката, оставяме само броя поръчки — сумите се скриват изцяло
      // (включително наема на кола — той също е парична сума, а не само
      // gross/deduction/net; преди този фикс изтичаше немаскиран тук)
      const viewingOwnWithoutEarnings = profileId === user.id && !isManagerOrAbove(user) && !db.canViewEarnings(user);
      if (viewingOwnWithoutEarnings) {
        entries = entries.map(e => ({
          ...e, gross_earnings: null, deduction_amount: null, car_rent_amount: null, net_amount: null,
        }));
      }
      // оценъчен пробег (не е парична сума — показва се винаги, вкл. на
      // самия шофьор; вж. buildPayrollConfirmationPdf за пълния контекст)
      const avgKmPerOrder = db.getSettings().avg_km_per_order;
      entries = entries.map(e => ({ ...e, estimated_km: Math.round(Number(e.order_count || 0) * avgKmPerOrder) }));
      return sendJson(res, 200, { entries, earnings_visible: !viewingOwnWithoutEarnings, avg_km_per_order: avgKmPerOrder });
    }
    if (pathname === '/api/hr/payroll' && req.method === 'POST') {
      const user = requirePermission(req, res, 'payroll', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.profile_id || !body.week_start || !body.week_end) {
        return sendJson(res, 400, { error: 'Липсват задължителни полета (служител, начало/край на седмица)' });
      }
      // ако администраторът въведе удръжка на ръка, пазим я като 'manual' —
      // процентната автоматика (deduction_source: 'percentage') е само за
      // удръжки, изчислени директно от заработка в качен седмичен отчет
      // (вж. /api/hr/payroll/import/apply по-долу); ръчен ред тук винаги е
      // изричен избор на администратора, затова не пипаме source/rate.
      const rec = db.upsertPayrollEntry({
        profile_id: body.profile_id, week_start: body.week_start, week_end: body.week_end,
        order_count: Number(body.order_count) || 0, gross_earnings: Number(body.gross_earnings) || 0,
        deduction_amount: body.deduction_amount != null ? Number(body.deduction_amount) : undefined,
        deduction_source: body.deduction_amount != null ? 'manual' : undefined,
        deduction_rate: body.deduction_amount != null ? null : undefined,
        car_rent_amount: body.car_rent_amount != null ? Number(body.car_rent_amount) : undefined,
        source: body.source || 'manual',
        created_by: user.id,
      });
      return sendJson(res, 200, { entry: rec });
    }

    // еднократно/при нужда преизчисляване на удръжка по договор + наем на
    // кола за СЪЩЕСТВУВАЩИ седмични записи, по ТЕКУЩО зададените параметри
    // (активни трудови/граждански договори + активни договори за наем на
    // коли) — нужно напр. след бекфил на история, направен преди тези
    // параметри да са били зададени, или след промяна на такса/процент,
    // за да се види реалният ефект върху вече качени седмици без да се
    // качва отново самият Excel файл. Не пипа gross_earnings/order_count,
    // само deduction_amount/car_rent_amount(+net).
    if (pathname === '/api/hr/payroll/recalc-deductions' && req.method === 'POST') {
      const user = requirePermission(req, res, 'payroll', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      let entries = db.listPayrollEntries({});
      if (body.week_start) entries = entries.filter(e => e.week_start >= body.week_start);
      if (body.week_end) entries = entries.filter(e => e.week_start <= body.week_end);
      const updated = [];
      for (const e of entries) {
        const defaults = db.getDefaultPayrollDeductions(e.profile_id, e.gross_earnings);
        const rec = db.upsertPayrollEntry({
          profile_id: e.profile_id, week_start: e.week_start, week_end: e.week_end,
          order_count: e.order_count, gross_earnings: e.gross_earnings,
          deduction_amount: defaults.deduction_amount,
          deduction_source: defaults.deduction_source,
          deduction_rate: defaults.deduction_rate,
          car_rent_amount: defaults.car_rent_amount,
          source: e.source,
          created_by: user.id,
        });
        updated.push({
          id: rec.id, profile_id: rec.profile_id, week_start: rec.week_start,
          deduction_amount: rec.deduction_amount, car_rent_amount: rec.car_rent_amount, net_amount: rec.net_amount,
        });
      }
      return sendJson(res, 200, { updated_count: updated.length, updated });
    }

    // ---- Справка "дължимо / изплатено" --------------------------------
    // Едно обобщение по шофьор за избран период, с филтър по град/мениджър/
    // статус — захранва новата секция "Бързо изплащане" в /payroll.html,
    // така че "какво дължим на кого и за кой период" да е видимо с едно
    // зареждане на страницата, без допълнителен бутон/заявка.
    if (pathname === '/api/hr/payroll/report' && req.method === 'GET') {
      const user = requirePermission(req, res, 'payroll', 'view');
      if (!user) return;
      const report = db.getPayrollDueReport({
        weekStart: query.week_start || undefined,
        weekEnd: query.week_end || undefined,
        city: query.city || undefined,
        managerId: query.manager_id || undefined,
        status: query.status || undefined,
      });
      return sendJson(res, 200, report);
    }

    // ---- Масово изплащане ("Изплати маркираните") ----------------------
    if (pathname === '/api/hr/payroll/bulk-pay' && req.method === 'POST') {
      const user = requirePermission(req, res, 'payroll', 'finalize');
      if (!user) return;
      const body = await readJsonBody(req);
      if (!Array.isArray(body.ids) || !body.ids.length) {
        return sendJson(res, 400, { error: 'Липсва списък от записи за изплащане (ids).' });
      }
      const result = db.bulkMarkPayrollPaid(body.ids, user.id);
      return sendJson(res, 200, { updated_count: result.updated.length, updated: result.updated, errors: result.errors });
    }

    // ---- Заявки за корекция на вече записана седмица --------------------
    // Мениджър предлага промяна ("при грешка") → изчаква одобрение от админ,
    // вместо да презаписва директно записа (виж коментара в lib/db.js над
    // createPayrollCorrectionRequest). Огледално на /api/hr/leave/requests.
    if (pathname === '/api/hr/payroll/correction-requests' && req.method === 'GET') {
      const user = requirePermission(req, res, 'payroll', 'view');
      if (!user) return;
      const filter = { status: query.status || undefined };
      if (!isAdminOrAbove(user)) filter.requestedBy = user.id;
      return sendJson(res, 200, { requests: db.listPayrollCorrectionRequests(filter) });
    }

    if (pathname === '/api/hr/payroll/correction-requests' && req.method === 'POST') {
      const user = requirePermission(req, res, 'payroll', 'request_correction');
      if (!user) return;
      const body = await readJsonBody(req);
      if (!body.payroll_entry_id || !body.requested_changes || !Object.keys(body.requested_changes).length) {
        return sendJson(res, 400, { error: 'Липсва запис за заплата или предложени промени.' });
      }
      try {
        const rec = db.createPayrollCorrectionRequest({
          payroll_entry_id: body.payroll_entry_id,
          requested_changes: body.requested_changes,
          reason: body.reason || null,
          requested_by: user.id,
        });
        return sendJson(res, 201, { request: rec });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    const payrollCorrectionDecideMatch = pathname.match(/^\/api\/hr\/payroll\/correction-requests\/([\w-]+)\/decide$/);
    if (payrollCorrectionDecideMatch && req.method === 'POST') {
      const user = requirePermission(req, res, 'payroll', 'finalize');
      if (!user) return;
      const body = await readJsonBody(req);
      try {
        const rec = db.decidePayrollCorrectionRequest(payrollCorrectionDecideMatch[1], {
          approve: !!body.approve, decided_by: user.id, decision_note: body.decision_note || null,
        });
        return sendJson(res, 200, { request: rec });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
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
      const user = requirePermission(req, res, 'payroll', 'view');
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
      const user = requirePermission(req, res, 'payroll', 'manage');
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
      const user = requirePermission(req, res, 'payroll', 'manage');
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
        // защита срещу разминати/непълни седмици (напр. 15.08–20.08 вместо
        // 15.08–21.08) — такъв запис "залива" в две съседни календарни седмици
        // и разваля филтрирането по седмица в статистиката/заплатите надолу по
        // веригата (виж loadPayrollStats в payroll.html); изисква се точно
        // 7-дневен период (начало + 6 дни = край)
        const spanDays = Math.round((new Date(weekEnd) - new Date(weekStart)) / 86400000);
        if (spanDays !== 6) {
          return sendJson(res, 400, {
            error: `Периодът ${weekStart} — ${weekEnd} не е точно 7 дни. За да не се разминат седмиците в статистиката/заплатите, въведете начало и край на седмицата, отстоящи точно на 6 дни (напр. понеделник — неделя).`,
          });
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
          // брой поръчки ПО ПЛАТФОРМА, огледално на platform_breakdown за
          // заработката — ВАЖНО: старата логика `existing.source !== r.platform`
          // се чупи след първото обединение на две платформи, защото
          // existing.source става 'bolt+glovo' и вече никога не съвпада с
          // самостоятелно име на платформа, затова ВСЯКО следващо качване
          // (дори поправка на СЪЩАТА вече включена платформа) трупаше
          // existing.order_count върху себе си отгоре — задвоявайки броя
          // поръчки при всеки повторен/коригиран импорт (открит и потвърден
          // бъг при одита). С breakdown по платформа повторен импорт на Glovo
          // просто ПРЕЗАПИСВА своя дял, вместо да се трупа отгоре.
          const orderBreakdown = existing && existing.order_count_breakdown ? { ...existing.order_count_breakdown } : {};
          if (!r.order_count_unknown) orderBreakdown[r.platform] = Number(r.order_count || 0);
          const combinedOrders = Object.values(orderBreakdown).reduce((a, b) => a + Number(b || 0), 0);
          // за НОВ седмичен запис попълваме удръжка/наем на кола по подразбиране
          // от активните договори на служителя (вж. getDefaultPayrollDeductions)
          // — иначе тези колони остават 0 за всеки импортиран запис, докато
          // някой не влезе да ги въведе ръчно за всеки служител всяка седмица.
          // Винаги смятаме defaults на база ТЕКУЩАТА обща заработка (и за
          // Bolt, и за Glovo платформата) — за ПРОЦЕНТНА удръжка това е
          // задължително: ако двете платформи за същата седмица се качат
          // отделно, при добавянето на втората обща заработка се променя и
          // удръжката трябва да се преизчисли на база новата обща сума, а не
          // да остане замръзнала на базата само на първата платформа.
          const defaults = db.getDefaultPayrollDeductions(profile.id, combinedGross);
          const reuseExistingDeduction = existing && existing.deduction_source !== 'percentage';

          const rec = db.upsertPayrollEntry({
            profile_id: profile.id, week_start: weekStart, week_end: weekEnd,
            order_count: combinedOrders,
            gross_earnings: combinedGross,
            deduction_amount: reuseExistingDeduction ? existing.deduction_amount : defaults.deduction_amount,
            deduction_source: reuseExistingDeduction ? existing.deduction_source : defaults.deduction_source,
            deduction_rate: reuseExistingDeduction ? existing.deduction_rate : defaults.deduction_rate,
            car_rent_amount: existing ? existing.car_rent_amount : defaults.car_rent_amount,
            source: sources.length > 1 ? 'bolt+glovo' : r.platform,
            platform_breakdown: otherPlatform,
            order_count_breakdown: orderBreakdown,
            needs_review: !!r.needs_review || (existing ? !!existing.needs_review : false),
            order_count_unknown: !!r.order_count_unknown,
            import_file: archivedFile ? archivedFile.url : (existing ? existing.import_file : null),
            created_by: user.id,
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

    // история на качените Bolt/Glovo файлове за заплати (виж
    // db.listPayrollImportHistory — групира съществуващите payroll_entries по
    // архивирания файл, без нова колекция/миграция)
    if (pathname === '/api/hr/payroll/import/history' && req.method === 'GET') {
      const user = requirePermission(req, res, 'payroll', 'view');
      if (!user) return;
      return sendJson(res, 200, { imports: db.listPayrollImportHistory() });
    }

    // ---- Bolt седмична статистика на шофьорите (активност/поръчки/баланси) --
    // Отделно табло от заплатите — чисто информативно, с тенденции ▲/▼ спрямо
    // предходната седмица за същия шофьор (виж lib/bolt-stats-import.js и
    // db.getBoltStatsWithTrends). Двустъпков поток като при импорта на
    // заплати: .../import/preview (само разчита + съпоставя по телефон) и
    // .../import/apply (действително записва). Файловете НЕ носят седмица в
    // себе си (за разлика от Glovo експортите), затова week_start/week_end се
    // подават изрично от администратора/мениджъра във формата.
    if (pathname === '/api/hr/bolt-stats/import/status' && req.method === 'GET') {
      const user = requirePermission(req, res, 'driver_stats', 'view');
      if (!user) return;
      return sendJson(res, 200, { available: boltStatsImport.isAvailable() });
    }

    function bufFromB64Stats(b64) {
      const buffer = Buffer.from(String(b64 || '').replace(/^data:[^,]*,/, ''), 'base64');
      if (!buffer.length) throw new Error('Празен или невалиден файл');
      return buffer;
    }

    function parseBoltStatsFiles(body) {
      if (!body.orders_file_base64 && !body.activity_file_base64 && !body.earnings_file_base64) {
        throw new Error('Качете поне един от трите файла (поръчки / активност / заработки и баланси).');
      }
      const orders = body.orders_file_base64 ? boltStatsImport.parseOrdersWorkbook(bufFromB64Stats(body.orders_file_base64)) : {};
      const activity = body.activity_file_base64 ? boltStatsImport.parseActivityWorkbook(bufFromB64Stats(body.activity_file_base64)) : {};
      const earnings = body.earnings_file_base64 ? boltStatsImport.parseEarningsBalancesWorkbook(bufFromB64Stats(body.earnings_file_base64)) : {};
      return boltStatsImport.mergeByCourierUid({ orders, activity, earnings });
    }

    function matchDriverByPhoneStats(phone, driverProfiles) {
      if (!phone) return null;
      return driverProfiles.find(p => boltStatsImport.normPhone(p.phone) === phone) || null;
    }

    if (pathname === '/api/hr/bolt-stats/import/preview' && req.method === 'POST') {
      const user = requirePermission(req, res, 'driver_stats', 'manage');
      if (!user) return;
      if (!boltStatsImport.isAvailable()) {
        return sendJson(res, 503, { error: 'Импортът изисква пакета "xlsx", който не е наличен в тази среда.' });
      }
      const body = await readJsonBody(req);
      let records;
      try { records = parseBoltStatsFiles(body); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }

      const driverProfiles = db.listUsers().filter(p => p.role === 'driver');
      const matched = [];
      const unmatched = [];
      records.forEach(r => {
        const profile = matchDriverByPhoneStats(r.phone, driverProfiles);
        const row = { ...r, profile_id: profile ? profile.id : null, profile_name: profile ? profile.full_name : null };
        (profile ? matched : unmatched).push(row);
      });
      return sendJson(res, 200, { matched, unmatched });
    }

    if (pathname === '/api/hr/bolt-stats/import/apply' && req.method === 'POST') {
      const user = requirePermission(req, res, 'driver_stats', 'manage');
      if (!user) return;
      if (!boltStatsImport.isAvailable()) {
        return sendJson(res, 503, { error: 'Импортът изисква пакета "xlsx", който не е наличен в тази среда.' });
      }
      const body = await readJsonBody(req);
      const weekStart = body.week_start;
      const weekEnd = body.week_end;
      if (!weekStart || !weekEnd) {
        return sendJson(res, 400, { error: 'Липсва седмица (начало/край).' });
      }
      const spanDays = Math.round((new Date(weekEnd) - new Date(weekStart)) / 86400000);
      if (spanDays !== 6) {
        return sendJson(res, 400, {
          error: `Периодът ${weekStart} — ${weekEnd} не е точно 7 дни. Въведете начало и край, отстоящи точно на 6 дни (напр. понеделник — неделя).`,
        });
      }
      let records;
      try { records = parseBoltStatsFiles(body); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }

      // архивираме оригиналните файлове (best-effort, не блокира импорта —
      // огледално на bank-statement/payroll импортите по-горе) + пазим
      // запис за историята на качванията (виж db.listBoltStatsImports)
      let ordersFileUrl = null, activityFileUrl = null, earningsFileUrl = null;
      try { if (body.orders_file_base64) ordersFileUrl = saveBase64File(body.orders_file_base64, 'bolt-stats-import-orders', 'xlsx').url; } catch (e) { /* best-effort */ }
      try { if (body.activity_file_base64) activityFileUrl = saveBase64File(body.activity_file_base64, 'bolt-stats-import-activity', 'xlsx').url; } catch (e) { /* best-effort */ }
      try { if (body.earnings_file_base64) earningsFileUrl = saveBase64File(body.earnings_file_base64, 'bolt-stats-import-earnings', 'xlsx').url; } catch (e) { /* best-effort */ }

      const driverProfiles = db.listUsers().filter(p => p.role === 'driver');
      const written = [];
      const unmatched = [];
      for (const r of records) {
        const profile = matchDriverByPhoneStats(r.phone, driverProfiles);
        if (!profile) { unmatched.push(r); continue; }
        const rec = db.upsertBoltWeeklyStat({
          profile_id: profile.id, week_start: weekStart, week_end: weekEnd,
          courier_uid: r.courier_uid, city: r.city,
          orders_proposed: r.orders_proposed, orders_accepted: r.orders_accepted, orders_delivered: r.orders_delivered,
          acceptance_rate: r.acceptance_rate, completion_rate: r.completion_rate,
          online_seconds: r.online_seconds, utilized_seconds: r.utilized_seconds,
          online_hms: r.online_hms, utilized_hms: r.utilized_hms,
          utilization_rate: r.utilization_rate, shift_count: r.shift_count,
          earnings_no_vat: r.earnings_no_vat, waiting_compensation: r.waiting_compensation,
          adjustments: r.adjustments, campaign_bonus: r.campaign_bonus, tips_no_vat: r.tips_no_vat,
          total_earnings_with_tips: r.total_earnings_with_tips,
          cash_received_from_clients: r.cash_received_from_clients, overdue_cash_debt: r.overdue_cash_debt,
          cash_paid_to_providers: r.cash_paid_to_providers,
          balance_before: r.balance_before, balance_after: r.balance_after,
          created_by: user.id,
        });
        written.push(rec.id);
      }
      try {
        db.addBoltStatsImport({
          week_start: weekStart, week_end: weekEnd,
          orders_file_url: ordersFileUrl, activity_file_url: activityFileUrl, earnings_file_url: earningsFileUrl,
          written_count: written.length, unmatched_count: unmatched.length, imported_by: user.id,
        });
      } catch (e) { /* историята е best-effort, не трябва да проваля самия импорт */ }
      return sendJson(res, 200, { written_entries: written.length, unmatched });
    }

    if (pathname === '/api/hr/bolt-stats/import/history' && req.method === 'GET') {
      const user = requirePermission(req, res, 'driver_stats', 'view');
      if (!user) return;
      return sendJson(res, 200, { imports: db.listBoltStatsImports() });
    }

    if (pathname === '/api/hr/bolt-stats' && req.method === 'GET') {
      const user = requirePermission(req, res, 'driver_stats', 'view');
      if (!user) return;
      const result = db.getBoltStatsWithTrends({
        weekStart: query.week_start || null, city: query.city || null, managerId: query.manager_id || null,
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/hr/bolt-stats/weeks' && req.method === 'GET') {
      const user = requirePermission(req, res, 'driver_stats', 'view');
      if (!user) return;
      const all = db.listBoltWeeklyStats();
      const weeksMap = new Map();
      all.forEach(r => { if (!weeksMap.has(r.week_start)) weeksMap.set(r.week_start, r.week_end); });
      const weeks = Array.from(weeksMap.entries())
        .map(([week_start, week_end]) => ({ week_start, week_end }))
        .sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
      return sendJson(res, 200, { weeks });
    }

    const payrollEsignMatch = pathname.match(/^\/api\/hr\/payroll\/([\w-]+)\/esign-events$/);
    if (payrollEsignMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const entry = db.getPayrollEntry(payrollEsignMatch[1]);
      if (!entry) return sendJson(res, 404, { error: 'Записът не е намерен' });
      if (entry.profile_id !== user.id && !isManagerOrAbove(user)) {
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
      if (entry.profile_id !== user.id && !isManagerOrAbove(user)) {
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
        avgKmPerOrder: db.getSettings().avg_km_per_order,
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
      const user = requirePermission(req, res, 'payroll', 'finalize');
      if (!user) return;
      const body = await readJsonBody(req);
      const rec = db.markPayrollPaid(payrollPaidMatch[1], body.paid !== false, user.id);
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
      if (targetId !== user.id && !isManagerOrAbove(user)) {
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
      const user = requirePermission(req, res, 'leave', 'manage_balance');
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
      if (isAdminOrAbove(user)) {
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
      const profileId = (body.profile_id && isManagerOrAbove(user)) ? body.profile_id : user.id;
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
      const user = requirePermission(req, res, 'leave', 'decide');
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
        if (isAdminOrAbove(user)) {
          try {
            const forced = db.decideLeaveRequest(leaveCancelMatch[1], { approve: false, decided_by: user.id, decision_note: 'Отменено от админ' });
            return sendJson(res, 200, { request: forced });
          } catch (err2) { return sendJson(res, 400, { error: err2.message }); }
        }
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- "МОЯТ ЕКИП" — самообслужващ изглед за мениджър при логване -------
    // За разлика от /api/hr/partners/:id (ограничено до role==='manager',
    // списъкът с "партньори" в partners.html), това е по-широк ендпойнт:
    // работи за всеки логнат потребител, показва собствения му екип (виж
    // profiles.manager_id) + собствената му комисионна/твърда заплата, ако
    // има такива — read-only тук нарочно (редакцията на комисионна/заплата
    // остава само през /api/hr/partners и /api/hr/fixed-salaries, admin-only,
    // за да не си редактира мениджърът сам условията). Админ може да разгледа
    // чужд екип през ?target_id=.
    if (pathname === '/api/hr/my-team' && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = query.target_id || user.id;
      if (targetId !== user.id && !isAdminOrAbove(user)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const target = db.findUserById(targetId);
      if (!target) return sendJson(res, 404, { error: 'Служителят не е намерен' });
      const { password: _pw, ...safeTarget } = target;
      return sendJson(res, 200, {
        profile: safeTarget,
        team: db.listTeamProfiles(targetId),
        commission: db.getPartnerCommissionProfile(targetId),
        commission_stats: db.getPartnerStats(targetId, { from: query.from, to: query.to }),
        fixed_salary: db.getFixedSalaryProfile(targetId),
      });
    }

    // ---- ПАРТНЬОРСКИ КОМИСИОННИ (реферални/посреднически партньори) ------
    // Партньор/посредник = ВСЕКИ служител (без значение от ролята му в
    // системата — директор, админ, мениджър, дори шофьор), на когото е
    // зададен комисионен профил тук, с шофьори зачислени към него (виж
    // profiles.manager_id). Преди тази версия списъкът беше ограничен до
    // роля 'manager' и изискваше администраторът първо да сменя ролята на
    // човека в "Потребители и роли" — премахнато по изрична обратна връзка:
    // добавянето на партньор става директно оттук, през търсачка по
    // име/имейл (виж /search по-долу), без допир до ролите. Компенсацията е
    // % или фиксирана сума на период. Статистиката за "пари, донесени на
    // компанията" засега се изчислява от заработката (gross_earnings) в
    // модул Заплати на екипа им — приблизителна демонстрационна база,
    // докато не бъде готов реалният импорт на таблиците с поръчки/приходи
    // (виж db.getPartnerStats).
    if (pathname === '/api/hr/partners' && req.method === 'GET') {
      const user = requirePermission(req, res, 'partners', 'view');
      if (!user) return;
      const configuredIds = new Set(db.listPartnerCommissionProfiles().map(p => p.profile_id));
      const partners = db.listUsers()
        .filter(u => configuredIds.has(u.id))
        .map(u => ({
          id: u.id, full_name: u.full_name, email: u.email, role: u.role, status: u.status,
          commission: db.getPartnerCommissionProfile(u.id),
          team_size: db.listTeamProfiles(u.id).length,
        }));
      return sendJson(res, 200, { partners });
    }
    // търсене на служител за добавяне на нов партньор/комисионна (всеки, не
    // само текущо конфигурираните, и без значение от ролята) — лек списък,
    // без пароли/лични данни. Трябва да е ПРЕДИ /:id регекса по-долу, иначе
    // "search" се прихваща като id.
    if (pathname === '/api/hr/partners/search' && req.method === 'GET') {
      const user = requirePermission(req, res, 'partners', 'view');
      if (!user) return;
      const q = (query.q || '').toLowerCase();
      const results = db.listUsers()
        .filter(u => !q || `${u.full_name} ${u.email}`.toLowerCase().includes(q))
        .slice(0, 20)
        .map(u => ({ id: u.id, full_name: u.full_name, email: u.email, role: u.role, has_commission: !!db.getPartnerCommissionProfile(u.id) }));
      return sendJson(res, 200, { results });
    }

    const partnerMatch = pathname.match(/^\/api\/hr\/partners\/([\w-]+)$/);
    if (partnerMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = partnerMatch[1];
      if (targetId !== user.id && !isAdminOrAbove(user)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const profile = db.findUserById(targetId);
      if (!profile) return sendJson(res, 404, { error: 'Служителят не е намерен' });
      const { password: _pw, ...safeProfile } = profile;
      return sendJson(res, 200, {
        profile: safeProfile,
        commission: db.getPartnerCommissionProfile(targetId),
        team: db.listTeamProfiles(targetId),
      });
    }
    if (partnerMatch && req.method === 'PUT') {
      const user = requirePermission(req, res, 'partners', 'manage');
      if (!user) return;
      const targetId = partnerMatch[1];
      const profile = db.findUserById(targetId);
      if (!profile) return sendJson(res, 404, { error: 'Служителят не е намерен' });
      const body = await readJsonBody(req);
      const allowed = ['comp_type', 'percentage', 'fixed_amount', 'fixed_period', 'comp_base', 'per_driver_amount', 'qualifying_threshold', 'team_qualifying_goal', 'tiers', 'active', 'notes'];
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
      if (targetId !== user.id && !isAdminOrAbove(user)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const stats = db.getPartnerStats(targetId, { from: query.from, to: query.to });
      return sendJson(res, 200, stats);
    }

    // История/маркиране на ПЛАТЕНИ комисионни — за разлика от /stats (което
    // само изчислява "на живо" колко се дължи), тук се пази трайна следа
    // кога/за какъв период/колко точно е платено, и се записва като реален
    // разход в общата каса (виж db.createPartnerCommissionPayment) — заключено
    // само за super_admin, както всяко друго касово движение.
    const partnerCommissionPaymentsMatch = pathname.match(/^\/api\/hr\/partners\/([\w-]+)\/commission-payments$/);
    if (partnerCommissionPaymentsMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = partnerCommissionPaymentsMatch[1];
      if (targetId !== user.id && !isAdminOrAbove(user)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      return sendJson(res, 200, { payments: db.listPartnerCommissionPayments({ profileId: targetId }) });
    }
    if (partnerCommissionPaymentsMatch && req.method === 'POST') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      const targetId = partnerCommissionPaymentsMatch[1];
      const body = await readJsonBody(req);
      try {
        const rec = db.createPartnerCommissionPayment({
          profileId: targetId, periodFrom: body.period_from, periodTo: body.period_to,
          amount: body.amount, note: body.note, createdBy: user.id,
        });
        return sendJson(res, 201, { payment: rec, cashier_balance: db.getCashierBalance(db.getCashierProfileId()) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- ТВЪРДИ ЗАПЛАТИ (офис/ръководен състав — виж lib/db.js за пълния --
    // коментар защо е отделен модул от партньорската комисионна и от
    // шофьорските заплати по брой поръчки). Същия permission модул
    // 'fixed_salaries' като партньорите — само admin вижда/редактира,
    // плащането само super_admin (реално касово движение).
    if (pathname === '/api/hr/fixed-salaries' && req.method === 'GET') {
      const user = requirePermission(req, res, 'fixed_salaries', 'view');
      if (!user) return;
      const salaried = db.listUsers()
        .map(u => ({ id: u.id, full_name: u.full_name, email: u.email, role: u.role, status: u.status, salary: db.getFixedSalaryProfile(u.id) }))
        .filter(u => u.salary); // по подразбиране само вече конфигурираните — добавянето на нов става през търсачката
      return sendJson(res, 200, { salaried });
    }
    // търсене на служител за добавяне на нова твърда заплата (всеки, не само
    // текущо конфигурираните) — лек списък, без пароли/лични данни
    if (pathname === '/api/hr/fixed-salaries/search' && req.method === 'GET') {
      const user = requirePermission(req, res, 'fixed_salaries', 'view');
      if (!user) return;
      const q = (query.q || '').toLowerCase();
      const results = db.listUsers()
        .filter(u => !q || `${u.full_name} ${u.email}`.toLowerCase().includes(q))
        .slice(0, 20)
        .map(u => ({ id: u.id, full_name: u.full_name, email: u.email, role: u.role, has_salary: !!db.getFixedSalaryProfile(u.id) }));
      return sendJson(res, 200, { results });
    }

    const fixedSalaryMatch = pathname.match(/^\/api\/hr\/fixed-salaries\/([\w-]+)$/);
    if (fixedSalaryMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = fixedSalaryMatch[1];
      if (targetId !== user.id && !isAdminOrAbove(user)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const profile = db.findUserById(targetId);
      if (!profile) return sendJson(res, 404, { error: 'Служителят не е намерен' });
      const { password: _pw, ...safeProfile } = profile;
      return sendJson(res, 200, { profile: safeProfile, salary: db.getFixedSalaryProfile(targetId) });
    }
    if (fixedSalaryMatch && req.method === 'PUT') {
      const user = requirePermission(req, res, 'fixed_salaries', 'manage');
      if (!user) return;
      const targetId = fixedSalaryMatch[1];
      const profile = db.findUserById(targetId);
      if (!profile) return sendJson(res, 404, { error: 'Служителят не е намерен' });
      const body = await readJsonBody(req);
      const allowed = ['amount', 'period', 'active', 'notes'];
      const patch = {};
      allowed.forEach(k => { if (k in body) patch[k] = body[k]; });
      const rec = db.setFixedSalaryProfile(targetId, patch);
      return sendJson(res, 200, { salary: rec });
    }

    const fixedSalaryStatsMatch = pathname.match(/^\/api\/hr\/fixed-salaries\/([\w-]+)\/stats$/);
    if (fixedSalaryStatsMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = fixedSalaryStatsMatch[1];
      if (targetId !== user.id && !isAdminOrAbove(user)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      const stats = db.getFixedSalaryStats(targetId, { from: query.from, to: query.to });
      return sendJson(res, 200, stats);
    }

    const fixedSalaryPaymentsMatch = pathname.match(/^\/api\/hr\/fixed-salaries\/([\w-]+)\/payments$/);
    if (fixedSalaryPaymentsMatch && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const targetId = fixedSalaryPaymentsMatch[1];
      if (targetId !== user.id && !isAdminOrAbove(user)) {
        return sendJson(res, 403, { error: 'Нямате права за това действие' });
      }
      return sendJson(res, 200, { payments: db.listFixedSalaryPayments({ profileId: targetId }) });
    }
    if (fixedSalaryPaymentsMatch && req.method === 'POST') {
      const user = requireSuperAdmin(req, res);
      if (!user) return;
      const targetId = fixedSalaryPaymentsMatch[1];
      const body = await readJsonBody(req);
      try {
        const rec = db.createFixedSalaryPayment({
          profileId: targetId, periodFrom: body.period_from, periodTo: body.period_to,
          amount: body.amount, note: body.note, createdBy: user.id,
        });
        return sendJson(res, 201, { payment: rec, cashier_balance: db.getCashierBalance(db.getCashierProfileId()) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
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
        had_glovo_bolt_account: body.had_glovo_bolt_account === 'yes' ? 'yes' : (body.had_glovo_bolt_account === 'no' ? 'no' : null),
        glovo_bolt_platform: body.glovo_bolt_platform ? escapeHtml(String(body.glovo_bolt_platform).slice(0, 100)) : null,
        city: VALID_CITIES.has(body.city) ? body.city : null,
        work_vehicle_type: VALID_WORK_VEHICLES.has(body.work_vehicle_type) ? body.work_vehicle_type : null,
        nationality: VALID_NATIONALITIES.has(body.nationality) ? body.nationality : null,
        nationality_other: body.nationality_other ? escapeHtml(String(body.nationality_other).slice(0, 100)) : null,
        ...photos,
      };
      // Бележките се пипат само ако кандидатът реално е въвел нещо в това
      // изпращане — иначе (празно поле) пазим каквото вече е записано (напр.
      // генерираните от краткия формуляр на маркетинг сайта), вместо да го
      // изтрием безследно с null (виж completeApplicationDetails в lib/db.js:
      // презаписва само ключове, които реално присъстват в patch).
      if (body.notes) patch.notes = escapeHtml(String(body.notes).slice(0, 1000));
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
      const user = requirePermission(req, res, 'applications', 'view');
      if (!user) return;
      let applications = db.listJobApplications({ status: query.status });
      if (user.role === 'manager') applications = applications.filter(a => a.manager_id === user.id);
      return sendJson(res, 200, { applications });
    }
    const applicationMatch = pathname.match(/^\/api\/hr\/applications\/([\w-]+)$/);
    if (applicationMatch && req.method === 'GET') {
      const user = requirePermission(req, res, 'applications', 'view');
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
      const user = requirePermission(req, res, 'applications', 'edit');
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
    // трайно изтрива кандидатура — прилага срока на съхранение (до 6 месеца
    // за неодобрени кандидатури) и правото на изтриване от Политиката за
    // поверителност (viж /privacy.html, т. 8.1 и т. 10). Само админ — това е
    // необратимо изтриване на лични данни (ЕГН, снимки на документи и др.),
    // затова е по-строго от reject/send-link (admin+manager).
    if (applicationMatch && req.method === 'DELETE') {
      const user = requirePermission(req, res, 'applications', 'edit');
      if (!user) return;
      const app = db.getJobApplication(applicationMatch[1]);
      if (!app) return sendJson(res, 404, { error: 'Не е намерена' });
      const removed = db.deleteJobApplication(applicationMatch[1]);
      const photoFields = [
        'id_card_photo_front_url', 'id_card_photo_back_url', 'selfie_photo_url',
        'driver_license_photo_front_url', 'driver_license_photo_back_url',
        'protection_status_photo_url', 'residence_permit_photo_url', 'nap_certificate_photo_url',
      ];
      for (const field of photoFields) {
        const url = removed[field];
        if (url && url.startsWith('/uploads/')) {
          const filePath = path.join(UPLOADS_DIR, url.replace('/uploads/', ''));
          fs.unlink(filePath, () => {}); // best-effort — не блокираме отговора
        }
      }
      return sendJson(res, 200, { deleted: true });
    }
    const applicationApproveMatch = pathname.match(/^\/api\/hr\/applications\/([\w-]+)\/approve$/);
    if (applicationApproveMatch && req.method === 'POST') {
      const user = requirePermission(req, res, 'applications', 'approve');
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
      const user = requirePermission(req, res, 'applications', 'manage');
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
      const user = requirePermission(req, res, 'applications', 'manage');
      if (!user) return;
      const existingApp = db.getJobApplication(applicationSendLinkMatch[1]);
      if (!existingApp) return sendJson(res, 404, { error: 'Не е намерена' });
      if (!canAccessApplication(user, existingApp)) return sendJson(res, 403, { error: 'Нямате права за тази кандидатура' });
      const body = await readJsonBody(req);
      try {
        // назначаването на мениджър от този диалог е позволено само на админ/super_admin —
        // мениджър не може да преназначава кандидатури през send-link
        if (isAdminOrAbove(user) && 'manager_id' in body) {
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
      const user = requirePermission(req, res, 'templates', 'view');
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
      const user = requirePermission(req, res, 'templates', 'manage');
      if (!user) return;
      const body = await readJsonBody(req);
      const patch = { source: 'builtin', content: body.content || '', file_url: null, file_name: null, updated_by: user.id };
      const template = db.setDocumentTemplate(templateMatch[1], patch);
      return sendJson(res, 200, { template });
    }
    const templateUploadMatch = pathname.match(/^\/api\/templates\/(protocol|contract|employment_contract_labor|employment_contract_civil)\/upload$/);
    if (templateUploadMatch && req.method === 'POST') {
      const user = requirePermission(req, res, 'templates', 'manage');
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
    if (templateMatch && req.method === 'DELETE') {
      const user = requirePermission(req, res, 'templates', 'manage');
      if (!user) return;
      const template = db.setDocumentTemplate(templateMatch[1], {
        source: 'builtin', file_url: null, file_name: null, updated_by: user.id,
      });
      return sendJson(res, 200, { template });
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
      const user = requirePermission(req, res, 'esign', 'manage');
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
      const user = requirePermission(req, res, 'esign', 'manage');
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
      const user = requirePermission(req, res, 'esign', 'manage');
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
      const user = requirePermission(req, res, 'stats', 'view');
      if (!user) return;
      return sendJson(res, 200, db.getFleetStats());
    }

    // ---- DASHBOARD (начало) ---------------------------------------------
    if (pathname === '/api/dashboard' && req.method === 'GET') {
      const user = requirePermission(req, res, 'stats', 'view');
      if (!user) return;
      return sendJson(res, 200, db.getDashboardData());
    }

    // ---- ACTIVITY LOG (дневник на активността) ---------------------------
    if (pathname === '/api/activity' && req.method === 'GET') {
      const user = requirePermission(req, res, 'activity_log', 'view');
      if (!user) return;
      const hasFilters = !!(query.from || query.to || query.actor_id || query.city || query.type);
      // без филтри пазим стария по-тесен таван (80) — с филтри вдигаме прага,
      // защото филтрирането се прилага след селекцията и иначе би "скрило"
      // резултати, които реално съществуват, но са извън първите 80 записа
      const limit = hasFilters ? 400 : 80;
      return sendJson(res, 200, { items: db.getActivityFeed(limit, {
        from: query.from || null,
        to: query.to || null,
        actorId: query.actor_id || null,
        city: query.city || null,
        type: query.type || null,
      }) });
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
    const promotedId = db.migrateSuperAdmin();
    if (promotedId) console.log(`Няма супер администратор — акаунт ${promotedId} е повишен автоматично.`);
  } catch (e) {
    console.error('Грешка при миграция на супер администратор:', e.message);
  }

  try {
    const syncedCount = db.syncConfirmedTalonData();
    if (syncedCount) console.log(`Синхронизирани talon_data с основните данни на колата за ${syncedCount} потвърдени талона.`);
  } catch (e) {
    console.error('Грешка при синхронизация на потвърдени талони:', e.message);
  }

  try {
    const ownerFixedCount = db.normalizeAllTalonOwnerNames();
    if (ownerFixedCount) console.log(`Коригирано изкривено AI-разчитане на "собственик (фирма)" в talon_data за ${ownerFixedCount} коли.`);
  } catch (e) {
    console.error('Грешка при нормализация на собственика във talon_data:', e.message);
  }

  try {
    const strayRegExpiryFixedCount = db.cleanupStrayTalonRegistrationExpiry();
    if (strayRegExpiryFixedCount) console.log(`Премахнато погрешно записано поле "следваща регистрация" от основния запис за ${strayRegExpiryFixedCount} коли.`);
  } catch (e) {
    console.error('Грешка при почистване на "следваща регистрация":', e.message);
  }

  try {
    // наемът на кола вече не е касово движение (виж коментара над
    // CASHIER_TX_TYPES в lib/db.js) — почистваме старите автоматични записи
    const obsoleteCarRentTxCount = db.cleanupObsoleteCarRentCashierEntries();
    if (obsoleteCarRentTxCount) console.log(`Премахнати ${obsoleteCarRentTxCount} остарели автоматични записа за "наем на кола" от касата (вече е само статистика).`);
  } catch (e) {
    console.error('Грешка при почистване на остарелите записи за наем в касата:', e.message);
  }

  try {
    backup.scheduleAutoBackups(() => db.readDb());
    console.log(`Автоматични бекъпи: включени (папка ${backup.BACKUPS_DIR}).`);
  } catch (e) {
    console.error('Грешка при стартиране на автоматичните бекъпи:', e.message);
  }

  // Подробен седмичен финансов отчет — "всеки петък", по изрично искане на
  // потребителя (виж коментара над buildDetailedWeeklyFinancialReport в
  // lib/db.js). Периодична проверка (не точен cron в петък в 00:00), защото
  // Render може да приспи/рестартира инстанцията по всяко време — но
  // latestReportableWeekStart() е "самолечебна": независимо КОГА точно се
  // извика (петък, събота, следващия понеделник...), винаги изчислява
  // СЪЩИТЕ дати за последната седмица, чийто разходен период вече е изтекъл,
  // затова е безопасно да се пробва при всеки старт + на всеки 30 минути.
  const WEEKLY_FINANCIAL_REPORT_CHECK_MS = 30 * 60 * 1000;
  function checkAndGenerateWeeklyFinancialReport() {
    try {
      const report = db.ensureLatestWeeklyFinancialReport(null);
      if (report && report.generated_at && (Date.now() - new Date(report.generated_at).getTime()) < 5000) {
        console.log(`Автоматично генериран седмичен финансов отчет за ${report.week_start} — ${report.week_end}.`);
      }
    } catch (e) {
      console.error('Грешка при автоматично генериране на седмичен финансов отчет:', e.message);
    }
  }
  checkAndGenerateWeeklyFinancialReport();
  const weeklyFinancialReportTimer = setInterval(checkAndGenerateWeeklyFinancialReport, WEEKLY_FINANCIAL_REPORT_CHECK_MS);
  weeklyFinancialReportTimer.unref();

  server.listen(PORT, () => {
    console.log(`Dombi Riders backend слуша на http://localhost:${PORT}`);
  });
})();
