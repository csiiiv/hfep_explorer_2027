# HFEP 2027 — Facilities Explorer & Validator

Working set, data pipeline, SQLite validation backend, and React web explorer for the DOH **Health Facilities Enhancement Program (HFEP) 2027** comparison between the **NEP** (executive proposal), **House GAB** (`HREP-GAB`), and **Senate** allocations, plus inventory and local download of documentary-requirement Google Drive links.

## Quick Start (Web App + SQLite Backend)

Requires **Node.js 26+** (uses built-in `node:sqlite`, no native compilation needed).

```bash
# 1. Install frontend dependencies (first time only)
cd web && npm install && cd ..

# 2. Terminal 1 — start SQLite API server (http://127.0.0.1:8787)
node server/index.mjs

# 3. Terminal 2 — start Vite frontend (http://127.0.0.1:5177)
cd web && npm run dev
```

- **App URL**: `http://127.0.0.1:5177` (routes: `/`, `/pending`, `/statistics`, `/about`)
- **Default Reviewer Login**: `admin` / `admin123` (override via `HFEP_ADMIN_PASSWORD`; reviewers can also self-register from the Sign In modal)
- **SQLite Database**: `data/hfep_validator.sqlite` (auto-created on first boot, gitignored)

## Quick Map

| Area | Start here |
|---|---|
| Architecture, API & SQLite schema | [`docs/architecture.md`](docs/architecture.md) |
| Data + link pipeline detail | [`docs/data_and_links.md`](docs/data_and_links.md) |
| Authenticated Drive downloads | [`docs/rclone_download.md`](docs/rclone_download.md) |
| Unified JSON catalogs | `data/json/facilities_catalog.json`, `data/json/resources_catalog.json` |
| Budget comparison CSV | `data/csv/comp_final.csv` |
| Pending facilities & sources CSVs | `data/csv/pending_facilities.csv`, `data/csv/pending_sources.csv` |
| Links needing owner action | `data/csv/links_needing_action_by_resource.csv` |

## Source Workbook

`data/HFEP 2027 NEP VS GAB.xlsx`

Only **SENATE** and **COMP-FINAL** were visible; the rest were **hidden** but readable:

| Sheet | Role |
|---|---|
| `NEP` | Executive NEP line items (hidden) |
| `HREP-GAB` | House GAB line items (hidden) |
| `SENATE` | Senate proposals |
| `COMP-FINAL` | Side-by-side NEP / GAB / variance / Senate + doc links |
| `facility`, `links`, `Sheet7`, `Sheet11` | Link helpers (hidden) |
| `XXX`, `Pivot Table 1`, `COMPARISON` | Working/pivot sheets (hidden) |

## Headline Budget Summary

| Source | Projects | Total |
|---|---:|---:|
| NEP | 464 | ₱14.47B |
| HREP-GAB | 513 | ₱10.02B |
| Senate (`SENATE` sheet & Annex A-2 PDF) | 174 | ₱5.49B* |
| **NEP → GAB Δ** | | **−₱4.45B** |

\* *Note: `COMP-FINAL` sums `sen_total` to ₱5.69B (+₱200M) because **Dr. Jose N. Rodriguez Memorial Hospital and Sanitarium** is a `−₱100M` deduction in the Senate Annex A-2 PDF and `SENATE` sheet, but entered as `+₱100M` in `COMP-FINAL`.*

Main shift: **DOH hospitals cut**, **LGU hospitals inserted/increased**. See `data/csv/summary_by_category.csv` and `data/csv/summary_by_region.csv`.

## Documentary Links & Downloads

758 facility rows (757 unique facilities) in `COMP-FINAL` map to **318 unique Drive/Docs resources** (`RES-####`).

| Access (probe) | Resources | Facilities |
|---|---:|---:|
| public | 192 | 276 |
| auth_required | 113 | 469 |
| no_url | 11 | 11 |
| not_found | 2 | 2 |

Many facilities share one Drive folder or Sheet (e.g. one spreadsheet → 77 facilities). **Download once per `RES-####`**, not once per facility.

```bash
export PATH="$HOME/.local/bin:$PATH"
# auth: see docs/rclone_download.md
python3 scripts/download_with_rclone.py --resource RES-0003   # smoke test
python3 scripts/download_with_rclone.py                       # all accessible resources
python3 scripts/match_downloads_to_facilities.py              # match local files to facilities
python3 scripts/build_json_catalogs.py                        # rebuild data/json/*.json
```

`downloads/` (7.45 GB, 2,568 files across 180 resources) is gitignored.

## Repository Layout

```text
HFEP/
  server/
    index.mjs                         # Node.js + SQLite API & local file server (port 8787)
  web/
    vite.config.ts                    # Vite config (port 5177, /api & /local-files proxy)
    src/
      App.tsx                         # Main shell, routing, auth/audit modals, 3-col Explorer
      PendingView.tsx                 # Pending facilities & sources tab + CSV export
      StatsView.tsx                   # Coverage, document types, allocation sources, regions
      AboutView.tsx                   # Project overview, data sources, caveats
      allocFilter.ts                  # Shared budget allocation source filter & counts
      types.ts                        # TypeScript interfaces
      styles.css                      # App styling
  scripts/
    download_with_rclone.py           # Authenticated rclone downloader (preferred)
    download_public_resources.py      # Legacy gdown public-only downloader
    match_downloads_to_facilities.py  # Subfolder/file-to-facility matcher
    build_json_catalogs.py            # Generates data/json/facilities_catalog.json & resources_catalog.json
  data/
    HFEP 2027 NEP VS GAB.xlsx         # Source workbook
    csv/                              # Extracted & derived CSV tables
    json/                             # Unified JSON catalogs for the web app
  docs/
    architecture.md                   # Backend, SQLite schema, API, and frontend guide
    data_and_links.md                 # Extraction, inventory, and access probes
    rclone_download.md                # Google Drive auth & rclone download guide
  downloads/                          # Local Drive artifacts (gitignored)
```
