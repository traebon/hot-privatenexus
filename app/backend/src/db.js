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

export async function initDb() {
  pool = new Pool({
    host:     process.env.DB_HOST     || "privatenexus-db",
    port:     Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME     || "privatenexus",
    user:     process.env.DB_USER     || "privatenexus",
    password: process.env.DB_PASSWORD || readDbPassword(),
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

  console.log("DB connected and schema ready");
}
