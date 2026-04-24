const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildDownloadPlan, DEFAULT_ENDPOINT, MIRROR_ENDPOINT, normalizeEndpoint, splitFilenames, splitList } = require("./src/command");
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
const STRUCTURED_EVENT_PREFIX = "__HF_EVENT__ ";
const DOWNLOAD_RUNNER_FILENAME = "hf_download_runner.py";
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy"];
const LOG_FILE_NAME = "hf-downloader.log";
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_FILES = 4;
let logWriteChain = Promise.resolve();

function structuredPhaseText(phase) {
  if (phase === "completed") {
    return "下载已完成";
  }
  if (phase === "downloading") {
    return "正在下载数据";
  }
  return "正在准备下载任务";
}

function createProgressTracker(kind, form, plan) {
  const explicitFiles = splitFilenames(form.files);
  const filteredFileCount = Number.isFinite(Number(form.filteredFileCount)) ? Number(form.filteredFileCount) : 0;
  const previewTotalFiles = Number.isFinite(Number(form.previewTotalFiles)) ? Number(form.previewTotalFiles) : 0;
  const hasScopedFilters = Boolean(cleanText(form.include) || cleanText(form.exclude));
  const estimatedTotal =
    explicitFiles.length ||
    (hasScopedFilters ? filteredFileCount : Math.max(previewTotalFiles, filteredFileCount)) ||
    0;

  return {
    kind,
    state: "running",
    repoId: cleanText(form.repoId),
    endpoint: plan.endpoint,
    totalFiles: estimatedTotal,
    completedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    percent: 0,
    currentFile: explicitFiles.length === 1 ? explicitFiles[0] : "",
    phase: explicitFiles.length ? "准备下载已选文件" : estimatedTotal ? "准备下载筛选结果" : "等待仓库返回文件清单"
  };
}

function emitProgress(tracker) {
  if (!tracker) {
    return;
  }

  const totalFiles = Number(tracker.totalFiles) || 0;
  const completedFiles = Math.max(0, Number(tracker.completedFiles) || 0);
  const totalBytes = Math.max(0, Number(tracker.totalBytes) || 0);
  const transferredBytes = Math.max(0, Number(tracker.transferredBytes) || 0);
  let percent = Number.isFinite(Number(tracker.percent)) ? Number(tracker.percent) : 0;

  if (!Number.isFinite(percent) || percent < 0) {
    percent = 0;
  }
  if (totalBytes > 0) {
    percent = Math.round((Math.min(transferredBytes, totalBytes) / totalBytes) * 100);
  } else if (totalFiles > 0) {
    percent = Math.max(percent, Math.round((Math.min(completedFiles, totalFiles) / totalFiles) * 100));
  }
  percent = Math.min(percent, 100);

  emit("process:progress", {
    ...tracker,
    totalBytes,
    transferredBytes: totalBytes > 0 ? Math.min(transferredBytes, totalBytes) : transferredBytes,
    totalFiles,
    completedFiles: totalFiles > 0 ? Math.min(completedFiles, totalFiles) : completedFiles,
    percent
  });
}

