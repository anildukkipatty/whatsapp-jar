-- A WhatsApp user is a users row with the chat id they write from. There is no
-- login: the row is created the first time that number messages Jar.
ALTER TABLE users
  ADD COLUMN whatsapp_id     text UNIQUE,
  ADD COLUMN limit_notice_at timestamptz;  -- last "daily limit reached" notice, so it is sent once a day

-- The outbox: an assistant or system row in a WhatsApp thread with delivered_at
-- NULL still has to be sent. external_id is the WhatsApp id of the sent message,
-- which a later quoted reply needs. (For user rows that id is dedupe_key.)
ALTER TABLE messages
  ADD COLUMN external_id       text,
  ADD COLUMN delivered_at      timestamptz,
  ADD COLUMN delivery_attempts int NOT NULL DEFAULT 0;
