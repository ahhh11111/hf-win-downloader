# HF Downloader

HF Downloader 是一个面向 Windows 的 Hugging Face Hub 桌面下载器。它用 Electron 提供图形界面，底层调用官方 `hf download` 命令，适合下载模型、数据集和 Space 仓库，也支持把常用任务保存为收藏或加入队列。

## 功能

- 下载 Hugging Face 模型、数据集和 Space。
- 支持官方源、`hf-mirror.com` 镜像源和自定义 endpoint。
- 支持 `--local-dir`、`--cache-dir`、`--revision`、`--include`、`--exclude` 等常用参数。
- 支持 token、dry run、强制重下、并发数、超时和 Xet 高性能模式。
- 自动检测 Hugging Face CLI，并可辅助安装或更新 `huggingface_hub`。
- 提供实时日志、停止任务、历史记录、收藏夹和多任务下载队列。
- Token 只用于当前命令执行，不会写入设置、历史记录或收藏夹。

## 本地运行

```powershell
npm install
npm start
```

## 本地打包

```powershell
npm run build:win
```

打包成功后，portable 版本会输出到 `dist/`，文件名类似：

```text
HF Downloader-0.1.0-x64-portable.exe
```

应用图标由脚本生成：

```powershell
npm run icon
```

Windows 打包时，`scripts/after-pack.js` 会把 `build/icon.ico` 写入应用 exe，并设置基础的版本信息。

## 自动构建

仓库包含 GitHub Actions 工作流：

- push 到 `main`：自动安装依赖、运行 smoke 测试并打包 Windows portable exe。
- pull request 到 `main`：自动执行同样的验证和打包流程。
- 发布 GitHub Release：自动构建 exe，并把产物上传到该 release。
- 手动触发 workflow：可在 GitHub Actions 页面随时生成构建产物。

## 发布 Release

当前版本号来自 `package.json`：

```json
"version": "0.1.0"
```

发布新版本时，建议先更新版本号，然后执行本地验证：

```powershell
npm run smoke
npm run build:win
```

再创建 tag 和 release，例如：

```powershell
gh release create v0.1.0 "dist/HF Downloader-0.1.0-x64-portable.exe" --title "HF Downloader v0.1.0"
```

## 命令依据

下载命令优先使用官方推荐的 `hf download`，不再生成旧教程中的 `--resume-download` 和 `--local-dir-use-symlinks` 参数。下载源切换通过子进程环境变量 `HF_ENDPOINT` 完成，选择镜像时会设置为 `https://hf-mirror.com`。

参考资料：

- <https://huggingface.co/docs/huggingface_hub/guides/cli>
- <https://huggingface.co/docs/huggingface_hub/package_reference/cli#hf-download>
- <https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/constants.py>
- <https://www.electron.build/icons.html>
- <https://www.electron.build/nsis.html#portable>
