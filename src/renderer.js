const fields = [
  "repoType",
  "repoId",
  "files",
  "localDir",
  "cacheDir",
  "source",
  "endpoint",
  "revision",
  "include",
  "exclude",
  "token",
  "maxWorkers",
  "downloadTimeout",
  "etagTimeout",
  "dryRun",
  "forceDownload",
  "quiet",
  "highPerformance",
  "disableSymlinks"
];

const state = {
  settings: {},
  library: { history: [], favorites: [] },
  queue: { running: false, paused: false, items: [] },
  running: false,
  command: "",
  repoFiles: [],
  selectedFiles: new Set(),
  progress: {
    state: "idle",
    repoId: "",
    endpoint: "",
    totalFiles: 0,
    completedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    speedBytesPerSecond: 0,
    percent: 0,
    currentFile: "",
    phase: "等待开始"
  },
  speed: {
    key: "",
    lastBytes: 0,
    lastTime: 0,
    bytesPerSecond: 0
  },
  previewTimer: 0,
  saveTimer: 0
};

const $ = (selector) => document.querySelector(selector);
const LEFT_PANE_WIDTH_KEY = "hfDownloader.leftPaneWidth";
const SPEED_SAMPLE_WINDOW_MS = 30000;
const SPEED_MIN_WINDOW_MS = 3000;
const SPEED_EWMA_HALF_LIFE_SECONDS = 12;
const SPEED_STALE_GRACE_MS = 8000;
const SPEED_STALE_DECAY_MS = 25000;
const ETA_MAX_SECONDS = 365 * 24 * 60 * 60;

const els = {
  appMain: $(".app-main"),
  paneResizer: $("#paneResizer"),
  appVersion: $("#appVersion"),
  cliStatus: $("#cliStatus"),
  installCliButton: $("#installCliButton"),
  saveFavoriteButton: $("#saveFavoriteButton"),
  addQueueButton: $("#addQueueButton"),
  openDownloadDirButton: $("#openDownloadDirButton"),
  startQueueButton: $("#startQueueButton"),
  stopQueueButton: $("#stopQueueButton"),
  clearQueueButton: $("#clearQueueButton"),
  startButton: $("#startButton"),
  stopButton: $("#stopButton"),
  openLogButton: $("#openLogButton"),
  clearLogButton: $("#clearLogButton"),
  pickLocalDir: $("#pickLocalDir"),
  commandPreview: $("#commandPreview"),
  endpointBadge: $("#endpointBadge"),
  warningBox: $("#warningBox"),
  loadFilesButton: $("#loadFilesButton"),
  fileSearch: $("#fileSearch"),
  filePreviewStatus: $("#filePreviewStatus"),
  filePreviewSummary: $("#filePreviewSummary"),
  fileSelectedSummary: $("#fileSelectedSummary"),
  fileList: $("#fileList"),
  selectFilteredButton: $("#selectFilteredButton"),
  clearFileSelectionButton: $("#clearFileSelectionButton"),
  progressTitle: $("#progressTitle"),
  progressSubtitle: $("#progressSubtitle"),
  progressCount: $("#progressCount"),
  progressSpeed: $("#progressSpeed"),
  progressEta: $("#progressEta"),
  progressPercent: $("#progressPercent"),
  progressFill: $("#progressFill"),
  logStatus: $("#logStatus"),
  runState: $("#runState"),
  endpointGroup: $("#endpointGroup"),
  favoritesList: $("#favoritesList"),
  queueList: $("#queueList"),
  toggleTokenButton: $("#toggleTokenButton"),
  minimizeButton: $("#minimizeButton"),
  maximizeButton: $("#maximizeButton"),
  closeButton: $("#closeButton")
};

function fieldElement(name) {
  return document.getElementById(name);
}

function readForm() {
  const form = {};
  for (const name of fields) {
    const el = fieldElement(name);
    if (!el) {
      continue;
    }
    if (el.type === "checkbox") {
      form[name] = el.checked;
    } else if (el.type === "number") {
      form[name] = Number(el.value);
    } else {
      form[name] = el.value;
    }
  }
  return form;
}

function buildSessionSnapshot() {
  return {
    version: 1,
    form: readForm(),
    repoFiles: state.repoFiles,
    fileSearch: els.fileSearch?.value || "",
    filePreviewStatus: els.filePreviewStatus?.textContent || ""
  };
}

function saveCurrentState() {
  const form = readForm();
  const session = buildSessionSnapshot();
  return Promise.all([
    window.hfBridge.saveSettings(form),
    window.hfBridge.saveSession?.(session)
  ]);
}

function saveCurrentStateSync() {
  const form = readForm();
  const session = buildSessionSnapshot();
  window.hfBridge.saveSettingsSync?.(form);
  window.hfBridge.saveSessionSync?.(session);
}

function buildRuntimeForm() {
  const downloadFiles = estimateDownloadFiles();

  return {
    ...readForm(),
    previewTotalFiles: state.repoFiles.length,
    filteredFileCount: filteredRepoFiles({ ignoreSearch: true }).length,
    selectedFileCount: state.selectedFiles.size,
    estimatedTotalBytes: sumFileSizes(downloadFiles)
  };
}

function writeForm(settings) {
  state.settings = { ...settings };

  for (const name of fields) {
    const el = fieldElement(name);
    if (!el || settings[name] === undefined) {
      continue;
    }
    if (el.type === "checkbox") {
      el.checked = Boolean(settings[name]);
    } else {
      el.value = settings[name];
    }
  }

  refreshSegments();
  updateEndpointVisibility();
}

