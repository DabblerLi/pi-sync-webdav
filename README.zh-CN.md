# pi-sync-webdav

[English](README.md)

为 Pi Coding Agent 提供通过 Basic Auth WebDAV 同步单个配置目录的扩展。

同步全部由你手动发起，每次只执行一个方向。没有后台同步、没有多目标路由，也没有可恢复的远端历史。

## 环境要求

- Pi Coding Agent
- 支持 Basic Auth 的 WebDAV 服务
- HTTPS（只有在配置时接受明文警告后才能使用 HTTP）

## 安装

```bash
pi install npm:pi-sync-webdav
```

更新：

```bash
pi update --extensions
```

## 快速开始

1. 为 pi-sync-webdav 新建一个空的专用 WebDAV 文件夹。不要在里面放其他文件，扩展会在其中管理自己的同步数据。
2. 执行 `/sync-webdav`，输入 WebDAV URL、文件夹路径、用户名和密码。保存前会测试对该文件夹的读写访问。
3. 选择要 push 的本地路径。
4. 在源机器执行 `push`，在目标机器执行 `pull`。每个会修改数据的操作都会先要求确认。

## 命令

| 命令                    | 作用                                               |
| ----------------------- | -------------------------------------------------- |
| `/sync-webdav`          | 未配置时进入初始化；已配置时打开仪表盘。           |
| `/sync-webdav settings` | 修改 WebDAV 连接或本地 push 选择范围。             |
| `/sync-webdav status`   | 检查远端文件夹是否可达、可读，并报告同步数据情况。 |
| `/sync-webdav diff`     | 预览下次 push 会产生的文件变更，不修改任何内容。   |
| `/sync-webdav push`     | 上传选定的本地配置。                               |
| `/sync-webdav pull`     | 确认后下载并应用远端配置。                         |
| `/sync-webdav restore`  | 恢复先前 pull 产生的最新本地备份。                 |

`status` 和 `diff` 是只读的，可在非交互模式运行。`settings`、`push`、`pull` 和 `restore` 需要交互式 Pi TUI。

## 同步内容

默认 push 选择范围：`settings.json`、`keybindings.json`、`AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`、`models.json`、`themes/`、`prompts/`、`skills/`、`extensions/`。

可在 **settings** 中修改选择范围，目录递归同步。选择范围只影响 `push`；`pull` 始终应用完整的远端文件集。

永远不会同步：`npm/`、`git/`、`pi-sync-webdav/`、`logs/`、`node_modules/`。

`sessions/` 和 `auth.json` 默认不选中。首次将它们加入选择范围时需要额外确认，之后保持已批准状态。请把你选中的所有内容——尤其是 `auth.json`——当作敏感数据，只同步到你信任的远端。

## 变更如何流转

- **push** 把你当前选中的本地文件发布到专用远端文件夹。
- **pull** 应用远端文件集，即使你本地的 push 选择范围不同。确认前请审阅计划的新增、更新和删除。
- pull 在覆盖或删除受管本地文件前，会为该文件保留一份本地备份。
- **restore** 在确认后重新应用这些本地文件备份。它不会恢复远端版本，也不会重新安装 Pi 扩展包。
- 备份位于 Pi agent 目录下的 `pi-sync-webdav/backups/`，按文件原相对路径存放。备份保存的是最近一次 pull 中被覆盖或删除的文件：下一次产生本地变更的 pull 会整体替换这批备份，restore 也不会删除备份。如需清除，删除该文件夹或其中的单个文件即可。
- 这不是远端备份历史服务：没有远端恢复命令。

## 远端访问与安全

- 默认要求 HTTPS。使用 HTTP 需要明确接受警告。自签名或无效 TLS 证书会被拒绝。
- 如果远端文件夹可读但不可写，连接会保存为只读模式。你仍可使用 `status`、`diff` 和 `pull`；`push` 和残留清理不可用。
- 保存连接只会测试访问，不会自动开始 push 或 pull。
- 耗时操作会显示进度，可按 Esc 取消。
- 对于可写连接，仪表盘提供 **Clean remote residue**，用于清理因失败或取消而留下的旧同步数据。

## Pi 扩展包

`settings.json` 可以声明 Pi 扩展包（即你用 `pi install` 安装的扩展）。pull 时，这些声明会转换为安装、更新或移除操作，与文件变更一起列出供你确认。扩展包的安装代码会以你的用户权限运行，因此只从信任的远端 pull。

如果文件已 pull 但扩展包操作失败或被取消，已拉取的文件会保留，你需要手动处理扩展包变更。

## 许可证

[MIT](LICENSE)。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
