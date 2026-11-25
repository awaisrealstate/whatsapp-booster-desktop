/**
 * WhatsApp CRM Pro - Enterprise Control Center Controller
 * Connects directly to background orchestrator with real-time bidirectional synchronization.
 */

document.addEventListener('DOMContentLoaded', () => {
  let currentState = null;
  let currentAppSettings = { minimizeToTray: true, autoStartOnBoot: false };
  let activeFilter = 'all';
  let searchTerm = '';
  let tickerTimer = null;

  try {
    chrome.runtime.connect({ name: 'wacrm_keepalive' });
  } catch (e) {}

  const SAMPLE_CONTACTS = [
    { name: 'Alexander Wright', phone: '03001112233', company: 'Apex Global' },
    { name: 'Sarah Jenkins', phone: '03212223344', company: 'Nexus Tech' },
    { name: 'Muhammad Usman', phone: '03334445566', company: 'Crescent Trading' },
    { name: 'David Miller', phone: '03456667788', company: 'Prime Logistics' },
    { name: 'Zainab Fatima', phone: '03018889900', company: 'Vertex Solutions' },
    { name: 'Hamza Tariq', phone: '03129990011', company: 'Alpha Ventures' },
    { name: 'Elena Rostova', phone: '03023334455', company: 'Horizon Media' },
    { name: 'Bilal Siddiqui', phone: '03225556677', company: 'Sterling Real Estate' },
    { name: 'Jessica Taylor', phone: '03347778899', company: 'Beacon Capital' },
    { name: 'Omar Farooq', phone: '03461113355', company: 'Summit Group' },
    { name: 'Sophie Turner', phone: '03032224466', company: 'Kestrel Labs' },
    { name: 'Ali Raza', phone: '03234446688', company: 'Metropolis Corp' },
    { name: 'Rachel Green', phone: '03356668800', company: 'Omni Retail' },
    { name: 'Kashif Mehmood', phone: '03478880022', company: 'Matrix Consulting' },
    { name: 'Lucas Martin', phone: '03041239876', company: 'Vanguard Dynamics' },
    { name: 'Ayesha Khan', phone: '03242340987', company: 'Pulse Healthcare' },
    { name: 'Daniel Craig', phone: '03363451098', company: 'Crown Holdings' },
    { name: 'Tariq Jamil', phone: '03484562109', company: 'Indus Motors' },
    { name: 'Emily Blunt', phone: '03055673210', company: 'Aura Interiors' },
    { name: 'Fahad Mustafa', phone: '03256784321', company: 'Starlight Media' },
    { name: 'Marcus Aurelius', phone: '03377895432', company: 'Imperium Group' },
    { name: 'Hina Altaf', phone: '03498906543', company: 'Glow Cosmetics' },
    { name: 'Robert Downey', phone: '03069017654', company: 'Stark Industries' },
    { name: 'Shoaib Akhtar', phone: '03260128765', company: 'Rawalpindi Sports' },
    { name: 'Natalie Portman', phone: '03381239876', company: 'Cinema House' },
    { name: 'Waqar Younis', phone: '03502340987', company: 'CricTech' },
    { name: 'Scarlett Johansson', phone: '03073451098', company: 'Red Star Agency' },
    { name: 'Babar Azam', phone: '03274562109', company: 'King Apparel' },
    { name: 'Jennifer Aniston', phone: '03395673210', company: 'Central Perk' },
    { name: 'Wasim Akram', phone: '03516784321', company: 'Swing Masters' },
    { name: 'Jonathan Vance', phone: '03087895432', company: 'Vance Refrigeration' },
    { name: 'Hira Mani', phone: '03288906543', company: 'Glamour Studio' },
    { name: 'Tom Holland', phone: '03409017654', company: 'Web Solutions' },
    { name: 'Shadab Khan', phone: '03520128765', company: 'Spin Academy' },
    { name: 'Emma Watson', phone: '03091239876', company: 'Books & Beyond' }
  ];

  // Request state from background orchestrator
  function syncWithBackground() {
    chrome.runtime.sendMessage({ action: 'getState' }, response => {
      if (response && response.state) {
        currentState = response.state;
        if (response.appSettings) {
          currentAppSettings = response.appSettings;
        }
        renderDashboard();
      }
    });
  }

  // Render complete UI
  function renderDashboard() {
    if (!currentState) return;

    const contacts = currentState.contacts || [];
    const dailyLimit = currentState.dailyLimit || 30;
    const minInt = currentState.minIntervalSec || 60;
    const maxInt = currentState.maxIntervalSec || 120;
    const minCd = currentState.minCooldownHours || 24;
    const maxCd = currentState.maxCooldownHours || 28;

    const sentCount = contacts.filter(c => c.status === 'sent').length;
    const failedCount = contacts.filter(c => c.status === 'failed').length;
    const pendingCount = contacts.filter(c => c.status === 'pending').length;
    const processedCount = sentCount + failedCount;

    // Metrics
    document.getElementById('metric-sent-today').innerText = `${currentState.batchSentCount} / ${dailyLimit}`;
    const batchNum = Math.floor(processedCount / dailyLimit) + 1;
    document.getElementById('metric-batch-label').innerText = `Batch ${batchNum} Active (Anti-Ban Quota)`;
    document.getElementById('metric-interval-status').innerText = `${minInt}s - ${maxInt}s`;
    document.getElementById('metric-interval-sub').innerText = `Dynamic Random ${minInt}s - ${maxInt}s Gap`;
    document.getElementById('metric-total-contacts').innerText = contacts.length;
    document.getElementById('metric-remaining-label').innerText = `${pendingCount} Pending · ${sentCount} Sent`;
    document.getElementById('metric-cooldown-sub').innerText = `Variable ${minCd}h - ${maxCd}h Auto-Resume`;
    document.getElementById('audience-count-label').innerText = contacts.length;

    // System Status Indicator
    const systemText = document.getElementById('system-status-text');
    const systemDot = document.getElementById('system-dot');
    const badgeTag = document.getElementById('campaign-badge');

    if (currentState.campaignCompleted && pendingCount === 0 && contacts.length > 0) {
      systemText.innerText = 'All Completed ✓';
      systemText.style.color = '#25D366';
      systemDot.style.backgroundColor = '#25D366';
      badgeTag.innerText = 'COMPLETED';
      badgeTag.style.color = '#25D366';
    } else if (currentState.inCooldown) {
      systemText.innerText = 'In Cooldown Lock';
      systemText.style.color = '#f59e0b';
      systemDot.style.backgroundColor = '#f59e0b';
      badgeTag.innerText = 'COOLDOWN';
      badgeTag.style.color = '#f59e0b';
    } else if (currentState.waitingForConnection) {
      systemText.innerText = 'Waiting Connection';
      systemText.style.color = '#f59e0b';
      systemDot.style.backgroundColor = '#f59e0b';
      badgeTag.innerText = 'RECONNECTING';
      badgeTag.style.color = '#f59e0b';
    } else if (currentState.isRunning) {
      if (currentState.isPaused) {
        systemText.innerText = 'Campaign Paused';
        systemText.style.color = '#f59e0b';
        systemDot.style.backgroundColor = '#f59e0b';
        badgeTag.innerText = 'PAUSED';
        badgeTag.style.color = '#f59e0b';
      } else {
        systemText.innerText = 'Auto-Dispatching';
        systemText.style.color = '#25D366';
        systemDot.style.backgroundColor = '#25D366';
        badgeTag.innerText = 'DISPATCHING';
        badgeTag.style.color = '#25D366';
      }
    } else {
      systemText.innerText = 'System Ready';
      systemText.style.color = '#00a884';
      systemDot.style.backgroundColor = '#25D366';
      badgeTag.innerText = 'IDLE';
      badgeTag.style.color = '#8696a0';
    }

    // Cooldown Banner & Metric
    const cooldownBanner = document.getElementById('cooldown-banner');
    const cooldownVal = document.getElementById('metric-cooldown-timer');
    const digitalClock = document.getElementById('digital-clock');

    if (currentState.inCooldown && currentState.cooldownEndsAt) {
      cooldownBanner.style.display = 'flex';
      document.getElementById('cooldown-banner-desc').innerText =
        `Daily batch of ${dailyLimit} messages completed safely. Auto-resume is ${currentState.autoResumeAfterCooldown ? 'ENABLED' : 'disabled'}.`;
      const diffMs = currentState.cooldownEndsAt - Date.now();
      if (diffMs > 0) {
        const totalSec = Math.floor(diffMs / 1000);
        const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
        const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
        const s = String(totalSec % 60).padStart(2, '0');
        const formatted = `${h}:${m}:${s}`;
        digitalClock.innerText = formatted;
        cooldownVal.innerText = formatted;
        cooldownVal.style.color = '#f59e0b';
      } else {
        digitalClock.innerText = '00:00:00';
        cooldownVal.innerText = 'Resuming...';
      }

      const nextNum = currentState.currentIndex + 1;
      const nextContact = contacts[currentState.currentIndex];
      const namePart = nextContact ? `(${nextContact.name})` : '';
      document.getElementById('cooldown-resume-info').innerText = `Next batch auto-resumes from Contact #${nextNum} ${namePart}`;
    } else {
      cooldownBanner.style.display = 'none';
      cooldownVal.innerText = 'Inactive';
      cooldownVal.style.color = '#e9edef';
    }

    // Completion Banner
    const completionBanner = document.getElementById('completion-banner');
    if (currentState.campaignCompleted && contacts.length > 0 && pendingCount === 0) {
      completionBanner.style.display = 'flex';
      document.getElementById('completion-banner-desc').innerText =
        `Total ${contacts.length} contacts processed (${sentCount} Sent, ${failedCount} Failed). No pending contacts left.`;
      const watchBadge = document.getElementById('completion-watch-badge');
      watchBadge.innerText = (currentState.autoSyncSheet && currentState.googleSheetUrl)
        ? '👀 Watching Sheet for New Contacts'
        : '✅ Data Cleared';
    } else {
      completionBanner.style.display = 'none';
    }

    // Monitor Progress Area
    const statusDesc = document.getElementById('monitor-status-desc');
    const nextTimer = document.getElementById('monitor-next-timer');
    const logStream = document.getElementById('log-stream');
    const fillBar = document.getElementById('progress-bar-fill');

    if (currentState.campaignCompleted && pendingCount === 0 && contacts.length > 0) {
      statusDesc.innerText = `🎉 Completed all ${contacts.length} contacts!`;
      nextTimer.innerText = '100% Done';
    } else if (currentState.inCooldown) {
      statusDesc.innerText = `⏳ ${currentState.cooldownHours || 26}h Cooldown active (Auto-Resume ON)`;
      nextTimer.innerText = 'Auto-Wait';
    } else if (currentState.waitingForConnection) {
      statusDesc.innerText = '📡 Waiting for Internet / WhatsApp connection...';
      nextTimer.innerText = 'Waiting';
    } else if (currentState.isRunning) {
      if (currentState.isPaused) {
        statusDesc.innerText = '⏸ Campaign paused by operator';
        nextTimer.innerText = 'Paused';
      } else if (currentState.nextDispatchAt && currentState.nextDispatchAt > Date.now()) {
        const remainingSec = Math.max(0, Math.ceil((currentState.nextDispatchAt - Date.now()) / 1000));
        const m = Math.floor(remainingSec / 60);
        const s = remainingSec % 60;
        nextTimer.innerText = `Next in: ${m}m ${s}s`;
        statusDesc.innerText = `⏳ Next dispatch (#${currentState.currentIndex + 1}) in ${remainingSec}s...`;
      } else {
        statusDesc.innerText = '⚡ Actively dispatching...';
        nextTimer.innerText = 'Sending now...';
      }
    } else {
      statusDesc.innerText = pendingCount > 0 ? `Ready (${pendingCount} pending)` : 'Ready to launch';
      nextTimer.innerText = 'Next: --';
    }

    logStream.innerText = currentState.lastLog || 'System ready.';

    const percent = contacts.length > 0
      ? Math.round((processedCount / contacts.length) * 100)
      : 0;
    fillBar.style.width = `${percent}%`;

    // Action Buttons
    const btnStart = document.getElementById('btn-start');
    const btnPause = document.getElementById('btn-pause');
    const btnStop = document.getElementById('btn-stop');

    if (currentState.isRunning) {
      btnStart.style.display = 'none';
      btnPause.style.display = 'flex';
      btnPause.innerText = currentState.isPaused ? '▶️ Resume Campaign' : '⏸ Pause Campaign';
      btnStop.style.display = 'flex';
    } else {
      btnStart.style.display = 'flex';
      if (processedCount > 0 && pendingCount > 0) {
        btnStart.innerText = `🚀 Resume Auto-Batch (From #${currentState.currentIndex + 1} · ${pendingCount} Left)`;
      } else {
        btnStart.innerText = `🚀 Launch Auto-Batch (${dailyLimit}/Day)`;
      }
      btnPause.style.display = 'none';
      btnStop.style.display = 'none';
    }

    // Template Textarea & Sheet URL
    const editor = document.getElementById('template-editor');
    if (document.activeElement !== editor) {
      editor.value = currentState.template || '';
    }
    const sheetInput = document.getElementById('input-sheet-url');
    if (document.activeElement !== sheetInput) {
      sheetInput.value = currentState.googleSheetUrl || '';
    }

    updatePreview();
    renderAudienceTable();
  }

  // Live Message Preview
  function updatePreview() {
    if (!currentState) return;
    const template = document.getElementById('template-editor').value;
    const contacts = currentState.contacts || [];
    const sample = contacts[currentState.currentIndex] || contacts[0] || {
      name: 'Alexander Wright',
      phone: '923001112233',
      customVars: { company: 'Apex Global' }
    };

    let msg = template || '';
    const fullName = sample.name || 'Valued Client';
    const firstName = fullName.split(' ')[0] || fullName;
    msg = msg.replace(/\{(?:name|نام)\}/gi, fullName);
    msg = msg.replace(/\{(?:firstname)\}/gi, firstName);
    msg = msg.replace(/\{(?:phone|number)\}/gi, sample.phone || '');
    if (sample.customVars) {
      Object.keys(sample.customVars).forEach(k => {
        if (!k) return;
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        msg = msg.replace(new RegExp(`\\{${escaped}\\}`, 'gi'), sample.customVars[k] || '');
      });
    }

    // Resolve spintax for preview
    msg = msg.replace(/\{([^{}]+)\}/g, (match, p1) => {
      const opts = p1.split('|');
      return opts.length > 1 ? opts[0] : match;
    });

    document.getElementById('template-preview-box').innerText = msg || '(No template message)';
  }

  // Render Audience Table with Filter and Search
  function renderAudienceTable() {
    if (!currentState) return;
    const tbody = document.getElementById('audience-tbody');
    let list = currentState.contacts || [];

    if (activeFilter === 'sent') list = list.filter(c => c.status === 'sent');
    else if (activeFilter === 'pending') list = list.filter(c => c.status === 'pending');
    else if (activeFilter === 'failed') list = list.filter(c => c.status === 'failed');

    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(c =>
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.phone && c.phone.includes(q)) ||
        (c.customVars && c.customVars.company && c.customVars.company.toLowerCase().includes(q))
      );
    }

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No contacts matched the filter.</td></tr>`;
      return;
    }

    let html = '';
    list.forEach((c, idx) => {
      let badgeClass = 'badge-pending';
      let statusText = 'Pending';
      if (c.status === 'sent') { badgeClass = 'badge-sent'; statusText = 'Dispatched ✓'; }
      else if (c.status === 'failed') { badgeClass = 'badge-failed'; statusText = 'Failed ✗'; }
      else if (c.status === 'sending') { badgeClass = 'badge-sending'; statusText = 'Sending...'; }

      const company = (c.customVars && c.customVars.company) || '-';
      const time = c.sentAt || '-';

      html += `
        <tr>
          <td>${c.id || idx + 1}</td>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td style="font-family:monospace;">${escapeHtml(c.phone)}</td>
          <td>${escapeHtml(company)}</td>
          <td><span class="badge-status ${badgeClass}">${statusText}</span></td>
          <td style="color:#8696a0;">${escapeHtml(time)}</td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  // Settings Modal Controls
  const settingsModal = document.getElementById('settings-modal');
  function openSettingsModal() {
    if (!currentState) return;
    document.getElementById('set-daily-limit').value = currentState.dailyLimit || 30;
    document.getElementById('set-country-code').value = currentState.defaultCountryCode || '92';
    document.getElementById('set-min-interval').value = currentState.minIntervalSec || 60;
    document.getElementById('set-max-interval').value = currentState.maxIntervalSec || 120;
    document.getElementById('set-min-cooldown').value = currentState.minCooldownHours || 24;
    document.getElementById('set-max-cooldown').value = currentState.maxCooldownHours || 28;
    document.getElementById('set-typing-delay').value = currentState.typingDelayMs || 2500;
    document.getElementById('set-sync-interval').value = currentState.autoSyncIntervalMin || 5;

    document.getElementById('set-auto-resume-cooldown').checked = currentState.autoResumeAfterCooldown !== false;
    document.getElementById('set-auto-resume-startup').checked = currentState.autoResumeOnStartup !== false;
    document.getElementById('set-auto-sync-sheet').checked = currentState.autoSyncSheet !== false;
    document.getElementById('set-auto-watch-new').checked = currentState.autoWatchNewContacts !== false;
    document.getElementById('set-minimize-tray').checked = currentAppSettings.minimizeToTray !== false;
    document.getElementById('set-autostart-boot').checked = !!currentAppSettings.autoStartOnBoot;

    settingsModal.style.display = 'flex';
  }

  function closeSettingsModal() {
    settingsModal.style.display = 'none';
  }

  document.getElementById('btn-open-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-close-settings').addEventListener('click', closeSettingsModal);
  document.getElementById('btn-cancel-settings').addEventListener('click', closeSettingsModal);

  document.getElementById('btn-save-settings').addEventListener('click', () => {
    const dailyLimit = Math.max(1, parseInt(document.getElementById('set-daily-limit').value, 10) || 30);
    const defaultCountryCode = (document.getElementById('set-country-code').value || '92').replace(/\D/g, '') || '92';
    const minIntervalSec = Math.max(5, parseInt(document.getElementById('set-min-interval').value, 10) || 60);
    const maxIntervalSec = Math.max(minIntervalSec, parseInt(document.getElementById('set-max-interval').value, 10) || 120);
    const minCooldownHours = Math.max(1, parseFloat(document.getElementById('set-min-cooldown').value) || 24);
    const maxCooldownHours = Math.max(minCooldownHours, parseFloat(document.getElementById('set-max-cooldown').value) || 28);
    const typingDelayMs = Math.max(500, parseInt(document.getElementById('set-typing-delay').value, 10) || 2500);
    const autoSyncIntervalMin = Math.max(1, parseInt(document.getElementById('set-sync-interval').value, 10) || 5);

    const config = {
      dailyLimit,
      defaultCountryCode,
      minIntervalSec,
      maxIntervalSec,
      minCooldownHours,
      maxCooldownHours,
      typingDelayMs,
      autoSyncIntervalMin,
      autoResumeAfterCooldown: document.getElementById('set-auto-resume-cooldown').checked,
      autoResumeOnStartup: document.getElementById('set-auto-resume-startup').checked,
      autoSyncSheet: document.getElementById('set-auto-sync-sheet').checked,
      autoWatchNewContacts: document.getElementById('set-auto-watch-new').checked,
      appSettings: {
        minimizeToTray: document.getElementById('set-minimize-tray').checked,
        autoStartOnBoot: document.getElementById('set-autostart-boot').checked
      }
    };

    chrome.runtime.sendMessage({ action: 'updateConfig', config }, () => {
      syncWithBackground();
      closeSettingsModal();
    });
  });

  // Event Listeners: Template Edit
  const editor = document.getElementById('template-editor');
  editor.addEventListener('input', () => {
    updatePreview();
    const savedBadge = document.getElementById('badge-template-saved');
    savedBadge.innerText = 'Saving...';
    chrome.runtime.sendMessage({
      action: 'updateConfig',
      config: { template: editor.value }
    }, () => {
      savedBadge.innerText = 'Saved ✓';
    });
  });

  // Tag Insert Buttons
  document.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.getAttribute('data-insert');
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = editor.value.substring(0, start) + tag + editor.value.substring(end);
      editor.focus();
      editor.selectionStart = editor.selectionEnd = start + tag.length;
      updatePreview();
      chrome.runtime.sendMessage({
        action: 'updateConfig',
        config: { template: editor.value }
      });
    });
  });

  // Action Buttons
  document.getElementById('btn-start').addEventListener('click', () => {
    if (!currentState || !currentState.contacts.length) {
      alert('Please connect a Google Sheet, upload an Excel file, or click "Load 35 Sample Leads".');
      return;
    }
    chrome.runtime.sendMessage({
      action: 'startCampaign',
      config: {
        template: editor.value,
        googleSheetUrl: document.getElementById('input-sheet-url').value
      }
    }, syncWithBackground);
  });

  document.getElementById('btn-pause').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'pauseCampaign' }, syncWithBackground);
  });

  document.getElementById('btn-stop').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopCampaign' }, syncWithBackground);
  });

  document.getElementById('btn-skip-cooldown').addEventListener('click', () => {
    if (confirm('Manually override variable cooldown and dispatch the next batch now?')) {
      chrome.runtime.sendMessage({ action: 'skipCooldown' }, syncWithBackground);
    }
  });

  // Open WhatsApp Web inside Desktop App tab
  function openWhatsAppView() {
    chrome.runtime.sendMessage({ action: 'openWhatsAppTab' });
  }

  document.getElementById('btn-open-wa-tab').addEventListener('click', openWhatsAppView);

  // Toggle Paste Box
  const btnTogglePaste = document.getElementById('btn-toggle-paste');
  const pasteBox = document.getElementById('paste-box-container');
  if (btnTogglePaste && pasteBox) {
    btnTogglePaste.addEventListener('click', () => {
      pasteBox.style.display = pasteBox.style.display === 'block' ? 'none' : 'block';
    });
  }

  // Import Pasted Contacts (Smart Merge - Preserves Progress!)
  const btnImportPasted = document.getElementById('btn-import-pasted');
  if (btnImportPasted) {
    btnImportPasted.addEventListener('click', () => {
      const text = document.getElementById('paste-textarea').value;
      const cc = (currentState && currentState.defaultCountryCode) || '92';
      const contacts = window.WACRMParser.parseManualInput(text, cc);
      if (contacts.length) {
        chrome.runtime.sendMessage({
          action: 'updateConfig',
          config: { contacts, sourceLabel: 'Excel Paste' }
        }, () => {
          syncWithBackground();
          pasteBox.style.display = 'none';
          alert(`List updated with ${contacts.length} contacts! Sent history & progress preserved.`);
        });
      } else {
        alert('Please paste valid contact rows from Excel.');
      }
    });
  }

  // Sync Live Spreadsheet (Smart Merge - Preserves Progress!)
  document.getElementById('btn-sync-sheet').addEventListener('click', async () => {
    const url = document.getElementById('input-sheet-url').value.trim();
    if (!url) {
      alert('Please enter a valid spreadsheet link.');
      return;
    }
    try {
      const cc = (currentState && currentState.defaultCountryCode) || '92';
      const contacts = await window.WACRMParser.fetchLiveSpreadsheet(url, cc);
      if (contacts.length) {
        chrome.runtime.sendMessage({
          action: 'updateConfig',
          config: {
            contacts,
            googleSheetUrl: url,
            sourceLabel: 'Google Sheet'
          }
        }, () => {
          syncWithBackground();
          alert(`Synced ${contacts.length} contacts! Already-sent numbers kept intact — resuming from next pending number.`);
        });
      } else {
        alert('No contacts found in the spreadsheet.');
      }
    } catch (err) {
      alert(`Spreadsheet Sync Notice:\n\n${err.message}`);
    }
  });

  // Excel / CSV File Dropzone (Smart Merge - Preserves Progress!)
  const dropzone = document.getElementById('excel-dropzone');
  const fileInput = document.getElementById('excel-file-input');
  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', e => { e.preventDefault(); });
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const cc = (currentState && currentState.defaultCountryCode) || '92';

    if (ext === 'xlsx' || ext === 'xls') {
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const buffer = ev.target.result;
          const contacts = window.WACRMParser.parseExcelArrayBuffer(buffer, cc);
          if (contacts.length) {
            chrome.runtime.sendMessage({
              action: 'updateConfig',
              config: { contacts, sourceLabel: 'Excel File' }
            }, () => {
              syncWithBackground();
              alert(`Loaded ${contacts.length} contacts from Excel! Sent progress preserved.`);
            });
          }
        } catch (err) {
          alert(`Excel Error: ${err.message}`);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const contacts = window.WACRMParser.parseCSV(ev.target.result, cc);
          if (contacts.length) {
            chrome.runtime.sendMessage({
              action: 'updateConfig',
              config: { contacts, sourceLabel: 'CSV File' }
            }, () => {
              syncWithBackground();
              alert(`Loaded ${contacts.length} contacts from CSV! Sent progress preserved.`);
            });
          }
        } catch (err) {
          alert(`CSV Error: ${err.message}`);
        }
      };
      reader.readAsText(file);
    }
  }

  // Load 35 Sample Leads
  document.getElementById('btn-load-sample').addEventListener('click', () => {
    const cc = (currentState && currentState.defaultCountryCode) || '92';
    const contacts = SAMPLE_CONTACTS.map((item, idx) => ({
      id: idx + 1,
      name: item.name,
      phone: window.WACRMParser.normalizePhone(item.phone, cc),
      rawPhone: item.phone,
      customVars: { name: item.name, phone: item.phone, company: item.company },
      status: 'pending',
      errorMessage: '',
      sentAt: null
    }));

    chrome.runtime.sendMessage({
      action: 'updateConfig',
      config: { contacts, sourceLabel: 'Sample Leads' }
    }, () => {
      syncWithBackground();
      alert('Loaded 35 Sample Leads! Sent progress preserved.');
    });
  });

  // Clear Audience
  document.getElementById('btn-clear-contacts').addEventListener('click', () => {
    if (confirm('Clear all audience contacts and reset sent history?')) {
      chrome.runtime.sendMessage({
        action: 'updateConfig',
        config: { contacts: [], clearAll: true }
      }, syncWithBackground);
    }
  });

  // Filters
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.getAttribute('data-filter');
      renderAudienceTable();
    });
  });

  // Search
  document.getElementById('search-contacts').addEventListener('input', e => {
    searchTerm = e.target.value;
    renderAudienceTable();
  });

  // Retry / Reset Entire Sheet
  const btnRetryFailed = document.getElementById('btn-retry-failed');
  if (btnRetryFailed) {
    btnRetryFailed.addEventListener('click', () => {
      if (!confirm('Reset all contacts in the current list back to Pending?')) return;
      chrome.runtime.sendMessage({ action: 'resetAndRetryEntireSheet' }, response => {
        syncWithBackground();
        if (response && response.count > 0) {
          alert(`Success: All ${response.count} contacts reset to Pending!\n\nClick "Launch Auto-Batch" to start sending.`);
        } else {
          alert('No contacts found in sheet to retry.');
        }
      });
    });
  }

  // Export CSV Report
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    if (!currentState || !currentState.contacts.length) {
      alert('No contacts available to export.');
      return;
    }
    let csv = 'ID,Name,Phone,Company,Status,DispatchedAt,Error\n';
    currentState.contacts.forEach(c => {
      const co = (c.customVars && c.customVars.company) || '';
      csv += `"${c.id}","${(c.name || '').replace(/"/g, '""')}","${c.phone}","${co.replace(/"/g, '""')}","${c.status}","${c.sentAt || ''}","${(c.errorMessage || '').replace(/"/g, '""')}"\n`;
    });
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wacrm_report_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 500);
  });

  // WhatsApp Connection Status Checker
  function checkWhatsAppConnection() {
    chrome.runtime.sendMessage({ action: 'checkWhatsAppStatus' }, response => {
      const badge = document.getElementById('badge-wa-conn');
      const desc = document.getElementById('wa-conn-desc');
      const icon = document.getElementById('wa-status-icon');
      const btn = document.getElementById('btn-wa-connect-action');
      if (!badge) return;

      if (response && response.connected) {
        badge.className = 'badge-conn-status connected';
        badge.innerText = '🟢 WhatsApp Linked & Ready (منسلک ہے اور تیار ہے)';
        desc.innerText = 'Active WhatsApp session connected. All messages will be automatically sent from your linked number.';
        icon.innerText = '✅';
        btn.innerText = '🟢 Sender WhatsApp Connected (واٹس ایپ منسلک ہے)';
      } else if (response && response.needsQR) {
        badge.className = 'badge-conn-status warning';
        badge.innerText = '⚠️ Scan QR Code to Link (کیو آر کوڈ اسکین کریں)';
        desc.innerText = 'Open WhatsApp on your phone -> Settings/Menu -> Linked Devices -> Scan QR Code.';
        icon.innerText = '📷';
        btn.innerText = '📲 Link WhatsApp via QR Code (واٹس ایپ لنک کریں)';
      } else if (response && response.loading) {
        badge.className = 'badge-conn-status warning';
        badge.innerText = '⏳ Connecting WhatsApp...';
        desc.innerText = 'WhatsApp session connecting. Please wait a few seconds...';
        icon.innerText = '⏳';
        btn.innerText = '⏳ Connecting WhatsApp...';
      } else {
        badge.className = 'badge-conn-status offline';
        badge.innerText = '⚠️ WhatsApp Not Connected (واٹس ایپ لنک نہیں ہے)';
        desc.innerText = 'Click the button to link your marketing WhatsApp account via QR Code.';
        icon.innerText = '📱';
        btn.innerText = '🔗 Link WhatsApp Account (واٹس ایپ منسلک کریں)';
      }
    });
  }

  const btnWaConnect = document.getElementById('btn-wa-connect-action');
  if (btnWaConnect) {
    btnWaConnect.addEventListener('click', openWhatsAppView);
  }

  // Sync ticker every 1 second
  syncWithBackground();
  checkWhatsAppConnection();
  tickerTimer = setInterval(() => {
    syncWithBackground();
    checkWhatsAppConnection();
  }, 1000);

  window.addEventListener('unload', () => {
    if (tickerTimer) clearInterval(tickerTimer);
  });
});