function applyStoredForm(form) {
  writeForm({ ...readForm(), ...form, token: "" });
  scheduleSaveAndPreview();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function setLeftPaneWidth(width) {
  if (!els.appMain) {
    return;
  }
  const bounds = els.appMain.getBoundingClientRect();
  const max = Math.max(380, bounds.width - 520);
  const clamped = clamp(Number(width) || 488, 380, max);
  els.appMain.style.setProperty("--left-pane-width", `${Math.round(clamped)}px`);
  localStorage.setItem(LEFT_PANE_WIDTH_KEY, String(Math.round(clamped)));
}

function restoreLeftPaneWidth() {
  const stored = Number(localStorage.getItem(LEFT_PANE_WIDTH_KEY));
  if (Number.isFinite(stored) && stored > 0) {
    setLeftPaneWidth(stored);
  }
}

function initPaneResize() {
  if (!els.appMain || !els.paneResizer) {
    return;
  }

  restoreLeftPaneWidth();

  els.paneResizer.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 980px)").matches) {
      return;
    }

    event.preventDefault();
    els.paneResizer.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-pane");

    const bounds = els.appMain.getBoundingClientRect();
    const move = (moveEvent) => {
      setLeftPaneWidth(moveEvent.clientX - bounds.left);
    };
    const stop = () => {
      document.body.classList.remove("resizing-pane");
      els.paneResizer.removeEventListener("pointermove", move);
      els.paneResizer.removeEventListener("pointerup", stop);
      els.paneResizer.removeEventListener("pointercancel", stop);
    };

    els.paneResizer.addEventListener("pointermove", move);
    els.paneResizer.addEventListener("pointerup", stop);
    els.paneResizer.addEventListener("pointercancel", stop);
  });

  window.addEventListener("resize", () => {
    const current = Number.parseInt(getComputedStyle(els.appMain).getPropertyValue("--left-pane-width"), 10);
    if (Number.isFinite(current)) {
      setLeftPaneWidth(current);
    }
  });
}

function refreshSegments() {
  document.querySelectorAll(".segmented").forEach((group) => {
    const field = group.dataset.field;
    const value = fieldElement(field)?.value;
    group.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", button.dataset.value === value);
    });
  });
}

function updateEndpointVisibility() {
  const source = fieldElement("source").value;
  const endpoint = fieldElement("endpoint");

  els.endpointGroup.hidden = false;
  endpoint.disabled = source !== "custom";

  if (source === "mirror") {
    endpoint.value = "https://hf-mirror.com";
  }
  if (source === "official") {
    endpoint.value = "https://huggingface.co";
  }
}

function updateProgressView(progress = state.progress) {
  const total = Number(progress.totalBytes) || 0;
  const completed = Number(progress.transferredBytes) || 0;
  const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : 0;
  const hasKnownTotal = total > 0;
  const stateName = ["completed", "failed", "canceled", "running", "stopping"].includes(progress.state)
    ? progress.state
    : "idle";

  els.runState.textContent =
    progress.state === "completed"
      ? "已完成"
      : progress.state === "failed"
        ? "失败"
        : progress.state === "canceled"
          ? "已停止"
          : progress.state === "running"
            ? "下载中"
            : progress.state === "stopping"
              ? "停止中"
              : "已停止";

  els.progressTitle.textContent = progress.repoId || "等待开始";
  els.progressSubtitle.textContent = progress.phase || "先预览并选择文件，再开始下载。";
  els.progressCount.textContent = hasKnownTotal ? `${Math.min(completed, total)} / ${total} 文件` : "文件数待确定";
  els.progressPercent.textContent = `${percent}%`;
  els.progressFill.style.width = `${percent}%`;
  els.runState.dataset.state = stateName;
  els.progressCurrentFile.textContent = progress.currentFile || (isRunning ? "批量下载处理中" : "-");
  els.progressEndpoint.textContent = progress.endpoint || "-";
}

function resetProgress() {
  state.progress = {
    state: "idle",
    repoId: "",
    endpoint: "",
    totalFiles: 0,
    completedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    speedBytesPerSecond: 0,
    percent: 0,
    currentFile: "",
    phase: "先预览并选择文件，再开始下载。"
  };
  resetSpeed(0, state.progress);
  updateProgressView();
}

function scheduleSaveAndPreview() {
  clearTimeout(state.saveTimer);
  clearTimeout(state.previewTimer);

  state.saveTimer = setTimeout(() => saveCurrentState().catch(() => {}), 250);

  state.previewTimer = setTimeout(updatePreview, 120);
}

function scheduleSaveOnly() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveCurrentState().catch(() => {}), 250);
}

async function updatePreview() {
  try {
    const plan = await window.hfBridge.previewDownload(buildRuntimeForm());
    state.command = plan.maskedCommand;
    els.commandPreview.textContent = plan.maskedCommand;
    els.endpointBadge.textContent = plan.endpoint;
    if (plan.warnings?.length) {
      els.warningBox.textContent = plan.warnings.join("\n");
      els.warningBox.hidden = false;
    } else {
      els.warningBox.hidden = true;
    }
  } catch (error) {
    els.commandPreview.textContent = error.message;
    els.endpointBadge.textContent = "未生成";
    els.warningBox.hidden = true;
  }
}

function splitPatternList(value) {
  return String(value ?? "")
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitSelectedFiles(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
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
      return escapeRegExp(char);
    })
    .join("");
  return new RegExp(`^${source}$`, "i");
}

