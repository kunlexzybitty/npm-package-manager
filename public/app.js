const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
};

/* ---------------- Theme toggle ---------------- */
function applyThemeIcon() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const btn = document.getElementById("theme-toggle");
  // Show the icon of the theme you'd switch TO.
  btn.textContent = isDark ? "☀️" : "🌙";
  btn.title = isDark ? "Switch to light theme" : "Switch to dark theme";
}
document.getElementById("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("mpm-theme", next);
  } catch (e) {
    /* ignore */
  }
  applyThemeIcon();
});
applyThemeIcon();

const state = {
  scan: null,
  selected: new Set(), // keys "section:name"
  filter: "all",
  browserPath: null,
  browserData: null,
  snapshots: [],
};

const key = (p) => `${p.section}:${p.name}`;

/* ---------------- API ---------------- */
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

/* ---------------- Controls ---------------- */
const pathInput = $("#path-input");
const scanBtn = $("#scan-btn");
const cooldown = $("#cooldown");

pathInput.addEventListener("input", () => {
  scanBtn.disabled = pathInput.value.trim() === "";
});
cooldown.addEventListener("input", () => {
  $("#cooldown-num").textContent = cooldown.value;
});

scanBtn.addEventListener("click", runScan);
pathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !scanBtn.disabled) runScan();
});

function setStatus(msg, kind = "info", spinner = false) {
  const box = $("#status");
  box.className = `status ${kind === "error" ? "error" : ""}`;
  box.classList.remove("hidden");
  box.innerHTML = "";
  if (spinner) box.appendChild(el("span", { class: "spinner" }));
  box.appendChild(el("span", {}, msg));
}
function clearStatus() {
  $("#status").classList.add("hidden");
}

/* ---------------- Scan ---------------- */
async function runScan() {
  const projectPath = pathInput.value.trim();
  const cooldownDays = Number(cooldown.value);
  scanBtn.disabled = true;
  ["#summary", "#toolbar"].forEach((s) => $(s).classList.add("hidden"));
  $("#results").innerHTML = "";
  state.selected.clear();
  setStatus("Scanning dependencies, querying the npm registry and OSV.dev…", "info", true);

  try {
    const scan = await api("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath, cooldownDays }),
    });
    state.scan = scan;
    clearStatus();
    renderSummary(scan);
    renderResults();
    refreshSnapshotCount();
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    scanBtn.disabled = pathInput.value.trim() === "";
  }
}

function renderSummary(scan) {
  const s = scan.summary;
  const stats = [
    { num: s.updates, lbl: "Updates available", cls: "" },
    { num: s.patch, lbl: "Patch bumps", cls: "" },
    { num: s.minor, lbl: "Minor bumps", cls: "" },
    { num: s.securityImproves, lbl: "Fix vulnerabilities", cls: "good" },
    { num: s.maliciousAvoided, lbl: "Malicious ver. skipped", cls: s.maliciousAvoided ? "bad" : "" },
    { num: s.blocked, lbl: "Blocked (all malicious)", cls: s.blocked ? "bad" : "" },
    { num: s.heldByCooldown, lbl: `Held by cooldown`, cls: s.heldByCooldown ? "warn" : "" },
  ];
  const box = $("#summary");
  box.innerHTML = "";
  stats.forEach((st) =>
    box.appendChild(
      el("div", { class: `stat ${st.cls}` }, [
        el("div", { class: "num" }, String(st.num)),
        el("div", { class: "lbl" }, st.lbl),
      ])
    )
  );
  box.classList.remove("hidden");

  const meta = el("div", { class: "hint", style: "grid-column:1/-1;margin-top:4px" },
    `${scan.projectName || scan.projectPath} · ${s.total} deps scanned · cooldown ${scan.cooldownDays}d` +
    (s.skipped ? ` · ${s.skipped} skipped` : "") + (s.errors ? ` · ${s.errors} errors` : "")
  );
  box.appendChild(meta);
}

/* ---------------- Filters / toolbar ---------------- */
$("#type-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.filter = btn.dataset.filter;
  $("#type-filter").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
  renderResults();
});

$("#filter-select-all").addEventListener("change", (e) => {
  const updates = visibleUpdates();
  if (e.target.checked) updates.forEach((p) => state.selected.add(key(p)));
  else updates.forEach((p) => state.selected.delete(key(p)));
  renderResults();
});

$("#apply-btn").addEventListener("click", applySelected);

function visibleUpdates() {
  const pkgs = (state.scan?.packages || []).filter((p) => p.status === "update");
  return pkgs.filter((p) => {
    if (state.filter === "all") return true;
    if (state.filter === "patch") return p.bumpType === "patch";
    if (state.filter === "minor") return p.bumpType === "minor";
    if (state.filter === "security")
      return p.security && p.security.verdict !== "neutral";
    return true;
  });
}

