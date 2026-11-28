function getDefaultApiBase() {
  if (
    typeof window !== 'undefined' &&
    window.location &&
    (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')
  ) {
    return 'http://127.0.0.1:8787';
  }
  return 'https://wacrm-api.awais-wacrm-2026.workers.dev';
}

const state = {
  apiBase:
    (typeof localStorage !== 'undefined' ? localStorage.getItem('wacrm_api_base') : null) ||
    getDefaultApiBase(),
  token: typeof localStorage !== 'undefined' ? localStorage.getItem('wacrm_bearer_token') || '' : '',
  activeView: (typeof localStorage !== 'undefined' ? localStorage.getItem('wacrm_active_view') : null) || 'overview',
  activeConversationId:
    (typeof localStorage !== 'undefined' ? localStorage.getItem('wacrm_active_conv_id') : null) || null,
  activeQrAccountId:
    (typeof localStorage !== 'undefined' ? localStorage.getItem('wacrm_active_qr_acc_id') : null) || null,
  activeWaAccountId:
    (typeof localStorage !== 'undefined' ? localStorage.getItem('wacrm_active_wa_acc_id') : null) || null,
  organization: null,
  organizations: [],
  user: null,
  role: 'agent',
  accounts: [],
  contacts: [],
  lists: [],
  tags: [],
  templates: [],
  campaigns: [],
  conversations: [],
  knowledgeDocs: [],
  teamMembers: [],
  teamInvites: [],
  rolesData: null,
  subscriptionData: null,
  auditLogs: [],
  aiAgent: null,
  workersAiConfigured: false,
  geminiConfigured: false,
  statusInfo: null,
  qrSession: null,
  qrPollTimer: null,
  qrCountdownTimer: null,
  pendingImportContacts: [],
  lastReport: null,
  convFilter: 'all',
  convSearch: '',
  conversationMetrics: null,
  activeConversation: null,
  assignmentHistory: [],
  scheduledMessages: [],
  waStatuses: [],
  businessAnalytics: null,
  aiRecommendations: []
};

export function setActiveView(viewName) {
  if (!viewName) viewName = 'overview';
  state.activeView = viewName;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('wacrm_active_view', viewName);
  }
  document.querySelectorAll('.nav-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === viewName);
  });
  document.querySelectorAll('.view-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `view-${viewName}`);
  });
}

export function formatConversationStatusBadge(conv) {
  if (!conv) return '<span class="badge-tag">--</span>';
  const hs = conv.handlingStatus || 'unassigned';
  const hm = conv.handlerMode || 'human';
  const at = conv.assignmentType || 'unassigned';

  if (hs === 'needs_attention') {
    return '<span class="badge-tag" style="background:#c53030;color:#fff;">⚠️ Needs Attention</span>';
  }
  if (hs === 'ai_handling' || at === 'ai' || hm === 'ai_bot') {
    return '<span class="badge-tag" style="background:#2b6cb0;color:#fff;">🤖 AI Handling</span>';
  }
  if (hs === 'assigned_owner' || at === 'owner') {
    return '<span class="badge-tag" style="background:#6b46c1;color:#fff;">👑 Owner Assigned</span>';
  }
  if (hs === 'assigned_team' || at === 'team_member') {
    const name = conv.assignedUserName ? `👤 ${conv.assignedUserName}` : '👤 Team Member';
    return `<span class="badge-tag" style="background:#285e61;color:#fff;">${escapeHtml(name)}</span>`;
  }
  if (hs === 'human_handling') {
    return '<span class="badge-tag" style="background:#2c7a7b;color:#fff;">👤 Human Handling</span>';
  }
  if (hs === 'waiting_customer') {
    return '<span class="badge-tag" style="background:#744210;color:#fefcbf;">⏳ Waiting for Customer</span>';
  }
  if (hs === 'resolved' || conv.status === 'resolved') {
    return '<span class="badge-tag" style="background:#22543d;color:#9ae6b4;">✓ Resolved</span>';
  }
  return '<span class="badge-tag" style="background:#4a5568;color:#cbd5e0;">Unassigned</span>';
}

export function formatQrStatusLabel(status) {
  switch (status) {
    case 'connecting':
      return 'Connecting';
    case 'waiting_for_scan':
      return 'Waiting for Scan';
    case 'connected':
      return 'Connected';
    case 'expired':
      return 'Expired';
    case 'error':
      return 'Error';
    default:
      return 'Disconnected';
  }
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });
}

export function sanitizeCsvCell(value) {
  const str = String(value == null ? '' : value);
  const safe = /^\s*[=+\-@\t\r\n]/.test(str) ? `'${str}` : str;
  return `"${safe.replace(/"/g, '""')}"`;
}

function showBanner(msg, isError = false) {
  const el = document.getElementById('global-banner');
  if (!el) return;
  if (!msg) {
    el.style.display = 'none';
    return;
  }
  el.textContent = msg;
  el.className = isError ? 'banner error' : 'banner';
  el.style.display = 'block';
}

