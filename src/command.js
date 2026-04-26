const DEFAULT_ENDPOINT = "https://huggingface.co";
const MIRROR_ENDPOINT = "https://hf-mirror.com";
const HF_URL_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf-mirror.com", "www.hf-mirror.com"]);
const FILE_ROUTE_MARKERS = new Set(["resolve", "blob", "raw"]);

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

function splitRepoIdInput(value) {
  return cleanText(value)
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(cleanText(value));
}

function parseHuggingFaceFileUrl(value) {
  const raw = cleanText(value);
  if (!looksLikeUrl(raw)) {
    return null;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`无法解析 Hugging Face 文件链接：${raw}`);
  }

  const hostname = url.hostname.toLowerCase();
  if (!HF_URL_HOSTS.has(hostname)) {
    throw new Error(`只支持 huggingface.co 或 hf-mirror.com 文件链接：${raw}`);
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodePathSegment);

  let repoType = "model";
  let repoStart = 0;
  if (segments[0] === "datasets") {
    repoType = "dataset";
    repoStart = 1;
  } else if (segments[0] === "spaces") {
    repoType = "space";
    repoStart = 1;
  }

  const markerIndex = segments.findIndex((segment, index) => index > repoStart && FILE_ROUTE_MARKERS.has(segment));
  if (markerIndex < 0 || markerIndex <= repoStart) {
    throw new Error(`链接不是 Hugging Face 文件直链：${raw}`);
  }

  const revision = segments[markerIndex + 1];
  const fileSegments = segments.slice(markerIndex + 2);
  if (!revision || !fileSegments.length) {
    throw new Error(`链接缺少版本或文件路径：${raw}`);
  }

  return {
    url: raw,
    repoType,
    repoId: segments.slice(repoStart, markerIndex).join("/"),
    revision,
    file: fileSegments.join("/")
  };
}

function parseDirectUrlInput(repoId) {
  const tokens = splitRepoIdInput(repoId);
  if (!tokens.length) {
    return { directUrls: false, urls: [], specs: [] };
  }

  const urlTokens = tokens.filter(looksLikeUrl);
  if (!urlTokens.length) {
    return { directUrls: false, urls: [], specs: [] };
  }
  if (urlTokens.length !== tokens.length) {
    throw new Error("仓库 ID 里不能混用普通仓库 ID 和 Hugging Face 文件链接。");
  }

  const urls = tokens.map(parseHuggingFaceFileUrl);
  const specs = [];
  const specByKey = new Map();

  for (const item of urls) {
    const key = `${item.repoType}\n${item.repoId}\n${item.revision}`;
    let spec = specByKey.get(key);
    if (!spec) {
      spec = {
        repoType: item.repoType,
        repoId: item.repoId,
        revision: item.revision,
        files: [],
        sourceUrls: []
      };
      specByKey.set(key, spec);
      specs.push(spec);
    }
    if (!spec.files.includes(item.file)) {
      spec.files.push(item.file);
    }
    spec.sourceUrls.push(item.url);
  }

  return { directUrls: true, urls, specs };
}

