# HF Downloader

一个简洁的 Windows 桌面下载器，用 Electron 包装 Hugging Face 官方 CLI。

## 运行

```powershell
npm install
npm start
```

## 打包

```powershell
npm run build:win
```

打包完成后，便携版 exe 会输出到 `dist/`，文件名形如 `HF Downloader-0.1.0-x64-portable.exe`。

应用图标由本地脚本生成：

```powershell
npm run icon
```

Windows 打包时会通过 `afterPack` 钩子把同一个 `build/icon.ico` 写入应用 exe，并把它配置为 NSIS portable 壳的图标。

## 队列

点击“加入队列”会保存当前表单配置为一个等待任务。点击“开始队列”后任务会顺序执行；当前任务停止时会标记为取消，并暂停后续任务。队列状态保存在 Electron 的 userData 目录中，重启后未完成任务仍可继续启动。

## 命令依据

当前实现优先使用官方推荐的 `hf download`，未再生成旧教程里的 `--resume-download` 和 `--local-dir-use-symlinks`。下载源切换通过子进程环境变量 `HF_ENDPOINT` 完成，选择镜像时会设置为 `https://hf-mirror.com`。

核对来源：

- https://huggingface.co/docs/huggingface_hub/guides/cli
- https://huggingface.co/docs/huggingface_hub/package_reference/cli#hf-download
- https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/constants.py
- https://www.electron.build/icons.html
- https://www.electron.build/nsis.html#portable

## 功能

- 模型、数据集、Space 下载
- 官方源、`hf-mirror.com`、自定义源切换
- `--local-dir`、`--cache-dir`、`--revision`、`--include`、`--exclude`
- Token、dry run、强制重下、并发数、超时、Xet 高性能模式
- CLI 检测、`huggingface_hub` 安装/更新、实时日志、停止任务
- 下载任务历史
- 常用仓库收藏
- 多任务下载队列