function fileMatchesPattern(path, pattern) {
  const normalized = String(path).replace(/\\/g, "/");
  const baseName = normalized.split("/").pop() || normalized;
  const target = pattern.includes("/") ? normalized : baseName;
  return globToRegExp(pattern.replace(/\\/g, "/")).test(target);
}

function filteredRepoFiles(options = {}) {
  const query = options.ignoreSearch ? "" : String(els.fileSearch?.value ?? "").trim().toLowerCase();
  const include = splitPatternList(fieldElement("include").value);
  const exclude = splitPatternList(fieldElement("exclude").value);

  return state.repoFiles.filter((file) => {
    const path = file.path || "";
    const lowerPath = path.toLowerCase();

    if (query && !lowerPath.includes(query)) {
      return false;
    }
    if (include.length && !include.some((pattern) => fileMatchesPattern(path, pattern))) {
      return false;
    }
    if (exclude.some((pattern) => fileMatchesPattern(path, pattern))) {
      return false;
    }
    return true;
  });
}

function estimateDownloadFiles() {
  const explicitFiles = splitSelectedFiles(fieldElement("files").value);
  if (!explicitFiles.length) {
    return filteredRepoFiles({ ignoreSearch: true });
  }

  const include = splitPatternList(fieldElement("include").value);
  const exclude = splitPatternList(fieldElement("exclude").value);
  const byPath = new Map(state.repoFiles.map((file) => [file.path, file]));
  const files = [];

  for (const path of explicitFiles) {
    if (include.length && !include.some((pattern) => fileMatchesPattern(path, pattern))) {
      continue;
    }
    if (exclude.some((pattern) => fileMatchesPattern(path, pattern))) {
      continue;
    }

    const file = byPath.get(path);
    if (!file) {
      return [];
    }
    files.push(file);
  }

  return files;
}

function sumFileSizes(files) {
  return files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
}

function formatBytes(size) {
  const value = Number(size) || 0;
  if (value <= 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let current = value;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  const digits = current >= 10 || index === 0 ? 0 : 1;
  return `${current.toFixed(digits)} ${units[index]}`;
}

function formatSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  return value > 0 ? `${formatBytes(value)}/s` : "-";
}

