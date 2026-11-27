const { app, BrowserWindow, ipcMain, session, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Set persistent user data path inside the software folder
const userDataPath = path.join(__dirname, 'user_data');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}
app.setPath('userData', userDataPath);

const stateFilePath = path.join(userDataPath, 'campaign_state.json');
const appSettingsPath = path.join(userDataPath, 'app_settings.json');
const mainHtmlUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const trustedPreloadPath = path.resolve(__dirname, 'engine', 'preload.js');

let mainWindow = null;
let tray = null;
let isQuitting = false;

function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to read JSON:', filePath, e);
  }
  return fallback;
}

function writeJsonAtomic(filePath, data) {
  try {
    const serialized = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > 15 * 1024 * 1024) {
      return false;
    }
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (e) {
    console.error('Failed to write JSON:', filePath, e);
    return false;
  }
}

function getAppSettings() {
  return {
    minimizeToTray: true,
    autoStartOnBoot: false,
    ...readJsonSafe(appSettingsPath, {})
  };
}

function applyAutoStartSetting(enabled) {
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: !!enabled,
        path: process.execPath,
        args: [path.resolve(__dirname)]
      });
    }
  } catch (e) {
    console.error('Failed to update login item settings:', e);
  }
}

function isTrustedMainSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (event.sender !== mainWindow.webContents) return false;
  const senderUrl = event.senderFrame?.url || '';
  return senderUrl === mainHtmlUrl;
}

function isAllowedWhatsAppHost(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'web.whatsapp.com' || parsed.hostname.endsWith('.whatsapp.com'))
    );
  } catch {
    return false;
  }
}

function assertAllowedGoogleSheetUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || '').trim());
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com') {
    throw new Error('Only https://docs.google.com URLs are permitted.');
  }
  if (!parsed.pathname.startsWith('/spreadsheets/')) {
    throw new Error('URL must reference a Google Sheets path.');
  }
  return parsed.toString();
}

// Single-instance lock so duplicate background campaigns cannot run
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'icons', 'icon48.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Whatsapp Booster With Awais - Running in Background');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Completely',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    title: 'Whatsapp Booster With Awais - Desktop Edition',
    backgroundColor: '#0c1317',
    icon: path.join(__dirname, 'icons', 'icon128.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-main.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      webSecurity: true
    }
  });

  mainWindow.setMenuBarVisibility(false);

  // Never allow external navigation or popups inside hardened host shell
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== mainHtmlUrl) {
      event.preventDefault();
    }
  });

  // Restrict <webview> attachment strictly to hardened WhatsApp Web configuration
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = false;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;

    const preloadFile = webPreferences.preload ? path.resolve(webPreferences.preload) : '';
    if (preloadFile !== trustedPreloadPath) {
      delete webPreferences.preload;
    }

    if (!isAllowedWhatsAppHost(params.src || '')) {
      event.preventDefault();
    }
  });

  mainWindow.loadFile('index.html');

  // Keep running in system tray when closed if minimizeToTray is enabled
  mainWindow.on('close', (event) => {
    const settings = getAppSettings();
    if (!isQuitting && settings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      if (Notification.isSupported()) {
        new Notification({
          title: 'Whatsapp Booster Running in Background',
          body: 'App tray mein active hai aur auto-campaign background mein chalti rahegi.',
          icon: path.join(__dirname, 'icons', 'icon128.png')
        }).show();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Strict IPC Handlers (validate sender & input shape)
ipcMain.handle('load-campaign-state', (event) => {
  if (!isTrustedMainSender(event)) return null;
  return readJsonSafe(stateFilePath, null);
});

ipcMain.handle('save-campaign-state', (event, state) => {
  if (!isTrustedMainSender(event)) return false;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  return writeJsonAtomic(stateFilePath, state);
});

ipcMain.handle('get-app-settings', (event) => {
  if (!isTrustedMainSender(event)) return getAppSettings();
  return getAppSettings();
});

ipcMain.handle('set-app-settings', (event, partial) => {
  if (!isTrustedMainSender(event)) return getAppSettings();
  const safePatch = {};
  if (partial && typeof partial === 'object') {
    if (typeof partial.minimizeToTray === 'boolean') safePatch.minimizeToTray = partial.minimizeToTray;
    if (typeof partial.autoStartOnBoot === 'boolean') safePatch.autoStartOnBoot = partial.autoStartOnBoot;
  }
  const updated = { ...getAppSettings(), ...safePatch };
  writeJsonAtomic(appSettingsPath, updated);
  if (Object.prototype.hasOwnProperty.call(safePatch, 'autoStartOnBoot')) {
    applyAutoStartSetting(updated.autoStartOnBoot);
  }
  return updated;
});

ipcMain.on('show-desktop-notification', (event, payload) => {
  if (!isTrustedMainSender(event)) return;
  if (Notification.isSupported() && payload && typeof payload === 'object') {
    new Notification({
      title: String(payload.title || 'Whatsapp Booster').slice(0, 120),
      body: String(payload.body || '').slice(0, 500),
      icon: path.join(__dirname, 'icons', 'icon128.png')
    }).show();
  }
});

// Safe SSRF-guarded Google Sheets CSV fetcher for webSecurity=true desktop mode
ipcMain.handle('fetch-google-sheet-csv', async (event, rawUrl) => {
  if (!isTrustedMainSender(event)) throw new Error('Unauthorized IPC sender.');
  const safeUrl = assertAllowedGoogleSheetUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(safeUrl, { signal: controller.signal, redirect: 'follow' });
    if (res.url && !res.url.startsWith('https://docs.google.com/') && !res.url.includes('googleusercontent.com/')) {
      throw new Error('Blocked unsafe redirect host.');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 2 * 1024 * 1024) {
      throw new Error('Spreadsheet exceeds 2 MB limit.');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
});

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (navEvent, targetUrl) => {
      if (!isAllowedWhatsAppHost(targetUrl)) {
        navEvent.preventDefault();
      }
    });
  }
});

app.whenReady().then(() => {
  // Restrict User-Agent rewrite strictly to WhatsApp domains
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.whatsapp.com/*'] },
    (details, callback) => {
      details.requestHeaders['User-Agent'] =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
      callback({ cancel: false, requestHeaders: details.requestHeaders });
    }
  );

  // Restrict persistent <webview> partition permissions to WhatsApp Web origin
  const waSession = session.fromPartition('persist:whatsapp_booster_session');
  waSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents?.getURL() || '';
    const allowedPerms = new Set(['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write']);
    callback(isAllowedWhatsAppHost(url) && allowedPerms.has(permission));
  });

  createTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
