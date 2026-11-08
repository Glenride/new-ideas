# New Ideas — iMac port

Standalone Bun port of the `new-ideas` Muse space. Same React client and
same server actions, served from the iMac instead of the Hatch runtime.

- **Live:** https://ideas.dvaughnhouse.com (Cloudflare Tunnel `330198c8…`,
  ingress in `~/projects/the-dispatch/cloudflared/config.yml`, service
  `http://127.0.0.1:8091`)
- **On the iMac:** `~/projects/new-ideas/` — `app.db` lives here, NOT in
  `~/Work/library/` (that folder is the Step 1 backup copy, not a running app)
- **Process:** `bun run server/src/standalone.ts` on port 8091, kept alive
  by systemd user service `new-ideas.service`
  (`~/.config/systemd/user/new-ideas.service`, `Restart=always`,
  `WantedBy=default.target` — enabled, so it starts on login; the iMac
  is Arch Linux, there is no launchd here)
- **Source of truth:** THIS server, once the Mission Control sync cron is
  re-pointed at it (see below). The Muse sidebar copy keeps running
  untouched until D'Vaughn says otherwise — do not edit both boards at
  once or they will diverge.

## History — dismissed ideas are never hard-deleted

Dismissing an idea (`updateStatus` → `archived`) is a soft-archive:

- The idea moves to the **History** view (filter tab in the client), with
  the date it was dismissed and a countdown ("gone in N days").
- **Restore** puts it back on the board (`updateStatus` → `new`) and
  clears the dismissal date.
- Dismissed ideas are kept **30 days** from `dismissed_at`, then removed
  automatically by the daily purge.
- Ideas he chooses — **saved / pursuing (and new)** — are kept
  permanently and are **never auto-purged**. The purge only ever deletes
  rows where `status = 'archived'` AND `dismissed_at` is older than 30
  days. Rows with a NULL `dismissed_at` are never purged (safe default).

Where the rule lives in code:

- `server/src/schema.ts` — `ideas.dismissed_at` (nullable timestamp).
- `drizzle/0004_add_dismissed_at.sql` — adds the column. Backfill: the 12
  ideas already archived when the column was added had no recorded
  dismissal time, so they were stamped at migration time and get a full
  30 days from when the rule starts being enforced (not from their
  creation date — the actual dismissal times are unknowable).
- `server/src/actions.ts` — `updateStatus` stamps `dismissed_at` on
  archive and clears it on restore; `getHistory` returns the History
  view; `purgeDismissedIdeas` runs the purge on demand;
  `purgeOldDismissed` is the shared helper; `refreshIdeas` (the daily
  sweep) runs the purge at the start of every sweep. `HISTORY_KEEP_DAYS
  = 30`.
- `client/src/App.tsx` — History filter tab, dismissed date + countdown,
  Restore button.

## How the standalone server replaces the Hatch runtime

| Hatch runtime piece | iMac replacement |
|---|---|
| `ctx.db` (drizzle/sqlite) | `drizzle-orm/bun-sqlite` over `app.db` (same file format) |
| `ctx.tool.web_search` | DuckDuckGo Lite, no key (`server/src/adapters.ts`). **IPv6 caveat (verified 2026-11-07):** DDG serves its anomaly challenge page to this box's IPv6 egress (0 results) while the same query over IPv4 returns 10. `webSearch` therefore tries Bun fetch first and falls back to `curl -4` (forced IPv4) when the first fetch comes back empty. DDG also rate-limits bursts — the sweep's 4 queries plus manual probing tripped both families for a while on Nov 7, so don't hammer DDG from the iMac; the daily sweep is one spaced run and tolerates a partial pool (a sweep with 6 live sources still synthesized 2 ideas). Bing HTML and Mojeek were tested as fallbacks the same night and are NOT viable from this box (Bing serves unrelated decoy results, Mojeek returns nothing). |
| `ctx.inference.complete` | LM Studio on the Mac Studio, OpenAI-compatible, over Tailscale (`LM_BASE_URL`, default `http://100.70.123.107:1234/v1`; model `LM_MODEL`, default `qwen3.6-35b-…-aggressive`). Synthesis timeout 300 s; a full 4-idea synthesis takes ~4–5 min. |
| `ctx.agent.spawnTask` (background sweep) | In-process background job (`runSweepJob` in `server/src/standalone.ts`) — the sweep pipeline itself (`runConsortiumSweep`) is shared with the inline daily refresh |
| Daily cron 07:36 ET | In-process scheduler in `standalone.ts` (checks every minute; runs `refreshIdeas` once per day after 07:36 ET). The date is marked before the sweep runs, so a failed sweep does not retry every minute. Note: a server (re)start also triggers a catch-up sweep if none ran today yet — restarts are sweep attempts, not free. |
| `ctx.invalidateQueries` | No-op; the client refetches on its own |

## Mission Control sync

The 15-minute sync cron (`new-ideas-mc-sync`) currently invokes the Muse
artifact action `getboard`. After cutover it must read THIS board instead:

- Read: `POST https://ideas.dvaughnhouse.com/actions` with
  `{"action": "getBoard", "args": {}}` (same `{data}` envelope as the
  artifact client), or `GET /api/board`.
- State file (unchanged): `~/workspace/goals/mission-control-dashboard/
  hidden_files/new-ideas-sync-state.json` — never create a second MC
  project for an idea already in it. If an idea leaves `pursuing`, leave
  its MC project alone.
- MC API auth (unchanged): bearer token read at runtime from
  `~/workspace/goals/mission-control-dashboard/hidden_files/mc-api-password`
  — never print or log it. Flat top-level JSON bodies only, curl with a
  browser User-Agent, GET-verify after every POST.

Until the cron is re-pointed, the Muse copy remains the sync source and
the two boards will diverge (new sweeps land on the Mac board; Pursue taps
in the Muse sidebar still sync from there). The Muse daily-sweep cron
(`new-ideas-daily-sweep`, 07:36 ET, `refreshIdeas` on the artifact) should
be disabled after cutover so only the Mac scheduler sweeps.

## Ops

- Start: `bun run server/src/standalone.ts` (or `bun run start`) from
  `~/projects/new-ideas/` on the iMac; service control is `systemctl
  --user {start,stop,restart,status} new-ideas.service`. Health: `curl
  http://127.0.0.1:8091/health`.
- Logs: service stdout/stderr appended to
  `~/projects/new-ideas/server.log` (also `journalctl --user -u
  new-ideas.service`).
- DB snapshot: the Mac `app.db` was snapshotted from the Muse copy with
  the SQLite backup API (safe against live writes) on 2026-11-07 20:04
  ET — 16 ideas (12 archived, 4 new), 2 sweep jobs. Two live sweeps ran
  on the Mac the same night and added ideas 17–20 ("The Ash Router",
  "The Decay Ledger", "The Cremation Slot Exchange", "The Ritual
  Specimen Archive"); board is 20 ideas (12 archived, 8 new) as of
  2026-11-07 20:18 ET. MC sync verified live: idea 13 "The AI Hospice"
  pursued on the Mac board → MC project 65 (+ milestones 23/24/25,
  tasks 279/280), recorded in the sync state file.
- Auth note: the board is public at ideas.dvaughnhouse.com with no login,
  the same exposure as a Muse share link — anyone with the URL can use it,
  including Dismiss/Save/Pursue. If that becomes a problem, the next step
  is Cloudflare Access in front of the tunnel hostname, not a code change.
