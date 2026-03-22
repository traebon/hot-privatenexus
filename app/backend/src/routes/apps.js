import { Router } from "express";

export const appsRouter = Router();

appsRouter.get("/", (_req, res) => {
  res.json([
    { name: "Nextcloud", category: "Cloud" },
    { name: "Immich", category: "Media" },
    { name: "Notesnook", category: "Notes" },
    { name: "Grafana", category: "Monitoring" }
  ]);
});
