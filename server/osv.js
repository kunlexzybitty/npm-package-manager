import { TtlCache } from "./util/concurrency.js";

const OSV_QUERY = "https://api.osv.dev/v1/query";
const cache = new TtlCache(30 * 60 * 1000);

const SEVERITY_RANK = { MALICIOUS: 5, CRITICAL: 4, HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

// OSV ingests supply-chain malware advisories under the "MAL-" id prefix
// (from the github.com/ossf/malicious-packages feed). Treat these specially:
// a version with one is compromised, not merely vulnerable.
function isMaliciousVuln(vuln) {
  if (/^MAL-/i.test(vuln.id || "")) return true;
  if ((vuln.aliases || []).some((a) => /^MAL-/i.test(a))) return true;
  return false;
}

export function hasMalicious(vulns) {
  return (vulns || []).some((v) => v.malicious);
}

// CVSS base score -> qualitative label (CVSS v3.x bands).
function scoreToLabel(score) {
  if (score >= 9.0) return "CRITICAL";
  if (score >= 7.0) return "HIGH";
  if (score >= 4.0) return "MODERATE";
  if (score > 0) return "LOW";
  return "UNKNOWN";
}

function extractSeverity(vuln) {
  const dbSev = vuln?.database_specific?.severity;
  if (dbSev && SEVERITY_RANK[String(dbSev).toUpperCase()] != null) {
    return String(dbSev).toUpperCase();
  }
  // Fall back to a parsed CVSS score if present.
  const cvss = (vuln?.severity || []).find((s) => /CVSS/i.test(s.type));
  if (cvss?.score) {
    const numeric = parseFloat(cvss.score);
    if (!Number.isNaN(numeric)) return scoreToLabel(numeric);
    // score may be a vector string like "CVSS:3.1/AV:N/..." — no number to parse.
  }
  return "UNKNOWN";
}

function normalizeVuln(vuln) {
  const malicious = isMaliciousVuln(vuln);
  return {
    id: vuln.id,
    aliases: vuln.aliases || [],
    summary: vuln.summary || vuln.details?.slice(0, 160) || vuln.id,
    // Malware outranks any CVSS band so it sorts and renders as the top risk.
    severity: malicious ? "MALICIOUS" : extractSeverity(vuln),
    malicious,
    references: (vuln.references || []).slice(0, 3).map((r) => r.url),
  };
}

/**
 * Query OSV for vulnerabilities affecting a specific npm package version.
 * Returns a normalized list (possibly empty). Never throws — returns [] on error.
 */
export async function queryVulns(name, version) {
  if (!version) return [];
  const key = `${name}@${version}`;
  return cache.wrap(key, async () => {
    try {
      const res = await fetch(OSV_QUERY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version,
          package: { name, ecosystem: "npm" },
        }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.vulns || []).map(normalizeVuln);
    } catch {
      return [];
    }
  });
}

/**
 * Compare the vulnerability sets of the current vs candidate version.
 *  - fixed:      present now, gone after upgrade  (upgrade helps)
 *  - remaining:  present in both                  (upgrade doesn't help)
 *  - introduced: absent now, present after upgrade (upgrade adds risk)
 */
export async function compareSecurity(name, currentVersion, targetVersion) {
  const [currentVulns, targetVulns] = await Promise.all([
    queryVulns(name, currentVersion),
    targetVersion ? queryVulns(name, targetVersion) : Promise.resolve([]),
  ]);

  const currentIds = new Set(currentVulns.map((v) => v.id));
  const targetIds = new Set(targetVulns.map((v) => v.id));

  const fixed = currentVulns.filter((v) => !targetIds.has(v.id));
  const remaining = currentVulns.filter((v) => targetIds.has(v.id));
  const introduced = targetVulns.filter((v) => !currentIds.has(v.id));

  const worst = (list) =>
    list.reduce((max, v) => Math.max(max, SEVERITY_RANK[v.severity] ?? 0), 0);

  let verdict = "neutral"; // neutral | improves | risky | mixed
  if (introduced.length > 0 && fixed.length > 0) verdict = "mixed";
  else if (introduced.length > 0) verdict = "risky";
  else if (fixed.length > 0) verdict = "improves";

  return {
    currentCount: currentVulns.length,
    targetCount: targetVulns.length,
    fixed,
    remaining,
    introduced,
    verdict,
    maliciousCurrent: hasMalicious(currentVulns),
    maliciousTarget: hasMalicious(targetVulns),
    worstCurrent: worst(currentVulns),
    worstTarget: worst(targetVulns),
  };
}

export { SEVERITY_RANK };
