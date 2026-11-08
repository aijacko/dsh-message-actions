# Message Butler (`dsh-message-actions`)

English · [中文](README.cn.md)

## Overview

**Make every turn in DSH controllable, shareable, and measurable.**

DSH has no recall or delete built in: send a message by mistake and your only option is to start a new session; share a conversation and you end up copying, pasting, and re-formatting by hand. Some plugins are overloaded with features or vague about where conversation data ends up, so I wrote my own: the features I needed, and data I don't need to touch stays untouched.

- Sent the wrong message: hover over a question row, click "Recall", the whole turn disappears and the text returns to the composer; edit and resend.
- Cleaning up a tangent: "Delete" on the question row removes the whole turn; to drop just one step's tool call, click the trash icon on that tool row.
- Sharing with a colleague: select the turns you want, export Markdown or generate a long PNG, all locally, nothing uploaded.
- Wondering what the last turn cost: the sidebar shows balance / today / per-turn cost (shown as "Bal / Today / Turn" on the card); local models collapse to "Local · no billing".

Features you don't use can be turned off in settings. Turn off cost statistics, for example, and the plugin stops fetching balances and recording spend, and stops rendering the sidebar card. The delete, share, and export switches work the same way: turn them off and their entries and actions disappear. It adds no persistent panel, no update prompts, and no system notifications, and it never rewrites your question. Share and export open a temporary full-screen picker, and recall / delete show a confirmation dialog according to your settings — all normal interactions.

---

## Features

| Feature | What it does |
|---|---|
| **Recall** | One click removes the whole exchange from the session and restores the original text plus image / file attachments to the composer, ready to resend |
| **Delete** | Question row deletes the whole exchange; tool row deletes that step (the answer and other tool results in the same step are hidden too, other steps are unaffected) |
| **Delete to end** | Removes everything from this message to the end, for closing off a topic |
| **Share as image** | Pick the turns you want in a full-screen overlay and generate a long PNG, generated locally, never uploaded |
| **Export Markdown** | Same selection, exports a `.md` with question / answer structure per turn |
| **Reply statistics** | `tok · chars · ¥0.0023` under every answer — its size and this reply's own estimated cost at a glance |
| **Confirmation dialog** | Recall / delete / delete-to-end share one compact dialog: 420px on wide screens, edge-to-edge on narrow screens, with the button row always fitting |
| **Rail sync** | After deletion, the matching sidebar ticks hide and the gaps close, leaving no ghost entries |
| **Cost card** | Balance / today / per-turn cost at a glance, with single-line and multi-line billing styles |
| **Statistics** | Small icon at the end of the cost row opens a panel with token totals, a 24 h / 30 d timeline, per-session cost and budget usage, built from real local session logs |
| **Peak / off-peak hint** | Peak in orange, off-peak in blue, showing whether now is expensive and when it switches |
| **Balance scope** | The main figure is the account's **total available balance** (top-up + bonus), each wallet truncated to the cent; bonus is merged into the main figure and broken out in the hover tooltip only, with no manual adjustment layer |
| **Bilingual UI** | Follows the DSH language; interface and tooltips switch automatically |
| **Session management** | Sidebar footer entry: search sessions, group by workspace, delete to trash, restore, move to another workspace |
| **Trash bin** | Deleted sessions move to `~/.dsh/dsh-message-actions-trash`; restore one, purge one, or empty all with an `OK` confirmation |
| **Overlay keyboard** | In the share / export overlay, `Enter` runs the primary action (Share image / Export); in a confirmation dialog it confirms, and `Esc` cancels. Enter is ignored while focus is in a text field, and when the primary action is disabled or busy |

Deletion uses **tombstone-style surface replacement**: it only appends a marker and hides the original span; it never rewrites the history log and doesn't affect other sessions. The marker is persisted in the session event log, so deleted content stays hidden after a page refresh, after switching to another conversation and back, and after restarting DSH. `/messages` and `full=1` both recompute the visible set from those markers instead of trusting the host surface alone.

---

## Session management

Open the panel from the **Message Butler** entry at the sidebar footer (same area as the cost card) or Settings → Message Butler → **Session manager**:

