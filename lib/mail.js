// ============================================================================
// lib/mail.js — интеграция с фирмената пощенска кутия (office@dombi.bg,
// хоствана в Zoho Mail, EU дата център) директно в админ панела: списък с
// входящи И изпратени писма, преглед на цяло писмо (текст/HTML + прикачени
// файлове), изпращане на ново писмо и отговор в нишка.
//
// Изисква три env променливи в Render (задават се РЪЧНО от собственика на
// бизнеса в Render Dashboard → Environment — тук НЕ се съхраняват пароли):
//   MAIL_USER     — пълният имейл адрес, напр. office@dombi.bg
//   MAIL_PASSWORD — App-Specific Password от Zoho (Account → Security →
//                   App Passwords), НЕ обикновената парола за вход в Zoho.
// Хостовете/портовете на Zoho EU дата център са фиксирани по-долу.
//
// ВАЖНО (Zoho-специфично): SMTP (изпращане) и IMAP (четене) са ДВЕ отделни
// разрешения в Zoho — App-Specific Password важи и за двете, но самият IMAP
// достъп трябва РЪЧНО да е включен за пощенската кутия:
//   Zoho Mail (webmail) → Settings (иконка зъбно колело) → Mail Accounts →
//   office@dombi.bg → секция "IMAP" → отметка "IMAP Access" → Save.
// В същия панел избирате кои папки да се синхронизират през IMAP — уверете
// се, че поне "Inbox" и "Sent"/"Изпратени" са отметнати. Ако това не е
// включено, четенето през тази страница ще връща грешка, докато изпращането
// (SMTP) продължава да работи нормално — точно симптомът, за който е писан
// този коментар.
//
// Пакетите imapflow/nodemailer/mailparser се зареждат "лениво" (при първо
// извикване, с try/catch) — ако инсталацията им се провали по някаква
// причина, останалата част от системата продължава да работи нормално;
// само страницата "Пощенска кутия" ще показва ясна грешка вместо да чупи
// целия сървър при стартиране (виж същия подход при lib/db.js → loadPg()).
// ============================================================================

const IMAP_HOST = 'imappro.zoho.eu';
const IMAP_PORT = 993;
const SMTP_HOST = 'smtppro.zoho.eu';
const SMTP_PORT = 465;

// Zoho не рекламира IMAP SPECIAL-USE атрибути (\Sent/\Drafts/...), затова
// папката "Изпратени" се търси по име — по подразбиране е "Sent" (en) или
// "Изпратени" (bg locale на самата пощенска кутия).
const SENT_FOLDER_PATTERNS = [/^sent$/i, /^sent items$/i, /^изпратени$/i, /sent/i];

function getCredentials() {
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASSWORD;
  if (!user || !pass) {
    const err = new Error('Пощата не е конфигурирана — липсват MAIL_USER/MAIL_PASSWORD в Environment на Render.');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  return { user, pass };
}

function loadImapFlow() {
  try { return require('imapflow').ImapFlow; } catch (e) { return null; }
}
function loadNodemailer() {
  try { return require('nodemailer'); } catch (e) { return null; }
}
function loadMailParser() {
  try { return require('mailparser').simpleParser; } catch (e) { return null; }
}

// imapflow хвърля грешки с общо съобщение ("Command failed") — тук вадим
// по-конкретния текст, който сървърът на Zoho реално е върнал (responseText/
// response), за да е ясно на потребителя КАКВО точно е отказал Zoho (напр.
// "IMAP access is disabled" вместо просто "Command failed").
function describeImapError(err) {
  const detail = err && (err.responseText || err.response || err.reason);
  if (detail && String(detail).trim() && String(detail).trim() !== 'Command failed') {
    return `IMAP грешка от Zoho: ${detail}`;
  }
  if (err && /auth/i.test(err.message || '')) {
    return 'Zoho отказа входа през IMAP (грешен имейл/App-Specific Password, или изтекла парола).';
  }
  return 'Zoho отказа заявката през IMAP. Най-честата причина: IMAP достъпът не е включен за тази пощенска кутия ' +
    '(Zoho Mail → Settings → Mail Accounts → office@dombi.bg → IMAP → отметка "IMAP Access" → Save), ' +
    'или папката Inbox/Sent не е избрана за синхронизация в същия панел.';
}

async function withImapClient(fn) {
  const ImapFlow = loadImapFlow();
  if (!ImapFlow) {
    const err = new Error('Пакетът "imapflow" не е наличен в тази среда.');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  const { user, pass } = getCredentials();
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  try {
    await client.connect();
  } catch (err) {
    const wrapped = new Error(describeImapError(err));
    wrapped.code = 'MAIL_IMAP_ERROR';
    throw wrapped;
  }
  try {
    return await fn(client);
  } catch (err) {
    if (err.code === 'MAIL_NOT_FOUND') throw err;
    const wrapped = new Error(describeImapError(err));
    wrapped.code = 'MAIL_IMAP_ERROR';
    throw wrapped;
  } finally {
    try { await client.logout(); } catch (e) { /* игнорираме грешка при затваряне */ }
  }
}

// открива реалния път на папка "Изпратени" в тази пощенска кутия по име
// (Zoho не поддържа IMAP SPECIAL-USE, затова няма как да разчитаме на флаг)
async function resolveSentFolder(client) {
  const list = await client.list();
  for (const box of list) {
    if (box.specialUse === '\\Sent') return box.path;
  }
  for (const pattern of SENT_FOLDER_PATTERNS) {
    const match = list.find(box => pattern.test(box.name));
    if (match) return match.path;
  }
  return null;
}

// последните `limit` писма от дадена папка, най-новите първи
async function fetchFolderMessages(client, folderPath, limit) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    const total = client.mailbox.exists;
    if (!total) return [];
    const from = Math.max(1, total - limit + 1);
    const messages = [];
    for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, uid: true })) {
      const env = msg.envelope || {};
      const fromAddr = (env.from && env.from[0]) || {};
      const toAddr = (env.to && env.to[0]) || {};
      messages.push({
        uid: msg.uid,
        folder: folderPath,
        from: fromAddr.address || '',
        fromName: fromAddr.name || fromAddr.address || '(непознат подател)',
        to: toAddr.address || toAddr.name || '',
        subject: env.subject || '(без тема)',
        date: env.date ? new Date(env.date).toISOString() : null,
        seen: msg.flags ? msg.flags.has('\\Seen') : false,
      });
    }
    messages.sort((a, b) => (b.uid || 0) - (a.uid || 0));
    return messages;
  } finally {
    lock.release();
  }
}

