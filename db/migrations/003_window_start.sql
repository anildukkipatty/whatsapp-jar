-- Where the rolling window starts. It only ever moves forward, in large jumps,
-- because every move changes the prompt prefix and invalidates the prompt cache.
ALTER TABLE threads ADD COLUMN window_start_turn_id bigint;