- **Delete a session**: uses a soft trash — it only writes a trash index entry and leaves the log in the original workspace, never moving files or detaching workspace membership. Only sessions that are actively replying are refused — sessions that are merely open (live) are allowed. A single delete needs only one confirmation click; only bulk delete, bulk permanent delete, and emptying the trash in Settings require typing `OK` (case-insensitive, surrounding spaces ignored). Pressing `Enter` after typing acts as the confirm button, and IME composition Enter does not submit. On success the row is hidden immediately in both this page and the host sidebar, and never falls into the "Ungrouped" bucket.
- **Multi-select and batch actions**: every row has a checkbox with select all / clear; batch delete, batch move (one target workspace) and batch archive. Results are summarized per item; successful items are never rolled back, and failed items stay selected for retry.
- **Trash**: single/bulk restore, single/bulk permanent delete, select all / clear. A soft-trash restore only removes the index entry, so the session **returns to its original workspace group immediately without a restart**. Bulk permanent delete requires `OK`; successful items are removed immediately and failed items stay selected. Emptying the whole trash also requires `OK`. The trash lives at `~/.dsh/dsh-message-actions-trash` (directory `0700`, metadata `0600`).
- **Move to another workspace**: moves the original log directory and only rewrites the zstd first frame (header), splicing every later event frame byte-for-byte. Host logs are multi-frame; the old "decompress and recompress the whole file" dropped every event after frame 0. Frame-level relocation now asserts the event count is unchanged before committing. The header is rebuilt against the host v4 whitelist and regains the `type: "session"` field that older versions dropped — without it the host treats the log as corrupt and opening fails with `session/not-found`. The target directory comes from host `locate`, so it matches the same encoding used by startup scan and open. It no longer calls `sessionPersistence.create`, so an open (live) session can move; a held write handle just skips the write claim. After moving: detach from the source workspace → redirect the live object and `persistence.states` `cwd` → attach to the target (`sessionPaths` stores the workspace path) → refresh the host index → verify via host `stat`. On failure the client shows the real error code (e.g. `TARGET_EXISTS`, `WORKSPACE_MISSING`, `LOG_VERIFY_FAILED`) and the original message.
- **Freshness**: trash delete and restore take effect immediately; a move refreshes the registry index, so the session opens in the target workspace and can be moved back, usually with no restart. Only a rejected attach or an unredirectable live state asks for a restart.

Known limits: the target workspace directory must exist; a move only recompresses frame 0, so even huge logs are fast; repeated round-trips never duplicate rows or leave "Ungrouped" residue; the trash is managed by this plugin only and is not part of DSH's own session cleanup. If an older build already dropped a log's events (only the header remains), repair can make the session openable again but cannot restore its content.

---

## Cost card

**Single-line** (default, no background, one row aligned left):

```
▲ Bal ¥6.00    Today ¥0.08    Turn ¥0.02
```

**Multi-line** (with a background card and a peak / off-peak text row):

```
Bal ¥6.00    Today ¥0.08    Turn ¥0.02
▲ Off-peak · peak at 9:00 tomorrow
```

New installations default to **single-line**; users who have already saved a preference keep their choice and are not reset by the new default.

- Peak = warm orange, off-peak = cool blue; 14px SVG status icons, readable at a glance on the left.
- When the sidebar collapses, the card degrades to a coin icon; hover to see the balance.
- Local models (localhost / 127.0.0.1 / private subnets / `.local`) collapse to "Local · no billing"; third-party gateways show as separately billed and do not poll the DeepSeek balance.

| Item | Meaning |
|---|---|
| Bal | The DeepSeek account **total available balance** (CNY top-up + bonus), each wallet truncated to the cent; bonus is merged into the main figure and broken out as "incl. bonus ¥x" in the hover tooltip. Refreshed at a minimum interval of 60 seconds; clicking the card forces a refresh regardless of that interval |
| Today | Today's spend (Beijing time): credited **immediately** when a turn settles, then reconciled against balance drops without double counting |
| Turn | Converted cost of the most recent turn; shown by default, can hide after 0–600 seconds |

