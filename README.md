# pi-sync-webdav

[简体中文](README.zh-CN.md)

Manual, single-target synchronization for one Pi Coding Agent configuration directory through a Basic Auth WebDAV server.

## Requirements

- Pi Coding Agent
- A WebDAV endpoint that supports Basic Auth
- HTTPS, unless you explicitly accept the HTTP warning during configuration

## Install

```bash
pi install npm:pi-sync-webdav
```

To update:

```bash
pi update --extensions
```

## Commands

| Command                 | Purpose                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `/sync-webdav`          | Starts initial configuration when unconfigured, otherwise opens the dashboard. |
| `/sync-webdav settings` | Edits the WebDAV connection or push selection.                                 |
| `/sync-webdav status`   | Checks remote readability without changing configuration.                      |
| `/sync-webdav diff`     | Shows planned push changes.                                                    |
| `/sync-webdav push`     | Uploads the selected local configuration.                                      |
| `/sync-webdav pull`     | Downloads and applies remote configuration after confirmation.                 |
| `/sync-webdav restore`  | Restores the latest local backups created by a prior pull.                     |

`settings`, `push`, `pull`, and `restore` require an interactive Pi TUI. `status` and `diff` can run non-interactively.

## Configuration

Run `/sync-webdav` and follow the prompts to configure WebDAV and select the local paths to push. Use a dedicated remote path for this package.

After configuration, select **settings** in the dashboard or run `/sync-webdav settings`:

- **Connection** updates the URL, remote path, username, and password. The complete connection is verified before it is saved.
- **Push selection** updates only the local selection and does not contact WebDAV.

Changing a connection does not push or pull automatically. Choose `push` or `pull` yourself.

## What syncs

The default push selection is `settings.json`, `keybindings.json`, `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `models.json`, `themes/`, `prompts/`, `skills/`, and `extensions/`.

You can change the selection in **settings**. Directories are recursive. `sessions/` and `auth.json` are opt-in and require an additional confirmation. `logs/` and `node_modules/` are excluded at every depth. The selection affects push only; pull applies the remote configuration.

## Sync behavior

When changes are found, push and pull show a plan and require confirmation. Pull validates the complete download before changing local files and creates local backups for files it replaces or removes.

Package declarations in `settings.json` are applied after files. If a package operation fails, the pulled files remain and Pi asks you to resolve the package manually.

There is no remote history or remote restore operation.

## License

[MIT](LICENSE)

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.
