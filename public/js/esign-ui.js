// ============================================================================
// public/js/esign-ui.js — общ панел за изтегляне на бланка (Word/PDF) и
// електронно разписване (присъствено с рисуван подпис / отдалечено по
// имейл), използван от protocol-print.html и contract-print.html.
// ============================================================================

const ESIGN_STATUS_LABELS = {
  none: ['Неподписан', 'badge-muted'],
  signed_in_person: ['Подписан присъствено', 'badge-green'],
  sent_remote: ['Изпратен за отдалечен подпис', 'badge-warn'],
  signed_remote: ['Подписан отдалечено', 'badge-green'],
  declined: ['Отказан подпис', 'badge-danger'],
};

function esignStatusBadge(status) {
  const [label, cls] = ESIGN_STATUS_LABELS[status || 'none'] || [status, 'badge-muted'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function esignDocBase(documentType, documentId) {
  if (documentType === 'protocol') return `/api/protocols/${documentId}`;
  if (documentType === 'employment_contract') return `/api/hr/employment-contracts/${documentId}`;
  return `/api/contracts/${documentId}`;
}

function esignPanelHtml(documentType, documentId, doc) {
  const base = esignDocBase(documentType, documentId);
  const status = doc.signature_status || 'none';
  const signedInfo = (status === 'signed_in_person' || status === 'signed_remote')
    ? `<p class="hint">${doc.signed_by_name || ''} · ${doc.signed_at ? fmtDateTime(doc.signed_at) : ''}</p>` : '';
  return `
    <div class="panel no-print" id="esignPanel">
      <div class="panel-head"><h2>Бланка и електронно разписване</h2><span id="esignStatusBadge">${esignStatusBadge(status)}</span></div>

      <div class="doc-actions" style="margin:0 0 16px;padding:0;">
        <a class="btn btn-ghost btn-sm" href="${base}/docx">⬇ Изтегли Word (.docx)</a>
        <a class="btn btn-ghost btn-sm" href="${base}/pdf">⬇ Изтегли PDF</a>
      </div>
      ${signedInfo}

      <div class="grid-2">
        <div>
          <h3>Присъствено разписване</h3>
          <p class="hint">Подписващият рисува подпис на екрана пред служител. Записва се хеш на документа, IP адрес и час — за одиторска следа.</p>
          <div class="field"><label>Име на подписващия *</label><input id="esignName" placeholder="Име и фамилия"></div>
          <div class="field"><label>Роля</label><input id="esignRole" placeholder="напр. Приел / Наемател"></div>
          <canvas id="esignCanvas" width="320" height="130" style="display:block;border:1px solid var(--line);border-radius:8px;background:#fff;touch-action:none;cursor:crosshair;max-width:100%;"></canvas>
          <div style="margin-top:8px;display:flex;gap:8px;">
            <button type="button" class="btn btn-ghost btn-sm" id="esignClearBtn">Изчисти</button>
            <button type="button" class="btn btn-primary btn-sm" id="esignSubmitBtn">Подпиши присъствено</button>
          </div>
          <div class="hint" id="esignInPersonMsg"></div>
        </div>
        <div>
          <h3>Отдалечено разписване (по имейл)</h3>
          <p class="hint">Изпраща документа за подпис по имейл през доставчик (SignNow). Изисква конфигуриран акаунт на сървъра.</p>
          <div class="field"><label>Имейл на подписващия *</label><input id="esignEmail" type="email" placeholder="name@example.com"></div>
          <div class="field"><label>Име</label><input id="esignRemoteName"></div>
          <button type="button" class="btn btn-primary btn-sm" id="esignSendBtn">Изпрати за подпис</button>
          <div class="hint" id="esignRemoteMsg"></div>
          ${status === 'sent_remote' ? `<button type="button" class="btn btn-ghost btn-sm" id="esignRefreshBtn" style="margin-top:8px;">↻ Провери статус</button>` : ''}
        </div>
      </div>

      <div id="esignHistory" style="margin-top:16px;"></div>
    </div>`;
}

function renderEsignHistory(events) {
  if (!events.length) return '';
  return `
    <h3>История на разписването</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Кога</th><th>Метод</th><th>Подписващ</th><th>Статус</th></tr></thead>
        <tbody>
          ${events.map(e => `
            <tr><td>${fmtDateTime(e.created_at)}</td>
            <td>${e.method === 'in_person' ? 'Присъствено' : 'Отдалечено (' + (e.provider || '—') + ')'}</td>
            <td>${e.signer_name || '—'}${e.signer_role ? ' · ' + e.signer_role : ''}</td>
            <td>${esignStatusBadge(e.status)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function setupSignatureCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#15181f';
  let drawing = false;
  let hasStroke = false;

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const point = e.touches ? e.touches[0] : e;
    return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY };
  }
  function start(e) {
    e.preventDefault();
    drawing = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    hasStroke = true;
  }
  function end() { drawing = false; }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  return {
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); hasStroke = false; },
    hasSignature: () => hasStroke,
    toDataUrl: () => canvas.toDataURL('image/png'),
  };
}

async function bindEsignPanel(documentType, documentId, refreshCallback) {
  const sig = setupSignatureCanvas(document.getElementById('esignCanvas'));

  document.getElementById('esignClearBtn').addEventListener('click', () => sig.clear());

  document.getElementById('esignSubmitBtn').addEventListener('click', async () => {
    const msg = document.getElementById('esignInPersonMsg');
    const name = document.getElementById('esignName').value.trim();
    if (!name) { msg.textContent = 'Въведете име на подписващия.'; return; }
    msg.textContent = 'Записване…';
    try {
      const body = { signer_name: name, signer_role: document.getElementById('esignRole').value.trim() };
      if (sig.hasSignature()) body.signature_image = sig.toDataUrl();
      await Api.post(`/api/esign/${documentType}/${documentId}/in-person`, body);
      if (refreshCallback) await refreshCallback();
      const msgAfter = document.getElementById('esignInPersonMsg');
      if (msgAfter) msgAfter.textContent = 'Подписано успешно.';
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  document.getElementById('esignSendBtn').addEventListener('click', async () => {
    const msg = document.getElementById('esignRemoteMsg');
    const email = document.getElementById('esignEmail').value.trim();
    if (!email) { msg.textContent = 'Въведете имейл на подписващия.'; return; }
    msg.textContent = 'Изпращане…';
    try {
      const result = await Api.post(`/api/esign/${documentType}/${documentId}/remote/send`, {
        signer_email: email, signer_name: document.getElementById('esignRemoteName').value.trim(),
      });
      if (result.warning) {
        msg.textContent = result.warning;
      } else {
        if (refreshCallback) await refreshCallback();
        const msgAfter = document.getElementById('esignRemoteMsg');
        if (msgAfter) msgAfter.textContent = 'Изпратено за подпис.';
      }
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  const refreshBtn = document.getElementById('esignRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      const result = await Api.post(`/api/esign/${documentType}/${documentId}/remote/refresh`, {});
      if (result.warning) alert(result.warning);
      if (refreshCallback) await refreshCallback();
    } catch (err) {
      alert(err.message);
    } finally {
      refreshBtn.disabled = false;
    }
  });

  try {
    const { events } = await Api.get(`/api/esign/${documentType}/${documentId}`);
    document.getElementById('esignHistory').innerHTML = renderEsignHistory(events);
  } catch (e) { /* незадължително */ }
}
