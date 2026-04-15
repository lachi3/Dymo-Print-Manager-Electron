const { app, BrowserWindow, ipcMain, shell, globalShortcut, Tray, Menu } = require("electron");
const path = require("path");
const http = require("http");
const https = require("https");
const fs = require("fs");

const DEFAULT_LOCAL_URL = "http://localhost:3000";
const DEFAULT_REMOTE_URL = "http://SCBO-PC23X5RJ:3000";

let mainWindow = null;
let remoteWindow = null;
let tray = null;

function log(...args) {
  console.log("[DymoPrintManager]", ...args);
}

function getTrayIconPath() {
  if (app.isPackaged) {
    // After build → goes into resources folder
    return path.join(process.resourcesPath, 'dymo_ico.png');
  } else {
    // In development
    return path.join(__dirname, '..', 'build', 'dymo_ico.png');
  }
}

function getArgValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function normalizeUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function getConfigDir() {
  return path.join(app.getPath("userData"), "app-config");
}

function getConfigPath() {
  return path.join(getConfigDir(), "settings.json");
}

function ensureConfigDir() {
  fs.mkdirSync(getConfigDir(), { recursive: true });
}

function readSettings() {
  try {
    const filePath = getConfigPath();

    if (!fs.existsSync(filePath)) {
      return {};
    }

    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    log("Failed to read settings:", error);
    return {};
  }
}

function writeSettings(settings) {
  try {
    ensureConfigDir();
    fs.writeFileSync(getConfigPath(), JSON.stringify(settings, null, 2), "utf8");
    return true;
  } catch (error) {
    log("Failed to write settings:", error);
    return false;
  }
}

function getServerTargets() {
  const argLocalUrl = normalizeUrl(getArgValue("local-url"));
  const argRemoteUrl = normalizeUrl(getArgValue("remote-url"));
  const settings = readSettings();
  const savedRemoteUrl = normalizeUrl(settings.remoteUrl);

  const local = argLocalUrl || DEFAULT_LOCAL_URL;
  const remote = argRemoteUrl || savedRemoteUrl || DEFAULT_REMOTE_URL;

  return {
    local,
    remote,
    remoteSource: argRemoteUrl
      ? "launch-arg"
      : savedRemoteUrl
        ? "saved"
        : "default"
  };
}

function checkUrl(url, timeout = 2000) {
  return new Promise((resolve) => {
    try {
      const client = url.startsWith("https:") ? https : http;

      const req = client.request(
        url,
        {
          method: "GET",
          timeout
        },
        () => {
          resolve(true);
          req.destroy();
        }
      );

      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });

      req.on("error", () => {
        resolve(false);
      });

      req.end();
    } catch {
      resolve(false);
    }
  });
}

async function getBestTarget() {
  const targets = getServerTargets();

  log("Checking local target:", targets.local);
  const localOk = await checkUrl(targets.local);

  if (localOk) {
    log("Using local target:", targets.local);
    return {
      mode: "local",
      url: targets.local,
      targets
    };
  }

  log("Local target unavailable, checking remote target:", targets.remote);
  const remoteOk = await checkUrl(targets.remote);

  if (remoteOk) {
    log("Using remote target:", targets.remote);
    return {
      mode: "remote",
      url: targets.remote,
      targets
    };
  }

  log("No reachable target found. Showing offline page.");
  return {
    mode: "offline",
    url: null,
    targets
  };
}

async function showOfflinePage(win) {
  const offlinePath = path.join(__dirname, "offline.html");
  await win.loadFile(offlinePath);
}

async function loadBestTarget(win) {
  const result = await getBestTarget();

  if (result.url) {
    await win.loadURL(result.url);
  } else {
    await showOfflinePage(win);
  }

  return result;
}

function attachMainWindowShortcuts(win) {
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") {
      return;
    }

    if (input.key === "F10") {
      log("Focused-window shortcut detected: F10");
      openSetRemoteWindow();
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#0b1020",
    autoHideMenuBar: true,
    title: "Dymo Print Manager",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on(
    "did-fail-load",
    async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (!validatedURL || validatedURL.startsWith("file://")) return;

      log("Main window failed to load:", {
        errorCode,
        errorDescription,
        validatedURL
      });

      try {
        const result = await getBestTarget();

        if (result.url && validatedURL !== result.url) {
          log("Retrying with fallback URL:", result.url);
          await mainWindow.loadURL(result.url);
        } else if (!result.url) {
          log("Falling back to offline page");
          await showOfflinePage(mainWindow);
        }
      } catch (error) {
        log("Fallback after did-fail-load failed:", error);
        await showOfflinePage(mainWindow);
      }
    }
  );

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  attachMainWindowShortcuts(mainWindow);

  return mainWindow;
}

