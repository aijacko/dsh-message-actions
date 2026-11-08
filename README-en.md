# Message Butler (`dsh-message-actions`)

**English** | [中文](README.md)

![version](https://img.shields.io/badge/version-0.2.14-blue)
![npm](https://img.shields.io/badge/npm-v0.2.4-orange)
![license](https://img.shields.io/badge/license-MIT-green)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blue)
[![GitHub repository](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/aijacko/dsh-message-actions)
![awesome](https://img.shields.io/badge/awesome-DSH%20plugin-red)

> **Compatibility**: built for the latest DSH (`0.2.2-rc.1`), tested on both desktop and web profiles.

**Make every turn in DSH controllable, shareable, and measurable.** Adds the recall, delete, share, export, and cost views the host lacks — with conversation data staying on your machine.

## Compatibility notes

- Built for the latest DSH `0.2.2-rc.1`; desktop and web profiles both tested.
- No runtime third-party dependencies. No extra port; endpoints accept same-origin requests from this machine only.
- After upgrading, fully quit and restart DSH — a page refresh does not load the new client code.

## Features

| Feature | What it does |
|---|---|
| Recall | Remove a whole exchange from the question row; text and attachments return to the composer |
| Delete | Question row deletes the turn; tool row deletes that step only |
| Delete to end | Clear everything from that message onward |
| Share as image | Multi-select turns and generate a long PNG locally, never uploaded |
| Export Markdown | Multi-select turns and export a `.md` with question / answer structure |
| Reply stats | `tok · chars · cost` under every answer |
| Cost card | Balance / today / per-turn in the sidebar, with peak and off-peak hints |
| Statistics | Tokens, timeline, per-session cost and budget usage from local session logs |
| Session management | Search, group by workspace, delete to trash, restore, and archive |
| Trash | Deleted sessions go to `~/.dsh/dsh-message-actions-trash`; restore is instant, purge needs `OK` |
| Toggleable | Recall / share / export / delete / stats / cost can each be turned off in settings |
| Bilingual | Follows the DSH language automatically |

## Installation

Marketplace: Plugins → Plugin marketplace → search `dsh-message-actions` → Install.

By package name: Plugins → + Add plugin → enter `dsh-message-actions`; choose the Mainland China mirror if the default registry is slow.

npm:

```bash
npm install dsh-message-actions
```

Local build:

```bash
node build.mjs
pnpm add "file:/path/to/dsh-message-actions"
```

- Published version: `0.2.4`; current source version: `0.2.14` (not published).
- `file:` installs copy the package; uninstall and reinstall after code changes.
- Add the package name to `dsh.profile.bundles` in the profile `package.json`; do not add a duplicate `insert` in `cordis.patch.yml`.

## Usage

1. Hover a question row: Recall / Share / Export / Delete / Delete to end.
2. Hover a tool row: delete that step's tool result; the answer in the same step is hidden too.
3. The stats line under each answer shows tokens, characters, and that reply's own estimated cost.
4. Deletion is tombstone-style: the history log is never rewritten, and deleted content does not come back after refresh, session switch, or restart.
5. Settings → Plugins → Message Butler: turn individual features off, adjust confirmation and sound.
6. Settings → Session manager can turn off **Delete session**; entries disappear and the host rejects delete and purge requests.
7. Trash: single / bulk restore is instant; purge and empty trash require typing `OK`.

## Feedback

- Issues and suggestions: [GitHub Issues](https://github.com/aijacko/dsh-message-actions/issues)
- License: [MIT](LICENSE)