function updateProgressFromOutput(tracker, text) {
  if (!tracker || tracker.kind !== "download") {
    return false;
  }

  let changed = false;
  const content = String(text ?? "");

  const fetchingMatch = /Fetching\s+(\d+)\s+files?/i.exec(content);
  if (fetchingMatch) {
    const totalFiles = Number(fetchingMatch[1]) || 0;
    if (totalFiles && tracker.totalFiles !== totalFiles) {
      tracker.totalFiles = totalFiles;
      tracker.phase = "正在拉取和校验仓库文件";
      changed = true;
    }
  }

  const fileProgressRegex = /(^|[\r\n])([^:\r\n]{1,220}):\s*(\d{1,3})%\|/g;
  for (const match of content.matchAll(fileProgressRegex)) {
    const currentFile = cleanText(match[2]);
    const percent = Number(match[3]) || 0;

    if (currentFile && !currentFile.toLowerCase().startsWith("fetching ")) {
      tracker.currentFile = currentFile;
    }
    if (tracker.totalFiles <= 1 && percent > tracker.percent) {
      tracker.percent = percent;
    }
    tracker.phase = "正在下载文件";
    changed = true;
  }

  const aggregateProgressRegex = /(\d{1,3})%\|[^\r\n]*?\|\s*(\d+)\/(\d+)(?![0-9A-Za-z.])/g;
  for (const match of content.matchAll(aggregateProgressRegex)) {
    const percent = Number(match[1]) || 0;
    const completedFiles = Number(match[2]) || 0;
    const totalFiles = Number(match[3]) || 0;

    if (totalFiles && tracker.totalFiles !== totalFiles) {
      tracker.totalFiles = totalFiles;
    }
    if (completedFiles > tracker.completedFiles) {
      tracker.completedFiles = completedFiles;
    }
    if (percent > tracker.percent) {
      tracker.percent = percent;
    }
    tracker.phase = "正在下载文件";
    changed = true;
  }

  const downloadingMatch = /Downloading\s+'([^']+)'/i.exec(content);
  if (downloadingMatch && cleanText(downloadingMatch[1]) && tracker.currentFile !== cleanText(downloadingMatch[1])) {
    tracker.currentFile = cleanText(downloadingMatch[1]);
    tracker.phase = "正在下载文件";
    changed = true;
  }

  return changed;
}

