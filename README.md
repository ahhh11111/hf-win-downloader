# HF Downloader

[![Windows Build](https://github.com/ahhh11111/hf-win-downloader/actions/workflows/windows-build.yml/badge.svg)](https://github.com/ahhh11111/hf-win-downloader/actions/workflows/windows-build.yml)
[![Release](https://img.shields.io/github/v/release/ahhh11111/hf-win-downloader?label=release)](https://github.com/ahhh11111/hf-win-downloader/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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
HF-Downloader-0.1.0-x64-portable.exe
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
- 发布 GitHub Release：自动构建 exe，生成 SHA256 校验文件，并把产物上传到该 release。
- 手动触发 workflow：可在 GitHub Actions 页面随时生成构建产物和校验文件。

## 发布 Release

当前版本号来自 `package.json`：

```json
"version": "0.1.0"
```

发布新版本时，推荐使用一键脚本：

```powershell
npm run release:win -- patch
```

也可以指定 `minor`、`major` 或完整版本号：

```powershell
npm run release:win -- minor
npm run release:win -- 0.2.0
```

脚本会检查工作区是否干净，更新 `package.json` 和 `package-lock.json`，运行 smoke 测试，打包 Windows portable exe，生成 `.sha256` 校验文件，提交版本号，创建 tag，推送到 GitHub，并创建 release。

## 命令依据

下载命令优先使用官方推荐的 `hf download`，不再生成旧教程中的 `--resume-download` 和 `--local-dir-use-symlinks` 参数。下载源切换通过子进程环境变量 `HF_ENDPOINT` 完成，选择镜像时会设置为 `https://hf-mirror.com`。

参考资料：

- <https://huggingface.co/docs/huggingface_hub/guides/cli>
- <https://huggingface.co/docs/huggingface_hub/package_reference/cli#hf-download>
- <https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/constants.py>
- <https://www.electron.build/icons.html>
- <https://www.electron.build/nsis.html#portable>

## 许可证

本项目使用 [MIT](LICENSE) 许可证。你可以自由使用、复制、修改和分发这个项目，包括商业用途；保留许可证和版权声明即可。
