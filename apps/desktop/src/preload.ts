// Preload: runs before the page with access to Electron's IPC, and exposes a narrow, typed API as
// `window.away`. The page itself has no Node.js or Electron access (contextIsolation + sandbox).
import { contextBridge, ipcRenderer } from "electron";
import type { AwayApi, Status } from "./shared/api";

const api: AwayApi & { platform: string; onNavigate(listener: (route: string) => void): () => void } = {
  platform: process.platform,
  getStatus: () => ipcRenderer.invoke("away:getStatus"),
  onStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: Status) => listener(status);
    ipcRenderer.on("away:status", handler);
    return () => ipcRenderer.off("away:status", handler);
  },
  onNavigate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, route: string) => listener(route);
    ipcRenderer.on("away:navigate", handler);
    return () => ipcRenderer.off("away:navigate", handler);
  },
  listProjects: () => ipcRenderer.invoke("away:listProjects"),
  addProject: () => ipcRenderer.invoke("away:addProject"),
  removeProject: (id) => ipcRenderer.invoke("away:removeProject", id),
  listDevices: () => ipcRenderer.invoke("away:listDevices"),
  revokeDevice: (id) => ipcRenderer.invoke("away:revokeDevice", id),
  listSessions: () => ipcRenderer.invoke("away:listSessions"),
  createPairing: () => ipcRenderer.invoke("away:createPairing"),
  copyText: (text) => ipcRenderer.invoke("away:copyText", text),
};

contextBridge.exposeInMainWorld("away", api);