function updateApplyBtn() {
  $("#apply-btn").disabled = state.selected.size === 0;
  $("#apply-btn").textContent = state.selected.size
    ? `Apply ${state.selected.size} update${state.selected.size > 1 ? "s" : ""}`
    : "Apply selected";
}

/* ---------------- Results ---------------- */
function renderResults() {
  const box = $("#results");
  box.innerHTML = "";
  const updates = visibleUpdates();

  if (!state.scan) return;
  $("#toolbar").classList.remove("hidden");

  // Blocked packages (every newer version is malware) always show first as alerts.
  const blocked = (state.scan.packages || []).filter((p) => p.status === "blocked");
  blocked.forEach((p) => box.appendChild(renderBlocked(p)));

  if (updates.length === 0 && blocked.length === 0) {
    box.appendChild(el("div", { class: "empty" },
      state.scan.summary.updates === 0
        ? "🎉 Everything is up to date within its current major version."
        : "No packages match this filter."));
    updateApplyBtn();
    return;
  }

  updates.forEach((p) => box.appendChild(renderPackage(p)));

  // sync select-all checkbox
  const allSelected = updates.every((p) => state.selected.has(key(p)));
  $("#filter-select-all").checked = allSelected && updates.length > 0;
  updateApplyBtn();
}

function fmtDate(iso) {
  if (!iso) return "unknown";
  return new Date(iso).toISOString().slice(0, 10);
}

function renderPackage(p) {
  const k = key(p);
  const selected = state.selected.has(k);

  const checkbox = el("input", { type: "checkbox" });
  checkbox.checked = selected;
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selected.add(k);
    else state.selected.delete(k);
    card.classList.toggle("selected", checkbox.checked);
    const updates = visibleUpdates();
    $("#filter-select-all").checked = updates.every((x) => state.selected.has(key(x)));
    updateApplyBtn();
  });

  const nameRow = el("div", { class: "pkg-name" }, [
    p.name,
    el("span", { class: `badge ${p.bumpType}` }, p.bumpType),
    el("span", { class: "pkg-section" }, p.section),
    p.deprecated ? el("span", { class: "badge deprecated", title: p.deprecated }, "deprecated") : null,
    p.heldBack ? el("span", { class: "badge cooldown", title: `Newer version ${p.latestIgnoringCooldown} is inside the cooldown window` }, "cooldown‑capped") : null,
  ]);

  const versionLine = el("div", { class: "version-line" }, [
    el("span", { class: "from" }, p.current),
    el("span", { class: "arrow" }, "→"),
    el("span", { class: "to" }, `${p.target}`),
    el("span", { class: "hint", style: "display:inline;margin-left:10px" }, `(${p.range} → ${p.newRange})`),
  ]);

  const metaLine = el("div", { class: "meta-line" }, [
    el("span", {}, `published ${fmtDate(p.publishedAt)}`),
    p.ageDays != null ? el("span", {}, `${p.ageDays} days old`) : null,
    p.currentFromLock ? el("span", {}, "current from lockfile") : el("span", {}, "current from range"),
  ]);

  const parts = [nameRow, versionLine, metaLine];
  if (p.skippedMalicious?.length) {
    parts.push(el("div", { class: "malware-note" },
      `⚠ Skipped ${p.skippedMalicious.join(", ")} — flagged as malicious by OSV. Targeting the newest safe version instead.`));
  }
  const main = el("div", { class: "pkg-main" }, parts);

  const card = el("div", { class: `pkg ${selected ? "selected" : ""}` }, [
    el("div", { class: "select" }, checkbox),
    main,
    renderSecurity(p.security),
  ]);
  return card;
}

function renderBlocked(p) {
  return el("div", { class: "pkg blocked" }, [
    el("div", { class: "select" }, "🚫"),
    el("div", { class: "pkg-main" }, [
      el("div", { class: "pkg-name" }, [
        p.name,
        el("span", { class: "badge malicious" }, "no safe upgrade"),
        el("span", { class: "pkg-section" }, p.section),
      ]),
      el("div", { class: "version-line" }, [
        el("span", { class: "from" }, p.current),
        el("span", { class: "hint", style: "display:inline;margin-left:10px" }, `currently on ${p.range}`),
      ]),
      el("div", { class: "malware-note" },
        `⚠ Every newer version within this major (${(p.skippedMalicious || []).join(", ")}) is flagged as malicious by OSV. No upgrade offered — stay on ${p.current} and watch for a clean release.`),
    ]),
  ]);
}

