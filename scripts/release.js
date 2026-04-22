const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");

function commandName(command) {
  if (process.platform === "win32" && command === "npm") {
    return "npm.cmd";
  }

  return command;
}

function run(command, args, options = {}) {
  const result = spawnSync(commandName(command), args, {
    cwd: root,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });

  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }

  return options.capture ? result.stdout.trim() : "";
}

function succeeds(command, args) {
  const result = spawnSync(commandName(command), args, {
    cwd: root,
    stdio: "ignore"
  });

  return result.status === 0;
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported version "${version}". Use x.y.z.`);
  }

  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }

  return 0;
}

function resolveNextVersion(current, target) {
  const [major, minor, patch] = parseVersion(current);

  if (target === "major") {
    return `${major + 1}.0.0`;
  }

  if (target === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  if (target === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }

  parseVersion(target);
  return target;
}

function findPortableExe(version) {
  const expected = path.join(root, "dist", `HF-Downloader-${version}-x64-portable.exe`);

  if (fs.existsSync(expected)) {
    return expected;
  }

  const matches = fs
    .readdirSync(path.join(root, "dist"), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith("-portable.exe") && name.includes(version));

  if (matches.length === 1) {
    return path.join(root, "dist", matches[0]);
  }

  throw new Error(`Expected one portable exe for ${version}, found ${matches.length}.`);
}

function writeChecksum(filePath) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  const checksumPath = `${filePath}.sha256`;
  fs.writeFileSync(checksumPath, `${hash}  ${path.basename(filePath)}${os.EOL}`, "ascii");
  return checksumPath;
}

function usage() {
  console.log(`Usage:
  npm run release:win -- patch
  npm run release:win -- minor
  npm run release:win -- major
  npm run release:win -- 0.2.0

The script requires a clean git worktree. It bumps package.json/package-lock.json,
runs smoke tests, builds the Windows portable exe, writes a SHA256 checksum,
commits the version bump, tags it, pushes, and creates a GitHub release.`);
}

function main() {
  const target = process.argv[2];

  if (!target || target === "-h" || target === "--help") {
    usage();
    process.exit(target ? 0 : 1);
  }

  const packagePath = path.join(root, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const currentVersion = packageJson.version;
  const nextVersion = resolveNextVersion(currentVersion, target);
  const tagName = `v${nextVersion}`;

  if (compareVersions(nextVersion, currentVersion) <= 0) {
    throw new Error(`Next version ${nextVersion} must be greater than current version ${currentVersion}.`);
  }

  const status = run("git", ["status", "--porcelain"], { capture: true });
  if (status) {
    throw new Error("Commit or stash local changes before running the release script.");
  }

  run("gh", ["auth", "status"]);

  if (succeeds("git", ["rev-parse", "-q", "--verify", `refs/tags/${tagName}`])) {
    throw new Error(`Local tag ${tagName} already exists.`);
  }

  const remoteTag = run("git", ["ls-remote", "--tags", "origin", tagName], { capture: true });
  if (remoteTag) {
    throw new Error(`Remote tag ${tagName} already exists.`);
  }

  if (succeeds("gh", ["release", "view", tagName])) {
    throw new Error(`GitHub release ${tagName} already exists.`);
  }

  const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { capture: true });
  const branch = run("git", ["branch", "--show-current"], { capture: true });
  if (!branch) {
    throw new Error("Run the release script from a named branch, not a detached HEAD.");
  }

  run("npm", ["version", nextVersion, "--no-git-tag-version"]);
  run("npm", ["run", "smoke"]);
  run("npm", ["run", "build:win"]);

  const exePath = findPortableExe(nextVersion);
  const checksumPath = writeChecksum(exePath);

  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `Release ${tagName}`]);
  run("git", ["tag", "-a", tagName, "-m", `HF Downloader ${tagName}`]);
  run("git", ["push", "origin", branch]);
  run("git", ["push", "origin", tagName]);

  const notes = `## Highlights

- Windows portable build for HF Downloader ${tagName}.
- Includes a SHA256 checksum for verifying the downloaded exe.

## Validation

- npm run smoke
- npm run build:win
`;
  const notesPath = path.join(os.tmpdir(), `hf-downloader-${tagName}-notes.md`);
  fs.writeFileSync(notesPath, notes, "utf8");

  run("gh", [
    "release",
    "create",
    tagName,
    exePath,
    checksumPath,
    "--repo",
    repo,
    "--title",
    `HF Downloader ${tagName}`,
    "--notes-file",
    notesPath
  ]);

  fs.rmSync(notesPath, { force: true });
  console.log(`Published ${tagName} to ${repo}.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
