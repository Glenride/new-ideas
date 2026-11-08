import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Board = ApiResponse<typeof api, "getBoard">;
type Idea = Board["ideas"][number];
type SweepJob = NonNullable<Board["sweep"]>;

const SWEEP_STAGES = ["searching", "synthesizing", "saving"] as const;

function sweepStageText(job: SweepJob): string {
  switch (job.stage) {
    case "searching":
      return "SEARCHING LIVE SOURCES";
    case "synthesizing":
      return "SYNTHESIZING — CROSSING THE SIGNALS";
    case "saving":
      return "SAVING THE NEW BATCH";
    case "done":
      return "SWEEP COMPLETE";
    default:
      return "SWEEP QUEUED";
  }
}

function sweepStageIndex(stage: string): number {
  const idx = (SWEEP_STAGES as readonly string[]).indexOf(stage);
  return idx === -1 ? 0 : idx;
}

type Filter = "all" | "business" | "art" | "hybrid" | "vault" | "history";

const TYPE_STAMP: Record<string, string> = {
  business: "BUSINESS",
  art: "ART",
  hybrid: "ART × BUSINESS",
};

function daysLeft(dismissedAt: string | null, purgeAfterDays: number): number | null {
  if (!dismissedAt) return purgeAfterDays;
  const ms = Date.now() - new Date(dismissedAt).getTime();
  return Math.max(0, purgeAfterDays - Math.floor(ms / 86_400_000));
}

function fmtDismissed(dismissedAt: string | null): string {
  if (!dismissedAt) return "Dismissed";
  return `Dismissed ${new Date(dismissedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  })}`;
}

function crazyWord(score: number): string {
  if (score >= 9.5) return "CERTIFIABLE";
  if (score >= 9) return "UNHINGED";
  if (score >= 8.5) return "DERANGED";
  if (score >= 8) return "RECKLESS";
  if (score >= 7) return "BOLD";
  return "TAME";
}

function CrazyMeter({ score, big }: { score: number; big?: boolean }) {
  return (
    <div className={big ? "min-w-36" : "min-w-28"}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-data text-[10px] tracking-widest text-[var(--dim)]">
          CRAZY INDEX
        </span>
        <span
          className={`font-data font-bold text-[var(--heat)] ${big ? "text-2xl" : "text-sm"}`}
        >
          {score.toFixed(1)}
        </span>
      </div>
      <div
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[var(--border)]"
        role="img"
        aria-label={`Crazy index ${score.toFixed(1)} out of 10 — ${crazyWord(score)}`}
      >
        <div
          className="h-full rounded-full bg-[var(--heat)]"
          style={{ width: `${Math.min(100, score * 10)}%` }}
        />
      </div>
      <p className="font-data mt-1 text-[10px] tracking-widest text-[var(--heat)]">
        {crazyWord(score)}
      </p>
    </div>
  );
}

function EvidenceList({ idea, compact }: { idea: Idea; compact?: boolean }) {
  const items = compact ? idea.evidence.slice(0, 2) : idea.evidence;
  if (items.length === 0) return null;
  return (
    <ul className="mt-3 space-y-2">
      {items.map((ev, i) => (
        <li
          key={`${ev.sourceUrl}-${i}`}
          className="border-l-2 border-[var(--accent)] pl-3"
        >
          <span className="font-data text-[10px] tracking-widest text-[var(--dim)] uppercase">
            {ev.label}
          </span>
          <p className="text-sm font-medium text-[var(--text)]">{ev.value}</p>
          <a
            href={ev.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="font-data text-[11px] text-[var(--accent)] underline decoration-dotted underline-offset-2"
          >
            {ev.sourceTitle} ↗
          </a>
        </li>
      ))}
    </ul>
  );
}

function StatusButtons({
  idea,
  onStatus,
  busy,
}: {
  idea: Idea;
  onStatus: (id: number, status: "saved" | "pursuing" | "archived" | "new") => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {idea.status !== "pursuing" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onStatus(idea.id, "pursuing")}
          className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-50"
        >
          I'm pursuing this
        </button>
      ) : (
        <span className="font-data rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-bold tracking-widest text-[var(--accent-ink)]">
          IN PURSUIT
        </span>
      )}
      {idea.status === "saved" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onStatus(idea.id, "new")}
          className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)] disabled:opacity-50"
        >
          Unsave
        </button>
      ) : idea.status !== "pursuing" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onStatus(idea.id, "saved")}
          className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)] disabled:opacity-50"
        >
          Save to vault
        </button>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => onStatus(idea.id, "archived")}
        className="rounded-md px-3 py-2 text-sm text-[var(--dim)] disabled:opacity-50"
      >
        Dismiss
      </button>
    </div>
  );
}

