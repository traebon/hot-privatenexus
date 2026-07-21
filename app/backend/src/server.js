import express from "express";
import { rateLimit } from "express-rate-limit";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient } from "redis";
import { readFileSync } from "fs";
import { timingSafeEqual } from "crypto";

import { authRouter }        from "./routes/auth.js";
import { appsRouter }        from "./routes/apps.js";
import { stacksRouter }      from "./routes/stacks.js";
import { adminRouter }       from "./routes/admin.js";
import { actionsRouter }     from "./routes/actions.js";
import { metricsRouter }     from "./routes/metrics.js";
import { filesRouter }       from "./routes/files.js";
import { alertsRouter }      from "./routes/alerts.js";
import { logsRouter }        from "./routes/logs.js";
import { servicesRouter }    from "./routes/services.js";
import { opsRouter }         from "./routes/ops.js";
import { catalogueRouter }   from "./routes/catalogue.js";
import { dnsRouter }         from "./routes/dns.js";
import { activityRouter }    from "./routes/activity.js";
import { discoveryRouter }   from "./routes/discovery.js";
import { dependenciesRouter }from "./routes/dependencies.js";
import { governanceRouter }  from "./routes/governance.js";
import { recoveryRouter }    from "./routes/recovery.js";
import { intelligenceRouter }from "./routes/intelligence.js";
import { requireAuth }       from "./middleware/requireAuth.js";
import { requireRole }       from "./middleware/requireRole.js";
import { tenantsRouter }     from "./routes/tenants.js";
import { initDb, HOT_TENANT_ID, resolveTenantForUser } from "./db.js";
import { startHealthScheduler } from "./healthScheduler.js";

const app  = express();
const port = Number(process.env.PORT || 3001);

await initDb();
startHealthScheduler();

// Rate limiters — applied at app level so they work regardless of upstream proxy
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,                    // 20 auth attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests" },
  skip: (req) => req.path === "/callback",  // don't limit OIDC callbacks
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 300,                   // 300 requests/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests" },
});

// Redis session store
const _redisPw = (() => { try { return readFileSync('/run/secrets/redis_password', 'utf8').trim(); } catch { return null; } })();
const _redisBase = process.env.REDIS_URL || 'redis://privatenexus-redis:6379';
const _redisUrl = _redisPw ? _redisBase.replace('redis://', `redis://:${encodeURIComponent(_redisPw)}@`) : _redisBase;
const redisClient = createClient({ url: _redisUrl });
redisClient.on("error", (err) => console.error("Redis error:", err));
await redisClient.connect();

function readSecret(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

const sessionSecret =
  readSecret("/run/secrets/session_secret") ??
  process.env.SESSION_SECRET ??
  "dev-secret-change-me";

const MCP_TOKEN =
  readSecret("/run/secrets/mcp_token") ??
  process.env.MCP_TOKEN;

if (sessionSecret === "dev-secret-change-me") {
  const envType = process.env.NODE_ENV || "production";
  if (envType !== "development") {
    throw new Error("FATAL: sessionSecret is the insecure default — configure /run/secrets/session_secret or SESSION_SECRET env var");
  }
  console.warn("[WARN] Using insecure default session secret — development only");
}

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.disable("x-powered-by");
app.use(cors({ origin: false }));
app.use(express.json({ limit: "1mb" }));

app.use("/api/auth", authLimiter);
app.use("/api", apiLimiter);

app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: "pn.sid",
    cookie: {
      secure: process.env.NODE_ENV !== "development",
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000, // 8h
      sameSite: "lax",
      domain: process.env.SESSION_COOKIE_DOMAIN || undefined,
    },
  })
);

// MCP internal auth — must run before requireAuth so MCP server can call backend APIs
app.use((req, _res, next) => {
  const tok = req.headers["x-mcp-internal"];
  // T16-3: constant-time comparison prevents timing-based token enumeration
  const mcpMatch = tok && MCP_TOKEN && (() => {
    try {
      const a = Buffer.from(tok);
      const b = Buffer.from(MCP_TOKEN);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch { return false; }
  })();
  if (mcpMatch) {
    req.session.user = {
      sub: "mcp-server",
      username: "mcp-server",
      name: "mcp-server",
      roles: ["operator"],
      // MCP (JARVIS) always operates against the House of Trae tenant — it has
      // no Keycloak identity of its own to resolve a membership for, and there's
      // no legitimate case today for an MCP client acting on another tenant.
      tenant_id: HOT_TENANT_ID,
    };
  }
  next();
});

// Public routes — no auth required
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, service: "privatenexus-backend", version: "5.0.0" })
);
app.use("/api/auth", authRouter);

// All remaining /api/* routes require a valid session, except the discovery
// agent ingest endpoint — it authenticates itself via Bearer token (see
// routes/discovery.js) so external non-interactive agents can push data
// without an OIDC session, which is the whole point of that endpoint.
app.use("/api", (req, res, next) => {
  if (req.method === "POST" && req.path === "/discovery/ingest") return next();
  return requireAuth(req, res, next);
});

// Backfill tenant_id for sessions created before dynamic tenant resolution
// existed (pre-deploy sessions still alive within the 8h cookie TTL). New
// logins already get tenant_id from auth.js; this only covers the transition
// window and is a no-op once those sessions expire.
app.use("/api", async (req, res, next) => {
  if (req.session?.user && !req.session.user.tenant_id) {
    try {
      req.session.user.tenant_id = await resolveTenantForUser(req.session.user.sub);
    } catch (err) {
      console.error("[tenant-backfill] error:", err.message);
      return res.status(500).json({ error: "Service unavailable" });
    }
  }
  next();
});

app.use("/api/apps",          appsRouter);
app.use("/api/stacks",        stacksRouter);
app.use("/api/admin",         adminRouter);
app.use("/api/actions",       requireRole("operator"), actionsRouter);
app.use("/api/metrics",       metricsRouter);
app.use("/api/files",         filesRouter);
app.use("/api/alerts",        alertsRouter);
app.use("/api/logs",          logsRouter);
app.use("/api/services",      servicesRouter);
app.use("/api/ops",           opsRouter);
app.use("/api/catalogue",     catalogueRouter);
app.use("/api/dns",           dnsRouter);
app.use("/api/activity",      activityRouter);
app.use("/api/discovery",     discoveryRouter);
app.use("/api/dependencies",  dependenciesRouter);
app.use("/api/governance",    governanceRouter);
app.use("/api/recovery",      recoveryRouter);
app.use("/api/intelligence",  intelligenceRouter);
app.use("/api/tenants",       requireRole("superadmin"), tenantsRouter);

app.listen(port, () => console.log(`PrivateNexus backend listening on ${port}`));

// Global error handler — must be after all routes, 4 args required by Express
// Sanitises unhandled 500s so stack traces never reach the client
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  console.error('[error]', err.message);
  if (status >= 500) {
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
  res.status(status).json({ ok: false, error: err.message || 'Request error' });
});
