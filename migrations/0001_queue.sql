CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id INTEGER NOT NULL UNIQUE,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','outbox','done')),
  lease TEXT,
  model TEXT,
  expires INTEGER,
  cancelled INTEGER NOT NULL DEFAULT 0,
  answer TEXT,
  sent INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX inbox_poll ON inbox(state, id);
