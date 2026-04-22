const MAX_HISTORY = 80;
const MAX_FAVORITES = 60;

const FORM_KEYS = [
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
  "maxWorkers",
  "downloadTimeout",
  "etagTimeout",
  "dryRun",
  "forceDownload",
  "quiet",
  "highPerformance",
  "disableSymlinks"
];

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeLibrary(raw) {
  return {
    history: Array.isArray(raw?.history) ? raw.history : [],
    favorites: Array.isArray(raw?.favorites) ? raw.favorites : []
  };
}

function formSnapshot(form) {
  const snapshot = {};
  for (const key of FORM_KEYS) {
    if (form[key] !== undefined) {
      snapshot[key] = form[key];
    }
  }
  return snapshot;
}

function titleFromForm(form) {
  return cleanText(form.repoId) || "未命名仓库";
}

function favoriteKey(form) {
  const repoType = cleanText(form.repoType) || "model";
  const repoId = cleanText(form.repoId).toLowerCase();
  return `${repoType}:${repoId}`;
}

function summarizeForm(form, endpoint) {
  const parts = [cleanText(form.repoType) || "model"];
  const revision = cleanText(form.revision);
  if (revision) {
    parts.push(revision);
  }
  const source = endpoint || cleanText(form.endpoint) || cleanText(form.source) || "official";
  parts.push(source);
  return parts.join(" · ");
}

function createHistoryItem(id, form, plan, createdAt = new Date().toISOString()) {
  const snapshot = formSnapshot(form);
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    completedAt: "",
    status: "running",
    exitCode: null,
    title: titleFromForm(snapshot),
    repoType: cleanText(snapshot.repoType) || "model",
    repoId: cleanText(snapshot.repoId),
    localDir: cleanText(snapshot.localDir),
    endpoint: plan.endpoint,
    command: plan.maskedCommand,
    summary: summarizeForm(snapshot, plan.endpoint),
    form: snapshot
  };
}

function upsertHistory(library, item) {
  const next = normalizeLibrary(library);
  next.history = [item, ...next.history.filter((entry) => entry.id !== item.id)].slice(0, MAX_HISTORY);
  return next;
}

function updateHistoryStatus(library, id, status, exitCode, completedAt = new Date().toISOString()) {
  const next = normalizeLibrary(library);
  next.history = next.history.map((entry) => {
    if (entry.id !== id) {
      return entry;
    }
    return {
      ...entry,
      status,
      exitCode,
      completedAt,
      updatedAt: completedAt
    };
  });
  return next;
}

function createFavoriteItem(id, form, createdAt = new Date().toISOString()) {
  const snapshot = formSnapshot(form);
  return {
    id,
    key: favoriteKey(snapshot),
    createdAt,
    updatedAt: createdAt,
    title: titleFromForm(snapshot),
    repoType: cleanText(snapshot.repoType) || "model",
    repoId: cleanText(snapshot.repoId),
    localDir: cleanText(snapshot.localDir),
    summary: summarizeForm(snapshot),
    form: snapshot
  };
}

function upsertFavorite(library, item) {
  const next = normalizeLibrary(library);
  const existing = next.favorites.find((entry) => entry.key === item.key);
  const merged = existing ? { ...item, id: existing.id, createdAt: existing.createdAt } : item;
  next.favorites = [merged, ...next.favorites.filter((entry) => entry.key !== item.key)].slice(0, MAX_FAVORITES);
  return { library: next, item: merged };
}

function removeById(library, collection, id) {
  const next = normalizeLibrary(library);
  next[collection] = next[collection].filter((entry) => entry.id !== id);
  return next;
}

module.exports = {
  createFavoriteItem,
  createHistoryItem,
  favoriteKey,
  formSnapshot,
  normalizeLibrary,
  removeById,
  updateHistoryStatus,
  upsertFavorite,
  upsertHistory
};
