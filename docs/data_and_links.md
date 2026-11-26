# Data extraction, budget analysis, and link inventory

This note covers everything done on the HFEP 2027 workbook **before** authenticated downloads. For rclone auth and `RES-####.zip` downloads, see [`rclone_download.md`](rclone_download.md).

## 1. Workbook inspection

Source: `data/HFEP 2027 NEP VS GAB.xlsx` (~1 MB).

### Visible vs hidden sheets

| Sheet | State | Used for |
|---|---|---|
| `SENATE` | visible | Senate line items |
| `COMP-FINAL` | visible | Master comparison + doc links |
| `NEP` | hidden | Executive NEP list |
| `HREP-GAB` | hidden | House GAB list |
| `XXX` | hidden | Combined/normalized working table |
| `Pivot Table 1` | hidden | SIMILAR/DIFFERENT flags |
| `COMPARISON` | hidden | Empty / unused in practice |
| `Sheet11`, `Sheet7` | hidden | Facility ↔ Drive link lists |
| `facility`, `links` | hidden | Link helpers |

**Practical source of truth for analysis:** `COMP-FINAL` (exported as `data/csv/comp_final.csv`).

### `COMP-FINAL` shape

Two header rows flattened to:

- Identity: category, subcategory, region, province, facility  
- NEP: infra / equipment / MV / total  
- HREP-GAB: infra / equipment / MV / total  
- Variance (GAB − NEP): infra / equipment / MV / total  
- Senate: infra / equipment / MV / total  
- Doc Drive link  

758 data rows after dropping blanks.

---

## 2. CSV extraction

All under `data/csv/`.

### Source lists

| File | Rows | Notes |
|---|---:|---|
| `nep.csv` | 464 | From `NEP` sheet |
| `hrep_gab.csv` | 513 | From `HREP-GAB` |
| `senate.csv` | 174 | Summary/total rows stripped |
| `all_sources_long.csv` | ~1,151 | Stacked NEP + GAB + Senate |
| `comp_final.csv` | 758 | Flattened comparison + `status` |
| `facility_links.csv` | 758 | From `facility` sheet (fewer real URLs than COMP-FINAL) |

### Budget aggregates

| File | Content |
|---|---|
| `summary_by_category.csv` | NEP / GAB / variance / Senate by category |
| `summary_by_region.csv` | Same by region |

### How `comp_final.status` was assigned

| Status | Meaning |
|---|---|
| `unchanged` | Both NEP and GAB &gt; 0, variance total = 0 |
| `increased` | Both present, GAB &gt; NEP |
| `decreased` | Both present, GAB &lt; NEP |
| `gab_inserted` | GAB only |
| `nep_dropped` | NEP only |
| `senate_only` | Senate amount only (no NEP/GAB) |

### Headline results (snapshot)

- NEP ₱14.47B → GAB ₱10.02B (**−₱4.45B**)
- Unchanged: 264 rows  
- GAB inserted: 159 (~₱2.46B)  
- NEP dropped: 110 (~₱6.41B)  
- Amount changes both present: 44 up / 46 down  
- Senate-only rows: 135  

Category pattern: **DOH hospitals heavily cut**; **LGU hospitals expanded**. Largest regional cut: **NCR**.

Largest NEP drops (examples): Philippine Cancer Center ₱900M; Jose B. Lingad ₱350M; Vicente Sotto ₱320M.  
Largest GAB inserts (examples): Cauayan City Medical Center ₱360M; Cauayan District Hospital ₱125M.

Senate sheet originally included a “Total (visible rows)” formula row that inflated sums; cleaned in `senate.csv`.

---

## 3. Link inventory (dedupe for downloads)

Goal: avoid downloading the same Drive folder/Sheet once per facility.

### Derived files

| File | Purpose |
|---|---|
| `link_inventory.csv` | One row per unique resource (`RES-####`) |
| `facility_link_map.csv` | Each facility (`FAC-####`) → `RES-####` + access fields |
| `facility_resource_join.csv` | Slim FAC ↔ RES join |
| `link_probe_results.csv` | Raw HTTP probe outcomes |
| `link_verification_summary.csv` | Counts snapshot |

### Coding scheme

- **`RES-####`** — unique downloadable resource (folder / file / spreadsheet / …). Suggested download directory name.
- **`FAC-####`** — unique facility/project identity (region + province + name).

### URL cleanup

Many `doc_link` values were dirty:

- Concatenated duplicates: `...drive_linkhttps://...`
- Scheme-less glued hosts: `docs.google.com/...IDdocs.google.com/...`
- IDs with glued suffixes: `...IDdrive` / `...IDdocs`

Cleaning + ID extraction reduced false `not_found` probes and recovered 64 scheme-less Sheets URLs (still mostly `auth_required`).

### Resource kinds (inventory)

| Kind | Count | Download approach |
|---|---:|---|
| folder | 184 | rclone folder copy → zip |
| spreadsheet | 108 | Auth; Sheets export / Drive API |
| open_id | 13 | Single file via id |
| file | 2 | Single file |
| unknown | 11 | Not URLs (filenames / “To follow”) |