function formatDuration(seconds) {
  const raw = Math.max(0, Math.ceil(Number(seconds) || 0));
  const value =
    raw < 60
      ? Math.ceil(raw / 5) * 5
      : raw < 10 * 60
        ? Math.ceil(raw / 10) * 10
        : raw < 60 * 60
          ? Math.ceil(raw / 60) * 60
          : raw < 6 * 60 * 60
            ? Math.ceil(raw / (5 * 60)) * 5 * 60
            : raw < 24 * 60 * 60
              ? Math.ceil(raw / (10 * 60)) * 10 * 60
              : Math.ceil(raw / (60 * 60)) * 60 * 60;

  if (value < 60) {
    return `${value} 秒`;
  }

  const minutes = Math.floor(value / 60);
  const secondsPart = value % 60;
  if (minutes < 10 && secondsPart > 0) {
    return `${minutes} 分 ${secondsPart} 秒`;
  }
  if (value < 60 * 60) {
    return `${minutes} 分钟`;
  }

  const hours = Math.floor(value / (60 * 60));
  const remainingMinutes = Math.floor((value % (60 * 60)) / 60);
  if (hours < 24) {
    return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days} 天 ${remainingHours} 小时` : `${days} 天`;
}

function displaySpeed(progress) {
  const speed = Math.max(0, Number(progress.speedBytesPerSecond) || 0);
  if (progress.state !== "running" || speed <= 0 || !state.speed.lastProgressTime) {
    return speed;
  }

  const staleMs = performance.now() - state.speed.lastProgressTime;
  if (staleMs <= SPEED_STALE_GRACE_MS) {
    return speed;
  }

  return speed * Math.exp(-(staleMs - SPEED_STALE_GRACE_MS) / SPEED_STALE_DECAY_MS);
}

function stabilizeEtaSeconds(rawSeconds) {
  const now = performance.now();
  const previous = Number(state.speed.displayedEtaSeconds) || 0;
  const lastUpdate = Number(state.speed.lastEtaUpdateTime) || 0;

  if (!previous || !lastUpdate || !Number.isFinite(previous)) {
    state.speed.displayedEtaSeconds = rawSeconds;
    state.speed.lastEtaUpdateTime = now;
    return rawSeconds;
  }

  const elapsed = Math.max(0, (now - lastUpdate) / 1000);
  const expected = Math.max(0, previous - elapsed);
  const delta = rawSeconds - expected;
  const quietBand = Math.max(15, expected * 0.05);

  let next = expected;
  if (Math.abs(delta) > quietBand) {
    const maxStep = Math.max(20, expected * 0.08);
    next = expected + Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
  }

  state.speed.displayedEtaSeconds = next;
  state.speed.lastEtaUpdateTime = now;
  return next;
}

function formatEta(progress, speedBytesPerSecond) {
  if (progress.state === "completed") {
    return { text: "已完成", title: "剩余 0 秒" };
  }
  if (progress.state !== "running") {
    return { text: "还需时间 -", title: "任务未运行" };
  }

  const totalBytes = Math.max(0, Number(progress.totalBytes) || 0);
  const transferredBytes = Math.max(0, Number(progress.transferredBytes) || 0);
  const speed = Math.max(0, Number(speedBytesPerSecond) || 0);
  const remainingBytes = totalBytes - transferredBytes;

  if (totalBytes <= 0 || remainingBytes <= 0) {
    return { text: "还需时间 计算中", title: "等待总大小确认" };
  }
  if (speed <= 0) {
    return { text: "还需时间 计算中", title: "等待速度稳定" };
  }

  const remainingSeconds = remainingBytes / speed;
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0 || remainingSeconds > ETA_MAX_SECONDS) {
    return { text: "还需时间 计算中", title: "等待速度稳定" };
  }

  const stableSeconds = stabilizeEtaSeconds(remainingSeconds);
  return {
    text: `还需约 ${formatDuration(stableSeconds)}`,
    title: `原始估算约 ${formatDuration(remainingSeconds)}，显示值已做平滑`
  };
}

function resetSpeed(bytes = 0, progress = state.progress) {
  const key = [progress.repoId || "", progress.endpoint || ""].join("|");
  const startBytes = Math.max(0, Number(bytes) || 0);
  state.speed = {
    key,
    startBytes,
    startTime: 0,
    lastBytes: startBytes,
    lastTime: 0,
    lastProgressTime: 0,
    bytesPerSecond: 0,
    displayedEtaSeconds: 0,
    lastEtaUpdateTime: 0,
    samples: []
  };
}

function sampleWindowSpeed(samples) {
  if (samples.length < 2) {
    return 0;
  }

  const newest = samples[samples.length - 1];
  const oldest = samples[0];
  const elapsedMs = newest.time - oldest.time;
  const deltaBytes = newest.bytes - oldest.bytes;

  if (elapsedMs < SPEED_MIN_WINDOW_MS || deltaBytes <= 0) {
    return 0;
  }

  return deltaBytes / (elapsedMs / 1000);
}

function updateDownloadSpeed(progress) {
  const bytes = Math.max(0, Number(progress.transferredBytes) || 0);
  const key = [progress.repoId || "", progress.endpoint || ""].join("|");
  const now = performance.now();

  if (progress.state !== "running") {
    resetSpeed(bytes, progress);
    progress.speedBytesPerSecond = 0;
    return progress;
  }

  if (state.speed.key !== key || bytes < state.speed.lastBytes) {
    resetSpeed(bytes, progress);
    progress.speedBytesPerSecond = 0;
    return progress;
  }

  if (!state.speed.startTime) {
    state.speed.startBytes = bytes;
    state.speed.startTime = now;
    state.speed.lastBytes = bytes;
    state.speed.lastTime = now;
    state.speed.samples = [{ time: now, bytes }];
    progress.speedBytesPerSecond = state.speed.bytesPerSecond;
    return progress;
  }

  if (bytes !== state.speed.lastBytes || now - state.speed.lastTime >= 1000) {
    state.speed.samples.push({ time: now, bytes });
    while (state.speed.samples.length > 2 && state.speed.samples[1].time < now - SPEED_SAMPLE_WINDOW_MS) {
      state.speed.samples.shift();
    }
  }

  const delta = bytes - state.speed.lastBytes;
  const elapsed = (now - state.speed.lastTime) / 1000;
  const sessionElapsed = (now - state.speed.startTime) / 1000;
  const averageSpeed =
    sessionElapsed >= 1 && bytes > state.speed.startBytes ? (bytes - state.speed.startBytes) / sessionElapsed : 0;
  const recentSpeed = sampleWindowSpeed(state.speed.samples);
  const targetSpeed =
    recentSpeed > 0 && sessionElapsed >= 15 ? recentSpeed * 0.7 + averageSpeed * 0.3 : averageSpeed || recentSpeed;

  if (elapsed >= 0.5 && targetSpeed > 0) {
    const alpha = Math.min(0.35, 1 - Math.exp(-elapsed / SPEED_EWMA_HALF_LIFE_SECONDS));
    state.speed.bytesPerSecond =
      state.speed.bytesPerSecond > 0 ? state.speed.bytesPerSecond * (1 - alpha) + targetSpeed * alpha : targetSpeed;
  }

  if (elapsed >= 0.5) {
    state.speed.lastBytes = bytes;
    state.speed.lastTime = now;
  }
  if (delta > 0) {
    state.speed.lastProgressTime = now;
  }

  progress.speedBytesPerSecond = state.speed.bytesPerSecond;
  return progress;
}

updateProgressView = function updateProgressViewBytes(progress = state.progress) {
  const totalBytes = Number(progress.totalBytes) || 0;
  const transferredBytes = Number(progress.transferredBytes) || 0;
  const speedBytesPerSecond = displaySpeed(progress);
  const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : 0;
  const stateName = ["completed", "failed", "canceled", "running", "stopping"].includes(progress.state)
    ? progress.state
    : "idle";
  const labels = {
    completed: "已完成",
    failed: "失败",
    canceled: "已停止",
    running: "下载中",
    stopping: "停止中",
    idle: "已停止"
  };

  els.runState.textContent = labels[stateName] || labels.idle;
  els.runState.dataset.state = stateName;
  els.progressTitle.textContent = progress.repoId || "等待开始";
  els.progressSubtitle.textContent = progress.phase || "先预览并选择文件，再开始下载。";
  els.progressCount.textContent =
    totalBytes > 0 ? `${formatBytes(Math.min(transferredBytes, totalBytes))} / ${formatBytes(totalBytes)}` : "总大小待确认";
  els.progressSpeed.textContent = progress.state === "running" ? formatSpeed(speedBytesPerSecond) : "-";
  const eta = formatEta(progress, speedBytesPerSecond);
  els.progressEta.textContent = eta.text;
  els.progressEta.title = eta.title;
  els.progressPercent.textContent = `${percent}%`;
  els.progressFill.style.width = `${percent}%`;
};

function initProgressRefreshTimer() {
  window.setInterval(() => {
    if (state.progress.state === "running") {
      updateProgressView();
    }
  }, 1000);
}

function syncSelectedFilesFromTextarea() {
  state.selectedFiles = new Set(splitSelectedFiles(fieldElement("files").value));
}

function updateFilePreviewSummary(visibleFiles = filteredRepoFiles()) {
  const total = state.repoFiles.length;
  const visible = visibleFiles.length;
  const selected = state.selectedFiles.size;
  const totalSize = visibleFiles.reduce((sum, file) => sum + (Number(file.size) || 0), 0);

  els.filePreviewSummary.textContent = total
    ? `共 ${total} 个文件 · 当前显示 ${visible} 个 · ${formatBytes(totalSize)}`
    : "未预览";
  els.fileSelectedSummary.textContent = `已选 ${selected} 个`;
  els.selectFilteredButton.disabled = visible === 0;
  els.clearFileSelectionButton.disabled = selected === 0;
}

function createFileRow(file) {
  const row = document.createElement("label");
  row.className = "file-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.selectedFiles.has(file.path);
  checkbox.dataset.path = file.path;

  const body = document.createElement("span");
  body.className = "file-row-body";

  const path = document.createElement("span");
  path.className = "file-path";
  path.textContent = file.path;

  const meta = document.createElement("span");
  meta.className = "file-meta";
  meta.textContent = [formatBytes(file.size), file.lfs ? "LFS" : ""].filter(Boolean).join(" · ");

  body.append(path, meta);
  row.append(checkbox, body);
  return row;
}

function renderFileList() {
  const visibleFiles = filteredRepoFiles();
  els.fileList.replaceChildren();

  if (!state.repoFiles.length) {
    const empty = document.createElement("div");
    empty.className = "file-empty";
    empty.textContent = "点击“预览文件”拉取仓库文件列表";
    els.fileList.appendChild(empty);
    updateFilePreviewSummary(visibleFiles);
    return;
  }

  if (!visibleFiles.length) {
    const empty = document.createElement("div");
    empty.className = "file-empty";
    empty.textContent = "没有文件匹配当前搜索或包含/排除规则";
    els.fileList.appendChild(empty);
    updateFilePreviewSummary(visibleFiles);
    return;
  }

  const maxRendered = 1000;
  for (const file of visibleFiles.slice(0, maxRendered)) {
    els.fileList.appendChild(createFileRow(file));
  }
  if (visibleFiles.length > maxRendered) {
    const clipped = document.createElement("div");
    clipped.className = "file-empty subtle";
    clipped.textContent = `仅显示前 ${maxRendered} 个，筛选结果总数 ${visibleFiles.length} 个`;
    els.fileList.appendChild(clipped);
  }

  updateFilePreviewSummary(visibleFiles);
}

async function loadRepoFiles() {
  syncSelectedFilesFromTextarea();
  els.filePreviewStatus.textContent = "正在拉取文件列表...";
  els.loadFilesButton.disabled = true;

  try {
    const result = await window.hfBridge.listRepoFiles(buildRuntimeForm());
    state.repoFiles = result.files || [];
    els.filePreviewStatus.textContent = `${result.endpoint} · ${result.revision}`;
    if (result.directUrls) {
      state.selectedFiles = new Set(state.repoFiles.map((file) => file.path));
      syncTextareaFromSelectedFiles();
      els.filePreviewStatus.textContent = `${result.endpoint} · 已解析 ${result.total} 个文件链接`;
    }
    appendLog(`[预览] 已加载 ${result.total} 个文件。\n`);
    renderFileList();
  } catch (error) {
    state.repoFiles = [];
    els.filePreviewStatus.textContent = error.message;
    appendLog(`[预览] ${error.message}\n`, "stderr");
    renderFileList();
  } finally {
    els.loadFilesButton.disabled = false;
    scheduleSaveOnly();
  }
}

function selectFiles(files) {
  for (const file of files) {
    state.selectedFiles.add(file.path);
  }
  syncTextareaFromSelectedFiles();
  renderFileList();
}

function selectedFilePathsInOrder() {
  const ordered = [];
  const seen = new Set();

  for (const file of state.repoFiles) {
    if (state.selectedFiles.has(file.path)) {
      ordered.push(file.path);
      seen.add(file.path);
    }
  }

  for (const filePath of state.selectedFiles) {
    if (!seen.has(filePath)) {
      ordered.push(filePath);
    }
  }

  return ordered;
}

function syncTextareaFromSelectedFiles() {
  fieldElement("files").value = selectedFilePathsInOrder().join("\n");
  scheduleSaveAndPreview();
}

function formatLogSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function updateLogStatus(status, message = "") {
  if (!els.logStatus || !status) {
    return;
  }
  const sizeText = formatLogSize(status.size);
  els.logStatus.textContent = message || `${status.path} · ${sizeText}`;
}

function appendLog(text, stream = "stdout") {
  const normalized = String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n");
  const writeLog = window.hfBridge.writeLog
    ? window.hfBridge.writeLog(normalized, stream)
    : Promise.resolve(null);
  writeLog
    .then((status) => updateLogStatus(status))
    .catch((error) => {
      if (els.logStatus) {
        els.logStatus.textContent = `日志写入失败：${error.message}`;
      }
    });
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function statusText(status) {
  if (status === "queued") {
    return "等待";
  }
  if (status === "completed") {
    return "完成";
  }
  if (status === "failed") {
    return "失败";
  }
  if (status === "canceled") {
    return "已取消";
  }
  return "运行中";
}

function createIconButton(action, id, title) {
  const button = document.createElement("button");
  button.className = "icon-button compact repo-delete";
  button.type = "button";
  button.dataset.action = action;
  button.dataset.id = id;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 14h10l1-14" />
      <path d="M9 7V4h6v3" />
    </svg>
  `;
  return button;
}

