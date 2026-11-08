# Message Butler (`dsh-message-actions`)

**English** | [中文](README.md)

![version](https://img.shields.io/badge/version-0.2.8-blue)
![npm](https://img.shields.io/badge/npm-v0.2.4-orange)
![license](https://img.shields.io/badge/license-MIT-green)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blue)
[![GitHub repository](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/aijacko/dsh-message-actions)
![awesome](https://img.shields.io/badge/awesome-DSH%20plugin-red)

> **Compatibility**: built for the latest DSH (`0.2.2-rc.1`), tested on both desktop and web profiles.

**Make every turn in DSH controllable, shareable, and measurable.** The host has no recall, delete, or cost view; this plugin fills those gaps — message actions, share/export, session management, and usage billing all run locally, with conversation data never uploaded.

## Features

### Message actions

- **Recall**: hover a question row and click Recall — the whole exchange disappears, and the text plus images / files return to the composer for editing and resending.
- **Delete**: the question row deletes the whole exchange; the tool row deletes only that step's tool result, hiding the answer in the same step while leaving other steps untouched.
- **Delete to end**: remove everything from that message onward — handy for closing off a topic.
- Deletion is tombstone-style: it appends a marker without rewriting the history log, so deleted content does not come back after a refresh, a session switch, or a DSH restart.

### Share and export

- **Share as image**: multi-select turns in a full-screen picker and generate a long PNG locally; nothing is uploaded.
- **Export Markdown**: the same selection, exported as a `.md` with question / answer structure.
- A failed run keeps the picker and selection open for retry; buttons are disabled while a reply is being generated.

### Usage and cost

- **Per-reply usage and cost**: `tok · chars · ¥0.0023` under every answer; the amount sums only that reply's own usage, so multi-step turns are not billed twice.
- **Cost card**: balance / today / per-turn in the sidebar; the main figure is the account total (top-up + bonus, each wallet truncated to the cent). Local models show "Local · no billing".
- **Statistics**: the icon at the end of the cost row opens token totals, a 24 h / 30 d timeline, per-session cost, source diagnostics, and the third-party price table.
- **Budget**: edited inside the statistics panel (default `¥5`, `0` hides the ratio and shows only the estimate). It only computes the budget-used ratio and remaining allowance; it never bills you.
- **Peak / off-peak hint**: weekdays `09:00–12:00` and `14:00–18:00` are peak, everything else is off-peak (`0.5×`); peak is orange, off-peak is blue.
- **Model billing tiers**: DeepSeek official models use official prices; confirmed local / private endpoints are unbilled; third-party models use the price table, and unpriced tokens still count but add `0` to the cost.

### Session management

- **Entry**: the Message Butler item at the sidebar footer, or Settings → Message Butler → Session manager.
- **Delete to trash**: a soft delete that only writes a trash index and leaves the log in the original workspace. Single and bulk delete run immediately, **no `OK` required**.
- **Restore**: single / bulk restore takes effect right away, no restart, and the session returns to its original workspace group.
- **Archive / unarchive**: move sessions out of the regular list; archiving never moves chat logs.
- **Purge**: single / bulk purge and emptying the trash are irreversible and require typing `OK` (case-insensitive, surrounding spaces ignored).
- **Delete switch**: turn off **Delete session** at the top of Settings → Message Butler → Session manager. Entries disappear and the host rejects delete / purge requests (`SESSIONS_DELETE_DISABLED`); restore, archive, and listing are unaffected.

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

Published version `0.2.4`; current source version `0.2.8` (not published).

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

## Usage notes

1. Hover a question row for Recall / Share / Export / Delete / Delete to end; hover a tool row to delete that step's tool result.
2. The stats line under each answer shows that reply's own tokens, characters, and estimated cost; the whole-turn total is in the sidebar's **Turn** figure.
3. In the share / export picker `Enter` runs the primary action; in a confirmation dialog `Enter` confirms and `Esc` cancels. Enter is ignored while focus is in a text field.
4. The trash lives at `~/.dsh/dsh-message-actions-trash` (same name under `$DSH_HOME`). Restore is instant; purge cannot be undone.
5. Delete markers are written into session event logs; deleting a session directory by hand removes the markers with it.
6. The plugin opens no extra port and only accepts same-origin local requests; conversation data is never sent to an external service.
7. Restart DSH fully after upgrading or changing host-side code; for client-only changes that already loaded, disable and re-enable the plugin or refresh the page.

## Feedback

- Issues and suggestions: [GitHub Issues](https://github.com/aijacko/dsh-message-actions/issues)
- License: [MIT](LICENSE)