- "Turn" (per-turn cost) is estimated from official list prices (`deepseek-flash` / `deepseek-v4-pro`) and actual usage; internal accounting is more precise than the UI, so very small costs are not rounded down to zero. Billing is on by default: only confirmed local/private endpoints are unbilled. Third-party models use the price table in the stats panel; without a price they still show tokens but add `0` to "Turn" and "Today", and history is recalculated once a price is filled in.
- **Per-answer cost**: the stats line under each answer ends with that reply's own estimate, e.g. `240 tok · 18 chars · ¥0.0023` (4 decimals with a `¥` prefix; `<¥0.0001` below one ten-thousandth of a yuan, `¥0.0000` at zero). It sums only this reply's usage, so a multi-step turn is not billed twice; local replies show `Local` and unpriced third-party replies show `No price`. The whole-turn total stays in **Turn**, and the hover text explains the difference.
- Peak / off-peak uses Beijing time: weekdays `09:00–12:00` and `14:00–18:00` are peak, everything else is off-peak; off-peak is `0.5×` the peak price.
- "Today" is **settlement-first**: `turn/end` immediately credits the estimated cents to today's bucket, at the same moment as "Turn". Balance observations then only add `actual drop − already settled`; when the estimate is higher than reality nothing is subtracted, so the same turn is never counted twice.
- When the balance goes up (top-up / refund), recorded spend is not reduced and no manual correction is kept; the next observation simply moves the baseline.
- Money is parsed and displayed in integer **cents**, never rounded at the yuan level. The main figure is **top-up + bonus**, with each wallet **truncated to the cent** exactly like the official page, so a raw `5.999…` shows as `¥5.99`, not `¥6.00`. Bonus is merged into the main figure and only broken out in the tooltip, not on a separate line.

---

## Statistics

A small chart icon sits at the **end of the sidebar cost row** (`Bal ¥6.02 | Today ¥0.00 | Turn`); hovering it shows "Statistics", clicking opens a full-screen overlay. It can also be opened from **Settings → Message Butler → Cost Statistics** via the **Open stats table** button between the peak/off-peak row and the account-scope note; there is no separate toggle, and the icon is always available while the cost card is shown.

- Data comes from the **real local session logs** through the host's official `sessionQuery` service — the same assistant usage records that feed the per-turn figure — so tokens, cost and the card agree.
- **First row, four cards**: total tokens (with cache-hit share), session count (with running count), **budget** (amount + progress bar), **budget usage** (percent + remaining).
- **Second row, four cards**: balance, today, turn, **estimated cost**, at the same size, radius and type scale as the KPI cards. The **budget card** shows the amount with "Left ¥x · used y%" underneath and a compact **Edit budget** button (25 px height, `0 9px` padding, 11.5 px label, 6 px radius, filled primary) at the right end of the amount row, so it never dominates the figure; clicking the amount still edits in place. The edit state is one no-wrap row with a uniform `gap:7px`: a 92 px input (shrinkable to 64 px, 13 px text, 2×6 px padding) with `¥` / `CNY` affixes, a 25 px **Save** and a 25 px outlined **Cancel**; Enter saves and Esc cancels. Below a ~181 px card width a container query tightens the gap to 4 px and the button paddings to 5 px / 4 px, so the row measures ≈135 px and still fits the 136 px content width of the narrowest card without wrapping. The one-line budget note truncates with an ellipsis instead of wrapping, so the card keeps the same height as its siblings. **Balance / today / turn** are the same state and formatters as the sidebar cost card, so the three figures match character for character. On narrow windows the row wraps to 2×2 with cards 1–2 / 3–4 and 5–6 / 7–8 per line.
- **Billing scope**: billed by default; only confirmed local/private endpoints (localhost, 127.0.0.1, 10/8, 172.16/12, 192.168/16, `.local`, etc.) are unbilled. Third-party models use the price table; without a price their tokens still count but cost `0` and are excluded from estimated cost, budget usage and the daily figure. The timeline adds a separate 3 px **billing bar** under each column — deep blue for priced tokens, neutral gray for local unbilled tokens, amber for unpriced tokens — because the four token-category colors already use blue (so the billing split is an additive encode, not a recolor). Its legend now shares the **same row** as the four-colour legend: categories on the left, billing scope right-aligned (`space-between`, same 11 px type); if the row cannot fit both, they wrap as two whole groups instead of overlapping. Local-only session rows show **Local · unbilled**, unpriced-only rows show **No price**, and unverified sources carry a **Source unverified** pill. The panel footer provides source diagnostics, an override list (`provider=always` / `provider=local`) and a third-party price-table editor.
- **Timeline**: last 24 hours / last 30 days, split by input / cache hit / cache write / output; legend, billing bar and peak marker included.
- **Session table**: name, tokens, cost, last updated; running sessions and subagent sessions are tagged, sorted by token usage; local-only sessions show **Local** in the cost column.
- **Budget**: click **Edit budget** on the budget card (or the amount itself) to edit (CNY, default ¥5, `0` hides the ratio and shows only the estimate). It is saved into the same `cost-state.json` as the rest of the cost data; old state files without the field fall back to ¥5. The budget **only computes the "budget used" ratio and remaining allowance** as a spending hint; it never bills you and does not affect the balance or per-turn figures.
- The estimate is billed by default: only confirmed local/private endpoints are unbilled. Third-party models use the price table in the stats panel (exact model → prefix → provider → global fallback); without a price they still show tokens but add `0` to the estimate, and history is recalculated once a price is filled in. DeepSeek official models keep official prices and peak / off-peak rules. A small cross-check line shows the card's "today" and observed total, since those come from balance drops and use a different basis.
- `Esc` closes the overlay, the opener regains focus, and focus starts on the close button — same behaviour as the share / export overlays.

