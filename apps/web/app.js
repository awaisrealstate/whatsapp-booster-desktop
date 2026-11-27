const state = {
  apiBase: localStorage.getItem('wacrm_api_base') || 'https://wacrm-api.awais-wacrm-2026.workers.dev',
  token: localStorage.getItem('wacrm_bearer_token') || '',
  organization: null,
  organizations: [],
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
  statusInfo: null,
  activeConversationId: null,
  activeQrAccountId: null,
  qrSession: null,
  qrPollTimer: null,
  qrCountdownTimer: null,
  pendingImportContacts: [],
  lastReport: null
};

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

async function apiFetch(path, options = {}) {
  const base = state.apiBase.replace(/\/+$/, '');
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
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label)} (${escapeHtml(a.maskedPhoneNumberId || a.providerType)})</option>`)
    .join('');
  for (const id of ['camp-account-id', 'reply-account-id']) {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = accOpts || '<option value="">Connect Meta WhatsApp account first</option>';
  }
  const tplAcc = document.getElementById('tpl-account-id');
  if (tplAcc) tplAcc.innerHTML = '<option value="">Any / Local Template</option>' + accOpts;

  const listSel = document.getElementById('camp-list-id');
  if (listSel) {
    listSel.innerHTML =
      state.lists.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)} (${Number(l.memberCount ?? 0)})</option>`).join('') ||
      '<option value="">Create Contact List first</option>';
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
  document.getElementById('conversations-list').innerHTML = state.conversations.length
    ? state.conversations
        .map(
          (conv) => `
        <div class="item-row ${conv.id === state.activeConversationId ? 'selected' : ''}" data-action="select-conv" data-id="${escapeHtml(conv.id)}" style="cursor:pointer;">
          <div><strong>${escapeHtml(conv.contactName)}</strong> (${escapeHtml(conv.contactPhone)})
            <div class="muted-note">${escapeHtml(conv.lastMessagePreview || 'No messages yet')}</div>
          </div>
          <span class="badge-tag">${escapeHtml(conv.handlerMode || 'human')}</span>
        </div>`
        )
        .join('')
    : '<div class="muted-note">No conversations yet.</div>';
}

