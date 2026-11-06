# DSH plugin dsh-message-actions

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
| **Balance scope** | The main figure is the official DeepSeek **top-up balance**, truncated to the cent like the official page; bonus credit is shown in the hover tooltip only, and there is no manual adjustment layer |
| **Bilingual UI** | Follows the DSH language; interface and tooltips switch automatically |
| **Overlay keyboard** | In the share / export overlay, `Enter` runs the primary action (Share image / Export); in a confirmation dialog it confirms, and `Esc` cancels. Enter is ignored while focus is in a text field, and when the primary action is disabled or busy |

Deletion uses **tombstone-style surface replacement**: it only appends a marker and hides the original span; it never rewrites the history log and doesn't affect other sessions. The marker is persisted in the session event log, so deleted content stays hidden after a page refresh, after switching to another conversation and back, and after restarting DSH. `/messages` and `full=1` both recompute the visible set from those markers instead of trusting the host surface alone.

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
- Local models / non-DeepSeek routing collapse to "Local · no billing", out of the way.

| Item | Meaning |
|---|---|
| Bal | The DeepSeek account **top-up balance** (CNY), matching the official page; bonus credit is not merged into the main figure and only shown in the hover tooltip. Refreshed at a minimum interval of 60 seconds; clicking the card forces a refresh regardless of that interval |
| Today | Today's spend (Beijing time): credited **immediately** when a turn settles, then reconciled against balance drops without double counting |
| Turn | Converted cost of the most recent turn; shown by default, can hide after 0–600 seconds |

- "Turn" (per-turn cost) is estimated from official list prices (`deepseek-flash` / `deepseek-v4-pro`) and actual usage; internal accounting is more precise than the UI, so very small costs are not rounded down to zero. Only DeepSeek-routed usage is billed: local models count tokens but add `0` to "Turn" and "Today", and the card collapses to "Local · no billing".
- **Per-answer cost**: the stats line under each answer ends with that reply's own estimate, e.g. `240 tok · 18 chars · ¥0.0023` (4 decimals with a `¥` prefix; `<¥0.0001` below one ten-thousandth of a yuan, `¥0.0000` at zero). It sums only this reply's usage, so a multi-step turn is not billed twice; local / non-DeepSeek replies show `Local`. The whole-turn total stays in **Turn**, and the hover text explains the difference.
- Peak / off-peak uses Beijing time: weekdays `09:00–12:00` and `14:00–18:00` are peak, everything else is off-peak; off-peak is `0.5×` the peak price.
- "Today" is **settlement-first**: `turn/end` immediately credits the estimated cents to today's bucket, at the same moment as "Turn". Balance observations then only add `actual drop − already settled`; when the estimate is higher than reality nothing is subtracted, so the same turn is never counted twice.
- When the balance goes up (top-up / refund), recorded spend is not reduced and no manual correction is kept; the next observation simply moves the baseline.
- Money is parsed and displayed in integer **cents**, never rounded at the yuan level. The top-up balance is **truncated to the cent** exactly like the official page, so a raw `5.999…` shows as `¥5.99`, not `¥6.00`. Bonus credit is listed separately in the tooltip to stay aligned with the official account page.

---

## Statistics

A small chart icon sits at the **end of the sidebar cost row** (`Bal ¥6.02 | Today ¥0.00 | Turn`); hovering it shows "Statistics", clicking opens a full-screen overlay. It can also be opened from **Settings → Messages & Cost → Cost Statistics** via the **Open stats table** button between the peak/off-peak row and the account-scope note; there is no separate toggle, and the icon is always available while the cost card is shown.

