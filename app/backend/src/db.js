import pg from "pg";
import { readFileSync } from "fs";

const { Pool } = pg;

let pool = null;

// Fixed UUID for House of Trae — Tenant 1, stable across deployments
export const HOT_TENANT_ID = "10000000-0000-0000-0000-000000000001";

function readDbPassword() {
  try { return readFileSync("/run/secrets/db_password", "utf8").trim(); } catch { return undefined; }
}

export function getPool() {
  if (!pool) throw new Error("DB pool not initialised — call initDb() first");
  return pool;
}

// Dynamic tenant resolution — replaces the HOT_TENANT_ID hardcode at the one
// point where a user's tenant should actually be looked up: login. Existing
// users with no tenant_memberships row (i.e. everyone before this was wired
// up) are auto-provisioned into House of Trae on first resolution, so current
// behavior is preserved with no migration step. New tenants are onboarded by
// a SuperAdmin explicitly inserting a membership row (see routes/tenants.js) —
// resolution here never creates a *new* tenant, only a membership into an
// existing one.
export async function resolveTenantForUser(userSub) {
  const { rows } = await pool.query(
    "SELECT tenant_id FROM tenant_memberships WHERE user_sub = $1 ORDER BY joined_at ASC LIMIT 1",
    [userSub]
  );
  if (rows.length) return rows[0].tenant_id;

  await pool.query(
    `INSERT INTO tenant_memberships (user_sub, tenant_id, role)
     VALUES ($1, $2, 'member')
     ON CONFLICT (user_sub, tenant_id) DO NOTHING`,
    [userSub, HOT_TENANT_ID]
  );
  return HOT_TENANT_ID;
}

