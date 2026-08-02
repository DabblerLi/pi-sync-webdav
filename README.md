<h1 align="center">pi-sync-webdav</h1>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-sync-webdav"><img alt="npm version" src="https://img.shields.io/npm/v/pi-sync-webdav?logo=npm" /></a>
  <img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D22.19.0-339933?logo=node.js&amp;logoColor=white" />
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

A Pi Coding Agent extension that syncs one configuration directory to and from a WebDAV server using Basic Auth.

## Requirements

- Pi Coding Agent
- A WebDAV server that supports Basic Auth
- HTTPS (HTTP is allowed only after you accept the cleartext warning during setup)

## Install

```bash
pi install npm:pi-sync-webdav
```

Update with:

```bash
pi update --extensions
```

## Quick start

1. Create an empty, dedicated WebDAV folder for pi-sync-webdav. Do not put other files in it; the extension manages its own sync data there.
2. Run `/sync-webdav` and enter the WebDAV URL, the folder path, your username, and password. Setup will test read and write access to this folder before saving.
3. Choose which local paths to push.
4. Run `push` on the machine you want to sync from and `pull` on the machine you want to sync to. Each changing action asks for confirmation first.

## Commands

| Command                 | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `/sync-webdav`          | Opens setup when unconfigured, otherwise the dashboard.                         |
| `/sync-webdav settings` | Edits the WebDAV connection or the local push selection.                        |
| `/sync-webdav status`   | Checks that the remote folder is reachable and readable, and reports sync data. |
| `/sync-webdav diff`     | Previews the file changes the next push would make. Changes nothing.            |
| `/sync-webdav push`     | Uploads the selected local configuration.                                       |
| `/sync-webdav pull`     | Downloads and applies the remote configuration after confirmation.              |
| `/sync-webdav restore`  | Reapplies the most recent local backups created by a prior pull.                |
| `/sync-webdav cleanup`  | Removes verified remote residue left by a failed or interrupted operation.      |

`status` and `diff` are read-only and can run non-interactively. Other commands require an interactive Pi TUI.

## What syncs

Default push selection: `settings.json`, `keybindings.json`, `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `models.json`, `themes/`, `prompts/`, `skills/`, `extensions/`.

Change the selection under **settings**. Directories sync recursively. The selection only affects `push`; `pull` always applies the full remote file set.

The top-level `npm/`, `git/`, and `pi-sync-webdav/` directories are never synced. `logs/` and `node_modules/` are ignored wherever they appear.

`sessions/` and `auth.json` are off by default. Adding one to the selection asks for an extra confirmation. Only sync sensitive data to a remote you trust.

## How sync works

- **push** publishes your currently selected local files to the dedicated remote folder. After the first push, unchanged files are reused on the server and only changed files are uploaded.
- **pull** applies the remote file set, even if your local push selection is different. Only added or updated files are downloaded. Review the planned additions, updates, and removals before confirming.
- **restore** reapplies those local file backups after confirmation. It does not restore a remote version and does not reinstall Pi packages.
- Before pull replaces or removes managed local files, it backs them up under `pi-sync-webdav/backups/` in the Pi agent directory. Only the latest changed pull is kept; restore leaves the backup in place.

## Remote access and safety

- HTTPS is required by default. HTTP needs an explicit warning confirmation. Self-signed or invalid TLS certificates are rejected.
- If the remote folder can be read but not written, the connection is saved as read-only. You can still use `status`, `diff`, and `pull`; `push` and residue cleanup are unavailable.
- Saving a connection only tests access—it never starts a push or pull.
- Long-running actions show progress and can be cancelled with Esc.
- If an operation reports remote residue, run `/sync-webdav cleanup` to remove it.

## Pi packages

When pull detects changes to the package list, it shows any installs, updates, or removals alongside the file changes and applies them after confirmation. Package install code runs with your user permissions, so only pull from a remote you trust.

If a package operation fails or is cancelled after files were pulled, the pulled files stay and you must resolve the package change manually.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project is licensed under the [MIT License](LICENSE).

## Acknowledgements

Thanks to the [LINUX DO](https://linux.do/) community.
