const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildDownloadPlan, MIRROR_ENDPOINT } = require("./src/command");
const {
  createFavoriteItem,
  createHistoryItem,
  normalizeLibrary,
  removeById,
  updateHistoryStatus,
  upsertFavorite,
  upsertHistory
} = require("./src/library");
const {
  appendQueueItem,
  clearFinishedQueueItems,
  createQueueItem,
  nextQueuedItem,
  normalizeQueue,
  removeQueueItem,
  updateQueueItem
} = require("./src/queue");

let mainWindow;
let activeProcess = null;
let activeKind = "";
let activeContext = {};
let activeHistoryId = "";
let activeQueueId = "";
let activeTerminationStatus = "";
let queueState = normalizeQueue();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 920,
    minWidth: 980,
    minHeight: 780,
    title: "HF Downloader",
    backgroundColor: "#f7f8fb",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(async () => {
  queueState = await loadSavedQueue();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function libraryPath() {
  return path.join(app.getPath("userData"), "library.json");
}

function queuePath() {
  return path.join(app.getPath("userData"), "queue.json");
}

function randomId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function defaultSettings() {
  return {
    repoType: "model",
    repoId: "gpt2",
    files: "",
    localDir: path.join(os.homedir(), "Downloads", "huggingface", "gpt2"),
    cacheDir: "",
    source: "official",
    endpoint: MIRROR_ENDPOINT,
    revision: "",
    include: "",
    exclude: "",
    token: "",
    maxWorkers: 8,
    downloadTimeout: 30,
    etagTimeout: 10,
    dryRun: false,
    forceDownload: false,
    quiet: false,
    highPerformance: false,
    disableSymlinks: true
  };
}

async function loadSettings() {
  try {
    const content = await fs.readFile(settingsPath(), "utf8");
    return { ...defaultSettings(), ...JSON.parse(content), token: "" };
  } catch {
    return defaultSettings();
  }
}

async function saveSettings(settings) {
  const safeSettings = { ...settings, token: "" };
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(safeSettings, null, 2), "utf8");
  return true;
}

async function loadLibrary() {
  try {
    const content = await fs.readFile(libraryPath(), "utf8");
    return normalizeLibrary(JSON.parse(content));
  } catch {
    return normalizeLibrary();
  }
}

async function saveLibrary(library) {
  const normalized = normalizeLibrary(library);
  await fs.mkdir(path.dirname(libraryPath()), { recursive: true });
  await fs.writeFile(libraryPath(), JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

async function publishLibrary(library) {
  const saved = await saveLibrary(library);
  emit("library:changed", saved);
  return saved;
}

async function appendHistory(form, plan) {
  const library = await loadLibrary();
  const item = createHistoryItem(randomId("history"), form, plan);
  const saved = await publishLibrary(upsertHistory(library, item));
  return { item, library: saved };
}

async function markHistoryDone(id, code) {
  if (!id) {
    return;
  }
  const library = await loadLibrary();
  const status = code === 0 ? "completed" : "failed";
  await publishLibrary(updateHistoryStatus(library, id, status, code));
}

async function markHistoryStatus(id, status, code) {
  if (!id) {
    return;
  }
  const library = await loadLibrary();
  await publishLibrary(updateHistoryStatus(library, id, status, code));
}

async function loadSavedQueue() {
  try {
    const content = await fs.readFile(queuePath(), "utf8");
    const queue = normalizeQueue(JSON.parse(content));
    queue.items = queue.items.map((item) =>
      item.status === "running" ? { ...item, status: "queued", historyId: "", startedAt: "", exitCode: null } : item
    );
    return queue;
  } catch {
    return normalizeQueue();
  }
}

async function saveQueue(queue) {
  const normalized = normalizeQueue(queue);
  normalized.running = Boolean(queue?.running);
  normalized.paused = Boolean(queue?.paused);
  await fs.mkdir(path.dirname(queuePath()), { recursive: true });
  await fs.writeFile(queuePath(), JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

async function publishQueue(queue) {
  queueState = await saveQueue(queue);
  emit("queue:changed", queueState);
  return queueState;
}

function emit(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function runCapture(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1" }
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
    }, options.timeoutMs ?? 7000);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, stdout, stderr: stderr || error.message, code: -1 });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

async function whereCommand(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = await runCapture(locator, [command], { timeoutMs: 5000 });
  if (!result.ok) {
    return "";
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? "";
}

async function resolveCli() {
  const hfPath = await whereCommand("hf");
  if (hfPath) {
    return { name: "hf", path: hfPath, modern: true };
  }

  const legacyPath = await whereCommand("huggingface-cli");
  if (legacyPath) {
    return { name: "huggingface-cli", path: legacyPath, modern: false };
  }

  return null;
}

async function getCommandVersion(cli) {
  if (!cli) {
    return "";
  }

  if (cli.modern) {
    const result = await runCapture(cli.path, ["version"], { timeoutMs: 8000 });
    return (result.stdout || result.stderr).trim();
  }

  const result = await runCapture(cli.path, ["--version"], { timeoutMs: 8000 });
  return (result.stdout || result.stderr).trim();
}

async function detectPython() {
  const py = await whereCommand("python");
  const pip = await whereCommand("pip");
  let pythonVersion = "";
  let hubVersion = "";

  if (py) {
    const version = await runCapture(py, ["--version"], { timeoutMs: 5000 });
    pythonVersion = (version.stdout || version.stderr).trim();

    const hub = await runCapture(py, ["-m", "pip", "show", "huggingface_hub"], { timeoutMs: 8000 });
    const versionLine = (hub.stdout || "")
      .split(/\r?\n/)
      .find((line) => line.toLowerCase().startsWith("version:"));
    hubVersion = versionLine ? versionLine.replace(/^version:\s*/i, "").trim() : "";
  }

  return { pythonPath: py, pipPath: pip, pythonVersion, hubVersion };
}

function spawnManaged(commandPath, args, env, kind, context = {}) {
  const child = spawn(commandPath, args, {
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...env }
  });

  activeProcess = child;
  activeKind = kind;
  activeContext = context;

  const push = (stream, chunk) => {
    emit("process:output", {
      stream,
      text: chunk.toString("utf8")
    });
  };

  child.stdout?.on("data", (chunk) => push("stdout", chunk));
  child.stderr?.on("data", (chunk) => push("stderr", chunk));

  child.on("error", (error) => {
    emit("process:output", { stream: "stderr", text: `${error.message}\n` });
  });

  child.on("close", (code) => {
    const context = activeContext;
    const historyId = context.historyId || activeHistoryId;
    const queueId = context.queueId || "";
    const state = activeTerminationStatus || (code === 0 ? "completed" : "failed");
    const shouldEmitStatus = !queueId;

    if (shouldEmitStatus) {
      emit("process:status", { state, code, kind });
    } else {
      emit("process:status", { state: "item-completed", code, kind, queueId, itemState: state });
    }

    activeProcess = null;
    activeKind = "";
    activeContext = {};
    activeHistoryId = "";
    activeQueueId = "";
    activeTerminationStatus = "";

    handleProcessClosed(kind, historyId, queueId, state, code).catch((error) => {
      emit("process:output", { stream: "stderr", text: `[任务] ${error.message}\n` });
    });
  });

  return child;
}

async function handleProcessClosed(kind, historyId, queueId, state, code) {
  if (kind === "download" && historyId) {
    await markHistoryStatus(historyId, state, code);
  }

  if (!queueId) {
    return;
  }

  queueState = updateQueueItem(queueState, queueId, {
    status: state,
    exitCode: code,
    completedAt: new Date().toISOString()
  });
  await publishQueue(queueState);

  if (queueState.running && !queueState.paused) {
    await startNextQueueItem();
  }
}

function killActiveProcess(finalStatus = "canceled") {
  if (!activeProcess) {
    return false;
  }

  activeTerminationStatus = finalStatus;
  const pid = activeProcess.pid;
  if (process.platform === "win32" && pid) {
    spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    activeProcess.kill("SIGTERM");
  }

  emit("process:status", { state: "stopping", kind: activeKind });
  return true;
}

ipcMain.handle("settings:load", loadSettings);
ipcMain.handle("settings:save", (_event, settings) => saveSettings(settings));
ipcMain.handle("library:load", loadLibrary);
ipcMain.handle("queue:load", () => queueState);

ipcMain.handle("queue:add", async (_event, form) => {
  const cli = await resolveCli();
  const plan = buildDownloadPlan(form, cli?.name ?? "hf");
  const item = createQueueItem(randomId("queue"), form, plan);
  return publishQueue(appendQueueItem(queueState, item));
});

ipcMain.handle("queue:start", async () => {
  if (activeProcess) {
    throw new Error("已有任务在运行。");
  }
  queueState = { ...queueState, running: true, paused: false };
  await publishQueue(queueState);
  emit("process:status", { state: "running", kind: "queue" });
  await startNextQueueItem();
  return queueState;
});

ipcMain.handle("queue:stop", async () => {
  queueState = { ...queueState, running: false, paused: true };
  await publishQueue(queueState);
  if (activeQueueId) {
    killActiveProcess("canceled");
  }
  return queueState;
});

ipcMain.handle("queue:remove", async (_event, id) => {
  if (id && id === activeQueueId) {
    queueState = { ...queueState, running: false, paused: true };
    await publishQueue(queueState);
    killActiveProcess("canceled");
    return queueState;
  }
  return publishQueue(removeQueueItem(queueState, id));
});

ipcMain.handle("queue:clear", async () => {
  return publishQueue(clearFinishedQueueItems(queueState));
});

ipcMain.handle("favorites:add", async (_event, form) => {
  if (!String(form?.repoId ?? "").trim()) {
    throw new Error("请输入仓库 ID 后再收藏。");
  }
  const library = await loadLibrary();
  const item = createFavoriteItem(randomId("favorite"), form);
  const result = upsertFavorite(library, item);
  const saved = await publishLibrary(result.library);
  return { item: result.item, library: saved };
});

ipcMain.handle("favorites:remove", async (_event, id) => {
  const library = await loadLibrary();
  return publishLibrary(removeById(library, "favorites", id));
});

ipcMain.handle("history:remove", async (_event, id) => {
  const library = await loadLibrary();
  return publishLibrary(removeById(library, "history", id));
});

ipcMain.handle("history:clear", async () => {
  const library = await loadLibrary();
  return publishLibrary({ ...library, history: [] });
});

ipcMain.handle("dialog:selectFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"]
  });
  return result.canceled ? "" : result.filePaths[0];
});

