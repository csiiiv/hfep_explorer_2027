import { useMemo } from "react";
import { ALLOC_OPTIONS, matchesAllocFilter } from "./allocFilter";
import type { FacilitiesCatalog, ResourcesCatalog, ValidationRecord } from "./types";

interface StatsViewProps {
  catalog: FacilitiesCatalog;
  resources: ResourcesCatalog | null;
  validations: Record<string, ValidationRecord>;
  onJumpToFilter: (opts: {
    region?: string;
    download?: string;
    validation?: string;
    alloc?: string;
  }) => void;
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

function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

function pct(part: number, total: number): string {
  if (!total) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

export default function StatsView({
  catalog,
  resources,
  validations,
  onJumpToFilter,
}: StatsViewProps) {
  const stats = useMemo(() => {
    const facs = catalog.facilities;
    const totalFacs = facs.length;
    const downloadedFacs = facs.filter((f) => f.download.downloaded);
    const pendingFacs = facs.filter((f) => !f.download.downloaded);

    // Budget totals
    const totalNep = facs.reduce((s, f) => s + (f.budget.nep_total || 0), 0);
    const totalGab = facs.reduce((s, f) => s + (f.budget.gab_total || 0), 0);
    const dlNep = downloadedFacs.reduce((s, f) => s + (f.budget.nep_total || 0), 0);
    const dlGab = downloadedFacs.reduce((s, f) => s + (f.budget.gab_total || 0), 0);

    // Coverage by status/reason
    const coverageMap = new Map<
      string,
      { label: string; count: number; nep: number; gab: number; filterKey: string; cls: string }
    >();
    const addCov = (key: string, label: string, filterKey: string, cls: string, nep: number, gab: number) => {
      const cur = coverageMap.get(key) || { label, count: 0, nep: 0, gab: 0, filterKey, cls };
      cur.count += 1;
      cur.nep += nep;
      cur.gab += gab;
      coverageMap.set(key, cur);
    };
    for (const f of facs) {
      if (f.download.downloaded) {
        addCov("downloaded", "Downloaded (local files)", "downloaded", "ok", f.budget.nep_total, f.budget.gab_total);
      } else {
        const r = f.download.reason || "other";
        const kind = f.resource.resource_kind || "unknown";
        const key = r === "auth_required" ? `auth_required:${kind}` : r;
        const label =
          key === "auth_required:spreadsheet"
            ? "Pending: Auth Required (Google Sheets)"
            : key === "auth_required:folder"
            ? "Pending: Auth Required (Drive Folder)"
            : key === "empty_public_folder"
            ? "Pending: Empty Public Folder"
            : key === "no_url"
            ? "Pending: No URL Provided"
            : key === "not_found"
            ? "Pending: Link Not Found (404)"
            : `Pending: ${r}`;
        addCov(key, label, r, r === "auth_required" ? "warn" : "bad", f.budget.nep_total, f.budget.gab_total);
      }
    }
    const coverageRows = Array.from(coverageMap.values()).sort((a, b) => b.count - a.count);

    // Match types among downloaded
    const matchMap = new Map<string, number>();
    for (const f of downloadedFacs) {
      const mt = f.download.match_type || "unknown";
      matchMap.set(mt, (matchMap.get(mt) || 0) + 1);
    }
    const matchRows = Array.from(matchMap.entries()).sort((a, b) => b[1] - a[1]);

    // Resource kinds
    const resList = resources?.resources || [];
    const resKindMap = new Map<string, { total: number; downloaded: number }>();
    for (const r of resList) {
      const k = r.resource_kind || "unknown";
      const cur = resKindMap.get(k) || { total: 0, downloaded: 0 };
      cur.total += 1;
      if ((r.subfolders?.length || 0) > 0) cur.downloaded += 1;
      resKindMap.set(k, cur);
    }
    const resKindRows = Array.from(resKindMap.entries()).sort((a, b) => b[1].total - a[1].total);

    // Document types (extensions) from resources catalog (unique files, no double counting shared)
    const extMap = new Map<string, { count: number; bytes: number }>();
    let totalFiles = 0;
    let totalBytes = 0;
    for (const r of resList) {
      for (const sf of r.subfolders || []) {
        for (const fl of sf.files || []) {
          totalFiles += 1;
          totalBytes += fl.bytes || 0;
          const ext = (fl.ext || "(no ext)").toLowerCase();
          const cur = extMap.get(ext) || { count: 0, bytes: 0 };
          cur.count += 1;
          cur.bytes += fl.bytes || 0;
          extMap.set(ext, cur);
        }
      }
    }
    const extRows = Array.from(extMap.entries()).sort((a, b) => b[1].count - a[1].count);

    // Validation stats
    const valCounts: Record<string, number> = {
      verified: 0,
      incomplete: 0,
      needs_followup: 0,
      mismatch: 0,
      unreviewed: 0,
    };
    const checklistCounts: Record<string, number> = {
      site_readiness: 0,
      land_ownership: 0,
      hazard_assessment: 0,
      sdp_daed: 0,
      manpower: 0,
    };
    for (const f of facs) {
      const v = validations[f.facility_code];
      if (v?.status && v.status in valCounts) valCounts[v.status] += 1;
      else valCounts.unreviewed += 1;
      if (v?.checklist) {
        for (const k of Object.keys(checklistCounts)) {
          if (v.checklist[k as keyof typeof v.checklist]) checklistCounts[k] += 1;
        }
      }
    }
    const reviewedTotal = totalFacs - valCounts.unreviewed;

    // By Region
    const regionMap = new Map<
      string,
      {
        region: string;
        total: number;
        downloaded: number;
        needsReview: number;
        validated: number;
        nep: number;
        gab: number;
      }
    >();
    for (const f of facs) {
      const reg = f.region || "(Unspecified)";
      const cur = regionMap.get(reg) || {
        region: reg,
        total: 0,
        downloaded: 0,
        needsReview: 0,
        validated: 0,
        nep: 0,
        gab: 0,
      };
      cur.total += 1;
      if (f.download.downloaded) cur.downloaded += 1;
      if (f.download.needs_review) cur.needsReview += 1;
      if (validations[f.facility_code]?.status) cur.validated += 1;
      cur.nep += f.budget.nep_total || 0;
      cur.gab += f.budget.gab_total || 0;
      regionMap.set(reg, cur);
    }
    const regionRows = Array.from(regionMap.values()).sort((a, b) => b.total - a.total);

    // By Category
    const catMap = new Map<
      string,
      { category: string; total: number; downloaded: number; nep: number; gab: number }
    >();
    for (const f of facs) {
      const cat = f.category || "(Unspecified)";
      const cur = catMap.get(cat) || { category: cat, total: 0, downloaded: 0, nep: 0, gab: 0 };
      cur.total += 1;
      if (f.download.downloaded) cur.downloaded += 1;
      cur.nep += f.budget.nep_total || 0;
      cur.gab += f.budget.gab_total || 0;
      catMap.set(cat, cur);
    }
    const catRows = Array.from(catMap.values()).sort((a, b) => b.total - a.total);

    // By Funding Source (exact combinations + All X funded)
    const allocRows = ALLOC_OPTIONS.filter((o) => o.key !== "all").map((opt) => {
      const matched = facs.filter((f) => matchesAllocFilter(f, opt.key));
      const dl = matched.filter((f) => f.download.downloaded).length;
      const nep = matched.reduce((s, f) => s + (f.budget.nep_total || 0), 0);
      const gab = matched.reduce((s, f) => s + (f.budget.gab_total || 0), 0);
      const sen = matched.reduce((s, f) => s + (f.budget.senate_total || 0), 0);
      return {
        key: opt.key,
        label: opt.label,
        total: matched.length,
        downloaded: dl,
        pending: matched.length - dl,
        nep,
        gab,
        sen,
        isSummary: opt.key.startsWith("all_"),
      };
    });

    return {
      totalFacs,
      downloadedCount: downloadedFacs.length,
      pendingCount: pendingFacs.length,
      totalResources: resList.length,
      downloadedResources: resList.filter((r) => (r.subfolders?.length || 0) > 0).length,
      totalFiles,
      totalBytes,
      totalNep,
      totalGab,
      dlNep,
      dlGab,
      coverageRows,
      matchRows,
      resKindRows,
      extRows,
      valCounts,
      checklistCounts,
      reviewedTotal,
      regionRows,
      catRows,
      allocRows,
    };
  }, [catalog, resources, validations]);

  return (
    <div className="stats-page">
      {/* Top KPI strip */}
      <div className="stats-kpis">
        <div className="stat-card">
          <div className="stat-label">Facility Coverage</div>
          <div className="stat-value ok">
            {stats.downloadedCount} / {stats.totalFacs}
          </div>
          <div className="stat-sub">
            {pct(stats.downloadedCount, stats.totalFacs)} downloaded · {stats.pendingCount} pending
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Unique Resources</div>
          <div className="stat-value">
            {stats.downloadedResources} / {stats.totalResources}
          </div>
          <div className="stat-sub">
            {pct(stats.downloadedResources, stats.totalResources)} Drive links downloaded
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Local Documents</div>
          <div className="stat-value accent">{stats.totalFiles.toLocaleString()}</div>
          <div className="stat-sub">{fmtBytes(stats.totalBytes)} across all downloaded folders</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Budget Covered (GAB)</div>
          <div className="stat-value">{fmtPhp(stats.dlGab)}</div>
          <div className="stat-sub">
            {pct(stats.dlGab, stats.totalGab)} of {fmtPhp(stats.totalGab)} total GAB (NEP:{" "}
            {fmtPhp(stats.totalNep)})
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Validation Progress</div>
          <div className="stat-value purple">
            {stats.reviewedTotal} / {stats.totalFacs}
          </div>
          <div className="stat-sub">
            {stats.valCounts.verified} verified · {stats.valCounts.incomplete} incomplete ·{" "}
            {stats.valCounts.needs_followup} follow-up · {stats.valCounts.mismatch} mismatch
          </div>
        </div>
      </div>

      {/* Row 1: Coverage breakdown + Document types */}
      <div className="stats-grid-2">
        <section className="card">
          <h2>Coverage by Download Status / Pending Reason</h2>
          <div className="bar-list">
            {stats.coverageRows.map((row) => (
              <div
                key={row.label}
                className="bar-row clickable"
                onClick={() => onJumpToFilter({ download: row.filterKey })}
                title="Click to filter Explorer"
              >
                <div className="bar-head">
                  <span>{row.label}</span>
                  <span className="bar-num">
                    <strong>{row.count}</strong> ({pct(row.count, stats.totalFacs)}) · GAB{" "}
                    {fmtPhp(row.gab)}
                  </span>
                </div>
                <div className="bar-track">
                  <div
                    className={`bar-fill ${row.cls}`}
                    style={{ width: `${(row.count / Math.max(1, stats.totalFacs)) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Document Types (by File Extension)</h2>
          <table className="mini">
            <thead>
              <tr>
                <th>Extension</th>
                <th>Files</th>
                <th>Share</th>
                <th>Total Size</th>
              </tr>
            </thead>
            <tbody>
              {stats.extRows.map(([ext, info]) => (
                <tr key={ext}>
                  <td>
                    <code>.{ext}</code>
                  </td>
                  <td>{info.count.toLocaleString()}</td>
                  <td>{pct(info.count, stats.totalFiles)}</td>
                  <td>{fmtBytes(info.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {/* Row 1.5: Coverage by Allocation Source */}
      <section className="card">
        <h2>Coverage by Budget Allocation Source</h2>
        <table className="mini">
          <thead>
            <tr>
              <th>Allocation Source</th>
              <th>Total</th>
              <th>Downloaded</th>
              <th>Pending</th>
              <th>Coverage</th>
              <th>NEP</th>
              <th>HGAB</th>
              <th>Senate</th>
            </tr>
          </thead>
          <tbody>
            {stats.allocRows.map((row) => (
              <tr
                key={row.key}
                className="clickable-row"
                style={row.isSummary ? { background: "var(--surface-muted)", fontWeight: 600 } : undefined}
                onClick={() => onJumpToFilter({ alloc: row.key, download: "all" })}
                title="Click to filter Explorer by allocation source"
              >
                <td>{row.label}</td>
                <td>{row.total}</td>
                <td>{row.downloaded}</td>
                <td>{row.pending}</td>
                <td>{pct(row.downloaded, row.total)}</td>
                <td>{fmtPhp(row.nep)}</td>
                <td>{fmtPhp(row.gab)}</td>
                <td>{fmtPhp(row.sen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Row 2: Match Quality + Resource Kinds + Validation Checklist */}
      <div className="stats-grid-3">
        <section className="card">
          <h2>Downloaded Match Methods ({stats.downloadedCount})</h2>
          <div className="bar-list">
            {stats.matchRows.map(([mt, cnt]) => (
              <div key={mt} className="bar-row">
                <div className="bar-head">
                  <code>{mt}</code>
                  <span className="bar-num">
                    <strong>{cnt}</strong> ({pct(cnt, stats.downloadedCount)})
                  </span>
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill accent"
                    style={{ width: `${(cnt / Math.max(1, stats.downloadedCount)) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Resources by Kind ({stats.totalResources})</h2>
          <table className="mini">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Total</th>
                <th>Downloaded</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {stats.resKindRows.map(([kind, info]) => (
                <tr key={kind}>
                  <td>
                    <code>{kind}</code>
                  </td>
                  <td>{info.total}</td>
                  <td>{info.downloaded}</td>
                  <td>{pct(info.downloaded, info.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Validation Status &amp; Checklist</h2>
          <div className="bar-list">
            {(
              [
                ["verified", "Verified", "ok"],
                ["incomplete", "Incomplete Docs", "warn"],
                ["needs_followup", "Needs Follow-up", "purple"],
                ["mismatch", "Link Mismatch", "bad"],
                ["unreviewed", "Unreviewed", "neutral"],
              ] as const
            ).map(([k, label, cls]) => (
              <div
                key={k}
                className="bar-row clickable"
                onClick={() => onJumpToFilter({ validation: k, download: "all" })}
                title="Click to filter Explorer"
              >
                <div className="bar-head">
                  <span>{label}</span>
                  <span className="bar-num">
                    <strong>{stats.valCounts[k]}</strong> ({pct(stats.valCounts[k], stats.totalFacs)})
                  </span>
                </div>
                <div className="bar-track">
                  <div
                    className={`bar-fill ${cls}`}
                    style={{
                      width: `${(stats.valCounts[k] / Math.max(1, stats.totalFacs)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Row 3: Coverage by Region + Category */}
      <div className="stats-grid-2">
        <section className="card">
          <h2>Coverage by Region</h2>
          <div className="stats-table-scroll">
            <table className="mini">
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Total</th>
                  <th>Downloaded</th>
                  <th>Coverage</th>
                  <th>Validated</th>
                  <th>GAB</th>
                </tr>
              </thead>
              <tbody>
                {stats.regionRows.map((r) => (
                  <tr
                    key={r.region}
                    className="clickable-row"
                    onClick={() => onJumpToFilter({ region: r.region, download: "all" })}
                    title="Click to filter Explorer by region"
                  >
                    <td>
                      <strong>{r.region}</strong>
                    </td>
                    <td>{r.total}</td>
                    <td>{r.downloaded}</td>
                    <td>{pct(r.downloaded, r.total)}</td>
                    <td>{r.validated}</td>
                    <td>{fmtPhp(r.gab)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h2>Coverage by Facility Category</h2>
          <div className="stats-table-scroll">
            <table className="mini">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Total</th>
                  <th>Downloaded</th>
                  <th>Coverage</th>
                  <th>NEP</th>
                  <th>GAB</th>
                </tr>
              </thead>
              <tbody>
                {stats.catRows.map((c) => (
                  <tr key={c.category}>
                    <td>{c.category}</td>
                    <td>{c.total}</td>
                    <td>{c.downloaded}</td>
                    <td>{pct(c.downloaded, c.total)}</td>
                    <td>{fmtPhp(c.nep)}</td>
                    <td>{fmtPhp(c.gab)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
