// Standalone Bun server for New Ideas — the iMac port of the Hatch TS space.
//
// What it is: the same React client (client/dist) and the same server
// actions (server/src/actions.ts), served by Bun on the iMac instead of the
// Hatch runtime. The Hatch-only pieces of the action context are shimmed:
//   - ctx.db            -> drizzle over bun:sqlite (the same app.db)
//   - ctx.tool.web_search -> DuckDuckGo Lite (adapters.ts, no key)
//   - ctx.inference.complete -> LM Studio on the Mac Studio (adapters.ts)
//   - ctx.agent.spawnTask -> in-process background sweep (runSweepJob)
//   - ctx.invalidateQueries -> no-op (the client refetches on its own)
//
// The Muse sidebar copy keeps running untouched; this server is an addition
// until D'Vaughn says otherwise. Source of truth for Mission Control sync:
// THIS server once the sync cron is re-pointed at it (see app/README.md).
//
// Env: PORT (default 8091), HOST (default 127.0.0.1 — the Cloudflare Tunnel
// reaches it on localhost, same as Ghost on :2368), DB_PATH (default
// <project>/app.db), LM_BASE_URL, LM_MODEL.

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Actions,
  loadJob,
  patchJob,
  runConsortiumSweep,
} from "./actions";
import type { Ctx } from "@hatch/space-sdk";
import * as schema from "./schema";
import { webSearch, inferenceComplete } from "./adapters";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PORT ?? 8091);
const HOST = process.env.HOST ?? "127.0.0.1";
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "app.db");

// ---------------------------------------------------------------- database

const sqlite = new Database(DB_PATH);
sqlite.exec("PRAGMA journal_mode=WAL;");
const db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder: join(ROOT, "drizzle") });

// ---------------------------------------------------------------- ctx shim

let ctx!: Ctx;

