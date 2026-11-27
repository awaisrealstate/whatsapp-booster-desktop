const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronHost', {
  loadCampaignState: () => ipcRenderer.invoke('load-campaign-state'),
  saveCampaignState: (state) => ipcRenderer.invoke('save-campaign-state', state),
  getAppSettings: () => ipcRenderer.invoke('get-app-settings'),
  setAppSettings: (partial) => ipcRenderer.invoke('set-app-settings', partial),
  showDesktopNotification: (payload) => ipcRenderer.send('show-desktop-notification', payload),
  fetchGoogleSheetCsv: (url) => ipcRenderer.invoke('fetch-google-sheet-csv', url)
});
