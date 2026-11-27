const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

console.log('⚡ [WhatsApp Booster Desktop] Preload initialized inside WhatsApp Web view.');

// Load and inject the single-dispatch engine into WhatsApp Web
window.addEventListener('DOMContentLoaded', () => {
  try {
    const enginePath = path.join(__dirname, 'content.js');
    if (fs.existsSync(enginePath)) {
      const code = fs.readFileSync(enginePath, 'utf8');
      const script = document.createElement('script');
      script.textContent = code;
      (document.head || document.documentElement).appendChild(script);
      console.log('⚡ [WhatsApp Booster Desktop] Engine injected into DOM.');
    }
  } catch (err) {
    console.error('Failed to inject engine:', err);
  }
});

// IPC Handler: Respond to host commands from dashboard
ipcRenderer.on('check-connection', () => {
  const hasMainPane = !!(
    document.querySelector('#pane-side') ||
    document.querySelector('#side') ||
    document.querySelector('[data-testid="chat-list"]') ||
    document.querySelector('#app header') ||
    document.querySelector('#main') ||
    document.querySelector('.two')
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

  ipcRenderer.sendToHost('connection-status', {
    connected: hasMainPane,
    needsQR: !hasMainPane && hasQR,
    loading: !hasMainPane && !hasQR && isLoading
  });
});

let pendingDispatchToken = null;

ipcRenderer.on('send-single-message', (event, data) => {
  const token = data.dispatchToken || `tok_${Date.now()}`;
  pendingDispatchToken = token;
  window.postMessage({
    action: 'WACRM_DESKTOP_DISPATCH',
    contact: data.contact,
    messageText: data.messageText,
    typingDelayMs: data.typingDelayMs || 2500,
    dispatchToken: token
  }, 'https://web.whatsapp.com');
});

// Listen for dispatch result from the page (validate origin + active dispatch token)
window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== 'https://web.whatsapp.com') return;
  if (!event.data || event.data.action !== 'WACRM_DESKTOP_RESULT') return;
  if (pendingDispatchToken && event.data.dispatchToken && event.data.dispatchToken !== pendingDispatchToken) return;
  pendingDispatchToken = null;
  ipcRenderer.sendToHost('dispatch-result', event.data);
});
