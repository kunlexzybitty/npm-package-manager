#!/usr/bin/env node
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "./scanner.js";
import { applyUpdates, runInstall, resolveProjectPath } from "./applier.js";
import { browse } from "./fsbrowse.js";
import { listSnapshots, restoreSnapshot, deleteSnapshot } from "./snapshots.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = process.env.PORT || 4321;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "internal error" });
  });
};

// Browse the filesystem for the folder picker.
app.get(
  "/api/browse",
  wrap(async (req, res) => {
    const result = await browse(req.query.path);
    res.json(result);
  })
);

// Scan a project for minor/patch upgrades + security comparison.
app.post(
  "/api/scan",
  wrap(async (req, res) => {
    const projectPath = resolveProjectPath(req.body.projectPath);
    if (!projectPath) return res.status(400).json({ error: "projectPath is required" });
    const cooldownDays = Number(req.body.cooldownDays) || 0;
    const result = await scanProject({ projectPath, cooldownDays });
    res.json(result);
  })
);

// Apply selected updates to package.json (+ optional npm install).
app.post(
  "/api/apply",
  wrap(async (req, res) => {
    const projectPath = resolveProjectPath(req.body.projectPath);
    if (!projectPath) return res.status(400).json({ error: "projectPath is required" });
    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    if (updates.length === 0) return res.status(400).json({ error: "no updates selected" });

    const result = await applyUpdates({ projectPath, updates });

    let install = null;
    if (result.wrote && req.body.install !== false) {
      install = await runInstall(projectPath);
    }
    res.json({ ...result, install });
  })
);

// List snapshots taken for a project.
app.get(
  "/api/snapshots",
  wrap(async (req, res) => {
    const projectPath = resolveProjectPath(req.query.path);
    if (!projectPath) return res.status(400).json({ error: "path is required" });
    res.json({ projectPath, snapshots: await listSnapshots(projectPath) });
  })
);

// Restore a snapshot (revert package.json + lockfiles), optionally re-installing.
app.post(
  "/api/restore",
  wrap(async (req, res) => {
    const projectPath = resolveProjectPath(req.body.projectPath);
    if (!projectPath) return res.status(400).json({ error: "projectPath is required" });
    if (!req.body.id) return res.status(400).json({ error: "snapshot id is required" });

    const result = await restoreSnapshot(projectPath, req.body.id);
    let install = null;
    if (req.body.install !== false) install = await runInstall(projectPath);
    res.json({ ...result, install });
  })
);

app.delete(
  "/api/snapshots",
  wrap(async (req, res) => {
    const projectPath = resolveProjectPath(req.query.path);
    if (!projectPath || !req.query.id)
      return res.status(400).json({ error: "path and id are required" });
    res.json(await deleteSnapshot(projectPath, req.query.id));
  })
);

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  minor-patch-manager running at ${url}\n`);
});