function applyStructuredProgressEvent(tracker, payload) {
  if (!tracker || payload?.event !== "progress") {
    return false;
  }

  const payloadTotalBytes = Number(payload.total_bytes);
  const payloadDownloadedBytes = Number(payload.downloaded_bytes);
  const payloadPercent = Number(payload.percent);

  if (Number.isFinite(Number(payload.total_bytes))) {
    tracker.totalBytes = Math.max(0, payloadTotalBytes);
  }
  if (Number.isFinite(Number(payload.downloaded_bytes))) {
    tracker.transferredBytes = Math.max(0, payloadDownloadedBytes);
  }
  if (Number.isFinite(Number(payload.percent))) {
    tracker.percent = Math.max(0, payloadPercent);
  }

  const completeByBytes = tracker.totalBytes > 0 && tracker.transferredBytes >= tracker.totalBytes;
  const completeByPercent = Number.isFinite(payloadPercent) && payloadPercent >= 100;
  const isComplete = payload.phase === "completed" && (completeByBytes || completeByPercent);
  const phase = isComplete ? "completed" : payload.phase === "completed" ? "downloading" : payload.phase;

  if (phase) {
    tracker.phase = structuredPhaseText(phase);
  }
  tracker.state = isComplete ? "completed" : "running";
  emitProgress(tracker);
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 920,
    minWidth: 640,
    minHeight: 640,
    title: "HF Downloader",
    backgroundColor: "#f5f7fa",
    autoHideMenuBar: true,
    frame: false,
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

function sessionPath() {
  return path.join(app.getPath("userData"), "session.json");
}

function randomId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function logsDirectoryPath() {
  return path.join(app.getPath("userData"), "logs");
}

function logFilePath() {
  return path.join(logsDirectoryPath(), LOG_FILE_NAME);
}

function rotatedLogFilePath(index) {
  return path.join(logsDirectoryPath(), `${LOG_FILE_NAME}.${index}`);
}

function normalizeLogText(text) {
  return String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n");
}

function formatLogEntry(stream, text) {
  const timestamp = new Date().toISOString();
  const label = stream === "stderr" ? "ERR" : "OUT";
  const normalized = normalizeLogText(text).replace(/\r?\n$/, "");
  const lines = normalized ? normalized.split(/\r?\n/) : [""];
  return `${lines.map((line) => `[${timestamp}] [${label}] ${line}`).join(os.EOL)}${os.EOL}`;
}

async function ensureLogDirectory() {
  await fs.mkdir(logsDirectoryPath(), { recursive: true });
}

async function rotateLogIfNeeded(incomingBytes = 0) {
  await ensureLogDirectory();
  const targetPath = logFilePath();
  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat || stat.size + incomingBytes <= MAX_LOG_BYTES) {
    return;
  }

  await fs.rm(rotatedLogFilePath(MAX_LOG_FILES), { force: true });
  for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
    const from = rotatedLogFilePath(index);
    const to = rotatedLogFilePath(index + 1);
    try {
      await fs.rename(from, to);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  await fs.rename(targetPath, rotatedLogFilePath(1)).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

async function writeLogNow(text, stream = "stdout") {
  const entry = formatLogEntry(stream, text);
  await rotateLogIfNeeded(Buffer.byteLength(entry, "utf8"));
  await fs.appendFile(logFilePath(), entry, "utf8");
}

function recordLog(stream, text) {
  logWriteChain = logWriteChain
    .then(() => writeLogNow(text, stream))
    .catch(() => {});
  return logWriteChain;
}

async function getLogStatus() {
  await ensureLogDirectory();
  const targetPath = logFilePath();
  const stat = await fs.stat(targetPath).catch(() => null);
  return {
    path: targetPath,
    directory: logsDirectoryPath(),
    size: stat?.size || 0,
    maxBytes: MAX_LOG_BYTES,
    maxFiles: MAX_LOG_FILES
  };
}

function endpointHostname(endpoint) {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function shouldBypassProxy(endpoint) {
  const hostname = endpointHostname(endpoint);
  return hostname === "hf-mirror.com" || hostname.endsWith(".hf-mirror.com");
}

function mergeNoProxy(existingValue, hosts) {
  const values = String(existingValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const seen = new Set(values.map((item) => item.toLowerCase()));

  for (const host of hosts) {
    if (!seen.has(host.toLowerCase())) {
      values.push(host);
      seen.add(host.toLowerCase());
    }
  }

  return values.join(",");
}

function createChildEnv(extraEnv = {}, context = {}) {
  const childEnv = { ...process.env, ...extraEnv };
  const endpoint = context.bypassProxyEndpoint || "";
  if (!shouldBypassProxy(endpoint)) {
    return childEnv;
  }

  for (const key of PROXY_ENV_KEYS) {
    delete childEnv[key];
  }

  const noProxyValue = mergeNoProxy(childEnv.NO_PROXY || childEnv.no_proxy, ["hf-mirror.com", ".hf-mirror.com"]);
  for (const key of NO_PROXY_ENV_KEYS) {
    childEnv[key] = noProxyValue;
  }

  return childEnv;
}

function globToRegExp(pattern) {
  const source = String(pattern)
    .split("")
    .map((char) => {
      if (char === "*") {
        return ".*";
      }
      if (char === "?") {
        return ".";
      }
      return char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`, "i");
}

function fileMatchesPattern(filePath, pattern) {
  const normalizedPath = String(filePath).replace(/\\/g, "/");
  const normalizedPattern = String(pattern).replace(/\\/g, "/");
  const basename = normalizedPath.split("/").pop() || normalizedPath;
  const target = normalizedPattern.includes("/") ? normalizedPath : basename;
  return globToRegExp(normalizedPattern).test(target);
}

function filteredExplicitFiles(form) {
  const includePatterns = splitList(form?.include);
  const excludePatterns = splitList(form?.exclude);
  return splitFilenames(form?.files).filter((filePath) => {
    if (includePatterns.length && !includePatterns.some((pattern) => fileMatchesPattern(filePath, pattern))) {
      return false;
    }
    if (excludePatterns.some((pattern) => fileMatchesPattern(filePath, pattern))) {
      return false;
    }
    return true;
  });
}

function repoPathSegments(filePath) {
  return String(filePath)
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== ".." && !part.endsWith(":"));
}

function commonDirectory(directories) {
  const cleanDirectories = directories.map((directory) => path.resolve(directory));
  if (!cleanDirectories.length) {
    return "";
  }
  let common = cleanDirectories[0];
  for (const directory of cleanDirectories.slice(1)) {
    while (common && directory !== common && !directory.startsWith(`${common}${path.sep}`)) {
      const parent = path.dirname(common);
      if (parent === common) {
        return parent;
      }
      common = parent;
    }
  }
  return common;
}

function resolveDownloadDirectory(form) {
  const localDir = cleanText(form?.localDir);
  if (!localDir) {
    return "";
  }

  const explicitFiles = filteredExplicitFiles(form);
  if (!explicitFiles.length) {
    return path.resolve(localDir);
  }

  const directories = explicitFiles
    .map((filePath) => repoPathSegments(filePath))
    .filter((segments) => segments.length)
    .map((segments) => path.dirname(path.join(localDir, ...segments)));

  return commonDirectory(directories) || path.resolve(localDir);
}

function withDownloadDirectory(item, form) {
  const downloadDir = resolveDownloadDirectory(form);
  return downloadDir ? { ...item, downloadDir } : item;
}

function downloadRunnerCandidates() {
  const sourceRunnerPath = path.join(__dirname, "src", DOWNLOAD_RUNNER_FILENAME);
  if (!app.isPackaged) {
    return [sourceRunnerPath];
  }

  const unpackedRunnerPath = sourceRunnerPath.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );

  return [...new Set([path.join(process.resourcesPath, DOWNLOAD_RUNNER_FILENAME), unpackedRunnerPath])];
}

async function resolveDownloadRunnerPath() {
  for (const candidate of downloadRunnerCandidates()) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known packaged/development location.
    }
  }
  return "";
}

function defaultSettings() {
  return {
    repoType: "model",
    repoId: "gpt2",
    files: "",
    localDir: path.join(os.homedir(), "Downloads", "huggingface", "gpt2"),
    cacheDir: "",
    source: "mirror",
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

function sanitizeSettings(settings) {
  return { ...settings, token: "" };
}

function normalizeSessionFile(file) {
  return {
    path: String(file?.path ?? ""),
    size: Number(file?.size ?? 0) || 0,
    lfs: Boolean(file?.lfs),
    oid: String(file?.oid ?? "")
  };
}

function normalizeSession(session = {}) {
  const source = session && typeof session === "object" ? session : {};
  const form = source.form && typeof source.form === "object" ? sanitizeSettings(source.form) : {};
  const repoFiles = Array.isArray(source.repoFiles)
    ? source.repoFiles.map(normalizeSessionFile).filter((file) => file.path)
    : [];

  return {
    version: 1,
    savedAt: cleanText(source.savedAt),
    form,
    repoFiles,
    fileSearch: String(source.fileSearch ?? ""),
    filePreviewStatus: String(source.filePreviewStatus ?? "")
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
  const safeSettings = sanitizeSettings(settings);
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(safeSettings, null, 2), "utf8");
  return true;
}

function saveSettingsSync(settings) {
  const safeSettings = sanitizeSettings(settings);
  fsSync.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fsSync.writeFileSync(settingsPath(), JSON.stringify(safeSettings, null, 2), "utf8");
  return true;
}

async function loadSession() {
  try {
    const content = await fs.readFile(sessionPath(), "utf8");
    return normalizeSession(JSON.parse(content));
  } catch {
    return normalizeSession();
  }
}

async function saveSession(session) {
  const normalized = normalizeSession({ ...session, savedAt: new Date().toISOString() });
  await fs.mkdir(path.dirname(sessionPath()), { recursive: true });
  await fs.writeFile(sessionPath(), JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function saveSessionSync(session) {
  const normalized = normalizeSession({ ...session, savedAt: new Date().toISOString() });
  fsSync.mkdirSync(path.dirname(sessionPath()), { recursive: true });
  fsSync.writeFileSync(sessionPath(), JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
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
      withDownloadDirectory(
        item.status === "running" ? { ...item, status: "queued", historyId: "", startedAt: "", exitCode: null } : item,
        item.form || item
      )
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

function repoApiKind(repoType) {
  if (repoType === "dataset") {
    return "datasets";
  }
  if (repoType === "space") {
    return "spaces";
  }
  return "models";
}

function repoTreeUrl(form, nextUrl = "") {
  if (nextUrl) {
    return nextUrl;
  }

  const endpoint = (normalizeEndpoint(form) || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const repoId = cleanText(form.repoId);
  const revision = encodeURIComponent(cleanText(form.revision) || "main");
  const repoPath = repoId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${endpoint}/api/${repoApiKind(cleanText(form.repoType))}/${repoPath}/tree/${revision}?recursive=1`;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) {
    return "";
  }

  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }
  return "";
}

async function fetchJson(url, form) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const token = cleanText(form.token);
  const headers = { Accept: "application/json" };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();

    if (!response.ok) {
      let message = text;
      try {
        const errorPayload = JSON.parse(text);
        message = errorPayload.error || errorPayload.message || message;
      } catch {
        // Keep the raw server response if it is not JSON.
      }
      throw new Error(message || `HTTP ${response.status}`);
    }

    return {
      data: text ? JSON.parse(text) : [],
      next: parseNextLink(response.headers.get("link"))
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("文件列表请求超时。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function listRepoFiles(form) {
  const repoId = cleanText(form.repoId);
  const repoType = cleanText(form.repoType) || "model";

  if (!repoId) {
    throw new Error("请输入仓库 ID 后再预览文件。");
  }
  if (!["model", "dataset", "space"].includes(repoType)) {
    throw new Error("仓库类型只能是 model、dataset 或 space。");
  }

  let url = repoTreeUrl(form);
  const files = [];
  let pages = 0;

  while (url) {
    pages += 1;
    if (pages > 20) {
      throw new Error("文件列表过大，已停止继续拉取。");
    }

    const result = await fetchJson(url, form);
    const entries = Array.isArray(result.data) ? result.data : [];
    for (const entry of entries) {
      if (entry?.type !== "file" || !entry.path) {
        continue;
      }
      files.push({
        path: String(entry.path),
        size: Number(entry.size ?? entry.lfs?.size ?? 0) || 0,
        lfs: Boolean(entry.lfs),
        oid: entry.oid || ""
      });
    }
    url = result.next;
  }

  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    endpoint: normalizeEndpoint(form) || DEFAULT_ENDPOINT,
    revision: cleanText(form.revision) || "main",
    total: files.length,
    files
  };
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

async function resolveDownloadRuntime() {
  const python = await detectPython();
  const runnerPath = await resolveDownloadRunnerPath();
  if (python.pythonPath && python.hubVersion && runnerPath) {
    return {
      kind: "python",
      path: python.pythonPath,
      args: [runnerPath],
      python
    };
  }

  const cli = await resolveCli();
  if (cli) {
    return {
      kind: "cli",
      path: cli.path,
      args: null,
      cli
    };
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

    const imported = await runCapture(
      py,
      ["-c", "import huggingface_hub,sys;sys.stdout.write(getattr(huggingface_hub,'__version__',''))"],
      { timeoutMs: 8000 }
    );
    hubVersion = (imported.stdout || "").trim();

    if (!hubVersion) {
      const hub = await runCapture(py, ["-m", "pip", "show", "huggingface_hub"], { timeoutMs: 8000 });
      const versionLine = (hub.stdout || "")
        .split(/\r?\n/)
        .find((line) => line.toLowerCase().startsWith("version:"));
      hubVersion = versionLine ? versionLine.replace(/^version:\s*/i, "").trim() : "";
    }
  }

  return { pythonPath: py, pipPath: pip, pythonVersion, hubVersion };
}

function spawnManaged(commandPath, args, env, kind, context = {}) {
  const child = spawn(commandPath, args, {
    shell: false,
    windowsHide: true,
    env: createChildEnv(env, context),
    stdio: ["pipe", "pipe", "pipe"]
  });

  activeProcess = child;
  activeKind = kind;
  activeContext = context;
  let structuredStdoutBuffer = "";

  if (context.stdinText) {
    child.stdin?.end(context.stdinText);
  } else {
    child.stdin?.end();
  }

  const parseStructuredStdout = (text, flush = false) => {
    structuredStdoutBuffer += text;
    const parts = structuredStdoutBuffer.split(/\r?\n/);
    if (!flush) {
      structuredStdoutBuffer = parts.pop() ?? "";
    } else {
      structuredStdoutBuffer = "";
    }

    for (const line of parts) {
      if (!line) {
        continue;
      }
      if (line.startsWith(STRUCTURED_EVENT_PREFIX)) {
        try {
          const payload = JSON.parse(line.slice(STRUCTURED_EVENT_PREFIX.length));
          applyStructuredProgressEvent(activeContext.progressTracker, payload);
          continue;
        } catch {
          // Fall back to plain log output when the structured line is malformed.
        }
      }
      recordLog("stdout", `${line}\n`);
    }
  };

  const push = (stream, chunk) => {
    const text = chunk.toString("utf8");
    if (context.structuredProgress && stream === "stdout") {
      parseStructuredStdout(text);
      return;
    }
    if (!context.structuredProgress && updateProgressFromOutput(activeContext.progressTracker, text)) {
      emitProgress(activeContext.progressTracker);
    }
    recordLog(stream, text);
  };

  child.stdout?.on("data", (chunk) => push("stdout", chunk));
  child.stderr?.on("data", (chunk) => push("stderr", chunk));

  child.on("error", (error) => {
    recordLog("stderr", `${error.message}\n`);
  });

  child.on("close", (code) => {
    const context = activeContext;
    const historyId = context.historyId || activeHistoryId;
    const queueId = context.queueId || "";
    const state = activeTerminationStatus || (code === 0 ? "completed" : "failed");
    const shouldEmitStatus = !queueId;

    if (context.structuredProgress) {
      parseStructuredStdout("", true);
    }

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

    if (context.progressTracker) {
      context.progressTracker.state = state;
      context.progressTracker.phase =
        state === "completed" ? "下载已完成" : state === "canceled" ? "任务已停止" : "下载失败";
      if (state === "completed" && context.progressTracker.totalBytes > 0) {
        context.progressTracker.transferredBytes = context.progressTracker.totalBytes;
        context.progressTracker.percent = 100;
      }
      if (state === "completed" && context.progressTracker.totalFiles > 0) {
        context.progressTracker.completedFiles = context.progressTracker.totalFiles;
        context.progressTracker.percent = 100;
      }
      emitProgress(context.progressTracker);
    }

    handleProcessClosed(kind, historyId, queueId, state, code).catch((error) => {
      recordLog("stderr", `[任务] ${error.message}\n`);
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
ipcMain.on("settings:saveSync", (event, settings) => {
  try {
    event.returnValue = saveSettingsSync(settings);
  } catch {
    event.returnValue = false;
  }
});
ipcMain.handle("session:load", loadSession);
ipcMain.handle("session:save", (_event, session) => saveSession(session));
ipcMain.on("session:saveSync", (event, session) => {
  try {
    event.returnValue = Boolean(saveSessionSync(session));
  } catch {
    event.returnValue = false;
  }
});
ipcMain.handle("library:load", loadLibrary);
ipcMain.handle("queue:load", () => queueState);

ipcMain.handle("queue:add", async (_event, form) => {
  const cli = await resolveCli();
  const plan = buildDownloadPlan(form, cli?.name ?? "hf");
  const item = withDownloadDirectory(createQueueItem(randomId("queue"), form, plan), form);
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

ipcMain.handle("log:status", async () => getLogStatus());

ipcMain.handle("log:write", async (_event, payload) => {
  await recordLog(payload?.stream || "stdout", payload?.text || "");
  return getLogStatus();
});

ipcMain.handle("log:open", async () => {
  const status = await getLogStatus();
  await fs.appendFile(status.path, "", "utf8");
  shell.showItemInFolder(status.path);
  return status;
});

ipcMain.handle("log:clear", async () => {
  await logWriteChain;
  await ensureLogDirectory();
  await fs.rm(logFilePath(), { force: true });
  for (let index = 1; index <= MAX_LOG_FILES; index += 1) {
    await fs.rm(rotatedLogFilePath(index), { force: true });
  }
  return getLogStatus();
});

ipcMain.handle("download:openDirectory", async (_event, form) => {
  const targetPath = resolveDownloadDirectory(form);
  if (!targetPath) {
    throw new Error("请先选择保存目录。");
  }

  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`目录不存在：${targetPath}`);
  }

  const result = await shell.openPath(targetPath);
  if (result) {
    throw new Error(result);
  }
  return { path: targetPath };
});

ipcMain.handle("clipboard:writeText", (_event, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});

ipcMain.handle("app:version", () => app.getVersion());

ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
  return true;
});

ipcMain.handle("window:toggleMaximize", () => {
  if (!mainWindow) {
    return false;
  }
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return mainWindow.isMaximized();
});

ipcMain.handle("window:close", () => {
  mainWindow?.close();
  return true;
});

ipcMain.handle("download:preview", async (_event, form) => {
  const cli = await resolveCli();
  const plan = buildDownloadPlan(form, cli?.name ?? "hf");
  return { ...plan, cli };
});

ipcMain.handle("repo:listFiles", async (_event, form) => listRepoFiles(form));

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

  const runtime = await resolveDownloadRuntime();
  if (!runtime) {
    throw new Error("No usable Python / huggingface_hub runtime or HF CLI was found.");
  }

  const cli = runtime.cli ?? { name: "hf", path: "" };
  const plan = buildDownloadPlan(form, cli.name);
  const progressTracker = createProgressTracker("download", form, plan);
  const { item } = await appendHistory(form, plan);
  activeHistoryId = item.id;
  emit("process:status", { state: "running", kind: "download", plan: { ...plan, displayCommand: plan.maskedCommand } });
  emitProgress(progressTracker);

  if (runtime.kind === "python") {
    spawnManaged(runtime.path, runtime.args, { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1" }, "download", {
      historyId: item.id,
      progressTracker,
      structuredProgress: true,
      bypassProxyEndpoint: plan.endpoint,
      stdinText: JSON.stringify({ form })
    });
  } else {
    spawnManaged(cli.path, plan.args, plan.env, "download", {
      historyId: item.id,
      progressTracker,
      bypassProxyEndpoint: plan.endpoint
    });
  }

  return { ...plan, cli: runtime.cli ?? null, python: runtime.python ?? null, historyItem: item };
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
  let runtime;
  let cli;
  let plan;

  try {
    runtime = await resolveDownloadRuntime();
    if (!runtime) {
      throw new Error("No usable Python / huggingface_hub runtime or HF CLI was found.");
    }
    cli = runtime.cli ?? { name: "hf", path: "" };
    plan = buildDownloadPlan(item.form, cli.name);
  } catch (error) {
    queueState = updateQueueItem(queueState, item.id, {
      status: "failed",
      exitCode: -1,
      completedAt: new Date().toISOString()
    });
    await publishQueue(queueState);
    recordLog("stderr", `[队列] ${item.repoId}: ${error.message}\n`);
    await startNextQueueItem();
    return;
  }

  const { item: historyItem } = await appendHistory(item.form, plan);
  const progressTracker = createProgressTracker("download", item.form, plan);
  activeHistoryId = historyItem.id;
  activeQueueId = item.id;
  queueState = updateQueueItem(queueState, item.id, {
    status: "running",
    startedAt,
    historyId: historyItem.id,
    endpoint: plan.endpoint,
    command: plan.maskedCommand,
    downloadDir: resolveDownloadDirectory(item.form)
  });
  await publishQueue(queueState);
  recordLog("stdout", `[队列] 开始 ${item.repoId}\n[命令] ${plan.maskedCommand}\n`);
  emitProgress(progressTracker);

  if (runtime.kind === "python") {
    spawnManaged(runtime.path, runtime.args, { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1" }, "download", {
      historyId: historyItem.id,
      queueId: item.id,
      progressTracker,
      structuredProgress: true,
      bypassProxyEndpoint: plan.endpoint,
      stdinText: JSON.stringify({ form: item.form })
    });
  } else {
    spawnManaged(cli.path, plan.args, plan.env, "download", {
      historyId: historyItem.id,
      queueId: item.id,
      progressTracker,
      bypassProxyEndpoint: plan.endpoint
    });
  }
}
