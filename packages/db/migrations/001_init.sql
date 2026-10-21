-- Manipulation Shield core schema.
--
-- Principle 2 ("analyze requests, not employees") is structural: there is no recipient,
-- employee or per-person score column anywhere. Sender fields describe the inbound message.
-- The one person reference is audit_events.actor_ref: an opaque id for whoever completed or
-- overrode a verification, required for an audit trail and never aggregated or scored.
-- (Enforced by packages/db/test/schema.test.ts.)
--
-- Every tenant table has row-level security. All tenant work runs as the restricted role
-- shield_app with app.tenant_id set (withTenant in src/db.ts), so RLS confines it to one tenant.
-- The connecting (owner) role is used only for administration: tenant creation, API-key lookup
-- and the retention purge. RLS is deliberately not FORCEd, so those jobs work without a
-- superuser; the API never queries tenant tables outside withTenant.

DO $$ BEGIN
  CREATE ROLE shield_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  org_domains text[] NOT NULL DEFAULT '{}',
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key_sha256 text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- New workflows start in shadow mode: detect and record, never hold.
CREATE TABLE workflow_settings (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  action_kind text NOT NULL,
  mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, action_kind)
);

CREATE TABLE requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  action jsonb NOT NULL DEFAULT '{"kind":"none"}',
  action_kind text NOT NULL DEFAULT 'none',
  object_ids text[] NOT NULL DEFAULT '{}',
  claimed_requester text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'held', 'released', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requests_tenant_recent ON requests (tenant_id, created_at DESC);
CREATE INDEX requests_object_ids ON requests USING gin (object_ids);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  channel text NOT NULL,
  sender_address text,
  sender_display text,
  reply_to text,
  subject text,
  body text,
  body_sha256 text NOT NULL,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  purged_at timestamptz
);
CREATE INDEX artifacts_request ON artifacts (request_id);

CREATE TABLE analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('ALLOW', 'WARN', 'PAUSE')),
  mode text NOT NULL CHECK (mode IN ('shadow', 'enforce')),
  held boolean NOT NULL,
  hits jsonb NOT NULL,
  explanations jsonb NOT NULL,
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analyses_request ON analyses (request_id);

-- Contacts from systems of record (vendor master, HRIS). Verification only ever uses these,
-- never contact details found in the request itself.
CREATE TABLE known_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('vendor', 'role')),
  subject_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('phone', 'email')),
  value text NOT NULL,
  source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_type, subject_id, channel, value)
);

CREATE TABLE verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES analyses (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'needs_contact', 'completed', 'overridden')),
  contact_id uuid REFERENCES known_contacts (id),
  script text NOT NULL,
  outcome text CHECK (outcome IN ('legitimate', 'attack', 'inconclusive')),
  channel_used text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  request_id uuid REFERENCES requests (id) ON DELETE CASCADE,
  verification_id uuid REFERENCES verifications (id) ON DELETE CASCADE,
  actor_ref text NOT NULL,
  event text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_settings', 'requests', 'artifacts', 'analyses', 'known_contacts', 'verifications', 'audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO shield_app', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON tenants TO shield_app;