function renderAiAndKnowledge(docsOverride = null) {
  const badge = document.getElementById('workers-ai-badge');
  badge.textContent = state.workersAiConfigured ? 'Workers AI Bound âœ“' : 'Workers AI Unconfigured (Safe Handoff)';
  if (state.aiAgent) {
    document.getElementById('ai-enabled').checked = Boolean(state.aiAgent.isEnabled);
    document.getElementById('ai-name').value = state.aiAgent.name || '';
    document.getElementById('ai-model').value = state.aiAgent.modelId || '';
    document.getElementById('ai-system-prompt').value = state.aiAgent.systemPrompt || '';
    document.getElementById('ai-daily-limit').value = String(state.aiAgent.dailyReplyLimit ?? 50);
    document.getElementById('ai-handoff-keywords').value = (state.aiAgent.handoffKeywords || []).join(', ');
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
  renderConversations();
  const data = await apiFetch(`/api/v1/crm/conversations/${encodeURIComponent(convId)}/messages`);
  const conv = state.conversations.find((c) => c.id === convId);
  document.getElementById('active-conv-title').textContent = conv ? `${conv.contactName} (${conv.contactPhone})` : 'Conversation';
  document.getElementById('active-conv-mode').textContent = conv?.handlerMode || 'human';
  const box = document.getElementById('conv-messages-box');
  const msgs = data.items || [];
  box.innerHTML = msgs.length
    ? msgs
        .map(
          (m) => `
        <div class="msg-bubble ${m.direction === 'outbound' ? 'outbound' : 'inbound'}">
          <div>${escapeHtml(m.body || '')}</div>
          <div class="msg-meta">${escapeHtml(m.direction)} Â· ${escapeHtml(m.status)} Â· ${new Date(m.createdAt).toLocaleString()}</div>
        </div>`
        )
        .join('')
    : '<div class="muted-note">No messages yet.</div>';
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
  if (!state.token) return;
  try {
    const [me, statusRes] = await Promise.all([apiFetch('/api/v1/auth/me'), apiFetch('/api/v1/status')]);
    state.organization = me.organization;
    state.organizations = me.organizations || [];
    state.role = me.membership.role;
    state.statusInfo = statusRes;
    document.getElementById('api-status-label').textContent = `${me.organization.name} (${me.membership.role})`;
    document.getElementById('api-dot').classList.add('online');
    document.getElementById('btn-signout').style.display = 'inline-block';

    const q = new URLSearchParams();
    const search = document.getElementById('contacts-search')?.value || '';
    const stage = document.getElementById('contacts-filter-stage')?.value || '';
    if (search) q.set('search', search);
    if (stage) q.set('pipelineStage', stage);

    const [acc, contacts, lists, tags, tpls, camps, convs, aiAgent, kb, members, invites, roles, sub, audits] =
      await Promise.all([
        apiFetch('/api/v1/whatsapp/accounts'),
        apiFetch(`/api/v1/crm/contacts?${q.toString()}`),
        apiFetch('/api/v1/crm/lists'),
        apiFetch('/api/v1/crm/tags'),
        apiFetch('/api/v1/templates'),
        apiFetch('/api/v1/campaigns'),
        apiFetch('/api/v1/crm/conversations'),
        apiFetch('/api/v1/ai/agent').catch(() => ({ agent: null, workersAiConfigured: false })),
        apiFetch('/api/v1/ai/knowledge').catch(() => ({ items: [] })),
        apiFetch('/api/v1/team/members').catch(() => ({ items: [] })),
        apiFetch('/api/v1/team/invites').catch(() => ({ items: [] })),
        apiFetch('/api/v1/team/roles').catch(() => null),
        apiFetch('/api/v1/subscription').catch(() => null),
        apiFetch('/api/v1/org/audit-logs').catch(() => ({ items: [] }))
      ]);

    state.accounts = acc.items || [];
    state.contacts = contacts.items || [];
    state.lists = lists.items || [];
    state.tags = tags.items || [];
    state.templates = tpls.items || [];
    state.campaigns = camps.items || [];
    state.conversations = convs.items || [];
    state.aiAgent = aiAgent.agent;
    state.workersAiConfigured = Boolean(aiAgent.workersAiConfigured);
    state.knowledgeDocs = kb.items || [];
    state.teamMembers = members.items || [];
    state.teamInvites = invites.items || [];
    state.rolesData = roles;
    state.subscriptionData = sub;
    state.auditLogs = audits.items || [];

    renderAllViews();
    showBanner('');
  } catch (err) {
    document.getElementById('api-status-label').textContent = 'Auth / Connection Error';
    document.getElementById('api-dot').classList.remove('online');
    showBanner(err.message, true);
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
  }
}

function wireEvents() {
  document.getElementById('input-api-base').value = state.apiBase;
  document.getElementById('input-bearer-token').value = state.token;

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.view-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`view-${btn.dataset.view}`)?.classList.add('active');
    });
  });

  document.getElementById('btn-save-connection').addEventListener('click', () => {
    state.apiBase = document.getElementById('input-api-base').value.trim();
    state.token = document.getElementById('input-bearer-token').value.trim();
    localStorage.setItem('wacrm_api_base', state.apiBase);
    localStorage.setItem('wacrm_bearer_token', state.token);
    refreshAllData();
  });

  for (const prov of ['google', 'github']) {
    document.getElementById(`btn-oauth-${prov}`).addEventListener('click', () => {
      const base = document.getElementById('input-api-base').value.trim().replace(/\/+$/, '');
      localStorage.setItem('wacrm_api_base', base);
      window.location.href = `${base}/api/v1/auth/oauth/${prov}/start`;
    });
  }

  document.getElementById('select-active-org').addEventListener('change', async (e) => {
    const organizationId = e.target.value;
    if (!organizationId || organizationId === state.organization?.id) return;
    try {
      await apiFetch('/api/v1/auth/orgs/switch', { method: 'POST', body: JSON.stringify({ organizationId }) });
      await refreshAllData();
    } catch (err) {
      showBanner(err.message, true);
    }
  });

  document.getElementById('btn-toggle-dev-login').addEventListener('click', () => {
    const p = document.getElementById('dev-login-panel');
    p.style.display = p.style.display === 'none' ? 'flex' : 'none';
  });

  document.getElementById('btn-dev-login').addEventListener('click', async () => {
    try {
      state.apiBase = document.getElementById('input-api-base').value.trim();
      const res = await apiFetch('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('login-email').value.trim(),
          password: document.getElementById('login-password').value,
          clientType: 'web'
        })
      });
      state.token = res.token;
      document.getElementById('input-bearer-token').value = res.token;
      localStorage.setItem('wacrm_api_base', state.apiBase);
      localStorage.setItem('wacrm_bearer_token', res.token);
      await refreshAllData();
    } catch (err) {
      showBanner(err.message, true);
    }
  });

  document.getElementById('btn-signout').addEventListener('click', async () => {
    try { await apiFetch('/api/v1/auth/logout', { method: 'POST' }); } catch {}
    state.token = '';
    localStorage.removeItem('wacrm_bearer_token');
    document.getElementById('input-bearer-token').value = '';
    document.getElementById('api-status-label').textContent = 'Signed Out';
    document.getElementById('api-dot').classList.remove('online');
  });

  document.getElementById('btn-refresh-all').addEventListener('click', refreshAllData);
  document.getElementById('btn-search-contacts').addEventListener('click', refreshAllData);

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

  function startQrPolling(accountId) {
    stopQrTimers();
    state.activeQrAccountId = accountId;
    const status = state.qrSession?.status;
    if (status && ['connecting', 'waiting_for_scan'].includes(status)) {
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
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-qr-refresh').addEventListener('click', async () => {
    if (!state.activeQrAccountId) return;
    try {
      const res = await apiFetch(`/api/v1/whatsapp/accounts/qr/${encodeURIComponent(state.activeQrAccountId)}/refresh`, { method: 'POST' });
      state.qrSession = res.session || res.account?.qrSession || null;
      await refreshAllData();
      startQrPolling(state.activeQrAccountId);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-qr-reconnect').addEventListener('click', async () => {
    if (!state.activeQrAccountId) return;
    try {
      const res = await apiFetch(`/api/v1/whatsapp/accounts/qr/${encodeURIComponent(state.activeQrAccountId)}/reconnect`, { method: 'POST' });
      state.qrSession = res.session || res.account?.qrSession || null;
      await refreshAllData();
      startQrPolling(state.activeQrAccountId);
    } catch (err) { showBanner(err.message, true); }
  });

  document.getElementById('btn-qr-disconnect').addEventListener('click', async () => {
    if (!state.activeQrAccountId) return;
    try {
      stopQrTimers();
      const res = await apiFetch(`/api/v1/whatsapp/accounts/qr/${encodeURIComponent(state.activeQrAccountId)}/disconnect`, { method: 'POST' });
      state.qrSession = res.session || res.account?.qrSession || null;
      await refreshAllData();
      showBanner('Unofficial QR session disconnected.');
    } catch (err) { showBanner(err.message, true); }
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

  document.getElementById('form-ai-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const kws = document.getElementById('ai-handoff-keywords').value.split(',').map((s) => s.trim()).filter(Boolean);
      await apiFetch('/api/v1/ai/agent', {
        method: 'PATCH',
        body: JSON.stringify({
          isEnabled: document.getElementById('ai-enabled').checked,
          name: document.getElementById('ai-name').value.trim(),
          modelId: document.getElementById('ai-model').value.trim(),
          systemPrompt: document.getElementById('ai-system-prompt').value.trim(),
          dailyReplyLimit: Number(document.getElementById('ai-daily-limit').value) || 50,
          handoffKeywords: kws
        })
      });
      await refreshAllData();
      showBanner('AI Support Agent configuration saved.');
    } catch (err) { showBanner(err.message, true); }
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
      else if (action === 'del-contact') { await apiFetch(`/api/v1/crm/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshAllData(); }
      else if (action === 'stop-contact') { await apiFetch('/api/v1/crm/consent/stop', { method: 'POST', body: JSON.stringify({ phone: target.dataset.phone, reason: 'manual_opt_out' }) }); showBanner('STOP suppression recorded.'); }
      else if (action === 'start-conv') { const res = await apiFetch('/api/v1/crm/conversations', { method: 'POST', body: JSON.stringify({ contactId: id, channelType: 'official_meta_cloud' }) }); await refreshAllData(); document.querySelector('.nav-tab[data-view="conversations"]')?.click(); await loadConversationMessages(res.conversation.id); }
      else if (action === 'del-list') { await apiFetch(`/api/v1/crm/lists/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshAllData(); }
      else if (action === 'del-tag') { await apiFetch(`/api/v1/crm/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshAllData(); }
      else if (action === 'del-template') { await apiFetch(`/api/v1/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshAllData(); }
      else if (action === 'camp-launch') { await apiFetch(`/api/v1/campaigns/${encodeURIComponent(id)}/launch`, { method: 'POST' }); await refreshAllData(); }
      else if (action === 'camp-pause') { await apiFetch(`/api/v1/campaigns/${encodeURIComponent(id)}/pause`, { method: 'POST' }); await refreshAllData(); }
      else if (action === 'camp-resume') { await apiFetch(`/api/v1/campaigns/${encodeURIComponent(id)}/resume`, { method: 'POST' }); await refreshAllData(); }
      else if (action === 'camp-tick') { await apiFetch(`/api/v1/campaigns/${encodeURIComponent(id)}/dispatch-tick`, { method: 'POST' }); await refreshAllData(); }
      else if (action === 'view-report') { document.getElementById('report-campaign-select').value = id; document.querySelector('.nav-tab[data-view="reports"]')?.click(); renderReport(await apiFetch(`/api/v1/campaigns/${encodeURIComponent(id)}/report`)); }
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

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    captureOAuthHashToken();
    wireEvents();
    if (state.token) refreshAllData();
  });
}
