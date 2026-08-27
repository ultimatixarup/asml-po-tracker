-- Core schema for the construction manager agent.
-- Ledger credibility rests on three mechanisms:
--   1. artifacts are content-addressed (sha256) and immutable
--   2. events are append-only and hash-chained per project
--   3. change-order lines carry mandatory evidence links

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  address     text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE parties (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('gc','sub','owner','architect','vendor')),
  contact_info jsonb
);

CREATE TABLE project_parties (
  project_id uuid NOT NULL REFERENCES projects(id),
  party_id   uuid NOT NULL REFERENCES parties(id),
  role       text,
  PRIMARY KEY (project_id, party_id)
);

-- Chat identity -> project context. contact_id is the channel key
-- ("tg:<chat_id>" for Telegram, bare phone number for WhatsApp).
CREATE TABLE contacts (
  contact_id        text PRIMARY KEY,
  display_name      text,
  active_project_id uuid REFERENCES projects(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Durable replacement for the in-memory history Map.
CREATE TABLE chat_messages (
  id         bigserial PRIMARY KEY,
  contact_id text NOT NULL REFERENCES contacts(contact_id),
  role       text NOT NULL CHECK (role IN ('user','assistant')),
  content    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_contact_idx ON chat_messages (contact_id, id DESC);

-- Immutable, content-addressed field artifacts.
CREATE TABLE artifacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid REFERENCES projects(id),
  sha256            text UNIQUE NOT NULL,
  blob_key          text NOT NULL,
  mime              text NOT NULL,
  byte_size         integer NOT NULL,
  kind              text NOT NULL DEFAULT 'other' CHECK (kind IN
                    ('photo','receipt','plan','estimate','design_note','document','other')),
  source_channel    text,
  source_message_id text,
  uploaded_by       text REFERENCES contacts(contact_id),
  extraction        jsonb,
  extraction_model  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- THE ledger. Append-only, hash-chained per project:
--   hash = sha256(prev_hash || canonical_json(payload))
CREATE TABLE events (
  id                bigserial PRIMARY KEY,
  project_id        uuid REFERENCES projects(id),
  type              text NOT NULL CHECK (type IN (
                    'message.received','artifact.ingested','estimate.imported',
                    'change.requested','co.drafted','co.status_changed',
                    'note.logged','daily_log.recorded','ai.call_recorded')),
  actor             text NOT NULL,
  payload           jsonb NOT NULL,
  artifact_id       uuid REFERENCES artifacts(id),
  source_message_id text,
  prev_hash         text NOT NULL,
  hash              text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- Durable webhook dedupe: a delivery retry cannot file twice.
CREATE UNIQUE INDEX events_source_message_idx
  ON events (source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX events_project_idx ON events (project_id, id);

CREATE OR REPLACE FUNCTION forbid_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_event_mutation();

CREATE TABLE estimates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id),
  version               integer NOT NULL,
  source_artifact_id    uuid REFERENCES artifacts(id),
  status                text NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded')),
  total                 numeric NOT NULL,
  created_from_event_id bigint REFERENCES events(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE TABLE estimate_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES estimates(id),
  line_no     integer NOT NULL,
  csi_code    text,
  description text NOT NULL,
  qty         numeric,
  unit        text,
  unit_cost   numeric,
  total       numeric NOT NULL,
  raw         jsonb
);
CREATE INDEX estimate_lines_estimate_idx ON estimate_lines (estimate_id, line_no);

CREATE TABLE change_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  number           integer NOT NULL,
  status           text NOT NULL DEFAULT 'pco' CHECK (status IN ('pco','cor','approved','void')),
  title            text NOT NULL,
  base_estimate_id uuid NOT NULL REFERENCES estimates(id),
  source_event_id  bigint REFERENCES events(id),
  net_amount       numeric NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

CREATE TABLE co_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_order_id          uuid NOT NULL REFERENCES change_orders(id),
  kind                     text NOT NULL CHECK (kind IN ('add','credit')),
  csi_code                 text,
  description              text NOT NULL,
  qty                      numeric,
  unit                     text,
  unit_cost                numeric,
  total                    numeric NOT NULL,
  affects_estimate_line_id uuid REFERENCES estimate_lines(id),
  rationale                text,
  math_note                text
);

-- Every change-order line must be able to show its evidence.
CREATE TABLE co_line_evidence (
  co_line_id uuid NOT NULL REFERENCES co_lines(id),
  event_id   bigint NOT NULL REFERENCES events(id),
  PRIMARY KEY (co_line_id, event_id)
);
