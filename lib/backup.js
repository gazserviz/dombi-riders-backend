// ============================================================================
// lib/backup.js — автоматични резервни копия на базата данни (kv_store в
// Supabase / локалния data/db.json), записвани като JSON файлове на диска.
//
// ВАЖНО: докато Render инстанцията НЯМА постоянен диск (Persistent Disk),
// файловете тук се пазят на СЪЩОТО ефимерно място като data/uploads — тоест
// се губят при redeploy/рестарт на контейнера, точно като снимките на
// документите. Истинска защита от загуба на данни има едва след като се
// закачи платен Render диск, монтиран върху DATA_DIR (виж по-долу).
//
// Как работи:
//  - веднъж на BACKUP_INTERVAL_HOURS часа (по подразбиране 24) се записва
//    пълен снимок на цялата база (readDb()) като нов JSON файл в
//    DATA_DIR/backups/.
//  - при всеки старт на сървъра (redeploy/рестарт) се прави и допълнителен
//    "boot" бекъп — полезно е, ако някой рестарт се случи преди редовния
//    24-часов цикъл.
//  - пазят се последните BACKUP_RETENTION бройки (по подразбиране 30) —
//    по-старите се трият автоматично, за да не расте дискът неограничено.
//  - админ може ръчно да пусне бекъп, да свали произволен бекъп или да
//    възстанови базата от него (виж routes в server.js и public/backups.html).
// ============================================================================
const fs = require('fs');
const path = require('path');

// DATA_DIR е коренът на всичко, което трябва да оцелее при redeploy — снимки
// (uploads/) и резервни копия (backups/). По подразбиране е локалната папка
// data/ до кода (текущото поведение, ефимерно на Render free tier). Когато
// се закачи Render Persistent Disk, задайте env променлива DATA_DIR с точния
// Mount Path на диска (напр. /var/data) — тогава автоматично и снимките
// (виж UPLOADS_DIR в server.js), и бекъпите ще се пазят на постоянния диск.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = parseInt(process.env.BACKUP_RETENTION, 10) || 30;
const BACKUP_INTERVAL_MS = (parseInt(process.env.BACKUP_INTERVAL_HOURS, 10) || 24) * 60 * 60 * 1000;

const FILENAME_RE = /^backup-[\d-]+T[\d-]+Z-(boot|scheduled|manual|pre-restore)\.json$/;

function ensureDir() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function timestampSlug(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-'); // безопасно за файлово име (без ':' и '.')
}

function writeBackup(db, { reason = 'scheduled' } = {}) {
  ensureDir();
  const filename = `backup-${timestampSlug()}-${reason}.json`;
  const payload = {
    created_at: new Date().toISOString(),
    reason,
    meta: {
      profiles: (db.profiles || []).length,
      payroll_entries: (db.payroll_entries || []).length,
      vehicles: (db.vehicles || []).length,
      job_applications: (db.job_applications || []).length,
    },
    data: db,
  };
  fs.writeFileSync(path.join(BACKUPS_DIR, filename), JSON.stringify(payload), 'utf-8');
  pruneOldBackups();
  return filename;
}

function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUPS_DIR)
    .filter(f => FILENAME_RE.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(BACKUPS_DIR, f), 'utf-8')).meta; } catch (e) { /* ignore */ }
      return { filename: f, size: stat.size, mtime: stat.mtime.toISOString(), meta };
    })
    .sort((a, b) => b.filename.localeCompare(a.filename)); // най-новите първи (ISO timestamp в името)
}

function pruneOldBackups() {
  const files = listBackups();
  if (files.length <= MAX_BACKUPS) return;
  files.slice(MAX_BACKUPS).forEach(f => {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, f.filename)); } catch (e) { /* ignore */ }
  });
}

// name е вече проверено през FILENAME_RE (виж routes) — не позволяваме
// произволен път, само точно този формат на име, генериран от writeBackup.
function readBackupFile(filename) {
  if (!FILENAME_RE.test(filename)) throw new Error('Невалидно име на бекъп файл');
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) throw new Error('Бекъпът не е намерен');
  return fs.readFileSync(filePath, 'utf-8');
}

function scheduleAutoBackups(getDb) {
  ensureDir();
  try { writeBackup(getDb(), { reason: 'boot' }); } catch (e) { console.error('Грешка при стартов бекъп:', e.message); }
  const timer = setInterval(() => {
    try { writeBackup(getDb(), { reason: 'scheduled' }); } catch (e) { console.error('Грешка при автоматичен бекъп:', e.message); }
  }, BACKUP_INTERVAL_MS);
  timer.unref(); // не пречи на процеса да спре нормално (напр. при тестове)
}

module.exports = {
  DATA_DIR, BACKUPS_DIR, FILENAME_RE,
  writeBackup, listBackups, pruneOldBackups, readBackupFile, scheduleAutoBackups,
};
