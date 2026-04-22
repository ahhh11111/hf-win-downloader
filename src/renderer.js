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
  previewTimer: 0,
  saveTimer: 0
};

const $ = (selector) => document.querySelector(selector);

const els = {
  cliStatus: $("#cliStatus"),
  checkCliButton: $("#checkCliButton"),
  installCliButton: $("#installCliButton"),
  saveFavoriteButton: $("#saveFavoriteButton"),
  copyCommandButton: $("#copyCommandButton"),
  openFolderButton: $("#openFolderButton"),
  addQueueButton: $("#addQueueButton"),
  startQueueButton: $("#startQueueButton"),
  stopQueueButton: $("#stopQueueButton"),
  clearQueueButton: $("#clearQueueButton"),
  startButton: $("#startButton"),
  stopButton: $("#stopButton"),
  clearLogButton: $("#clearLogButton"),
  clearHistoryButton: $("#clearHistoryButton"),
  pickLocalDir: $("#pickLocalDir"),
  commandPreview: $("#commandPreview"),
  endpointBadge: $("#endpointBadge"),
  warningBox: $("#warningBox"),
  logOutput: $("#logOutput"),
  runState: $("#runState"),
  endpointGroup: $("#endpointGroup"),
  favoritesList: $("#favoritesList"),
  historyList: $("#historyList"),
  queueList: $("#queueList")
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
  els.endpointGroup.hidden = source === "official";
}

function scheduleSaveAndPreview() {
  clearTimeout(state.saveTimer);
  clearTimeout(state.previewTimer);

  state.saveTimer = setTimeout(() => {
    window.hfBridge.saveSettings(readForm()).catch(() => {});
  }, 250);

  state.previewTimer = setTimeout(updatePreview, 120);
}

async function updatePreview() {
  try {
    const plan = await window.hfBridge.previewDownload(readForm());
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

function appendLog(text, stream = "stdout") {
  const normalized = String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n");
  const prefix = stream === "stderr" ? "" : "";
  els.logOutput.textContent += prefix + normalized;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
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
    return "取消";
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
  path.textContent = item.localDir || item.form?.localDir || "";

  main.append(titleLine, meta, path);
  row.append(main, createIconButton(options.removeAction, item.id, options.removeTitle));
  return row;
}

function renderList(container, items, options) {
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "repo-empty";
    empty.textContent = options.emptyText;
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    container.appendChild(createRepoItem(item, options));
  }
}

function renderLibrary() {
  renderList(els.favoritesList, state.library.favorites, {
    applyAction: "apply-favorite",
    removeAction: "remove-favorite",
    removeTitle: "删除收藏",
    emptyText: "暂无收藏"
  });
  renderList(els.historyList, state.library.history, {
    applyAction: "apply-history",
    removeAction: "remove-history",
    removeTitle: "删除历史",
    emptyText: "暂无历史",
    showStatus: true
  });
}

function renderQueue() {
  renderList(els.queueList, state.queue.items, {
    applyAction: "apply-queue",
    removeAction: "remove-queue",
    removeTitle: "移出队列",
    emptyText: "暂无队列任务",
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
    const result = await window.hfBridge.addFavorite(readForm());
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

async function removeHistory(id) {
  state.library = await window.hfBridge.removeHistory(id);
  renderLibrary();
}

async function clearHistory() {
  state.library = await window.hfBridge.clearHistory();
  renderLibrary();
  appendLog("[历史] 已清空。\n");
}

async function addQueueItem() {
  try {
    state.queue = await window.hfBridge.addQueueItem(readForm());
    renderQueue();
    appendLog(`[队列] 已加入 ${readForm().repoId}。\n`);
  } catch (error) {
    appendLog(`[队列] ${error.message}\n`, "stderr");
  }
}

async function startQueue() {
  try {
    els.logOutput.textContent = "";
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

function setRunning(running, label = running ? "运行中" : "就绪", failed = false) {
  state.running = running;
  els.runState.textContent = label;
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
  els.logOutput.textContent = "";
  try {
    const plan = await window.hfBridge.startDownload(readForm());
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
    els.logOutput.textContent = "";
    await window.hfBridge.installCli();
    setRunning(true, "安装中");
    appendLog("[安装] python -m pip install -U huggingface_hub\n\n");
  } catch (error) {
    appendLog(`${error.message}\n`, "stderr");
    setRunning(false, "失败", true);
  }
}

function bindEvents() {
  document.querySelectorAll("input, textarea").forEach((el) => {
    el.addEventListener("input", () => {
      updateEndpointVisibility();
      scheduleSaveAndPreview();
    });
    el.addEventListener("change", () => {
      updateEndpointVisibility();
      scheduleSaveAndPreview();
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

  els.checkCliButton.addEventListener("click", checkCli);
  els.installCliButton.addEventListener("click", installCli);
  els.saveFavoriteButton.addEventListener("click", saveFavorite);
  els.addQueueButton.addEventListener("click", addQueueItem);
  els.startQueueButton.addEventListener("click", startQueue);
  els.stopQueueButton.addEventListener("click", stopQueue);
  els.clearQueueButton.addEventListener("click", clearQueue);
  els.startButton.addEventListener("click", startDownload);
  els.stopButton.addEventListener("click", () => window.hfBridge.stopProcess());
  els.clearHistoryButton.addEventListener("click", clearHistory);
  els.clearLogButton.addEventListener("click", () => {
    els.logOutput.textContent = "";
  });

  els.copyCommandButton.addEventListener("click", async () => {
    await window.hfBridge.writeClipboard(state.command || els.commandPreview.textContent);
    appendLog("[剪贴板] 已复制命令预览。\n");
  });

  els.openFolderButton.addEventListener("click", async () => {
    const result = await window.hfBridge.openPath(fieldElement("localDir").value);
    if (result) {
      appendLog(`[目录] ${result}\n`, "stderr");
    }
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

  els.historyList.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) {
      return;
    }
    const item = findStoredItem("history", target.dataset.id);
    if (target.dataset.action === "apply-history" && item) {
      applyStoredForm(item.form);
      appendLog(`[历史] 已载入 ${item.repoId}。\n`);
    }
    if (target.dataset.action === "remove-history") {
      await removeHistory(target.dataset.id);
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

  window.hfBridge.onProcessOutput(({ stream, text }) => appendLog(text, stream));
  window.hfBridge.onProcessStatus((payload) => {
    if (payload.state === "item-completed") {
      return;
    }
    if (payload.state === "running") {
      setRunning(true, payload.kind === "install" ? "安装中" : payload.kind === "queue" ? "队列中" : "下载中");
      return;
    }
    if (payload.state === "stopping") {
      setRunning(true, "停止中");
      return;
    }
    if (payload.state === "completed") {
      setRunning(false, payload.kind === "install" ? "安装完成" : payload.kind === "queue" ? "队列完成" : "完成");
      if (payload.kind === "install") {
        checkCli();
      }
      return;
    }
    if (payload.state === "canceled") {
      setRunning(false, "已停止");
      return;
    }
    setRunning(false, `失败 ${payload.code ?? ""}`.trim(), true);
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
  const settings = await window.hfBridge.loadSettings();
  writeForm(settings);
  await loadLibrary();
  await loadQueue();
  await updatePreview();
  await checkCli();
}

init();
