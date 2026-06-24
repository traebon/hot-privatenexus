import express from "express";
import { rateLimit } from "express-rate-limit";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient } from "redis";
import { readFileSync } from "fs";

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
import { initDb }            from "./db.js";
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
  if (tok && MCP_TOKEN && tok === MCP_TOKEN) {
    req.session.user = {
      sub: "mcp-server",
      username: "mcp-server",
      name: "mcp-server",
      roles: ["operator"],
    };
  }
  next();
});

// Public routes — no auth required
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, service: "privatenexus-backend", version: "5.0.0" })
);
app.use("/api/auth", authRouter);

// All remaining /api/* routes require a valid session
app.use("/api", requireAuth);

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
