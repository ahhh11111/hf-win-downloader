const { spawnSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const root = path.join(__dirname, "..");
  const packageJson = require(path.join(root, "package.json"));
  const winVersion = /^\d+\.\d+\.\d+\.\d+$/.test(packageJson.version) ? packageJson.version : `${packageJson.version}.0`;
  const rcedit = path.join(root, "node_modules", "rcedit", "bin", process.arch === "ia32" ? "rcedit.exe" : "rcedit-x64.exe");
  const icon = path.join(root, "build", "icon.ico");
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);

  const result = spawnSync(
    rcedit,
    [
      executable,
      "--set-icon",
      icon,
      "--set-version-string",
      "FileDescription",
      "HF Downloader",
      "--set-version-string",
      "ProductName",
      "HF Downloader",
      "--set-version-string",
      "CompanyName",
      "Local",
      "--set-file-version",
      winVersion,
      "--set-product-version",
      winVersion
    ],
    { cwd: root, stdio: "inherit" }
  );

  if (result.status !== 0) {
    throw new Error(`rcedit failed for ${executable}`);
  }
};
