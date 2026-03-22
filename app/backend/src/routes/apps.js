import { Router } from "express";

export const appsRouter = Router();

appsRouter.get("/", (_req, res) => {
  res.json([
    { name: "Nextcloud", category: "Cloud", meta: "Files · Sync" },
    { name: "Immich", category: "Media", meta: "Photos · ML" },
    { name: "Notesnook", category: "Notes", meta: "Vault · Secure" },
    { name: "Paperless", category: "Docs", meta: "OCR · Archive" },
    { name: "Grafana", category: "Monitoring", meta: "Dashboards" }
  ]);
});
