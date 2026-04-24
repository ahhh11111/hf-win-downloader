const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildDownloadPlan, MIRROR_ENDPOINT } = require("../src/command");
const {
  createFavoriteItem,
  createHistoryItem,
  normalizeLibrary,
  updateHistoryStatus,
  upsertFavorite,
  upsertHistory
} = require("../src/library");
const {
  appendQueueItem,
  createQueueItem,
  clearFinishedQueueItems,
  nextQueuedItem,
  normalizeQueue,
  updateQueueItem
} = require("../src/queue");

const modelPlan = buildDownloadPlan(
  {
    repoType: "model",
    repoId: "gpt2",
    files: "config.json\nmodel.safetensors",
    localDir: "C:\\models\\gpt2",
    source: "mirror",
    endpoint: "",
    revision: "main",
    include: "*.json,*.safetensors",
    exclude: "*.bin",
    token: "hf_secret",
    maxWorkers: 16,
    downloadTimeout: 30,
    etagTimeout: 10,
    dryRun: true,
    forceDownload: false,
    quiet: true,
    highPerformance: true,
    disableSymlinks: true
  },
  "hf"
);

assert.equal(modelPlan.command, "hf");
assert.equal(modelPlan.endpoint, MIRROR_ENDPOINT);
assert.equal(modelPlan.env.HF_ENDPOINT, MIRROR_ENDPOINT);
assert.ok(modelPlan.maskedCommand.includes("$env:HF_ENDPOINT='https://hf-mirror.com'"));
assert.equal(modelPlan.env.HF_XET_HIGH_PERFORMANCE, "1");
assert.equal(modelPlan.env.HF_HUB_DISABLE_SYMLINKS, "1");
assert.deepEqual(modelPlan.args.slice(0, 4), ["download", "gpt2", "config.json", "model.safetensors"]);
assert.ok(modelPlan.args.includes("--local-dir"));
assert.ok(modelPlan.args.includes("--dry-run"));
assert.ok(modelPlan.args.includes("--max-workers"));
assert.ok(modelPlan.args.includes("--format"));
assert.ok(modelPlan.args.includes("quiet"));
assert.ok(!modelPlan.maskedCommand.includes("hf_secret"));

const datasetPlan = buildDownloadPlan(
  {
    repoType: "dataset",
    repoId: "wikitext",
    files: "",
    localDir: "D:\\data\\wikitext",
    source: "official",
    maxWorkers: 8
  },
  "hf"
);

assert.ok(datasetPlan.args.includes("--repo-type"));
assert.ok(datasetPlan.args.includes("dataset"));
assert.equal(datasetPlan.env.HF_ENDPOINT, undefined);

assert.throws(() => buildDownloadPlan({ repoType: "model", repoId: "", source: "official" }), /仓库 ID/);

const historyItem = createHistoryItem("history-1", { ...modelPlan, repoId: "gpt2", token: "hf_secret" }, modelPlan);
assert.equal(historyItem.status, "running");
assert.equal(historyItem.form.token, undefined);

let library = upsertHistory(normalizeLibrary(), historyItem);
library = updateHistoryStatus(library, "history-1", "completed", 0);
assert.equal(library.history[0].status, "completed");
assert.equal(library.history[0].exitCode, 0);

const favorite = createFavoriteItem("favorite-1", { repoType: "model", repoId: "gpt2", token: "hf_secret" });
const favoriteResult = upsertFavorite(library, favorite);
assert.equal(favoriteResult.library.favorites.length, 1);
assert.equal(favoriteResult.library.favorites[0].form.token, undefined);

let queue = appendQueueItem(normalizeQueue(), createQueueItem("queue-1", { repoType: "model", repoId: "gpt2" }, modelPlan));
assert.equal(queue.items.length, 1);
assert.equal(nextQueuedItem(queue).id, "queue-1");
queue = updateQueueItem(queue, "queue-1", { status: "running" });
assert.equal(queue.items[0].status, "running");
assert.equal(normalizeQueue({ items: [{ id: "queue-2", status: "queued" }] }).items[0].status, "queued");
assert.equal(
  clearFinishedQueueItems({ items: [{ id: "queued", status: "queued" }, { id: "done", status: "completed" }] }).items
    .length,
  1
);

const iconPath = path.join(__dirname, "..", "build", "icon.ico");
assert.ok(fs.existsSync(iconPath), "build/icon.ico should exist; run npm run icon first");
const icon = fs.readFileSync(iconPath);
assert.equal(icon.readUInt16LE(0), 0);
assert.equal(icon.readUInt16LE(2), 1);
assert.ok(icon.readUInt16LE(4) >= 5);

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const extraResources = packageJson.build?.extraResources ?? [];
assert.ok(
  extraResources.some((item) => item.from === "src/hf_download_runner.py" && item.to === "hf_download_runner.py"),
  "hf_download_runner.py should be copied outside app.asar for external python.exe"
);

console.log("smoke ok");
