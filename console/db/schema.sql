-- Proof-of-concept schema. Idempotent: scripts/seed.mjs applies this file as is.
-- Web events live in Umami's own tables (schema "public") and are not defined here.
-- Every statement is schema-qualified because Neon's pooled connections do not keep search_path.

CREATE SCHEMA IF NOT EXISTS usage_signals;

CREATE TABLE IF NOT EXISTS usage_signals.tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending_verification'
              CHECK (status IN ('pending_verification', 'pending_approval',
                                'active', 'unverified', 'suspended', 'removed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_signals.site (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES usage_signals.tenant(id),
  domain            text NOT NULL UNIQUE,
  umami_website_id  uuid NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  slug              text NOT NULL UNIQUE
                    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 63)
);

-- The slug addresses the tenant console (/<slug>/web). Databases created before it existed get
-- the column here; scripts/seed.mjs fills it and then sets NOT NULL.
ALTER TABLE usage_signals.site
  ADD COLUMN IF NOT EXISTS slug text UNIQUE
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 63);

CREATE INDEX IF NOT EXISTS site_tenant_id_idx ON usage_signals.site (tenant_id);

-- Hashed User-Agents per hashed truncated address and UTC day, for the many-agents flag.
CREATE TABLE IF NOT EXISTS usage_signals.agent_sighting (
  day           date  NOT NULL,
  address_hash  bytea NOT NULL CHECK (octet_length(address_hash) = 32),
  agent_hash    bytea NOT NULL CHECK (octet_length(agent_hash) = 32),
  PRIMARY KEY (day, address_hash, agent_hash)
);

-- token_hash is the SHA-256 of a random token of at least 128 bits; the token itself is never stored.
CREATE TABLE IF NOT EXISTS usage_signals.ingest_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES usage_signals.tenant(id),
  token_prefix  text NOT NULL,
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

CREATE INDEX IF NOT EXISTS ingest_token_tenant_id_idx ON usage_signals.ingest_token (tenant_id);

-- One row per series and minute. bucket_counts holds one count per upper bound, in
-- milliseconds: 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000, +Inf.
-- Every tenant shares these bounds so that histograms can be summed across time and projects.
-- The key leads with tenant and minute because dashboards filter by tenant and time range.
CREATE TABLE IF NOT EXISTS usage_signals.api_metric_minute (
  tenant_id        uuid             NOT NULL REFERENCES usage_signals.tenant(id),
  minute           timestamptz      NOT NULL,
  service          text             NOT NULL,
  route            text             NOT NULL,
  method           text             NOT NULL,
  status_code      smallint         NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  request_count    bigint           NOT NULL CHECK (request_count >= 0),
  duration_sum_ms  double precision NOT NULL CHECK (duration_sum_ms >= 0),
  bucket_counts    bigint[]         NOT NULL
                   CHECK (cardinality(bucket_counts) = 15
                          AND array_position(bucket_counts, NULL) IS NULL),
  PRIMARY KEY (tenant_id, minute, service, route, method, status_code)
);

-- Operator API keys. Only the SHA-256 of a key is kept; the key is shown once, when it is made.
-- A key with no tenant reads every project, one with a tenant reads only that project.
CREATE TABLE IF NOT EXISTS usage_signals.operator_api_key (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text        NOT NULL CHECK (label <> ''),
  tenant_id     uuid        REFERENCES usage_signals.tenant(id),
  key_prefix    text        NOT NULL UNIQUE,
  key_hash      bytea       NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- Operator actions, newest last. `subject` names what the action was about, such as a key prefix.
CREATE TABLE IF NOT EXISTS usage_signals.operator_audit (
  id       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text        NOT NULL CHECK (actor <> ''),
  action   text        NOT NULL,
  subject  text        NOT NULL,
  detail   jsonb       NOT NULL DEFAULT '{}'
);

-- Requests per operator API key and minute, for the per-key limit. Only the current minute is
-- needed; a key's older rows are deleted on its next request.
CREATE TABLE IF NOT EXISTS usage_signals.operator_api_key_minute (
  key_id    uuid        NOT NULL REFERENCES usage_signals.operator_api_key(id),
  minute    timestamptz NOT NULL,
  requests  integer     NOT NULL CHECK (requests > 0),
  PRIMARY KEY (key_id, minute)
);
