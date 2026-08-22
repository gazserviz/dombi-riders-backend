// ============================================================================
// lib/docx-to-pdf.js — по избор, ПО-ДОБРО качество PDF: конвертира вече
// готов .docx буфер (от lib/doc-builder.js ИЛИ от качен Word шаблон през
// lib/doc-templates.js) в истински PDF с векторен, селектируем текст, чрез
// LibreOffice (`soffice --headless --convert-to pdf`), ако е инсталиран на
// сървъра.
//
// Това НЕ Е гарантирано наличен път при деплой (LibreOffice е тежка system
// зависимост — само 'npm install' не я слага; на Render трябва изрично да се
// добави чрез Docker базиран деплой с `apt-get install libreoffice`).
// Затова целият модул е "best effort": проверява дали `soffice` съществува,
// и ако не — хвърля ясна грешка (SOFFICE_NOT_AVAILABLE), а извикващият код
// пада обратно към lib/pdf-builder.js (растеризиран PDF чрез pdf-lib+sharp,
// който Е тестван и работи без никакви system зависимости).
//
// ТЕСТВАНО в средата за разработка (soffice е наличен ТУК) — реален .docx е
// конвертиран в PDF за ~2 секунди, с коректна кирилица (проверено визуално).
// Не е потвърдено дали ще е наличен и в реалната продукционна среда.
// ============================================================================

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let sofficeChecked = false;
let sofficeAvailable = false;

function checkSoffice() {
  return new Promise(resolve => {
    if (sofficeChecked) return resolve(sofficeAvailable);
    execFile('soffice', ['--version'], { timeout: 5000 }, (err) => {
      sofficeChecked = true;
      sofficeAvailable = !err;
      resolve(sofficeAvailable);
    });
  });
}

async function convertDocxToPdf(docxBuffer) {
  const available = await checkSoffice();
  if (!available) {
    const err = new Error('LibreOffice (soffice) не е наличен на този сървър.');
    err.code = 'SOFFICE_NOT_AVAILABLE';
    throw err;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dombi-pdf-'));
  const inputPath = path.join(tmpDir, `doc-${crypto.randomBytes(4).toString('hex')}.docx`);
  fs.writeFileSync(inputPath, docxBuffer);

  return new Promise((resolve, reject) => {
    execFile(
      'soffice',
      ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmpDir, inputPath],
      { timeout: 30000 },
      (err) => {
        if (err) {
          cleanup();
          const e = new Error('Грешка при конвертиране в PDF: ' + err.message);
          e.code = 'CONVERT_FAILED';
          return reject(e);
        }
        const outPath = inputPath.replace(/\.docx$/, '.pdf');
        if (!fs.existsSync(outPath)) {
          cleanup();
          const e = new Error('LibreOffice не създаде изходен PDF файл.');
          e.code = 'CONVERT_FAILED';
          return reject(e);
        }
        const pdfBuffer = fs.readFileSync(outPath);
        cleanup();
        resolve(pdfBuffer);
      }
    );
    function cleanup() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  });
}

module.exports = { convertDocxToPdf, checkSoffice };
