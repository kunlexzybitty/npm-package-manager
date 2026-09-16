import { TtlCache } from "./util/concurrency.js";

const REGISTRY = "https://registry.npmjs.org";
const cache = new TtlCache(10 * 60 * 1000);

/**
 * Fetch the packument for a package and return the list of published versions
 * plus a version->ISO-date map from the registry's `time` field.
 */
export async function getPackageMeta(name) {
  return cache.wrap(name, async () => {
    const url = `${REGISTRY}/${encodeURIComponent(name).replace(/^%40/, "@")}`;
    let res;
    try {
      res = await fetch(url, {
        headers: {
          // Abbreviated metadata is smaller and still includes `time`? No —
          // `time` is only on the full document, so request the full one.
          Accept: "application/json",
        },
      });
    } catch (err) {
      return { ok: false, error: `network error: ${err.message}` };
    }

    if (res.status === 404) return { ok: false, error: "not found on registry" };
    if (!res.ok) return { ok: false, error: `registry returned ${res.status}` };

    const doc = await res.json();
    const versions = Object.keys(doc.versions || {});
    const timeMap = doc.time || {};

    return {
      ok: true,
      name: doc.name || name,
      versions,
      timeMap,
      latestTag: doc["dist-tags"]?.latest || null,
      deprecatedVersions: Object.fromEntries(
        Object.entries(doc.versions || {})
          .filter(([, v]) => v && v.deprecated)
          .map(([ver, v]) => [ver, String(v.deprecated)])
      ),
    };
  });
}
