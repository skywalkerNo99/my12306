const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('connection', { load: () => ipcRenderer.invoke('connection:load'), save: input => ipcRenderer.invoke('connection:save', input) });