function vulnRow(v) {
  const link = v.references && v.references[0];
  return el("div", { class: "vuln" }, [
    el("span", { class: `sev ${v.severity}` }, v.severity),
    link
      ? el("a", { href: link, target: "_blank", rel: "noopener" }, v.id)
      : el("span", {}, v.id),
    el("span", { style: "color:var(--text-dim)" }, v.summary),
  ]);
}

function renderSecurity(sec) {
  if (!sec) return null;
  const wrap = el("div", { class: "security" });

  const verdictLabel = {
    improves: "✓ Upgrade fixes vulnerabilities",
    risky: "⚠ Upgrade introduces vulnerabilities",
    mixed: "⚠ Fixes some, introduces others",
    neutral: "No known vulnerability change",
  }[sec.verdict];

  wrap.appendChild(
    el("div", { class: "sec-head" }, [
      el("span", {}, "Security"),
      el("span", { class: `verdict ${sec.verdict}` }, verdictLabel),
      el("span", { class: "hint", style: "display:inline" },
        `current: ${sec.currentCount} · candidate: ${sec.targetCount}`),
    ])
  );

  if (sec.fixed.length + sec.remaining.length + sec.introduced.length === 0) {
    wrap.appendChild(el("div", { class: "sec-clean" }, "No known vulnerabilities on either version (per OSV.dev)."));
    return wrap;
  }

  const groups = el("div", { class: "vuln-groups" });
  const addGroup = (cls, title, list) => {
    if (!list.length) return;
    groups.appendChild(
      el("div", { class: `vuln-group ${cls}` }, [
        el("div", { class: "vuln-group-title" }, `${title} (${list.length})`),
        ...list.map(vulnRow),
      ])
    );
  };
  addGroup("fixed", "Fixed by upgrade", sec.fixed);
  addGroup("introduced", "Introduced by upgrade", sec.introduced);
  addGroup("remaining", "Still present after upgrade", sec.remaining);
  wrap.appendChild(groups);
  return wrap;
}

/* ---------------- Apply ---------------- */
async function applySelected() {
  const updates = (state.scan.packages || [])
    .filter((p) => p.status === "update" && state.selected.has(key(p)))
    .map((p) => ({ name: p.name, section: p.section, newRange: p.newRange }));
  if (!updates.length) return;

  const btn = $("#apply-btn");
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Applying & installing…";

  try {
    const result = await api("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: state.scan.projectPath, updates, install: true }),
    });
    showApplyResult(result);
    // Re-scan to reflect the new baseline.
    await runScan();
  } catch (err) {
    showApplyResult({ error: err.message });
  } finally {
    btn.textContent = prev;
    updateApplyBtn();
  }
}

function showApplyResult(result) {
  const body = $("#apply-body");
  body.innerHTML = "";

  if (result.error) {
    body.appendChild(el("p", { class: "fail-text" }, `Failed: ${result.error}`));
  } else {
    if (result._restoreOf) {
      body.appendChild(el("h3", { class: "ok-text" }, "Snapshot restored"));
      body.appendChild(el("ul", {}, (result.restored || []).map((f) => el("li", {}, f))));
    }
    if (result.applied?.length) {
      body.appendChild(el("h3", {}, `Updated ${result.applied.length} package(s) in package.json`));
      body.appendChild(el("ul", {}, result.applied.map((a) =>
        el("li", {}, `${a.name}: ${a.from} → ${a.to}`))));
      if (result.snapshot)
        body.appendChild(el("p", { class: "hint ok-text" },
          `Snapshot saved (${result.snapshot.files.join(", ")}). Use History to revert.`));
    }
    if (result.skipped?.length) {
      body.appendChild(el("h3", {}, "Skipped"));
      body.appendChild(el("ul", {}, result.skipped.map((s) => el("li", {}, `${s.name}: ${s.reason}`))));
    }
    if (result.install) {
      body.appendChild(el("h3", { class: result.install.ok ? "ok-text" : "fail-text" },
        result.install.ok ? "npm install succeeded" : `npm install failed (exit ${result.install.code})`));
      body.appendChild(el("pre", {}, result.install.output || "(no output)"));
    }
  }
  $("#apply-modal").classList.remove("hidden");
}
$("#apply-close").addEventListener("click", () => $("#apply-modal").classList.add("hidden"));

/* ---------------- Snapshots / revert ---------------- */
$("#history-btn").addEventListener("click", openSnapshots);
$("#snapshots-close").addEventListener("click", () => $("#snapshots-modal").classList.add("hidden"));

async function refreshSnapshotCount() {
  if (!state.scan) return;
  try {
    const data = await api(`/api/snapshots?path=${encodeURIComponent(state.scan.projectPath)}`);
    state.snapshots = data.snapshots;
    $("#history-btn").textContent = data.snapshots.length
      ? `History (${data.snapshots.length})`
      : "History";
  } catch {
    /* non-fatal */
  }
}

