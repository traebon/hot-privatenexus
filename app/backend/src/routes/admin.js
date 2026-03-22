import { Router } from "express";

export const adminRouter = Router();

adminRouter.get("/backup", (_req, res) => {
  res.json({
    schedule: "Daily at 02:00",
    destination: "Backblaze B2",
    lastRun: "Success",
    nextRun: "Tonight 02:00"
  });
});

adminRouter.get("/network", (_req, res) => {
  res.json({
    subnet: "10.10.60.0/24",
    gateway: "10.10.60.1",
    resolver: "internal"
  });
});
