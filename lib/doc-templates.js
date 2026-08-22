// ============================================================================
// lib/doc-templates.js — Tier 2: качване на ГОТОВ .docx шаблон (изготвен от
// потребителя, напр. в Word) и попълването му с данни чрез {{токени}}, вместо
// вградения (builtin) генератор в lib/doc-builder.js.
//
// Използва пакетите `docxtemplater` + `pizzip`, добавени в package.json.
//
// ⚠️ ВАЖНО: тези два пакета НЕ могат да бъдат инсталирани/тествани в средата,
// в която е разработена тази система (npm registry е недостъпен там) — затова
// се зареждат "лениво" (require вътре във функция, с try/catch). Ако липсват,
// функциите тук връщат ясна грешка (MODULE_NOT_AVAILABLE), вместо да съборят
// сървъра или да се престорят на успешни. При реален деплой (Render и т.н.)
// `npm install` ще ги свали истински от package.json — но е ЗАДЪЛЖИТЕЛНО да
// се направи поне един реален тест с качен .docx шаблон, преди да се разчита
// на този път в продукция. До момента на такъв тест — третирайте пътя
// "качен Word шаблон" като experimental spatial и предпочитайте вградените
// протокол/договор бланки (lib/doc-builder.js), които СА тествани.
// ============================================================================

function loadLibs() {
  try {
    const PizZip = require('pizzip');
    const Docxtemplater = require('docxtemplater');
    return { PizZip, Docxtemplater };
  } catch (e) {
    return null;
  }
}

function isAvailable() {
  return !!loadLibs();
}

// data: плосък обект { plate_number: '...', driver_name: '...', ... } —
// токените в .docx шаблона трябва да са във вид {{plate_number}}.
function fillDocxTemplate(templateBuffer, data) {
  const libs = loadLibs();
  if (!libs) {
    const err = new Error('Пакетите docxtemplater/pizzip не са налични в тази среда.');
    err.code = 'MODULE_NOT_AVAILABLE';
    throw err;
  }
  const { PizZip, Docxtemplater } = libs;
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
  });
  try {
    doc.render(data);
  } catch (renderErr) {
    const details = renderErr.properties && renderErr.properties.errors
      ? renderErr.properties.errors.map(e => e.message).join('; ')
      : renderErr.message;
    const err = new Error('Грешка при попълване на шаблона: ' + details);
    err.code = 'RENDER_ERROR';
    throw err;
  }
  return doc.getZip().generate({ type: 'nodebuffer' });
}

module.exports = { isAvailable, fillDocxTemplate };
