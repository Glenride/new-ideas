CREATE TABLE sweep_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  focus TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  stage TEXT NOT NULL DEFAULT 'queued',
  detail TEXT NOT NULL DEFAULT '',
  added INTEGER NOT NULL DEFAULT 0,
  batch_label TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
