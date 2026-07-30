# pi-sync-webdav

[English](README.md)

通过 Basic Auth WebDAV 手动同步单个 Pi Coding Agent 配置目录的 Pi Package。

## 要求

- Pi Coding Agent
- 支持 Basic Auth 的 WebDAV 服务
- HTTPS；只有在配置时明确接受 HTTP 警告后才可使用 HTTP

## 安装

```bash
pi install npm:pi-sync-webdav
```

更新包：

```bash
pi update --extensions
```

## 命令

| 命令                    | 用途                                     |
| ----------------------- | ---------------------------------------- |
| `/sync-webdav`          | 未配置时进入初始化；已配置时打开仪表盘。 |
| `/sync-webdav settings` | 修改 WebDAV 连接或 push 选择范围。       |
| `/sync-webdav status`   | 检查远端可读性，不修改配置。             |
| `/sync-webdav diff`     | 显示计划中的 push 变更。                 |
| `/sync-webdav push`     | 上传选定的本地配置。                     |
| `/sync-webdav pull`     | 确认后下载并应用远端配置。               |
| `/sync-webdav restore`  | 恢复先前 pull 创建的最新本地备份。       |

`settings`、`push`、`pull` 和 `restore` 必须在交互式 Pi TUI 中执行；`status` 和 `diff` 可以在非交互模式中执行。

## 配置

执行 `/sync-webdav`，按提示配置 WebDAV 并选择要 push 的本地路径。请为本包使用专用远端路径。

完成配置后，可从仪表盘选择 **settings**，或执行 `/sync-webdav settings`：

- **Connection**：修改 URL、远端路径、用户名和密码。保存前会检查完整连接的读取权限和写入能力。可读取但不可写入的目标会保存为只读模式。
- **Push selection**：只修改本地选择范围，不会连接 WebDAV，保存前还会显示最终复核。

修改连接不会自动 push 或 pull；请自行选择 `push` 或 `pull`。

## 同步内容

默认 push 选择范围包括 `settings.json`、`keybindings.json`、`AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`、`models.json`、`themes/`、`prompts/`、`skills/` 和 `extensions/`。

可在 **settings** 中修改选择范围。目录会递归同步。`sessions/` 和 `auth.json` 默认不选中，且需要额外确认。任意层级的 `logs/` 和 `node_modules/` 都会排除。选择范围只影响 push；pull 会应用远端配置。

## 同步行为

发现变更时，push 和 pull 会显示计划并要求确认。Pull 会在修改本地文件前验证完整下载，并为被覆盖或删除的文件创建本地备份。

耗时的交互式操作会显示进度。按 Esc 可请求取消。

可写连接的仪表盘提供 **Clean remote residue**。该操作只会删除已识别的过期同步数据；无法识别的远端项会保留。

文件应用后，会处理 `settings.json` 中的 package 声明。若包操作失败，或取消请求中断这一步，已拉取文件会保留，Pi 会提示你手动处理该包。

不保留远端历史，也不提供远端 restore 操作。

## 许可证

[MIT](LICENSE)

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