function createRepoItem(item, options) {
  const row = document.createElement("div");
  row.className = "repo-item";

  const main = document.createElement("button");
  main.className = "repo-main";
  main.type = "button";
  main.dataset.action = options.applyAction;
  main.dataset.id = item.id;

  const titleLine = document.createElement("span");
  titleLine.className = "repo-title-line";

  const title = document.createElement("span");
  title.className = "repo-title";
  title.textContent = item.title || item.repoId || "未命名仓库";
  titleLine.appendChild(title);

  if (options.showStatus) {
    const status = document.createElement("span");
    status.className = `repo-status ${item.status || "running"}`;
    status.textContent = statusText(item.status);
    titleLine.appendChild(status);
  }

  const meta = document.createElement("span");
  meta.className = "repo-meta";
  const stamp = formatDate(item.completedAt || item.updatedAt || item.createdAt);
  meta.textContent = [item.summary, stamp].filter(Boolean).join(" · ");

  const path = document.createElement("span");
  path.className = "repo-path";
  path.textContent = item.downloadDir || item.localDir || item.form?.localDir || "";

  main.append(titleLine, meta, path);
  row.append(main, createIconButton(options.removeAction, item.id, options.removeTitle));
  return row;
}

function createEmptyState(options) {
  const empty = document.createElement("div");
  empty.className = options.largeEmpty ? "empty-state large-empty" : "empty-state";
  empty.innerHTML = `
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M12 21h24v14a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4Z" />
      <path d="M16 21l3-8h10l3 8" />
      <path d="M19 27h10" />
    </svg>
  `;

  const title = document.createElement("strong");
  title.textContent = options.emptyTitle || options.emptyText;
  empty.appendChild(title);

  if (options.emptyDescription) {
    const description = document.createElement("span");
    description.textContent = options.emptyDescription;
    empty.appendChild(description);
  }

  return empty;
}