function getEffectiveApiBase() {
  const envSel = document.getElementById('select-api-env');
  if (envSel && envSel.value && envSel.value !== 'custom') {
    return envSel.value.replace(/\/+$/, '');
  }
  const inputApi = document.getElementById('input-api-base');
  if (inputApi && inputApi.value.trim()) {
    return inputApi.value.trim().replace(/\/+$/, '');
  }
  return (state.apiBase || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

async function apiFetch(path, options = {}) {
  const base = getEffectiveApiBase();
  const headers = { ...(options.headers || {}) };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${base}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Request failed (${res.status})`);
  }
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      resolve(btoa(bin));
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}

function renderAllViews() {
  const sub = state.subscriptionData;
  document.getElementById('plan-badge').textContent = (sub?.plan?.displayName || 'SAAS').toUpperCase();
  document.getElementById('stat-contacts-count').textContent = String(sub?.usage?.contactsCount ?? state.contacts.length);
  document.getElementById('stat-campaigns-count').textContent = String(sub?.usage?.campaignsCount ?? state.campaigns.length);
  document.getElementById('stat-monthly-msgs').textContent = String(sub?.usage?.monthlyOutboundMessages ?? 0);
  document.getElementById('stat-ai-replies').textContent = String(sub?.usage?.todayAiReplies ?? 0);
  document.getElementById('stat-ai-status').textContent = state.workersAiConfigured
    ? `Workers AI Bound Â· ${state.aiAgent?.isEnabled ? 'Enabled' : 'Disabled'}`
    : 'Workers AI Binding Not Configured';

  const healthBox = document.getElementById('overview-health');
  if (healthBox) {
    healthBox.textContent = JSON.stringify(
      {
        organization: state.organization?.name,
        plan: sub?.plan?.tier,
        role: state.role,
        metaConnectedAccounts: state.accounts.length,
        apiStatus: state.statusInfo
      },
      null,
      2
    );
  }

  const orgSel = document.getElementById('select-active-org');
  if (orgSel) {
    orgSel.innerHTML =
      state.organizations
        .map(
          (o) =>
            `<option value="${escapeHtml(o.organizationId)}" ${o.organizationId === state.organization?.id ? 'selected' : ''}>${escapeHtml(o.name)} (${escapeHtml(o.role)})</option>`
        )
        .join('') || '<option value="">No workspace</option>';
  }

  const webhookPreview = document.getElementById('webhook-callback-preview');
  if (webhookPreview) webhookPreview.textContent = `${state.apiBase.replace(/\/+$/, '')}/webhooks/meta`;

  const accOpts = state.accounts
    .map((a) => {
      const isSel = (state.activeWaAccountId && a.id === state.activeWaAccountId) || (!state.activeWaAccountId && a.isDefault);
      return `<option value="${escapeHtml(a.id)}" ${isSel ? 'selected' : ''}>${escapeHtml(a.label)} (${escapeHtml(a.phoneNumber || a.maskedPhoneNumberId || a.providerType)})</option>`;
    })
    .join('');
  for (const id of ['camp-account-id', 'reply-account-id', 'composer-wa-account', 'status-account-id']) {
    const sel = document.getElementById(id);
    if (sel) {
      sel.innerHTML = accOpts || '<option value="">Connect WhatsApp account first</option>';
      if (state.activeWaAccountId && state.accounts.some((a) => a.id === state.activeWaAccountId)) {
        sel.value = state.activeWaAccountId;
      }
    }
  }
  const tplAcc = document.getElementById('tpl-account-id');
  if (tplAcc) tplAcc.innerHTML = '<option value="">Any / Local Template</option>' + accOpts;

  const listSel = document.getElementById('camp-list-id');
  const compListSel = document.getElementById('composer-list-select');
  const listOptions =
    state.lists.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)} (${Number(l.memberCount ?? 0)})</option>`).join('') ||
    '<option value="">Create Contact List first</option>';
  if (listSel) listSel.innerHTML = listOptions;
  if (compListSel) compListSel.innerHTML = '<option value="">Select a contact list...</option>' + listOptions;

  const compContactSel = document.getElementById('composer-contact-select');
  if (compContactSel) {
    compContactSel.innerHTML =
      '<option value="">Select a contact...</option>' +
      state.contacts
        .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.phone)})</option>`)
        .join('');
  }

  const tplOpts = state.templates
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)} [${escapeHtml(t.approvalStatus)}]</option>`)
    .join('');
  document.getElementById('camp-template-id').innerHTML = '<option value="">None (24h Window Custom Text)</option>' + tplOpts;
  document.getElementById('reply-template-id').innerHTML = '<option value="">Free-Form Text (24h Window)</option>' + tplOpts;
  document.getElementById('report-campaign-select').innerHTML =
    state.campaigns.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.status)})</option>`).join('') ||
    '<option value="">No campaigns</option>';

  renderAccounts();
  renderContacts();
  renderListsAndTags();
  renderTemplates();
  renderCampaigns();
  renderConversations();
  renderAiAndKnowledge();
  renderTeamAndRoles();
  renderSubscriptionAndSettings();
  renderScheduledMessages();
  renderWaStatuses();
  renderBusinessAi();
}

function renderSignedOutState() {
  const sessionBar = document.getElementById('session-active-bar');
  const devLoginPanel = document.getElementById('dev-login-panel');
  if (sessionBar) sessionBar.style.display = 'none';
  if (devLoginPanel) devLoginPanel.style.display = 'flex';
  const label = document.getElementById('api-status-label');
  if (label) label.textContent = 'Not Signed In';
  const dot = document.getElementById('api-dot');
  if (dot) dot.classList.remove('online');
}

function renderScheduledMessages() {
  const el = document.getElementById('scheduled-messages-list');
  if (!el) return;
  el.innerHTML = state.scheduledMessages.length
    ? state.scheduledMessages
        .map(
          (m) => `
        <div class="item-row" style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:6px; border:1px solid rgba(255,255,255,0.08); border-radius:6px;">
          <div style="flex:1; min-width:0; padding-right:8px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <strong>${escapeHtml(m.recipientTarget || (m.recipientPhones || []).join(', ') || 'Recipient')}</strong>
              <span class="badge-tag">${escapeHtml(m.status)}</span>
              <span class="muted-note" style="font-size:11px;">⏰ ${new Date(m.scheduledAt).toLocaleString()}</span>
            </div>
            <div class="muted-note" style="font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;">
              ${escapeHtml(m.messageText || m.mediaUrl || 'Template message')}
            </div>
          </div>
          <div>
            ${m.status === 'pending' ? `<button class="btn-danger-sm" data-action="cancel-scheduled" data-id="${escapeHtml(m.id)}" style="padding:4px 8px; font-size:11px;">Cancel</button>` : ''}
          </div>
        </div>`
        )
        .join('')
    : '<div class="muted-note">No scheduled messages queued.</div>';
}

function renderWaStatuses() {
  const el = document.getElementById('wa-statuses-list');
  if (!el) return;
  el.innerHTML = state.waStatuses.length
    ? state.waStatuses
        .map(
          (s) => `
        <div class="item-row" style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; margin-bottom:6px; border:1px solid rgba(255,255,255,0.08); border-radius:6px;">
          <div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="badge-tag">${escapeHtml(s.contentType)}</span>
              <span class="muted-note" style="font-size:11px;">${new Date(s.createdAt).toLocaleString()}</span>
            </div>
            <div style="font-size:13px; margin-top:4px;">${escapeHtml(s.contentText || s.mediaCaption || '-')}</div>
            ${s.mediaUrl ? `<div class="muted-note" style="font-size:11px;">Media: <a href="${escapeHtml(s.mediaUrl)}" target="_blank" rel="noopener">${escapeHtml(s.mediaUrl)}</a></div>` : ''}
          </div>
          <button class="btn-danger-sm" data-action="delete-status" data-id="${escapeHtml(s.id)}" style="padding:4px 8px; font-size:11px;">Delete</button>
        </div>`
        )
        .join('')
    : '<div class="muted-note">No status updates published yet.</div>';
}

function renderBusinessAi() {
  const o = state.businessAnalytics;
  if (o) {
    const elConv = document.getElementById('stat-ai-conv-rate');
    if (elConv) elConv.textContent = `${Number(o.conversionRate || 0).toFixed(1)}%`;
    const elHigh = document.getElementById('stat-ai-high-intent');
    if (elHigh) elHigh.textContent = String(o.highIntentLeadsCount ?? 0);
    const elPricing = document.getElementById('stat-ai-pricing-queries');
    if (elPricing) elPricing.textContent = String(o.pricingQueriesCount ?? 0);
    const elCsat = document.getElementById('stat-ai-csat');
    if (elCsat) elCsat.textContent = `${Number(o.positiveSentimentRatio || 95).toFixed(0)}%`;
  }

  const reportBox = document.getElementById('business-ai-report-box');
  if (reportBox && state.aiRecommendations) {
    if (state.aiRecommendations.length > 0) {
      reportBox.innerHTML = `
        <h4 style="margin:0 0 10px 0; color:#48bb78; font-size:14px;">Active Gemini Strategic Recommendations &amp; Lead Alerts</h4>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${state.aiRecommendations
            .map(
              (r) => `
            <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:10px 12px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong>${escapeHtml(r.title || r.type)}</strong>
                <span class="badge-tag" style="background:${r.priority === 'high' ? '#e53e3e' : '#3182ce'}; color:#fff; font-size:10px; padding:1px 6px;">${escapeHtml(r.priority || 'normal')}</span>
              </div>
              <div style="font-size:12px; margin-top:4px; color:#cbd5e0;">${escapeHtml(r.description || '')}</div>
              ${r.actionPayload ? `<div style="font-size:11px; margin-top:4px; color:#ecc94b;">💡 Action: ${escapeHtml(typeof r.actionPayload === 'string' ? r.actionPayload : JSON.stringify(r.actionPayload))}</div>` : ''}
            </div>`
            )
            .join('')}
        </div>
      `;
    }
  }
}

function stopQrTimers() {
  if (state.qrPollTimer) {
    clearInterval(state.qrPollTimer);
    state.qrPollTimer = null;
  }
  if (state.qrCountdownTimer) {
    clearInterval(state.qrCountdownTimer);
    state.qrCountdownTimer = null;
  }
}

function updateQrCountdownDisplay() {
  const el = document.getElementById('qr-countdown-label');
  if (!el) return;
  const s = state.qrSession;
  if (!s || s.status !== 'waiting_for_scan' || !s.qrExpiresAt) {
    el.textContent = s?.status === 'connected' ? 'Authenticated' : 'Countdown: --';
    return;
  }
  const remainingSec = Math.max(0, Math.ceil((s.qrExpiresAt - Date.now()) / 1000));
  el.textContent = remainingSec > 0 ? `Expires in ${remainingSec}s` : 'Expired';
}

function renderQrSessionPanel() {
  const qrAccount =
    state.accounts.find((a) => a.id === state.activeQrAccountId) ||
    state.accounts.find((a) => a.providerType === 'unofficial_bridge') ||
    null;

  if (qrAccount && !state.activeQrAccountId) {
    state.activeQrAccountId = qrAccount.id;
  }

  const session = state.qrSession || qrAccount?.qrSession || null;
  const status = session?.status || (qrAccount?.connectionStatus === 'connected' ? 'connected' : 'disconnected');

  const pill = document.getElementById('qr-status-pill');
  const img = document.getElementById('qr-code-image');
  const placeholder = document.getElementById('qr-placeholder');
  const phoneEl = document.getElementById('qr-connected-phone');
  const lastConnEl = document.getElementById('qr-last-connected');
  const errEl = document.getElementById('qr-error-box');

  if (!pill) return;

  pill.textContent = formatQrStatusLabel(status);
  pill.className = status === 'error' || status === 'expired' ? 'badge-warn' : 'badge-tag';
  phoneEl.textContent = session?.phoneNumber || qrAccount?.phoneNumber || '-';
  const lastTs = session?.lastConnectedAt || qrAccount?.lastConnectedAt;
  lastConnEl.textContent = lastTs ? new Date(lastTs).toLocaleString() : '-';

  const errMsg = session?.lastError || qrAccount?.lastError;
  if (errMsg && (status === 'error' || status === 'expired' || status === 'disconnected')) {
    errEl.textContent = errMsg;
    errEl.style.display = 'block';
  } else {
    errEl.textContent = '';
    errEl.style.display = 'none';
  }

  const dataUrl = session?.qrDataUrl;
  const isSafeImageUrl =
    typeof dataUrl === 'string' &&
    (dataUrl.startsWith('data:image/png;base64,') || dataUrl.startsWith('data:image/svg+xml'));

  if (status === 'waiting_for_scan' && isSafeImageUrl) {
    img.src = dataUrl;
    img.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
    placeholder.style.display = 'block';
    if (status === 'connected') {
      placeholder.innerHTML = `<strong>Connected</strong><div class="muted-note">Authenticated WhatsApp Web session active (${escapeHtml(session?.phoneNumber || qrAccount?.phoneNumber || 'Number verified')}).</div>`;
    } else if (status === 'connecting') {
      placeholder.innerHTML = '<strong>Connecting...</strong><div class="muted-note">Waiting for Node.js QR Bridge to emit fresh WhatsApp Web QR code.</div>';
    } else if (status === 'expired') {
      placeholder.innerHTML = '<strong>QR Code Expired</strong><div class="muted-note">Click <strong>Refresh QR</strong> to generate a new code.</div>';
    } else if (status === 'error') {
      placeholder.innerHTML = '<strong>Session Error</strong><div class="muted-note">Check error details &amp; troubleshooting instructions below.</div>';
    } else {
      placeholder.innerHTML = 'Click <strong>Generate QR Code</strong> to start an encrypted tenant-isolated session via the Node.js QR Bridge service.';
    }
  }

  const hasAccount = Boolean(state.activeQrAccountId);
  document.getElementById('btn-qr-refresh').disabled = !hasAccount;
  document.getElementById('btn-qr-reconnect').disabled = !hasAccount;
  document.getElementById('btn-qr-disconnect').disabled = !hasAccount;
  updateQrCountdownDisplay();
}

function renderAccounts() {
  const el = document.getElementById('wa-accounts-list');
  el.innerHTML = state.accounts.length
    ? state.accounts
        .map((a) => {
          const isMeta = a.providerType === 'official_meta_cloud';
          const statusText = isMeta ? a.connectionStatus : formatQrStatusLabel(a.qrStatus || a.connectionStatus);
          const lastConn = a.lastConnectedAt ? new Date(a.lastConnectedAt).toLocaleString() : 'Never';
          return `
        <div class="item-row">
          <div>
            <strong>${escapeHtml(a.label)}</strong>
            <span class="${isMeta ? 'badge-tag' : 'badge-warn'}">${isMeta ? 'Official Meta API' : 'Unofficial QR Web'}</span>
            <span class="badge-tag">${escapeHtml(statusText)}</span>
            <div class="muted-note">
              Number: ${escapeHtml(a.phoneNumber || 'Pending / Unverified')} |
              Last Connected: ${escapeHtml(lastConn)}
              ${isMeta ? `| WABA: ${escapeHtml(a.metaWabaId || '-')} | Phone ID: ${escapeHtml(a.maskedPhoneNumberId || '-')}` : ''}
            </div>
            ${a.lastError ? `<div class="qr-error-note">${escapeHtml(a.lastError)}</div>` : ''}
          </div>
          <div class="row-actions">
            ${
              isMeta
                ? `<button class="btn-secondary" data-action="verify-meta" data-id="${escapeHtml(a.id)}">Verify Connection</button>
                   <button class="btn-secondary" data-action="sync-templates" data-id="${escapeHtml(a.id)}">Sync Templates</button>`
                : `<button class="btn-secondary" data-action="manage-qr" data-id="${escapeHtml(a.id)}">Show QR</button>
                   <button class="btn-secondary" data-action="qr-reconnect" data-id="${escapeHtml(a.id)}">Reconnect</button>`
            }
            <button class="btn-danger-sm" data-action="disconnect-wa" data-id="${escapeHtml(a.id)}">Disconnect</button>
          </div>
        </div>`;
        })
        .join('')
    : '<div class="muted-note">No WhatsApp accounts connected yet. Choose Option A (Official Meta API) or Option B (QR Code) above.</div>';

  renderQrSessionPanel();
}

function renderContacts() {
  const tbody = document.getElementById('contacts-tbody');
  tbody.innerHTML = state.contacts.length
    ? state.contacts
        .map(
          (c) => `
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(c.phone)}</td>
          <td>${escapeHtml(c.company || '-')}</td>
          <td><span class="badge-tag">${escapeHtml(c.pipelineStage)}</span></td>
          <td class="row-actions">
            <button class="btn-secondary" data-action="start-conv" data-id="${escapeHtml(c.id)}">Inbox</button>
            <button class="btn-secondary" data-action="stop-contact" data-phone="${escapeHtml(c.phone)}">STOP</button>
            <button class="btn-danger-sm" data-action="del-contact" data-id="${escapeHtml(c.id)}">Delete</button>
          </td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="muted-note">No contacts found.</td></tr>';
}