**Sharing:** 33 resources are shared by multiple facilities (469 facility mappings). Largest: one spreadsheet → **77** facilities.

---

## 4. Access verification (HTTP probe)

Unauthenticated HEAD/GET-style probes classified each canonical URL.

| Status | Meaning |
|---|---|
| `public` | Reachable without Google login |
| `auth_required` | 401/403 / sign-in / permission wall |
| `not_found` | 404 / missing |
| `no_url` | Placeholder or bare filename, not a URL |
| `error` | Transport/other failure |

### Snapshot counts

| Access | Resources | Facility rows |
|---|---:|---:|
| public | 192 | 276 |
| auth_required | 113 | 469 |
| no_url | 11 | 11 |
| not_found | 2 | 2 |

Important caveats from testing:

- **Folder can be listable/public while some nested files are not** → partial downloads.
- **Probe “public” ≠ always downloadable via `gdown`** for every file (rate limits / confirm walls).
- **All 108 spreadsheets probed as `auth_required`** (CSV export and viewer).

---

## 5. Forwardable lists for document owners

| File | Use |
|---|---|
| `links_needing_action_by_resource.csv` | **Prefer this** — 126 unique links to fix once |
| `links_needing_action_by_facility.csv` | 482 facility-level rows for project detail |

Columns include issue label, suggested action, codes, geography, amounts, canonical URL / raw link, and how many facilities share the resource.

Ask owners to:

1. Share publicly **or** grant access to a working Google account.  
2. Replace `no_url` / broken links with real Drive/Docs URLs.  
3. Clarify whether large Sheets are **indexes** vs per-facility document packs.

---

## 6. Download approaches tried

### A. `gdown` (public, recursive) — `scripts/download_public_resources.py`

- Uses `gdown.download_folder` / `gdown.download`.
- Writes `downloads/RES-####/` + `downloads/manifest.json`.
- Resume: skips `downloaded`; retries `partial`/`error`.
- **Pros:** No login for truly public folders.  
- **Cons:** File-by-file; nested permission failures; no native folder zip; rate limits.

Test notes:

- `RES-0003` — full OK (1 PDF).  
- `RES-0155` — partial (~47 files / ~152 MB); many nested files blocked; folder is a large regional dump mapped to only 2 facilities in COMP-FINAL.  
- Some “public” files still failed via gdown until retried.

### B. rclone + local zip (authenticated) — preferred

Documented in [`rclone_download.md`](rclone_download.md).

- Remote name: `hfep` (`drive.readonly`).
- Script: `scripts/download_with_rclone.py`.
- Output: `downloads/RES-####/`, `downloads/RES-####.zip`, `downloads/manifest_rclone.json`.
- Google has **no supported public “download folder as one zip” API**; rclone copies recursively, script zips locally.

Smoke test succeeded for `RES-0003` (1 file + zip + sha256 in manifest).

### Why not Drive “Download folder” zip over HTTP?

Tried `uc?export=download&id=FOLDER_ID` → 404.  
Anonymous Takeout (`takeout-pa.clients6.google.com`) → 403 without browser session.  
rclone/Google Drive API maintainers confirm no public folder-zip endpoint.

---

## 7. Provenance join (for later analysis)

```text
facility (FAC-####)
  → resource (RES-####)          [facility_link_map.csv]
    → canonical_url / resource_id
      → local files / RES-####.zip
        → sha256 in manifest_rclone.json
```

Budget amounts stay on the facility row (`nep_total`, `gab_total`, `sen_total`, `status`).

---

## 8. Regenerating artifacts (reference)

There is no single packaged ETL script yet; work was done via notebook-style Python against the xlsx. Logical order if redoing:

1. Read sheets → write `nep.csv`, `hrep_gab.csv`, `senate.csv`, `comp_final.csv` (+ summaries).  
2. Clean URLs → build `link_inventory.csv`, `facility_link_map.csv`.  
3. Probe URLs → stamp `access_status`.  
4. Export `links_needing_action_*.csv`.  
5. Download via rclone (`docs/rclone_download.md`).

Re-probe / rebuild inventories should keep **stable sort keys** if you need stable `RES-####` / `FAC-####` codes across runs (codes are assigned by sorted kind/id and region/province/facility).

---

## 9. Related files checklist

```text
data/csv/
  nep.csv / hrep_gab.csv / senate.csv / all_sources_long.csv
  comp_final.csv
  summary_by_category.csv / summary_by_region.csv
  link_inventory.csv / link_probe_results.csv / link_verification_summary.csv
  facility_link_map.csv / facility_resource_join.csv / facility_links.csv
  links_needing_action_by_resource.csv
  links_needing_action_by_facility.csv

scripts/
  download_with_rclone.py          # preferred
  download_public_resources.py     # gdown fallback

docs/
  data_and_links.md                # this file
  rclone_download.md               # auth + rclone usage
```
