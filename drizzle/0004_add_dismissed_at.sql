ALTER TABLE ideas ADD COLUMN dismissed_at INTEGER;
--> statement-breakpoint
-- Backfill: existing archived rows have no recorded dismissal time (the
-- column did not exist), so they start their 30-day clock at migration
-- time and get a full 30 days from when the rule starts being enforced.
-- New dismissals stamp dismissed_at at the moment of dismissal (see
-- updateStatus in server/src/actions.ts).
UPDATE ideas SET dismissed_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE status = 'archived' AND dismissed_at IS NULL;
