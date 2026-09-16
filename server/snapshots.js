import fs from "node:fs/promises";
import path from "node:path";

export const SNAPSHOT_DIR = ".mpm-snapshots";

// Files worth capturing so a revert fully restores dependency state. Order
// matters only for display; all present files are snapshotted.
export const TRACKED_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
];

function snapshotRoot(projectPath) {
  return path.join(projectPath, SNAPSHOT_DIR);
}

// Guard against `id` escaping the snapshots directory (path traversal).
function snapshotDir(projectPath, id) {
  const root = path.resolve(snapshotRoot(projectPath));
  const dir = path.resolve(root, id);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    const err = new Error("invalid snapshot id");
    err.statusCode = 400;
    throw err;
  }
  return dir;
}

/**
 * Copy package.json + any present lockfiles into a timestamped snapshot folder,
 * writing a manifest describing what was captured and (optionally) the updates
 * that were about to be applied. Returns the manifest.
 */
export async function createSnapshot(projectPath, meta = {}) {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = snapshotDir(projectPath, id);
  await fs.mkdir(dir, { recursive: true });

  const files = [];
  for (const name of TRACKED_FILES) {
    try {
      await fs.copyFile(path.join(projectPath, name), path.join(dir, name));
      files.push(name);
    } catch {
      // File not present in this project — skip it.
    }
  }

  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    files,
    reason: meta.reason || "manual",
    updates: meta.updates || [],
  };
  await fs.writeFile(
    path.join(dir, "snapshot.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
  return manifest;
}

export async function listSnapshots(projectPath) {
  let entries;
  try {
    entries = await fs.readdir(snapshotRoot(projectPath), { withFileTypes: true });
  } catch {
    return [];
  }

  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(snapshotRoot(projectPath), entry.name);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, "snapshot.json"), "utf8"));
      snapshots.push(manifest);
    } catch {
      snapshots.push({ id: entry.name, createdAt: null, files: [], updates: [] });
    }
  }

  // Timestamp-based ids sort lexicographically == chronologically; newest first.
  snapshots.sort((a, b) => b.id.localeCompare(a.id));
  return snapshots;
}

/**
 * Restore a snapshot by copying its captured files back over the project.
 * Returns the list of files restored.
 */
export async function restoreSnapshot(projectPath, id) {
  const dir = snapshotDir(projectPath, id);

  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, "snapshot.json"), "utf8"));
  } catch {
    const err = new Error(`snapshot "${id}" not found`);
    err.statusCode = 404;
    throw err;
  }

  const files = manifest.files?.length ? manifest.files : TRACKED_FILES;
  const restored = [];
  for (const name of files) {
    try {
      await fs.copyFile(path.join(dir, name), path.join(projectPath, name));
      restored.push(name);
    } catch {
      // Snapshot didn't include this file — nothing to restore.
    }
  }

  return { id, restored, manifest };
}

export async function deleteSnapshot(projectPath, id) {
  const dir = snapshotDir(projectPath, id);
  await fs.rm(dir, { recursive: true, force: true });
  return { id, deleted: true };
}
