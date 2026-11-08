import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const ideas = sqliteTable("ideas", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  hook: text("hook").notNull(),
  type: text("type", { enum: ["business", "art", "hybrid"] }).notNull(),
  crazyScore: real("crazy_score").notNull(),
  whyShyAway: text("why_shy_away").notNull().default(""),
  marketSignal: text("market_signal").notNull().default(""),
  upsideCase: text("upside_case").notNull().default(""),
  whyForYou: text("why_for_you").notNull().default(""),
  firstMove: text("first_move").notNull().default(""),
  sevenDayTest: text("seven_day_test").notNull().default(""),
  // JSON array: [{ label, value, sourceTitle, sourceUrl }]
  evidenceJson: text("evidence_json").notNull().default("[]"),
  status: text("status", {
    enum: ["new", "saved", "pursuing", "archived"],
  })
    .notNull()
    .default("new"),
  batchLabel: text("batch_label").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  // Set when an idea is dismissed (status -> archived); cleared on restore.
  // History keeps dismissed ideas 30 days from this timestamp, then the
  // daily purge removes them. Saved / pursuing / new ideas never expire.
  dismissedAt: integer("dismissed_at", { mode: "timestamp_ms" }),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// One row per sweep run. The sweep itself runs as a background task (it
// outlives a single action call); this row is the durable record the board
// polls: current stage while running, or the stage it died on + why.
export const sweepJobs = sqliteTable("sweep_jobs", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  focus: text("focus"),
  status: text("status", { enum: ["running", "done", "failed"] })
    .notNull()
    .default("running"),
  stage: text("stage").notNull().default("queued"),
  detail: text("detail").notNull().default(""),
  added: integer("added").notNull().default(0),
  batchLabel: text("batch_label").notNull().default(""),
  message: text("message").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