function renderList(container, items, options) {
  container.replaceChildren();
  if (!items.length) {
    container.appendChild(createEmptyState(options));
    return;
  }

  for (const item of items) {
    container.appendChild(createRepoItem(item, options));
  }
}

function renderLibrary() {
  if (els.favoritesList) {
    renderList(els.favoritesList, state.library.favorites, {
      applyAction: "apply-favorite",
      removeAction: "remove-favorite",
      removeTitle: "删除收藏",
      emptyTitle: "暂无收藏",
      emptyDescription: "保存后的常用配置会显示在这里",
      emptyText: "暂无收藏"
    });
  }
}

function renderQueue() {
  renderList(els.queueList, state.queue.items, {
    applyAction: "apply-queue",
    removeAction: "remove-queue",
    removeTitle: "移出队列",
    emptyTitle: "队列为空",
    emptyDescription: "点击“加入队列”或直接“开始下载”开始你的第一个任务",
    emptyText: "暂无队列任务",
    largeEmpty: true,
    showStatus: true
  });
  syncQueueControls();
}

function syncQueueControls() {
  const hasQueued = state.queue.items.some((item) => item.status === "queued");
  els.startQueueButton.disabled = state.running || !hasQueued;
  els.stopQueueButton.disabled = !state.queue.running;
  els.clearQueueButton.disabled = state.queue.items.length === 0;
}

async function loadLibrary() {
  state.library = await window.hfBridge.loadLibrary();
  renderLibrary();
}

async function loadQueue() {
  state.queue = await window.hfBridge.loadQueue();
  renderQueue();
}

function findStoredItem(collection, id) {
  return state.library[collection].find((item) => item.id === id);
}

function findQueueItem(id) {
  return state.queue.items.find((item) => item.id === id);
}

async function saveFavorite() {
  try {
    const result = await window.hfBridge.addFavorite(buildRuntimeForm());
    state.library = result.library;
    renderLibrary();
    appendLog(`[收藏] 已保存 ${result.item.repoId}。\n`);
  } catch (error) {
    appendLog(`[收藏] ${error.message}\n`, "stderr");
  }
}

async function removeFavorite(id) {
  state.library = await window.hfBridge.removeFavorite(id);
  renderLibrary();
}

async function addQueueItem() {
  try {
    state.queue = await window.hfBridge.addQueueItem(buildRuntimeForm());
    renderQueue();
    appendLog(`[队列] 已加入 ${fieldElement("repoId").value}。\n`);
  } catch (error) {
    appendLog(`[队列] ${error.message}\n`, "stderr");
  }
}

async function openDownloadDirectory() {
  try {
    const result = await window.hfBridge.openDownloadDirectory(buildRuntimeForm());
    appendLog(`[目录] 已打开 ${result.path}\n`);
  } catch (error) {
    appendLog(`[目录] ${error.message}\n`, "stderr");
  }
}

async function startQueue() {
  try {
    appendLog("[队列] 启动队列。\n");
    state.queue = await window.hfBridge.startQueue();
    renderQueue();
    setRunning(true, "队列中");
  } catch (error) {
    appendLog(`[队列] ${error.message}\n`, "stderr");
    setRunning(false, "失败", true);
  }
}

