-- The numbers Jar answers on WhatsApp. Everyone else is ignored. A row is a phone
-- number in digits with the country code (919876543210), managed with
-- `npm run whitelist`. Read on every message, so a change needs no restart.
CREATE TABLE whatsapp_whitelist (
  phone      text PRIMARY KEY CHECK (phone ~ '^[0-9]{8,15}$'),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
