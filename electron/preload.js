const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  retryConnection: () => ipcRenderer.invoke("app:retry-connection"),
  getServerTargets: () => ipcRenderer.invoke("app:get-server-targets"),
  openSetRemoteWindow: () => ipcRenderer.invoke("app:open-set-remote-window"),
  getRemoteSettings: () => ipcRenderer.invoke("app:get-remote-settings"),
  saveRemoteUrl: (remoteUrl) => ipcRenderer.invoke("app:save-remote-url", remoteUrl),
  applyRemoteUrlAndReconnect: (remoteUrl) =>
    ipcRenderer.invoke("app:apply-remote-url-and-reconnect", remoteUrl)
});