const { spawnSync } = require("node:child_process");
const path = require("node:path");

require("./generate-icon");

const root = path.join(__dirname, "..");
const electronBuilder = path.join(root, "node_modules", "electron-builder", "cli.js");

const result = spawnSync(process.execPath, [electronBuilder, "--win", "portable", "--x64"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false"
  }
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
