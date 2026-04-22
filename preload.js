const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hfBridge", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  loadLibrary: () => ipcRenderer.invoke("library:load"),
  addFavorite: (form) => ipcRenderer.invoke("favorites:add", form),
  removeFavorite: (id) => ipcRenderer.invoke("favorites:remove", id),
  removeHistory: (id) => ipcRenderer.invoke("history:remove", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  loadQueue: () => ipcRenderer.invoke("queue:load"),
  addQueueItem: (form) => ipcRenderer.invoke("queue:add", form),
  startQueue: () => ipcRenderer.invoke("queue:start"),
  stopQueue: () => ipcRenderer.invoke("queue:stop"),
  removeQueueItem: (id) => ipcRenderer.invoke("queue:remove", id),
  clearQueue: () => ipcRenderer.invoke("queue:clear"),
  selectFolder: () => ipcRenderer.invoke("dialog:selectFolder"),
  openPath: (targetPath) => ipcRenderer.invoke("shell:openPath", targetPath),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  previewDownload: (form) => ipcRenderer.invoke("download:preview", form),
  startDownload: (form) => ipcRenderer.invoke("download:start", form),
  stopProcess: () => ipcRenderer.invoke("process:stop"),
  checkCli: () => ipcRenderer.invoke("cli:status"),
  installCli: () => ipcRenderer.invoke("cli:install"),
  onProcessOutput: (callback) => {
    ipcRenderer.on("process:output", (_event, payload) => callback(payload));
  },
  onProcessStatus: (callback) => {
    ipcRenderer.on("process:status", (_event, payload) => callback(payload));
  },
  onLibraryChanged: (callback) => {
    ipcRenderer.on("library:changed", (_event, payload) => callback(payload));
  },
  onQueueChanged: (callback) => {
    ipcRenderer.on("queue:changed", (_event, payload) => callback(payload));
  }
});
