const { app, BrowserWindow, ipcMain, session, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Set persistent user data path inside the software folder
const userDataPath = path.join(__dirname, 'user_data');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}
app.setPath('userData', userDataPath);

const stateFilePath = path.join(userDataPath, 'campaign_state.json');
const appSettingsPath = path.join(userDataPath, 'app_settings.json');

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
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
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
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      webSecurity: false
    }
  });

  // Remove default menu for a clean modern app look
  mainWindow.setMenuBarVisibility(false);

  // Load the desktop application shell
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

// IPC Handlers for Persistent Campaign State & Desktop Settings
ipcMain.handle('load-campaign-state', () => {
  return readJsonSafe(stateFilePath, null);
});

ipcMain.handle('save-campaign-state', (event, state) => {
  return writeJsonAtomic(stateFilePath, state);
});

ipcMain.handle('get-app-settings', () => {
  return getAppSettings();
});

ipcMain.handle('set-app-settings', (event, partial) => {
  const updated = { ...getAppSettings(), ...(partial || {}) };
  writeJsonAtomic(appSettingsPath, updated);
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'autoStartOnBoot')) {
    applyAutoStartSetting(updated.autoStartOnBoot);
  }
  return updated;
});

ipcMain.on('show-desktop-notification', (event, payload) => {
  if (Notification.isSupported() && payload) {
    new Notification({
      title: payload.title || 'Whatsapp Booster',
      body: payload.body || '',
      icon: path.join(__dirname, 'icons', 'icon128.png')
    }).show();
  }
});

app.whenReady().then(() => {
  // Configure modern Chrome User-Agent for WhatsApp Web
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    callback({ cancel: false, requestHeaders: details.requestHeaders });
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
