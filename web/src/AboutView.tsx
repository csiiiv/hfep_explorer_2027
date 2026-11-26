import type { FacilitiesCatalog, ResourcesCatalog } from "./types";

interface AboutViewProps {
  catalog: FacilitiesCatalog;
  resources: ResourcesCatalog | null;
}

export default function AboutView({ catalog, resources }: AboutViewProps) {
  const totalResources = resources?.resources.length ?? 318;
  const downloadedResources =
    resources?.resources.filter((r) => (r.subfolders?.length || 0) > 0).length ?? 180;

  return (
    <div className="stats-page" style={{ maxWidth: 960, margin: "0 auto", width: "100%" }}>
      <section className="card">
        <h1 className="detail-title" style={{ marginBottom: 6 }}>
          About HFEP 2027 — Facilities Explorer &amp; Validator
        </h1>
        <p style={{ margin: "6px 0 0", lineHeight: 1.55, color: "var(--text)" }}>
          A local-first explorer, document viewer, and validation workbench for the Philippine
          Department of Health&apos;s{" "}
          <strong>Health Facilities Enhancement Program (HFEP) 2027</strong> budget — comparing
          the executive <strong>NEP</strong>, House <strong>GAB (HREP-GAB)</strong>, and{" "}
          <strong>Senate</strong> allocations alongside their supporting Google Drive documentary
          requirements.
        </p>
      </section>

      <div className="stats-grid-2">
        <section className="card">
          <h2>Data Sources</h2>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.65 }}>
            <li>
              <strong>Source Workbook:</strong> <code>data/HFEP 2027 NEP VS GAB.xlsx</code>{" "}
              (extracted <code>NEP</code>, <code>HREP-GAB</code>, <code>SENATE</code>, and{" "}
              <code>COMP-FINAL</code> sheets into clean CSVs and JSON catalogs).
            </li>
            <li>
              <strong>Senate Annex A-2 PDF:</strong> cross-checked against{" "}
              <code>Annex A-2 DOH Health Facilities Enhancement Program (HFEP).pdf</code> (174
              facilities, ₱5.49B grand total).
            </li>
            <li>
              <strong>Documentary Requirements:</strong> deduplicated 758 rows into{" "}
              <strong>{totalResources}</strong> unique Google Drive / Docs resources (
              <code>RES-####</code>); downloaded <strong>{downloadedResources}</strong> accessible
              resources locally via authenticated <code>rclone</code>.
            </li>
          </ul>
        </section>

        <section className="card">
          <h2>Coverage Snapshot</h2>
          <table className="mini">
            <tbody>
              <tr>
                <td>Total Facilities</td>
                <td>
                  <strong>{catalog.counts.total_facilities}</strong>
                </td>
              </tr>
              <tr>
                <td>Downloaded (local files)</td>
                <td>
                  <strong>{catalog.counts.downloaded_facilities}</strong>
                </td>
              </tr>
              <tr>
                <td>Pending (auth / empty / missing)</td>
                <td>
                  <strong>{catalog.counts.pending_facilities}</strong>
                </td>
              </tr>
              <tr>
                <td>Flagged for Match Review</td>
                <td>
                  <strong>{catalog.counts.needs_review}</strong>
                </td>
              </tr>
              <tr>
                <td>Catalog Generated</td>
                <td>{new Date(catalog.generated_at).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <section className="card">
        <h2>Known Workbook Caveats</h2>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.65 }}>
          <li>
            <strong>Senate Sign Discrepancy (₱200M swing):</strong>{" "}
            <em>Dr. Jose N. Rodriguez Memorial Hospital and Sanitarium</em> is listed as a{" "}
            <code>(100,000,000)</code> deduction (<code>−₱100M</code>) in the Senate Annex A-2 PDF
            and the <code>SENATE</code> sheet (<code>₱5.49B</code> total), but entered as{" "}
            <code>+₱100,000,000</code> in <code>COMP-FINAL</code> (<code>₱5.69B</code> total).
          </li>
          <li>
            <strong>Shared Drive Resources:</strong> Many facilities point to a shared regional or
            provincial Drive folder or Google Sheet. Use the <strong>Matched / All RES-####</strong>{" "}
            toggle in Explorer to inspect both auto-matched subfolders and the full resource bundle.
          </li>
          <li>
            <strong>Pending Sources:</strong> Most pending facilities (463 of 494) reference
            access-restricted Google Sheets (<code>auth_required</code>) that require owner sharing.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>How Validation &amp; Audit Logging Work</h2>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.65 }}>
          <li>
            <strong>Read-only browsing</strong> is open to everyone;{" "}
            <strong>saving validation reviews</strong> requires signing in with a reviewer account.
          </li>
          <li>
            Reviews, reviewer accounts, sessions, and an append-only <strong>Audit Log</strong>{" "}
            (capturing before/after state, username, and timestamp) are stored in a local SQLite
            database (<code>data/hfep_validator.sqlite</code>).
          </li>
          <li>
            All validations can be exported at any time via <strong>Export CSV</strong> in the
            header, and pending facilities/sources can be exported from the <strong>Pending</strong>{" "}
            tab.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>Repository &amp; Documentation</h2>
        <p style={{ margin: 0, lineHeight: 1.6 }}>
          Source code, extraction scripts, and pipeline documentation:{" "}
          <a
            href="https://github.com/csiiiv/hfep_explorer_2027"
            target="_blank"
            rel="noreferrer"
          >
            github.com/csiiiv/hfep_explorer_2027 ↗
          </a>
        </p>
      </section>
    </div>
  );
}