async function stopQueue() {
  try {
    state.queue = await window.hfBridge.stopQueue();
    renderQueue();
    setRunning(Boolean(state.queue.running), state.queue.running ? "停止中" : "已停止");
  } catch (error) {
    appendLog(`[队列] ${error.message}\n`, "stderr");
  }
}

async function removeQueueItem(id) {
  state.queue = await window.hfBridge.removeQueueItem(id);
  renderQueue();
}

async function clearQueue() {
  state.queue = await window.hfBridge.clearQueue();
  renderQueue();
  appendLog("[队列] 已清空已完成任务。\n");
}

async function refreshLogStatus() {
  try {
    updateLogStatus(await window.hfBridge.getLogStatus());
  } catch (error) {
    if (els.logStatus) {
      els.logStatus.textContent = `日志状态读取失败：${error.message}`;
    }
  }
}

async function openLog() {
  try {
    updateLogStatus(await window.hfBridge.openLog(), "已打开日志文件位置");
  } catch (error) {
    if (els.logStatus) {
      els.logStatus.textContent = `打开日志失败：${error.message}`;
    }
  }
}

async function clearLog() {
  try {
    updateLogStatus(await window.hfBridge.clearLog(), "日志已清空");
  } catch (error) {
    if (els.logStatus) {
      els.logStatus.textContent = `清空日志失败：${error.message}`;
    }
  }
}

function setRunning(running, label = running ? "运行中" : "已停止", failed = false) {
  state.running = running;
  document.body.classList.toggle("busy", running);
  document.body.classList.toggle("failed", failed);
  els.startButton.disabled = running;
  els.stopButton.disabled = !running;
  els.installCliButton.disabled = running;
  syncQueueControls();
}

async function checkCli() {
  els.cliStatus.textContent = "正在检测 CLI...";
  try {
    const status = await window.hfBridge.checkCli();
    const cliPart = status.cli
      ? `${status.cli.name} · ${status.version || status.cli.path}`
      : "未找到 hf CLI";
    const hubPart = status.python?.hubVersion ? `hub ${status.python.hubVersion}` : "hub 未安装";
    els.cliStatus.textContent = `${cliPart} · ${hubPart}`;
    appendLog(`[环境] ${cliPart}\n[环境] Python: ${status.python?.pythonVersion || "未找到"} · ${hubPart}\n`);
  } catch (error) {
    els.cliStatus.textContent = error.message;
    appendLog(`[环境] ${error.message}\n`, "stderr");
  }
}

async function startDownload() {
  try {
    const plan = await window.hfBridge.startDownload(buildRuntimeForm());
    appendLog(`[命令] ${plan.maskedCommand}\n[源] ${plan.endpoint}\n\n`);
    if (plan.historyItem) {
      await loadLibrary();
    }
    setRunning(true, "下载中");
  } catch (error) {
    appendLog(`${error.message}\n`, "stderr");
    setRunning(false, "失败", true);
  }
}

async function installCli() {
  try {
    await window.hfBridge.installCli();
    setRunning(true, "安装中");
    appendLog("[安装] python -m pip install -U huggingface_hub\n\n");
  } catch (error) {
    appendLog(`${error.message}\n`, "stderr");
    setRunning(false, "失败", true);
  }
}