async function openSnapshots() {
  const modal = $("#snapshots-modal");
  const list = $("#snapshots-list");
  modal.classList.remove("hidden");
  list.innerHTML = "<li class='hint'>Loading…</li>";
  try {
    const data = await api(`/api/snapshots?path=${encodeURIComponent(state.scan.projectPath)}`);
    state.snapshots = data.snapshots;
    renderSnapshots();
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(el("li", { class: "fail-text" }, err.message));
  }
}

function renderSnapshots() {
  const list = $("#snapshots-list");
  list.innerHTML = "";
  if (!state.snapshots?.length) {
    list.appendChild(el("li", { class: "empty" }, "No snapshots yet. One is saved automatically before each apply."));
    return;
  }
  state.snapshots.forEach((s) => list.appendChild(renderSnapshot(s)));
}

function renderSnapshot(s) {
  const when = s.createdAt ? new Date(s.createdAt).toLocaleString() : s.id;
  const count = s.updates?.length || 0;
  const info = el("div", { class: "snap-info" }, [
    el("div", { class: "snap-when" }, when),
    el("div", { class: "snap-meta" },
      `${s.reason || "manual"}${count ? ` · ${count} package${count > 1 ? "s" : ""} changed` : ""}`),
    el("div", { class: "snap-files" }, (s.files || []).join(" · ") || "no files captured"),
  ]);

  const restoreBtn = el("button", { class: "btn primary small" }, "Restore");
  restoreBtn.addEventListener("click", () => restore(s.id, restoreBtn));

  const delBtn = el("button", { class: "btn danger small" }, "Delete");
  delBtn.addEventListener("click", () => removeSnapshot(s.id));

  return el("div", { class: "snap" }, [
    info,
    el("div", { class: "snap-actions" }, [restoreBtn, delBtn]),
  ]);
}

async function restore(id, btn) {
  if (!confirm("Restore this snapshot? It will overwrite package.json and lockfiles, then run npm install.")) return;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Restoring…";
  try {
    const result = await api("/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: state.scan.projectPath, id, install: true }),
    });
    $("#snapshots-modal").classList.add("hidden");
    showApplyResult({
      applied: [],
      restored: result.restored,
      install: result.install,
      _restoreOf: id,
    });
    await runScan();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prev;
    alert(`Restore failed: ${err.message}`);
  }
}

async function removeSnapshot(id) {
  if (!confirm("Delete this snapshot permanently?")) return;
  try {
    await api(`/api/snapshots?path=${encodeURIComponent(state.scan.projectPath)}&id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await openSnapshots();
    refreshSnapshotCount();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

/* ---------------- Folder browser ---------------- */
$("#browse-btn").addEventListener("click", () => openBrowser(pathInput.value.trim() || undefined));
$("#browser-close").addEventListener("click", () => $("#browser").classList.add("hidden"));
$("#browser-up").addEventListener("click", () => state.browserData?.parent && openBrowser(state.browserData.parent));
$("#browser-home").addEventListener("click", () => openBrowser(state.browserData?.home));
$("#browser-select").addEventListener("click", () => {
  pathInput.value = state.browserData.path;
  scanBtn.disabled = false;
  $("#browser").classList.add("hidden");
  runScan();
});

async function openBrowser(path) {
  $("#browser").classList.remove("hidden");
  $("#browser-list").innerHTML = "<li>Loading…</li>";
  try {
    const data = await api(`/api/browse?path=${encodeURIComponent(path || "")}`);
    state.browserData = data;
    $("#browser-path").textContent = data.path;
    $("#browser-up").disabled = !data.parent;
    const pkg = $("#browser-pkg");
    const sel = $("#browser-select");
    if (data.hasPackageJson) {
      pkg.textContent = "✓ Contains package.json";
      pkg.className = "hint ok-text";
      sel.disabled = false;
    } else {
      pkg.textContent = "No package.json here — open a project folder";
      pkg.className = "hint";
      sel.disabled = true;
    }
    const list = $("#browser-list");
    list.innerHTML = "";
    if (!data.directories.length) {
      list.appendChild(el("li", { style: "color:var(--text-faint)" }, "(no sub-folders)"));
    }
    data.directories.forEach((d) => {
      list.appendChild(
        el("li", { onclick: () => openBrowser(`${data.path}/${d.name}`) }, [
          el("span", {}, "📁"),
          el("span", {}, d.name),
          d.isProject ? el("span", { class: "proj-tag" }, "● project") : null,
        ])
      );
    });
  } catch (err) {
    $("#browser-list").innerHTML = "";
    $("#browser-list").appendChild(el("li", { class: "fail-text" }, err.message));
  }
}