- Data comes from the **real local session logs** through the host's official `sessionQuery` service — the same assistant usage records that feed the per-turn figure — so tokens, cost and the card agree.
- **First row, four cards**: total tokens (with cache-hit share), session count (with running count), **budget** (amount + progress bar), **budget usage** (percent + remaining).
- **Second row, four cards**: balance, today, turn, **estimated cost**, at the same size, radius and type scale as the KPI cards. The **budget card** shows the amount with "Left ¥x · used y%" underneath and a compact **Edit budget** button (25 px height, `0 9px` padding, 11.5 px label, 6 px radius, filled primary) at the right end of the amount row, so it never dominates the figure; clicking the amount still edits in place. The edit state is one no-wrap row with a uniform `gap:7px`: a 92 px input (shrinkable to 64 px, 13 px text, 2×6 px padding) with `¥` / `CNY` affixes, a 25 px **Save** and a 25 px outlined **Cancel**; Enter saves and Esc cancels. Below a ~181 px card width a container query tightens the gap to 4 px and the button paddings to 5 px / 4 px, so the row measures ≈135 px and still fits the 136 px content width of the narrowest card without wrapping. The one-line budget note truncates with an ellipsis instead of wrapping, so the card keeps the same height as its siblings. **Balance / today / turn** are the same state and formatters as the sidebar cost card, so the three figures match character for character. On narrow windows the row wraps to 2×2 with cards 1–2 / 3–4 and 5–6 / 7–8 per line.
- **Billing scope**: only **official DeepSeek models** are billed. Usage from local / non-DeepSeek providers (ollama, localhost endpoints, custom gateways) still counts toward tokens, but its cost is `0` and it is excluded from estimated cost, budget usage and the daily figure. The timeline adds a separate 3 px **billing bar** under each column — deep blue for DeepSeek-billed tokens, neutral gray for local unbilled tokens — because the four token-category colors already use blue (so the billing split is an additive encode, not a recolor). Its legend now shares the **same row** as the four-colour legend: categories on the left, billing scope right-aligned (`space-between`, same 11 px type); if the row cannot fit both, they wrap as two whole groups instead of overlapping. Local-only session rows show **Local · unbilled** instead of `¥0.00`, and their cost is excluded from the total; the panel note states the rule explicitly.
- **Timeline**: last 24 hours / last 30 days, split by input / cache hit / cache write / output; legend, billing bar and peak marker included.
- **Session table**: name, tokens, cost, last updated; running sessions and subagent sessions are tagged, sorted by token usage; local-only sessions show **Local** in the cost column.
- **Budget**: click **Edit budget** on the budget card (or the amount itself) to edit (CNY, default ¥5, `0` hides the ratio and shows only the estimate). It is saved into the same `cost-state.json` as the rest of the cost data; old state files without the field fall back to ¥5. The budget **only computes the "budget used" ratio and remaining allowance** as a spending hint; it never bills you and does not affect the balance or per-turn figures.
- The estimate uses the same official prices and peak / off-peak rules as the per-turn figure. A small cross-check line shows the card's "today" and observed total, since those come from balance drops and use a different basis.
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

The published package is `dsh-message-actions@0.2.1`.

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

The card's **Bal** is read directly from the DeepSeek account service and matches the official **Account & balance** page:

- Main figure = **top-up balance** (CNY wallets), **truncated to the cent** exactly like the official page: a raw `5.999…` renders `¥5.99`, not `¥6.00`.
- Bonus credit (`bonusWallets`) is **not** merged into the main figure; it appears only in the hover tooltip.
- There is **no manual correction layer**: top-ups and refunds simply move the observed baseline, so the figure always mirrors the official one and nothing typed can silently override it. The settings page keeps a short note explaining this scope.

---

## Settings

Settings → Plugins → **Messages & Cost**; the page has two tabs, and changes **save immediately and apply right away**.

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
| Balance scope | Main figure = official top-up balance, truncated to the cent; bonus credit in the tooltip only; no manual correction |

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
node test/check.mjs   # offline assertions, 2782 currently
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


