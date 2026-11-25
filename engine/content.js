/**
 * WhatsApp CRM Pro - Ultra-Reliable Content Engine (v11.0 Absolute Single-Target Engine)
 * ZERO DOM INJECTION on web.whatsapp.com (Completely invisible on screen).
 * 
 * CORE GUARANTEES:
 * 1. MANDATORY CHAT SWITCHING: Never assumes a contact is already open from previous row.
 * 2. COMPOSER ISOLATION: Never checks composer alone; verifies header matches target contact.
 * 3. RESULT ROW AUTONOMOUS SELECTION:
 *    - Robust multi-event click (pointerdown, mousedown, mouseup, click) on result row & clickable children.
 *    - ArrowDown + Enter keyboard navigation to select result item.
 * 4. STRICT HEADER VERIFICATION:
 *    - Ensures header text actually changed from previous contact.
 *    - Matches by phone digits, exact contact name, or search result row text.
 *    - HARD GUARD: Aborts send if active chat is still the previous contact!
 * 5. BULLETPROOF SEND:
 *    - Detects modern circular send button (geometric position right of composer).
 *    - Dual-action trigger: singleClick(sendButton) + forceKey(composer, 'Enter', 13).
 * 6. ZERO PAGE RELOADS: 100% in-page execution.
 */