function bindEvents() {
  document.querySelectorAll("input[name], textarea[name], select[name]").forEach((el) => {
    el.addEventListener("input", () => {
      updateEndpointVisibility();
      scheduleSaveAndPreview();
      if (el.name === "include" || el.name === "exclude") {
        renderFileList();
      }
      if (el.name === "files") {
        syncSelectedFilesFromTextarea();
        renderFileList();
      }
    });
    el.addEventListener("change", () => {
      updateEndpointVisibility();
      scheduleSaveAndPreview();
      if (el.name === "include" || el.name === "exclude") {
        renderFileList();
      }
      if (el.name === "files") {
        syncSelectedFilesFromTextarea();
        renderFileList();
      }
    });
  });

  document.querySelectorAll(".segmented button").forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.closest(".segmented").dataset.field;
      fieldElement(field).value = button.dataset.value;
      refreshSegments();
      updateEndpointVisibility();
      scheduleSaveAndPreview();
    });
  });

  els.pickLocalDir.addEventListener("click", async () => {
    const folder = await window.hfBridge.selectFolder();
    if (folder) {
      fieldElement("localDir").value = folder;
      scheduleSaveAndPreview();
    }
  });

  els.installCliButton.addEventListener("click", installCli);
  els.saveFavoriteButton.addEventListener("click", saveFavorite);
  els.addQueueButton.addEventListener("click", addQueueItem);
  els.openDownloadDirButton.addEventListener("click", openDownloadDirectory);
  els.startQueueButton.addEventListener("click", startQueue);
  els.stopQueueButton.addEventListener("click", stopQueue);
  els.clearQueueButton.addEventListener("click", clearQueue);
  els.startButton.addEventListener("click", startDownload);
  els.stopButton.addEventListener("click", () => window.hfBridge.stopProcess());
  els.openLogButton.addEventListener("click", openLog);
  els.clearLogButton.addEventListener("click", clearLog);

  els.loadFilesButton.addEventListener("click", loadRepoFiles);
  els.fileSearch.addEventListener("input", () => {
    renderFileList();
    scheduleSaveOnly();
  });
  els.selectFilteredButton.addEventListener("click", () => selectFiles(filteredRepoFiles()));
  els.clearFileSelectionButton.addEventListener("click", () => {
    state.selectedFiles.clear();
    syncTextareaFromSelectedFiles();
    renderFileList();
  });
  els.fileList.addEventListener("change", (event) => {
    const checkbox = event.target.closest('input[type="checkbox"][data-path]');
    if (!checkbox) {
      return;
    }
    if (checkbox.checked) {
      state.selectedFiles.add(checkbox.dataset.path);
    } else {
      state.selectedFiles.delete(checkbox.dataset.path);
    }
    syncTextareaFromSelectedFiles();
    updateFilePreviewSummary();
  });

  els.toggleTokenButton?.addEventListener("click", () => {
    const token = fieldElement("token");
    token.type = token.type === "password" ? "text" : "password";
    els.toggleTokenButton.classList.toggle("active", token.type === "text");
  });

  els.minimizeButton?.addEventListener("click", () => window.hfBridge.minimizeWindow?.());
  els.maximizeButton?.addEventListener("click", () => window.hfBridge.toggleMaximizeWindow?.());
  els.closeButton?.addEventListener("click", () => {
    saveCurrentStateSync();
    window.hfBridge.closeWindow?.();
  });

  window.addEventListener("beforeunload", () => {
    saveCurrentStateSync();
  });

  els.favoritesList.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) {
      return;
    }
    const item = findStoredItem("favorites", target.dataset.id);
    if (target.dataset.action === "apply-favorite" && item) {
      applyStoredForm(item.form);
      appendLog(`[收藏] 已载入 ${item.repoId}。\n`);
    }
    if (target.dataset.action === "remove-favorite") {
      await removeFavorite(target.dataset.id);
    }
  });

  els.queueList.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) {
      return;
    }
    const item = findQueueItem(target.dataset.id);
    if (target.dataset.action === "apply-queue" && item) {
      applyStoredForm(item.form);
      appendLog(`[队列] 已载入 ${item.repoId}。\n`);
    }
    if (target.dataset.action === "remove-queue") {
      await removeQueueItem(target.dataset.id);
    }
  });

  window.hfBridge.onProcessProgress?.((payload) => {
    state.progress = updateDownloadSpeed({ ...state.progress, ...payload });
    updateProgressView();
  });
  window.hfBridge.onProcessStatus((payload) => {
    if (payload.state === "item-completed") {
      return;
    }
    if (payload.state === "running") {
      setRunning(true, payload.kind === "install" ? "安装中" : payload.kind === "queue" ? "队列中" : "下载中");
      if (payload.kind === "install") {
        state.progress = {
          ...state.progress,
          state: "running",
          repoId: "huggingface_hub",
          endpoint: "-",
          totalFiles: 0,
          completedFiles: 0,
          percent: 0,
          currentFile: "",
          phase: "正在安装或更新 Hugging Face CLI"
        };
        updateProgressView();
      }
      return;
    }
    if (payload.state === "stopping") {
      setRunning(true, "停止中");
      state.progress = { ...state.progress, state: "stopping", phase: "正在停止任务" };
      updateProgressView();
      return;
    }
    if (payload.state === "completed") {
      setRunning(false, payload.kind === "install" ? "安装完成" : payload.kind === "queue" ? "队列完成" : "完成");
      state.progress = {
        ...state.progress,
        state: "completed",
        phase: payload.kind === "install" ? "环境已更新完成" : payload.kind === "queue" ? "队列已处理完成" : "下载已完成",
        percent: 100,
        completedFiles: Math.max(state.progress.completedFiles || 0, state.progress.totalFiles || 0)
      };
      updateProgressView();
      if (payload.kind === "install") {
        checkCli();
      }
      return;
    }
    if (payload.state === "canceled") {
      setRunning(false, "已停止");
      state.progress = { ...state.progress, state: "canceled", phase: "任务已停止" };
      updateProgressView();
      return;
    }
    setRunning(false, `失败 ${payload.code ?? ""}`.trim(), true);
    state.progress = { ...state.progress, state: "failed", phase: `任务失败${payload.code !== undefined ? `（${payload.code}）` : ""}` };
    updateProgressView();
  });
  window.hfBridge.onLibraryChanged((library) => {
    state.library = library;
    renderLibrary();
  });
  window.hfBridge.onQueueChanged((queue) => {
    state.queue = queue;
    renderQueue();
    if (queue.running) {
      setRunning(true, "队列中");
    }
  });
}

async function init() {
  bindEvents();
  initPaneResize();
  initProgressRefreshTimer();
  resetProgress();
  if (els.appVersion && window.hfBridge.getAppVersion) {
    try {
      els.appVersion.textContent = `v${await window.hfBridge.getAppVersion()}`;
    } catch {
      els.appVersion.textContent = "";
    }
  }
  const settings = await window.hfBridge.loadSettings();
  const session = (await window.hfBridge.loadSession?.().catch(() => null)) || {};
  writeForm({ ...settings, ...(session.form || {}) });
  if (Array.isArray(session.repoFiles)) {
    state.repoFiles = session.repoFiles;
  }
  if (els.fileSearch && typeof session.fileSearch === "string") {
    els.fileSearch.value = session.fileSearch;
  }
  if (els.filePreviewStatus && session.filePreviewStatus) {
    els.filePreviewStatus.textContent = session.filePreviewStatus;
  }
  syncSelectedFilesFromTextarea();
  renderFileList();
  await loadLibrary();
  await loadQueue();
  await refreshLogStatus();
  await updatePreview();
  await checkCli();
}

init();
