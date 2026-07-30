-- 0001_lockdown_tables.sql
-- PrivateNexus Security Lockdown Mode — initial schema.
-- Design: /root/hot/docs/PrivateNexus_Security_Lockdown_Mode_Design.md (locked 2026-07-30)
-- First tracked migration file in this repo — see migrations/README.md for why and
-- how to apply it. Does not retroactively migrate the other 22 pre-existing tables.

CREATE TABLE lockdown_state (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tier           TEXT NOT NULL CHECK (tier IN ('none', 'alert', 'soft', 'hard', 'full')),
  activated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_by   TEXT,                 -- username, or 'system' for auto-triggered tiers
  trigger_source TEXT CHECK (trigger_source IN ('wazuh', 'intelligence_signal', 'manual')),
  trigger_ref    TEXT,                 -- Wazuh rule id / intelligence_signals id, for traceability
  reason         TEXT,
  expires_at     TIMESTAMPTZ,          -- null = indefinite until manually cleared
  cleared_at     TIMESTAMPTZ,
  cleared_by     TEXT
);

CREATE INDEX lockdown_state_tenant_idx ON lockdown_state (tenant_id);
CREATE INDEX lockdown_state_activated_idx ON lockdown_state (activated_at DESC);

-- At most one active (uncleared) lockdown episode per tenant at a time — keeps
-- "current tier" unambiguous. A tier escalates by UPDATEing this same row's
-- `tier` column (each transition logged as a lockdown_events row), not by
-- inserting a new lockdown_state row per tier change.
CREATE UNIQUE INDEX lockdown_state_one_active_per_tenant
  ON lockdown_state (tenant_id)
  WHERE cleared_at IS NULL;

CREATE TABLE lockdown_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lockdown_id UUID NOT NULL REFERENCES lockdown_state(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK (event_type IN ('tier_change', 'action_taken', 'action_failed')),
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX lockdown_events_lockdown_idx ON lockdown_events (lockdown_id);
CREATE INDEX lockdown_events_created_idx ON lockdown_events (created_at DESC);
