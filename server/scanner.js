import { getPackageMeta } from "./registry.js";
import { compareSecurity, queryVulns, hasMalicious } from "./osv.js";
import { mapLimit } from "./util/concurrency.js";
import {
  isScannableRange,
  currentVersionFromRange,
  resolveUpgrade,
  describeVersion,
  buildRange,
} from "./util/versions.js";
import { readPackageJson, collectDependencies, readLockfileVersions } from "./project.js";

const CONCURRENCY = 8;

/**
 * Walk the cooldown-passed candidates from newest down, skipping any version
 * that OSV flags as containing malicious code, and return the newest SAFE one.
 * Records which versions were skipped so the UI can explain the choice.
 */
async function pickSafeTarget(name, eligibleVersions, fetchVulns = queryVulns) {
  const skippedMalicious = [];
  for (const version of eligibleVersions) {
    const vulns = await fetchVulns(name, version);
    if (hasMalicious(vulns)) {
      skippedMalicious.push(version);
      continue;
    }
    return { target: version, skippedMalicious };
  }
  return { target: null, skippedMalicious };
}

/**
 * Scan a project for available minor/patch upgrades and, for every package that
 * has one, compare the security posture of the current vs candidate version.
 */
export async function scanProject({ projectPath, cooldownDays = 0 }) {
  const { json } = await readPackageJson(projectPath);
  const deps = collectDependencies(json);
  const { hasLock, lockfile, versions: installed } = await readLockfileVersions(projectPath);
  const now = Date.now();

  const results = await mapLimit(deps, CONCURRENCY, async (dep) => {
    const base = {
      name: dep.name,
      section: dep.section,
      range: dep.range,
    };

    if (!isScannableRange(dep.range)) {
      return { ...base, status: "skipped", reason: "non-registry or unpinnable range" };
    }

    const current = installed[dep.name] || currentVersionFromRange(dep.range);
    if (!current) {
      return { ...base, status: "skipped", reason: "could not resolve current version" };
    }

    const meta = await getPackageMeta(dep.name);
    if (!meta.ok) {
      return { ...base, current, status: "error", reason: meta.error };
    }

    const upgrade = resolveUpgrade({
      current,
      versions: meta.versions,
      timeMap: meta.timeMap,
      cooldownDays,
      now,
    });

    if (!upgrade || upgrade.hasUpgrade === false) {
      return {
        ...base,
        current,
        status: upgrade?.heldBackByCooldown ? "cooldown" : "current",
        heldBack: upgrade?.heldBackByCooldown || false,
        latestIgnoringCooldown: upgrade?.latestIgnoringCooldown || null,
        latestPublishedAt: upgrade?.latestPublishedAt || null,
      };
    }

    // Step down past any compromised (malware) versions to the newest safe one.
    const { target, skippedMalicious } = await pickSafeTarget(
      dep.name,
      upgrade.eligibleVersions
    );

    if (!target) {
      // Every candidate newer than the current version is flagged malicious.
      return {
        ...base,
        current,
        status: "blocked",
        skippedMalicious,
        reason: "all newer versions flagged as malicious",
      };
    }

    const security = await compareSecurity(dep.name, current, target);
    const { publishedAt, ageDays, bumpType } = describeVersion(current, target, meta.timeMap, now);
    const deprecated = meta.deprecatedVersions[target] || null;

    return {
      ...base,
      status: "update",
      current,
      currentFromLock: hasLock && installed[dep.name] != null,
      target,
      newRange: buildRange(dep.range, target),
      bumpType,
      publishedAt,
      ageDays,
      heldBack: upgrade.heldBackByCooldown || skippedMalicious.length > 0,
      latestIgnoringCooldown: upgrade.latestIgnoringCooldown,
      skippedMalicious,
      deprecated,
      security,
    };
  });

  const updates = results.filter((r) => r.status === "update");
  const summary = {
    total: results.length,
    updates: updates.length,
    patch: updates.filter((r) => r.bumpType === "patch").length,
    minor: updates.filter((r) => r.bumpType === "minor").length,
    securityImproves: updates.filter((r) => r.security?.verdict === "improves").length,
    securityRisky: updates.filter(
      (r) => r.security?.verdict === "risky" || r.security?.verdict === "mixed"
    ).length,
    heldByCooldown: results.filter((r) => r.status === "cooldown").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    maliciousAvoided: results.reduce((n, r) => n + (r.skippedMalicious?.length || 0), 0),
    maliciousCurrent: updates.filter((r) => r.security?.maliciousCurrent).length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
  };

  return {
    projectPath,
    projectName: json.name || null,
    cooldownDays,
    hasLock,
    lockfile,
    scannedAt: new Date(now).toISOString(),
    summary,
    packages: results,
  };
}
