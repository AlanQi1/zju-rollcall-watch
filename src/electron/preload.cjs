const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  checkNow: () => ipcRenderer.invoke('check-now'),
  toggleWatch: () => ipcRenderer.invoke('toggle-watch'),
  testPopup: () => ipcRenderer.invoke('test-popup'),
  updateConfig: (patch) => ipcRenderer.invoke('update-config', patch),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  getLocations: () => ipcRenderer.invoke('get-locations'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openAccounts: () => ipcRenderer.invoke('open-accounts'),
  openEnvFile: () => ipcRenderer.invoke('open-env-file'),
  saveAccount: (input) => ipcRenderer.invoke('save-account', input),
  deleteAccount: (key) => ipcRenderer.invoke('delete-account', key),
  onStatusUpdate: (callback) => subscribe('status-update', callback),
  onLogEntry: (callback) => subscribe('log-entry', callback),
});
