-- btree_gin lets the search index be scoped by thread inside the GIN index itself.
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE TABLE tenants (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  bigint NOT NULL REFERENCES tenants (id),
  name       text NOT NULL,
  timezone   text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- One endless thread per user. The lease columns are the per-thread turn lock.
CREATE TABLE threads (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        bigint NOT NULL,
  user_id          bigint NOT NULL,
  lease_owner      uuid,
  lease_expires_at timestamptz,
  attempts         int NOT NULL DEFAULT 0,
  retry_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);

-- One row per finished turn. transcript is the exact model-message list for that
-- turn (user batch, tool calls, tool results, replies). A turn is one row, so the
-- rolling window can only ever cut between turns, never inside one.
CREATE TABLE turns (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      bigint NOT NULL,
  thread_id      bigint NOT NULL,
  transcript     jsonb NOT NULL,
  token_estimate int NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, thread_id, id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads (tenant_id, id)
);

-- The permanent chat log, and also the inbox: a user message with turn_id NULL
-- has not been answered yet. The composite foreign keys make a cross-tenant or
-- cross-thread reply or turn link impossible at the database level.
CREATE TABLE messages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   bigint NOT NULL,
  thread_id   bigint NOT NULL,
  role        text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  dedupe_key  text,
  reply_to_id bigint,
  turn_id     bigint,
  search      tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (tenant_id, thread_id, id),
  UNIQUE (thread_id, dedupe_key),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads (tenant_id, id),
  FOREIGN KEY (tenant_id, thread_id, reply_to_id) REFERENCES messages (tenant_id, thread_id, id),
  FOREIGN KEY (tenant_id, thread_id, turn_id) REFERENCES turns (tenant_id, thread_id, id)
);

CREATE INDEX messages_search_idx ON messages USING gin (thread_id, search);
CREATE INDEX messages_inbox_idx ON messages (thread_id, created_at)
  WHERE role = 'user' AND turn_id IS NULL;
