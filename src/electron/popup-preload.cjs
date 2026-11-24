const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('popupAPI', {
  onShow: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('show-popup', handler);
    ipcRenderer.send('popup-ready');
    return () => ipcRenderer.removeListener('show-popup', handler);
  },
  dismiss: () => ipcRenderer.send('popup-dismiss'),
  showMain: () => ipcRenderer.send('show-main'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
