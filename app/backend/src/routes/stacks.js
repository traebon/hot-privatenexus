import { Router } from "express";

export const stacksRouter = Router();

stacksRouter.get("/", (_req, res) => {
  res.json([
    { name: "Nextcloud", status: "Running" },
    { name: "Immich", status: "Degraded" },
    { name: "Notesnook", status: "Running" },
    { name: "Paperless", status: "Needs Review" }
  ]);
});
