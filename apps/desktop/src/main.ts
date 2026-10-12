// Main process: owns the window, the tray, and the companion utility process.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Tray, utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";
import QRCode from "qrcode";
import type { Pairing, Status, WorkerMessage, WorkerRequest } from "./shared/api";
import { TRAY_ICON_1X, TRAY_ICON_2X } from "./tray-icon";

// Windows installer events start the app briefly; quit immediately in that case.
if (started) app.quit();

// Only one Away may run: two companions with the same identity would keep replacing each other at
// the relay. A second launch focuses the existing window instead.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
app.on("second-instance", () => showWindow());

const PAIRING_TTL_MS = 5 * 60 * 1000;

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let worker: UtilityProcess | undefined;
let quitting = false;
let nextRequestId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const status: Status = { relay: { state: "connecting", detail: null }, laptopName: "", relayUrl: "" };

function startWorker() {
  worker = utilityProcess.fork(path.join(__dirname, "companion.mjs"), [], { serviceName: "Away companion", stdio: "inherit" });
  worker.on("message", (message: WorkerMessage) => {
    if ("event" in message) {
      status.relay = { state: message.state, detail: message.detail };
      broadcastStatus();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  worker.on("exit", (code) => {
    if (quitting) return;
    dialog.showErrorBox("Away", `The Away companion stopped unexpectedly (code ${code}).`);
    app.quit();
  });
}

function ask<T>(request: WorkerRequest): Promise<T> {
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    worker?.postMessage({ id, request });
  });
}

function broadcastStatus() {
  window?.webContents.send("away:status", status);
  updateTray();
}

function createWindow() {
  window = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    title: "Away",
    // Native macOS feel: content under the title bar, inset traffic lights, translucent sidebar.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: "sidebar",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    // Shown once the first frame is painted, so there is no white flash.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window?.show());
  // Closing the window keeps Away running in the tray. Quit from the tray stops it.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  // Links never open inside the app window.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));

  captureForDevelopment(window);
}

function showWindow() {
  if (!window) createWindow();
  window?.show();
  window?.focus();
}

function createTray() {
  const icon = nativeImage.createEmpty();
  icon.addRepresentation({ scaleFactor: 1, dataURL: TRAY_ICON_1X });
  icon.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Away");
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const label = { online: "Remote access on", connecting: "Connecting…", offline: "Offline" }[status.relay.state];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: "separator" },
      { label: "Open Away", click: showWindow },
      {
        label: "Pair a Phone…",
        click: () => {
          showWindow();
          window?.webContents.send("away:navigate", "pair");
        },
      },
      { type: "separator" },
      { label: "Quit Away", accelerator: "Command+Q", click: () => app.quit() },
    ]),
  );
}

function registerIpc() {
  ipcMain.handle("away:getStatus", () => status);
  ipcMain.handle("away:listProjects", () => ask({ type: "listProjects" }));
  ipcMain.handle("away:addProject", async () => {
    // The project folder is always chosen explicitly by the user on the laptop.
    const options: Electron.OpenDialogOptions = { title: "Choose a project folder", properties: ["openDirectory"] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return null;
    return ask({ type: "addProject", path: folder });
  });
  ipcMain.handle("away:removeProject", (_event, id: string) => ask({ type: "removeProject", id }));
  ipcMain.handle("away:listDevices", () => ask({ type: "listDevices" }));
  ipcMain.handle("away:revokeDevice", (_event, id: string) => ask({ type: "revokeDevice", id }));
  ipcMain.handle("away:listSessions", () => ask({ type: "listSessions" }));
  ipcMain.handle("away:createPairing", async (): Promise<Pairing> => {
    const offer = await ask<string>({ type: "pair" });
    const dark = nativeTheme.shouldUseDarkColors;
    const qr = await QRCode.toDataURL(offer, { margin: 1, width: 520, errorCorrectionLevel: "M", color: dark ? { dark: "#000000", light: "#ffffff" } : undefined });
    return { offer, qr, expiresAt: Date.now() + PAIRING_TTL_MS };
  });
  ipcMain.handle("away:copyText", (_event, text: string) => clipboard.writeText(text));
}

/**
 * Development only: AWAY_DEV_SCREENSHOTS=<folder> saves a capture of each page after load.
 * capturePage cannot record macOS vibrancy, so the sidebar gets an approximate solid color first.
 */
function captureForDevelopment(target: BrowserWindow) {
  const folder = process.env.AWAY_DEV_SCREENSHOTS;
  if (app.isPackaged || !folder) return;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  target.webContents.once("did-finish-load", async () => {
    const { writeFile } = await import("node:fs/promises");
    await wait(2500);
    await target.webContents.insertCSS(`aside { background: ${nativeTheme.shouldUseDarkColors ? "#2a2a2c" : "#ececee"}; }`);
    for (const route of ["overview", "projects", "devices", "sessions", "pair"]) {
      target.webContents.send("away:navigate", route);
      await wait(900);
      await writeFile(path.join(folder, `${route}.png`), (await target.webContents.capturePage()).toPNG());
    }
    console.log(`[dev] saved screenshots to ${folder}`);
  });
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  startWorker();
  registerIpc();
  const info = await ask<{ laptopName: string; relayUrl: string }>({ type: "info" });
  status.laptopName = info.laptopName;
  status.relayUrl = info.relayUrl;
  createTray();
  createWindow();
  app.on("activate", showWindow);
});

// Away keeps running in the tray when its window is closed.
app.on("window-all-closed", () => {});

app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  // Stop agents and disconnect cleanly, then exit. Force-kill if that takes too long.
  const timeout = setTimeout(() => worker?.kill(), 10_000);
  ask({ type: "stop" })
    .catch(() => {})
    .finally(() => {
      clearTimeout(timeout);
      app.exit(0);
    });
});
