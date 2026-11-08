// Actions for New Ideas — an idea-discovery engine.
//
// Pipeline: a battery of live web searches across the user's worlds (the
// "consortium") -> the raw results become the ONLY allowed evidence pool ->
// synthesis produces wild, personalized ideas that must cite that pool ->
// the server drops any evidence item whose URL is not in the pool -> ideas
// are stored as a dated batch. Saved / pursuing ideas are never touched by
// a sweep.
//
// Two entry points run that pipeline:
// - startSweep (the in-page button): the searches + synthesis take longer
//   than one action call survives, so the work runs as a background task
//   (ctx.agent.spawnTask) tracked by a sweep_jobs row. The board polls
//   getSweepStatus for stage progress; the task reports back through
//   completeSweepJob. A task that dies mid-sweep leaves the job row behind,
//   and getSweepStatus reconciles it into a visible, stage-named failure.
// - refreshIdeas (the daily cron): the same pipeline inline in one call.

import {
defineAction,
z,
type ActionsModule,
type Ctx,
} from "@hatch/space-sdk";
import { and, desc, eq, lt } from "drizzle-orm";
import * as schema from "./schema";

// ---------------------------------------------------------------- lenses

export const LENSES = [
  {
    id: "pharma",
    label: "Pharma & supply chain",
    blurb:
      "12 years in clinical research and pharma project work; Glenride researches supply-chain vulnerabilities and drug shortages.",
  },
  {
    id: "ai",
    label: "AI systems & orchestration",
    blurb:
      "Independent AI orchestrator; builds agent fleets, prototypes enterprise software, sells The First Build — a fixed-scope one-week AI workflow build.",
  },
  {
    id: "art",
    label: "Art practice",
    blurb:
      "Independent artist; author of the Glenride camel mark; interested in generative and data-driven work.",
  },
  {
    id: "homelab",
    label: "Homelab & self-hosted",
    blurb:
      "Runs a self-hosted AI homelab and a homelab publication; deep in local models, bots, and sovereign infrastructure.",
  },
  {
    id: "community",
    label: "Community & media",
    blurb:
      "Runs the Prism community and Glenride's Dispatch/digest publications; audiences and distribution already in hand.",
  },
] as const;

const DEFAULT_ACTIVE = ["pharma", "ai", "art", "homelab", "community"];

// ---------------------------------------------------------------- queries

const QUERY_POOL: { lens: string; q: string }[] = [
  { lens: "pharma", q: "FDA drug shortages 2026 pharmaceutical supply chain failures unmet need" },
  { lens: "pharma", q: "CDMO manufacturing capacity shortage biologics market size growth forecast" },
  { lens: "pharma", q: "compounding pharmacy drug shortage market size growth forecast" },
  { lens: "ai", q: "AI implementation consulting small business market size growth 2026 adoption gap" },
  { lens: "ai", q: "underserved SaaS niches 2026 low competition proven demand market gap" },
  { lens: "art", q: "online fine art market size fractional ownership growth forecast" },
  { lens: "art", q: "AI in art market size growth forecast collectors generative art" },
  { lens: "homelab", q: "self-hosted software local AI privacy market growth homelab demand" },
  { lens: "community", q: "weird but profitable niche businesses 2026 underserved markets people actually pay for" },
  { lens: "wild", q: "strangest emerging consumer trends 2026 unusual services growing demand" },
  { lens: "wild", q: "creator economy micro niche subscription market size growth 2026" },
  { lens: "wild", q: "death care pet aftercare unusual industries market size growth overlooked" },
];

export function pickQueries(activeLenses: string[], focus?: string): string[] {
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const wanted = new Set<string>([...activeLenses, "wild"]);
  if (focus) wanted.add(focus);
  const pool = QUERY_POOL.filter((entry) => wanted.has(entry.lens));
  const source = pool.length >= 4 ? pool : QUERY_POOL;
  const picked: string[] = [];
  // Rotate through the pool by day so daily sweeps explore different ground,
  // while guaranteeing each active lens contributes when focused.
  if (focus) {
    for (const entry of source) {
      if (entry.lens === focus && picked.length < 2) picked.push(entry.q);
    }
  }
  let i = dayIndex % source.length;
  while (picked.length < 4 && picked.length < source.length) {
    const entry = source[i % source.length];
    if (entry && !picked.includes(entry.q)) picked.push(entry.q);
    i += 2;
    if (i > source.length * 3) break;
  }
  return picked.slice(0, 4);
}