function DetailBlock({ label, children, heat }: { label: string; children: string; heat?: boolean }) {
  if (!children) return null;
  return (
    <div>
      <p
        className={`font-data text-[10px] tracking-widest ${heat ? "text-[var(--heat)]" : "text-[var(--dim)]"}`}
      >
        {label}
      </p>
      <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">{children}</p>
    </div>
  );
}

function IdeaCard({
  idea,
  expanded,
  onToggle,
  onStatus,
  busy,
  history,
  purgeAfterDays,
}: {
  idea: Idea;
  expanded: boolean;
  onToggle: () => void;
  onStatus: (id: number, status: "saved" | "pursuing" | "archived" | "new") => void;
  busy: boolean;
  history?: boolean;
  purgeAfterDays?: number;
}) {
  const left = history
    ? daysLeft(idea.dismissedAt, purgeAfterDays ?? 30)
    : null;
  return (
    <article className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-data rounded-sm bg-[var(--surface2)] px-2 py-1 text-[10px] font-bold tracking-widest text-[var(--text)]">
            {TYPE_STAMP[idea.type] ?? idea.type.toUpperCase()}
          </span>
          {idea.status === "saved" && (
            <span className="font-data rounded-sm border border-[var(--accent)] px-2 py-1 text-[10px] tracking-widest text-[var(--accent)]">
              IN VAULT
            </span>
          )}
          <span className="font-data text-[10px] tracking-widest text-[var(--dim)]">
            {idea.batchLabel.toUpperCase()}
          </span>
        </div>
        <CrazyMeter score={idea.crazyScore} />
      </div>

      <h3 className="font-display mt-3 text-2xl leading-tight font-semibold text-[var(--text)]">
        {idea.title}
      </h3>
      <p className="mt-1 text-base leading-relaxed text-[var(--text)]">{idea.hook}</p>

      {idea.marketSignal && (
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
          <span className="font-data text-[10px] tracking-widest text-[var(--accent)]">
            THE SIGNAL —{" "}
          </span>
          {idea.marketSignal}
        </p>
      )}
      <EvidenceList idea={idea} compact={!expanded} />

      {expanded && (
        <div className="mt-4 grid gap-4 border-t border-dashed border-[var(--border)] pt-4 sm:grid-cols-2">
          <DetailBlock label="WHY PEOPLE SHY AWAY" heat>
            {idea.whyShyAway}
          </DetailBlock>
          <DetailBlock label="THE UPSIDE">{idea.upsideCase}</DetailBlock>
          <DetailBlock label="WHY THIS FITS YOU">{idea.whyForYou}</DetailBlock>
          <DetailBlock label="FIRST MOVE">{idea.firstMove}</DetailBlock>
          <div className="sm:col-span-2">
            <DetailBlock label="THE 7-DAY TEST — UNDER $500">{idea.sevenDayTest}</DetailBlock>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {history ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-data text-xs tracking-widest text-[var(--dim)]">
              {fmtDismissed(idea.dismissedAt)} ·{" "}
              {left === null
                ? "kept 30 days"
                : left === 0
                  ? "removed today"
                  : `gone in ${left} day${left === 1 ? "" : "s"}`}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onStatus(idea.id, "new")}
              className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-50"
            >
              Restore to board
            </button>
          </div>
        ) : (
          <StatusButtons idea={idea} onStatus={onStatus} busy={busy} />
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="font-data text-xs tracking-widest text-[var(--accent)] underline decoration-dotted underline-offset-4"
        >
          {expanded ? "CLOSE THE FILE ↑" : "OPEN THE FILE ↓"}
        </button>
      </div>
    </article>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showLenses, setShowLenses] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  // Sweep job tracking: the sweep runs in the background; this page starts
  // it, then polls the job row until it lands or visibly fails.
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  const handledJobRef = useRef<string | null>(null);

  // Add-your-own form state
  const [newTitle, setNewTitle] = useState("");
  const [newHook, setNewHook] = useState("");
  const [newType, setNewType] = useState<"business" | "art" | "hybrid">("hybrid");
  const [newCrazy, setNewCrazy] = useState(8);

  // Lens draft state (seeded from server data when the panel opens)
  const [lensDraft, setLensDraft] = useState<string[] | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);

  const board = useQuery({
    queryKey: ["board"],
    queryFn: () => api.getBoard({}),
  });

  const historyQuery = useQuery({
    queryKey: ["history"],
    queryFn: () => api.getHistory({}),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["board"] });
    void queryClient.invalidateQueries({ queryKey: ["history"] });
  };

  const data0 = board.data;
  const trackedJobId = jobId ?? data0?.sweep?.jobId ?? null;

  const sweepStatus = useQuery({
    queryKey: ["sweep-status", trackedJobId],
    queryFn: () => api.getSweepStatus({ jobId: trackedJobId as string }),
    enabled: !!trackedJobId,
    refetchInterval: (query) =>
      query.state.data?.job && query.state.data.job.status !== "running"
        ? false
        : 4000,
  });

  const polledJob = sweepStatus.data?.job ?? null;
  const boardJob =
    data0?.sweep && data0.sweep.jobId === trackedJobId ? data0.sweep : null;
  const rawJob = polledJob ?? boardJob;
  const displayJob =
    rawJob && dismissedJobId !== rawJob.jobId ? rawJob : null;
  const sweepRunning = rawJob?.status === "running";

  // When a sweep lands, refresh the board once per job and surface the new
  // batch; failures just refresh so the failure banner is current.
  useEffect(() => {
    const j = sweepStatus.data?.job;
    if (!j || j.status === "running") return;
    const key = `${j.jobId}:${j.status}`;
    if (handledJobRef.current === key) return;
    handledJobRef.current = key;
    if (j.status === "done" && j.added > 0) {
      setFilter("all");
      setExpandedId(null);
    }
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepStatus.data]);

  const startSweep = useMutation({
    mutationFn: (focus?: string) => api.startSweep(focus ? { focus } : {}),
    onSuccess: (res) => {
      setStartError(null);
      if (res.jobId) {
        setJobId(res.jobId);
        setDismissedJobId(null);
      }
      if (!res.ok) setStartError(res.message);
      invalidate();
    },
    onError: () =>
      setStartError(
        "The sweep couldn't even start — the request never got through. Check your connection and retry.",
      ),
  });
  const sweepBusy = startSweep.isPending || sweepRunning;

  const statusMut = useMutation({
    mutationFn: (args: {
      id: number;
      status: "saved" | "pursuing" | "archived" | "new";
    }) => api.updateStatus(args),
    onSuccess: invalidate,
  });

  const addMut = useMutation({
    mutationFn: () =>
      api.addCustomIdea({
        title: newTitle.trim(),
        hook: newHook.trim(),
        type: newType,
        crazyScore: newCrazy,
      }),
    onSuccess: () => {
      setNewTitle("");
      setNewHook("");
      setShowAdd(false);
      setFilter("vault");
      invalidate();
    },
  });

  const lensMut = useMutation({
    mutationFn: (args: { active: string[]; note: string }) =>
      api.updateLenses(args),
    onSuccess: () => {
      setShowLenses(false);
      setLensDraft(null);
      setNoteDraft(null);
      invalidate();
    },
  });

  const data = board.data;
  const ideas = data?.ideas ?? [];
  const latestBatch = data?.lastBatchLabel ?? null;
  const featured =
    ideas
      .filter((i) => i.batchLabel === latestBatch && !i.isCustom)
      .sort((a, b) => b.crazyScore - a.crazyScore)[0] ??
    [...ideas].sort((a, b) => b.crazyScore - a.crazyScore)[0];

  const filtered = ideas.filter((i) => {
    if (filter === "vault") return i.status === "saved" || i.status === "pursuing";
    if (filter === "all") return true;
    return i.type === filter;
  });
  const feedIdeas =
    filter === "all" && featured
      ? filtered.filter((i) => i.id !== featured.id)
      : filtered;

  const onStatus = (
    id: number,
    status: "saved" | "pursuing" | "archived" | "new",
  ) => statusMut.mutate({ id, status });

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "All ideas" },
    { id: "business", label: "Business" },
    { id: "art", label: "Art" },
    { id: "hybrid", label: "Hybrids" },
    { id: "vault", label: `Vault (${(data?.savedCount ?? 0) + (data?.pursuingCount ?? 0)})` },
    { id: "history", label: `History (${historyQuery.data?.archivedCount ?? 0})` },
  ];

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pt-6 pb-16">
        {/* Console strip */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-data text-[11px] tracking-[0.2em] text-[var(--accent)]">
              THE CONSORTIUM SWEEP
            </p>
            <p className="font-data mt-1 text-xs text-[var(--dim)]">
              {data?.lastSweepAt
                ? `LAST SWEEP ${new Date(data.lastSweepAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: "America/New_York",
                  })} ET · ${ideas.length} IDEAS ON THE BOARD`
                : "NO SWEEP YET"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                if (data && lensDraft === null) {
                  setLensDraft(data.activeLenses);
                  setNoteDraft(data.lensNote);
                }
                setShowLenses((v) => !v);
              }}
              aria-expanded={showLenses}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
            >
              Tune my lenses
            </button>
            <button
              type="button"
              onClick={() => setShowAdd((v) => !v)}
              aria-expanded={showAdd}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
            >
              Add my own
            </button>
            <button
              type="button"
              disabled={sweepBusy}
              onClick={() => startSweep.mutate(undefined)}
              className="rounded-md bg-[var(--heat)] px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
            >
              {startSweep.isPending
                ? "Starting…"
                : sweepRunning
                  ? "Sweep running…"
                  : "Run a fresh sweep"}
            </button>
          </div>
        </div>

        {startError && (
          <div
            className="mt-3 rounded-md border border-[var(--heat)] bg-[var(--surface)] px-3 py-2"
            role="alert"
          >
            <p className="text-sm text-[var(--text)]">{startError}</p>
            <button
              type="button"
              disabled={sweepBusy}
              onClick={() => startSweep.mutate(undefined)}
              className="mt-2 rounded-md bg-[var(--heat)] px-3 py-1.5 text-sm font-bold text-white disabled:opacity-60"
            >
              Retry the sweep
            </button>
          </div>
        )}

        {displayJob?.status === "running" && (
          <div
            className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
            role="status"
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-data text-xs font-bold tracking-widest text-[var(--heat)]">
                {sweepStageText(displayJob)}
              </p>
              <p className="font-data text-[10px] tracking-widest text-[var(--dim)]">
                STEP {sweepStageIndex(displayJob.stage) + 1} OF 3
              </p>
            </div>
            <div
              className="mt-2 flex gap-1"
              role="img"
              aria-label={`Sweep stage ${sweepStageIndex(displayJob.stage) + 1} of 3: ${sweepStageText(displayJob)}`}
            >
              {SWEEP_STAGES.map((s, i) => (
                <div
                  key={s}
                  className={`h-1.5 flex-1 rounded-full ${
                    i <= sweepStageIndex(displayJob.stage)
                      ? "bg-[var(--heat)]"
                      : "bg-[var(--border)]"
                  }`}
                />
              ))}
            </div>
            <p className="mt-2 text-sm text-[var(--dim)]">
              {displayJob.detail ||
                "Mining live sources and crossing them against your world — a sweep takes a minute or two. You can leave this page; the sweep keeps running."}
            </p>
          </div>
        )}

        {displayJob?.status === "failed" && (
          <div
            className="mt-3 rounded-md border border-[var(--heat)] bg-[var(--surface)] px-3 py-3"
            role="alert"
          >
            <p className="font-data text-xs font-bold tracking-widest text-[var(--heat)]">
              THE SWEEP FAILED
            </p>
            <p className="mt-1 text-sm text-[var(--text)]">
              {displayJob.message}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={sweepBusy}
                onClick={() =>
                  startSweep.mutate(displayJob.focus ?? undefined)
                }
                className="rounded-md bg-[var(--heat)] px-3 py-1.5 text-sm font-bold text-white disabled:opacity-60"
              >
                Retry the sweep
              </button>
              <button
                type="button"
                onClick={() => setDismissedJobId(displayJob.jobId)}
                className="rounded-md px-3 py-1.5 text-sm text-[var(--dim)]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {displayJob?.status === "done" && (
          <div
            className="mt-3 flex items-start justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            role="status"
          >
            <p className="text-sm">{displayJob.message}</p>
            <button
              type="button"
              onClick={() => setDismissedJobId(displayJob.jobId)}
              aria-label="Dismiss sweep result"
              className="font-data px-1 text-sm text-[var(--dim)]"
            >
              ×
            </button>
          </div>
        )}

        {/* Lenses panel */}
        {showLenses && data && (
          <section
            aria-label="Personalization lenses"
            className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <h2 className="font-display text-xl font-semibold">
              What the engine knows about you
            </h2>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Active lenses steer every sweep — ideas are built from these
              worlds and argued against your actual assets.
            </p>
            <div className="mt-3 space-y-2">
              {data.lenses.map((lens) => {
                const active = (lensDraft ?? data.activeLenses).includes(lens.id);
                return (
                  <label
                    key={lens.id}
                    className="flex cursor-pointer items-start gap-3 rounded-md border border-[var(--border)] bg-[var(--surface2)] p-3"
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      aria-label={`Lens: ${lens.label}`}
                      onChange={() =>
                        setLensDraft((prev) => {
                          const base = prev ?? data.activeLenses;
                          return active
                            ? base.filter((x) => x !== lens.id)
                            : [...base, lens.id];
                        })
                      }
                      className="mt-1 h-4 w-4 accent-[var(--accent)]"
                    />
                    <span>
                      <span className="block text-sm font-semibold">{lens.label}</span>
                      <span className="block text-sm text-[var(--dim)]">{lens.blurb}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <label className="mt-4 block">
              <span className="font-data text-[10px] tracking-widest text-[var(--dim)]">
                STEER THE ENGINE — A NOTE IN YOUR WORDS
              </span>
              <textarea
                value={noteDraft ?? data.lensNote}
                onChange={(e) => setNoteDraft(e.target.value)}
                rows={3}
                maxLength={600}
                placeholder="e.g. Lean harder into things I can sell to hospitals. Nothing that needs a storefront."
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface2)] p-3 text-sm text-[var(--text)]"
              />
            </label>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={lensMut.isPending || (lensDraft ?? data.activeLenses).length === 0}
                onClick={() =>
                  lensMut.mutate({
                    active: lensDraft ?? data.activeLenses,
                    note: noteDraft ?? data.lensNote,
                  })
                }
                className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-50"
              >
                Save lenses
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLenses(false);
                  setLensDraft(null);
                  setNoteDraft(null);
                }}
                className="rounded-md px-3 py-2 text-sm text-[var(--dim)]"
              >
                Cancel
              </button>
            </div>
          </section>
        )}

        {/* Add your own */}
        {showAdd && (
          <section
            aria-label="Add your own idea"
            className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <h2 className="font-display text-xl font-semibold">
              Your own wild one
            </h2>
            <label className="mt-3 block">
              <span className="font-data text-[10px] tracking-widest text-[var(--dim)]">
                TITLE
              </span>
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                maxLength={140}
                placeholder="Name it like you mean it"
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface2)] p-3 text-sm"
              />
            </label>
            <label className="mt-3 block">
              <span className="font-data text-[10px] tracking-widest text-[var(--dim)]">
                THE HOOK — ONE SENTENCE
              </span>
              <textarea
                value={newHook}
                onChange={(e) => setNewHook(e.target.value)}
                rows={2}
                maxLength={400}
                placeholder="The sentence that makes it impossible to un-hear"
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface2)] p-3 text-sm"
              />
            </label>
            <div className="mt-3 flex flex-wrap items-end gap-4">
              <label className="block">
                <span className="font-data text-[10px] tracking-widest text-[var(--dim)]">
                  KIND
                </span>
                <select
                  value={newType}
                  onChange={(e) =>
                    setNewType(e.target.value as "business" | "art" | "hybrid")
                  }
                  aria-label="Idea kind"
                  className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface2)] p-2 text-sm"
                >
                  <option value="business">Business</option>
                  <option value="art">Art</option>
                  <option value="hybrid">Art × Business</option>
                </select>
              </label>
              <label className="block grow">
                <span className="font-data text-[10px] tracking-widest text-[var(--dim)]">
                  HOW CRAZY — {newCrazy.toFixed(0)}/10
                </span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={newCrazy}
                  onChange={(e) => setNewCrazy(Number(e.target.value))}
                  aria-label="Crazy index"
                  className="mt-2 w-full accent-[var(--heat)]"
                />
              </label>
              <button
                type="button"
                disabled={
                  addMut.isPending || !newTitle.trim() || !newHook.trim()
                }
                onClick={() => addMut.mutate()}
                className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-50"
              >
                Put it in the vault
              </button>
            </div>
          </section>
        )}

        {/* Loading / error / empty */}
        {board.isPending && (
          <p className="py-16 text-center text-sm text-[var(--dim)]">
            Opening the files…
          </p>
        )}
        {board.isError && (
          <div className="py-16 text-center">
            <p className="text-sm text-[var(--dim)]">
              The board wouldn't load.
            </p>
            <button
              type="button"
              onClick={() => board.refetch()}
              className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm"
            >
              Try again
            </button>
          </div>
        )}

        {data && ideas.length === 0 && (
          <div className="py-14 text-center">
            <p className="font-display text-3xl font-semibold">
              No wild ideas on the board yet.
            </p>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--dim)]">
              Run the first sweep and the engine will mine live market data
              across pharma, AI, art, and your homelab world — then cross them
              into plays most people would be afraid to touch, each one argued
              with real numbers and a source you can open.
            </p>
            <button
              type="button"
              disabled={sweepBusy}
              onClick={() => startSweep.mutate(undefined)}
              className="mt-5 rounded-md bg-[var(--heat)] px-5 py-3 text-sm font-bold text-white disabled:opacity-60"
            >
              {startSweep.isPending
                ? "Starting…"
                : sweepRunning
                  ? "Sweep running…"
                  : "Run the first sweep"}
            </button>
          </div>
        )}

        {/* Featured — Today's Wildest Bet */}
        {data && featured && filter === "all" && (
          <section
            aria-label="Today's wildest bet"
            className="mt-6 rotate-[-0.4deg] rounded-[var(--radius)] border-2 border-[var(--heat)] bg-[var(--surface)] p-5 shadow-lg sm:p-6"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="font-data inline-block -rotate-2 bg-[var(--heat)] px-2 py-1 text-[11px] font-bold tracking-[0.2em] text-white">
                TODAY'S WILDEST BET
              </p>
              <CrazyMeter score={featured.crazyScore} big />
            </div>
            <h2 className="font-display mt-4 text-4xl leading-[1.05] font-semibold sm:text-5xl">
              {featured.title}
            </h2>
            <p className="mt-3 text-lg leading-relaxed">{featured.hook}</p>
            {featured.marketSignal && (
              <p className="mt-4 text-sm leading-relaxed text-[var(--dim)]">
                <span className="font-data text-[10px] tracking-widest text-[var(--accent)]">
                  THE SIGNAL —{" "}
                </span>
                {featured.marketSignal}
              </p>
            )}
            <EvidenceList idea={featured} />
            <div className="mt-5 grid gap-4 border-t border-dashed border-[var(--border)] pt-4 sm:grid-cols-2">
              <DetailBlock label="WHY PEOPLE SHY AWAY" heat>
                {featured.whyShyAway}
              </DetailBlock>
              <DetailBlock label="THE UPSIDE">{featured.upsideCase}</DetailBlock>
              <DetailBlock label="WHY THIS FITS YOU">{featured.whyForYou}</DetailBlock>
              <DetailBlock label="FIRST MOVE">{featured.firstMove}</DetailBlock>
              <div className="sm:col-span-2">
                <DetailBlock label="THE 7-DAY TEST — UNDER $500">
                  {featured.sevenDayTest}
                </DetailBlock>
              </div>
            </div>
            <div className="mt-5">
              <StatusButtons
                idea={featured}
                onStatus={onStatus}
                busy={statusMut.isPending}
              />
            </div>
          </section>
        )}

        {/* Focused sweeps */}
        {data && ideas.length > 0 && (
          <div className="mt-8 flex flex-wrap items-center gap-2">
            <span className="font-data text-[10px] tracking-widest text-[var(--dim)]">
              SWEEP ONE WORLD HARD:
            </span>
            {data.lenses
              .filter((l) => data.activeLenses.includes(l.id))
              .map((lens) => (
                <button
                  key={lens.id}
                  type="button"
                  disabled={sweepBusy}
                  onClick={() => startSweep.mutate(lens.id)}
                  className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  {lens.label}
                </button>
              ))}
          </div>
        )}

        {/* Filters */}
        {data && ideas.length > 0 && (
          <div
            className="mt-4 flex flex-wrap gap-2"
            role="tablist"
            aria-label="Filter ideas"
          >
            {filters.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-full px-4 py-2 text-sm ${
                  filter === f.id
                    ? "bg-[var(--text)] font-semibold text-[var(--bg)]"
                    : "border border-[var(--border)] bg-[var(--surface)]"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        {/* Feed */}
        {filter === "history" ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm leading-relaxed text-[var(--dim)]">
              Dismissed ideas live here for 30 days, then they are removed
              automatically. Saved and pursued ideas are never removed.
              Restoring puts an idea back on the board.
            </p>
            {(historyQuery.data?.ideas ?? []).map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                expanded={expandedId === idea.id}
                onToggle={() =>
                  setExpandedId((cur) => (cur === idea.id ? null : idea.id))
                }
                onStatus={onStatus}
                busy={statusMut.isPending}
                history
                purgeAfterDays={historyQuery.data?.purgeAfterDays ?? 30}
              />
            ))}
            {historyQuery.data && historyQuery.data.ideas.length === 0 && (
              <p className="py-10 text-center text-sm text-[var(--dim)]">
                Nothing dismissed yet — dismissed ideas will land here for 30 days.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {feedIdeas.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                expanded={expandedId === idea.id}
                onToggle={() =>
                  setExpandedId((cur) => (cur === idea.id ? null : idea.id))
                }
                onStatus={onStatus}
                busy={statusMut.isPending}
              />
            ))}
            {data && ideas.length > 0 && feedIdeas.length === 0 && (
              <p className="py-10 text-center text-sm text-[var(--dim)]">
                {filter === "vault"
                  ? "The vault is empty — save an idea or mark one as in pursuit and it lands here."
                  : filter === "all"
                    ? "Everything else from the latest sweep is the wildest bet above."
                    : "Nothing in this cut yet — run a sweep and the mix refills."}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