function renderListsAndTags() {
  document.getElementById('lists-container').innerHTML = state.lists.length
    ? state.lists
        .map(
          (l) => `
        <div class="item-row">
          <div><strong>${escapeHtml(l.name)}</strong><div class="muted-note">${Number(l.memberCount ?? 0)} active members</div></div>
          <button class="btn-danger-sm" data-action="del-list" data-id="${escapeHtml(l.id)}">Delete</button>
        </div>`
        )
        .join('')
    : '<div class="muted-note">No lists created.</div>';

  document.getElementById('tags-container').innerHTML = state.tags.length
    ? state.tags
        .map(
          (t) => `<span class="tag-chip" style="border-left:4px solid ${escapeHtml(t.color || '#00a884')}">${escapeHtml(t.name)} <button class="btn-danger-sm" data-action="del-tag" data-id="${escapeHtml(t.id)}" style="padding:1px 6px;">Ã—</button></span>`
        )
        .join('')
    : '<div class="muted-note">No tags created.</div>';
}

function renderTemplates() {
  document.getElementById('templates-list').innerHTML = state.templates.length
    ? state.templates
        .map(
          (t) => `
        <div class="item-row">
          <div><strong>${escapeHtml(t.name)}</strong> (${escapeHtml(t.language)}) Â· <span class="badge-tag">${escapeHtml(t.approvalStatus)}</span>
            <div class="muted-note">${escapeHtml(t.bodyText)}</div>
          </div>
          <button class="btn-danger-sm" data-action="del-template" data-id="${escapeHtml(t.id)}">Delete</button>
        </div>`
        )
        .join('')
    : '<div class="muted-note">No templates yet.</div>';
}

function renderCampaigns() {
  document.getElementById('campaigns-list').innerHTML = state.campaigns.length
    ? state.campaigns
        .map(
          (c) => `
        <div class="item-row">
          <div><strong>${escapeHtml(c.name)}</strong> Â· <span class="badge-tag">${escapeHtml(c.status)}</span>
            <div class="muted-note">Total: ${Number(c.totalRecipients)} Â· Sent: ${Number(c.sentCount)} Â· Delivered: ${Number(c.deliveredCount)} Â· Read: ${Number(c.readCount)} Â· Skipped: ${Number(c.skippedCount)}</div>
          </div>
          <div class="row-actions">
            ${['draft', 'scheduled'].includes(c.status) ? `<button class="btn-primary" data-action="camp-launch" data-id="${escapeHtml(c.id)}">Launch</button>` : ''}
            ${c.status === 'running' ? `<button class="btn-secondary" data-action="camp-pause" data-id="${escapeHtml(c.id)}">Pause</button>` : ''}
            ${c.status === 'running' ? `<button class="btn-secondary" data-action="camp-tick" data-id="${escapeHtml(c.id)}">Run Tick</button>` : ''}
            ${c.status === 'paused' ? `<button class="btn-primary" data-action="camp-resume" data-id="${escapeHtml(c.id)}">Resume</button>` : ''}
            <button class="btn-secondary" data-action="view-report" data-id="${escapeHtml(c.id)}">Report</button>
          </div>
        </div>`
        )
        .join('')
    : '<div class="muted-note">No campaigns yet.</div>';
}

function renderConversations() {
  const m = state.conversationMetrics;
  const metricsEl = document.getElementById('conv-metrics-summary');
  if (metricsEl && m) {
    metricsEl.textContent = `Total: ${m.total} | AI: ${m.aiHandled} | Owner: ${m.ownerHandled} | Team: ${m.teamHandled} | Needs Attention: ${m.needsAttention}`;
  }

  document.getElementById('conversations-list').innerHTML = state.conversations.length
    ? state.conversations
        .map(
          (conv) => `
        <div class="item-row ${conv.id === state.activeConversationId ? 'selected' : ''}" data-action="select-conv" data-id="${escapeHtml(conv.id)}" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center; padding: 10px 12px; margin-bottom: 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
          <div style="flex:1; min-width: 0; padding-right: 8px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <strong>${escapeHtml(conv.contactName || 'Unknown')}</strong>
              <span class="muted-note" style="font-size:11px;">(${escapeHtml(conv.contactPhone || '')})</span>
            </div>
            <div class="muted-note" style="font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;">
              ${escapeHtml(conv.lastMessagePreview || 'No messages yet')}
            </div>
          </div>
          <div>
            ${formatConversationStatusBadge(conv)}
          </div>
        </div>`
        )
        .join('')
    : '<div class="muted-note">No conversations found.</div>';
}

function renderAiAndKnowledge(docsOverride = null) {
  const workersBadge = document.getElementById('workers-ai-badge');
  if (workersBadge) {
    workersBadge.textContent = state.workersAiConfigured ? 'Workers AI Bound ✓' : 'Workers AI Unconfigured';
    workersBadge.style.background = state.workersAiConfigured ? 'rgba(72, 187, 120, 0.2)' : 'rgba(160, 174, 192, 0.2)';
  }

  const geminiBadge = document.getElementById('gemini-ai-badge');
  if (geminiBadge) {
    geminiBadge.textContent = state.geminiConfigured ? 'Gemini 1.5 Flash Connected ✓' : 'Gemini Key Not Set (.dev.vars)';
    geminiBadge.style.background = state.geminiConfigured ? 'rgba(66, 153, 225, 0.2)' : 'rgba(237, 137, 54, 0.2)';
  }

  if (state.aiAgent) {
    const elEnabled = document.getElementById('ai-enabled');
    if (elEnabled) elEnabled.checked = Boolean(state.aiAgent.isEnabled);
    const elName = document.getElementById('ai-name');
    if (elName) elName.value = state.aiAgent.name || '';
    const elModel = document.getElementById('ai-model-select') || document.getElementById('ai-model');
    if (elModel) elModel.value = state.aiAgent.modelId || 'gemini-1.5-flash';
    const elPrompt = document.getElementById('ai-system-prompt');
    if (elPrompt) elPrompt.value = state.aiAgent.systemPrompt || '';
    const elDaily = document.getElementById('ai-daily-limit');
    if (elDaily) elDaily.value = String(state.aiAgent.dailyReplyLimit ?? 50);
    const elHandoff = document.getElementById('ai-handoff-keywords');
    if (elHandoff) elHandoff.value = (state.aiAgent.handoffKeywords || []).join(', ');

    // Business Profile Fields
    const p = state.aiAgent.businessProfile || {};
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('ai-biz-name', p.businessName);
    setVal('ai-biz-desc', p.businessDescription);
    setVal('ai-biz-products', p.productsAndServices);
    setVal('ai-biz-pricing', p.pricesAndPackages);
    setVal('ai-biz-hours', p.openingHours);
    setVal('ai-biz-location', p.location);
    setVal('ai-biz-contact', p.contactInfo);
    setVal('ai-biz-faqs', p.faqs);
    setVal('ai-biz-service-instructions', p.customerServiceInstructions);
    setVal('ai-biz-language', p.preferredLanguage);
    setVal('ai-biz-tone', p.tone || 'friendly and welcoming');
    setVal('ai-biz-custom-instructions', p.customInstructions);
  }

  const docs = docsOverride ?? state.knowledgeDocs;
  document.getElementById('kb-list').innerHTML = docs.length
    ? docs
        .map(
          (d) => `
        <div class="item-row">
          <div><strong>${escapeHtml(d.title)}</strong> [${escapeHtml(d.language)}]
            <div class="muted-note">${escapeHtml(d.content.slice(0, 160))}</div>
          </div>
          <button class="btn-danger-sm" data-action="del-kb" data-id="${escapeHtml(d.docId || d.id)}">Delete</button>
        </div>`
        )
        .join('')
    : '<div class="muted-note">No Knowledge Base documents found.</div>';
}

function renderTeamAndRoles() {
  document.getElementById('team-members-list').innerHTML = state.teamMembers.length
    ? state.teamMembers
        .map(
          (m) => `
        <div class="item-row">
          <div><strong>${escapeHtml(m.name)}</strong> (${escapeHtml(m.email)}) Â· <span class="badge-tag">${escapeHtml(m.role)}</span></div>
          ${m.role !== 'owner' ? `<button class="btn-danger-sm" data-action="remove-member" data-id="${escapeHtml(m.memberId)}">Remove</button>` : ''}
        </div>`
        )
        .join('')
    : '<div class="muted-note">No members loaded.</div>';

  document.getElementById('team-invites-list').innerHTML = state.teamInvites.length
    ? state.teamInvites
        .map((inv) => `<div class="item-row"><div>${escapeHtml(inv.email)} Â· ${escapeHtml(inv.role)}</div><span class="badge-tag">${inv.acceptedAt ? 'Accepted' : 'Pending'}</span></div>`)
        .join('')
    : '<div class="muted-note">No invitations yet.</div>';

  document.getElementById('current-role-badge').textContent = `Your Role: ${state.role}`;
  if (state.rolesData?.roles) {
    document.getElementById('roles-matrix').innerHTML = state.rolesData.roles
      .map((r) => `<div class="item-row"><div><strong>${escapeHtml(r.role.toUpperCase())}</strong><div class="muted-note">${escapeHtml(r.permissions.join(', '))}</div></div></div>`)
      .join('');
  }
}

function renderSubscriptionAndSettings() {
  const sub = state.subscriptionData;
  if (sub) {
    document.getElementById('sub-status-badge').textContent = `${sub.plan.displayName} (${sub.subscription.status})`;
    document.getElementById('billing-notice-box').textContent = sub.billingNotice;
    const u = sub.usage;
    const p = sub.plan;
    document.getElementById('usage-meters').innerHTML = `
      <div class="metric-card"><span class="metric-title">WhatsApp Numbers</span><strong class="metric-value">${u.whatsappAccountsCount ?? 0} / ${p.maxWhatsappAccounts ?? 1}</strong></div>
      <div class="metric-card"><span class="metric-title">Contacts</span><strong class="metric-value">${u.contactsCount} / ${p.maxContacts}</strong></div>
      <div class="metric-card"><span class="metric-title">Campaigns</span><strong class="metric-value">${u.campaignsCount} / ${p.maxCampaigns}</strong></div>
      <div class="metric-card"><span class="metric-title">Monthly Msgs</span><strong class="metric-value">${u.monthlyOutboundMessages} / ${p.monthlyOutboundMessages}</strong></div>
      <div class="metric-card"><span class="metric-title">Daily AI Replies</span><strong class="metric-value">${u.todayAiReplies} / ${p.dailyAiReplies}</strong></div>`;

    document.getElementById('plan-cards').innerHTML = (sub.catalog || [])
      .map(
        (plan) => `
      <div class="dash-card">
        <div class="card-title"><h3>${escapeHtml(plan.displayName)} — $${Number(plan.priceMonthlyUsd)}/mo</h3>${plan.tier === p.tier ? '<span class="badge-tag">Current</span>' : ''}</div>
        <div class="muted-note">${escapeHtml(plan.description)}</div>
        <div class="muted-note">Numbers: ${plan.maxWhatsappAccounts ?? 1} · Contacts: ${plan.maxContacts} · Campaigns: ${plan.maxCampaigns} · Msgs/mo: ${plan.monthlyOutboundMessages} · AI/day: ${plan.dailyAiReplies} · Team: ${plan.maxTeamMembers}</div>
        <button class="btn-secondary" data-action="set-plan" data-tier="${escapeHtml(plan.tier)}" ${plan.tier === p.tier ? 'disabled' : ''}>Assign ${escapeHtml(plan.displayName)} (Admin Mode)</button>
      </div>`
      )
      .join('');
  }

  if (state.organization) {
    document.getElementById('org-name').value = state.organization.name || '';
    document.getElementById('org-country').value = state.organization.defaultCountryCode || '92';
    document.getElementById('org-timezone').value = state.organization.timezone || 'Asia/Karachi';
  }

  const auditHtml = state.auditLogs.length
    ? state.auditLogs
        .slice(0, 12)
        .map((a) => `<div class="item-row"><div><strong>${escapeHtml(a.action)}</strong> Â· ${escapeHtml(a.entityType)}</div><span class="muted-note">${new Date(a.createdAt).toLocaleString()}</span></div>`)
        .join('')
    : '<div class="muted-note">No audit events recorded (or insufficient permission).</div>';
  document.getElementById('overview-audit').innerHTML = auditHtml;
  document.getElementById('settings-audit-logs').innerHTML = auditHtml;
}

