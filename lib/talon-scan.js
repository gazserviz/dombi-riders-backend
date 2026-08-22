// ============================================================================
// lib/talon-scan.js — разчитане на данни от снимки чрез AI (Claude Vision):
// талон (свидетелство за регистрация на МПС), лична карта, шофьорска книжка.
//
// Изисква променлива на средата ANTHROPIC_API_KEY (задава се в Render → Environment).
// Без зададен ключ връща ясна грешка, а не измислени данни.
// ============================================================================

const https = require('https');

const TALON_PROMPT = `Ти получаваш снимка на български СВИДЕТЕЛСТВО ЗА РЕГИСТРАЦИЯ НА МПС (талон),
част I и/или част II. Извлечи следните полета, ако се виждат на снимката, и върни
СТРОГО валиден JSON обект (без markdown, без обяснения) с точно следните ключове:

{
  "plate_number": "регистрационен номер, напр. CA1234HK",
  "vin": "рама / VIN номер",
  "make": "марка",
  "model": "модел",
  "year": "година на първа регистрация (само число)",
  "color": "цвят",
  "fuel": "тип гориво: petrol | diesel | hybrid | electric | lpg",
  "engine_capacity_cc": "обем на двигателя в куб.см (само число)",
  "power_kw": "мощност в kW (само число)",
  "seats": "брой места (само число)",
  "owner_name": "собственик, ако е видим",
  "registration_expiry": "дата на следваща регистрация/талон, ако е видима, формат YYYY-MM-DD"
}

Ако дадено поле не се чете ясно от снимката, остави стойността null. Не измисляй данни.
Върни САМО JSON обекта, нищо друго.`;

const ID_CARD_PROMPT = `Ти получаваш снимка на българска ЛИЧНА КАРТА (документ за самоличност).
Извлечи следните полета, ако се виждат на снимката, и върни СТРОГО валиден JSON обект
(без markdown, без обяснения) с точно следните ключове:

{
  "full_name": "три имена на притежателя, както са изписани на кирилица",
  "egn": "ЕГН (10 цифри)",
  "id_card_number": "номер на личната карта",
  "address": "постоянен адрес, ако е видим",
  "id_card_expiry": "дата на валидност (изтича на), формат YYYY-MM-DD"
}

Ако дадено поле не се чете ясно от снимката, остави стойността null. Не измисляй данни.
Върни САМО JSON обекта, нищо друго.`;

const DRIVER_LICENSE_PROMPT = `Ти получаваш снимка на българска СВИДЕТЕЛСТВО ЗА УПРАВЛЕНИЕ НА МПС
(шофьорска книжка). Извлечи следните полета, ако се виждат на снимката, и върни
СТРОГО валиден JSON обект (без markdown, без обяснения) с точно следните ключове:

{
  "full_name": "три имена на притежателя, както са изписани на кирилица",
  "driver_license_number": "номер на книжката",
  "categories": "категории, напр. B, BE",
  "driver_license_expiry": "дата на валидност (изтича на), формат YYYY-MM-DD"
}

Ако дадено поле не се чете ясно от снимката, остави стойността null. Не измисляй данни.
Върни САМО JSON обекта, нищо друго.`;

function callClaudeVisionWithPrompt(base64Image, mimeType, promptText) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reject(new Error('NO_API_KEY'));
      return;
    }

    const payload = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
            { type: 'text', text: promptText },
          ],
        },
      ],
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(payload),
        },
      },
      res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Anthropic API грешка ${res.statusCode}: ${body.slice(0, 300)}`));
            return;
          }
          try {
            const json = JSON.parse(body);
            const text = json.content?.[0]?.text || '{}';
            const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '');
            resolve(JSON.parse(cleaned));
          } catch (err) {
            reject(new Error('Неуспешно разчитане на отговора от AI: ' + err.message));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// талон (запазено за съвместимост с автопарк модула)
function callClaudeVision(base64Image, mimeType) {
  return callClaudeVisionWithPrompt(base64Image, mimeType, TALON_PROMPT);
}

// лична карта — за досието на служителя и формата за самокандидатстване
function scanIdCard(base64Image, mimeType) {
  return callClaudeVisionWithPrompt(base64Image, mimeType, ID_CARD_PROMPT);
}

// шофьорска книжка — за досието на служителя и формата за самокандидатстване
function scanDriverLicense(base64Image, mimeType) {
  return callClaudeVisionWithPrompt(base64Image, mimeType, DRIVER_LICENSE_PROMPT);
}

module.exports = { callClaudeVision, scanIdCard, scanDriverLicense };
