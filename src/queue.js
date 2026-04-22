const { formSnapshot } = require("./library");

const MAX_QUEUE_ITEMS = 100;

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeQueue(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return {
    running: false,
    paused: Boolean(raw?.paused),
    items: items.slice(0, MAX_QUEUE_ITEMS).map((item) => {
      const status = item.status || "queued";
      return { ...item, status, historyId: status === "queued" ? "" : item.historyId || "" };
    })
  };
}

function createQueueItem(id, form, plan, createdAt = new Date().toISOString()) {
  const snapshot = formSnapshot(form);
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    startedAt: "",
    completedAt: "",
    status: "queued",
    exitCode: null,
    historyId: "",
    title: cleanText(snapshot.repoId) || "未命名仓库",
    repoType: cleanText(snapshot.repoType) || "model",
    repoId: cleanText(snapshot.repoId),
    localDir: cleanText(snapshot.localDir),
    endpoint: plan.endpoint,
    command: plan.maskedCommand,
    summary: [cleanText(snapshot.repoType) || "model", plan.endpoint].filter(Boolean).join(" · "),
    form: snapshot
  };
}

function appendQueueItem(queue, item) {
  const next = normalizeQueue(queue);
  next.items = [...next.items, item].slice(0, MAX_QUEUE_ITEMS);
  return next;
}

function updateQueueItem(queue, id, patch) {
  const next = normalizeQueue(queue);
  next.running = Boolean(queue?.running);
  next.paused = Boolean(queue?.paused);
  next.items = next.items.map((item) => (item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item));
  return next;
}

function removeQueueItem(queue, id) {
  const next = normalizeQueue(queue);
  next.running = Boolean(queue?.running);
  next.paused = Boolean(queue?.paused);
  next.items = next.items.filter((item) => item.id !== id);
  return next;
}

function clearFinishedQueueItems(queue) {
  const next = normalizeQueue(queue);
  next.running = Boolean(queue?.running);
  next.paused = Boolean(queue?.paused);
  next.items = next.items.filter((item) => item.status === "running" || item.status === "queued");
  return next;
}

function nextQueuedItem(queue) {
  return queue.items.find((item) => item.status === "queued") || null;
}

module.exports = {
  appendQueueItem,
  clearFinishedQueueItems,
  createQueueItem,
  nextQueuedItem,
  normalizeQueue,
  removeQueueItem,
  updateQueueItem
};
