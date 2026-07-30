# pi-sync-webdav

[English](README.md)

通过 Basic Auth WebDAV 手动同步单个 Pi Coding Agent 配置目录的 Pi Package。仅支持单目标手动同步；不执行自动后台同步，也不保留远端历史。

## 要求

- Pi Coding Agent
- 支持 Basic Auth 的 WebDAV 服务
- HTTPS；只有在 setup 中明确接受 HTTP 警告后才可使用 HTTP

## 安装

可全局安装：

```bash
pi install npm:pi-sync-webdav
```

使用 Pi 的包更新命令安装最新已发布版本：

```bash
pi update --extensions
```

Pi Package 会以你的用户权限运行。安装不受信任发布者的包前，应先审查源码。

## 命令

| 命令                   | 用途                                           |
| ---------------------- | ---------------------------------------------- |
| `/sync-webdav`         | 未配置时进入 setup；已配置时打开仪表盘。       |
| `/sync-webdav setup`   | 配置 WebDAV 连接和 push 选择范围。             |
| `/sync-webdav status`  | 检查远端可读性，不修改本地或远端状态。         |
| `/sync-webdav diff`    | 显示计划中的 push 变更，不修改本地或远端状态。 |
| `/sync-webdav push`    | 上传选定的本地配置。                           |
| `/sync-webdav pull`    | 确认后下载并应用远端配置。                     |
| `/sync-webdav restore` | 恢复先前 pull 创建的最新本地备份。             |

`setup`、`push`、`pull` 和 `restore` 必须在交互式 Pi TUI 中执行。只有 `status` 和 `diff` 可以在非交互模式中使用。

## 设置

执行：

```text
/sync-webdav setup
```

向导会依次询问：

1. WebDAV URL
2. 插件专用远端路径
3. Basic Auth 用户名
4. Basic Auth 密码
5. 本地 push 选择范围

请为本包使用专用远端路径。若远端根目录非空但没有 `manifest.json`，setup 会拒绝使用它，而不会修改无关内容。

Setup 会验证目录访问和全部必需写入操作。若连接可读但无法创建、上传、读取和删除探测资源，连接会保存为只读：`status`、`diff` 和 `pull` 仍可使用，`push` 则被禁用。

## 同步内容

默认 push 选择范围包括：

- `settings.json`
- `keybindings.json`
- `AGENTS.md`
- `SYSTEM.md`
- `APPEND_SYSTEM.md`
- `models.json`
- `themes/`
- `prompts/`
- `skills/`
- `extensions/`

Setup 选择器可以加入其他安全的顶层文件和目录；目录会递归同步。`npm/`、`git/` 和本包的私有状态始终排除。`sessions/` 和 `auth.json` 默认不选中，且需要额外确认。平台支持时，恢复 `auth.json` 后会设置为仅所有者可读写权限。

Push 前会在本地检查文本文件中的常见秘密模式。界面只报告受影响的路径，绝不显示检测到的内容。

## 同步行为

### Push

Push 会上传完整的远端快照，并仅在上传完成后激活它。若激活前远端发生变更，请重新执行 push。

### Pull

在一次整批确认后，pull 会先验证完整下载，再修改本地文件；覆盖或安全删除的文件会先备份。

首次 pull 不会仅因远端缺失而删除本地文件。删除只针对由同一配置连接先前管理过的路径。

### Pi 包

文件应用完成后，会协调 `settings.json` 中的 package 声明：新增包会安装，删除包会卸载，npm 或 Git source 变更时会重新安装。不会同步 Pi 的 `npm/` 和 `git/` 缓存。失败的包操作会在之后的 pull 中重试，且不会撤销已拉取的文件。

## 安全模型

- WebDAV URL 不允许内嵌凭证、查询参数或片段。
- 密码、Authorization 请求头、文件内容和秘密扫描命中内容不会出现在 UI 消息或错误文本中。
- 远端和本地路径会在 I/O 前校验。符号链接和不安全文件类型不会被同步。
- 私有配置、凭证、备份和 pull 工作区都位于有效 Pi agent 目录下的 `pi-sync-webdav/`，且永远不会被同步。
- Pull 和 restore 只使用本地备份；不提供远端 restore 或远端历史。
- 在 pull 下载期间按 Esc 可以取消操作，并会在可能时清理临时工作区。

## 开发

开发需要 Node.js 22.19 或更高版本，以及 npm。

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run pack:check
```

贡献规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
