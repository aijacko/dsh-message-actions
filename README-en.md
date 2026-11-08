# Message Butler (`dsh-message-actions`)

**English** | [中文](README.md)

![version](https://img.shields.io/badge/version-0.2.8-blue)
![npm](https://img.shields.io/badge/npm-v0.2.8-orange)
![license](https://img.shields.io/badge/license-MIT-green)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blue)
[![GitHub repository](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/aijacko/dsh-message-actions)
![awesome](https://img.shields.io/badge/awesome-DSH%20plugin-red)

> **Compatibility**: built for the latest DSH (`0.2.2-rc.1`), tested on both desktop and web profiles.

**Features: recall, delete, and delete-to-end; multi-select share and export; session deletion, trash, restore, and batch actions; usage billing with balance and cost views; a completion sound when a reply finishes.** The host has no recall, delete, or cost view; this plugin fills those gaps — message actions, share/export, session management, and usage billing all run locally, with conversation data never uploaded.

## Features

### Message actions

- **Recall**: hover a question row and click Recall — the whole exchange disappears, and the text plus images / files return to the composer for editing and resending. Running sessions cannot be recalled.
- **Delete**: the question row deletes the whole exchange; the tool row deletes only that step's tool result, hiding the answer in the same step while leaving other steps untouched.
- **Delete to end**: remove everything from that message onward — handy for closing off a topic.
- Deletion is tombstone-style: it appends a marker without rewriting the history log, so deleted content does not come back after a refresh, a session switch, or a DSH restart.

### Share and export

- **Selecting turns**: hover any question row and click Share or Export to open the full-screen picker; click a turn card to select or deselect it, or use Select all.
- **Share as image**: renders a 720 px wide long PNG locally with nothing uploaded. Content taller than 12000 px is rejected with a hint, so split it into batches.
- **Export Markdown**: a `.md` with `# title`, `## Q N`, and `### A` structure, named `dsh-{sessionId}-{YYYYMMDD-HHmm}.md`.
- A failed run keeps the picker and selection open for retry; buttons are disabled while a reply is being generated.

### Usage and cost

- **Per-reply usage and cost**: `tok · chars · ¥0.0023` under every answer; the amount sums only that reply's own usage, so multi-step turns are not billed twice.
- **Where the numbers live**: the per-reply amount sits under the answer, the turn total is the sidebar's "Turn" figure, and balance / today / turn are on the cost card; session and time breakdowns are in the statistics panel.
- **Cost card**: the main figure is the account total (top-up + bonus, each wallet truncated to the cent); hover for the split. Local models show "Local · no billing".
- **Statistics**: the icon at the end of the cost row opens token totals, a 24 h / 30 d timeline, per-session cost, source diagnostics, and the third-party price table.
- **Budget**: edited inside the statistics panel (default `¥5`; `0` shows only the estimate). It only computes the used ratio and remaining allowance, never blocks a turn; when exceeded it shows "Over budget" with the real, uncapped percentage.
- **Peak / off-peak hint**: weekdays `09:00–12:00` and `14:00–18:00` are peak, everything else is off-peak (`0.5×`); peak is orange, off-peak is blue.

### Session management

- **Entry**: the Message Butler item at the sidebar footer, or Settings → Message Butler → Session manager.
- **Delete to trash**: a soft delete that only writes a trash index and leaves the log in the original workspace. Single and bulk delete run immediately, **no `OK` required**.
- **Restore**: single / bulk restore takes effect right away, no restart, and the session returns to its original workspace group.
- **Archive / unarchive**: move sessions out of the regular list; archiving never moves chat logs.
- **Purge**: single / bulk purge and emptying the trash are irreversible and require typing `OK` (case-insensitive, surrounding spaces ignored).
- **How long trashed items stay**: there is no TTL or auto-expiry. Entries remain until you purge them or empty the trash; a soft-deleted log still occupies disk space.
- **Delete switch**: turn off **Delete session** at the top of Settings → Message Butler → Session manager. This hides the delete item in the question menu, bulk delete, and the trash's purge / empty buttons; the host also rejects delete / purge requests (`SESSIONS_DELETE_DISABLED`). Restore, archive, and listing keep working.

### Sound and volume

- The completion sound is synthesized in the client: no network, no audio files, and it plays once per turn.
- Tones: default double / bell / soft / off; volume `0–100` (default `50` is the reference level, `0` is silent).

## Installation

### Option 1: Plugin marketplace (recommended)

1. Plugins → **Plugin marketplace** tab → search `dsh-message-actions`.
2. Click **Install** on the card; once installed the card shows the **Installed** badge.

### Option 2: Local install

```bash
git clone <repository-url> dsh-message-actions
cd dsh-message-actions
node build.mjs          # generates lib/
pnpm add "file:/path/to/dsh-message-actions"
```

- A `file:` install **copies** the package; uninstall and reinstall after code changes. `lib/` is generated — do not edit it by hand.
- Add the package name to `dsh.profile.bundles` in the profile `package.json`; do **not** add another `insert` in `cordis.patch.yml`, or settings may fail to save.
- After upgrading, **fully quit and restart DSH** (including tray / background processes); a page refresh does not load the new client code.

Published version `0.2.8`.

## Configuration

Settings → Plugins → Message Butler. Changes save and take effect immediately.

| Setting | What it does | Default |
|---|---|---|
| Recall `recall` | Show Recall on question rows | On |
| Share `share` | Show Share on question rows | On |
| Export `export` | Show Export on question rows | On |
| Delete `delete` | Question row deletes the turn; tool row deletes that step | On |
| Delete to end `deleteFrom` | Show Delete to end on question rows | On |
| Confirm actions `confirm` | Ask before recall / delete | On |
| Reply statistics `stats` | Show tokens, characters, and cost under answers | On |
| Cost statistics `usageStats` | Show balance / today / per-turn in the sidebar; off stops fetching and recording | On |
| Cost layout `costLayout` | `compact` single-line / `default` multi-line | `compact` |
| Per-turn cost `costPerTurn` | Show the turn cost after each turn | On |
| Auto close `costPerTurnAutoClose` | Seconds before the turn cost group hides; `0` = always visible | `0` |
| Peak / off-peak row `costPeakValley` | Show the current period and next switch time | On |
| Sound tone `soundTone` | `double` / `bell` / `soft` / `off` | `double` |
| Volume `soundVolume` | Completion-sound volume, `0–100` | `50` |
| Delete session `sessionsDelete` | Master switch for delete / purge in session management | On |
| Completion sound `sound` | Legacy compatibility field; `false` equals muted | On |

## Billing rules

### What is not billed

- **Overrides first**: mark a provider `local` in Statistics → Billing rules to make that source free; `always` forces billing.
- **Automatic local detection**: `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `*.local`, and container / host aliases such as `host.docker.internal` count as local unless they look like an official domain.
- **Official sources**: a DeepSeek provider name or official domain is billed at official prices, including peak / off-peak.
- **Unconfirmed sources**: billed as third-party and marked "source unconfirmed" — never silently treated as local.

### Third-party gateways and overrides

Statistics → Billing rules edits `overrides` (provider → `local` / `always`), `prices` (the price table), and recalculates history after saving. The gateway base URL is probed by the host and shown under "Source diagnostics"; no manual URL entry is needed.

### Price table priority

Third-party prices resolve in this order: **exact model name → longest model prefix → provider → global fallback**. If nothing matches, the UI shows "not configured", tokens are still counted, and cost stays `0` — official prices are never applied automatically.

## Data and permissions

- **State file**: `$DSH_HOME/plugins/dsh-message-actions/cost-state.json` (directory `0700`, file `0600`) holds the budget, third-party price table, spending records, and balance baseline.
- **Trash**: `$DSH_HOME/dsh-message-actions-trash/trash-*/meta.json` (`0600`) plus the `purged.json` tombstone list; the session logs themselves stay in the original workspace.
- **Delete markers**: recall / delete / delete-to-end append events to the matching `session.v*.jsonl`; history text is never rewritten.
- **Uploads**: the plugin sends no conversations, attachments, or statistics anywhere. Share images and Markdown are generated locally. Endpoints only accept same-origin local requests and open no extra port.
- **Credentials**: no API keys, tokens, or cookies are stored; balance and usage come from the host's existing session.
- **Backup**: back up the `plugins/dsh-message-actions/` and `dsh-message-actions-trash/` directories; session logs are backed up with the DSH session directory.
- **Clean removal**: empty the trash first (to avoid leftover tombstones), then disable and remove the plugin; delete `plugins/dsh-message-actions/` to clear statistics. Delete markers already written into session logs stay with the logs and do not restore hidden content on uninstall.

## Usage notes

1. Hover a question row for Recall / Share / Export / Delete / Delete to end; hover a tool row to delete that step's tool result.
2. The stats line under each answer shows that reply's own tokens, characters, and estimated cost; the whole-turn total is in the sidebar's **Turn** figure.
3. In the share / export picker `Enter` runs the primary action; in a confirmation dialog `Enter` confirms and `Esc` cancels. Enter is ignored while focus is in a text field.
4. Trash restore is instant; purge is irreversible and also removes the session from the workspace index.
5. Delete markers are written into session event logs; deleting a session directory by hand removes the markers with it.
6. Restart DSH fully after upgrading or changing host-side code; for client-only changes that already loaded, disable and re-enable the plugin or refresh the page.

## FAQ

- **No entry appears after installing**: confirm the plugin is enabled, the profile's `dsh.profile.bundles` contains the package name, then fully quit and restart DSH; if it is still missing, check the developer console for load errors.
- **No completion sound**: make sure the tone is not Off, volume is above `0`, and neither the OS nor the browser is muted; a legacy `sound=false` also mutes it. Browsers require a prior page interaction before playing audio.
- **Cost shows "not configured"**: the third-party model did not match the price table. Add a price by model / prefix / provider / fallback under Statistics → Billing rules; for official or local sources, check the baseURL and overrides under Source diagnostics.
- **Balance does not add up**: the balance is a snapshot of the account total, "today" observes drops in that total, and "turn" is converted from list prices — different bases, so they need not match turn by turn. Top-ups / refunds only move the baseline without reducing recorded spend, and cross-day or long gaps do not backfill the difference.
- **Delete is rejected**: `SESSIONS_DELETE_DISABLED` means the Delete session switch is off; `SESSION_RUNNING` means the reply is still generating; `TRASH_UNAVAILABLE` usually means an old host or a disabled plugin; non-local requests get 403.
- **Disk usage did not drop after deleting**: delete-to-trash is a soft delete and the log stays in the workspace; only purge or empty trash frees the space.

## Feedback

- Issues and suggestions: [GitHub Issues](https://github.com/aijacko/dsh-message-actions/issues)
- License: [MIT](LICENSE)