// ---------------------------------------------------------------- shapes

const evidenceItem = z.object({
  label: z.string(),
  value: z.string(),
  sourceTitle: z.string(),
  sourceUrl: z.string(),
});

const ideaOut = z.object({
  id: z.number(),
  title: z.string(),
  hook: z.string(),
  type: z.string(),
  crazyScore: z.number(),
  whyShyAway: z.string(),
  marketSignal: z.string(),
  upsideCase: z.string(),
  whyForYou: z.string(),
  firstMove: z.string(),
  sevenDayTest: z.string(),
  evidence: z.array(evidenceItem),
  status: z.string(),
  batchLabel: z.string(),
  createdAt: z.string(),
  dismissedAt: z.string().nullable(),
  isCustom: z.boolean(),
});

const synthesizedIdea = z.object({
  title: z.string(),
  hook: z.string(),
  type: z.enum(["business", "art", "hybrid"]),
  crazyScore: z.number().min(1).max(10),
  whyShyAway: z.string(),
  marketSignal: z.string(),
  upsideCase: z.string(),
  whyForYou: z.string(),
  firstMove: z.string(),
  sevenDayTest: z.string(),
  evidence: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      sourceUrl: z.string(),
    }),
  ),
});

const synthesisSchema = z.object({
  ideas: z.array(synthesizedIdea),
});

type EvidenceRow = z.infer<typeof evidenceItem>;

function parseEvidence(json: string): EvidenceRow[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: EvidenceRow[] = [];
    for (const item of parsed) {
      const check = evidenceItem.safeParse(item);
      if (check.success) out.push(check.data);
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadLenses(
  ctx: Ctx,
): Promise<{ active: string[]; note: string }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, "lenses"));
  const row = rows[0];
  if (!row) return { active: [...DEFAULT_ACTIVE], note: "" };
  try {
    const parsed = JSON.parse(row.value) as { active?: unknown; note?: unknown };
    const active = Array.isArray(parsed.active)
      ? parsed.active.filter((x): x is string => typeof x === "string")
      : [...DEFAULT_ACTIVE];
    return {
      active: active.length > 0 ? active : [...DEFAULT_ACTIVE],
      note: typeof parsed.note === "string" ? parsed.note : "",
    };
  } catch {
    return { active: [...DEFAULT_ACTIVE], note: "" };
  }
}

// ---------------------------------------------------------------- sweep jobs

// A running job that has not reported progress in this long is treated as
// stalled: the failure becomes visible instead of spinning forever.
export const SWEEP_STALE_MS = 10 * 60 * 1000;

const sweepJobOut = z.object({
  jobId: z.string(),
  status: z.string(),
  stage: z.string(),
  detail: z.string(),
  added: z.number(),
  batchLabel: z.string(),
  message: z.string(),
  focus: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
});

type SweepJobRow = typeof schema.sweepJobs.$inferSelect;
type SweepJobOut = z.infer<typeof sweepJobOut>;

function jobToOut(job: SweepJobRow): SweepJobOut {
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    detail: job.detail,
    added: job.added,
    batchLabel: job.batchLabel,
    message: job.message,
    focus: job.focus,
    startedAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function stageLabel(stage: string): string {
  switch (stage) {
    case "searching":
      return "search";
    case "synthesizing":
      return "synthesis";
    case "saving":
      return "save";
    case "queued":
      return "startup";
    default:
      return stage;
  }
}

export async function loadJob(ctx: Ctx, jobId: string): Promise<SweepJobRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.sweepJobs)
    .where(eq(schema.sweepJobs.id, jobId))
    .limit(1);
  return rows[0] ?? null;
}

