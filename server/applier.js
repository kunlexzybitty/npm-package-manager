import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { readPackageJson } from "./project.js";
import { createSnapshot } from "./snapshots.js";

const VALID_SECTIONS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
]);

// Detect the indentation used in the original file so we round-trip cleanly.
function detectIndent(raw) {
  const match = raw.match(/^[ \t]*[{[]\r?\n([ \t]+)/);
  if (match) return match[1];
  return "  ";
}

/**
 * Rewrite the selected dependency ranges in package.json. Returns which updates
 * were applied and which were skipped (and why). Writes a .backup first.
 */
export async function applyUpdates({ projectPath, updates }) {
  const { file, raw, json } = await readPackageJson(projectPath);
  const indent = detectIndent(raw);

  const applied = [];
  const skipped = [];

  for (const u of updates) {
    const { name, section, newRange } = u;
    if (!VALID_SECTIONS.has(section) || !json[section] || !(name in json[section])) {
      skipped.push({ name, reason: "dependency no longer present in package.json" });
      continue;
    }
    const previous = json[section][name];
    json[section][name] = newRange;
    applied.push({ name, section, from: previous, to: newRange });
  }

  if (applied.length === 0) {
    return { applied, skipped, wrote: false, snapshot: null };
  }

  // Snapshot package.json + lockfiles BEFORE mutating, so the change is
  // fully revertible. Then write with the original indentation + newline.
  const snapshot = await createSnapshot(projectPath, { reason: "apply", updates: applied });
  await fs.writeFile(file, JSON.stringify(json, null, indent) + "\n", "utf8");

  return { applied, skipped, wrote: true, snapshot };
}

/**
 * Run `npm install` in the project directory, streaming nothing but capturing
 * combined output. Resolves with exit code + output regardless of success.
 */
export function runInstall(projectPath) {
  return new Promise((resolve) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npm, ["install"], {
      cwd: projectPath,
      env: process.env,
    });

    let output = "";
    const capture = (chunk) => {
      output += chunk.toString();
      if (output.length > 20000) output = output.slice(-20000); // keep tail
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    child.on("error", (err) => {
      resolve({ ok: false, code: -1, output: `failed to launch npm: ${err.message}` });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, code, output: output.trim() });
    });
  });
}

export function resolveProjectPath(input) {
  if (!input || typeof input !== "string") return null;
  return path.resolve(input);
}
