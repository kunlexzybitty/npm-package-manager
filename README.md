# Minor / Patch Manager

A local web tool to scan Node/React projects for **minor & patch** dependency
updates, compare the **security posture** of the current vs candidate version,
and apply the upgrades you choose — straight into `package.json` plus
`npm install`.

Built for reviewing multiple projects safely: it never crosses a major version,
respects a configurable **cooldown** (ignore releases that are too fresh), and
shows you exactly which vulnerabilities an upgrade fixes, keeps, or introduces
before you commit.

## Features

- **Light / dark theme** — defaults to light (and respects your OS preference on
  first load); a toggle in the header switches themes and remembers your choice.
- **Folder picker UI** — browse your filesystem and pick any project directory
  (folders containing a `package.json` are flagged).
- **Minor/patch only** — upgrades stay within the current major version, so no
  breaking-change surprises. Pre-releases are never suggested.
- **Cooldown slider (0–90 days)** — versions published fewer than N days ago are
  ignored; the tool falls back to the newest release that clears the window and
  labels anything held back.
- **Security diff via [OSV.dev](https://osv.dev)** — for every available upgrade
  it queries vulnerabilities on both the current and candidate version and
  groups them into **fixed / still-present / introduced**, with severity badges.
- **Compromised-version avoidance** — OSV malware advisories (`MAL-*`) are
  detected specially: the tool **steps down past any version flagged as
  malicious** and targets the newest *safe* release instead, noting what it
  skipped. If every newer version in the major is malicious, the package is
  marked **blocked** (no upgrade offered) rather than silently advanced.
- **Selective apply** — tick the upgrades you want, then it rewrites the version
  ranges (preserving your `^` / `~` / pinned style) and runs `npm install`. The
  results are re-scanned automatically.
- **Automatic snapshots & one-click revert** — before every apply, a snapshot of
  `package.json` plus any lockfile is saved to `.mpm-snapshots/<timestamp>/`.
  Open **History** to restore or delete snapshots; restoring reverts the files
  and re-installs.
- **Lockfile-aware** — reads `npm-shrinkwrap.json` when present (with precedence
  over `package-lock.json`, matching npm), so the reported "current" version
  reflects what the project actually ships.

## Requirements

- Node.js ≥ 18 (uses the built-in `fetch`)
- npm on your `PATH` (used for the install step)
- Network access to `registry.npmjs.org` and `api.osv.dev`

## Usage

```bash
npm install
npm start
# open http://localhost:4321
```

Set a different port with `PORT=5000 npm start`.

1. Click **Browse…** (or paste a path) and select a project folder.
2. Choose a **cooldown** in days.
3. Click **Scan**.
4. Review each package's version bump and security diff, tick the ones you want,
   and click **Apply**.

## How it decides the "current" version

If a lockfile exists (`npm-shrinkwrap.json` is preferred over
`package-lock.json`), the actually-installed version is used as the baseline.
Otherwise it falls back to the floor of the declared range (e.g. `^1.2.3` →
`1.2.3`). Non-registry ranges (git, file:, workspace:, `*`, `latest`) are
skipped.

## Snapshots & reverting

Every apply first writes a snapshot to `.mpm-snapshots/<timestamp>/` containing
`package.json` and any present lockfile (`package-lock.json` /
`npm-shrinkwrap.json`), plus a `snapshot.json` manifest recording what changed.
Use the **History** button to restore or delete them. You'll likely want to add
`.mpm-snapshots/` to your project's `.gitignore`.

## Project layout

```
server/
  index.js        Express app + API routes (/api/browse, /api/scan, /api/apply)
  scanner.js      Orchestrates scan: resolve upgrades + security comparison
  registry.js     npm registry client (versions + publish dates), cached
  osv.js          OSV.dev vulnerability queries + current-vs-target diff
  applier.js      Rewrite package.json ranges and run npm install
  snapshots.js    Snapshot / restore / delete package.json + lockfiles
  project.js      Read package.json / lockfile (shrinkwrap-aware)
  fsbrowse.js     Filesystem directory listing for the folder picker
  util/           Concurrency limiter + TTL cache, semver/version helpers
public/           No-build frontend (index.html, styles.css, app.js)
```

## Defending against compromised packages

Three layers work together:

1. **Registry reality** — only versions actually published to npm are ever
   considered, so versions that were unpublished after a compromise are
   automatically out of scope.
2. **Cooldown** — most supply-chain compromises are caught and yanked within
   hours to days. A cooldown of ~7–30 days makes the tool skip fresh releases
   entirely and fall back to a vetted older one. This is your strongest lever.
3. **Malware avoidance** — the target-selection step queries OSV per candidate
   and refuses any version carrying a `MAL-*` advisory, stepping down to the
   newest safe version (or marking the package **blocked** if none is safe).

This reduces exposure but is not a guarantee: detection depends on OSV having
ingested the advisory, which can lag a brand-new compromise. Cooldown is the
mitigation for that timing gap.

## Notes & limits

- **npm only** for now — reads/writes `package.json` and uses the lockfile
  (`npm-shrinkwrap.json` or `package-lock.json`) as the source of truth for
  installed versions.
- The security comparison reflects OSV's data at scan time; absence of a finding
  is not a guarantee a version is vulnerability-free.
- The apply step edits `package.json` in place (after writing a snapshot to
  `.mpm-snapshots/`) and runs `npm install` in that directory.
