import fs from "node:fs/promises";
import path from "node:path";

const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

export async function readPackageJson(projectPath) {
  const file = path.join(projectPath, "package.json");
  const raw = await fs.readFile(file, "utf8");
  const json = JSON.parse(raw);
  return { file, raw, json };
}

// Return every declared dependency across sections as a flat list.
export function collectDependencies(json) {
  const deps = [];
  for (const section of DEP_SECTIONS) {
    const block = json[section];
    if (!block || typeof block !== "object") continue;
    for (const [name, range] of Object.entries(block)) {
      deps.push({ name, range, section });
    }
  }
  return deps;
}

// npm resolves npm-shrinkwrap.json ahead of package-lock.json when both exist,
// so we honour the same precedence.
const LOCKFILES = ["npm-shrinkwrap.json", "package-lock.json"];

function parseLock(lock) {
  const map = {};
  // npm v7+ lockfile: keys like "node_modules/<name>".
  if (lock.packages) {
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (!key.startsWith("node_modules/")) continue;
      const name = key.slice("node_modules/".length);
      // Prefer the top-level install; nested node_modules paths contain "/node_modules/".
      if (name.includes("/node_modules/")) continue;
      if (meta.version && map[name] == null) map[name] = meta.version;
    }
  }
  // Legacy fallback.
  if (lock.dependencies) {
    for (const [name, meta] of Object.entries(lock.dependencies)) {
      if (meta.version && map[name] == null) map[name] = meta.version;
    }
  }

  return map;
}

/**
 * Read installed versions from the project's lockfile (npm-shrinkwrap.json takes
 * precedence over package-lock.json) so we know the *actual* current version
 * rather than just the range floor.
 */
export async function readLockfileVersions(projectPath) {
  for (const lockfile of LOCKFILES) {
    let raw;
    try {
      raw = await fs.readFile(path.join(projectPath, lockfile), "utf8");
    } catch {
      continue;
    }
    try {
      return { hasLock: true, lockfile, versions: parseLock(JSON.parse(raw)) };
    } catch {
      // Malformed lockfile — treat as absent and try the next candidate.
    }
  }
  return { hasLock: false, lockfile: null, versions: {} };
}
