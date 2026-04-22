const DEFAULT_ENDPOINT = "https://huggingface.co";
const MIRROR_ENDPOINT = "https://hf-mirror.com";

function cleanText(value) {
  return String(value ?? "").trim();
}

function splitList(value) {
  return cleanText(value)
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitFilenames(value) {
  return cleanText(value)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEndpoint(form) {
  if (form.source === "mirror") {
    return MIRROR_ENDPOINT;
  }
  if (form.source === "custom") {
    return cleanText(form.endpoint).replace(/\/+$/, "");
  }
  return "";
}

function buildDownloadPlan(form, cliName = "hf") {
  const warnings = [];
  const repoId = cleanText(form.repoId);
  const localDir = cleanText(form.localDir);
  const repoType = cleanText(form.repoType) || "model";

  if (!repoId) {
    throw new Error("请输入 Hugging Face 仓库 ID。");
  }

  if (!["model", "dataset", "space"].includes(repoType)) {
    throw new Error("仓库类型只能是 model、dataset 或 space。");
  }

  const args = ["download", repoId];
  const files = splitFilenames(form.files);
  args.push(...files);

  if (repoType !== "model") {
    args.push("--repo-type", repoType);
  }

  const revision = cleanText(form.revision);
  if (revision) {
    args.push("--revision", revision);
  }

  for (const pattern of splitList(form.include)) {
    args.push("--include", pattern);
  }

  for (const pattern of splitList(form.exclude)) {
    args.push("--exclude", pattern);
  }

  if (localDir) {
    args.push("--local-dir", localDir);
  }

  const cacheDir = cleanText(form.cacheDir);
  if (cacheDir) {
    args.push("--cache-dir", cacheDir);
  }

  if (form.forceDownload) {
    args.push("--force-download");
  }

  if (form.dryRun) {
    args.push("--dry-run");
  }

  const token = cleanText(form.token);
  if (token) {
    args.push("--token", token);
  }

  if (form.quiet) {
    if (cliName === "huggingface-cli") {
      args.push("--quiet");
    } else {
      args.push("--format", "quiet");
    }
  }

  const maxWorkers = Number.parseInt(form.maxWorkers, 10);
  if (Number.isFinite(maxWorkers) && maxWorkers > 0 && maxWorkers !== 8) {
    args.push("--max-workers", String(maxWorkers));
  }

  const endpoint = normalizeEndpoint(form);
  const env = {
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    NO_COLOR: "1"
  };

  if (endpoint && endpoint !== DEFAULT_ENDPOINT) {
    env.HF_ENDPOINT = endpoint;
  }

  const downloadTimeout = Number.parseInt(form.downloadTimeout, 10);
  if (Number.isFinite(downloadTimeout) && downloadTimeout > 0) {
    env.HF_HUB_DOWNLOAD_TIMEOUT = String(downloadTimeout);
  }

  const etagTimeout = Number.parseInt(form.etagTimeout, 10);
  if (Number.isFinite(etagTimeout) && etagTimeout > 0) {
    env.HF_HUB_ETAG_TIMEOUT = String(etagTimeout);
  }

  if (form.highPerformance) {
    env.HF_XET_HIGH_PERFORMANCE = "1";
  }

  if (form.disableSymlinks) {
    env.HF_HUB_DISABLE_SYMLINKS = "1";
    env.HF_HUB_DISABLE_SYMLINKS_WARNING = "1";
  }

  if (form.source === "custom" && !endpoint) {
    throw new Error("自定义下载源不能为空。");
  }

  if (cleanText(form.legacyFlags)) {
    warnings.push("已忽略旧参数：新版 `hf download` 不再需要 `--resume-download` 或 `--local-dir-use-symlinks`。");
  }

  return {
    command: cliName,
    args,
    env,
    endpoint: endpoint || DEFAULT_ENDPOINT,
    warnings,
    maskedCommand: formatPowerShellCommand(cliName, args, env, { maskSecrets: true }),
    displayCommand: formatPowerShellCommand(cliName, args, env, { maskSecrets: false })
  };
}

function quoteArg(arg) {
  const value = String(arg);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function formatCommand(command, args, options = {}) {
  const maskSecrets = Boolean(options.maskSecrets);
  const rendered = [command];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (maskSecrets && arg === "--token" && index + 1 < args.length) {
      rendered.push(arg, "hf_***");
      index += 1;
      continue;
    }
    rendered.push(quoteArg(arg));
  }

  return rendered.join(" ");
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function shouldShowEnv(name) {
  return !["PYTHONUTF8", "PYTHONIOENCODING", "NO_COLOR"].includes(name);
}

function formatPowerShellCommand(command, args, env, options = {}) {
  const assignments = Object.entries(env ?? {})
    .filter(([name]) => shouldShowEnv(name))
    .map(([name, value]) => `$env:${name}=${quotePowerShell(value)}`);

  return [...assignments, formatCommand(command, args, options)].join("; ");
}

module.exports = {
  DEFAULT_ENDPOINT,
  MIRROR_ENDPOINT,
  buildDownloadPlan,
  formatCommand,
  formatPowerShellCommand,
  normalizeEndpoint,
  splitFilenames,
  splitList
};
