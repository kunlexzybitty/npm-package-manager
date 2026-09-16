import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * List sub-directories of a path for the UI folder browser. Also reports
 * whether the directory itself is a Node project (has package.json).
 */
export async function browse(inputPath) {
  const target = inputPath ? path.resolve(inputPath) : os.homedir();

  const stat = await fs.stat(target).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    const err = new Error(`not a directory: ${target}`);
    err.statusCode = 400;
    throw err;
  }

  const entries = await fs.readdir(target, { withFileTypes: true });

  const dirs = [];
  let hasPackageJson = false;
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "package.json") hasPackageJson = true;
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    // Flag child dirs that are themselves projects, so they're easy to spot.
    const childHasPkg = await fs
      .stat(path.join(target, entry.name, "package.json"))
      .then(() => true)
      .catch(() => false);
    dirs.push({ name: entry.name, isProject: childHasPkg });
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));

  return {
    path: target,
    parent: path.dirname(target) === target ? null : path.dirname(target),
    hasPackageJson,
    home: os.homedir(),
    directories: dirs,
  };
}