async function runSweepJob(jobId: string): Promise<void> {
  const job = await loadJob(ctx, jobId);
  if (!job || job.status !== "running") return;
  try {
    const result = await runConsortiumSweep(
      ctx,
      job.focus ?? undefined,
      async (stage, detail) => {
        await patchJob(ctx, jobId, { stage, detail });
      },
    );
    await patchJob(ctx, jobId, {
      status: result.ok ? "done" : "failed",
      stage: "done",
      detail: "",
      added: result.added,
      batchLabel: result.batchLabel,
      message: result.message,
    });
  } catch (err) {
    await patchJob(ctx, jobId, {
      status: "failed",
      message: `Sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function buildCtx(): Ctx {
  const shim: Record<string, unknown> = {
    db: () => db,
    tool: {
      web_search: async (query: string, _opts?: unknown) =>
        webSearch(query),
    },
    inference: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      complete: async (prompt: string, opts: { schema: any }) =>
        inferenceComplete(prompt, opts),
    },
    agent: {
      spawnTask: async (
        _message: string,
        opts: { dedupeKey?: string; expectsAction?: string },
      ) => {
        const jobId =
          opts?.dedupeKey ?? `sweep-${Date.now().toString(36)}`;
        void runSweepJob(jobId);
        return { ok: true, taskId: jobId };
      },
      status: async (taskId: string) => {
        const job = await loadJob(ctx, taskId);
        if (!job) return { status: "not_found" };
        if (job.status === "done")
          return {
            status: "completed",
            returnContractStatus: "satisfied",
            finalResponse: job.message,
          };
        if (job.status === "failed")
          return {
            status: "failed",
            failureReason: job.message,
            finalResponse: job.message,
          };
        return { status: "running" };
      },
    },
    invalidateQueries: () => {},
  };
  return shim as unknown as Ctx;
}

ctx = buildCtx();

// ---------------------------------------------------------------- actions

type ActionDef = {
  request?: { parse: (v: unknown) => unknown };
  response?: { parse: (v: unknown) => unknown };
  handler: (ctx: Ctx, args: never) => Promise<unknown>;
};

async function dispatchAction(
  action: string,
  args: unknown,
): Promise<{ status: number; body: unknown }> {
  const def = (Actions as Record<string, ActionDef>)[action];
  if (!def) return { status: 404, body: { error: `Unknown action: ${action}` } };
  try {
    const parsedArgs = def.request ? def.request.parse(args ?? {}) : {};
    const result = await def.handler(ctx, parsedArgs as never);
    const data = def.response ? def.response.parse(result) : result;
    return { status: 200, body: { data } };
  } catch (err) {
    return {
      status: 500,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ---------------------------------------------------------------- daily sweep

// The Muse daily cron (07:36 ET, refreshIdeas) stays pointed at the Muse
// copy until the parent disables it after cutover. This server runs its own
// 07:36 ET sweep so the Mac board refreshes itself; the purge of dismissed
// ideas older than 30 days runs inside refreshIdeas.
let dailyRunning = false;
let lastDailySweepDate = "";

async function maybeDailySweep(now = new Date()): Promise<void> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const today = `${get("year")}-${get("month")}-${get("day")}`;
  const hm = `${get("hour")}:${get("minute")}`;
  if (hm < "07:36" || today === lastDailySweepDate || dailyRunning) return;
  dailyRunning = true;
  lastDailySweepDate = today;
  try {
    const started = new Date().toISOString();
    console.log(`[sweep] daily sweep starting (${today} ET)`);
    const res = await dispatchAction("refreshIdeas", {});
    console.log(`[sweep] daily sweep finished at ${started}:`, JSON.stringify(res.body));
  } catch (err) {
    console.error("[sweep] daily sweep failed:", err);
  } finally {
    dailyRunning = false;
  }
}

setInterval(() => void maybeDailySweep(), 60_000);

// ---------------------------------------------------------------- http

const CLIENT_DIST = join(ROOT, "client", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function boardCounts() {
  const rows = await db.select().from(schema.ideas);
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const newest = rows.length > 0 ? Math.max(...rows.map((r) => r.id)) : 0;
  return { total: rows.length, byStatus, newestId: newest };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/actions") {
        const body = (await req.json().catch(() => ({}))) as {
          action?: string;
          args?: unknown;
        };
        const { status, body: out } = await dispatchAction(
          body.action ?? "",
          body.args ?? {},
        );
        return Response.json(out, { status });
      }
      if (req.method === "GET" && url.pathname === "/health") {
        const counts = await boardCounts();
        return Response.json({
          ok: true,
          service: "new-ideas-standalone",
          port: PORT,
          uptimeSec: Math.floor(process.uptime()),
          ...counts,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/board") {
        const { status, body: out } = await dispatchAction("getBoard", {});
        return Response.json(out, { status });
      }
      if (req.method === "GET" && url.pathname === "/api/history") {
        const { status, body: out } = await dispatchAction("getHistory", {});
        return Response.json(out, { status });
      }
      if (req.method === "GET") {
        const rel =
          url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
        const file = Bun.file(join(CLIENT_DIST, rel));
        if (await file.exists()) {
          const ext = rel.slice(rel.lastIndexOf("."));
          return new Response(file, {
            headers: {
              "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
            },
          });
        }
        // SPA fallback.
        const index = Bun.file(join(CLIENT_DIST, "index.html"));
        return new Response(index, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("[http]", err);
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
});

const counts = await boardCounts();
console.log(
  `[new-ideas] listening on http://${HOST}:${PORT} — db ${DB_PATH} — ideas ${counts.total} ${JSON.stringify(counts.byStatus)}`,
);
console.log(
  `[new-ideas] daily sweep 07:36 America/New_York (in-process) + 30-day History purge inside refreshIdeas`,
);
console.log(`[new-ideas] LM ${process.env.LM_BASE_URL ?? "http://100.70.123.107:1234/v1"} model ${process.env.LM_MODEL ?? "qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive"}`);

export { server };