ipcMain.handle("shell:openPath", async (_event, targetPath) => {
  if (!targetPath) {
    return "路径为空";
  }
  return shell.openPath(targetPath);
});

ipcMain.handle("clipboard:writeText", (_event, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});

ipcMain.handle("download:preview", async (_event, form) => {
  const cli = await resolveCli();
  const plan = buildDownloadPlan(form, cli?.name ?? "hf");
  return { ...plan, cli };
});

ipcMain.handle("cli:status", async () => {
  const cli = await resolveCli();
  const version = await getCommandVersion(cli);
  const python = await detectPython();
  return { cli, version, python };
});

ipcMain.handle("cli:install", async () => {
  if (activeProcess) {
    throw new Error("已有任务在运行。");
  }
  const python = await detectPython();
  if (!python.pythonPath) {
    throw new Error("未找到 python，无法通过 pip 安装 huggingface_hub。");
  }
  emit("process:status", { state: "running", kind: "install" });
  spawnManaged(python.pythonPath, ["-m", "pip", "install", "-U", "huggingface_hub"], {}, "install");
  return true;
});

ipcMain.handle("download:start", async (_event, form) => {
  if (activeProcess) {
    throw new Error("已有任务在运行。");
  }

  const cli = await resolveCli();
  if (!cli) {
    throw new Error("未找到 `hf` 或 `huggingface-cli`。请先安装或更新 Hugging Face CLI。");
  }

  const plan = buildDownloadPlan(form, cli.name);
  const { item } = await appendHistory(form, plan);
  activeHistoryId = item.id;
  emit("process:status", { state: "running", kind: "download", plan: { ...plan, displayCommand: plan.maskedCommand } });
  spawnManaged(cli.path, plan.args, plan.env, "download", { historyId: item.id });
  return { ...plan, cli, historyItem: item };
});