async function listInbox({ limit = 30 } = {}) {
  return withImapClient(client => fetchFolderMessages(client, 'INBOX', limit));
}

// последните `limit` изпратени писма (Zoho пази копие автоматично при
// изпращане през SMTP — не се налага ръчно записване в тази папка)
async function listSent({ limit = 30 } = {}) {
  return withImapClient(async client => {
    const folder = await resolveSentFolder(client);
    if (!folder) return [];
    return fetchFolderMessages(client, folder, limit);
  });
}

// пълно съдържание на едно писмо по UID в дадена папка (текст/HTML +
// метаданни за прикачени файлове) — маркира го и като прочетено
async function getMessage(uid, folder = 'INBOX') {
  const simpleParser = loadMailParser();
  if (!simpleParser) {
    const err = new Error('Пакетът "mailparser" не е наличен в тази среда.');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  return withImapClient(async client => {
    const lock = await client.getMailboxLock(folder);
    try {
      const full = await client.fetchOne(String(uid), { source: true, uid: true });
      if (!full) {
        const err = new Error('Писмото не е намерено.');
        err.code = 'MAIL_NOT_FOUND';
        throw err;
      }
      const parsed = await simpleParser(full.source);
      try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch (e) { /* не е критично */ }
      return {
        uid,
        folder,
        from: (parsed.from && parsed.from.text) || '',
        to: (parsed.to && parsed.to.text) || '',
        subject: parsed.subject || '(без тема)',
        date: parsed.date ? parsed.date.toISOString() : null,
        text: parsed.text || '',
        html: parsed.html || null,
        messageId: parsed.messageId || null,
        references: parsed.references
          ? (Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references)
          : null,
        attachments: (parsed.attachments || []).map((a, i) => ({
          index: i,
          filename: a.filename || `прикачен-файл-${i + 1}`,
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || (a.content ? a.content.length : 0),
        })),
      };
    } finally {
      lock.release();
    }
  });
}

// съдържанието (Buffer) на конкретен прикачен файл от дадено писмо (в
// дадена папка), за сваляне
async function getAttachment(uid, index, folder = 'INBOX') {
  const simpleParser = loadMailParser();
  if (!simpleParser) {
    const err = new Error('Пакетът "mailparser" не е наличен в тази среда.');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  return withImapClient(async client => {
    const lock = await client.getMailboxLock(folder);
    try {
      const full = await client.fetchOne(String(uid), { source: true, uid: true });
      if (!full) {
        const err = new Error('Писмото не е намерено.');
        err.code = 'MAIL_NOT_FOUND';
        throw err;
      }
      const parsed = await simpleParser(full.source);
      const att = (parsed.attachments || [])[index];
      if (!att) {
        const err = new Error('Прикаченият файл не е намерен.');
        err.code = 'MAIL_NOT_FOUND';
        throw err;
      }
      return { filename: att.filename || `прикачен-файл-${index + 1}`, contentType: att.contentType || 'application/octet-stream', content: att.content };
    } finally {
      lock.release();
    }
  });
}

// изпращане на ново писмо (отговор, ако се подадат inReplyTo/references, или
// препращане, ако се подадат attachments от оригиналното писмо). `to` и `cc`
// приемат по няколко адреса, разделени със запетая или точка и запетая.
async function sendMail({ to, cc, subject, text, inReplyTo, references, attachments }) {
  const nodemailer = loadNodemailer();
  if (!nodemailer) {
    const err = new Error('Пакетът "nodemailer" не е наличен в тази среда.');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  const { user, pass } = getCredentials();
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user, pass },
  });
  const mailOptions = { from: user, to, subject, text };
  if (cc) mailOptions.cc = cc;
  if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
  if (references) mailOptions.references = references;
  if (Array.isArray(attachments) && attachments.length) {
    mailOptions.attachments = attachments.map(a => ({
      filename: a.filename || 'прикачен-файл',
      contentType: a.contentType || undefined,
      content: Buffer.from(a.content, 'base64'),
    }));
  }
  const info = await transporter.sendMail(mailOptions);
  return { messageId: info.messageId };
}

module.exports = { listInbox, listSent, getMessage, getAttachment, sendMail };
