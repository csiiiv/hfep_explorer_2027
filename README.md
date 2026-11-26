# HFEP 2027 — NEP vs GAB / documentary links

Working set for the DOH **Health Facilities Enhancement Program (HFEP) 2027** comparison between the **NEP** (executive proposal), **House GAB** (`HREP-GAB`), and **Senate** inserts, plus inventory and download of documentary-requirement Drive links.

## Quick map

| Area | Start here |
|---|---|
| Budget comparison CSVs | `data/csv/comp_final.csv` |
| Unique Drive resources | `data/csv/link_inventory.csv` |
| Facility ↔ resource map | `data/csv/facility_link_map.csv` |
| Links needing owner action | `data/csv/links_needing_action_by_resource.csv` |
| Authenticated downloads | [`docs/rclone_download.md`](docs/rclone_download.md) |
| Data + link pipeline detail | [`docs/data_and_links.md`](docs/data_and_links.md) |

## Source workbook

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

## Headline budget finding (from `COMP-FINAL`)

| Source | Projects | Total |
|---|---:|---:|
| NEP | 464 | ₱14.47B |
| HREP-GAB | 513 | ₱10.02B |
| Senate | 174 | ₱5.49B |
| **NEP → GAB Δ** | | **−₱4.45B** |

Main shift: **DOH hospitals cut**, **LGU hospitals inserted/increased**. See `data/csv/summary_by_category.csv` and `summary_by_region.csv`.

## Documentary links (deduped)

758 facility rows in `COMP-FINAL` map to **318 unique Drive/Docs resources** (`RES-####`).

| Access (probe) | Resources | Facilities |
|---|---:|---:|
| public | 192 | 276 |
| auth_required | 113 | 469 |
| no_url | 11 | 11 |
| not_found | 2 | 2 |

Many facilities share one Drive folder or Sheet (e.g. one spreadsheet → 77 facilities). **Download once per `RES-####`**, not once per facility.

## Downloads

Preferred: **authenticated rclone** → unpacked `downloads/RES-####/` + `downloads/RES-####.zip`.

```bash
export PATH="$HOME/.local/bin:$PATH"
# auth: see docs/rclone_download.md
python3 scripts/download_with_rclone.py --resource RES-0003   # smoke
python3 scripts/download_with_rclone.py                       # all public
```

Legacy/public-only experiment: `scripts/download_public_resources.py` (`gdown`, recursive, no zip).

`downloads/` is gitignored.

## Layout

```text
HFEP/
  data/
    HFEP 2027 NEP VS GAB.xlsx
    csv/                      # extracted + derived tables
  docs/
    data_and_links.md         # extraction, inventory, probes
    rclone_download.md        # Google auth + rclone downloader
  scripts/
    download_with_rclone.py   # preferred downloader
    download_public_resources.py
  downloads/                  # local artifacts (gitignored)
```

## Status codes

**Budget row (`comp_final.status`)** — NEP vs GAB:

- `unchanged`, `increased`, `decreased`, `gab_inserted`, `nep_dropped`, `senate_only`

**Link access (`link_inventory.access_status`)** — HTTP probe:

- `public`, `auth_required`, `no_url`, `not_found` (+ rare `error`)

**Download (`manifest_rclone.json` / `manifest.json`)**:

- `downloaded`, `partial`, `error`