ipcMain.handle("process:stop", async () => {
  if (activeQueueId) {
    queueState = { ...queueState, running: false, paused: true };
    await publishQueue(queueState);
  }
  return killActiveProcess();
});

async function startNextQueueItem() {
  if (activeProcess || queueState.paused) {
    return;
  }

  const item = nextQueuedItem(queueState);
  if (!item) {
    queueState = { ...queueState, running: false, paused: false };
    await publishQueue(queueState);
    emit("process:status", { state: "completed", kind: "queue" });
    return;
  }

  const startedAt = new Date().toISOString();
  let cli;
  let plan;

  try {
    cli = await resolveCli();
    if (!cli) {
      throw new Error("未找到 `hf` 或 `huggingface-cli`。");
    }
    plan = buildDownloadPlan(item.form, cli.name);
  } catch (error) {
    queueState = updateQueueItem(queueState, item.id, {
      status: "failed",
      exitCode: -1,
      completedAt: new Date().toISOString()
    });
    await publishQueue(queueState);
    emit("process:output", { stream: "stderr", text: `[队列] ${item.repoId}: ${error.message}\n` });
    await startNextQueueItem();
    return;
  }

  const { item: historyItem } = await appendHistory(item.form, plan);
  activeHistoryId = historyItem.id;
  activeQueueId = item.id;
  queueState = updateQueueItem(queueState, item.id, {
    status: "running",
    startedAt,
    historyId: historyItem.id,
    endpoint: plan.endpoint,
    command: plan.maskedCommand
  });
  await publishQueue(queueState);
  emit("process:output", { stream: "stdout", text: `[队列] 开始 ${item.repoId}\n[命令] ${plan.maskedCommand}\n\n` });
  spawnManaged(cli.path, plan.args, plan.env, "download", { historyId: historyItem.id, queueId: item.id });
}