export async function initDb() {
  pool = new Pool({
    host:     process.env.DB_HOST     || "privatenexus-db",
    port:     Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME     || "privatenexus",
    user:     process.env.DB_USER     || "privatenexus",
    password: readDbPassword() ?? process.env.DB_PASSWORD,
    max: 10,
  });

  // Tenancy
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT         NOT NULL,
      slug       TEXT         NOT NULL UNIQUE,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id  UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name       TEXT         NOT NULL,
      slug       TEXT         NOT NULL,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, slug)
    );

    CREATE TABLE IF NOT EXISTS tenant_memberships (
      id         BIGSERIAL    PRIMARY KEY,
      user_sub   TEXT         NOT NULL,
      tenant_id  UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      role       TEXT         NOT NULL,
      joined_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (user_sub, tenant_id)
    );
  `);

  // Seed House of Trae as Tenant 1 with a fixed, stable UUID
  await pool.query(`
    INSERT INTO tenants (id, name, slug)
    VALUES ($1, 'House of Trae', 'house-of-trae')
    ON CONFLICT (slug) DO NOTHING;
  `, [HOT_TENANT_ID]);

  await pool.query(`
    INSERT INTO workspaces (tenant_id, name, slug) VALUES
      ($1, 'Infrastructure',     'infrastructure'),
      ($1, 'Business Systems',   'business-systems'),
      ($1, 'Personal Services',  'personal-services'),
      ($1, 'Monitoring',         'monitoring')
    ON CONFLICT (tenant_id, slug) DO NOTHING;
  `, [HOT_TENANT_ID]);

  // Audit log — create then patch schema for tenant_id (idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         BIGSERIAL    PRIMARY KEY,
      ts         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      tenant_id  UUID         REFERENCES tenants(id),
      user_sub   TEXT         NOT NULL,
      username   TEXT         NOT NULL,
      role       TEXT         NOT NULL,
      action     TEXT         NOT NULL,
      target     TEXT,
      outcome    TEXT         NOT NULL CHECK (outcome IN ('success', 'failure')),
      detail     JSONB,
      ip         TEXT
    );
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
    CREATE INDEX IF NOT EXISTS audit_log_ts_idx        ON audit_log (ts DESC);
    CREATE INDEX IF NOT EXISTS audit_log_username_idx  ON audit_log (username);
    CREATE INDEX IF NOT EXISTS audit_log_action_idx    ON audit_log (action);
    CREATE INDEX IF NOT EXISTS audit_log_tenant_idx    ON audit_log (tenant_id);
  `);

  // Service registry
  await pool.query(`
    CREATE TABLE IF NOT EXISTS services (
      id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      workspace_id    UUID         REFERENCES workspaces(id) ON DELETE SET NULL,
      name            TEXT         NOT NULL,
      slug            TEXT         NOT NULL,
      description     TEXT,
      category        TEXT         NOT NULL,
      access_url      TEXT,
      access_mode     TEXT         NOT NULL,
      runtime_type    TEXT         NOT NULL,
      owner           TEXT         NOT NULL,
      backup_policy   TEXT         NOT NULL,
      health_endpoint TEXT,
      status          TEXT         NOT NULL DEFAULT 'unknown',
      archived        BOOLEAN      NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, slug)
    );
    CREATE INDEX IF NOT EXISTS services_tenant_idx    ON services (tenant_id);
    CREATE INDEX IF NOT EXISTS services_category_idx  ON services (category);
    CREATE INDEX IF NOT EXISTS services_workspace_idx ON services (workspace_id);
  `);

  // Health event history
  await pool.query(`
    CREATE TABLE IF NOT EXISTS health_events (
      id          BIGSERIAL    PRIMARY KEY,
      ts          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      service_id  UUID         NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      slug        TEXT         NOT NULL,
      status      TEXT         NOT NULL,
      status_code INTEGER,
      latency_ms  INTEGER,
      error       TEXT,
      source      TEXT         NOT NULL DEFAULT 'scheduler'
    );
    CREATE INDEX IF NOT EXISTS health_events_service_ts_idx ON health_events (service_id, ts DESC);
    CREATE INDEX IF NOT EXISTS health_events_tenant_ts_idx  ON health_events (tenant_id, ts DESC);
  `);

  // Service-level backup records (separate from file-centric backups in fileBackups.js)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_backups (
      id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      service_id   UUID         NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      label        TEXT         NOT NULL,
      backup_type  TEXT         NOT NULL DEFAULT 'manual',
      trust_state  TEXT         NOT NULL DEFAULT 'unknown',
      location     TEXT,
      taken_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      size_bytes   BIGINT,
      notes        TEXT,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS service_backups_service_idx ON service_backups (service_id, taken_at DESC);
    CREATE INDEX IF NOT EXISTS service_backups_tenant_idx  ON service_backups (tenant_id);
  `);

  // Discovery candidates
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovery_candidates (
      id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id              UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      source                 TEXT         NOT NULL,
      host                   TEXT,
      raw_name               TEXT,
      raw_image              TEXT,
      suggested_slug         TEXT,
      suggested_name         TEXT,
      suggested_description  TEXT,
      suggested_workspace_id UUID         REFERENCES workspaces(id) ON DELETE SET NULL,
      suggested_category     TEXT,
      suggested_access_mode  TEXT         NOT NULL DEFAULT 'internal',
      suggested_runtime      TEXT         NOT NULL DEFAULT 'docker',
      suggested_health_ep    TEXT,
      raw_data               JSONB,
      completeness_score     INT          NOT NULL DEFAULT 0,
      status                 TEXT         NOT NULL DEFAULT 'pending'
                                          CHECK (status IN ('pending','approved','rejected','merged')),
      reject_reason          TEXT,
      merged_service_id      UUID         REFERENCES services(id) ON DELETE SET NULL,
      discovered_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      reviewed_at            TIMESTAMPTZ,
      reviewed_by            TEXT,
      created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS disc_tenant_status_idx ON discovery_candidates (tenant_id, status);
    CREATE INDEX IF NOT EXISTS disc_source_idx        ON discovery_candidates (source);
    CREATE INDEX IF NOT EXISTS disc_slug_idx          ON discovery_candidates (tenant_id, suggested_slug);
    -- De-dupe any rows from before this constraint existed, keeping the most recent per identity
    DELETE FROM discovery_candidates
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY tenant_id, source, raw_name
            ORDER BY discovered_at DESC, id DESC
          ) AS rn
          FROM discovery_candidates
        ) ranked WHERE rn > 1
      );
    CREATE UNIQUE INDEX IF NOT EXISTS disc_dedup_idx ON discovery_candidates (tenant_id, source, raw_name);
  `);

  // Agent tokens for discovery ingest (scoped, expirable, revocable)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      label        TEXT         NOT NULL,
      token_hash   TEXT         NOT NULL UNIQUE,
      expires_at   TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      created_by   TEXT         NOT NULL,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      revoked      BOOLEAN      NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS agent_tokens_tenant_idx ON agent_tokens (tenant_id);
    CREATE INDEX IF NOT EXISTS agent_tokens_hash_idx   ON agent_tokens (token_hash);
  `);

  // Service dependency graph
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_dependencies (
      id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      upstream_id   UUID         NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      downstream_id UUID         NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      dep_type      TEXT         NOT NULL DEFAULT 'hard'
                                 CHECK (dep_type IN ('hard','soft','data','auth','network')),
      notes         TEXT,
      created_by    TEXT         NOT NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, upstream_id, downstream_id)
    );
    CREATE INDEX IF NOT EXISTS svc_deps_upstream_idx   ON service_dependencies (upstream_id);
    CREATE INDEX IF NOT EXISTS svc_deps_downstream_idx ON service_dependencies (downstream_id);
    CREATE INDEX IF NOT EXISTS svc_deps_tenant_idx     ON service_dependencies (tenant_id);
  `);

  // Governance — policy rules, exceptions, change records
  await pool.query(`
    ALTER TABLE services ADD COLUMN IF NOT EXISTS recovery_runbook_url TEXT;

    CREATE TABLE IF NOT EXISTS policy_rules (
      id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   UUID         REFERENCES tenants(id) ON DELETE CASCADE,
      rule_key    TEXT         NOT NULL UNIQUE,
      name        TEXT         NOT NULL,
      description TEXT,
      severity    TEXT         NOT NULL DEFAULT 'warning'
                               CHECK (severity IN ('critical','warning','info')),
      enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
      built_in    BOOLEAN      NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS policy_exceptions (
      id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      service_id  UUID         NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      rule_key    TEXT         NOT NULL,
      reason      TEXT         NOT NULL,
      expires_at  TIMESTAMPTZ,
      created_by  TEXT         NOT NULL,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, service_id, rule_key)
    );
    CREATE INDEX IF NOT EXISTS policy_ex_tenant_idx  ON policy_exceptions (tenant_id);
    CREATE INDEX IF NOT EXISTS policy_ex_service_idx ON policy_exceptions (service_id);

    CREATE TABLE IF NOT EXISTS change_records (
      id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      service_id   UUID         REFERENCES services(id) ON DELETE SET NULL,
      service_name TEXT,
      change_type  TEXT         NOT NULL,
      actor        TEXT         NOT NULL,
      summary      TEXT         NOT NULL,
      detail       JSONB,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS change_records_tenant_ts_idx  ON change_records (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS change_records_service_idx    ON change_records (service_id);
  `);

  // Seed built-in policy rules (idempotent)
  await pool.query(`
    INSERT INTO policy_rules (rule_key, name, description, severity, built_in) VALUES
      ('owner_required',          'Owner Required',            'Every service must have an owner assigned.',                                    'warning',  TRUE),
      ('backup_policy_required',  'Backup Policy Required',    'Every non-dev service must have a backup policy defined.',                      'critical', TRUE),
      ('health_check_required',   'Health Check Required',     'Every service must have a health endpoint configured.',                         'warning',  TRUE),
      ('access_mode_classified',  'Access Mode Required',      'Every service must have an access mode classification.',                        'warning',  TRUE),
      ('admin_service_protected', 'Admin Service Protection',  'Admin services must use VPN, SSO, mTLS, or internal access mode.',             'critical', TRUE),
      ('recovery_runbook_required','Recovery Runbook Required', 'Every service should have a recovery runbook URL.',                            'info',     TRUE),
      ('stale_backup',            'Stale Backup',              'Service has no backup recorded in the last 7 days.',                           'warning',  TRUE)
    ON CONFLICT (rule_key) DO NOTHING;
  `);

  // v3.0 — Controlled Orchestration
  await pool.query(`
    ALTER TABLE services ADD COLUMN IF NOT EXISTS container_name TEXT;

    CREATE TABLE IF NOT EXISTS action_policies (
      id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id           UUID    REFERENCES tenants(id) ON DELETE CASCADE,
      action_type         TEXT    NOT NULL,
      requires_approval   BOOLEAN NOT NULL DEFAULT FALSE,
      elevation_required  TEXT,
      blast_radius_check  BOOLEAN NOT NULL DEFAULT FALSE,
      cooldown_secs       INT     NOT NULL DEFAULT 60,
      max_per_hour        INT     NOT NULL DEFAULT 20,
      enabled             BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE (action_type)
    );

    CREATE TABLE IF NOT EXISTS action_requests (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      service_id    UUID        REFERENCES services(id) ON DELETE SET NULL,
      service_name  TEXT,
      action_type   TEXT        NOT NULL,
      params        JSONB       NOT NULL DEFAULT '{}',
      status        TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','approved','rejected','executed','expired','failed')),
      proposed_by   TEXT        NOT NULL,
      proposed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_by   TEXT,
      reviewed_at   TIMESTAMPTZ,
      review_note   TEXT,
      executed_at   TIMESTAMPTZ,
      result        JSONB,
      expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
    );
    CREATE INDEX IF NOT EXISTS action_req_tenant_status_idx ON action_requests (tenant_id, status, proposed_at DESC);
    CREATE INDEX IF NOT EXISTS action_req_service_idx       ON action_requests (service_id);

    CREATE TABLE IF NOT EXISTS deploy_rollback_points (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      service_id      UUID        REFERENCES services(id) ON DELETE SET NULL,
      container_name  TEXT        NOT NULL,
      previous_image  TEXT        NOT NULL,
      deployed_image  TEXT        NOT NULL,
      deployed_by     TEXT        NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS drp_service_idx ON deploy_rollback_points (service_id, created_at DESC);
  `);

  // Seed default action policies (idempotent)
  await pool.query(`
    INSERT INTO action_policies (action_type, requires_approval, elevation_required, blast_radius_check, cooldown_secs, max_per_hour) VALUES
      ('container.restart', FALSE, 'operator',    TRUE,  60,   20),
      ('container.stop',    TRUE,  'operator',    TRUE,  60,   10),
      ('container.start',   FALSE, 'operator',    FALSE, 30,   20),
      ('service.deploy',    TRUE,  'admin',       TRUE,  300,  5),
      ('service.rollback',  FALSE, 'admin',       TRUE,  300,  5),
      ('maintenance.enable',FALSE, 'admin',       FALSE, 300,  5),
      ('emergency.stop-all',TRUE,  'superadmin',  FALSE, 3600, 2)
    ON CONFLICT (action_type) DO NOTHING;
  `);

  // v4.0 — Recovery Intelligence
  await pool.query(`
    CREATE TABLE IF NOT EXISTS restore_tests (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      service_id     UUID        NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      backup_id      UUID        REFERENCES service_backups(id) ON DELETE SET NULL,
      tested_by      TEXT        NOT NULL,
      test_type      TEXT        NOT NULL DEFAULT 'dry_run'
                                 CHECK (test_type IN ('dry_run','partial','full')),
      outcome        TEXT        NOT NULL DEFAULT 'passed'
                                 CHECK (outcome IN ('passed','failed','partial')),
      rto_actual_min INT,
      notes          TEXT,
      tested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS restore_tests_service_idx ON restore_tests (service_id, tested_at DESC);
    CREATE INDEX IF NOT EXISTS restore_tests_tenant_idx  ON restore_tests (tenant_id, tested_at DESC);

    CREATE TABLE IF NOT EXISTS recovery_simulations (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      scenario_type TEXT        NOT NULL,
      target_type   TEXT        NOT NULL,
      target_id     UUID,
      target_name   TEXT,
      run_by        TEXT        NOT NULL,
      result        JSONB       NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS rec_sim_tenant_idx ON recovery_simulations (tenant_id, created_at DESC);
  `);

  // v5.0 — Autonomous Operations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS intelligence_signals (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      service_id   UUID        REFERENCES services(id) ON DELETE SET NULL,
      service_name TEXT        NOT NULL,
      signal_type  TEXT        NOT NULL
                               CHECK (signal_type IN ('down_spike','degrading','latency_spike','intermittent','latency_trending','auth_failure_burst','resource_trending')),
      severity     TEXT        NOT NULL DEFAULT 'warning'
                               CHECK (severity IN ('critical','warning','info')),
      detail       TEXT        NOT NULL,
      acknowledged BOOLEAN     NOT NULL DEFAULT FALSE,
      ack_by       TEXT,
      ack_at       TIMESTAMPTZ,
      resolved_at  TIMESTAMPTZ,
      fired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS intel_sig_tenant_ts_idx  ON intelligence_signals (tenant_id, fired_at DESC);
    CREATE INDEX IF NOT EXISTS intel_sig_service_idx    ON intelligence_signals (service_id, fired_at DESC);
    CREATE INDEX IF NOT EXISTS intel_sig_open_idx       ON intelligence_signals (tenant_id, service_id) WHERE resolved_at IS NULL;

    CREATE TABLE IF NOT EXISTS remediation_proposals (
      id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      signal_id         UUID        REFERENCES intelligence_signals(id) ON DELETE SET NULL,
      service_id        UUID        REFERENCES services(id) ON DELETE SET NULL,
      service_name      TEXT        NOT NULL,
      action_type       TEXT        NOT NULL,
      rationale         TEXT        NOT NULL,
      status            TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending','approved','dismissed','executed','failed')),
      requires_approval BOOLEAN     NOT NULL DEFAULT FALSE,
      reviewed_by       TEXT,
      reviewed_at       TIMESTAMPTZ,
      executed_at       TIMESTAMPTZ,
      result            JSONB,
      proposed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS rem_prop_tenant_status_idx ON remediation_proposals (tenant_id, status, proposed_at DESC);
    CREATE INDEX IF NOT EXISTS rem_prop_service_idx       ON remediation_proposals (service_id);

    CREATE TABLE IF NOT EXISTS autonomous_policies (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     UUID        REFERENCES tenants(id) ON DELETE CASCADE,
      signal_type   TEXT        NOT NULL,
      action_type   TEXT        NOT NULL,
      enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
      max_per_hour  INT         NOT NULL DEFAULT 3,
      cooldown_secs INT         NOT NULL DEFAULT 300,
      description   TEXT,
      UNIQUE (signal_type, action_type)
    );
  `);

  // Seed 5 autonomous policies — all disabled by default, operator must enable explicitly
  await pool.query(`
    INSERT INTO autonomous_policies (signal_type, action_type, enabled, max_per_hour, cooldown_secs, description) VALUES
      ('down_spike',     'health.refresh',    FALSE, 5, 120,  'Auto-probe services with 3+ consecutive failures'),
      ('degrading',      'health.refresh',    FALSE, 5, 120,  'Auto-probe services showing degradation trend'),
      ('latency_spike',  'health.refresh',    FALSE, 3, 180,  'Auto-probe services with latency spike'),
      ('intermittent',   'health.refresh',    FALSE, 3, 180,  'Auto-probe flapping services'),
      ('down_spike',     'container.restart', FALSE, 1, 600,  'Auto-restart containers with 5+ consecutive failures (CAUTION: requires container_name)')
    ON CONFLICT (signal_type, action_type) DO NOTHING;
  `);

  // Extend restore_tests.test_type CHECK to include 'tabletop' (idempotent migration)
  await pool.query(
    `ALTER TABLE restore_tests DROP CONSTRAINT IF EXISTS restore_tests_test_type_check`
  );
  await pool.query(
    `ALTER TABLE restore_tests ADD CONSTRAINT restore_tests_test_type_check
       CHECK (test_type IN ('dry_run', 'partial', 'full', 'tabletop'))`
  );

  // Align service_dependencies.dep_type CHECK with application VALID_DEP_TYPES (idempotent)
  await pool.query(
    `ALTER TABLE service_dependencies DROP CONSTRAINT IF EXISTS service_dependencies_dep_type_check`
  );
  await pool.query(
    `ALTER TABLE service_dependencies ADD CONSTRAINT service_dependencies_dep_type_check
       CHECK (dep_type IN ('hard', 'soft', 'data', 'auth', 'network'))`
  );

  console.log("DB connected and schema ready");
}