- Version: `0.2.2` (npm latest is still `0.2.1`; 0.2.2 is not published yet)
- Release: [v0.2.1](https://github.com/aijacko/dsh-message-actions/releases/tag/v0.2.1)
- Compatible with: tested on DSH `0.2.1-rc.5` desktop (profile `desktop`)
- Dependencies: none at runtime

---

## Changelog

### 0.2.2 · 2026-11-04

All 16 commits from this day (old → new): `53552dc`, `f830b12`, `78cb270`, `4978c2e`, `ba60691`, `f8e0c67`, `d221953`, `4faa989`, `1bf7ffc`, `51bfdf5`, `50c67fa`, `67f195a`, `f9eb238`, `a18e6ee`, `5156514`, `88873c2`; docs `9041816`, `ace30b3`, `6e813a2` and this round's docs commit. The first 15 commits are on `origin/main` (remote HEAD `84d5af5`); `88873c2` and this round's docs commit are **local only, not pushed**.

**Completion sound & instant settlement** (`f830b12` / `f8e0c67` / `4faa989`)
- Symptom: after the per-turn figure appeared, "today" lagged up to 5 s; the chime was often inaudible and had a single fixed tone with no volume control.
- Cause: the client polled on a fixed 5 s timer; `AudioContext` was only resumed when the turn finished, so autoplay policy blocked it; gain was fixed at 0.09 with no tone or volume config.
- Fix: `/cost/state?wait=<lastTurn.at>` long-polling, with the host returning right after `turn/end` settles, so the per-turn figure and the chime land in the same state update; pre-unlock audio on `pointerdown` / `keydown` at module load and retry silently after `resume()`; base gain 0.09 → 0.18, plus tones (double / bell / soft / off) and a 0–100 volume slider.

**Settings layout & interaction** (`78cb270` / `4faa989`)
- Symptom: rows were tall and loosely spaced; the sound block expressed on/off twice (a switch plus an "Off" tone).
- Cause: row `padding` 14px, description `margin-top` 3px and block gaps 14px were too large; `sound` boolean and `soundTone` both encoded the switch.
- Fix: row `padding` 14 → 10px, description margin 3 → 2px, block/button gaps tightened to 8–10px; removed the "Completion sound" switch row, `soundTone = "off"` now means off, legacy `sound = false` maps to "Off"; added a volume row.

**Session statistics merged in** (`4978c2e` / `ba60691`)
- Symptom: token usage, timeline and per-session cost were needed; the separate `session-stats` plugin also added a top-level nav entry and CPU / memory / load / uptime sampling that duplicated the cost card.
- Cause: stats lived in a separate plugin, so entry points and cost data were split.
- Fix: reads through `sessionQuery` / `sessionPersistence`, a small icon at the end of the cost row, a body-level stats overlay with four KPI cards, a 24 h / 30 d timeline, a session table and a budget (default ¥5, stored in the same `cost-state.json`); dropped the nav entry and system samplers; the over-budget ratio is no longer capped at 100% and shows the true ratio.

**Data consistency fixes** (`f8e0c67`)
- Symptom: ① "today" lagged behind the per-turn figure; ② balance was off by one cent (`¥5.99` rendered as `¥6.00`); ③ the stats panel showed no balance / today / turn figures; ④ the chime did not play.
- Cause: today was only accumulated passively from balance observations; amounts went through float rounding; the budget row only had an input; audio nodes were skipped while the context was suspended.
- Fix: `settleSpend()` accumulates at `turn/end` (bucketed by `endedAt`, idempotent by `key`), while balance observations only add the `diff - settled` remainder; all amounts are integer cents with numbers parsed via decimal strings, the primary balance uses the official recharge balance and bonus is listed separately; the budget row shows all three figures from the same state and formatters as the sidebar; pre-unlock + 0.18 gain + `resume()` retry + tone preview.

**Boot failure fix** (`d221953`)
- Symptom: restarting DSH reported `web boot: 1 entry did not activate` / `dsh-message-actions: import failed`, with `client.js:4615 Uncaught SyntaxError: Unexpected token ','`.
- Cause: an extra closing parenthesis in the budget three-figure ternary made `lib/client.js` fail to parse as a whole.
- Fix: rewrote the closure; `test/check.mjs` now guards the artifacts three ways — `node --check lib/client.js`, every shared symbol destructured by the client must really be exported, and every literal key passed to `tt()` must exist in both zh and en.

**Copy & entry adjustments** (`4faa989`)
- Symptom: the stats row in Settings repeated the panel's budget explanation; the button and panel title used different names; the budget block was a single input row that did not match the KPI cards.
- Cause: Settings was explaining budget semantics that belong to the panel; the button reused the row label; the budget block did not reuse card styles.
- Fix: Settings keeps only "Token usage, usage timeline and per-session cost" and the budget note lives only in the panel; the button reads "Open stats table"; panel title / `aria-label` / hover all say "Statistics"; the budget block became a budget card (in-place amount editing, remaining · used sub-line, progress bar) plus balance / today / turn cards, matching the KPI cards in size and hierarchy, wrapping to 2×2 on narrow windows.

**Stats cards & volume slider** (`51bfdf5`)
- Symptom: the budget card only had the hidden "click the amount" entry; the budget and budget-usage cards were not in the expected positions; dragging the volume slider in Settings stuttered and did not follow the pointer.
- Cause: the budget card had no explicit button; the two cards were grouped by function rather than by editable / read-only; the volume slider called `save("soundVolume", n)` on every `onChange` (one input event per pixel), which wrote host config, persisted it and updated the `useSyncExternalStore` snapshot, re-rendering the whole settings panel — and the slider `value` came straight from the host snapshot, so the delayed write caused jumps.
- Fix: the budget card gained an **Edit budget** text button as the primary entry (the hidden amount click stays; both call the same `openBudgetEdit`); the edit state is still input + Save / Cancel, Enter saves and Esc cancels, and `READ_ONLY` / `WRITE_FAILED` keep the existing "save failed" feedback. The budget card moved to the fourth slot of row one and budget usage to the first slot of row two — DOM order only, same styling and sub-line. Volume now uses a local `draft` state plus refs: dragging only updates the displayed number; release / key up / blur / native `change` all funnel into a 120 ms debounce that saves once and previews once, and external snapshot updates cannot overwrite the draft mid-drag.

**Budget button, card order & settings divider** (`50c67fa`)
- Symptom: the Edit budget link sat on its own line and did not match the settings button; estimated cost was still in row one; the settings page showed two dividers between the Statistics row and the Balance correction heading.
- Cause: the trigger was a text-link rendered as a separate row; cards were grouped by function; the last `.dma-setting-row` already has `border-bottom`, and `.dma-correction` added a `border-top` plus a 10 px `margin-top`, producing a double line and doubled spacing.
- Fix: Edit budget is now a compact filled button matching the settings save button, placed in `.dma-stats-money-value-row` beside the amount, and the standalone `.dma-stats-money-trigger` row was removed (clicking the amount still works). Row one is now total tokens → sessions → budget → budget usage; row two is balance → today → turn → estimated cost. `.dma-correction` lost `border-top` and `margin-top`, leaving the row's `.5px` `border-bottom` as the only divider (same colour and indent).

**Balance scope: correction removed & one-cent mismatch fixed** (`67f195a`)
- Symptom: editing the two Balance correction inputs and clicking Save changed nothing (the derived balance stayed `¥6.82`, pending `¥0.00`); the sidebar balance showed `¥6.00` while the official **Account & balance** page showed `¥5.99` even after the previous round switched the card to the recharge figure.
- Cause: (1) `correctedBalanceCents` was only consumed by `stateValue()` and the settings preview — the sidebar card read `balance.rechargeCents` and never looked at the correction; `pendingAdjustmentCents` was only incremented by `observeBalance` on a balance rise and had no renderer, so saving could not move any visible number. The correction layer was pure display dead weight on top of data that already comes straight from the account API. (2) `yuanToCents` rounded half-up, while the official page **truncates positive amounts to the cent**; the wallet API returns a raw string with more than two decimals (e.g. `5.999…`), so the plugin got `600` and the official page showed `599`.
- Fix: the whole correction block was removed — `/dsh-message-actions/cost/correction` route, `applyCorrection`, `correctedBalanceCents`, `pendingAdjustmentCents` / `pendingAdjustmentAt`, `correctionCreditCents` / `correctionDebitCents` (state, normalization and tests), the settings form, the "Check" badge and the dead CSS; the settings page now keeps a short account-scope note (`cost.balanceNote`). `yuanToCents` gained a `truncate` mode used only for CNY wallets, so the card matches the official page cent for cent; ordinary amount parsing keeps round-half-up.

**Budget card button parity & compact edit row** (`f9eb238`)
- Symptom: **Edit budget** was a black filled 22 px button (11 px text) while **Save budget** was taller and wider (≈28 px, 12–13 px); the edit row's full-width input plus buttons overflowed the card and pushed Cancel onto its own line.
- Cause: the two buttons used different classes (`.dma-stats-money-apply` vs `.dma-stats-money-save`) with independent height / padding / font / radius; the input had no fixed width and the row had no `min-width:0`, so it could exceed the card.
- Fix: **both buttons now use the same `.dma-setting-primary` class** — identical height 32 px, padding 0 16 px, 13 px font, radius 8 px, primary fill and weight; `.dma-stats-money-apply` and `.dma-stats-money-save` were deleted. Edit budget sits at the right end of the amount row (amount button is `flex:1`, action `flex:none`, `white-space:nowrap`). The edit row is `[¥ fixed 88 px input] [Save] [Cancel]` with `flex-wrap:wrap` and `min-width:0`, so it never overflows and only wraps on very narrow cards; Save is now "保存 / Save", Cancel is a secondary outlined button with the same 32 px height immediately after Save. Enter still saves, Esc still cancels, and the sub-line "Left ¥x · used y%" and progress bar are unchanged. (Superseded by `a18e6ee`: the settings-sized 32 px pair was still visually louder than the amount, so the next round shrank it to a dedicated 25 px class (gap tuned in `5156514`).)

**Compact budget controls & local-model billing scope** (`a18e6ee` / `5156514` / `88873c2`)
- Symptom: **Edit budget** still took more than half the card width (32 px tall, `0 16px` padding, 13 px text); in the edit state the `[¥ 5.00 CNY]` input was too wide and Cancel fell onto a second line; the statistics table billed local-model tokens at DeepSeek prices.
- Cause: the last round reused the settings primary button (`.dma-setting-primary`, sized for full-width settings rows) inside a 160 px card; the edit input still had no fixed width and the row allowed wrapping. For billing, `foldSessionStats` recorded `provider` but `statsPointCostMicros` priced every point through `turnCost(point.model)`, whose unknown-model fallback is the DeepSeek Flash row, so a `ninfer-27b` local session (102 points in the real logs on this machine) was charged as if it were DeepSeek.
- Fix: (1) both budget actions now use a dedicated `.dma-stats-money-mini` (25 px height, `0 9px` padding, 11.5 px label, radius 6 px, primary fill); the edit row is `flex-wrap:nowrap` with `gap:7px` (no margin stacking), a 25 px Save and a 25 px outlined Cancel, so all three keep clear spacing and stay on one line; the hint shrank to one 10 px line with ellipsis instead of wrapping. (Input sizing was tuned twice: 64 px in `a18e6ee`, then 92 px with a container-query fallback in `88873c2`.) (2) `isBillableRoute(provider, model)` was added: `deepseek-account` / `deepseek-*` providers are billable, any other known provider is local and unbilled, and a missing provider is billable only when the model name is `deepseek-*` (unknown sources are never guessed into a price). Folded points carry `billable`; `statsPointCostMicros` returns 0 for local points; timeline buckets / rows / totals gained `billableTokens` and `localTokens`; turn settlement filters billable groups before `turnCostOfGroups`, so local usage never enters "Today". The timeline draws a separate 3 px billing bar (deep blue `#2f6bd8` = DeepSeek billed, gray `#a8aeb8` = local unbilled) with its own legend row, because the four token-category colors already use blue; local-only session rows show **Local** instead of `¥0.00` and are excluded from the total. Follow-up `5156514`: the first pass packed the three controls with a 3 px gap and read as cramped, so the row now uses a uniform `gap:7px` (input↔Save and Save↔Cancel); Save / Cancel keep 25 px height (`0 9px` / `0 7px` padding). Follow-up `88873c2`: the input was then too small, so it was widened to 92 px (`flex:0 1 92px`, `min-width:64px`, 13 px text, 2×6 px padding); a container query on the budget card (`≤181px`) tightens the gap to 4 px and button paddings to 5 px / 4 px, keeping the row at ≈135 px inside 136 px and never wrapping, while the billing legend moved onto the same row as the four-colour legend, right-aligned.

## Acceptance checklist (0.2.2)

**Cost card & data consistency**
- [ ] The sidebar cost row shows balance / today / turn in both layouts (single-line and multi-line) with correct alignment.
- [ ] Run one turn: the per-turn figure and today update together with no visible lag; midnight buckets by end time.
- [ ] The primary balance matches the official recharge balance to the cent (e.g. a raw `5.999…` shows `¥5.99`, not `¥6.00`); bonus appears only in the hover hint.
- [ ] Peak / off-peak icon and pricing switch correctly (peak / off-peak / auto).
- [ ] There is no Balance correction block and no "Check" badge; Settings shows only the account-scope note, and top-ups / refunds never alter recorded spend.

**Statistics**
- [ ] The small icon at the end of the cost row is always visible and hover says "Statistics"; Settings → Messages & Cost → Cost Statistics → "Open stats table" opens it too.
- [ ] Panel title and `aria-label` both say "Statistics"; `Esc` closes and returns focus to the opener.
- [ ] The first row's four KPI cards read total tokens / sessions / budget / budget usage, with sensible values and the cache share noted.
- [ ] The second row reads balance / today / turn / estimated cost; the 2×2 wrap puts cards 1–2, 3–4, 5–6 and 7–8 on their own lines.
- [ ] Edit budget and Save share the same compact button (25 px height, `0 9px` padding, 11.5 px font, 6 px radius, primary fill) at the right end of the amount row, no clipping, no half-row spill; the amount itself is still clickable.
- [ ] The edit row reads `[¥ 92 px input] [Save] [Cancel]` in one no-wrap line with a uniform 7 px gap (4 px under the ≤181 px container query): Save is "保存 / Save", Cancel is a 25 px outlined button right after it, Enter saves, Esc cancels, the sub-line "Left ¥x · used y%" and progress bar stay put, and the card height matches its neighbours.
- [ ] The balance / today / turn cards match the sidebar character for character.
- [ ] The 24 h ↔ 30 d switch works; timeline buckets, legend, billing bar and peak marker are correct; the billing legend sits on the same row as the four-colour legend, right-aligned, and wraps as a whole group on narrow widths.
- [ ] The session table is sorted by usage; running and subagent sessions are tagged; local-only rows show **Local** in the cost column.
- [ ] Run a local-model turn: tokens count, estimated cost / budget usage / today do not move; the banner note and DeepSeek-blue / local-gray billing legend are visible.

**Settings page**
- [ ] Exactly one divider sits under the Statistics row — no double line, no doubled spacing; the account-scope note follows it; other groups are unchanged.

**Completion sound**
- [ ] Tone "Off": no sound at end of turn. Any other tone: previews immediately and plays once at end of turn.
- [ ] A legacy config (old `sound = false`) opens Settings showing "Off".
- [ ] Volume 0% is completely silent, 50% matches the previous level, 100% is clearly louder; the number follows the drag with no stutter, nothing is persisted or previewed mid-drag, and release saves and previews once.
- [ ] Tone and volume survive a DSH restart.

**Settings**
- [ ] "Message actions" has no "Completion sound" switch row — only "Sound tone" and "Volume".
- [ ] The Cost Statistics row has a single data-purpose line, no long budget note; the button reads "Open stats table".
- [ ] Order: usage-stats switch → cost layout → per-turn switch → auto-close → peak pricing → Statistics → account-scope note.
- [ ] Switching tabs keeps state; the version line at the bottom of tab 1 reads `v0.2.2`.

**Message actions & error handling**
- [ ] Recall / delete / delete-from / share / export all work; deletions survive refresh, session switch and restart.
- [ ] Recall a message with an image and a file: both return to the composer as real draft attachments (thumbnail + file card), not as `[图片]` / `[文件]` text.
- [ ] The stats line under each answer ends with `¥0.0023` (4 decimals); a local-model reply shows `Local`; a multi-step turn does not double-count.
- [ ] Recall / delete / delete-to-end dialogs have the same width (~420px in a 1280 window); at 390px they go edge-to-edge with the button row fitting on one line.
- [ ] Acting while a reply is generating returns `423` with a "try again later" message.
- [ ] A read-only state file or failed write shows "Save failed".

**Build & install**
- [ ] `node test/check.mjs` passes (2897 checks, 0 failures).
- [ ] `node build.mjs` succeeds and `node --check lib/client.js` passes.
- [ ] The profile copy's five artifacts hash-match; after restart `v0.2.2` shows and there is no `import failed`.

---

## License

[MIT](LICENSE)
