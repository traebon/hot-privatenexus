import { Router } from "express";

export const actionsRouter = Router();

actionsRouter.post("/run", (req, res) => {
  const { action } = req.body || {};
  res.json({
    ok: true,
    mode: "mock",
    action: action || "unknown"
  });
});