function normalizeDownloadForm(form) {
  const parsed = parseDirectUrlInput(form?.repoId);
  if (!parsed.directUrls) {
    return {
      ...form,
      directUrls: false,
      directUrlCount: 0,
      downloadSpecs: []
    };
  }

  const firstSpec = parsed.specs[0];
  const normalizedRepoId = parsed.specs.length === 1 ? firstSpec.repoId : `${parsed.urls.length} 个 Hugging Face 文件链接`;

  return {
    ...form,
    repoType: parsed.specs.length === 1 ? firstSpec.repoType : cleanText(form?.repoType) || "model",
    repoId: normalizedRepoId,
    revision: parsed.specs.length === 1 ? firstSpec.revision : "",
    files: parsed.urls.map((item) => item.file).join("\n"),
    include: "",
    exclude: "",
    directUrls: true,
    directUrlCount: parsed.urls.length,
    downloadSpecs: parsed.specs
  };
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

function buildArgs(form) {
  const repoId = cleanText(form.repoId);
  const localDir = cleanText(form.localDir);
  const repoType = cleanText(form.repoType) || "model";
  const args = ["download", repoId];
  const files = splitFilenames(form.files);
  const includePatterns = splitList(form.include);
  const excludePatterns = splitList(form.exclude);

  args.push(...files);

  if (repoType !== "model") {
    args.push("--repo-type", repoType);
  }

  const revision = cleanText(form.revision);
  if (revision) {
    args.push("--revision", revision);
  }

  for (const pattern of includePatterns) {
    args.push("--include", pattern);
  }

  for (const pattern of excludePatterns) {
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

  return { args, files, includePatterns, excludePatterns, repoType };
}

function withSpec(form, spec) {
  return {
    ...form,
    repoType: spec.repoType,
    repoId: spec.repoId,
    revision: spec.revision,
    files: spec.files.join("\n"),
    include: "",
    exclude: ""
  };
}

function buildDownloadPlan(form, cliName = "hf") {
  const warnings = [];
  const normalizedForm = normalizeDownloadForm(form);
  const repoId = cleanText(normalizedForm.repoId);
  const repoType = cleanText(normalizedForm.repoType) || "model";

  if (!repoId) {
    throw new Error("请输入 Hugging Face 仓库 ID。");
  }

  if (!["model", "dataset", "space"].includes(repoType)) {
    throw new Error("仓库类型只能是 model、dataset 或 space。");
  }

  const { files, includePatterns, excludePatterns } = buildArgs(normalizedForm);

  const maxWorkers = Number.parseInt(form.maxWorkers, 10);

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

  const appendRuntimeArgs = (targetArgs) => {
    if (form.quiet) {
      if (cliName === "huggingface-cli") {
        targetArgs.push("--quiet");
      } else {
        targetArgs.push("--format", "quiet");
      }
    }
    if (Number.isFinite(maxWorkers) && maxWorkers > 0 && maxWorkers !== 8) {
      targetArgs.push("--max-workers", String(maxWorkers));
    }
  };

  if (cleanText(form.legacyFlags)) {
    warnings.push("已忽略旧参数：新版 `hf download` 不再需要 `--resume-download` 或 `--local-dir-use-symlinks`。");
  }

  if (normalizedForm.directUrls) {
    warnings.push(
      `已从仓库 ID 中解析出 ${normalizedForm.directUrlCount} 个 Hugging Face 文件链接；URL 模式会忽略文件预览里的旧选择和 Include/Exclude。`
    );
    if (normalizedForm.downloadSpecs.length > 1) {
      warnings.push("这些链接跨仓库或版本，将按多个下载任务顺序处理；如果只能回退到 HF CLI，则需要拆分后分别下载。");
    }
  } else if (!files.length && !includePatterns.length && !excludePatterns.length) {
    warnings.push("当前没有指定文件或筛选条件，开始下载会拉取整个仓库。建议先用“文件预览”勾选需要的文件。");
  }

  if (files.length && (includePatterns.length || excludePatterns.length)) {
    warnings.push("已指定具体文件，同时 Include/Exclude 仍会参与过滤；如果文件没有被下载，请检查筛选条件是否排除了它。");
  }

  const commandForms = normalizedForm.directUrls
    ? normalizedForm.downloadSpecs.map((spec) => withSpec(normalizedForm, spec))
    : [normalizedForm];
  const commandArgs = commandForms.map((item) => {
    const result = buildArgs(item).args;
    appendRuntimeArgs(result);
    return result;
  });

  return {
    command: cliName,
    args: commandArgs[0],
    env,
    endpoint: endpoint || DEFAULT_ENDPOINT,
    warnings,
    normalizedForm,
    directUrls: Boolean(normalizedForm.directUrls),
    directUrlCount: normalizedForm.directUrlCount || 0,
    downloadSpecs: normalizedForm.downloadSpecs || [],
    multiCommand: commandArgs.length > 1,
    displayRepoId: normalizedForm.directUrls ? normalizedForm.repoId : repoId,
    maskedCommand: commandArgs.map((item) => formatPowerShellCommand(cliName, item, env, { maskSecrets: true })).join("\n"),
    displayCommand: commandArgs.map((item) => formatPowerShellCommand(cliName, item, env, { maskSecrets: false })).join("\n")
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
  normalizeDownloadForm,
  parseDirectUrlInput,
  splitFilenames,
  splitList
};
