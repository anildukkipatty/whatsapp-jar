-- Usage for a whole turn, summed over its model steps. This is UI metadata: it
-- lives beside the transcript, never in it, so it can't reach the model.
ALTER TABLE turns
  ADD COLUMN input_tokens       int,  -- everything sent, including cache reads and writes
  ADD COLUMN output_tokens      int,  -- includes thinking
  ADD COLUMN cache_read_tokens  int,
  ADD COLUMN cache_write_tokens int,
  ADD COLUMN cost_usd           numeric(12, 6),  -- NULL when the price isn't known
  ADD COLUMN last_message_id    bigint,          -- the row the usage line shows under
  ADD FOREIGN KEY (tenant_id, thread_id, last_message_id) REFERENCES messages (tenant_id, thread_id, id);

CREATE UNIQUE INDEX turns_last_message_idx ON turns (tenant_id, thread_id, last_message_id);

-- Usage billed by failed attempts, held until the turn finally commits.
ALTER TABLE threads ADD COLUMN carried_usage jsonb;