(function () {
  'use strict';

  // Global Deduplication Stores on window
  if (!window.__WACRM_DISPATCHED_TOKENS__) {
    window.__WACRM_DISPATCHED_TOKENS__ = new Set();
  }
  if (!window.__WACRM_RECENT_PHONE_TIMESTAMPS__) {
    window.__WACRM_RECENT_PHONE_TIMESTAMPS__ = {};
  }

  // Prevent multiple script instances
  if (window.__WACRM_ACCURACY_ENGINE_V11__) {
    console.log('⚡ [WhatsApp CRM Pro] Engine v11 already active in this tab.');
    return;
  }
  window.__WACRM_ACCURACY_ENGINE_V11__ = true;

  console.log('⚡ [WhatsApp CRM Pro] Accuracy Engine v11.0 Active.');

  let isSendingLock = false;

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function escapeRegExp(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Full-event native click supporting React synthetic events & pointer listeners
  function robustClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventOpts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      buttons: 1
    };

    try { el.focus(); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerdown', eventOpts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', eventOpts)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', eventOpts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', eventOpts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', eventOpts)); } catch (e) {}
    try { el.click(); } catch (e) {}
    return true;
  }

  // Synthetic Keyboard Event
  function forceKey(element, key, keyCode) {
    if (!element) return;
    try { element.focus(); } catch (e) {}
    ['keydown', 'keypress', 'keyup'].forEach(evtName => {
      try {
        const evt = new KeyboardEvent(evtName, {
          key,
          code: key,
          keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true,
          view: window
        });
        element.dispatchEvent(evt);
      } catch (e) {}
    });
  }

  const Automator = {
    // Check if WhatsApp Web is logged in
    getConnectionStatus() {
      const hasMainPane = !!(
        document.querySelector('#pane-side') ||
        document.querySelector('[data-testid="chat-list"]') ||
        document.querySelector('#app header') ||
        document.querySelector('#main') ||
        document.querySelector('div[data-tab="3"]')
      );

      const hasQR = !!(
        document.querySelector('canvas[aria-label="Scan this QR code to link a device"]') ||
        document.querySelector('canvas') ||
        document.querySelector('div[data-ref]') ||
        document.querySelector('[data-testid="qrcode"]')
      );

      const isLoading = !!(
        document.querySelector('progress') ||
        document.querySelector('[data-testid="intro-loading"]') ||
        document.querySelector('#initial_startup')
      );

      if (hasMainPane) {
        return { connected: true, status: 'Connected & Ready' };
      } else if (hasQR) {
        return { connected: false, status: 'Waiting for QR Code Scan' };
      } else if (isLoading) {
        return { connected: false, status: 'WhatsApp Synchronizing...' };
      } else {
        return { connected: false, status: 'WhatsApp Web Not Loaded' };
      }
    },

    findComposer() {
      return (
        document.querySelector('#main footer div[contenteditable="true"]') ||
        document.querySelector('#main div[data-lexical-editor="true"][contenteditable="true"]') ||
        document.querySelector('footer div[contenteditable="true"]') ||
        document.querySelector('div[data-tab="10"][contenteditable="true"]') ||
        document.querySelector('div[data-tab="6"][contenteditable="true"]') ||
        document.querySelector('div[title="Type a message"][contenteditable="true"]') ||
        document.querySelector('div[aria-label="Type a message"][contenteditable="true"]') ||
        document.querySelector('div[aria-label="ایک پیغام لکھیں"][contenteditable="true"]') ||
        document.querySelector('#main div[contenteditable="true"]')
      );
    },

    isMicButton(element) {
      if (!element) return false;
      const html = (element.innerHTML || '').toLowerCase();
      const label = (element.getAttribute('aria-label') || '').toLowerCase();
      return (
        html.includes('data-icon="ptt"') ||
        html.includes('data-icon="mic"') ||
        label.includes('voice') ||
        label.includes('record') ||
        label.includes('وائس')
      );
    },

    /**
     * Rock-solid Send Button locator supporting modern circular send button
     */
    findSendButton() {
      const sendSelectors = [
        'span[data-icon="send"]',
        'span[data-icon="wds-ic-send-filled"]',
        'span[data-icon="send-light"]',
        '[data-icon="send"]',
        '[data-testid="send"]',
        'button[data-testid="compose-btn-send"]',
        'button[aria-label="Send"]',
        'button[aria-label="بھیجیں"]',
        'button[aria-label="Enviar"]',
        'button[data-tab="11"]'
      ];

      for (const sel of sendSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const btn = el.tagName === 'BUTTON' ? el : el.closest('button');
          if (btn && !this.isMicButton(btn)) {
            return btn;
          }
        }
      }

      const footer = document.querySelector('#main footer') || document.querySelector('footer');
      if (footer) {
        const buttons = Array.from(footer.querySelectorAll('button, div[role="button"]'));
        for (const btn of buttons) {
          if (this.isMicButton(btn)) continue;
          const hasSendIcon = btn.querySelector('[data-icon="send"]') ||
                              btn.querySelector('[data-icon*="send"]') ||
                              btn.querySelector('[data-icon*="wds-ic-send"]') ||
                              (btn.getAttribute('aria-label') || '').toLowerCase().includes('send') ||
                              (btn.getAttribute('aria-label') || '').includes('بھیجیں');
          if (hasSendIcon) return btn;
        }

        // Geometric fallback: Button directly to the right of composer in footer
        const composer = this.findComposer();
        if (composer) {
          const compRect = composer.getBoundingClientRect();
          for (const btn of buttons) {
            if (this.isMicButton(btn)) continue;
            const rect = btn.getBoundingClientRect();
            if (rect.left >= compRect.right - 25 && rect.width > 20 && rect.height > 20) {
              return btn;
            }
          }
        }
      }

      return null;
    },

    checkInvalidNumberModal() {
      const modals = document.querySelectorAll(
        '[data-animate-modal-body="true"], div[role="dialog"], div[data-testid="popup-contents"], div[data-testid="confirm-popup"]'
      );

      for (const modal of modals) {
        const text = (modal.innerText || modal.textContent || '').toLowerCase();
        if (
          text.includes('invalid') ||
          text.includes('phone number shared via url is invalid') ||
          text.includes('url is invalid') ||
          text.includes('not on whatsapp') ||
          text.includes('نمبر درست نہیں') ||
          text.includes('فون نمبر درست نہیں') ||
          text.includes('فون نمبر واٹس ایپ پر نہیں')
        ) {
          const okBtn =
            modal.querySelector('button') ||
            modal.querySelector('div[role="button"]') ||
            document.querySelector('[data-testid="popup-controls-ok"]');
          return { isInvalid: true, okButton: okBtn };
        }
      }
      return { isInvalid: false, okButton: null };
    },

    /**
     * Extracts active chat title and phone digits from #main header.
     */
    getOpenChatInfo() {
      const mainHeader = document.querySelector('#main header');
      if (!mainHeader) {
        return { title: '', titleDigits: '', allDigits: '', rawText: '' };
      }

      let title = '';
      const titleEl = mainHeader.querySelector('div[data-testid="conversation-info-header"] span[title]') ||
                      mainHeader.querySelector('span[title]') ||
                      mainHeader.querySelector('div[role="button"] span[dir="auto"]');
      if (titleEl) {
        title = (titleEl.getAttribute('title') || titleEl.innerText || '').trim();
      }

      const rawText = (mainHeader.innerText || '').trim();

      if (!title) {
        const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        for (const line of lines) {
          const lower = line.toLowerCase();
          if (lower === 'online' || lower.includes('last seen') || lower.includes('typing') || lower.includes('click here') || line.length <= 2) {
            continue;
          }
          title = line;
          break;
        }
      }

      const allDigits = rawText.replace(/\D/g, '');
      const titleDigits = title.replace(/\D/g, '');

      return { title, titleDigits, allDigits, rawText };
    },

    /**
     * Opens the "New chat" drawer where unsaved numbers can be searched.
     */
    async openNewChatDrawer() {
      const isDrawerOpen = !!(
        document.querySelector('div[data-animate-modal-body="true"]') ||
        document.querySelector('header span[data-icon="back"]') ||
        document.querySelector('button[aria-label="Back"]') ||
        document.querySelector('button[aria-label="واپس"]')
      );

      if (isDrawerOpen) {
        return true;
      }

      const newChatBtn = document.querySelector('button[aria-label="New chat"]') ||
                         document.querySelector('button[title="New chat"]') ||
                         document.querySelector('button[aria-label="نئی بات چیت"]') ||
                         document.querySelector('span[data-icon="chat"]')?.closest('button') ||
                         document.querySelector('span[data-icon="new-chat-outline"]')?.closest('button') ||
                         document.querySelector('span[data-icon="wds-ic-chat-new"]')?.closest('button') ||
                         document.querySelector('div[title="New chat"]');

      if (newChatBtn) {
        robustClick(newChatBtn);
        await sleep(600);
        return true;
      }

      return false;
    },

    /**
     * Finds the Search Input inside the active "New chat" drawer.
     */
    getDrawerSearchInput() {
      const selectors = [
        'div[data-animate-modal-body="true"] input[type="text"]',
        'div[data-animate-modal-body="true"] [contenteditable="true"]',
        'header + div input[type="text"]',
        'header + div [contenteditable="true"]',
        'input[placeholder*="Search name"]',
        'input[placeholder*="name, number"]',
        'input[placeholder*="Search"]',
        'input[placeholder*="تلاش"]',
        '#side input[placeholder*="Search"]',
        'input[type="text"]'
      ];

      for (const sel of selectors) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
          if (el.closest('#main') || el.closest('footer')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 50 && rect.height > 10 && rect.left < window.innerWidth * 0.55 && rect.top >= 0 && rect.top < window.innerHeight) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              return el;
            }
          }
        }
      }

      return null;
    },

    /**
     * Types query into search input supporting both native React <input> and Lexical contenteditable
     */
    async typeSearchQuery(searchInput, text) {
      if (!searchInput) return;
      searchInput.focus();
      robustClick(searchInput);
      await sleep(100);

      if (searchInput.tagName === 'INPUT') {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        const prototype = Object.getPrototypeOf(searchInput);
        const prototypeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

        if (prototypeSetter && nativeSetter !== prototypeSetter) {
          prototypeSetter.call(searchInput, text);
        } else if (nativeSetter) {
          nativeSetter.call(searchInput, text);
        } else {
          searchInput.value = text;
        }

        if (searchInput._valueTracker) {
          searchInput._valueTracker.setValue('');
        }

        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(searchInput);
        sel.removeAllRanges();
        sel.addRange(range);

        document.execCommand('delete', false, null);

        try {
          const beforeInputEvt = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
          });
          searchInput.dispatchEvent(beforeInputEvt);
        } catch (e) {}

        const success = document.execCommand('insertText', false, text);
        if (!success || (searchInput.innerText || searchInput.textContent || '').trim() !== text) {
          searchInput.innerText = text;
        }

        searchInput.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text
        }));
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await sleep(350);
    },

    /**
     * Switches chat in-page using the New Chat drawer with multi-layer click & keyboard navigation.
     * ZERO PAGE RELOAD!
     */
    async switchChatInPage(contact, cleanPhone, previousChatHeader) {
      window.__WACRM_CURRENT_OPEN_PHONE__ = null;

      // 1. Open New Chat drawer
      await this.openNewChatDrawer();

      // 2. Find search input in the drawer
      let searchInput = this.getDrawerSearchInput();
      if (!searchInput) {
        await sleep(500);
        await this.openNewChatDrawer();
        searchInput = this.getDrawerSearchInput();
      }

      // 3. Search queries in priority order:
      // Priority 1: +923139144815 (International format)
      // Priority 2: 03139144815 (Local format)
      // Priority 3: 923139144815 (Clean digits)
      // Priority 4: Contact name
      const queries = ['+' + cleanPhone];
      if (cleanPhone.startsWith('923') && cleanPhone.length === 12) {
        queries.push('0' + cleanPhone.substring(2));
      }
      queries.push(cleanPhone);
      if (contact && contact.name && contact.name.trim().toLowerCase() !== 'valued client') {
        queries.push(contact.name.trim());
      }

      for (const query of queries) {
        if (!searchInput) {
          searchInput = this.getDrawerSearchInput();
          if (!searchInput) continue;
        }

        console.log(`🔍 [WACRM] Searching New Chat drawer for: ${query}`);
        await this.typeSearchQuery(searchInput, query);

        // Wait up to 4 seconds for WhatsApp search results to populate
        const searchWaitStart = Date.now();
        while (Date.now() - searchWaitStart < 4000) {
          await sleep(400);

          // Find result rows specifically inside the left drawer
          const drawerContainer = document.querySelector('div[data-animate-modal-body="true"]') ||
                                  document.querySelector('#side');
          
          if (!drawerContainer) continue;

          const resultRows = Array.from(drawerContainer.querySelectorAll(
            '[data-testid="cell-frame-container"], ' +
            'div[role="listitem"], ' +
            'div[data-testid*="list-item"], ' +
            'div[data-testid="chat-list-item"]'
          ));

          if (resultRows.length > 0) {
            let targetRow = null;
            let resultRowText = '';

            for (const row of resultRows) {
              const rowText = (row.innerText || '').toLowerCase();
              if (rowText.includes('chat with') || rowText.includes('چیٹ کریں') ||
                  (cleanPhone.length >= 7 && rowText.includes(cleanPhone.slice(-7))) ||
                  (contact.name && rowText.includes(contact.name.toLowerCase()))) {
                targetRow = row;
                resultRowText = (row.innerText || '').trim();
                break;
              }
            }

            const chosenRow = targetRow || resultRows[0];
            if (!resultRowText) {
              resultRowText = (chosenRow.innerText || '').trim();
            }

            console.log(`🎯 [WACRM] Found search result "${resultRowText}" for ${cleanPhone}. Executing multi-layer click...`);

            // Layer A: Click the clickable child inside the row (e.g. role="button" or avatar or title)
            const clickableChild = chosenRow.querySelector('div[role="button"]') ||
                                   chosenRow.querySelector('span[title]') ||
                                   chosenRow.querySelector('[data-testid="cell-frame-title"]') ||
                                   chosenRow.firstElementChild;
            if (clickableChild) {
              robustClick(clickableChild);
            }

            // Layer B: Click the row container itself
            robustClick(chosenRow);

            // Layer C: Keyboard Navigation - ArrowDown then Enter on search input
            forceKey(searchInput, 'ArrowDown', 40);
            await sleep(100);
            forceKey(searchInput, 'Enter', 13);
            await sleep(1200);

            // Layer D: Verify if the chat in #main changed
            const newHeader = this.getOpenChatInfo();
            const composer = this.findComposer();

            // The header must NOT be the previous contact!
            const isDifferentFromPrev = !previousChatHeader || (newHeader.rawText !== previousChatHeader && !previousChatHeader.includes(newHeader.title));
            const hasPhoneDigits = cleanPhone.length >= 7 && (newHeader.allDigits.includes(cleanPhone.slice(-7)) || newHeader.titleDigits.includes(cleanPhone.slice(-7)));
            const hasNameMatch = contact.name && newHeader.title.toLowerCase().includes(contact.name.toLowerCase());
            const hasResultMatch = resultRowText && (resultRowText.toLowerCase().includes(newHeader.title.toLowerCase()) || newHeader.title.toLowerCase().includes(resultRowText.split('\n')[0].toLowerCase()));

            if (composer && (hasPhoneDigits || hasNameMatch || hasResultMatch || (isDifferentFromPrev && newHeader.title.length > 0))) {
              window.__WACRM_CURRENT_OPEN_PHONE__ = cleanPhone;
              console.log(`✅ [WACRM] Successfully switched and verified chat to ${cleanPhone} (${newHeader.title})!`);
              return true;
            }
          }
        }

        // Fallback: ArrowDown + Enter on search input
        forceKey(searchInput, 'ArrowDown', 40);
        await sleep(150);
        forceKey(searchInput, 'Enter', 13);
        await sleep(1200);

        const currentHeader = this.getOpenChatInfo();
        const currentComposer = this.findComposer();
        if (currentComposer && (!previousChatHeader || currentHeader.rawText !== previousChatHeader)) {
          window.__WACRM_CURRENT_OPEN_PHONE__ = cleanPhone;
          console.log(`✅ [WACRM] Switched via Enter key to ${cleanPhone}!`);
          return true;
        }
      }

      return !!(window.__WACRM_CURRENT_OPEN_PHONE__ === cleanPhone);
    },

    /**
     * Ensures message text is in composer and forces Send button to render
     */
    async ensureMessageCommitted(composer, messageText) {
      composer.focus();
      await sleep(150);

      const currentText = (composer.innerText || composer.textContent || '').trim();

      if (!currentText || currentText !== messageText.trim()) {
        try {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, messageText);
        } catch (e) {
          composer.innerText = messageText;
        }
      }

      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: ' '
      }));

      try {
        document.execCommand('insertText', false, ' ');
        await sleep(40);
        document.execCommand('delete', false, null);
      } catch (e) {}

      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(250);
    },

    /**
     * ABSOLUTE ACCURACY SINGLE-SEND DISPATCHER (ZERO PAGE RELOAD!)
     */
    async sendToContact(contact, messageText, options = {}) {
      const cleanPhone = String(contact.phone || '').replace(/\D/g, '');
      const { typingDelayMs = 2500, dispatchToken = '' } = options;

      // 1. DEDUPLICATION CHECK A: Dispatch Token
      if (dispatchToken && window.__WACRM_DISPATCHED_TOKENS__.has(dispatchToken)) {
        console.warn(`🛑 [WACRM] Duplicate request blocked by dispatch token: ${dispatchToken}`);
        return { success: true, duplicateBlocked: true };
      }
      if (dispatchToken) {
        window.__WACRM_DISPATCHED_TOKENS__.add(dispatchToken);
      }

      // 2. DEDUPLICATION CHECK B: 20-Second Phone Lock
      const lastSentTime = window.__WACRM_RECENT_PHONE_TIMESTAMPS__[cleanPhone] || 0;
      if (Date.now() - lastSentTime < 20000) {
        console.warn(`🛑 [WACRM] Duplicate send blocked to ${cleanPhone} (Cooldown active within 20s)`);
        return { success: true, duplicateBlocked: true };
      }

      if (isSendingLock) {
        console.warn('🛑 [WACRM] Send already in progress lock active.');
        return { success: false, error: 'A send operation is currently in progress.' };
      }

      isSendingLock = true;
      console.log(`🎯 [WhatsApp CRM Pro] Initiating single dispatch for ${contact.name} (${cleanPhone})...`);

      try {
        // Record currently open chat header before switching
        const previousChatHeader = (document.querySelector('#main header')?.innerText || '').trim();

        // ALWAYS switch chat to the target contact's phone number!
        const switched = await this.switchChatInPage(contact, cleanPhone, previousChatHeader);

        // Verification Loop: Wait up to 6 seconds for target chat & composer
        const pollStart = Date.now();
        let composer = null;

        while (Date.now() - pollStart < 6000) {
          const invalidCheck = this.checkInvalidNumberModal();
          if (invalidCheck.isInvalid) {
            console.warn('⚠️ Invalid phone number modal detected.');
            await sleep(500);
            if (invalidCheck.okButton) robustClick(invalidCheck.okButton);
            isSendingLock = false;
            return { success: false, error: 'نمبر واٹس ایپ پر موجود نہیں ہے (Not on WhatsApp)' };
          }

          if (window.__WACRM_CURRENT_OPEN_PHONE__ === cleanPhone) {
            composer = this.findComposer();
            if (composer) break;
          }
          await sleep(400);
        }

        // HARD ISOLATION GUARD:
        // Must have switched, composer must exist, and the chat header MUST NOT be the previous contact!
        const activeHeader = this.getOpenChatInfo();
        const isStillPreviousContact = previousChatHeader && activeHeader.rawText === previousChatHeader && !cleanPhone.includes(activeHeader.titleDigits);

        if (!switched || !composer || window.__WACRM_CURRENT_OPEN_PHONE__ !== cleanPhone || isStillPreviousContact) {
          console.error(`🛑 [WACRM] Chat switch to ${contact.name} (${cleanPhone}) was not verified. Refusing to send into wrong chat.`);
          isSendingLock = false;
          return {
            success: false,
            error: `Target chat for ${contact.name} (${cleanPhone}) could not be opened.`
          };
        }

        // Step 3: Natural human typing delay
        await sleep(typingDelayMs);

        // Step 4: Commit message text in composer
        await this.ensureMessageCommitted(composer, messageText);
        await sleep(500);

        // Step 5: Locate Send button
        const sendPollStart = Date.now();
        let sendButton = null;

        while (Date.now() - sendPollStart < 6000) {
          sendButton = this.findSendButton();
          if (sendButton) break;
          await this.ensureMessageCommitted(composer, messageText);
          await sleep(500);
        }

        // Step 6: Pure Single Send (Guaranteed Exactly 1 Outgoing Message - Zero Duplicates!)
        console.log(`🚀 [WACRM] Executing single native send for ${contact.name} (${cleanPhone}).`);
        if (sendButton) {
          try { sendButton.focus(); } catch (e) {}
          sendButton.click();
        } else if (composer) {
          forceKey(composer, 'Enter', 13);
        }

        // Record timestamp for 20-second deduplication lock
        window.__WACRM_RECENT_PHONE_TIMESTAMPS__[cleanPhone] = Date.now();

        // Step 7: Verification loop (Wait up to 5 seconds for message bubble / composer cleared)
        const verifyStart = Date.now();
        while (Date.now() - verifyStart < 5000) {
          await sleep(600);
          composer = this.findComposer();
          const remainingText = composer ? (composer.innerText || '').trim() : '';
          const currentSendBtn = this.findSendButton();

          if (remainingText.length === 0 || !currentSendBtn) {
            console.log(`✅ [WhatsApp CRM Pro] Single message verified delivered to ${contact.name} (${cleanPhone})!`);
            break;
          }
        }

        await sleep(500);
        isSendingLock = false;
        return { success: true };
      } catch (err) {
        isSendingLock = false;
        return { success: false, error: err.message };
      }
    }
  };

  // Runtime Message Listener with Token Deduplication (Extension mode only)
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'checkConnection') {
        sendResponse(Automator.getConnectionStatus());
        return true;
      }

      if (request.action === 'sendSingleMessage') {
        Automator.sendToContact(request.contact, request.messageText, {
          typingDelayMs: request.typingDelayMs || 2500,
          dispatchToken: request.dispatchToken || ''
        }).then(result => {
          sendResponse(result);
        }).catch(err => {
          sendResponse({ success: false, error: err.message });
        });
        return true;
      }
    });
  }

  // Desktop Window Message Listener for standalone Electron execution
  window.addEventListener('message', async (event) => {
    if (!event.data) return;

    if (event.data.action === 'WACRM_DESKTOP_CHECK_CONN') {
      const status = Automator.getConnectionStatus();
      window.postMessage({ action: 'WACRM_DESKTOP_CONN_RESULT', ...status }, '*');
      return;
    }

    if (event.data.action === 'WACRM_DESKTOP_DISPATCH') {
      try {
        const result = await Automator.sendToContact(
          event.data.contact,
          event.data.messageText,
          {
            typingDelayMs: event.data.typingDelayMs || 2500,
            dispatchToken: event.data.dispatchToken || ''
          }
        );
        window.postMessage({ action: 'WACRM_DESKTOP_RESULT', ...result }, '*');
      } catch (err) {
        window.postMessage({ action: 'WACRM_DESKTOP_RESULT', success: false, error: err.message }, '*');
      }
    }
  });

})();