async function loadConversationMessages(convId) {
  state.activeConversationId = convId;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('wacrm_active_conv_id', convId);
  }
  renderConversations();

  try {
    const [msgData, convDetail, histData] = await Promise.all([
      apiFetch(`/api/v1/crm/conversations/${encodeURIComponent(convId)}/messages`),
      apiFetch(`/api/v1/crm/conversations/${encodeURIComponent(convId)}`).catch(() => null),
      apiFetch(`/api/v1/crm/conversations/${encodeURIComponent(convId)}/assignment-history`).catch(() => ({ history: [] }))
    ]);

    const conv = convDetail?.conversation || state.conversations.find((c) => c.id === convId);
    state.activeConversation = conv;
    state.assignmentHistory = histData?.history || [];

    document.getElementById('active-conv-title').textContent = conv
      ? `${conv.contactName || 'Contact'} (${conv.contactPhone || ''})`
      : 'Conversation';
    const subEl = document.getElementById('active-conv-subtitle');
    if (subEl && conv) {
      subEl.textContent = `Channel: ${conv.channelType || 'WhatsApp'} · Status: ${conv.status || 'open'}`;
    }

    const statusEl = document.getElementById('active-conv-status');
    if (statusEl && conv) {
      statusEl.outerHTML = `<span id="active-conv-status">${formatConversationStatusBadge(conv)}</span>`;
    }

    const btnLeadIntel = document.getElementById('btn-analyze-leads');
    if (btnLeadIntel) btnLeadIntel.style.display = 'inline-block';
    const leadCard = document.getElementById('lead-analysis-card');
    if (leadCard) leadCard.style.display = 'none';

    // Render Chat Assignment Control Bar & Action Banner
    const assignContainer = document.getElementById('chat-assignment-container');
    if (assignContainer && conv) {
      assignContainer.style.display = 'block';

      // Update button highlights
      const at = conv.assignmentType || 'unassigned';
      const hm = conv.handlerMode || 'human';
      const hs = conv.handlingStatus || 'unassigned';

      const btnTeam = document.getElementById('btn-assign-team');
      const btnOwner = document.getElementById('btn-assign-owner');
      const btnAi = document.getElementById('btn-assign-ai');

      if (btnTeam) btnTeam.style.borderColor = (at === 'team_member') ? '#38b2ac' : 'rgba(255,255,255,0.2)';
      if (btnOwner) btnOwner.style.borderColor = (at === 'owner') ? '#9f7aea' : 'rgba(255,255,255,0.2)';
      if (btnAi) btnAi.style.borderColor = (at === 'ai' || hm === 'ai_bot') ? '#4299e1' : 'rgba(255,255,255,0.2)';

      // Update Action Banner & Takeover/Return buttons
      const banner = document.getElementById('handling-action-banner');
      const bannerText = document.getElementById('handling-banner-text');
      const btnTakeover = document.getElementById('btn-takeover-from-ai');
      const btnReturnAi = document.getElementById('btn-return-to-ai');

      const isAiActive = at === 'ai' || hm === 'ai_bot' || hs === 'ai_handling';
      const isNeedsAttention = hs === 'needs_attention';

      if (isNeedsAttention) {
        banner.style.background = 'rgba(229, 62, 62, 0.2)';
        banner.style.borderColor = 'rgba(229, 62, 62, 0.6)';
        bannerText.innerHTML = `<span>⚠️ <strong>Needs Human Attention!</strong> (AI escalated: ${escapeHtml(conv.handoffReason || 'Unhandled inquiry')})</span>`;
        if (btnTakeover) {
          btnTakeover.style.display = 'inline-block';
          btnTakeover.textContent = '⚡ Take Over Conversation';
        }
        if (btnReturnAi) btnReturnAi.style.display = 'none';
      } else if (isAiActive) {
        banner.style.background = 'rgba(49, 130, 206, 0.15)';
        banner.style.borderColor = 'rgba(49, 130, 206, 0.4)';
        bannerText.innerHTML = `<span>🤖 <strong>AI Chatbot is handling this conversation.</strong> (Knowledge-grounded)</span>`;
        if (btnTakeover) {
          btnTakeover.style.display = 'inline-block';
          btnTakeover.textContent = '⚡ Take Over from AI';
        }
        if (btnReturnAi) btnReturnAi.style.display = 'none';
      } else {
        const assignee = conv.assignedUserName ? ` (Assigned to: ${escapeHtml(conv.assignedUserName)})` : (at === 'owner' ? ' (Business Owner)' : '');
        banner.style.background = 'rgba(44, 122, 123, 0.2)';
        banner.style.borderColor = 'rgba(44, 122, 123, 0.5)';
        bannerText.innerHTML = `<span>👤 <strong>Human is handling this conversation.</strong>${assignee}</span>`;
        if (btnTakeover) btnTakeover.style.display = 'none';
        if (btnReturnAi) btnReturnAi.style.display = 'inline-block';
      }

      // History count & entries
      const histCountEl = document.getElementById('conv-history-count');
      if (histCountEl) histCountEl.textContent = String(state.assignmentHistory.length);

      const histEntriesEl = document.getElementById('conv-history-entries');
      if (histEntriesEl) {
        histEntriesEl.innerHTML = state.assignmentHistory.length
          ? state.assignmentHistory
              .map(
                (h) => `
              <div style="padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                <strong>${new Date(h.createdAt).toLocaleTimeString()} (${new Date(h.createdAt).toLocaleDateString()})</strong>:
                ${escapeHtml(h.previousHandlerType || 'unassigned')} ➔ <strong>${escapeHtml(h.newHandlerType)}</strong>
                ${h.newUserName ? `(👤 ${escapeHtml(h.newUserName)})` : ''} ·
                <span style="color:#a0aec0;">${escapeHtml(h.reason || 'Handler updated')}</span>
                <span class="muted-note">by ${escapeHtml(h.changedByUserName || 'System')}</span>
              </div>`
              )
              .join('')
          : '<div class="muted-note">No assignment history recorded yet.</div>';
      }
    }

    const box = document.getElementById('conv-messages-box');
    const msgs = msgData.items || [];
    box.innerHTML = msgs.length
      ? msgs
          .map(
            (m) => `
          <div class="msg-bubble ${m.direction === 'outbound' ? 'outbound' : 'inbound'}">
            <div>${escapeHtml(m.body || '')}</div>
            <div class="msg-meta">${escapeHtml(m.direction)} · ${escapeHtml(m.status)} · ${new Date(m.createdAt).toLocaleString()}</div>
          </div>`
          )
          .join('')
      : '<div class="muted-note">No messages yet.</div>';
  } catch (err) {
    showBanner(`Failed to load conversation: ${err.message}`, true);
  }
}

