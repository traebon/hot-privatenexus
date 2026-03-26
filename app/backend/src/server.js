import express from "express";
import cors from "cors";
import { appsRouter } from "./routes/apps.js";
import { stacksRouter } from "./routes/stacks.js";
import { adminRouter } from "./routes/admin.js";
import { actionsRouter } from "./routes/actions.js";
import { metricsRouter } from "./routes/metrics.js";

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "privatenexus-backend", version: "0.1.0" });
});

app.use("/api/apps", appsRouter);
app.use("/api/stacks", stacksRouter);
app.use("/api/admin", adminRouter);
app.use("/api/actions", actionsRouter);
app.use("/api/metrics", metricsRouter);

app.listen(port, () => {
  console.log(`PrivateNexus backend listening on ${port}`);
});
