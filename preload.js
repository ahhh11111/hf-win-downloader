const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hfBridge", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  saveSettingsSync: (settings) => ipcRenderer.sendSync("settings:saveSync", settings),
  loadSession: () => ipcRenderer.invoke("session:load"),
  saveSession: (session) => ipcRenderer.invoke("session:save", session),
  saveSessionSync: (session) => ipcRenderer.sendSync("session:saveSync", session),
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
  getLogStatus: () => ipcRenderer.invoke("log:status"),
  writeLog: (text, stream) => ipcRenderer.invoke("log:write", { text, stream }),
  openLog: () => ipcRenderer.invoke("log:open"),
  clearLog: () => ipcRenderer.invoke("log:clear"),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggleMaximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  previewDownload: (form) => ipcRenderer.invoke("download:preview", form),
  openDownloadDirectory: (form) => ipcRenderer.invoke("download:openDirectory", form),
  listRepoFiles: (form) => ipcRenderer.invoke("repo:listFiles", form),
  startDownload: (form) => ipcRenderer.invoke("download:start", form),
  stopProcess: () => ipcRenderer.invoke("process:stop"),
  checkCli: () => ipcRenderer.invoke("cli:status"),
  installCli: () => ipcRenderer.invoke("cli:install"),
  onProcessProgress: (callback) => {
    ipcRenderer.on("process:progress", (_event, payload) => callback(payload));
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