export async function latestJob(ctx: Ctx): Promise<SweepJobRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.sweepJobs)
    .orderBy(desc(schema.sweepJobs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function patchJob(
  ctx: Ctx,
  jobId: string,
  patch: Partial<
    Pick<
      SweepJobRow,
      "status" | "stage" | "detail" | "added" | "batchLabel" | "message" | "taskId"
    >
  >,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db
    .update(schema.sweepJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.sweepJobs.id, jobId));
}

// Shared save step for both sweep entry points: drop evidence whose URL is
// not in the search pool, skip titles already on the board, insert the rest
// as one dated batch.
export async function saveSynthesizedIdeas(
  ctx: Ctx,
  ideas: z.infer<typeof synthesizedIdea>[],
  pool: { title: string; url: string }[],
): Promise<{ added: number; batchLabel: string }> {
  const db = ctx.db<typeof schema>();
  const prior = await db
    .select({ title: schema.ideas.title })
    .from(schema.ideas)
    .orderBy(desc(schema.ideas.id))
    .limit(200);
  const priorTitles = new Set(prior.map((p) => p.title.toLowerCase()));
  const titleByUrl = new Map(pool.map((p) => [p.url, p.title]));
  const batchLabel = `Sweep · ${new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  })}`;
  let added = 0;
  for (const idea of ideas) {
    if (priorTitles.has(idea.title.toLowerCase())) continue;
    const evidence: EvidenceRow[] = [];
    for (const ev of idea.evidence) {
      const sourceTitle = titleByUrl.get(ev.sourceUrl);
      if (!sourceTitle) continue; // URL not in pool — drop, never ship.
      evidence.push({
        label: ev.label,
        value: ev.value,
        sourceTitle,
        sourceUrl: ev.sourceUrl,
      });
    }
    await db.insert(schema.ideas).values({
      title: idea.title,
      hook: idea.hook,
      type: idea.type,
      crazyScore: Math.min(10, Math.max(1, idea.crazyScore)),
      whyShyAway: idea.whyShyAway,
      marketSignal: idea.marketSignal,
      upsideCase: idea.upsideCase,
      whyForYou: idea.whyForYou,
      firstMove: idea.firstMove,
      sevenDayTest: idea.sevenDayTest,
      evidenceJson: JSON.stringify(evidence.slice(0, 3)),
      status: "new",
      batchLabel,
    });
    added += 1;
  }
  return { added, batchLabel };
}

// ---------------------------------------------------------------- actions

type IdeaRow = typeof schema.ideas.$inferSelect;

function ideaToOut(r: IdeaRow): z.infer<typeof ideaOut> {
  return {
    id: r.id,
    title: r.title,
    hook: r.hook,
    type: r.type,
    crazyScore: r.crazyScore,
    whyShyAway: r.whyShyAway,
    marketSignal: r.marketSignal,
    upsideCase: r.upsideCase,
    whyForYou: r.whyForYou,
    firstMove: r.firstMove,
    sevenDayTest: r.sevenDayTest,
    evidence: parseEvidence(r.evidenceJson),
    status: r.status,
    batchLabel: r.batchLabel,
    createdAt: r.createdAt.toISOString(),
    dismissedAt: r.dismissedAt ? r.dismissedAt.toISOString() : null,
    isCustom: r.batchLabel === "Yours",
  };
}

// History retention: dismissed ideas live 30 days from dismissed_at, then
// the daily purge removes them. Only archived rows are ever purged —
// new / saved / pursuing ideas are never touched. Rows archived before
// dismissed_at existed were backfilled at migration time (see 0004:
// they get a full 30 days from when the rule starts being enforced).
export const HISTORY_KEEP_DAYS = 30;

export async function purgeOldDismissed(
  ctx: Ctx,
): Promise<{ purged: number; ids: number[] }> {
  const db = ctx.db<typeof schema>();
  const cutoff = new Date(Date.now() - HISTORY_KEEP_DAYS * 86_400_000);
  const stale = await db
    .select({ id: schema.ideas.id })
    .from(schema.ideas)
    .where(
      and(
        eq(schema.ideas.status, "archived"),
        lt(schema.ideas.dismissedAt, cutoff),
      ),
    );
  const ids = stale.map((r) => r.id);
  for (const id of ids) {
    await db.delete(schema.ideas).where(eq(schema.ideas.id, id));
  }
  return { purged: ids.length, ids };
}


// Shared sweep pipeline (search -> synthesize -> save), used by both the
// inline daily refresh and the background sweep job. onStage reports
// progress for the job-tracked path; the inline path passes none.
export async function runConsortiumSweep(
  ctx: Ctx,
  focus: string | undefined,
  onStage?: (
    stage: "searching" | "synthesizing" | "saving",
    detail: string,
  ) => Promise<void> | void,
): Promise<{
  ok: boolean;
  added: number;
  batchLabel: string;
  message: string;
}> {
const db = ctx.db<typeof schema>();
      const lensState = await loadLenses(ctx);
      const activeLensText = LENSES.filter((l) =>
        lensState.active.includes(l.id),
      )
        .map((l) => `- ${l.label}: ${l.blurb}`)
        .join("\n");

      // 1. Consortium sweep — live searches.
      const queries = pickQueries(lensState.active, focus);
      type PoolItem = { title: string; url: string; snippet: string };
      const pool: PoolItem[] = [];
      let searched = 0;
      const seenUrls = new Set<string>();
      for (const q of queries) {
        searched += 1;
        try {
          const res = await ctx.tool.web_search(q, { language_code: "en" });
          const results = res.content?.results ?? [];
          for (const r of results.slice(0, 3)) {
            if (r.url && !seenUrls.has(r.url)) {
              seenUrls.add(r.url);
              pool.push({
                title: r.title,
                url: r.url,
                snippet: (r.snippet ?? "").slice(0, 550),
              });
            }
          }
        } catch (e) {
          // One failed query must not sink the sweep — but log it so a
          // dead search feed is visible in server.log instead of silent.
          console.error(`[sweep] search failed for "${q}":`, e instanceof Error ? e.message : e);
        }
        await onStage?.(
          "searching",
          `Search ${searched} of ${queries.length} done \u2014 ${pool.length} sources so far`,
        );
      }
      if (pool.length < 4) {
        return {
          ok: false,
          added: 0,
          batchLabel: "",
          message:
            "The sweep came back nearly empty — the search feed looks unavailable right now. Nothing was added; try again in a bit.",
        };
      }

      // 2. Titles to avoid repeating.
      const prior = await db
        .select({ title: schema.ideas.title })
        .from(schema.ideas)
        .orderBy(desc(schema.ideas.id))
        .limit(60);
      const priorTitles = new Set(prior.map((p) => p.title.toLowerCase()));

      // 3. Synthesis — wild ideas, evidence-bound. Two calls of 3 ideas each:
      // a single 6-idea call overruns the inference budget and fails whole.
      const poolText = pool
        .map(
          (p, i) =>
            `[S${i + 1}] ${p.title}\nURL: ${p.url}\n${p.snippet}`,
        )
        .join("\n\n");
      const focusLine = focus
        ? `\nLean this batch toward the lens: ${focus}.`
        : "";
      const briefFor = (mix: string, avoid: string) => `You are the idea engine for D'Vaughn House. Invent NEW ideas he could actually start — ${mix}.

WHO HE IS (his active lenses):
${activeLensText}
${lensState.note ? `\nHis own note for this engine: ${lensState.note}` : ""}${focusLine}

THE BRIEF — read carefully:
- He explicitly wants the CRAZY ones: novel, contrarian, the plays most people shy away from because they sound unhinged, morbid, unfashionable, too niche, or too early. Every idea must score crazyScore 7.5 or higher. If a sensible consultant would suggest it, it does not belong here.
- Cross his worlds against each other and against the evidence: pharma x art, supply chain x community, homelab x media, shortage data x commerce. Collisions are where the gold is.
- Every idea must be anchored to the market evidence below. The "evidence" array on each idea: 1 to 3 items, each with a short label (e.g. "Market size 2026"), the value EXACTLY as stated in the source snippet (e.g. "$15.48B in 2026, $21.01B by 2031"), and sourceUrl copied character-for-character from the pool. Never invent a number, a market size, or a URL. If the pool has no number for an angle, use a qualitative evidence item from a snippet instead of making one up.
- marketSignal: one or two sentences naming the real-world demand the evidence shows.
- upsideCase: the honest bull case — what this becomes if it works, grounded in the evidence's trajectory.
- whyShyAway: name the real reason people avoid this — stigma, regulation, weirdness, technical moat, emotional discomfort. Be specific; this is the feature, not a bug.
- whyForYou: tie the idea to a SPECIFIC asset above — his pharma years, Glenride's shortage research, his agent fleets, his lab, his art practice, his audiences. Generic praise fails.
- firstMove: the concrete first step he could take this week, using tools he already has.
- sevenDayTest: a test completable in 7 days for under $500 that would prove or kill the idea, with what result counts as proof.
- Titles: short, vivid, a little confrontational. Hooks: one sentence that makes the idea impossible to un-hear.

Do NOT repeat or lightly rephrase any of these existing ideas:
${avoid || "(none yet)"}

MARKET EVIDENCE POOL (the only sources you may cite):
${poolText}`;

      await onStage?.("synthesizing", "Crossing the signals into wild ideas");
      // One call of 4 ideas: a 6-idea call overruns the inference budget, and
      // two sequential calls starve the second against the action deadline
      // (both verified empirically). Fall back to a 2-idea call if it throws.
      const avoidBase = [...priorTitles].slice(0, 40).join(" | ");
      let collected: z.infer<typeof synthesisSchema>["ideas"] = [];
      try {
        const part = await ctx.inference.complete(
          briefFor(
            '2 of type "business", 1 of type "art", and 1 of type "hybrid" (art x business) — exactly 4 ideas',
            avoidBase,
          ),
          { schema: synthesisSchema },
        );
        collected = part.ideas;
      } catch {
        try {
          const part = await ctx.inference.complete(
            briefFor(
              '1 of type "business" and 1 of type "hybrid" (art x business) — exactly 2 ideas',
              avoidBase,
            ),
            { schema: synthesisSchema },
          );
          collected = part.ideas;
        } catch {
          collected = [];
        }
      }
      if (collected.length === 0) {
        return {
          ok: false,
          added: 0,
          batchLabel: "",
          message:
            "The sweep found its signals but the synthesis step failed. Nothing was added; run the sweep again.",
        };
      }
      const synthesized = { ideas: collected };

      await onStage?.("saving", "Filing the new dossiers");
      // 4. Validate evidence against the pool, dedupe, save.
      const { added, batchLabel } = await saveSynthesizedIdeas(
        ctx,
        synthesized.ideas,
        pool,
      );
      ctx.invalidateQueries();
      return {
        ok: added > 0,
        added,
        batchLabel,
        message:
          added > 0
            ? `${added} new ideas mined from ${pool.length} live sources.`
            : "The sweep ran but every candidate duplicated an earlier idea. Try a focused sweep.",
      };
    }

export const Actions = {
  getBoard: defineAction({
    description:
      "Returns the idea board: all non-archived ideas newest first, counts, and the user's active personalization lenses.",
    request: z.object({}),
    response: z.object({
      ideas: z.array(ideaOut),
      savedCount: z.number(),
      pursuingCount: z.number(),
      lastBatchLabel: z.string().nullable(),
      lastSweepAt: z.string().nullable(),
      lenses: z.array(
        z.object({ id: z.string(), label: z.string(), blurb: z.string() }),
      ),
      activeLenses: z.array(z.string()),
      lensNote: z.string(),
      sweep: sweepJobOut.nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.ideas)
        .orderBy(desc(schema.ideas.id))
        .limit(200);
      const visible = rows.filter((r) => r.status !== "archived");
      const ideas = visible.map(ideaToOut);
      const newest = rows[0];
      const lensState = await loadLenses(ctx);
      const job = await latestJob(ctx);
      return {
        ideas,
        savedCount: visible.filter((r) => r.status === "saved").length,
        pursuingCount: visible.filter((r) => r.status === "pursuing").length,
        lastBatchLabel: newest ? newest.batchLabel : null,
        lastSweepAt: newest ? newest.createdAt.toISOString() : null,
        lenses: LENSES.map((l) => ({ id: l.id, label: l.label, blurb: l.blurb })),
        activeLenses: lensState.active,
        lensNote: lensState.note,
        sweep: job ? jobToOut(job) : null,
      };
    },
  }),

  refreshIdeas: defineAction({
    description:
      "Runs a fresh consortium sweep: live web searches across the user's active lenses, then synthesizes 6 new wild ideas with source-linked market evidence and saves them as a new batch.",
    request: z.object({
      focus: z.string().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      added: z.number(),
      batchLabel: z.string(),
      message: z.string(),
    }),
    async handler(ctx, args) {
      // The daily sweep is the daily job, so it also enforces the 30-day
      // History rule. Saved / pursuing ideas are never purged.
      await purgeOldDismissed(ctx);
      const result = await runConsortiumSweep(ctx, args.focus);
      ctx.invalidateQueries();
      return result;
},
  }),

  startSweep: defineAction({
    description:
      "Starts a consortium sweep as a background job and returns immediately with a jobId. The board polls getSweepStatus for stage progress; results land on the board when the job completes.",
    request: z.object({
      focus: z.string().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      jobId: z.string(),
      alreadyRunning: z.boolean(),
      message: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();

      // One sweep at a time: a fresh running job is reused, a stalled one
      // is failed out loud and replaced.
      const existing = await latestJob(ctx);
      if (existing && existing.status === "running") {
        const ageMs = Date.now() - existing.updatedAt.getTime();
        if (ageMs < SWEEP_STALE_MS) {
          return {
            ok: true,
            jobId: existing.id,
            alreadyRunning: true,
            message: "A sweep is already running — its progress is below.",
          };
        }
        await patchJob(ctx, existing.id, {
          status: "failed",
          message: `The sweep stalled during the ${stageLabel(existing.stage)} stage and stopped reporting progress. Nothing was added.`,
        });
      }

      const lensState = await loadLenses(ctx);
      const queries = pickQueries(lensState.active, args.focus);
      const activeLensText = LENSES.filter((l) =>
        lensState.active.includes(l.id),
      )
        .map((l) => `- ${l.label}: ${l.blurb}`)
        .join("\n");
      const prior = await db
        .select({ title: schema.ideas.title })
        .from(schema.ideas)
        .orderBy(desc(schema.ideas.id))
        .limit(60);
      const avoid = prior.map((p) => p.title).join(" | ") || "(none yet)";
      const focusLabel = args.focus
        ? (LENSES.find((l) => l.id === args.focus)?.label ?? args.focus)
        : null;

      const jobId = `sweep-${Date.now().toString(36)}-${Math.floor(
        Math.random() * 1_000_000,
      ).toString(36)}`;
      await db.insert(schema.sweepJobs).values({
        id: jobId,
        focus: args.focus ?? null,
        status: "running",
        stage: "queued",
        detail: "Sweep queued — the researcher is warming up.",
      });

      const taskMessage = `You are the research worker for one consortium sweep in the "New Ideas" artifact (slug: new-ideas). Work through the stages IN ORDER and report progress with the artifact's actions as you go. Job id: ${jobId}

STAGE 1 — SEARCHING. Run each of these web searches, in order:
${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}
Keep the top 3 results per search. Build an evidence pool: one entry per result with its exact title, its exact URL (copied character-for-character from the search result), and its snippet text. Dedupe by URL. After each search, call the artifact action "updateSweepStage" with jobId "${jobId}", stage "searching", and a detail like "Search 2 of ${queries.length} done — 6 sources so far" (use the real counts).

STAGE 2 — SYNTHESIZING. Call "updateSweepStage" with { "jobId": "${jobId}", "stage": "synthesizing", "detail": "Crossing the signals into wild ideas" }. Then invent exactly 4 NEW ideas for D'Vaughn House — 2 of type "business", 1 of type "art", 1 of type "hybrid" — from this brief:

WHO HE IS (his active lenses):
${activeLensText}
${lensState.note ? `\nHis own note for this engine: ${lensState.note}` : ""}${focusLabel ? `\nLean this batch toward the lens: ${focusLabel}.` : ""}

THE BRIEF:
- He explicitly wants the CRAZY ones: novel, contrarian, the plays most people shy away from because they sound unhinged, morbid, unfashionable, too niche, or too early. Every idea must have crazyScore 7.5 or higher. If a sensible consultant would suggest it, it does not belong here.
- Cross his worlds against each other and against the evidence: pharma x art, supply chain x community, homelab x media, shortage data x commerce. Collisions are where the gold is.
- Every idea must be anchored to the evidence pool YOU built in stage 1. Each idea's "evidence" array: 1 to 3 items, each with a short label (e.g. "Market size 2026"), the value EXACTLY as stated in the source snippet (e.g. "$15.48B in 2026, $21.01B by 2031"), and sourceUrl copied character-for-character from your pool. Never invent a number, a market size, or a URL. If the pool has no number for an angle, use a qualitative evidence item from a snippet instead of making one up.
- marketSignal: one or two sentences naming the real-world demand the evidence shows.
- upsideCase: the honest bull case — what this becomes if it works, grounded in the evidence's trajectory.
- whyShyAway: name the real reason people avoid this — stigma, regulation, weirdness, technical moat, emotional discomfort. Be specific; this is the feature, not a bug.
- whyForYou: tie the idea to a SPECIFIC asset above — his pharma years, Glenride's shortage research, his agent fleets, his lab, his art practice, his audiences. Generic praise fails.
- firstMove: the concrete first step he could take this week, using tools he already has.
- sevenDayTest: a test completable in 7 days for under $500 that would prove or kill the idea, with what result counts as proof.
- Titles: short, vivid, a little confrontational. Hooks: one sentence that makes the idea impossible to un-hear.
- Do NOT repeat or lightly rephrase any of these existing ideas: ${avoid}

STAGE 3 — SAVING. Call "updateSweepStage" with { "jobId": "${jobId}", "stage": "saving", "detail": "Filing the new dossiers" }. Then finish by calling the artifact action "completeSweepJob" with { "jobId": "${jobId}", "pool": [ { "title", "url", "snippet" } for every pool entry ], "ideas": [ the 4 ideas, each with title, hook, type, crazyScore, whyShyAway, marketSignal, upsideCase, whyForYou, firstMove, sevenDayTest, evidence: [ { label, value, sourceUrl } ] ] }. The server validates every evidence URL against the pool and saves the batch — do not describe the ideas in your reply instead of calling the action; the call IS the deliverable. If a stage fails outright (searches return nothing usable, synthesis impossible), still call "completeSweepJob" with an empty ideas array and empty pool so the failure is recorded, rather than ending silently.`;

      const spawned = await ctx.agent.spawnTask(taskMessage, {
        expectsAction: "completeSweepJob",
        dedupeKey: jobId,
      });
      if (!spawned.ok) {
        await patchJob(ctx, jobId, {
          status: "failed",
          stage: "queued",
          message: `The sweep could not be started — the background worker was unavailable (${spawned.error}). Nothing was added.`,
        });
        return {
          ok: false,
          jobId,
          alreadyRunning: false,
          message:
            "The sweep couldn't start — the background worker was unavailable. Nothing was added; try again.",
        };
      }
      await patchJob(ctx, jobId, { taskId: spawned.taskId });
      ctx.invalidateQueries();
      return {
        ok: true,
        jobId,
        alreadyRunning: false,
        message: "Sweep running — progress shows below as it works.",
      };
    },
  }),

  updateSweepStage: defineAction({
    description:
      "Reports a running sweep job's current stage (called by the sweep worker as it progresses).",
    request: z.object({
      jobId: z.string(),
      stage: z.enum(["searching", "synthesizing", "saving"]),
      detail: z.string().max(300),
    }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const job = await loadJob(ctx, args.jobId);
      if (!job || job.status !== "running") return { ok: false };
      await patchJob(ctx, args.jobId, {
        stage: args.stage,
        detail: args.detail,
      });
      return { ok: true };
    },
  }),

  completeSweepJob: defineAction({
    description:
      "Final step of a background sweep: receives the evidence pool and synthesized ideas, validates every evidence URL against the pool, saves the new batch, and marks the sweep job done (or failed, with the reason, when nothing could be saved).",
    request: z.object({
      jobId: z.string(),
      pool: z
        .array(
          z.object({
            title: z.string(),
            url: z.string(),
            snippet: z.string(),
          }),
        )
        .max(40),
      ideas: z.array(synthesizedIdea).max(8),
    }),
    response: z.object({
      ok: z.boolean(),
      added: z.number(),
      message: z.string(),
    }),
    async handler(ctx, args) {
      const job = await loadJob(ctx, args.jobId);
      if (!job) return { ok: false, added: 0, message: "Unknown sweep job." };
      if (job.status !== "running") {
        return { ok: true, added: job.added, message: job.message };
      }
      if (args.pool.length < 4 || args.ideas.length === 0) {
        const message =
          args.pool.length < 4
            ? "The sweep came back nearly empty — the search feed looks unavailable right now. Nothing was added."
            : "The sweep found its signals but the synthesis step produced no usable ideas. Nothing was added.";
        await patchJob(ctx, args.jobId, {
          status: "failed",
          stage: args.pool.length < 4 ? "searching" : "synthesizing",
          message,
        });
        ctx.invalidateQueries();
        return { ok: false, added: 0, message };
      }
      const { added, batchLabel } = await saveSynthesizedIdeas(
        ctx,
        args.ideas,
        args.pool,
      );
      const message =
        added > 0
          ? `${added} new ideas mined from ${args.pool.length} live sources.`
          : "The sweep ran but every candidate duplicated an earlier idea. Try a focused sweep.";
      await patchJob(ctx, args.jobId, {
        status: "done",
        stage: "done",
        detail: "",
        added,
        batchLabel,
        message,
      });
      ctx.invalidateQueries();
      return { ok: added > 0, added, message };
    },
  }),

  getSweepStatus: defineAction({
    description:
      "Returns one sweep job's status and stage. If the background worker died or stalled without finishing, the job is reconciled into a visible failure naming the stage it stopped at.",
    request: z.object({
      jobId: z.string(),
    }),
    response: z.object({
      ok: z.boolean(),
      job: sweepJobOut.nullable(),
      error: z.string().nullable(),
    }),
    async handler(ctx, args) {
      let job = await loadJob(ctx, args.jobId);
      if (!job) {
        return { ok: false, job: null, error: "That sweep job no longer exists." };
      }
      if (job.status === "running") {
        let workerGone = false;
        let workerNote = "";
        if (job.taskId) {
          try {
            const st = await ctx.agent.status(job.taskId);
            if (st.status === "failed") {
              workerGone = true;
              workerNote = st.failureReason ?? st.finalResponse ?? "";
            } else if (
              st.status === "completed" &&
              st.returnContractStatus === "unsatisfied"
            ) {
              workerGone = true;
              workerNote = st.finalResponse ?? "";
            } else if (st.status === "not_found") {
              workerGone = true;
            }
          } catch {
            // Status read is best-effort; the staleness check still applies.
          }
        }
        const stale = Date.now() - job.updatedAt.getTime() > SWEEP_STALE_MS;
        if (workerGone || stale) {
          const message = workerGone
            ? `The sweep stopped during the ${stageLabel(job.stage)} stage before it could save anything${workerNote ? ` — ${workerNote.slice(0, 200)}` : ""}. Nothing was added.`
            : `The sweep stalled during the ${stageLabel(job.stage)} stage and stopped reporting progress. Nothing was added.`;
          await patchJob(ctx, job.id, { status: "failed", message });
          job = (await loadJob(ctx, job.id)) ?? job;
          ctx.invalidateQueries();
        }
      }
      return { ok: true, job: jobToOut(job), error: null };
    },
  }),

  updateStatus: defineAction({
    description:
      "Sets an idea's status: new, saved, pursuing, or archived (dismissed).",
    request: z.object({
      id: z.number().int().positive(),
      status: z.enum(["new", "saved", "pursuing", "archived"]),
    }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Dismissing is a soft-archive, never a delete: stamping dismissed_at
      // starts the 30-day History clock. Restoring clears the stamp.
      await db
        .update(schema.ideas)
        .set(
          args.status === "archived"
            ? { status: args.status, dismissedAt: new Date() }
            : { status: args.status, dismissedAt: null },
        )
        .where(eq(schema.ideas.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getHistory: defineAction({
    description:
      "Returns dismissed (archived) ideas newest-dismissed first, with the date each was dismissed. Dismissed ideas are kept 30 days, then removed automatically; saved and pursuing ideas are never purged.",
    request: z.object({}),
    response: z.object({
      ideas: z.array(ideaOut),
      archivedCount: z.number(),
      purgeAfterDays: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.ideas)
        .where(eq(schema.ideas.status, "archived"))
        .orderBy(desc(schema.ideas.dismissedAt), desc(schema.ideas.id))
        .limit(200);
      return {
        ideas: rows.map(ideaToOut),
        archivedCount: rows.length,
        purgeAfterDays: HISTORY_KEEP_DAYS,
      };
    },
  }),

  purgeDismissedIdeas: defineAction({
    description:
      "Deletes dismissed ideas older than 30 days (the History retention rule). Only archived rows with a dismissed_at older than 30 days are removed; new, saved, and pursuing ideas are never touched.",
    request: z.object({}),
    response: z.object({
      purged: z.number(),
      ids: z.array(z.number()),
    }),
    async handler(ctx) {
      const result = await purgeOldDismissed(ctx);
      ctx.invalidateQueries();
      return result;
    },
  }),

  addCustomIdea: defineAction({
    description: "Adds one of the user's own wild ideas to the board.",
    request: z.object({
      title: z.string().min(1).max(140),
      hook: z.string().min(1).max(400),
      type: z.enum(["business", "art", "hybrid"]),
      crazyScore: z.number().min(1).max(10).default(8),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.ideas)
        .values({
          title: args.title,
          hook: args.hook,
          type: args.type,
          crazyScore: args.crazyScore,
          status: "saved",
          batchLabel: "Yours",
          evidenceJson: "[]",
        })
        .returning({ id: schema.ideas.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addCustomIdea: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  updateLenses: defineAction({
    description:
      "Saves which personalization lenses are active and the user's free-text note for future sweeps.",
    request: z.object({
      active: z.array(z.string()).min(1),
      note: z.string().max(600),
    }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const valid = args.active.filter((a) =>
        LENSES.some((l) => l.id === a),
      );
      const value = JSON.stringify({
        active: valid.length > 0 ? valid : [...DEFAULT_ACTIVE],
        note: args.note,
      });
      await db
        .insert(schema.settings)
        .values({ key: "lenses", value })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
