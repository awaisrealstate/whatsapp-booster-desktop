/**
 * WhatsApp Booster Desktop - Native Bridge & Autonomous Campaign Orchestrator
 * Features:
 * - Smart List Merge: Updates/appends contacts (200, 500, 700, 1000+) WITHOUT resetting progress to 0
 * - Persistent Sent History: Remembers sent numbers across sheet updates and app restarts
 * - Autonomous Cooldown & Auto-Resume: Automatically continues Day 2, Day 3... batches after cooldown
 * - Google Sheet Auto-Sync: Periodically fetches sheet updates in background
 * - Connection Guard: Waits cleanly if offline/disconnected instead of failing contacts
 * - Completion Indication: Notifies when all contacts in list are completed
 */

(function (root) {
  'use strict';

  function normalizePhoneNumber(rawPhone, defaultCountryCode = '92') {
    if (typeof window !== 'undefined' && window.WACRMParser && typeof window.WACRMParser.normalizePhone === 'function') {
      return window.WACRMParser.normalizePhone(rawPhone, defaultCountryCode);
    }
    let cleaned = String(rawPhone || '').trim().replace(/[\s\-\(\)\.\–\—]/g, '');
    if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
    cleaned = cleaned.replace(/\D/g, '');
    if (!cleaned) return '';

    if (cleaned.startsWith('0092')) cleaned = cleaned.substring(2);
    else if (cleaned.startsWith('00')) cleaned = cleaned.substring(2);

    if (cleaned.startsWith('92') && (cleaned.length === 12 || cleaned.length === 11)) return cleaned;
    if (cleaned.startsWith('03') && cleaned.length === 11) return '92' + cleaned.substring(1);
    if (cleaned.startsWith('3') && cleaned.length === 10) return '92' + cleaned;

    const cc = String(defaultCountryCode || '92').replace(/\D/g, '') || '92';
    if (cleaned.startsWith('0') && cleaned.length >= 9 && cleaned.length <= 11) {
      return cc + cleaned.substring(1);
    }
    if (cleaned.length === 10 && !cleaned.startsWith(cc)) {
      return cc + cleaned;
    }
    return cleaned;
  }

  /**
   * Pure Smart Merge function:
   * Merges incoming contacts with existing contacts + persistent sentPhoneHistory
   * so already-sent contacts stay 'sent', newly added contacts become 'pending',
   * and progress NEVER resets to 0 when a sheet or Excel list updates.
   */
  function mergeContactsPreserveProgress(existingContacts, incomingContacts, sentPhoneHistory = {}, defaultCountryCode = '92') {
    const statusByPhone = { ...(sentPhoneHistory || {}) };

    (existingContacts || []).forEach(c => {
      const clean = normalizePhoneNumber(c.phone || c.rawPhone, defaultCountryCode);
      if (!clean) return;
      if (c.status === 'sent' || c.status === 'failed') {
        statusByPhone[clean] = {
          status: c.status,
          sentAt: c.sentAt || null,
          errorMessage: c.errorMessage || ''
        };
      }
    });

    const seen = new Set();
    const merged = [];
    let preservedSent = 0;
    let newlyAdded = 0;

    (incomingContacts || []).forEach((item) => {
      const clean = normalizePhoneNumber(item.phone || item.rawPhone, defaultCountryCode);
      if (!clean || seen.has(clean)) return;
      seen.add(clean);

      const prior = statusByPhone[clean];
      let status = 'pending';
      let sentAt = null;
      let errorMessage = '';

      if (prior && (prior.status === 'sent' || prior.status === 'failed')) {
        status = prior.status;
        sentAt = prior.sentAt || null;
        errorMessage = prior.errorMessage || '';
        if (status === 'sent') preservedSent++;
      } else {
        newlyAdded++;
      }

      const name = String(item.name || '').trim() || 'Valued Client';
      const customVars = {
        ...(item.customVars || {}),
        name,
        phone: clean
      };

      merged.push({
        id: merged.length + 1,
        name,
        phone: clean,
        rawPhone: String(item.rawPhone || item.phone || clean).trim(),
        customVars,
        status,
        errorMessage,
        sentAt
      });
    });

    const firstPendingIndex = merged.findIndex(c => c.status === 'pending');
    const nextIndex = firstPendingIndex === -1 ? merged.length : firstPendingIndex;
    const pendingCount = merged.filter(c => c.status === 'pending').length;

    return {
      contacts: merged,
      sentPhoneHistory: statusByPhone,
      nextIndex,
      pendingCount,
      preservedSent,
      newlyAdded
    };
  }

  function findNextPendingIndex(contacts) {
    if (!Array.isArray(contacts)) return 0;
    const idx = contacts.findIndex(c => c.status === 'pending');
    return idx === -1 ? contacts.length : idx;
  }

  function formatMessageText(template, contact) {
    let msg = template || 'Hi {name}, hope you are doing well!';
    const fullName = (contact && contact.name) || 'Valued Client';
    const firstName = fullName.split(' ')[0] || fullName;

    msg = msg.replace(/\{(?:name|نام)\}/gi, fullName);
    msg = msg.replace(/\{(?:firstname)\}/gi, firstName);
    msg = msg.replace(/\{(?:phone|number)\}/gi, (contact && contact.phone) || '');

    if (contact && contact.customVars) {
      Object.keys(contact.customVars).forEach(k => {
        if (!k) return;
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        msg = msg.replace(new RegExp(`\\{${escaped}\\}`, 'gi'), contact.customVars[k] || '');
      });
    }

    // Spintax {opt1|opt2}
    const regex = /\{([^{}]+)\}/g;
    let match;
    while ((match = regex.exec(msg)) !== null) {
      const fullMatch = match[0];
      const options = match[1].split('|');
      if (options.length === 1) continue;
      const chosen = options[Math.floor(Math.random() * options.length)].trim();
      msg = msg.replace(fullMatch, chosen);
      regex.lastIndex = 0;
    }
    return msg;
  }

  // Export pure helpers for Node testing if running outside browser
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalizePhoneNumber,
      mergeContactsPreserveProgress,
      findNextPendingIndex,
      formatMessageText
    };
  }

  if (typeof window === 'undefined') {
    return;
  }

  // Desktop Local Storage Shim
  const Storage = {
    get: function (keys, callback) {
      try {
        const raw = localStorage.getItem('wacrm_desktop_state');
        const data = raw ? JSON.parse(raw) : {};
        if (typeof keys === 'string') {
          const res = {};
          res[keys] = data[keys];
          callback(res);
        } else if (Array.isArray(keys)) {
          const res = {};
          keys.forEach(k => { res[k] = data[k]; });
          callback(res);
        } else if (typeof keys === 'object' && keys !== null) {
          const res = { ...keys };
          Object.keys(keys).forEach(k => {
            if (data[k] !== undefined) res[k] = data[k];
          });
          callback(res);
        } else {
          callback(data);
        }
      } catch (e) {
        callback({});
      }
    },
    set: function (items, callback) {
      try {
        const raw = localStorage.getItem('wacrm_desktop_state');
        const data = raw ? JSON.parse(raw) : {};
        Object.assign(data, items);
        localStorage.setItem('wacrm_desktop_state', JSON.stringify(data));
      } catch (e) {
        console.error('Storage set error:', e);
      }
      if (typeof callback === 'function') callback();
    }
  };

  function createDefaultState() {
    return {
      contacts: [],
      sentPhoneHistory: {},
      currentIndex: 0,
      batchSentCount: 0,
      dailyLimit: 30,
      minIntervalSec: 60,
      maxIntervalSec: 120,
      minCooldownHours: 24,
      maxCooldownHours: 28,
      typingDelayMs: 2500,
      defaultCountryCode: '92',
      autoResumeAfterCooldown: true,
      autoResumeOnStartup: true,
      autoSyncSheet: true,
      autoSyncIntervalMin: 5,
      autoWatchNewContacts: true,
      isRunning: false,
      isPaused: false,
      wasActiveCampaign: false,
      autoWatchActive: false,
      waitingForConnection: false,
      inCooldown: false,
      cooldownEndsAt: null,
      cooldownHours: 26,
      campaignCompleted: false,
      completionNotifiedAt: null,
      lastSheetSyncAt: null,
      template: 'Hi {name}, hope you are doing well!',
      googleSheetUrl: '',
      lastLog: 'Desktop Engine initialized & ready.',
      nextDispatchAt: null,
      nextDispatchInSec: 0,
      updatedAt: 0
    };
  }

  // Internal Orchestrator
  const Orchestrator = {
    state: createDefaultState(),
    appSettings: {
      minimizeToTray: true,
      autoStartOnBoot: false
    },

    timerId: null,
    schedulerTimerId: null,
    sheetSyncTimerId: null,
    isDispatching: false,
    isSyncingSheet: false,
    lastWaStatus: false,
    lastWaNeedsQR: false,
    lastWaLoading: false,
    diskLoaded: false,

    init: function () {
      // Load localStorage immediately
      Storage.get('wacrm_engine_state', (saved) => {
        if (saved && saved.wacrm_engine_state) {
          this.hydrateState(saved.wacrm_engine_state);
        }
      });

      // Request authoritative JSON backup from Electron user_data
      try {
        window.parent.postMessage({ action: 'HOST_LOAD_STATE' }, '*');
      } catch (e) {}

      // Listen for host events (strictly verify parent window source)
      window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        if (!event.data || typeof event.data !== 'object') return;

        if (event.data.action === 'HOST_DISPATCH_RESULT') {
          this.handleDispatchResult(event.data.result);
        }

        if (event.data.action === 'HOST_WA_STATUS') {
          const prevConnected = this.lastWaStatus;
          this.lastWaStatus = !!event.data.status;
          this.lastWaNeedsQR = !!event.data.needsQR;
          this.lastWaLoading = !!event.data.loading;

          if (!prevConnected && this.lastWaStatus) {
            this.onWhatsAppConnected();
          }
        }

        if (event.data.action === 'HOST_STATE_LOADED') {
          this.diskLoaded = true;
          if (event.data.appSettings) {
            this.appSettings = { ...this.appSettings, ...event.data.appSettings };
          }
          if (event.data.state && (!this.state.updatedAt || (event.data.state.updatedAt || 0) >= this.state.updatedAt)) {
            this.hydrateState(event.data.state);
          }
          this.onStartupReady();
        }

        if (event.data.action === 'HOST_APP_SETTINGS_UPDATED' && event.data.appSettings) {
          this.appSettings = { ...this.appSettings, ...event.data.appSettings };
        }
      });

      // Background scheduler tick every 5s (handles cooldown expiry, offline retry, auto-resume)
      this.schedulerTimerId = setInterval(() => this.tickScheduler(), 5000);

      // Background Google Sheet auto-sync check every 30s (runs fetch when interval elapsed)
      this.sheetSyncTimerId = setInterval(() => this.maybeAutoSyncSheet(), 30000);
    },

    hydrateState: function (savedState) {
      const defaults = createDefaultState();
      this.state = {
        ...defaults,
        ...savedState,
        isRunning: false,
        isPaused: false,
        waitingForConnection: false,
        nextDispatchAt: null
      };

      // Recover any contact left in 'sending' during an abrupt shutdown
      if (Array.isArray(this.state.contacts)) {
        this.state.contacts.forEach(c => {
          if (c.status === 'sending') c.status = 'pending';
        });
      }

      this.state.currentIndex = findNextPendingIndex(this.state.contacts);
      this.updateCompletionFlag(false);
    },

    onStartupReady: function () {
      // Check if cooldown already expired while app was closed
      if (this.state.inCooldown && this.state.cooldownEndsAt && Date.now() >= this.state.cooldownEndsAt) {
        this.completeCooldown(true);
        return;
      }

      const pendingCount = this.getPendingCount();
      if (this.state.wasActiveCampaign && this.state.autoResumeOnStartup && !this.state.inCooldown && pendingCount > 0) {
        this.state.isRunning = true;
        this.state.isPaused = false;
        this.state.lastLog = '🔄 Auto-resuming campaign from where it left off...';
        this.save();
        this.dispatchNext();
      } else if (this.state.autoSyncSheet && this.state.googleSheetUrl) {
        this.maybeAutoSyncSheet(true);
      }
    },

    onWhatsAppConnected: function () {
      if (this.state.waitingForConnection && this.state.isRunning && !this.state.isPaused && !this.state.inCooldown && !this.isDispatching) {
        this.state.waitingForConnection = false;
        this.state.lastLog = '🟢 WhatsApp & Internet connected! Resuming dispatch...';
        this.save();
        this.dispatchNext();
      }
    },

    save: function () {
      this.state.updatedAt = Date.now();
      Storage.set({ wacrm_engine_state: this.state });
      try {
        window.parent.postMessage({
          action: 'HOST_SAVE_STATE',
          state: this.state
        }, '*');
      } catch (e) {}
    },

    notifyDesktop: function (title, body) {
      try {
        window.parent.postMessage({
          action: 'HOST_NOTIFY',
          payload: { title, body }
        }, '*');
      } catch (e) {}
    },

    getPendingCount: function () {
      return (this.state.contacts || []).filter(c => c.status === 'pending').length;
    },

    getSentCount: function () {
      return (this.state.contacts || []).filter(c => c.status === 'sent').length;
    },

    getFailedCount: function () {
      return (this.state.contacts || []).filter(c => c.status === 'failed').length;
    },

    updateCompletionFlag: function (notifyIfNewlyCompleted = true) {
      const total = this.state.contacts.length;
      const pending = this.getPendingCount();

      if (total > 0 && pending === 0) {
        const wasCompleted = this.state.campaignCompleted;
        this.state.campaignCompleted = true;
        this.state.isRunning = false;
        this.state.isPaused = false;
        this.state.waitingForConnection = false;
        this.state.nextDispatchAt = null;
        this.state.wasActiveCampaign = false;

        if (!wasCompleted && notifyIfNewlyCompleted) {
          const sent = this.getSentCount();
          const failed = this.getFailedCount();
          this.state.completionNotifiedAt = Date.now();
          this.state.lastLog = `🎉 Data Cleared / Completed! All ${total} contacts processed (${sent} sent, ${failed} failed).`;
          this.notifyDesktop(
            '🎉 Campaign Completed — Data Cleared!',
            `All ${total} contacts have been processed (${sent} sent, ${failed} failed).`
          );
        }
      } else {
        this.state.campaignCompleted = false;
      }
    },

    applySmartMerge: function (incomingContacts, sourceLabel = 'List') {
      const result = mergeContactsPreserveProgress(
        this.state.contacts,
        incomingContacts,
        this.state.sentPhoneHistory,
        this.state.defaultCountryCode || '92'
      );

      this.state.contacts = result.contacts;
      this.state.sentPhoneHistory = result.sentPhoneHistory;
      this.state.currentIndex = result.nextIndex;
      this.updateCompletionFlag(false);

      this.state.lastLog = `[${new Date().toLocaleTimeString()}] 📋 ${sourceLabel} updated: ${result.contacts.length} total (${result.preservedSent} already sent kept, +${result.newlyAdded} new pending).`;
      this.save();

      // If autoWatch is active and new pending contacts arrived, resume automatically
      if (
        result.newlyAdded > 0 &&
        this.state.autoWatchNewContacts &&
        this.state.autoWatchActive &&
        !this.state.isRunning &&
        !this.state.isPaused &&
        !this.state.inCooldown
      ) {
        this.start(true);
      }

      return result;
    },

    maybeAutoSyncSheet: async function (force = false) {
      if (!this.state.autoSyncSheet || !this.state.googleSheetUrl) return;
      if (this.isSyncingSheet || typeof window.WACRMParser === 'undefined') return;

      const intervalMs = Math.max(1, parseInt(this.state.autoSyncIntervalMin, 10) || 5) * 60 * 1000;
      if (!force && this.state.lastSheetSyncAt && (Date.now() - this.state.lastSheetSyncAt) < intervalMs) {
        return;
      }

      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

      this.isSyncingSheet = true;
      try {
        const fetched = await window.WACRMParser.fetchLiveSpreadsheet(
          this.state.googleSheetUrl,
          this.state.defaultCountryCode || '92'
        );
        this.state.lastSheetSyncAt = Date.now();
        if (Array.isArray(fetched) && fetched.length > 0) {
          this.applySmartMerge(fetched, 'Auto-Sync Sheet');
        } else {
          this.save();
        }
      } catch (e) {
        // Silent background retry on next interval
        this.state.lastSheetSyncAt = Date.now();
      } finally {
        this.isSyncingSheet = false;
      }
    },

    tickScheduler: function () {
      // 1. Check Cooldown Expiration
      if (this.state.inCooldown && this.state.cooldownEndsAt) {
        if (Date.now() >= this.state.cooldownEndsAt) {
          this.completeCooldown(false);
          return;
        }
      }

      // 2. Retry if waiting for internet / WhatsApp connection
      if (this.state.isRunning && !this.state.isPaused && !this.state.inCooldown && !this.isDispatching && this.state.waitingForConnection) {
        const isOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
        if (isOnline && this.lastWaStatus) {
          this.state.waitingForConnection = false;
          this.state.lastLog = '🟢 Connection restored! Continuing campaign...';
          this.save();
          this.dispatchNext();
        }
      }
    },

    completeCooldown: function (fromStartup = false) {
      this.state.inCooldown = false;
      this.state.cooldownEndsAt = null;
      this.state.batchSentCount = 0;

      const pendingCount = this.getPendingCount();
      if (pendingCount > 0 && this.state.autoResumeAfterCooldown && (this.state.wasActiveCampaign || fromStartup)) {
        this.state.isRunning = true;
        this.state.isPaused = false;
        this.state.currentIndex = findNextPendingIndex(this.state.contacts);
        this.state.lastLog = `🎉 Cooldown complete! Auto-resuming from Contact #${this.state.currentIndex + 1}...`;
        this.save();
        this.notifyDesktop('🚀 Daily Batch Resumed', `Cooldown complete. Continuing from Contact #${this.state.currentIndex + 1}.`);
        this.dispatchNext();
      } else {
        this.updateCompletionFlag(true);
        if (!this.state.campaignCompleted) {
          this.state.lastLog = '✅ Cooldown complete. Ready for next batch.';
        }
        this.save();
      }
    },

    start: function (isAutoResume = false) {
      const pendingCount = this.getPendingCount();
      if (this.state.contacts.length === 0) {
        this.state.lastLog = '❌ No audience loaded. Please import Excel or Google Sheet.';
        this.save();
        return;
      }
      if (pendingCount === 0) {
        this.updateCompletionFlag(true);
        this.save();
        return;
      }
      if (this.state.inCooldown) {
        if (this.state.cooldownEndsAt && Date.now() >= this.state.cooldownEndsAt) {
          this.completeCooldown(false);
          return;
        }
        this.state.wasActiveCampaign = true;
        this.state.autoWatchActive = true;
        this.state.lastLog = '⏳ Cooldown active. Campaign will auto-resume automatically when cooldown ends.';
        this.save();
        return;
      }

      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }

      this.state.currentIndex = findNextPendingIndex(this.state.contacts);
      this.state.isRunning = true;
      this.state.isPaused = false;
      this.state.wasActiveCampaign = true;
      this.state.autoWatchActive = true;
      this.state.campaignCompleted = false;
      this.state.lastLog = isAutoResume
        ? `🚀 Auto-resumed from Contact #${this.state.currentIndex + 1}.`
        : `🚀 Campaign started from Contact #${this.state.currentIndex + 1}.`;
      this.save();
      this.dispatchNext();
    },

    pause: function () {
      if (this.state.isPaused && this.state.isRunning) {
        // Toggle back to resume if called while paused
        this.state.isPaused = false;
        this.state.wasActiveCampaign = true;
        this.state.lastLog = '▶️ Campaign resumed.';
        this.save();
        this.dispatchNext();
        return;
      }

      this.state.isRunning = true;
      this.state.isPaused = true;
      this.state.wasActiveCampaign = false;
      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
      this.state.nextDispatchAt = null;
      this.state.lastLog = '⏸️ Campaign paused.';
      this.save();
    },

    stop: function () {
      this.state.isRunning = false;
      this.state.isPaused = false;
      this.state.wasActiveCampaign = false;
      this.state.autoWatchActive = false;
      this.state.waitingForConnection = false;
      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
      this.state.nextDispatchAt = null;
      this.state.lastLog = '⏹️ Campaign stopped.';
      this.save();
    },

    dispatchNext: async function () {
      if (!this.state.isRunning || this.state.isPaused || this.state.inCooldown) return;
      if (this.isDispatching) return;

      if (this.state.batchSentCount >= (this.state.dailyLimit || 30)) {
        this.engageCooldown();
        return;
      }

      const nextIdx = findNextPendingIndex(this.state.contacts);
      this.state.currentIndex = nextIdx;

      if (nextIdx >= this.state.contacts.length) {
        this.updateCompletionFlag(true);
        this.save();
        return;
      }

      // Connection & Internet Guard: never fail contacts if offline/disconnected!
      const isOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (!isOnline || !this.lastWaStatus) {
        this.state.waitingForConnection = true;
        this.state.nextDispatchAt = null;
        this.state.lastLog = !isOnline
          ? '📡 Internet disconnected — waiting to auto-resume when online...'
          : '📱 WhatsApp not connected — waiting for WhatsApp session to resume...';
        this.save();
        return;
      }

      this.state.waitingForConnection = false;
      const contact = this.state.contacts[nextIdx];
      contact.status = 'sending';
      this.isDispatching = true;
      this.state.nextDispatchAt = null;

      const cleanPhone = normalizePhoneNumber(contact.phone || contact.rawPhone, this.state.defaultCountryCode || '92');
      contact.phone = cleanPhone;
      const messageText = formatMessageText(this.state.template, contact);

      this.state.lastLog = `[${new Date().toLocaleTimeString()}] Sending #${nextIdx + 1}: ${contact.name} (${cleanPhone})...`;
      this.save();

      window.parent.postMessage({
        action: 'DESKTOP_EXECUTE_DISPATCH',
        contact: { ...contact, phone: cleanPhone },
        messageText: messageText,
        dispatchToken: `tok_${cleanPhone}_${Date.now()}`,
        typingDelayMs: parseInt(this.state.typingDelayMs, 10) || 2500
      }, '*');
    },

    handleDispatchResult: function (result) {
      this.isDispatching = false;
      const idx = this.state.currentIndex;

      if (idx >= 0 && idx < this.state.contacts.length) {
        const contact = this.state.contacts[idx];
        const cleanPhone = normalizePhoneNumber(contact.phone || contact.rawPhone, this.state.defaultCountryCode || '92');

        if (result && result.success) {
          contact.status = 'sent';
          contact.sentAt = new Date().toLocaleTimeString();
          contact.errorMessage = '';
          this.state.sentPhoneHistory[cleanPhone] = {
            status: 'sent',
            sentAt: contact.sentAt,
            errorMessage: ''
          };
          this.state.batchSentCount++;
          this.state.lastLog = `[${new Date().toLocaleTimeString()}] ✅ Sent #${idx + 1} (${contact.name}) — Batch: ${this.state.batchSentCount}/${this.state.dailyLimit}`;
        } else {
          contact.status = 'failed';
          contact.errorMessage = (result && result.error) || 'Failed to send';
          this.state.sentPhoneHistory[cleanPhone] = {
            status: 'failed',
            sentAt: null,
            errorMessage: contact.errorMessage
          };
          this.state.lastLog = `[${new Date().toLocaleTimeString()}] ❌ Failed #${idx + 1} (${contact.name}): ${contact.errorMessage}`;
        }
      }

      this.state.currentIndex = findNextPendingIndex(this.state.contacts);

      // Check if all contacts in the entire list are finished
      if (this.getPendingCount() === 0) {
        this.updateCompletionFlag(true);
        this.save();
        return;
      }

      // Check daily batch limit
      if (this.state.batchSentCount >= (this.state.dailyLimit || 30)) {
        this.engageCooldown();
        return;
      }

      this.save();

      // Schedule next contact with configured random interval
      if (this.state.isRunning && !this.state.isPaused) {
        const minSec = Math.max(5, parseInt(this.state.minIntervalSec, 10) || 60);
        const maxSec = Math.max(minSec, parseInt(this.state.maxIntervalSec, 10) || 120);
        const delaySec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;

        this.state.nextDispatchAt = Date.now() + (delaySec * 1000);
        this.state.nextDispatchInSec = delaySec;
        this.state.lastLog = `[${new Date().toLocaleTimeString()}] ⏱️ Next dispatch (#${this.state.currentIndex + 1}) in ${delaySec}s (${Math.floor(delaySec / 60)}m ${delaySec % 60}s)...`;
        this.save();

        this.timerId = setTimeout(() => {
          this.dispatchNext();
        }, delaySec * 1000);
      }
    },

    engageCooldown: function () {
      this.state.isRunning = false;
      this.state.isPaused = false;
      this.state.inCooldown = true;
      this.state.wasActiveCampaign = true;
      this.state.nextDispatchAt = null;

      const minH = Math.max(1, parseFloat(this.state.minCooldownHours) || 24);
      const maxH = Math.max(minH, parseFloat(this.state.maxCooldownHours) || 28);
      const hours = parseFloat((minH + Math.random() * (maxH - minH)).toFixed(1));
      this.state.cooldownHours = hours;
      this.state.cooldownEndsAt = Date.now() + (hours * 3600 * 1000);

      const nextNum = findNextPendingIndex(this.state.contacts) + 1;
      this.state.lastLog = `🛑 Daily batch reached (${this.state.batchSentCount}/${this.state.dailyLimit}). ${hours}h anti-ban cooldown active — will auto-resume from Contact #${nextNum}.`;
      this.save();

      this.notifyDesktop(
        '⏳ Daily Batch Completed — Cooldown Active',
        `${this.state.batchSentCount} messages sent. Auto-resume scheduled in ${hours}h from Contact #${nextNum}.`
      );
    }
  };

  Orchestrator.init();

  // Expose Chrome-compatible API for dashboard.js
  window.chrome = {
    storage: {
      local: Storage
    },
    runtime: {
      lastError: null,
      sendMessage: function (message, responseCallback) {
        const action = message && message.action;
        let response = {};

        switch (action) {
          case 'getState':
            response = {
              state: { ...Orchestrator.state },
              appSettings: { ...Orchestrator.appSettings }
            };
            break;

          case 'updateConfig': {
            const cfg = message.config || {};
            if (Array.isArray(cfg.contacts)) {
              if (cfg.contacts.length === 0 && cfg.clearAll) {
                Orchestrator.state.contacts = [];
                Orchestrator.state.sentPhoneHistory = {};
                Orchestrator.state.currentIndex = 0;
                Orchestrator.state.campaignCompleted = false;
                Orchestrator.state.wasActiveCampaign = false;
                Orchestrator.state.autoWatchActive = false;
                Orchestrator.state.lastLog = 'Audience cleared.';
              } else {
                Orchestrator.applySmartMerge(cfg.contacts, cfg.sourceLabel || 'Audience');
              }
            }

            const allowedScalarKeys = [
              'template', 'googleSheetUrl', 'dailyLimit', 'minIntervalSec',
              'maxIntervalSec', 'minCooldownHours', 'maxCooldownHours',
              'typingDelayMs', 'defaultCountryCode', 'autoResumeAfterCooldown',
              'autoResumeOnStartup', 'autoSyncSheet', 'autoSyncIntervalMin',
              'autoWatchNewContacts'
            ];
            allowedScalarKeys.forEach(k => {
              if (cfg[k] !== undefined) {
                Orchestrator.state[k] = cfg[k];
              }
            });

            if (cfg.appSettings) {
              Orchestrator.appSettings = { ...Orchestrator.appSettings, ...cfg.appSettings };
              window.parent.postMessage({
                action: 'HOST_SET_APP_SETTINGS',
                appSettings: cfg.appSettings
              }, '*');
            }

            Orchestrator.save();
            response = {
              success: true,
              state: { ...Orchestrator.state },
              appSettings: { ...Orchestrator.appSettings }
            };
            break;
          }

          case 'startCampaign': {
            const cfg = message.config || {};
            if (cfg.template !== undefined) Orchestrator.state.template = cfg.template;
            if (cfg.googleSheetUrl !== undefined) Orchestrator.state.googleSheetUrl = cfg.googleSheetUrl;
            Orchestrator.start(false);
            response = { success: true, state: { ...Orchestrator.state } };
            break;
          }

          case 'pauseCampaign':
            Orchestrator.pause();
            response = { success: true, state: { ...Orchestrator.state } };
            break;

          case 'stopCampaign':
            Orchestrator.stop();
            response = { success: true, state: { ...Orchestrator.state } };
            break;

          case 'skipCooldown':
            Orchestrator.state.inCooldown = false;
            Orchestrator.state.cooldownEndsAt = null;
            Orchestrator.state.batchSentCount = 0;
            Orchestrator.state.lastLog = 'Cooldown manually bypassed. Ready to continue from next pending contact.';
            Orchestrator.save();
            if (Orchestrator.getPendingCount() > 0 && Orchestrator.state.autoResumeAfterCooldown) {
              Orchestrator.start(true);
            }
            response = { success: true, state: { ...Orchestrator.state } };
            break;

          case 'resetAndRetryEntireSheet': {
            if (Orchestrator.timerId) {
              clearTimeout(Orchestrator.timerId);
              Orchestrator.timerId = null;
            }
            Orchestrator.isDispatching = false;
            Orchestrator.state.isRunning = false;
            Orchestrator.state.isPaused = false;
            Orchestrator.state.wasActiveCampaign = false;
            Orchestrator.state.waitingForConnection = false;
            Orchestrator.state.nextDispatchAt = null;
            const cc = Orchestrator.state.defaultCountryCode || '92';
            Orchestrator.state.contacts.forEach(c => {
              const clean = normalizePhoneNumber(c.phone || c.rawPhone, cc);
              c.phone = clean;
              c.status = 'pending';
              c.sentAt = null;
              c.errorMessage = '';
              delete Orchestrator.state.sentPhoneHistory[clean];
            });
            Orchestrator.state.currentIndex = 0;
            Orchestrator.state.batchSentCount = 0;
            Orchestrator.state.inCooldown = false;
            Orchestrator.state.cooldownEndsAt = null;
            Orchestrator.state.campaignCompleted = false;
            Orchestrator.state.lastLog = `Sheet reset: ${Orchestrator.state.contacts.length} contacts reset to Pending.`;
            Orchestrator.save();
            response = {
              success: true,
              count: Orchestrator.state.contacts.length,
              state: { ...Orchestrator.state }
            };
            break;
          }

          case 'syncSheetNow':
            Orchestrator.maybeAutoSyncSheet(true).then(() => {
              if (typeof responseCallback === 'function') {
                responseCallback({ success: true, state: { ...Orchestrator.state } });
              }
            });
            return true;

          case 'loadAudience':
            Orchestrator.applySmartMerge(message.contacts || [], 'Audience');
            response = { success: true, total: Orchestrator.state.contacts.length, state: { ...Orchestrator.state } };
            break;

          case 'setDailyLimit':
            Orchestrator.state.dailyLimit = Math.max(1, parseInt(message.limit, 10) || 30);
            Orchestrator.save();
            response = { success: true, state: { ...Orchestrator.state } };
            break;

          case 'setInterval':
            Orchestrator.state.minIntervalSec = Math.max(5, parseInt(message.min, 10) || 60);
            Orchestrator.state.maxIntervalSec = Math.max(Orchestrator.state.minIntervalSec, parseInt(message.max, 10) || 120);
            Orchestrator.save();
            response = { success: true, state: { ...Orchestrator.state } };
            break;

          case 'checkWhatsAppStatus':
            window.parent.postMessage({ action: 'CHECK_HOST_WA_STATUS' }, '*');
            response = {
              connected: Orchestrator.lastWaStatus || false,
              needsQR: Orchestrator.lastWaNeedsQR || false,
              loading: Orchestrator.lastWaLoading || false,
              phone: Orchestrator.lastWaStatus ? 'Desktop Session Active' : null
            };
            break;

          case 'openWhatsAppTab':
            window.parent.postMessage({ action: 'SWITCH_TO_WA_TAB' }, '*');
            response = { success: true };
            break;

          case 'exportLegacyState':
            response = {
              success: true,
              exportedAt: Date.now(),
              source: 'whatsapp_booster_desktop',
              campaignState: { ...Orchestrator.state }
            };
            break;

          default:
            response = { success: true };
        }

        if (typeof responseCallback === 'function') {
          setTimeout(() => responseCallback(response), 10);
        }
      },
      onConnect: {
        addListener: function () {}
      },
      connect: function () {
        return {
          postMessage: function () {},
          onMessage: { addListener: function () {} },
          onDisconnect: { addListener: function () {} },
          disconnect: function () {}
        };
      }
    }
  };

  console.log('⚡ [WhatsApp Booster Desktop] Autonomous Bridge Loaded & Active.');
})(typeof globalThis !== 'undefined' ? globalThis : this);
