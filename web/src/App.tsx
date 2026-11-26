import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ALLOC_OPTIONS, countAllocOptions, matchesAllocFilter } from "./allocFilter";
import PendingView from "./PendingView";
import StatsView from "./StatsView";
import type {
  AuditLogEntry,
  AuthUser,
  FacilitiesCatalog,
  FacilityRecord,
  MatchedFile,
  ResourcesCatalog,
  ValidationRecord,
  ValidationStatus,
} from "./types";

function fmtPhp(v: number): string {
  if (!v) return "₱0";
  const sign = v < 0 ? "−" : "";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${sign}₱${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}₱${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}₱${(abs / 1e3).toFixed(0)}K`;
  return `${sign}₱${abs.toLocaleString()}`;
}

function fmtBytes(b: number): string {
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

function fileUrl(localPath: string): string {
  const encoded = localPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `/local-files/${encoded}`;
}

function isImage(ext: string): boolean {
  return ["jpg", "jpeg", "jfif", "png", "gif", "webp", "svg"].includes(ext.toLowerCase());
}

function isPdf(ext: string): boolean {
  return ext.toLowerCase() === "pdf";
}

function budgetBadgeClass(status: string): string {
  if (status === "gab_inserted" || status === "increased") return "ok";
  if (status === "nep_dropped" || status === "decreased") return "bad";
  if (status === "senate_only") return "purple";
  return "neutral";
}

function validationBadge(v?: ValidationRecord): { label: string; cls: string } | null {
  if (!v?.status) return null;
  switch (v.status) {
    case "verified":
      return { label: "Verified", cls: "ok" };
    case "incomplete":
      return { label: "Incomplete", cls: "warn" };
    case "needs_followup":
      return { label: "Follow-up", cls: "purple" };
    case "mismatch":
      return { label: "Mismatch", cls: "bad" };
  }
}

function summarizeAudit(log: AuditLogEntry): string {
  if (log.action === "validation_update" && log.after && typeof log.after === "object") {
    const a = log.after as { status?: string; note?: string };
    const st = a.status ? `status=${a.status}` : "status=cleared";
    const note = a.note ? ` · "${a.note.slice(0, 40)}"` : "";
    return `${st}${note}`;
  }
  return log.action;
}

const CHECKLIST_ITEMS: Array<{ key: keyof ValidationRecord["checklist"]; label: string }> = [
  { key: "site_readiness", label: "Site Readiness" },
  { key: "land_ownership", label: "Proof of Lot Ownership" },
  { key: "hazard_assessment", label: "Hazard Assessment" },
  { key: "sdp_daed", label: "SDP / DAED" },
  { key: "manpower", label: "Manpower Availability" },
];

type TabKey = "explorer" | "pending" | "stats";

function tabFromPath(pathname: string): TabKey {
  const clean = pathname.replace(/\/+$/, "").toLowerCase();
  if (clean === "/pending") return "pending";
  if (clean === "/statistics" || clean === "/stats") return "stats";
  return "explorer";
}

function pathForTab(tab: TabKey): string {
  if (tab === "pending") return "/pending";
  if (tab === "stats") return "/statistics";
  return "/";
}

function readExplorerParams() {
  const sp = new URLSearchParams(window.location.search);
  return {
    search: sp.get("q") || "",
    region: sp.get("region") || "all",
    budget: sp.get("budget") || "all",
    download: sp.get("download") || "downloaded",
    validation: sp.get("validation") || "all",
    alloc: sp.get("alloc") || "all",
    facility: sp.get("facility") || null,
  };
}

export default function App() {
  const [catalog, setCatalog] = useState<FacilitiesCatalog | null>(null);
  const [resources, setResources] = useState<ResourcesCatalog | null>(null);
  const [validations, setValidations] = useState<Record<string, ValidationRecord>>({});
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auth modal
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authUsername, setAuthUsername] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  // Audit logs
  const [facilityLogs, setFacilityLogs] = useState<AuditLogEntry[]>([]);
  const [auditModalOpen, setAuditModalOpen] = useState(false);
  const [globalLogs, setGlobalLogs] = useState<AuditLogEntry[]>([]);

  // Filters (initialized from URL query params)
  const initialParams = useMemo(() => readExplorerParams(), []);
  const [activeTab, setActiveTabState] = useState<TabKey>(() => tabFromPath(window.location.pathname));
  const [search, setSearch] = useState(initialParams.search);
  const [regionFilter, setRegionFilter] = useState(initialParams.region);
  const [budgetStatusFilter, setBudgetStatusFilter] = useState(initialParams.budget);
  const [downloadFilter, setDownloadFilter] = useState(initialParams.download);
  const [validationFilter, setValidationFilter] = useState(initialParams.validation);
  const [allocFilter, setAllocFilter] = useState(initialParams.alloc);

  // Selection
  const [selectedCode, setSelectedCode] = useState<string | null>(initialParams.facility);
  const [selectedFile, setSelectedFile] = useState<MatchedFile | null>(null);
  const [fileScope, setFileScope] = useState<"matched" | "all_resource">("matched");
  const [saving, setSaving] = useState(false);

  const buildExplorerUrl = useCallback(
    (overrides?: {
      search?: string;
      region?: string;
      budget?: string;
      download?: string;
      validation?: string;
      facility?: string | null;
    }) => {
      const sp = new URLSearchParams();
      const q = overrides?.search ?? search;
      const reg = overrides?.region ?? regionFilter;
      const bud = overrides?.budget ?? budgetStatusFilter;
      const dl = overrides?.download ?? downloadFilter;
      const val = overrides?.validation ?? validationFilter;
      const fac = overrides?.facility !== undefined ? overrides.facility : selectedCode;
      if (q) sp.set("q", q);
      if (reg !== "all") sp.set("region", reg);
      if (bud !== "all") sp.set("budget", bud);
      if (dl !== "downloaded") sp.set("download", dl);
      if (val !== "all") sp.set("validation", val);
      if (allocFilter !== "all") sp.set("alloc", allocFilter);
      if (fac) sp.set("facility", fac);
      const qs = sp.toString();
      return qs ? `/?${qs}` : "/";
    },
    [
      search,
      regionFilter,
      budgetStatusFilter,
      downloadFilter,
      validationFilter,
      allocFilter,
      selectedCode,
    ]
  );

  const setActiveTab = useCallback(
    (tab: TabKey) => {
      setActiveTabState(tab);
      const target = tab === "explorer" ? buildExplorerUrl() : pathForTab(tab);
      if (window.location.pathname + window.location.search !== target) {
        window.history.pushState({ tab }, "", target);
      }
    },
    [buildExplorerUrl]
  );

  // Sync Explorer filters & selected facility to URL query params
  useEffect(() => {
    if (activeTab !== "explorer") return;
    const target = buildExplorerUrl();
    if (window.location.pathname + window.location.search !== target) {
      window.history.replaceState({ tab: "explorer" }, "", target);
    }
  }, [activeTab, buildExplorerUrl]);

  useEffect(() => {
    const onPopState = () => {
      const tab = tabFromPath(window.location.pathname);
      setActiveTabState(tab);
      if (tab === "explorer") {
        const p = readExplorerParams();
        setSearch(p.search);
        setRegionFilter(p.region);
        setBudgetStatusFilter(p.budget);
        setDownloadFilter(p.download);
        setValidationFilter(p.validation);
        setAllocFilter(p.alloc);
        if (p.facility) setSelectedCode(p.facility);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/facilities").then((r) => r.json()),
      fetch("/api/resources").then((r) => r.json()),
      fetch("/api/validations").then((r) => r.json()),
      fetch("/api/auth/me").then((r) => r.json()),
    ])
      .then(([facData, resData, valData, authData]) => {
        setCatalog(facData);
        setResources(resData);
        setValidations(valData || {});
        setUser(authData?.user ?? null);
        if (!initialParams.facility) {
          const firstDl = facData.facilities.find((f: FacilityRecord) => f.download.downloaded);
          setSelectedCode((firstDl || facData.facilities[0])?.facility_code ?? null);
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  const loadFacilityLogs = useCallback((fcode: string) => {
    fetch(`/api/audit-logs?facility_code=${encodeURIComponent(fcode)}&limit=20`)
      .then((r) => r.json())
      .then((d) => setFacilityLogs(d.logs || []))
      .catch(() => setFacilityLogs([]));
  }, []);

  const openGlobalAudit = useCallback(() => {
    setAuditModalOpen(true);
    fetch("/api/audit-logs?limit=100")
      .then((r) => r.json())
      .then((d) => setGlobalLogs(d.logs || []))
      .catch(() => setGlobalLogs([]));
  }, []);

  const resourceByCode = useMemo(() => {
    const map = new Map<string, ResourcesCatalog["resources"][number]>();
    resources?.resources.forEach((r) => map.set(r.resource_code, r));
    return map;
  }, [resources]);

  const regions = useMemo(() => {
    if (!catalog) return [];
    return Array.from(new Set(catalog.facilities.map((f) => f.region).filter(Boolean))).sort();
  }, [catalog]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const q = search.trim().toLowerCase();
    return catalog.facilities.filter((f) => {
      if (regionFilter !== "all" && f.region !== regionFilter) return false;
      if (budgetStatusFilter !== "all" && !f.budget.statuses.includes(budgetStatusFilter)) {
        return false;
      }
      if (!matchesAllocFilter(f, allocFilter)) return false;
      if (downloadFilter === "downloaded" && !f.download.downloaded) return false;
      if (downloadFilter === "needs_review" && !f.download.needs_review) return false;
      if (downloadFilter === "pending" && f.download.downloaded) return false;
      if (
        ["auth_required", "empty_public_folder", "no_url", "not_found"].includes(downloadFilter) &&
        f.download.reason !== downloadFilter
      ) {
        return false;
      }

      const v = validations[f.facility_code];
      if (validationFilter === "unreviewed" && v?.status) return false;
      if (
        ["verified", "incomplete", "needs_followup", "mismatch"].includes(validationFilter) &&
        v?.status !== validationFilter
      ) {
        return false;
      }

      if (q) {
        const hay = [
          f.facility_code,
          f.facility,
          f.region,
          f.province,
          f.category,
          f.resource.resource_code,
          ...(f.download.matched_subfolders || []),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    catalog,
    search,
    regionFilter,
    budgetStatusFilter,
    downloadFilter,
    validationFilter,
    validations,
    allocFilter,
  ]);

  const allocCounts = useMemo(
    () => countAllocOptions(catalog?.facilities || []),
    [catalog]
  );

  const selected: FacilityRecord | null = useMemo(() => {
    if (!catalog || !selectedCode) return null;
    return catalog.facilities.find((f) => f.facility_code === selectedCode) ?? null;
  }, [catalog, selectedCode]);

  const activeResource = selected ? resourceByCode.get(selected.resource.resource_code) : undefined;

  useEffect(() => {
    setFileScope("matched");
    if (selected) {
      loadFacilityLogs(selected.facility_code);
      if (selected.download.files.length > 0) {
        const firstPdf = selected.download.files.find((f) => isPdf(f.ext));
        setSelectedFile(firstPdf || selected.download.files[0]);
      } else {
        setSelectedFile(null);
      }
    } else {
      setSelectedFile(null);
      setFacilityLogs([]);
    }
  }, [selected?.facility_code, loadFacilityLogs]);

  const displayedFiles: MatchedFile[] = useMemo(() => {
    if (!selected) return [];
    if (fileScope === "matched") return selected.download.files;
    if (!activeResource) return [];
    return activeResource.subfolders.flatMap((sf) =>
      sf.files.map((f) => ({ ...f, subfolder: sf.subfolder }))
    );
  }, [selected, fileScope, activeResource]);

  const groupedFiles = useMemo(() => {
    const groups = new Map<string, MatchedFile[]>();
    for (const f of displayedFiles) {
      const key = f.subfolder || "(root)";
      const list = groups.get(key) || [];
      list.push(f);
      groups.set(key, list);
    }
    return Array.from(groups.entries());
  }, [displayedFiles]);

  async function handleAuthSubmit(e: FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthBusy(true);
    try {
      const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body =
        authMode === "login"
          ? { username: authUsername, password: authPassword }
          : { username: authUsername, display_name: authDisplayName || authUsername, password: authPassword };
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setAuthError(data.error || "Authentication failed.");
        return;
      }
      setUser(data.user);
      setAuthModalOpen(false);
      setAuthPassword("");
    } catch (err) {
      setAuthError(String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
  }

  async function saveValidation(fcode: string, next: ValidationRecord | null) {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    setSaving(true);
    try {
      const resp = await fetch("/api/validations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facility_code: fcode, record: next }),
      });
      if (resp.status === 401) {
        setUser(null);
        setAuthModalOpen(true);
        return;
      }
      const data = await resp.json();
      if (resp.ok) {
        setValidations((prev) => {
          const copy = { ...prev };
          if (!data.record) delete copy[fcode];
          else copy[fcode] = data.record;
          return copy;
        });
        loadFacilityLogs(fcode);
      }
    } finally {
      setSaving(false);
    }
  }

  function currentVal(fcode: string): ValidationRecord {
    return validations[fcode] || { status: null, checklist: {}, note: "" };
  }

  function setStatus(status: ValidationStatus | null) {
    if (!selected) return;
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    const cur = currentVal(selected.facility_code);
    saveValidation(selected.facility_code, { ...cur, status });
  }

  function toggleCheck(key: keyof ValidationRecord["checklist"]) {
    if (!selected) return;
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    const cur = currentVal(selected.facility_code);
    saveValidation(selected.facility_code, {
      ...cur,
      checklist: { ...cur.checklist, [key]: !cur.checklist[key] },
    });
  }

  function updateNote(note: string) {
    if (!selected || !user) return;
    const cur = currentVal(selected.facility_code);
    setValidations((prev) => ({
      ...prev,
      [selected.facility_code]: { ...cur, note },
    }));
  }

  function commitNote() {
    if (!selected || !user) return;
    saveValidation(selected.facility_code, currentVal(selected.facility_code));
  }

  const reviewedCount = useMemo(
    () => Object.values(validations).filter((v) => v?.status).length,
    [validations]
  );

  if (error) {
    return <div className="empty-state">Error loading catalog: {error}</div>;
  }
  if (!catalog) {
    return <div className="empty-state">Loading HFEP 2027 catalog…</div>;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1>HFEP 2027 — Facilities Explorer &amp; Validator</h1>
          <div className="subtitle">
            SQLite-backed local reviewer · NEP vs HREP-GAB + downloaded PDFs
          </div>
        </div>
        <div className="topbar-right">
          <div className="nav-tabs">
            <button
              className={`nav-tab ${activeTab === "explorer" ? "active" : ""}`}
              onClick={() => setActiveTab("explorer")}
            >
              Explorer
            </button>
            <button
              className={`nav-tab ${activeTab === "pending" ? "active" : ""}`}
              onClick={() => setActiveTab("pending")}
            >
              Pending ({catalog.counts.pending_facilities})
            </button>
            <button
              className={`nav-tab ${activeTab === "stats" ? "active" : ""}`}
              onClick={() => setActiveTab("stats")}
            >
              Statistics
            </button>
          </div>
          <div className="kpis">
            <div className="kpi">
              <span className="label">Facilities</span>
              <span className="val">{catalog.counts.total_facilities}</span>
            </div>
            <div className="kpi ok">
              <span className="label">Downloaded</span>
              <span className="val">{catalog.counts.downloaded_facilities}</span>
            </div>
            <div className="kpi warn">
              <span className="label">Needs Review</span>
              <span className="val">{catalog.counts.needs_review}</span>
            </div>
            <div className="kpi accent">
              <span className="label">Validated</span>
              <span className="val">{reviewedCount}</span>
            </div>
          </div>

          <button className="btn" onClick={openGlobalAudit}>
            Audit Log
          </button>
          <a className="btn" href="/api/validations/export.csv" download>
            Export CSV
          </a>

          {user ? (
            <>
              <span className="user-pill">
                {user.display_name} (@{user.username})
              </span>
              <button className="btn" onClick={handleLogout}>
                Sign out
              </button>
            </>
          ) : (
            <button
              className="btn primary"
              onClick={() => {
                setAuthMode("login");
                setAuthError(null);
                setAuthModalOpen(true);
              }}
            >
              Sign in
            </button>
          )}
        </div>
      </header>

      {activeTab === "pending" ? (
        <PendingView
          catalog={catalog}
          onSelectFacility={(fcode) => {
            setDownloadFilter("all");
            setRegionFilter("all");
            setValidationFilter("all");
            setSelectedCode(fcode);
            setActiveTab("explorer");
          }}
        />
      ) : activeTab === "stats" ? (
        <StatsView
          catalog={catalog}
          resources={resources}
          validations={validations}
          onJumpToFilter={({ region, download, validation, alloc }) => {
            if (region !== undefined) setRegionFilter(region);
            if (download !== undefined) setDownloadFilter(download);
            if (validation !== undefined) setValidationFilter(validation);
            if (alloc !== undefined) setAllocFilter(alloc);
            setActiveTab("explorer");
          }}
        />
      ) : (
        <>
      <div className="filters">
        <input
          type="search"
          placeholder="Search facility, FAC-####, RES-####, province, subfolder…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={downloadFilter} onChange={(e) => setDownloadFilter(e.target.value)}>
          <option value="all">All facilities ({catalog.counts.total_facilities})</option>
          <option value="downloaded">Downloaded ({catalog.counts.downloaded_facilities})</option>
          <option value="needs_review">Needs match review ({catalog.counts.needs_review})</option>
          <option value="pending">Pending ({catalog.counts.pending_facilities})</option>
          <option value="auth_required">Pending: auth_required</option>
          <option value="empty_public_folder">Pending: empty folder</option>
          <option value="no_url">Pending: no_url</option>
          <option value="not_found">Pending: not_found</option>
        </select>
        <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}>
          <option value="all">All regions</option>
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select value={budgetStatusFilter} onChange={(e) => setBudgetStatusFilter(e.target.value)}>
          <option value="all">All budget statuses</option>
          <option value="unchanged">unchanged</option>
          <option value="gab_inserted">gab_inserted</option>
          <option value="nep_dropped">nep_dropped</option>
          <option value="increased">increased</option>
          <option value="decreased">decreased</option>
          <option value="senate_only">senate_only</option>
        </select>
        <select value={validationFilter} onChange={(e) => setValidationFilter(e.target.value)}>
          <option value="all">All validations</option>
          <option value="unreviewed">Unreviewed</option>
          <option value="verified">Verified</option>
          <option value="incomplete">Incomplete</option>
          <option value="needs_followup">Follow-up</option>
          <option value="mismatch">Mismatch</option>
        </select>
        <select value={allocFilter} onChange={(e) => setAllocFilter(e.target.value)}>
          {ALLOC_OPTIONS.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.label} ({allocCounts[opt.key]})
            </option>
          ))}
        </select>
        <span className="result-count">{filtered.length} shown</span>
      </div>

      <div className="workspace">
        {/* Column 1: Facilities list */}
        <aside className="list-pane">
          {filtered.length === 0 ? (
            <div className="empty-state">No facilities match current filters.</div>
          ) : (
            filtered.map((f) => {
              const vBadge = validationBadge(validations[f.facility_code]);
              return (
                <div
                  key={f.facility_code}
                  className={`fac-row ${selectedCode === f.facility_code ? "selected" : ""}`}
                  onClick={() => setSelectedCode(f.facility_code)}
                >
                  <div className="fac-row-top">
                    <span className="code-tag">
                      {f.facility_code} · {f.resource.resource_code}
                    </span>
                    <div className="badges">
                      {vBadge && <span className={`badge ${vBadge.cls}`}>{vBadge.label}</span>}
                      {f.download.needs_review && <span className="badge warn">Review</span>}
                      {f.download.downloaded ? (
                        <span className="badge ok">{f.download.file_count} files</span>
                      ) : (
                        <span className="badge neutral">{f.download.reason}</span>
                      )}
                    </div>
                  </div>
                  <div className="fac-name">{f.facility}</div>
                  <div className="fac-meta">
                    <span>
                      {f.region} / {f.province}
                    </span>
                    <span>
                      NEP {fmtPhp(f.budget.nep_total)} · GAB {fmtPhp(f.budget.gab_total)} · Sen{" "}
                      {fmtPhp(f.budget.senate_total)}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </aside>

        {/* Column 2: Facility info + budget + local files list */}
        <section className="middle-pane">
          {!selected ? (
            <div className="empty-state">Select a facility from the list.</div>
          ) : (
            <>
              <section className="card">
                <div className="detail-header">
                  <div>
                    <div className="badges">
                      <span className="code-tag">{selected.facility_code}</span>
                      <span className="code-tag">· {selected.resource.resource_code}</span>
                      <span className="badge neutral">{selected.resource.resource_kind}</span>
                      {selected.budget.statuses.map((st) => (
                        <span key={st} className={`badge ${budgetBadgeClass(st)}`}>
                          {st}
                        </span>
                      ))}
                      {selected.download.downloaded && selected.download.match_type && (
                        <span
                          className={`badge ${
                            selected.download.needs_review ? "warn" : "accent"
                          }`}
                        >
                          {selected.download.match_type} ({selected.download.match_confidence})
                        </span>
                      )}
                    </div>
                    <h1 className="detail-title">{selected.facility}</h1>
                    <div className="subtitle">
                      {selected.region} · {selected.province} · {selected.category} —{" "}
                      {selected.subcategory}
                    </div>
                  </div>

                  <div className="detail-actions">
                    {selected.resource.canonical_url && (
                      <a
                        className="btn"
                        href={selected.resource.canonical_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Drive Link ↗
                      </a>
                    )}
                    {selected.download.zip_path && (
                      <a
                        className="btn"
                        href={fileUrl(selected.download.zip_path)}
                        download
                      >
                        ZIP
                      </a>
                    )}
                  </div>
                </div>
              </section>

              <section className="card">
                <h2>Budget (PHP)</h2>
                <table className="mini">
                  <thead>
                    <tr>
                      <th>Component</th>
                      <th>NEP</th>
                      <th>GAB</th>
                      <th>Δ</th>
                      <th>Sen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.budget_line_items.map((li, i) => (
                      <tr key={i}>
                        <td>
                          <strong>Total ({li.status})</strong>
                        </td>
                        <td>{fmtPhp(li.nep.total)}</td>
                        <td>{fmtPhp(li.gab.total)}</td>
                        <td className={li.variance.total > 0 ? "pos" : li.variance.total < 0 ? "neg" : ""}>
                          {li.variance.total > 0 ? "+" : ""}
                          {fmtPhp(li.variance.total)}
                        </td>
                        <td>{fmtPhp(li.senate.total)}</td>
                      </tr>
                    ))}
                    {selected.budget_line_items.length === 1 && (
                      <>
                        <tr>
                          <td>Infra</td>
                          <td>{fmtPhp(selected.budget_line_items[0].nep.infra)}</td>
                          <td>{fmtPhp(selected.budget_line_items[0].gab.infra)}</td>
                          <td>{fmtPhp(selected.budget_line_items[0].variance.infra)}</td>
                          <td>{fmtPhp(selected.budget_line_items[0].senate.infra)}</td>
                        </tr>
                        <tr>
                          <td>Equipment</td>
                          <td>{fmtPhp(selected.budget_line_items[0].nep.equipment)}</td>
                          <td>{fmtPhp(selected.budget_line_items[0].gab.equipment)}</td>
                          <td>{fmtPhp(selected.budget_line_items[0].variance.equipment)}</td>
                          <td>{fmtPhp(selected.budget_line_items[0].senate.equipment)}</td>
                        </tr>
                        <tr>
                          <td>Motor Veh.</td>
                          <td>{fmtPhp(selected.budget_line_items[0].nep.motor_vehicle)}</td>
                          <td>{fmtPhp(selected.budget_line_items[0].gab.motor_vehicle)}</td>
                          <td>{fmtPhp(selected.budget_line_items[0].variance.motor_vehicle)}</td>
                          <td>{fmtPhp(selected.budget_line_items[0].senate.motor_vehicle)}</td>
                        </tr>
                      </>
                    )}
                  </tbody>
                </table>
              </section>

              <section className="card">
                <h2>
                  <span>Documents ({displayedFiles.length})</span>
                  {activeResource?.is_shared && selected.download.downloaded && (
                    <div className="tabs">
                      <button
                        className={`tab ${fileScope === "matched" ? "active" : ""}`}
                        onClick={() => setFileScope("matched")}
                      >
                        Matched ({selected.download.file_count})
                      </button>
                      <button
                        className={`tab ${fileScope === "all_resource" ? "active" : ""}`}
                        onClick={() => setFileScope("all_resource")}
                      >
                        All {selected.resource.resource_code} (
                        {activeResource.subfolders.reduce((s, x) => s + x.file_count, 0)})
                      </button>
                    </div>
                  )}
                </h2>

                {!selected.download.downloaded ? (
                  <div className="empty-state">
                    Not downloaded locally (reason: <strong>{selected.download.reason}</strong>).
                  </div>
                ) : displayedFiles.length === 0 ? (
                  <div className="empty-state">
                    No matched files for this facility.{" "}
                    {activeResource?.is_shared && (
                      <div style={{ marginTop: 8 }}>
                        <button className="btn" onClick={() => setFileScope("all_resource")}>
                          Browse all in {selected.resource.resource_code}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="file-list">
                    {groupedFiles.map(([sub, files]) => (
                      <div key={sub}>
                        <div className="subfolder-hdr">{sub}</div>
                        {files.map((fl) => (
                          <div
                            key={fl.local_path}
                            className={`file-item ${
                              selectedFile?.local_path === fl.local_path ? "active" : ""
                            }`}
                            onClick={() => setSelectedFile(fl)}
                            title={fl.relative_path}
                          >
                            <span className="file-name">{fl.filename}</span>
                            <span className="file-size">{fmtBytes(fl.bytes)}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </section>

        {/* Column 3: Validator + PDF / Image Viewer */}
        <main className="right-pane">
          {!selected ? (
            <div className="empty-state">Select a facility to validate and preview documents.</div>
          ) : (
            <>
              <section className="card">
                <h2>
                  <span>Validator — {selected.facility_code}</span>
                  <span className="save-hint">
                    {saving
                      ? "Saving…"
                      : validations[selected.facility_code]?.updated_at
                      ? `Updated by @${
                          validations[selected.facility_code].updated_by_username || "reviewer"
                        } · ${new Date(
                          validations[selected.facility_code].updated_at!
                        ).toLocaleString()}`
                      : "Not yet reviewed"}
                  </span>
                </h2>

                {!user && (
                  <div className="auth-gate">
                    <span>Sign in to save validation reviews and log activity.</span>
                    <button
                      className="btn primary"
                      onClick={() => {
                        setAuthMode("login");
                        setAuthError(null);
                        setAuthModalOpen(true);
                      }}
                    >
                      Sign in
                    </button>
                  </div>
                )}

                <div className="validator-row">
                  {(
                    [
                      ["verified", "Verified", "active-ok"],
                      ["incomplete", "Incomplete Docs", "active-warn"],
                      ["needs_followup", "Needs Follow-up", "active-purple"],
                      ["mismatch", "Link Mismatch", "active-bad"],
                    ] as const
                  ).map(([val, label, activeCls]) => {
                    const isActive = currentVal(selected.facility_code).status === val;
                    return (
                      <button
                        key={val}
                        className={`btn ${isActive ? activeCls : ""}`}
                        disabled={!user}
                        onClick={() => setStatus(isActive ? null : val)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="checklist">
                  {CHECKLIST_ITEMS.map((item) => (
                    <label key={item.key}>
                      <input
                        type="checkbox"
                        disabled={!user}
                        checked={!!currentVal(selected.facility_code).checklist[item.key]}
                        onChange={() => toggleCheck(item.key)}
                      />
                      {item.label}
                    </label>
                  ))}
                </div>
                <textarea
                  className="note-input"
                  disabled={!user}
                  placeholder={user ? "Reviewer notes (saved on blur)…" : "Sign in to add reviewer notes…"}
                  value={currentVal(selected.facility_code).note}
                  onChange={(e) => updateNote(e.target.value)}
                  onBlur={commitNote}
                />

                {facilityLogs.length > 0 && (
                  <details className="audit-mini">
                    <summary>History for {selected.facility_code} ({facilityLogs.length})</summary>
                    <div className="audit-list">
                      {facilityLogs.map((log) => (
                        <div key={log.id} className="audit-item">
                          <span>
                            <strong>@{log.username}</strong> — {summarizeAudit(log)}
                          </span>
                          <span className="meta">
                            {new Date(log.timestamp).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </section>

              <section className="card viewer-card">
                <div className="viewer-box">
                  {!selectedFile ? (
                    <div className="empty-state">
                      {selected.download.downloaded
                        ? "Select a document from the middle column to preview it here."
                        : `No local files to preview (${selected.download.reason}).`}
                    </div>
                  ) : (
                    <>
                      <div className="viewer-toolbar">
                        <span className="path" title={selectedFile.local_path}>
                          {selectedFile.relative_path} ({fmtBytes(selectedFile.bytes)})
                        </span>
                        <a
                          className="btn"
                          href={fileUrl(selectedFile.local_path)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open in tab ↗
                        </a>
                      </div>
                      {isPdf(selectedFile.ext) ? (
                        <iframe
                          key={selectedFile.local_path}
                          className="viewer-frame"
                          src={fileUrl(selectedFile.local_path)}
                          title={selectedFile.filename}
                        />
                      ) : isImage(selectedFile.ext) ? (
                        <div className="viewer-img-wrap">
                          <img
                            src={fileUrl(selectedFile.local_path)}
                            alt={selectedFile.filename}
                          />
                        </div>
                      ) : (
                        <div className="empty-state">
                          Preview not supported for <code>.{selectedFile.ext || "file"}</code>.
                          <div style={{ marginTop: 10 }}>
                            <a
                              className="btn primary"
                              href={fileUrl(selectedFile.local_path)}
                              download
                            >
                              Download file
                            </a>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
        </>
      )}

      {/* Login / Register Modal */}
      {authModalOpen && (
        <div className="modal-backdrop" onClick={() => setAuthModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              <span>{authMode === "login" ? "Reviewer Sign In" : "Create Reviewer Account"}</span>
              <button className="btn" onClick={() => setAuthModalOpen(false)}>
                ✕
              </button>
            </h3>
            {authError && <div className="form-error">{authError}</div>}
            <form onSubmit={handleAuthSubmit}>
              <div className="form-field">
                <label>Username</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                  placeholder="e.g. admin"
                />
              </div>
              {authMode === "register" && (
                <div className="form-field">
                  <label>Display Name</label>
                  <input
                    type="text"
                    value={authDisplayName}
                    onChange={(e) => setAuthDisplayName(e.target.value)}
                    placeholder="e.g. Juan Dela Cruz"
                  />
                </div>
              )}
              <div className="form-field">
                <label>Password</label>
                <input
                  type="password"
                  required
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setAuthMode(authMode === "login" ? "register" : "login");
                    setAuthError(null);
                  }}
                >
                  {authMode === "login" ? "Need an account? Register" : "Back to Sign In"}
                </button>
                <button type="submit" className="btn primary" disabled={authBusy}>
                  {authBusy ? "Please wait…" : authMode === "login" ? "Sign in" : "Create account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Global Audit Log Modal */}
      {auditModalOpen && (
        <div className="modal-backdrop" onClick={() => setAuditModalOpen(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>
              <span>Recent Audit Log ({globalLogs.length})</span>
              <button className="btn" onClick={() => setAuditModalOpen(false)}>
                ✕
              </button>
            </h3>
            <div className="audit-table-wrap">
              {globalLogs.length === 0 ? (
                <div className="empty-state">No audit events recorded yet.</div>
              ) : (
                <table className="mini">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>User</th>
                      <th>Action</th>
                      <th>Facility</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {globalLogs.map((log) => (
                      <tr key={log.id}>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {new Date(log.timestamp).toLocaleString()}
                        </td>
                        <td style={{ textAlign: "left" }}>@{log.username}</td>
                        <td style={{ textAlign: "left" }}>{log.action}</td>
                        <td style={{ textAlign: "left" }}>
                          {log.facility_code ? (
                            <button
                              className="btn"
                              onClick={() => {
                                setSelectedCode(log.facility_code);
                                setAuditModalOpen(false);
                              }}
                            >
                              {log.facility_code}
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={{ textAlign: "left" }}>{summarizeAudit(log)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
