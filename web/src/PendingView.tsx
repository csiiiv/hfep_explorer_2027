import { useEffect, useMemo, useState } from "react";
import { ALLOC_OPTIONS, countAllocOptions, matchesAllocFilter } from "./allocFilter";
import type { FacilitiesCatalog, FacilityRecord } from "./types";

interface PendingViewProps {
  catalog: FacilitiesCatalog;
  onSelectFacility: (facilityCode: string) => void;
}

function fmtPhp(v: number): string {
  if (!v) return "₱0";
  const sign = v < 0 ? "−" : "";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${sign}₱${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}₱${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}₱${(abs / 1e3).toFixed(0)}K`;
  return `${sign}₱${abs.toLocaleString()}`;
}

function reasonKey(f: FacilityRecord): string {
  const r = f.download.reason || "other";
  if (r === "auth_required") {
    return f.resource.resource_kind === "spreadsheet"
      ? "auth_required_sheet"
      : "auth_required_folder";
  }
  return r;
}

function allocationSourceKey(f: FacilityRecord): string {
  const nep = (f.budget.nep_total || 0) > 0;
  const gab = (f.budget.gab_total || 0) > 0;
  const sen = (f.budget.senate_total || 0) > 0;
  if (nep && gab && sen) return "nep_hgab_senate";
  if (nep && gab && !sen) return "nep_hgab";
  if (nep && !gab && sen) return "nep_senate";
  if (!nep && gab && sen) return "hgab_senate";
  if (nep && !gab && !sen) return "nep_only";
  if (!nep && gab && !sen) return "hgab_only";
  if (!nep && !gab && sen) return "senate_only";
  return "none";
}

function allocationSourceLabel(key: string): string {
  switch (key) {
    case "nep_only":
      return "NEP Only";
    case "hgab_only":
      return "HGAB Only";
    case "senate_only":
      return "Senate Only";
    case "nep_hgab":
      return "NEP + HGAB";
    case "nep_senate":
      return "NEP + Senate";
    case "hgab_senate":
      return "HGAB + Senate";
    case "nep_hgab_senate":
      return "NEP + HGAB + Senate";
    default:
      return "None";
  }
}

function reasonLabel(key: string): { label: string; cls: string } {
  switch (key) {
    case "auth_required_sheet":
      return { label: "Auth Required (Sheet)", cls: "warn" };
    case "auth_required_folder":
      return { label: "Auth Required (Folder)", cls: "warn" };
    case "empty_public_folder":
      return { label: "Empty Public Folder", cls: "purple" };
    case "no_url":
      return { label: "No URL", cls: "bad" };
    case "not_found":
      return { label: "Not Found (404)", cls: "bad" };
    default:
      return { label: key, cls: "neutral" };
  }
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function PendingView({ catalog, onSelectFacility }: PendingViewProps) {
  const initialSp = useMemo(() => new URLSearchParams(window.location.search), []);
  const [groupBy, setGroupBy] = useState<"facility" | "source">(
    initialSp.get("view") === "source" ? "source" : "facility"
  );
  const [search, setSearch] = useState(initialSp.get("q") || "");
  const [reasonFilter, setReasonFilter] = useState(initialSp.get("reason") || "all");
  const [regionFilter, setRegionFilter] = useState(initialSp.get("region") || "all");
  const [allocFilter, setAllocFilter] = useState(initialSp.get("alloc") || "all");

  useEffect(() => {
    const sp = new URLSearchParams();
    if (groupBy === "source") sp.set("view", "source");
    if (search) sp.set("q", search);
    if (reasonFilter !== "all") sp.set("reason", reasonFilter);
    if (regionFilter !== "all") sp.set("region", regionFilter);
    if (allocFilter !== "all") sp.set("alloc", allocFilter);
    const qs = sp.toString();
    const target = qs ? `/pending?${qs}` : "/pending";
    if (window.location.pathname + window.location.search !== target) {
      window.history.replaceState({ tab: "pending" }, "", target);
    }
  }, [groupBy, search, reasonFilter, regionFilter, allocFilter]);

  const pendingFacilities = useMemo(
    () => catalog.facilities.filter((f) => !f.download.downloaded),
    [catalog]
  );

  const regions = useMemo(
    () => Array.from(new Set(pendingFacilities.map((f) => f.region).filter(Boolean))).sort(),
    [pendingFacilities]
  );

  const allocCounts = useMemo(
    () => countAllocOptions(pendingFacilities),
    [pendingFacilities]
  );

  const filteredFacilities = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pendingFacilities.filter((f) => {
      if (reasonFilter !== "all" && reasonKey(f) !== reasonFilter) return false;
      if (regionFilter !== "all" && f.region !== regionFilter) return false;
      if (!matchesAllocFilter(f, allocFilter)) return false;
      if (q) {
        const hay = [
          f.facility_code,
          f.facility,
          f.region,
          f.province,
          f.resource.resource_code,
          f.resource.canonical_url || "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [pendingFacilities, search, reasonFilter, regionFilter, allocFilter]);

  const groupedSources = useMemo(() => {
    const map = new Map<
      string,
      {
        resource_code: string;
        resource_kind: string;
        reason_key: string;
        canonical_url: string | null;
        facilities: FacilityRecord[];
        regions: Set<string>;
        nep: number;
        gab: number;
        senate: number;
      }
    >();
    for (const f of filteredFacilities) {
      const code = f.resource.resource_code || f.facility_code;
      const cur = map.get(code) || {
        resource_code: f.resource.resource_code,
        resource_kind: f.resource.resource_kind,
        reason_key: reasonKey(f),
        canonical_url: f.resource.canonical_url,
        facilities: [],
        regions: new Set<string>(),
        nep: 0,
        gab: 0,
        senate: 0,
      };
      cur.facilities.push(f);
      if (f.region) cur.regions.add(f.region);
      cur.nep += f.budget.nep_total || 0;
      cur.gab += f.budget.gab_total || 0;
      cur.senate += f.budget.senate_total || 0;
      map.set(code, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.facilities.length - a.facilities.length);
  }, [filteredFacilities]);

  function downloadCsv() {
    let lines: string[];
    let filename: string;
    if (groupBy === "facility") {
      filename = "hfep_pending_facilities.csv";
      lines = [
        [
          "facility_code",
          "facility",
          "region",
          "province",
          "pending_reason",
          "allocation_source",
          "resource_code",
          "resource_kind",
          "nep_total",
          "gab_total",
          "senate_total",
          "pending_source_url",
        ].join(","),
        ...filteredFacilities.map((f) =>
          [
            f.facility_code,
            f.facility,
            f.region,
            f.province,
            reasonKey(f),
            allocationSourceLabel(allocationSourceKey(f)),
            f.resource.resource_code,
            f.resource.resource_kind,
            f.budget.nep_total,
            f.budget.gab_total,
            f.budget.senate_total,
            f.resource.canonical_url || "",
          ]
            .map(csvEscape)
            .join(",")
        ),
      ];
    } else {
      filename = "hfep_pending_sources.csv";
      lines = [
        [
          "resource_code",
          "resource_kind",
          "pending_reason",
          "facility_count",
          "regions",
          "nep_total",
          "gab_total",
          "senate_total",
          "pending_source_url",
        ].join(","),
        ...groupedSources.map((s) =>
          [
            s.resource_code,
            s.resource_kind,
            s.reason_key,
            s.facilities.length,
            Array.from(s.regions).join("; "),
            s.nep,
            s.gab,
            s.senate,
            s.canonical_url || "",
          ]
            .map(csvEscape)
            .join(",")
        ),
      ];
    }
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="stats-page">
      <div className="filters" style={{ borderRadius: 8, border: "1px solid var(--border)" }}>
        <div className="tabs">
          <button
            className={`tab ${groupBy === "facility" ? "active" : ""}`}
            onClick={() => setGroupBy("facility")}
          >
            By Facility ({filteredFacilities.length})
          </button>
          <button
            className={`tab ${groupBy === "source" ? "active" : ""}`}
            onClick={() => setGroupBy("source")}
          >
            By Pending Source ({groupedSources.length})
          </button>
        </div>

        <input
          type="search"
          placeholder="Search facility, FAC-####, RES-####, region, URL…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <select value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)}>
          <option value="all">All pending reasons ({pendingFacilities.length})</option>
          <option value="auth_required_sheet">Auth Required (Google Sheets)</option>
          <option value="auth_required_folder">Auth Required (Drive Folder)</option>
          <option value="empty_public_folder">Empty Public Folder</option>
          <option value="no_url">No URL Provided</option>
          <option value="not_found">Not Found (404)</option>
        </select>

        <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}>
          <option value="all">All regions</option>
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <select value={allocFilter} onChange={(e) => setAllocFilter(e.target.value)}>
          {ALLOC_OPTIONS.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.label} ({allocCounts[opt.key]})
            </option>
          ))}
        </select>

        <button className="btn primary" onClick={downloadCsv}>
          Download CSV
        </button>
      </div>

      <section className="card" style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <h2>
          <span>
            {groupBy === "facility"
              ? `Pending Facilities (${filteredFacilities.length})`
              : `Pending Sources / Drive Links (${groupedSources.length})`}
          </span>
        </h2>

        <div style={{ overflowY: "auto", flex: 1 }}>
          {groupBy === "facility" ? (
            <table className="mini">
              <thead>
                <tr>
                  <th>Facility</th>
                  <th style={{ textAlign: "left" }}>Region / Province</th>
                  <th style={{ textAlign: "left" }}>Pending Reason</th>
                  <th style={{ textAlign: "left" }}>Pending Source</th>
                  <th>NEP</th>
                  <th>GAB</th>
                  <th>Senate</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredFacilities.map((f) => {
                  const rl = reasonLabel(reasonKey(f));
                  return (
                    <tr key={f.facility_code}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{f.facility}</div>
                        <div className="code-tag">{f.facility_code}</div>
                      </td>
                      <td style={{ textAlign: "left" }}>
                        {f.region} / {f.province}
                      </td>
                      <td style={{ textAlign: "left" }}>
                        <span className={`badge ${rl.cls}`}>{rl.label}</span>
                      </td>
                      <td style={{ textAlign: "left", maxWidth: 320 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span className="code-tag">{f.resource.resource_code}</span>
                          <span className="badge neutral">{f.resource.resource_kind}</span>
                          {f.resource.canonical_url ? (
                            <a
                              href={f.resource.canonical_url}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: 11.5, wordBreak: "break-all" }}
                            >
                              Open Source ↗
                            </a>
                          ) : (
                            <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>No URL</span>
                          )}
                        </div>
                      </td>
                      <td>{fmtPhp(f.budget.nep_total)}</td>
                      <td>{fmtPhp(f.budget.gab_total)}</td>
                      <td>{fmtPhp(f.budget.senate_total)}</td>
                      <td>
                        <button className="btn" onClick={() => onSelectFacility(f.facility_code)}>
                          Inspect
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="mini">
              <thead>
                <tr>
                  <th>Source</th>
                  <th style={{ textAlign: "left" }}>Pending Reason</th>
                  <th>Facilities</th>
                  <th style={{ textAlign: "left" }}>Regions</th>
                  <th>NEP</th>
                  <th>GAB</th>
                  <th>Senate</th>
                  <th style={{ textAlign: "left" }}>Pending Source URL</th>
                </tr>
              </thead>
              <tbody>
                {groupedSources.map((s) => {
                  const rl = reasonLabel(s.reason_key);
                  return (
                    <tr key={s.resource_code}>
                      <td>
                        <span className="code-tag">{s.resource_code}</span>{" "}
                        <span className="badge neutral">{s.resource_kind}</span>
                      </td>
                      <td style={{ textAlign: "left" }}>
                        <span className={`badge ${rl.cls}`}>{rl.label}</span>
                      </td>
                      <td>
                        <strong>{s.facilities.length}</strong>
                      </td>
                      <td style={{ textAlign: "left" }}>{Array.from(s.regions).join(", ")}</td>
                      <td>{fmtPhp(s.nep)}</td>
                      <td>{fmtPhp(s.gab)}</td>
                      <td>{fmtPhp(s.senate)}</td>
                      <td style={{ textAlign: "left", maxWidth: 420, wordBreak: "break-all" }}>
                        {s.canonical_url ? (
                          <a href={s.canonical_url} target="_blank" rel="noreferrer">
                            {s.canonical_url} ↗
                          </a>
                        ) : (
                          <span style={{ color: "var(--text-muted)" }}>No URL in workbook</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
