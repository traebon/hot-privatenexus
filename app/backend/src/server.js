import express from "express";
import cors from "cors";
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient } from "redis";
import { readFileSync } from "fs";

import { authRouter }     from "./routes/auth.js";
import { appsRouter }     from "./routes/apps.js";
import { stacksRouter }   from "./routes/stacks.js";
import { adminRouter }    from "./routes/admin.js";
import { actionsRouter }  from "./routes/actions.js";
import { metricsRouter }  from "./routes/metrics.js";
import { filesRouter }    from "./routes/files.js";
import { alertsRouter }   from "./routes/alerts.js";
import { logsRouter }     from "./routes/logs.js";
import { servicesRouter } from "./routes/services.js";
import { opsRouter }     from "./routes/ops.js";
import { catalogueRouter } from "./routes/catalogue.js";
import { dnsRouter } from "./routes/dns.js";
import { requireAuth }   from "./middleware/requireAuth.js";
import { requireRole }   from "./middleware/requireRole.js";
import { initDb }        from "./db.js";
import { startHealthScheduler } from "./healthScheduler.js";

const app  = express();
const port = Number(process.env.PORT || 3001);

await initDb();
startHealthScheduler();

// Redis session store
const redisClient = createClient({ url: process.env.REDIS_URL || "redis://privatenexus-redis:6379" });
redisClient.on("error", (err) => console.error("Redis error:", err));
await redisClient.connect();

function readSecret(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

const sessionSecret =
  readSecret("/run/secrets/session_secret") ??
  process.env.SESSION_SECRET ??
  "dev-secret-change-me";

app.set("trust proxy", 1);
app.use(cors({ origin: false }));
app.use(express.json());

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

// Public routes — no auth required
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, service: "privatenexus-backend", version: "1.12.0" })
);
app.use("/api/auth", authRouter);

// All remaining /api/* routes require a valid session
app.use("/api", requireAuth);

app.use("/api/apps",     appsRouter);
app.use("/api/stacks",   stacksRouter);
app.use("/api/admin",    adminRouter);
app.use("/api/actions",  requireRole("operator"), actionsRouter);
app.use("/api/metrics",  metricsRouter);
app.use("/api/files",    filesRouter);
app.use("/api/alerts",   alertsRouter);
app.use("/api/logs",     logsRouter);
app.use("/api/services", servicesRouter);
app.use("/api/ops",       opsRouter);
app.use("/api/catalogue", catalogueRouter);
app.use("/api/dns", dnsRouter);

app.listen(port, () => console.log(`PrivateNexus backend listening on ${port}`));