function openSetRemoteWindow() {
  log("openSetRemoteWindow called");

  if (remoteWindow && !remoteWindow.isDestroyed()) {
    log("Remote window already exists, focusing it");
    remoteWindow.show();
    remoteWindow.focus();
    return;
  }

  remoteWindow = new BrowserWindow({
    width: 560,
    height: 460,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: "Set Remote URL",
    backgroundColor: "#f4f7fb",
    show: false,
    // Temporarily not modal/parented to avoid hidden-window weirdness
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  remoteWindow.once("ready-to-show", () => {
    log("Set Remote window ready to show");
    remoteWindow.show();
    remoteWindow.focus();
  });

  remoteWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
    log("Set Remote window failed to load:", { code, desc, url });
  });

  remoteWindow.on("closed", () => {
    log("Set Remote window closed");
    remoteWindow = null;
  });

  const remotePagePath = path.join(__dirname, "set-remote.html");
  log("Loading Set Remote page:", remotePagePath);
  remoteWindow.loadFile(remotePagePath).catch((error) => {
    log("Failed to load set-remote.html:", error);
  });
}

async function createAndLoadMainWindow() {
  createMainWindow();
  await loadBestTarget(mainWindow);
}

app.whenReady().then(async () => {
  log("App ready");
  log("userData path:", app.getPath("userData"));
  log("settings path:", getConfigPath());
  log("argv:", process.argv);

  await createAndLoadMainWindow();
  const iconPath = getTrayIconPath();

  tray = new Tray(iconPath);
  tray.setToolTip("Dymo Print Manager");

  const trayMenu = Menu.buildFromTemplate([
    {
      label: "Open",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: "Set Remote URL",
      click: () => openSetRemoteWindow()
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(trayMenu);

  const shortcutRegistered = globalShortcut.register("F10", () => {
    log("Global shortcut pressed: F10");
    openSetRemoteWindow();
  });

  log("Global shortcut F10 registered:", shortcutRegistered);
  log("Global shortcut F10 active:", globalShortcut.isRegistered("F10"));

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createAndLoadMainWindow();
    }
  });
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

ipcMain.handle("app:retry-connection", async () => {
  if (!mainWindow) {
    return { ok: false };
  }

  const result = await loadBestTarget(mainWindow);
  return {
    ok: result.mode !== "offline",
    ...result
  };
});

ipcMain.handle("app:get-server-targets", async () => {
  return getServerTargets();
});

ipcMain.handle("app:open-set-remote-window", async () => {
  openSetRemoteWindow();
  return { ok: true };
});

ipcMain.handle("app:get-remote-settings", async () => {
  const settings = readSettings();
  const targets = getServerTargets();

  return {
    savedRemoteUrl: normalizeUrl(settings.remoteUrl) || "",
    effectiveRemoteUrl: targets.remote,
    remoteSource: targets.remoteSource,
    defaultRemoteUrl: DEFAULT_REMOTE_URL
  };
});

ipcMain.handle("app:save-remote-url", async (_event, remoteUrl) => {
  const argRemoteUrl = normalizeUrl(getArgValue("remote-url"));

  if (argRemoteUrl) {
    return {
      ok: false,
      message: "A launch argument is currently overriding the remote URL. Remove --remote-url to use a saved value."
    };
  }

  if (remoteUrl === "" || remoteUrl === null) {
    const settings = readSettings();
    delete settings.remoteUrl;

    const ok = writeSettings(settings);

    return {
      ok,
      message: ok ? "Saved remote URL cleared." : "Could not clear the saved remote URL."
    };
  }

  const normalized = normalizeUrl(remoteUrl);

  if (!normalized) {
    return {
      ok: false,
      message: "Enter a valid http:// or https:// URL."
    };
  }

  const settings = readSettings();
  settings.remoteUrl = normalized;

  const ok = writeSettings(settings);

  return {
    ok,
    message: ok ? "Remote URL saved." : "Could not save the remote URL.",
    remoteUrl: normalized
  };
});

ipcMain.handle("app:apply-remote-url-and-reconnect", async (_event, remoteUrl) => {
  const argRemoteUrl = normalizeUrl(getArgValue("remote-url"));

  if (argRemoteUrl) {
    return {
      ok: false,
      message: "A launch argument is currently overriding the remote URL. Remove --remote-url to use a saved value."
    };
  }

  let saveResponse;

  if (remoteUrl === "" || remoteUrl === null) {
    const settings = readSettings();
    delete settings.remoteUrl;

    const ok = writeSettings(settings);

    saveResponse = {
      ok,
      message: ok ? "Saved remote URL cleared." : "Could not clear the saved remote URL."
    };
  } else {
    const normalized = normalizeUrl(remoteUrl);

    if (!normalized) {
      return {
        ok: false,
        message: "Enter a valid http:// or https:// URL."
      };
    }

    const settings = readSettings();
    settings.remoteUrl = normalized;

    const ok = writeSettings(settings);

    saveResponse = {
      ok,
      message: ok ? "Remote URL saved." : "Could not save the remote URL.",
      remoteUrl: normalized
    };
  }

  if (!saveResponse.ok) {
    return saveResponse;
  }

  if (remoteWindow && !remoteWindow.isDestroyed()) {
    remoteWindow.close();
  }

  if (mainWindow) {
    const result = await loadBestTarget(mainWindow);

    return {
      ok: true,
      message: saveResponse.message,
      result
    };
  }

  return {
    ok: true,
    message: saveResponse.message
  };
});