CPU, process memory, system load and uptime are deliberately **not** included; this plugin is about messages and cost.

---

## Installation

### Install from the plugin marketplace

1. Plugins → **Plugin marketplace** tab → type `dsh-message-actions` in the search box.
2. Click **Install** on the card. Once installed, the card shows the **Installed** badge.

### Add the plugin by package name

1. Plugins → **+ Add plugin** (top right).
2. Enter `dsh-message-actions`; if the default registry is slow, choose **Mainland China mirror** as the install source.
3. Click **Install**. If it is already installed, DSH tells you: "This plugin is already installed. To upgrade, uninstall and reinstall it."

### Install from npm

```bash
npm install dsh-message-actions
```

The published package is `dsh-message-actions@0.2.4`.

### Self-hosted market index source (optional)

The plugin also has its own market index, useful when a marketplace does not list it or you want a pinned source:

```text
https://raw.githubusercontent.com/aijacko/dsh-message-actions/main/market/index.json
```

1. Plugins → **Experimental plugins** → More → turn on **Custom plugin marketplace**.
2. Plugins → **Discover** → **Add index source** → paste the URL above.
3. Search `dsh-message-actions`, check that the source is the npm package and registry, install, then restart DSH.

### Local install

```bash
git clone <repository-url> dsh-message-actions
cd dsh-message-actions
node build.mjs          # writes lib/
node test/check.mjs     # should print ALL CHECKS PASSED
```

Install the built directory into a DSH profile:

```bash
pnpm add "file:/path/to/dsh-message-actions"
```

- `pnpm add file:` uses **copy** semantics: after editing code, reinstall (or pass `--force`).
- Host-side changes (`src/index.mjs`, Config) need a DSH restart; client-only changes can be picked up by disabling → enabling the plugin, or refreshing the page.
- Registration: add the package name to `dsh.profile.bundles` in the profile `package.json`.
  **Do not** append another `insert` in the profile's `cordis.patch.yml` — the package's own patch already inserts itself at the bundle layer, and a duplicate insert makes the settings page fail to save.

---

## Usage

1. Hover over any **question** row: Recall, Share, Export, Delete, Delete to end appear on the right.
2. Hover over a **tool-call row**: "Delete tool" appears on the right; it deletes the node set for that `(turn, step)` — the answer and other tool results in the same step disappear too; other steps are unaffected.
3. Under every **answer**, `tok · chars · ¥0.0023` is shown; the last segment is that reply's own estimated cost (`Local` for non-DeepSeek routes).
4. Recall and delete actions ask for confirmation by default, using one compact 420px dialog on wide screens and an edge-to-edge dialog on narrow screens; turn off "Confirm actions" to run them immediately. After confirming, the content disappears and the sidebar ticks hide in sync.
5. Share / export opens a full-screen picker; each card shows the question and answer preview for that turn, and you can select one, several, or all; full text is fetched only when you generate. If fetching full text or generating the image / file fails, a toast appears and the picker **stays open with your selection**, so you can retry; it closes only after a successful download.
6. While a reply is being generated, all buttons are disabled to avoid conflicting with the running session; a write that still races the agent returns `423 AGENT_BUSY`.

### Balance scope

The card's **Bal** is read directly from the DeepSeek account service and shows the **total available balance**:

- Main figure = **top-up balance (CNY wallets) + bonus / reward wallets (`bonusWallets`)**, each wallet **truncated to the cent** exactly like the official page: a raw `5.999…` renders `¥5.99`, not `¥6.00`.
- Bonus is **merged into the main figure**, not split onto its own line; the hover tooltip breaks it out as "incl. bonus ¥x" so it can still be compared with the official **Bonus balance** row.
- "Today" observes drops in that same total, so the displayed balance and the accounting basis agree.
- There is **no manual correction layer**: top-ups and refunds simply move the observed baseline, and nothing typed can silently override the figure. The settings page keeps a short note explaining this scope.

---

## Settings

Settings → Plugins → **Message Butler**; the page has two tabs, and changes **save immediately and apply right away**.

**Message Actions**

| Toggle | Effect |
|---|---|
| Recall | Show "Recall" on question rows |
| Share | Show "Share" on question rows |
| Export | Show "Export" on question rows |
| Delete | Question row deletes the whole exchange; tool row deletes that step's tool results |
| Delete to end | Show "Delete to end" on question rows |
| Confirm actions | Whether recall and delete actions ask for confirmation |
| Reply statistics | Whether `tok · chars · cost` is shown under answers |
| Completion tone | Default double / bell / soft / off; picking one turns the chime on and previews it, "Off" turns the completion sound off (there is no separate switch row) |
| Volume | 0–100 slider (default 50, step 5): applies to all tones — 0% mutes, 50% is normal, 100% is double. The number follows the drag without writing config; on release (or key up / blur / native change) it saves once and previews once |

**Cost Statistics**

| Setting | Effect |
|---|---|
| Cost statistics | Show balance / today / per-turn cost in the sidebar; when off, stop fetching and recording |
| Style | `Single-line` (default, no background) / `Multi-line` (card with the peak / off-peak row), switch instantly and persist |
| Per-turn | Show the cost of each finished turn; when off, don't render that group |
| Auto-hide | Seconds before the turn cost hides (0–600, 0 = always) |
| Peak/off-peak | Show the current pricing period and the next switch |
| Statistics | The button reads "Open stats table" and opens the overlay; sits between the peak/off-peak row and the account-scope note. The settings row describes only what the data is; the budget note lives inside the overlay only |
| Balance scope | Main figure = top-up + bonus, each wallet truncated to the cent; bonus broken out in the tooltip only, not on its own line; no manual correction |

---

## Privacy and security

This section only describes what the code actually does. It is risk reduction, not a "zero-risk" promise; every claim below maps to an implementation under `src/`.

**The interface is reachable from this machine only**

- The plugin doesn't open its own port; routes register on DSH's existing `webServer`.
- Every request checks that `Host` is `localhost`, `127.0.0.0/8`, or `::1`, otherwise it returns `403`; this blocks DNS rebinding and LAN origins.
- Browser requests also go through `Sec-Fetch-Site`: only `same-origin` / `none`, or a non-browser client that omits the header, is accepted; `cross-site` and `same-site` are rejected explicitly.
- Requests carrying `Origin` must be same-origin with the host; when the host can't provide an expected `Origin`, any request with `Origin` is rejected.

**Response headers and write requests**

- Every JSON response carries `cache-control: no-store`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `cross-origin-resource-policy: same-origin`, and `content-security-policy: default-src 'none'; frame-ancestors 'none'`.
- Write requests only accept `content-type: application/json`; the body limit is 1MB, and oversized bodies get `413` with the connection drained; a wrong method gets `405` (with an `allow` header), and the error body is the same JSON shape.
- No CORS allow headers are returned.

**Conversation data**

- `GET /messages` is a **summary** interface: it returns message ids, turn, step, a preview of at most 200 characters, usage, and the tool `callId`; no body text. The client has no fixed polling timer: it refetches when the conversation DOM changes, coalesced by a 120 ms scheduler, with a 3-second TTL to avoid duplicate requests.
- The summary supports incremental reads: a request with `since=<last version>` returns only rows with `seq > since` (plus `removedSeqs` for rows deleted since then); without `since` it still returns the full snapshot. Deletion state (`goneTurns` / `goneTools`) is always returned in full, so deleted content stays hidden after an incremental refresh.
- `preview` is only generated for real questions and assistant answers; system / developer messages, runtime-injected context, and tool results are always empty, so their text is never returned by this endpoint (implementation: `messagesSummaryOf` in `src/shared.cjs`).
- Share images and export fetch full text only for the selected turns via `full=1`, and only questions / answers are returned.

