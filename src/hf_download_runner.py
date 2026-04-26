import fnmatch
import itertools
import json
import os
import sys

from tqdm.auto import tqdm as base_tqdm


EVENT_PREFIX = "__HF_EVENT__ "
PROGRESS_COUNTER = itertools.count(1)


def emit_event(payload):
    sys.stdout.write(EVENT_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def write_log(message):
    sys.stderr.write(message.rstrip("\n") + "\n")
    sys.stderr.flush()


def clean_text(value):
    return str(value or "").strip()


def split_patterns(value):
    raw = clean_text(value)
    if not raw:
        return []
    parts = []
    for chunk in raw.replace(",", "\n").splitlines():
        item = chunk.strip()
        if item:
            parts.append(item)
    return parts


def split_files(value):
    raw = clean_text(value)
    if not raw:
        return []
    return [item.strip() for item in raw.splitlines() if item.strip()]


def normalize_repo_type(value):
    repo_type = clean_text(value) or "model"
    return None if repo_type == "model" else repo_type


def file_matches_pattern(path, pattern):
    normalized_path = str(path).replace("\\", "/")
    normalized_pattern = str(pattern).replace("\\", "/")
    basename = normalized_path.rsplit("/", 1)[-1]
    target = normalized_path if "/" in normalized_pattern else basename
    return fnmatch.fnmatchcase(target, normalized_pattern)


def filter_explicit_files(files, include_patterns, exclude_patterns):
    filtered = []
    for file_path in files:
        if include_patterns and not any(file_matches_pattern(file_path, pattern) for pattern in include_patterns):
            continue
        if exclude_patterns and any(file_matches_pattern(file_path, pattern) for pattern in exclude_patterns):
            continue
        filtered.append(file_path)
    return filtered


def build_download_kwargs(form):
    explicit_files = split_files(form.get("files"))
    include_patterns = split_patterns(form.get("include"))
    exclude_patterns = split_patterns(form.get("exclude"))

    if explicit_files:
        explicit_files = filter_explicit_files(explicit_files, include_patterns, exclude_patterns)
        if not explicit_files:
            raise RuntimeError("No files remain after applying Include / Exclude filters.")
        allow_patterns = explicit_files
        ignore_patterns = None
    else:
        allow_patterns = include_patterns or None
        ignore_patterns = exclude_patterns or None

    return {
        "repo_id": clean_text(form.get("repoId")),
        "repo_type": normalize_repo_type(form.get("repoType")),
        "revision": clean_text(form.get("revision")) or None,
        "local_dir": clean_text(form.get("localDir")) or None,
        "cache_dir": clean_text(form.get("cacheDir")) or None,
        "allow_patterns": allow_patterns,
        "ignore_patterns": ignore_patterns,
        "max_workers": max(int(form.get("maxWorkers") or 8), 1),
        "force_download": bool(form.get("forceDownload")),
        "dry_run": bool(form.get("dryRun")),
        "token": clean_text(form.get("token")) or None,
        "endpoint": clean_text(form.get("endpoint")) or None,
        "tqdm_class": JsonProgressTqdm,
    }


def form_for_spec(form, spec):
    next_form = dict(form)
    next_form["repoId"] = clean_text(spec.get("repoId"))
    next_form["repoType"] = clean_text(spec.get("repoType")) or "model"
    next_form["revision"] = clean_text(spec.get("revision"))
    next_form["files"] = "\n".join(clean_text(item) for item in spec.get("files", []) if clean_text(item))
    next_form["include"] = ""
    next_form["exclude"] = ""
    return next_form


def normalize_download_specs(value):
    if not isinstance(value, list):
        return []

    specs = []
    for item in value:
        if not isinstance(item, dict):
            continue
        repo_id = clean_text(item.get("repoId"))
        files = [clean_text(file_path) for file_path in item.get("files", []) if clean_text(file_path)]
        if not repo_id or not files:
            continue
        specs.append(
            {
                "repoId": repo_id,
                "repoType": clean_text(item.get("repoType")) or "model",
                "revision": clean_text(item.get("revision")),
                "files": files,
            }
        )
    return specs


def set_runtime_environment(form):
    download_timeout = clean_text(form.get("downloadTimeout"))
    if download_timeout:
        os.environ["HF_HUB_DOWNLOAD_TIMEOUT"] = download_timeout

    etag_timeout = clean_text(form.get("etagTimeout"))
    if etag_timeout:
        os.environ["HF_HUB_ETAG_TIMEOUT"] = etag_timeout

    if form.get("highPerformance"):
        os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"

    if form.get("disableSymlinks"):
        os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"
        os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"


def phase_from_desc(description, downloaded_bytes=0, total_bytes=0):
    desc = clean_text(description).lower()
    if "complete" in desc and total_bytes > 0 and downloaded_bytes >= total_bytes:
        return "completed"
    if "download" in desc:
        return "downloading"
    return "preparing"


class JsonProgressTqdm(base_tqdm):
    def __init__(self, *args, **kwargs):
        self._hf_desc = kwargs.get("desc") or ""
        self._hf_progress_id = next(PROGRESS_COUNTER)
        self._last_signature = None
        kwargs["disable"] = False
        kwargs["mininterval"] = 0
        kwargs["miniters"] = 1
        super().__init__(*args, **kwargs)
        self._emit_progress()

    def display(self, *args, **kwargs):
        return None

    def update(self, n=1):
        result = super().update(n)
        self._emit_progress()
        return result

    def refresh(self, *args, **kwargs):
        result = super().refresh(*args, **kwargs)
        self._emit_progress()
        return result

    def set_description(self, desc=None, refresh=True):
        if desc is not None:
            self._hf_desc = desc
        result = super().set_description(desc, refresh)
        self._emit_progress()
        return result

    def close(self):
        self._emit_progress(force=True)
        return super().close()

    def _emit_progress(self, force=False):
        if str(getattr(self, "unit", "")) != "B":
            return

        total_bytes = int(self.total or 0)
        downloaded_bytes = int(self.n or 0)
        percent = round((downloaded_bytes / total_bytes) * 100, 2) if total_bytes > 0 else 0.0
        payload = {
            "event": "progress",
            "progress_id": str(self._hf_progress_id),
            "phase": phase_from_desc(self._hf_desc, downloaded_bytes, total_bytes),
            "total_bytes": total_bytes,
            "downloaded_bytes": downloaded_bytes,
            "percent": percent,
        }
        signature = (payload["phase"], payload["total_bytes"], payload["downloaded_bytes"], payload["percent"])
        if signature == self._last_signature:
            return
        self._last_signature = signature
        emit_event(payload)


def run_download(form, download_specs=None):
    repo_id = clean_text(form.get("repoId"))
    if not repo_id:
        raise RuntimeError("Missing repoId.")

    set_runtime_environment(form)
    from huggingface_hub import snapshot_download

    specs = normalize_download_specs(download_specs)
    forms = [form_for_spec(form, spec) for spec in specs] if specs else [form]
    emit_event({"event": "progress", "phase": "preparing", "total_bytes": 0, "downloaded_bytes": 0, "percent": 0})

    dry_run_files = 0
    dry_run_bytes = 0
    results = []

    for current_form in forms:
        kwargs = build_download_kwargs(current_form)
        result = snapshot_download(**kwargs)
        results.append(result)

        if kwargs["dry_run"]:
            files = result if isinstance(result, list) else []
            dry_run_files += len(files)
            dry_run_bytes += sum(int(getattr(item, "file_size", 0) or 0) for item in files)

    dry_run_enabled = form.get("dryRun") is True or clean_text(form.get("dryRun")).lower() in {"true", "1", "yes", "on"}
    if dry_run_enabled:
        emit_event(
            {
                "event": "progress",
                "phase": "completed",
                "total_bytes": dry_run_bytes,
                "downloaded_bytes": dry_run_bytes,
                "percent": 100,
            }
        )
        write_log(f"[Dry Run] {dry_run_files} file(s), {dry_run_bytes} bytes planned.")
        return

    write_log(f"[Download] Completed: {results[-1] if len(results) == 1 else f'{len(results)} downloads'}")


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        form = payload.get("form") if isinstance(payload, dict) and "form" in payload else payload
        download_specs = payload.get("downloadSpecs") if isinstance(payload, dict) else None
        if not isinstance(form, dict):
            raise RuntimeError("Invalid payload.")
        run_download(form, download_specs)
    except Exception as error:
        write_log(f"[Download] {error}")
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