function renderReport(report) {
  state.lastReport = report;
  const c = report.campaign;
  document.getElementById('report-summary').textContent =
    `${c.name} [${c.status}] â€” Total: ${c.totalRecipients}, Sent: ${c.sentCount}, Delivered: ${c.deliveredCount}, Read: ${c.readCount}, Failed: ${c.failedCount}, Skipped: ${c.skippedCount}`;
  document.getElementById('report-tbody').innerHTML = (report.recipients || [])
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.contactName)}</td>
        <td>${escapeHtml(r.phone)}</td>
        <td><span class="badge-tag">${escapeHtml(r.status)}</span></td>
        <td>${escapeHtml(r.providerMessageId || '-')}</td>
        <td>${Number(r.attemptCount || 0)}</td>
        <td>${escapeHtml(r.errorMessage || '-')}</td>
      </tr>`
    )
    .join('');
}

async function refreshAllData() {
  if (!state.token) {
    renderSignedOutState();
    return;
  }
  try {
    const [me, statusRes] = await Promise.all([apiFetch('/api/v1/auth/me'), apiFetch('/api/v1/status')]);
    state.organization = me.organization;
    state.organizations = me.organizations || [];
    state.user = me.user || null;
    state.role = me.membership.role;
    state.statusInfo = statusRes;

    const sessionBar = document.getElementById('session-active-bar');
    const devLoginPanel = document.getElementById('dev-login-panel');
    const sessionBadge = document.getElementById('session-user-badge');
    if (sessionBar) sessionBar.style.display = 'flex';
    if (devLoginPanel) devLoginPanel.style.display = 'none';
    if (sessionBadge) {
      sessionBadge.textContent = `${me.user?.email || 'User'} · ${me.organization.name} (${me.membership.role.toUpperCase()})`;
    }

    document.getElementById('api-status-label').textContent = `${me.organization.name} (${me.membership.role})`;
    document.getElementById('api-dot').classList.add('online');
    const btnSignout = document.getElementById('btn-signout');
    if (btnSignout) btnSignout.style.display = 'inline-block';

    const q = new URLSearchParams();
    const search = document.getElementById('contacts-search')?.value || '';
    const stage = document.getElementById('contacts-filter-stage')?.value || '';
    if (search) q.set('search', search);
    if (stage) q.set('pipelineStage', stage);

    const convUrl =
      `/api/v1/crm/conversations?limit=50` +
      (state.convFilter && state.convFilter !== 'all' ? `&filter=${encodeURIComponent(state.convFilter)}` : '') +
      (state.convSearch ? `&search=${encodeURIComponent(state.convSearch)}` : '');

    const [
      acc,
      contacts,
      lists,
      tags,
      tpls,
      camps,
      convs,
      convMetrics,
      aiAgent,
      kb,
      members,
      invites,
      roles,
      sub,
      audits,
      sched,
      statuses,
      analytics,
      recs
    ] = await Promise.all([
      apiFetch('/api/v1/whatsapp/accounts').catch(() => ({ items: [] })),
      apiFetch(`/api/v1/crm/contacts?${q.toString()}`).catch(() => ({ items: [] })),
      apiFetch('/api/v1/crm/lists').catch(() => ({ items: [] })),
      apiFetch('/api/v1/crm/tags').catch(() => ({ items: [] })),
      apiFetch('/api/v1/templates').catch(() => ({ items: [] })),
      apiFetch('/api/v1/campaigns').catch(() => ({ items: [] })),
      apiFetch(convUrl).catch(() => ({ items: [] })),
      apiFetch('/api/v1/crm/conversations-metrics').catch(() => ({ metrics: null })),
      apiFetch('/api/v1/ai/agent').catch(() => ({ agent: null, workersAiConfigured: false })),
      apiFetch('/api/v1/ai/knowledge').catch(() => ({ items: [] })),
      apiFetch('/api/v1/team/members').catch(() => ({ items: [] })),
      apiFetch('/api/v1/team/invites').catch(() => ({ items: [] })),
      apiFetch('/api/v1/team/roles').catch(() => null),
      apiFetch('/api/v1/subscription').catch(() => null),
      apiFetch('/api/v1/org/audit-logs').catch(() => ({ items: [] })),
      apiFetch('/api/v1/messages/scheduled').catch(() => ({ items: [] })),
      apiFetch('/api/v1/whatsapp/status').catch(() => ({ items: [] })),
      apiFetch('/api/v1/analytics/overview').catch(() => ({ overview: null })),
      apiFetch('/api/v1/business-ai/recommendations').catch(() => ({ items: [] }))
    ]);

    state.accounts = acc.items || [];
    state.contacts = contacts.items || [];
    state.lists = lists.items || [];
    state.tags = tags.items || [];
    state.templates = tpls.items || [];
    state.campaigns = camps.items || [];
    state.conversations = convs.items || [];
    state.conversationMetrics = convMetrics?.metrics || null;
    state.aiAgent = aiAgent.agent;
    state.workersAiConfigured = Boolean(aiAgent.workersAiConfigured);
    state.geminiConfigured = Boolean(aiAgent.geminiConfigured);
    state.knowledgeDocs = kb.items || [];
    state.teamMembers = members.items || [];
    state.teamInvites = invites.items || [];
    state.rolesData = roles;
    state.subscriptionData = sub;
    state.auditLogs = audits.items || [];
    state.scheduledMessages = sched.items || [];
    state.waStatuses = statuses.items || [];
    state.businessAnalytics = analytics.overview || null;
    state.aiRecommendations = recs.items || [];

    renderAllViews();
    showBanner('');

    // Restore active conversation thread seamlessly if previously opened
    const savedConvId =
      state.activeConversationId ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem('wacrm_active_conv_id') : null);
    if (savedConvId) {
      const match = state.conversations.find((c) => c.id === savedConvId);
      if (match) {
        void loadConversationMessages(savedConvId);
      }
    }
  } catch (err) {
    if (
      err.message &&
      (err.message.includes('401') ||
        err.message.includes('Unauthorized') ||
        err.message.includes('SESSION_EXPIRED')) &&
      !state.organization
    ) {
      state.token = '';
      if (typeof localStorage !== 'undefined') localStorage.removeItem('wacrm_bearer_token');
      renderSignedOutState();
      showBanner('Session expired. Please sign in again.', true);
    } else {
      document.getElementById('api-status-label').textContent = `${state.organization?.name || 'Workspace'} (Online)`;
      document.getElementById('api-dot').classList.add('online');
      console.warn('refreshAllData notice:', err.message);
    }
  }
}

function captureOAuthHashToken() {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash || '';
  if (hash.startsWith('#token=')) {
    const tok = decodeURIComponent(hash.slice('#token='.length));
    if (tok) {
      state.token = tok;
      localStorage.setItem('wacrm_bearer_token', tok);
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  } else if (hash.includes('error=oauth_not_configured')) {
    const banner = document.getElementById('oauth-warning-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.innerHTML = `<strong>⚠️ Google OAuth2 is not configured on this Worker.</strong><br/>
      Please sign in or create an account using Email & Password below, or configure <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> on your Cloudflare Worker / <code>.dev.vars</code>.`;
    }
    const devPanel = document.getElementById('dev-login-panel');
    if (devPanel) devPanel.style.display = 'flex';
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

function wireEvents() {
  const inApi = document.getElementById('input-api-base');
  if (inApi) inApi.value = state.apiBase;
  const inTok = document.getElementById('input-bearer-token');
  if (inTok) inTok.value = state.token;

  // Environment Selector
  const envSel = document.getElementById('select-api-env');
  if (envSel) {
    if (state.apiBase.includes('127.0.0.1:8787') || state.apiBase.includes('localhost:8787')) {
      envSel.value = 'http://127.0.0.1:8787';
    } else if (state.apiBase.includes('workers.dev')) {
      envSel.value = 'https://wacrm-api.awais-wacrm-2026.workers.dev';
    } else {
      envSel.value = 'custom';
    }

    envSel.addEventListener('change', async (e) => {
      const val = e.target.value;
      if (val === 'custom') {
        const drawer = document.getElementById('connection-details-drawer');
        if (drawer) drawer.style.display = 'flex';
        return;
      }
      state.apiBase = val;
      if (typeof localStorage !== 'undefined') localStorage.setItem('wacrm_api_base', val);
      if (inApi) inApi.value = val;
      showBanner(`API environment switched to ${val}.`);
      if (state.token) {
        await refreshAllData();
      }
    });
  }

  document.getElementById('btn-toggle-connection-details')?.addEventListener('click', () => {
    const d = document.getElementById('connection-details-drawer');
    if (d) d.style.display = d.style.display === 'none' ? 'flex' : 'none';
  });

  // Active view switching with persistent state
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      setActiveView(btn.dataset.view);
    });
  });

  // Track WhatsApp account changes
  for (const id of ['reply-account-id', 'composer-wa-account', 'status-account-id']) {
    document.getElementById(id)?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val) {
        state.activeWaAccountId = val;
        if (typeof localStorage !== 'undefined') localStorage.setItem('wacrm_active_wa_acc_id', val);
      }
    });
  }

  document.getElementById('btn-save-connection')?.addEventListener('click', () => {
    state.apiBase = getEffectiveApiBase();
    state.token = document.getElementById('input-bearer-token')?.value?.trim() || '';
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('wacrm_api_base', state.apiBase);
      localStorage.setItem('wacrm_bearer_token', state.token);
    }
    refreshAllData();
  });

  for (const prov of ['google', 'github']) {
    document.getElementById(`btn-oauth-${prov}`)?.addEventListener('click', async () => {
      const base = getEffectiveApiBase();
      if (typeof localStorage !== 'undefined') localStorage.setItem('wacrm_api_base', base);

      // Pre-check provider configuration before leaving page
      try {
        const provRes = await fetch(`${base}/api/v1/auth/oauth/providers`).then((r) => r.json());
        const target = provRes?.providers?.find((p) => p.provider === prov);
        if (target && !target.configured) {
          const banner = document.getElementById('oauth-warning-banner');
          if (banner) {
            banner.style.display = 'block';
            banner.innerHTML = `<strong>⚠️ ${prov === 'google' ? 'Google' : 'GitHub'} OAuth2 is not configured on this Worker.</strong><br/>
            Please use the Email & Password form below to sign in or create an account, or add <code>${prov.toUpperCase()}_CLIENT_ID</code> and <code>${prov.toUpperCase()}_CLIENT_SECRET</code> to your Worker secrets.`;
          }
          const p = document.getElementById('dev-login-panel');
          if (p) p.style.display = 'flex';
          return;
        }
      } catch {}

      window.location.href = `${base}/api/v1/auth/oauth/${prov}/start`;
    });
  }

  document.getElementById('select-active-org')?.addEventListener('change', async (e) => {
    const organizationId = e.target.value;
    if (!organizationId || organizationId === state.organization?.id) return;
    try {
      await apiFetch('/api/v1/auth/orgs/switch', { method: 'POST', body: JSON.stringify({ organizationId }) });
      await refreshAllData();
    } catch (err) {
      showBanner(err.message, true);
    }
  });

  document.getElementById('btn-dev-login')?.addEventListener('click', async () => {
    try {
      state.apiBase = getEffectiveApiBase();
      const email = document.getElementById('login-email')?.value?.trim() || '';
      const password = document.getElementById('login-password')?.value || '';
      if (!email || !password) {
        return showBanner('Please enter your email and password.', true);
      }
      showBanner('Signing in...');
      const res = await apiFetch('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, clientType: 'web' })
      });
      state.token = res.token;
      const tokInput = document.getElementById('input-bearer-token');
      if (tokInput) tokInput.value = res.token;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('wacrm_api_base', state.apiBase);
        localStorage.setItem('wacrm_bearer_token', res.token);
      }
      await refreshAllData();
      showBanner('Signed in successfully.');
    } catch (err) {
      showBanner(err.message, true);
    }
  });

  document.getElementById('btn-dev-register')?.addEventListener('click', async () => {
    try {
      state.apiBase = getEffectiveApiBase();
      const email = document.getElementById('login-email')?.value?.trim() || '';
      const password = document.getElementById('login-password')?.value || '';
      if (!email || password.length < 8) {
        return showBanner('Enter a valid email and password (at least 8 characters) to create an account.', true);
      }
      showBanner('Creating account...');
      const res = await apiFetch('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email,
          name: email.split('@')[0] || 'User',
          password,
          clientType: 'web'
        })
      });
      state.token = res.token;
      const tokInput = document.getElementById('input-bearer-token');
      if (tokInput) tokInput.value = res.token;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('wacrm_api_base', state.apiBase);
        localStorage.setItem('wacrm_bearer_token', res.token);
      }
      await refreshAllData();
      showBanner('Account created and signed in successfully!');
    } catch (err) {
      showBanner(err.message, true);
    }
  });

  document.getElementById('btn-signout')?.addEventListener('click', async () => {
    try { await apiFetch('/api/v1/auth/logout', { method: 'POST' }); } catch {}
    state.token = '';
    if (typeof localStorage !== 'undefined') localStorage.removeItem('wacrm_bearer_token');
    const tokInput = document.getElementById('input-bearer-token');
    if (tokInput) tokInput.value = '';
    renderSignedOutState();
    showBanner('Signed out successfully.');
  });

  document.getElementById('btn-refresh-all')?.addEventListener('click', refreshAllData);
  document.getElementById('btn-search-contacts')?.addEventListener('click', refreshAllData);

  async function syncQrStatusOnce(accountId) {
    if (!accountId) return;
    try {
      const res = await apiFetch(`/api/v1/whatsapp/accounts/qr/${encodeURIComponent(accountId)}/status`);
      state.qrSession = res.session || res.account?.qrSession || null;
      if (res.account) {
        const idx = state.accounts.findIndex((a) => a.id === res.account.id);
        if (idx >= 0) state.accounts[idx] = res.account;
        else state.accounts.unshift(res.account);
      }
      renderAccounts();
      const status = state.qrSession?.status;
      if (!status || !['connecting', 'waiting_for_scan'].includes(status)) {
        stopQrTimers();
      }
    } catch (err) {
      stopQrTimers();
      showBanner(err.message, true);
    }
  }

  function showQrBoxError(msg) {
    showBanner(msg, true);
    const errEl = document.getElementById('qr-error-box');
    const pill = document.getElementById('qr-status-pill');
    if (pill) {
      pill.textContent = 'Error';
      pill.className = 'badge-warn';
    }
    if (errEl) {
      if (msg && (msg.includes('QR_BRIDGE') || msg.includes('not configured') || msg.includes('503'))) {
        errEl.innerHTML = `
          <div style="background: rgba(221,107,32,0.18); border: 1px solid rgba(221,107,32,0.45); padding: 12px; border-radius: 6px; color: #ecc94b; line-height: 1.5; font-size: 12px; text-align: left;">
            <strong style="color:#feb2b2; font-size:13px;">⚠️ Local Desktop QR Engine Required for Option B</strong><br/>
            The unofficial WhatsApp Web QR code is generated by the local desktop Node.js service (port 8790).<br/><br/>
            <strong>To scan your QR Code right now:</strong><br/>
            1. Open the local desktop dashboard: <a href="http://127.0.0.1:8788" target="_blank" style="color: #68d391; font-weight: bold; text-decoration: underline;">http://127.0.0.1:8788</a><br/>
            2. Or switch the API environment in the top bar to <em>Local Dev / Desktop API (127.0.0.1:8787)</em>.<br/>
            3. For Cloudflare cloud operation without running local services, use <strong>Option A: Official Meta WhatsApp Cloud API</strong> (left panel).
          </div>
        `;
      } else {
        errEl.textContent = msg;
      }
      errEl.style.display = 'block';
    }
  }

  function startQrPolling(accountId) {
    stopQrTimers();
    state.activeQrAccountId = accountId;
    const status = state.qrSession?.status;
    if (status && ['connecting', 'waiting_for_scan'].includes(status)) {
      setTimeout(() => {
        if (state.token && state.activeQrAccountId === accountId) {
          void syncQrStatusOnce(accountId);
        }
      }, 700);
      state.qrPollTimer = setInterval(() => {
        if (state.token && document.visibilityState === 'visible') {
          void syncQrStatusOnce(accountId);
        }
      }, 2000);
      state.qrCountdownTimer = setInterval(updateQrCountdownDisplay, 1000);
    }
  }

  document.getElementById('btn-verify-meta-creds').addEventListener('click', async () => {
    const out = document.getElementById('meta-verify-result');
    try {
      const res = await apiFetch('/api/v1/whatsapp/accounts/meta/verify', {
        method: 'POST',
        body: JSON.stringify({
          metaWabaId: document.getElementById('meta-waba-id').value.trim(),
          metaPhoneNumberId: document.getElementById('meta-phone-id').value.trim(),
          accessToken: document.getElementById('meta-access-token').value.trim()
        })
      });
      if (res.phoneNumber && !document.getElementById('meta-phone').value.trim()) {
        document.getElementById('meta-phone').value = res.phoneNumber;
      }
      out.style.display = 'block';
      out.textContent = `Verified ✓ Phone: ${res.phoneNumber || 'Valid'} · Business Name: ${res.verifiedName || 'Verified'}`;
    } catch (err) {
      out.style.display = 'block';
      out.textContent = `Verification failed: ${err.message}`;
    }
  });

  document.getElementById('form-connect-meta').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/whatsapp/accounts/meta', {
        method: 'POST',
        body: JSON.stringify({
          label: document.getElementById('meta-label').value.trim(),
          phoneNumber: document.getElementById('meta-phone').value.trim() || null,
          metaWabaId: document.getElementById('meta-waba-id').value.trim(),
          metaPhoneNumberId: document.getElementById('meta-phone-id').value.trim(),
          accessToken: document.getElementById('meta-access-token').value.trim(),
          appSecret: document.getElementById('meta-app-secret').value.trim(),
          webhookVerifyToken: document.getElementById('meta-verify-token').value.trim(),
          verifyConnection: true
        })
      });
      e.target.reset();
      document.getElementById('meta-verify-result').style.display = 'none';
      await refreshAllData();
      showBanner('Official Meta Cloud API verified and connected.');
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-qr-start').addEventListener('click', async () => {
    if (!state.token) {
      return showQrBoxError(
        'Sign in first before generating a QR code: use Google OAuth2 (production) or Dev Login → Create Local Account / Sign In (localhost).'
      );
    }
    try {
      const label = document.getElementById('qr-account-label').value.trim() || 'WhatsApp Web QR (Unofficial)';
      const res = await apiFetch('/api/v1/whatsapp/accounts/qr/start', {
        method: 'POST',
        body: JSON.stringify({
          accountId: state.activeQrAccountId || undefined,
          label
        })
      });
      state.activeQrAccountId = res.account.id;
      state.qrSession = res.session || res.account.qrSession || null;
      await refreshAllData();
      startQrPolling(res.account.id);
    } catch (err) { showQrBoxError(err.message); }
  });

  document.getElementById('btn-qr-refresh').addEventListener('click', async () => {
    if (!state.activeQrAccountId) return;
    try {
      const res = await apiFetch(`/api/v1/whatsapp/accounts/qr/${encodeURIComponent(state.activeQrAccountId)}/refresh`, { method: 'POST' });
      state.qrSession = res.session || res.account?.qrSession || null;
      await refreshAllData();
      startQrPolling(state.activeQrAccountId);
    } catch (err) { showQrBoxError(err.message); }
  });

  document.getElementById('btn-qr-reconnect').addEventListener('click', async () => {
    if (!state.activeQrAccountId) return;
    try {
      const res = await apiFetch(`/api/v1/whatsapp/accounts/qr/${encodeURIComponent(state.activeQrAccountId)}/reconnect`, { method: 'POST' });
      state.qrSession = res.session || res.account?.qrSession || null;
      await refreshAllData();
      startQrPolling(state.activeQrAccountId);
    } catch (err) { showQrBoxError(err.message); }
  });

  document.getElementById('btn-qr-disconnect').addEventListener('click', async () => {
    if (!state.activeQrAccountId) return;
    try {
      stopQrTimers();
      const res = await apiFetch(`/api/v1/whatsapp/accounts/qr/${encodeURIComponent(state.activeQrAccountId)}/disconnect`, { method: 'POST' });
      state.qrSession = res.session || res.account?.qrSession || null;
      await refreshAllData();
      showBanner('Unofficial QR session disconnected.');
    } catch (err) { showQrBoxError(err.message); }
  });

  document.getElementById('form-add-contact').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/crm/contacts', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('contact-name').value.trim(),
          phone: document.getElementById('contact-phone').value.trim(),
          company: document.getElementById('contact-company').value.trim() || null,
          email: document.getElementById('contact-email').value.trim() || null,
          pipelineStage: document.getElementById('contact-stage').value
        })
      });
      e.target.reset();
      await refreshAllData();
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-preview-import').addEventListener('click', async () => {
    const file = document.getElementById('cloud-import-file').files?.[0];
    if (!file) return showBanner('Select a .csv, .tsv, or .xlsx file first.', true);
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'xls') return showBanner('Legacy binary .xls is rejected in Cloud CRM; convert to .xlsx or .csv.', true);
    try {
      const payload = ext === 'xlsx' ? { format: 'xlsx', xlsxBase64: await fileToBase64(file) } : { format: ext === 'tsv' ? 'tsv' : 'csv', text: await file.text() };
      const res = await apiFetch('/api/v1/crm/contacts/import/preview', { method: 'POST', body: JSON.stringify(payload) });
      state.pendingImportContacts = res.preview.validContacts || [];
      document.getElementById('btn-commit-import').disabled = state.pendingImportContacts.length === 0;
      document.getElementById('import-preview-output').textContent = JSON.stringify({ total: res.preview.totalDataRows, valid: res.preview.validContacts.length, duplicates: res.preview.duplicates.length, invalid: res.preview.invalidRows.length }, null, 2);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-commit-import').addEventListener('click', async () => {
    try {
      const listName = document.getElementById('cloud-import-list-name').value.trim() || undefined;
      const res = await apiFetch('/api/v1/crm/contacts/import', { method: 'POST', body: JSON.stringify({ listName, contacts: state.pendingImportContacts }) });
      state.pendingImportContacts = [];
      document.getElementById('btn-commit-import').disabled = true;
      document.getElementById('import-preview-output').textContent = JSON.stringify(res.summary, null, 2);
      await refreshAllData();
    } catch (err) { showBanner(err.message, true); }
  });

  async function runLegacyImport(dryRun) {
    const file = document.getElementById('legacy-json-file').files?.[0];
    if (!file) return showBanner('Select exported wacrm_legacy_state_*.json file.', true);
    try {
      const parsed = JSON.parse(await file.text());
      const res = await apiFetch('/api/v1/crm/legacy-import', { method: 'POST', body: JSON.stringify({ sourceName: file.name, campaignState: parsed.campaignState || parsed, dryRun, conflictPolicy: 'skip_existing' }) });
      document.getElementById('import-preview-output').textContent = JSON.stringify(res, null, 2);
      if (!dryRun) await refreshAllData();
    } catch (err) { showBanner(err.message, true); }
  }
  document.getElementById('btn-legacy-dryrun').addEventListener('click', () => runLegacyImport(true));
  document.getElementById('btn-legacy-commit').addEventListener('click', () => runLegacyImport(false));

  document.getElementById('form-create-list').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/crm/lists', { method: 'POST', body: JSON.stringify({ name: document.getElementById('list-name').value.trim(), description: document.getElementById('list-desc').value.trim() || null }) });
      e.target.reset();
      await refreshAllData();
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('form-create-tag').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/crm/tags', { method: 'POST', body: JSON.stringify({ name: document.getElementById('tag-name').value.trim(), color: document.getElementById('tag-color').value }) });
      e.target.reset();
      await refreshAllData();
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-check-consent').addEventListener('click', async () => {
    const phone = document.getElementById('consent-phone').value.trim();
    if (!phone) return;
    try { document.getElementById('consent-result').textContent = JSON.stringify(await apiFetch(`/api/v1/crm/consent/eligibility?phone=${encodeURIComponent(phone)}`), null, 2); }
    catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-optin-phone').addEventListener('click', async () => {
    const phone = document.getElementById('consent-phone').value.trim();
    if (!phone) return;
    try { document.getElementById('consent-result').textContent = JSON.stringify(await apiFetch('/api/v1/crm/consent', { method: 'POST', body: JSON.stringify({ phone, status: 'opted_in', source: 'cloud_dashboard' }) }), null, 2); }
    catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-stop-phone').addEventListener('click', async () => {
    const phone = document.getElementById('consent-phone').value.trim();
    if (!phone) return;
    try { document.getElementById('consent-result').textContent = JSON.stringify(await apiFetch('/api/v1/crm/consent/stop', { method: 'POST', body: JSON.stringify({ phone, reason: 'manual_opt_out', source: 'cloud_dashboard' }) }), null, 2); }
    catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('form-create-template').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/templates', {
        method: 'POST',
        body: JSON.stringify({
          whatsappAccountId: document.getElementById('tpl-account-id').value || null,
          name: document.getElementById('tpl-name').value.trim(),
          language: document.getElementById('tpl-language').value.trim() || 'en_US',
          category: document.getElementById('tpl-category').value,
          approvalStatus: document.getElementById('tpl-approval').value,
          bodyText: document.getElementById('tpl-body').value
        })
      });
      e.target.reset();
      await refreshAllData();
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('camp-schedule-type').addEventListener('change', (e) => {
    document.getElementById('camp-scheduled-at').style.display = e.target.value === 'once' ? 'inline-block' : 'none';
  });

  document.getElementById('form-create-campaign').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const scheduleType = document.getElementById('camp-schedule-type').value;
      const dtVal = document.getElementById('camp-scheduled-at').value;
      await apiFetch('/api/v1/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('camp-name').value.trim(),
          whatsappAccountId: document.getElementById('camp-account-id').value,
          listId: document.getElementById('camp-list-id').value,
          templateId: document.getElementById('camp-template-id').value || null,
          messageOverride: document.getElementById('camp-override').value.trim() || null,
          scheduleType,
          scheduledAt: scheduleType === 'once' && dtVal ? new Date(dtVal).getTime() : null,
          dailyLimit: Number(document.getElementById('camp-daily-limit').value) || 30
        })
      });
      e.target.reset();
      await refreshAllData();
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-load-report').addEventListener('click', async () => {
    const campId = document.getElementById('report-campaign-select').value;
    if (!campId) return;
    try { renderReport(await apiFetch(`/api/v1/campaigns/${encodeURIComponent(campId)}/report`)); }
    catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-download-report-csv').addEventListener('click', () => {
    if (!state.lastReport) return showBanner('Load a campaign report first.', true);
    const header = 'Name,Phone,Status,ProviderMessageId,Attempts,Error\n';
    const rows = (state.lastReport.recipients || []).map((r) => [sanitizeCsvCell(r.contactName), sanitizeCsvCell(r.phone), sanitizeCsvCell(r.status), sanitizeCsvCell(r.providerMessageId || ''), sanitizeCsvCell(r.attemptCount), sanitizeCsvCell(r.errorMessage || '')].join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + header + rows], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `campaign_report_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 500);
  });

  document.getElementById('form-send-reply').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.activeConversationId) return showBanner('Select a conversation first.', true);
    try {
      await apiFetch(`/api/v1/whatsapp/conversations/${encodeURIComponent(state.activeConversationId)}/send`, {
        method: 'POST',
        body: JSON.stringify({
          whatsappAccountId: document.getElementById('reply-account-id').value,
          templateId: document.getElementById('reply-template-id').value || null,
          body: document.getElementById('reply-body').value.trim() || null,
          idempotencyKey: `ui_${crypto.randomUUID()}`
        })
      });
      document.getElementById('reply-body').value = '';
      await loadConversationMessages(state.activeConversationId);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-conv-handoff').addEventListener('click', async () => {
    if (!state.activeConversationId) return showBanner('Select a conversation first.', true);
    try {
      await apiFetch(`/api/v1/ai/conversations/${encodeURIComponent(state.activeConversationId)}/handoff`, { method: 'POST', body: JSON.stringify({ reason: 'Agent handoff via Inbox' }) });
      await refreshAllData();
      await loadConversationMessages(state.activeConversationId);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-assign-team')?.addEventListener('click', async () => {
    if (!state.activeConversationId) return showBanner('Select a conversation first.', true);
    try {
      await apiFetch(`/api/v1/crm/conversations/${encodeURIComponent(state.activeConversationId)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ handlerType: 'team_member' })
      });
      showBanner('Conversation assigned to Team Member.');
      await refreshAllData();
      await loadConversationMessages(state.activeConversationId);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-assign-owner')?.addEventListener('click', async () => {
    if (!state.activeConversationId) return showBanner('Select a conversation first.', true);
    try {
      await apiFetch(`/api/v1/crm/conversations/${encodeURIComponent(state.activeConversationId)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ handlerType: 'owner' })
      });
      showBanner('Conversation assigned to Business Owner.');
      await refreshAllData();
      await loadConversationMessages(state.activeConversationId);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-assign-ai')?.addEventListener('click', async () => {
    if (!state.activeConversationId) return showBanner('Select a conversation first.', true);
    try {
      await apiFetch(`/api/v1/crm/conversations/${encodeURIComponent(state.activeConversationId)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ handlerType: 'ai' })
      });
      showBanner('Conversation assigned to AI Chatbot.');
      await refreshAllData();
      await loadConversationMessages(state.activeConversationId);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-takeover-from-ai')?.addEventListener('click', async () => {
    if (!state.activeConversationId) return showBanner('Select a conversation first.', true);
    try {
      await apiFetch(`/api/v1/crm/conversations/${encodeURIComponent(state.activeConversationId)}/takeover`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Manual human takeover from AI' })
      });
      showBanner('You took over this conversation. AI automatic replies are now paused.');
      await refreshAllData();
      await loadConversationMessages(state.activeConversationId);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-return-to-ai')?.addEventListener('click', async () => {
    if (!state.activeConversationId) return showBanner('Select a conversation first.', true);
    if (!confirm('Return this conversation to AI Chatbot? The bot will resume automatic replies for future incoming messages.')) return;
    try {
      await apiFetch(`/api/v1/crm/conversations/${encodeURIComponent(state.activeConversationId)}/return-to-ai`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Returned to AI Chatbot' })
      });
      showBanner('Returned to AI Chatbot. AI will handle future incoming messages.');
      await refreshAllData();
      await loadConversationMessages(state.activeConversationId);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-toggle-assignment-history')?.addEventListener('click', () => {
    const drawer = document.getElementById('conv-history-drawer');
    if (drawer) drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('conv-filter-select')?.addEventListener('change', async (e) => {
    state.convFilter = e.target.value;
    await refreshAllData();
  });

  let searchConvTimeout = null;
  document.getElementById('conv-search-input')?.addEventListener('input', (e) => {
    state.convSearch = e.target.value.trim();
    if (searchConvTimeout) clearTimeout(searchConvTimeout);
    searchConvTimeout = setTimeout(async () => {
      await refreshAllData();
    }, 300);
  });

  document.getElementById('btn-test-ai-reply').addEventListener('click', async () => {
    if (!state.activeConversationId) return showBanner('Select a conversation first.', true);
    const customerText = document.getElementById('reply-body').value.trim();
    if (!customerText) return showBanner('Enter a customer message in the box to run AI reply.', true);
    try {
      const res = await apiFetch(`/api/v1/ai/conversations/${encodeURIComponent(state.activeConversationId)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ customerText, sendOutboundReply: false })
      });
      showBanner(`AI Result [${res.status}]: ${res.reason}`, res.status !== 'replied');
      await loadConversationMessages(state.activeConversationId);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('form-ai-config')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const kws = document.getElementById('ai-handoff-keywords').value.split(',').map((s) => s.trim()).filter(Boolean);
      const modelVal = (document.getElementById('ai-model-select') || document.getElementById('ai-model'))?.value.trim() || 'gemini-1.5-flash';
      const getVal = (id) => document.getElementById(id)?.value.trim() || '';

      await apiFetch('/api/v1/ai/agent', {
        method: 'PATCH',
        body: JSON.stringify({
          isEnabled: document.getElementById('ai-enabled').checked,
          name: document.getElementById('ai-name').value.trim(),
          modelId: modelVal,
          systemPrompt: document.getElementById('ai-system-prompt').value.trim(),
          dailyReplyLimit: Number(document.getElementById('ai-daily-limit').value) || 50,
          handoffKeywords: kws,
          businessProfile: {
            businessName: getVal('ai-biz-name'),
            businessDescription: getVal('ai-biz-desc'),
            productsAndServices: getVal('ai-biz-products'),
            pricesAndPackages: getVal('ai-biz-pricing'),
            openingHours: getVal('ai-biz-hours'),
            location: getVal('ai-biz-location'),
            contactInfo: getVal('ai-biz-contact'),
            faqs: getVal('ai-biz-faqs'),
            customerServiceInstructions: getVal('ai-biz-service-instructions'),
            preferredLanguage: getVal('ai-biz-language'),
            tone: getVal('ai-biz-tone') || 'friendly and welcoming',
            customInstructions: getVal('ai-biz-custom-instructions')
          }
        })
      });
      await refreshAllData();
      showBanner('AI Chatbot & Business Profile saved successfully.');
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-analyze-leads')?.addEventListener('click', async () => {
    if (!state.activeConversationId) return showBanner('Select a conversation first.', true);
    const card = document.getElementById('lead-analysis-card');
    if (card) {
      card.style.display = 'block';
      card.innerHTML = '<em>Analyzing conversation with Google Gemini...</em>';
    }
    try {
      const res = await apiFetch(`/api/v1/ai/conversations/${encodeURIComponent(state.activeConversationId)}/analyze-leads`, {
        method: 'POST'
      });
      const a = res.analysis;
      if (card && a) {
        const intentColor = a.leadIntentScore === 'high' ? '#38a169' : a.leadIntentScore === 'medium' ? '#d69e2e' : '#718096';
        card.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <strong>🧠 Gemini Lead Intelligence & Retention Analysis</strong>
            <span class="badge-tag" style="background:${intentColor}; color:#fff; text-transform:uppercase; font-size:11px; padding:2px 8px; border-radius:4px;">Intent: ${escapeHtml(a.leadIntentScore)}</span>
          </div>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-bottom: 8px;">
            <div><strong>Interested:</strong> ${a.isInterested ? '✅ Yes' : '❌ No'}</div>
            <div><strong>Pricing Query:</strong> ${a.pricingQueryDetected ? '💰 Yes' : 'No'}</div>
            <div><strong>Sentiment:</strong> ${escapeHtml(a.sentiment)}</div>
            <div><strong>Churn Risk:</strong> ${escapeHtml(a.churnRisk)}</div>
          </div>
          <div style="margin-bottom:6px;"><strong>Summary:</strong> ${escapeHtml(a.summary)}</div>
          ${a.followUpRequired ? `<div style="color:#ecc94b; margin-bottom:4px;"><strong>Follow-up Needed:</strong> ${escapeHtml(a.followUpReason || 'Follow-up requested')}</div>` : ''}
          <div><strong>Suggested Action:</strong> 💡 <em>${escapeHtml(a.suggestedAction)}</em></div>
        `;
      }
    } catch (err) {
      if (card) {
        card.innerHTML = `<span style="color:#e53e3e;">Lead Analysis Error: ${escapeHtml(err.message)}</span>`;
      }
    }
  });

  document.getElementById('form-add-knowledge').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/ai/knowledge', {
        method: 'POST',
        body: JSON.stringify({
          title: document.getElementById('kb-title').value.trim(),
          language: document.getElementById('kb-language').value,
          category: document.getElementById('kb-category').value.trim() || null,
          content: document.getElementById('kb-content').value.trim()
        })
      });
      e.target.reset();
      await refreshAllData();
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-kb-search').addEventListener('click', async () => {
    const q = document.getElementById('kb-search-input').value.trim();
    if (!q) return renderAiAndKnowledge();
    try {
      const res = await apiFetch(`/api/v1/ai/knowledge/search?q=${encodeURIComponent(q)}`);
      renderAiAndKnowledge(res.items || []);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('form-invite-member').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/v1/team/invites', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('invite-email').value.trim(),
          role: document.getElementById('invite-role').value
        })
      });
      document.getElementById('invite-token-output').textContent = JSON.stringify(res, null, 2);
      e.target.reset();
      await refreshAllData();
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-accept-invite').addEventListener('click', async () => {
    const token = document.getElementById('accept-invite-token').value.trim();
    if (!token) return;
    try {
      await apiFetch('/api/v1/team/invites/accept', { method: 'POST', body: JSON.stringify({ token }) });
      await refreshAllData();
      showBanner('Workspace invitation accepted.');
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('form-org-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/org/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          name: document.getElementById('org-name').value.trim(),
          defaultCountryCode: document.getElementById('org-country').value.trim(),
          timezone: document.getElementById('org-timezone').value.trim()
        })
      });
      await refreshAllData();
      showBanner('Organization settings saved.');
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('form-create-org').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/auth/orgs', {
        method: 'POST',
        body: JSON.stringify({ name: document.getElementById('new-org-name').value.trim() })
      });
      e.target.reset();
      await refreshAllData();
    } catch (err) { showBanner(err.message, true); }
  });

  // Simple Message Composer Target Radios
  document.querySelectorAll('input[name="composer-target-type"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const val = e.target.value;
      const phoneBox = document.getElementById('composer-target-phone-box');
      const contactBox = document.getElementById('composer-target-contact-box');
      const listBox = document.getElementById('composer-target-list-box');
      if (phoneBox) phoneBox.style.display = val === 'phone' ? 'block' : 'none';
      if (contactBox) contactBox.style.display = val === 'contact' ? 'block' : 'none';
      if (listBox) listBox.style.display = val === 'list' ? 'block' : 'none';
    });
  });

  // Schedule Checkbox
  document.getElementById('composer-enable-schedule')?.addEventListener('change', (e) => {
    const timeBox = document.getElementById('composer-schedule-time-box');
    const submitBtn = document.getElementById('btn-composer-submit');
    if (timeBox) timeBox.style.display = e.target.checked ? 'block' : 'none';
    if (submitBtn) {
      submitBtn.textContent = e.target.checked ? '⏰ CONFIRM SCHEDULED DELIVERY' : '🚀 SEND NOW';
    }
  });

  // Emoji buttons
  document.querySelectorAll('.btn-emoji').forEach((btn) => {
    btn.addEventListener('click', () => {
      const textarea = document.getElementById('composer-message-text');
      if (textarea && btn.dataset.emoji) {
        textarea.value += btn.dataset.emoji;
        textarea.focus();
      }
    });
  });

  // Submit Composer Form
  document.getElementById('form-simple-composer')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const accountId = document.getElementById('composer-wa-account').value;
    if (!accountId) return showBanner('Select or connect a WhatsApp account first.', true);

    const targetType = document.querySelector('input[name="composer-target-type"]:checked')?.value || 'phone';
    const messageText = document.getElementById('composer-message-text').value.trim();
    if (!messageText) return showBanner('Message text is required.', true);

    const isScheduled = document.getElementById('composer-enable-schedule')?.checked;
    const scheduleDt = document.getElementById('composer-schedule-datetime')?.value;

    let recipientPhones = [];
    let recipientContactIds = [];
    let recipientListId = null;

    if (targetType === 'phone') {
      const phone = document.getElementById('composer-phone-input').value.trim();
      if (!phone) return showBanner('Enter recipient phone number.', true);
      recipientPhones = [phone];
    } else if (targetType === 'contact') {
      const contactId = document.getElementById('composer-contact-select').value;
      if (!contactId) return showBanner('Select a contact.', true);
      recipientContactIds = [contactId];
    } else if (targetType === 'list') {
      const listId = document.getElementById('composer-list-select').value;
      if (!listId) return showBanner('Select a contact list.', true);
      recipientListId = listId;
    }

    try {
      if (isScheduled) {
        if (!scheduleDt) return showBanner('Select a scheduled date and time.', true);
        const scheduledAt = new Date(scheduleDt).getTime();
        if (scheduledAt <= Date.now()) return showBanner('Scheduled delivery time must be in the future.', true);

        await apiFetch('/api/v1/messages/scheduled/schedule', {
          method: 'POST',
          body: JSON.stringify({
            whatsappAccountId: accountId,
            recipientType: targetType === 'list' ? 'list' : (targetType === 'contact' ? 'contact' : 'phones'),
            recipientPhones: recipientPhones.length ? recipientPhones : undefined,
            recipientContactIds: recipientContactIds.length ? recipientContactIds : undefined,
            recipientListId: recipientListId || undefined,
            messageText,
            scheduledAt,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
          })
        });
        showBanner(`Message scheduled successfully for ${new Date(scheduledAt).toLocaleString()}.`);
      } else {
        // Send now
        await apiFetch('/api/v1/messages/scheduled/schedule', {
          method: 'POST',
          body: JSON.stringify({
            whatsappAccountId: accountId,
            recipientType: targetType === 'list' ? 'list' : (targetType === 'contact' ? 'contact' : 'phones'),
            recipientPhones: recipientPhones.length ? recipientPhones : undefined,
            recipientContactIds: recipientContactIds.length ? recipientContactIds : undefined,
            recipientListId: recipientListId || undefined,
            messageText,
            scheduledAt: Date.now() + 1000,
            timezone: 'UTC'
          })
        });
        showBanner('Message queued and dispatched immediately.');
      }
      document.getElementById('composer-message-text').value = '';
      await refreshAllData();
    } catch (err) {
      showBanner(err.message, true);
    }
  });

  document.getElementById('btn-refresh-scheduled')?.addEventListener('click', refreshAllData);

  // Submit Status Form
  document.getElementById('form-wa-status')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const accountId = document.getElementById('status-account-id').value;
    if (!accountId) return showBanner('Select a WhatsApp account first.', true);

    const contentType = document.getElementById('status-content-type').value;
    const contentText = document.getElementById('status-content-text').value.trim();
    const mediaUrl = document.getElementById('status-media-url')?.value.trim() || null;
    const backgroundColor = document.getElementById('status-bg-color')?.value || '#075e54';
    const font = document.getElementById('status-font')?.value || 'SANS_SERIF';

    try {
      await apiFetch('/api/v1/whatsapp/status', {
        method: 'POST',
        body: JSON.stringify({
          whatsappAccountId: accountId,
          contentType,
          contentText: contentText || null,
          mediaUrl: mediaUrl || undefined,
          backgroundColor,
          font
        })
      });
      document.getElementById('status-content-text').value = '';
      showBanner('WhatsApp Status published successfully.');
      await refreshAllData();
    } catch (err) {
      showBanner(err.message, true);
    }
  });

  document.getElementById('btn-refresh-statuses')?.addEventListener('click', refreshAllData);

  // Generate Business AI
  document.getElementById('btn-generate-business-ai')?.addEventListener('click', async () => {
    try {
      showBanner('Generating Gemini Strategic Intelligence report...');
      const res = await apiFetch('/api/v1/business-ai/recommendations/generate', { method: 'POST' });
      showBanner(`Generated ${res.generated} actionable AI business recommendations.`);
      await refreshAllData();
    } catch (err) {
      showBanner(err.message, true);
    }
  });

  document.body.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    try {
      if (action === 'sync-templates') { await apiFetch(`/api/v1/whatsapp/accounts/${encodeURIComponent(id)}/sync-templates`, { method: 'POST' }); await refreshAllData(); }
      else if (action === 'verify-meta') { const r = await apiFetch(`/api/v1/whatsapp/accounts/${encodeURIComponent(id)}/verify`, { method: 'POST' }); await refreshAllData(); showBanner(`Meta Account verified (${r.phoneNumber || 'OK'})`); }
      else if (action === 'manage-qr') { state.activeQrAccountId = id; state.qrSession = (await apiFetch(`/api/v1/whatsapp/accounts/qr/${encodeURIComponent(id)}/status`)).session; renderAccounts(); }
      else if (action === 'qr-reconnect') { state.activeQrAccountId = id; const r = await apiFetch(`/api/v1/whatsapp/accounts/qr/${encodeURIComponent(id)}/reconnect`, { method: 'POST' }); state.qrSession = r.session; await refreshAllData(); }
      else if (action === 'disconnect-wa') { stopQrTimers(); await apiFetch(`/api/v1/whatsapp/accounts/${encodeURIComponent(id)}/disconnect`, { method: 'POST' }); state.qrSession = null; await refreshAllData(); }
      else if (action === 'cancel-scheduled') { await apiFetch(`/api/v1/messages/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' }); showBanner('Scheduled message cancelled.'); await refreshAllData(); }
      else if (action === 'delete-status') { await apiFetch(`/api/v1/whatsapp/status/${encodeURIComponent(id)}`, { method: 'DELETE' }); showBanner('WhatsApp Status removed.'); await refreshAllData(); }
      else if (action === 'del-contact') { await apiFetch(`/api/v1/crm/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshAllData(); }
      else if (action === 'stop-contact') { await apiFetch('/api/v1/crm/consent/stop', { method: 'POST', body: JSON.stringify({ phone: target.dataset.phone, reason: 'manual_opt_out' }) }); showBanner('STOP suppression recorded.'); }
      else if (action === 'start-conv') { const res = await apiFetch('/api/v1/crm/conversations', { method: 'POST', body: JSON.stringify({ contactId: id, channelType: 'official_meta_cloud' }) }); await refreshAllData(); setActiveView('conversations'); await loadConversationMessages(res.conversation.id); }
      else if (action === 'del-list') { await apiFetch(`/api/v1/crm/lists/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshAllData(); }
      else if (action === 'del-tag') { await apiFetch(`/api/v1/crm/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshAllData(); }
      else if (action === 'del-template') { await apiFetch(`/api/v1/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshAllData(); }
      else if (action === 'camp-launch') { await apiFetch(`/api/v1/campaigns/${encodeURIComponent(id)}/launch`, { method: 'POST' }); await refreshAllData(); }
      else if (action === 'camp-pause') { await apiFetch(`/api/v1/campaigns/${encodeURIComponent(id)}/pause`, { method: 'POST' }); await refreshAllData(); }
      else if (action === 'camp-resume') { await apiFetch(`/api/v1/campaigns/${encodeURIComponent(id)}/resume`, { method: 'POST' }); await refreshAllData(); }
      else if (action === 'camp-tick') { await apiFetch(`/api/v1/campaigns/${encodeURIComponent(id)}/dispatch-tick`, { method: 'POST' }); await refreshAllData(); }
      else if (action === 'view-report') { document.getElementById('report-campaign-select').value = id; setActiveView('reports'); renderReport(await apiFetch(`/api/v1/campaigns/${encodeURIComponent(id)}/report`)); }
      else if (action === 'select-conv') { await loadConversationMessages(id); }
      else if (action === 'del-kb') { await apiFetch(`/api/v1/ai/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshAllData(); }
      else if (action === 'remove-member') { await apiFetch(`/api/v1/team/members/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshAllData(); }
      else if (action === 'set-plan') { await apiFetch('/api/v1/subscription/plan', { method: 'POST', body: JSON.stringify({ planTier: target.dataset.tier }) }); await refreshAllData(); showBanner('Plan updated in manual admin mode.'); }
    } catch (err) { showBanner(err.message, true); }
  });

  setInterval(() => {
    if (state.token && document.visibilityState === 'visible') refreshAllData();
  }, 20_000);
}

function bootApp() {
  captureOAuthHashToken();
  wireEvents();
  setActiveView(state.activeView);
  if (state.token) {
    refreshAllData();
  } else {
    renderSignedOutState();
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootApp);
  } else {
    bootApp();
  }
}