**Cost data**

- Only one local file: `cost-state.json` under `$DSH_HOME` (default `~/.dsh`), in `plugins/dsh-message-actions/`.
- Writes are a whole-file replacement: temp file in the same directory (`0600`) → `fsync` → `rename`, so a half-written file can't be left behind; the directory is created with `0700`.
- Contents are only balance observations, per-day spend and the budget; no conversation text.
- Budget writes report success only after the state file is written: a read-only state file returns `500 READ_ONLY`, a failed write returns `500 WRITE_FAILED` and rolls the in-memory value back, so the UI shows "save failed" instead of a false success.
- A file over 4MB is rebuilt as the default state and logged with the reason and size; a corrupt file under the limit is renamed to `cost-state.bad-<timestamp>.json` and kept.
- Settlement is pushed: the client long-polls `/cost/state` with `wait=<lastTurn.at>` (up to 10 seconds), and the host answers as soon as `turn/end` is processed, so the per-turn cost does not wait for the next 5-second poll; the chime fires in the same state update as the number.
- The chime is synthesised in the client with Web Audio; no audio file, no network request, no state file. Default double tone is 880→660 Hz sine at a base gain of 0.18, bell uses triangle waves, soft is a single 523 Hz note. The base gain is multiplied by the volume factor (50% = 1×, 100% = 2×) and 0% stays completely silent. It plays once per turn.
- Browsers require at least one user gesture before audio: the plugin installs `pointerdown` / `keydown` listeners at load time to unlock the `AudioContext` early. If playback still finds it suspended, it retries once silently after `resume()`; no toast. Picking a tone in Settings previews it immediately; the volume slider previews once on commit only (release / key up / blur / end of drag, debounced 120 ms) and stays silent during the drag.

**Network**

- The plugin itself does not make requests to external addresses; the client only calls same-origin `/dsh-message-actions/*`.
- The balance is read through the host's signed-in DeepSeek account service (`deepseekAccount`); that network request is made by the host. When signed out, it shows "Signed out".
- The plugin stores no keys; to decide whether an API-key path applies, it only asks the host credential service whether one exists, without persisting it or returning it.

---

## Known limitations

- Deletion granularity: the question row deletes the whole turn; the tool row deletes that step, hiding the answer and other tool results in the same step. Other steps are unaffected.
- No undo for deletion, and no cross-session memory cleanup.
- Deletion markers live in the session event log. They survive refresh, conversation switching, and a DSH restart; deleting the session directory removes the markers along with the session.
- If the host ever rebuilt the conversation surface without replaying the tombstone, this plugin hides the removed tool rows again from `goneTools`; the hidden rows still exist in the DOM (CSS `display:none`), so very large sessions may keep some invisible nodes.
- The sidebar ticks are drawn by the official virtual list; after deleting content, scrolling past that area may show blank space.
- Entries depend on the host's conversation DOM structure: after a major DSH upgrade the buttons may stop appearing (they disappear silently rather than deleting the wrong thing).
- "Per-turn cost" covers model calls only, not external billing such as search or plugins.
- Web mode is untested: `localhost` on the same machine may work; LAN / remote access is rejected by the security fence.

---

## Development

```bash
node build.mjs        # build to lib/
node test/check.mjs   # offline assertions, 2972 currently
# plus a real session-log regression: 18/18
```

```
src/
├── index.mjs    # host: Config + HTTP routes + cost / session-stats services
├── client.js    # client: slots, DOM injection, share / export overlay, cost card
├── shared.cjs   # pure functions shared by host and client (offline testable)
├── store.cjs    # cost state file: atomic read/write, recovery on corrupt files
├── http.cjs     # HTTP helpers: JSON responses, 413 drain, body reading
└── i18n.cjs     # single source for Chinese/English copy (builds locale/*.json)
test/check.mjs   # dependency-free assertion script
```


- Version: `0.2.6` (source version; not published)
- Latest release: [v0.2.4](https://github.com/aijacko/dsh-message-actions/releases/tag/v0.2.4)
- Compatible with: DSH `0.2.1-rc.5` and `0.2.2-rc.1`; `0.2.2-rc.1` (web profile) verified, older hosts take the portal fallback
- Dependencies: none at runtime

---

## License

[MIT](LICENSE)
