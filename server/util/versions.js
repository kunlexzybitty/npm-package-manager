import semver from "semver";

// Pull the leading range operator off a package.json range string so we can
// re-apply it when we bump the version (e.g. "^1.2.3" -> keep "^").
export function rangePrefix(range) {
  if (typeof range !== "string") return "^";
  const trimmed = range.trim();
  const match = trimmed.match(/^(\^|~|>=|<=|>|<|=)?\s*/);
  const op = match && match[1] ? match[1] : "";
  // A bare version (e.g. "1.2.3") stays pinned; default new ranges to caret.
  return op;
}

export function buildRange(originalRange, newVersion) {
  return `${rangePrefix(originalRange)}${newVersion}`;
}

// A range is only "scannable" if it resolves to a concrete floor version.
// URLs, git deps, "latest", "*", and workspace protocols are skipped.
export function isScannableRange(range) {
  if (typeof range !== "string") return false;
  const r = range.trim();
  if (!r || r === "*" || r === "latest" || r === "x") return false;
  if (/^(git\+|git:|https?:|file:|link:|workspace:|npm:|github:)/.test(r)) return false;
  return semver.validRange(r) !== null;
}

// Best-effort "what version am I effectively on right now" for a declared range.
export function currentVersionFromRange(range) {
  try {
    const min = semver.minVersion(range);
    return min ? min.version : null;
  } catch {
    return null;
  }
}

/**
 * Given the current concrete version and the registry's version->publishDate
 * map, find the best minor/patch upgrade within the SAME major that has been
 * published at least `cooldownDays` days ago.
 *
 * Returns null when there is no eligible upgrade.
 */
export function resolveUpgrade({ current, versions, timeMap, cooldownDays, now = Date.now() }) {
  const currentSem = semver.coerce(current);
  if (!currentSem) return null;

  const cooldownMs = Math.max(0, cooldownDays) * 24 * 60 * 60 * 1000;

  const sameMajorNewer = versions.filter((v) => {
    if (!semver.valid(v)) return false;
    if (semver.prerelease(v)) return false; // never suggest pre-releases
    if (semver.major(v) !== currentSem.major) return false; // minor/patch only
    return semver.gt(v, currentSem.version);
  });

  if (sameMajorNewer.length === 0) return null;

  const sorted = sameMajorNewer.sort(semver.rcompare); // highest first

  // The absolute best if cooldown were ignored — used to explain "held back".
  const latestIgnoringCooldown = sorted[0];

  const eligible = sorted.filter((v) => {
    const published = timeMap[v] ? Date.parse(timeMap[v]) : null;
    if (published == null || Number.isNaN(published)) return false;
    return now - published >= cooldownMs;
  });

  const target = eligible[0];
  if (!target) {
    // Everything newer is still inside the cooldown window.
    return {
      hasUpgrade: false,
      heldBackByCooldown: true,
      latestIgnoringCooldown,
      latestPublishedAt: timeMap[latestIgnoringCooldown] || null,
    };
  }

  const publishedAt = timeMap[target] || null;
  const ageDays = publishedAt
    ? Math.floor((now - Date.parse(publishedAt)) / (24 * 60 * 60 * 1000))
    : null;

  return {
    hasUpgrade: semver.gt(target, currentSem.version),
    current: currentSem.version,
    target,
    bumpType: semver.diff(currentSem.version, target), // "minor" | "patch"
    publishedAt,
    ageDays,
    heldBackByCooldown: target !== latestIgnoringCooldown,
    latestIgnoringCooldown,
    latestPublishedAt: timeMap[latestIgnoringCooldown] || null,
    // Cooldown-passed candidates, highest first. Lets the scanner step down
    // past compromised versions to the newest *safe* one.
    eligibleVersions: eligible,
  };
}

// Compute the {publishedAt, ageDays, bumpType} facts for a chosen version.
export function describeVersion(current, version, timeMap, now = Date.now()) {
  const publishedAt = timeMap[version] || null;
  const ageDays = publishedAt
    ? Math.floor((now - Date.parse(publishedAt)) / (24 * 60 * 60 * 1000))
    : null;
  let bumpType = null;
  try {
    bumpType = semver.diff(current, version);
  } catch {
    /* leave null */
  }
  return { publishedAt, ageDays, bumpType };
}
