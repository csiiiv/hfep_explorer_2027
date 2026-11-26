#!/usr/bin/env python3
"""Build unified JSON catalogs for HFEP 2027 facilities and Drive resources.

Outputs:
  - data/json/facilities_catalog.json  (all 757 facilities: budget + link + matched files)
  - data/json/resources_catalog.json   (all 318 resources: link + zip + folder/file tree)
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CSV_DIR = ROOT / "data" / "csv"
JSON_DIR = ROOT / "data" / "json"
DL_DIR = ROOT / "downloads"
MANIFEST_PATH = DL_DIR / "manifest_rclone.json"


def clean_val(v):
    if pd.isna(v):
        return None
    if hasattr(v, "item"):
        return v.item()
    return v


def clean_str(v) -> str:
    if pd.isna(v):
        return ""
    return str(v).strip()


def split_semi(v) -> list[str]:
    s = clean_str(v)
    if not s:
        return []
    return [x.strip() for x in s.split(";") if x.strip()]


def build_resources_catalog(
    inv: pd.DataFrame,
    fmap: pd.DataFrame,
    files_df: pd.DataFrame,
    folders_df: pd.DataFrame,
    shared_detail: pd.DataFrame,
    manifest: dict,
) -> dict:
    m_by_code = {r["resource_code"]: r for r in manifest.get("resources", [])}

    # Pre-group dataframes for speed
    fmap_by_res = {k: g for k, g in fmap.groupby("resource_code")}
    files_by_res = {k: g for k, g in files_df.groupby("resource_code")}
    folders_by_res = {k: g for k, g in folders_df.groupby("resource_code")}
    detail_by_res = {k: g for k, g in shared_detail.groupby("resource_code")}

    items = []
    for _, row in inv.sort_values("resource_code").iterrows():
        code = row["resource_code"]
        m_entry = m_by_code.get(code)
        res_fmap = fmap_by_res.get(code)
        res_files = files_by_res.get(code)
        res_folders = folders_by_res.get(code)
        res_detail = detail_by_res.get(code)

        linked_facs = []
        if res_fmap is not None:
            for _, fr in res_fmap.drop_duplicates("facility_code").sort_values("facility_code").iterrows():
                linked_facs.append({
                    "facility_code": fr["facility_code"],
                    "facility": fr["facility"],
                    "region": clean_str(fr["region"]),
                    "province": clean_str(fr["province"]),
                    "status": clean_str(fr["status"]),
                })

        # Download & zip info
        dl_info = None
        if m_entry:
            dl_info = {
                "status": m_entry.get("status"),
                "downloaded_at": m_entry.get("downloaded_at"),
                "local_dir": f"downloads/{code}" if m_entry.get("local_dir") else None,
                "file_count": int(m_entry.get("file_count") or 0),
                "zip": {
                    "path": f"downloads/{m_entry['zip_path']}" if m_entry.get("zip_path") else None,
                    "bytes": m_entry.get("zip_bytes"),
                    "sha256": m_entry.get("zip_sha256"),
                } if m_entry.get("zip_path") else None,
                "error": m_entry.get("error"),
            }

        # Subfolder tree (grouped by subfolder path -> list of files)
        subfolders = []
        if res_files is not None and len(res_files) > 0:
            detail_lookup = {}
            if res_detail is not None:
                for _, dr in res_detail.iterrows():
                    detail_lookup[dr["subfolder"]] = {
                        "matched_facility_count": int(dr["matched_facility_count"]),
                        "best_facility_code": clean_str(dr["best_facility_code"]) or None,
                        "best_facility_name": clean_str(dr["best_facility_name"]) or None,
                        "best_score": float(dr["best_score"]),
                    }

            for sub_name, grp in res_files.groupby(res_files["subfolder"].fillna("(root)")):
                sub_key = sub_name if sub_name else "(root)"
                file_list = [
                    {
                        "filename": r["filename"],
                        "relative_path": r["relative_path"],
                        "local_path": f"downloads/{code}/{r['relative_path']}",
                        "ext": clean_str(r["ext"]),
                        "bytes": int(r["bytes"]),
                    }
                    for _, r in grp.sort_values("relative_path").iterrows()
                ]
                sf_obj = {
                    "subfolder": sub_key,
                    "file_count": len(file_list),
                    "total_bytes": sum(f["bytes"] for f in file_list),
                    "files": file_list,
                }
                if sub_key in detail_lookup:
                    sf_obj["match"] = detail_lookup[sub_key]
                subfolders.append(sf_obj)

        items.append({
            "resource_code": code,
            "resource_kind": clean_str(row["resource_kind"]),
            "resource_id": clean_val(row["resource_id"]),
            "canonical_url": clean_val(row["canonical_url"]),
            "access_status": clean_str(row["access_status"]),
            "download_strategy": clean_str(row["download_strategy"]),
            "n_facilities": len(linked_facs),
            "is_shared": len(linked_facs) > 1,
            "regions": split_semi(row.get("regions")),
            "provinces": split_semi(row.get("provinces")),
            "budget_totals": {
                "nep": float(row.get("nep_total") or 0),
                "gab": float(row.get("gab_total") or 0),
                "senate": float(row.get("sen_total") or 0),
            },
            "facilities": linked_facs,
            "download": dl_info,
            "subfolders": subfolders,
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "counts": {
            "total_resources": len(items),
            "downloaded": sum(1 for x in items if (x["download"] or {}).get("status") == "downloaded"),
            "shared_resources": sum(1 for x in items if x["is_shared"]),
            "total_files": sum(
                (x["download"] or {}).get("file_count", 0)
                for x in items
                if (x["download"] or {}).get("status") == "downloaded"
            ),
        },
        "resources": items,
    }


def build_facilities_catalog(
    comp: pd.DataFrame,
    fmap: pd.DataFrame,
    match_df: pd.DataFrame,
    files_df: pd.DataFrame,
    manifest: dict,
) -> dict:
    m_by_code = {r["resource_code"]: r for r in manifest.get("resources", [])}
    match_by_fac = {r["facility_code"]: r for _, r in match_df.iterrows()}
    files_by_res = {k: g for k, g in files_df.groupby("resource_code")}

    # Merge comp_final budget detail with facility_code/resource_code from fmap
    # Both have 758 rows; join on region, province, facility, status, nep_total, gab_total, sen_total
    merged = fmap.merge(
        comp[[
            "region", "province", "facility", "status",
            "nep_infra", "nep_eqpt", "nep_mv", "nep_total",
            "gab_infra", "gab_eqpt", "gab_mv", "gab_total",
            "var_infra", "var_eqpt", "var_mv", "var_total",
            "sen_infra", "sen_eqpt", "sen_mv", "sen_total",
        ]].drop_duplicates(),
        on=["region", "province", "facility", "status", "nep_total", "gab_total", "sen_total"],
        how="left",
    )

    items = []
    for fcode, grp in merged.groupby("facility_code", sort=True):
        first = grp.iloc[0]
        rcode = clean_str(first["resource_code"])
        m_entry = m_by_code.get(rcode)
        mrow = match_by_fac.get(fcode)

        # Budget line items (usually 1; 2 for Basilan Medical Center)
        line_items = []
        for _, r in grp.iterrows():
            line_items.append({
                "status": clean_str(r["status"]),
                "category": clean_str(r["category"]),
                "subcategory": clean_str(r["subcategory"]),
                "nep": {
                    "infra": float(r.get("nep_infra") or 0),
                    "equipment": float(r.get("nep_eqpt") or 0),
                    "motor_vehicle": float(r.get("nep_mv") or 0),
                    "total": float(r.get("nep_total") or 0),
                },
                "gab": {
                    "infra": float(r.get("gab_infra") or 0),
                    "equipment": float(r.get("gab_eqpt") or 0),
                    "motor_vehicle": float(r.get("gab_mv") or 0),
                    "total": float(r.get("gab_total") or 0),
                },
                "variance": {
                    "infra": float(r.get("var_infra") or 0),
                    "equipment": float(r.get("var_eqpt") or 0),
                    "motor_vehicle": float(r.get("var_mv") or 0),
                    "total": float(r.get("var_total") or 0),
                },
                "senate": {
                    "infra": float(r.get("sen_infra") or 0),
                    "equipment": float(r.get("sen_eqpt") or 0),
                    "motor_vehicle": float(r.get("sen_mv") or 0),
                    "total": float(r.get("sen_total") or 0),
                },
            })

        budget_summary = {
            "nep_total": sum(x["nep"]["total"] for x in line_items),
            "gab_total": sum(x["gab"]["total"] for x in line_items),
            "variance_total": sum(x["variance"]["total"] for x in line_items),
            "senate_total": sum(x["senate"]["total"] for x in line_items),
            "statuses": sorted({x["status"] for x in line_items if x["status"]}),
        }

        # Resolve matched files for this facility
        download_block = None
        if mrow is not None:
            mtype = clean_str(mrow["match_type"])
            matched_subs = split_semi(mrow.get("matched_subfolders"))
            res_files = files_by_res.get(rcode)
            matched_files = []

            if res_files is not None and len(res_files) > 0:
                if mtype in ("direct_1to1", "shared_compound_bundle"):
                    sel = res_files
                elif mtype == "shared_subfolder_match":
                    sel = res_files[res_files["subfolder"].isin(matched_subs)]
                elif mtype == "shared_umbrella_docs_only":
                    sel = res_files[res_files["subfolder"].isna() | (res_files["subfolder"] == "")]
                elif mtype == "shared_filename_match":
                    # Re-select matching filenames via matcher's sample or subfolder + token check
                    from match_downloads_to_facilities import facility_signature, norm_text, score_match

                    fdist, fall = facility_signature(first["facility"], clean_str(first["province"]))
                    fnorm = norm_text(first["facility"])
                    scored = [
                        (idx, score_match(fdist, fall, fnorm, r["filename"]))
                        for idx, r in res_files.iterrows()
                    ]
                    scored = [x for x in scored if x[1] >= 0.58]
                    if scored:
                        best = max(x[1] for x in scored)
                        keep_idx = [x[0] for x in scored if x[1] >= max(0.58, best - 0.15)]
                        sel = res_files.loc[keep_idx]
                    else:
                        sel = res_files.iloc[0:0]
                else:
                    sel = res_files.iloc[0:0]

                matched_files = [
                    {
                        "filename": r["filename"],
                        "relative_path": r["relative_path"],
                        "local_path": f"downloads/{rcode}/{r['relative_path']}",
                        "subfolder": clean_str(r["subfolder"]) or "(root)",
                        "ext": clean_str(r["ext"]),
                        "bytes": int(r["bytes"]),
                    }
                    for _, r in sel.sort_values("relative_path").iterrows()
                ]

            download_block = {
                "downloaded": True,
                "match_type": mtype,
                "match_confidence": float(mrow["match_confidence"]),
                "needs_review": bool(mrow["needs_review"]),
                "matched_subfolders": matched_subs,
                "file_count": len(matched_files),
                "total_bytes": sum(f["bytes"] for f in matched_files),
                "zip_path": f"downloads/{m_entry['zip_path']}" if (m_entry and m_entry.get("zip_path")) else None,
                "files": matched_files,
            }
        else:
            download_block = {
                "downloaded": False,
                "reason": (
                    "empty_public_folder"
                    if (m_entry and m_entry.get("status") == "error" and clean_str(first["access_status"]) == "public")
                    else clean_str(first["access_status"])
                ),
                "file_count": 0,
                "total_bytes": 0,
                "files": [],
            }

        items.append({
            "facility_code": fcode,
            "facility": first["facility"],
            "region": clean_str(first["region"]),
            "province": clean_str(first["province"]),
            "category": clean_str(first["category"]),
            "subcategory": clean_str(first["subcategory"]),
            "budget": budget_summary,
            "budget_line_items": line_items,
            "resource": {
                "resource_code": rcode,
                "resource_kind": clean_str(first["resource_kind"]),
                "resource_id": clean_val(first["resource_id"]),
                "canonical_url": clean_val(first["canonical_url"]),
                "access_status": clean_str(first["access_status"]),
            },
            "download": download_block,
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "counts": {
            "total_facilities": len(items),
            "downloaded_facilities": sum(1 for x in items if x["download"]["downloaded"]),
            "pending_facilities": sum(1 for x in items if not x["download"]["downloaded"]),
            "needs_review": sum(1 for x in items if x["download"].get("needs_review")),
        },
        "facilities": items,
    }


def main() -> None:
    JSON_DIR.mkdir(parents=True, exist_ok=True)

    comp = pd.read_csv(CSV_DIR / "comp_final.csv")
    inv = pd.read_csv(CSV_DIR / "link_inventory.csv")
    fmap = pd.read_csv(CSV_DIR / "facility_link_map.csv")
    files_df = pd.read_csv(CSV_DIR / "downloaded_files_inventory.csv")
    folders_df = pd.read_csv(CSV_DIR / "downloaded_subfolders_inventory.csv")
    match_df = pd.read_csv(CSV_DIR / "facility_download_match.csv")
    shared_detail = pd.read_csv(CSV_DIR / "shared_subfolder_match_detail.csv")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    res_cat = build_resources_catalog(inv, fmap, files_df, folders_df, shared_detail, manifest)
    fac_cat = build_facilities_catalog(comp, fmap, match_df, files_df, manifest)

    res_path = JSON_DIR / "resources_catalog.json"
    fac_path = JSON_DIR / "facilities_catalog.json"

    res_path.write_text(json.dumps(res_cat, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    fac_path.write_text(json.dumps(fac_cat, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Wrote {res_path} ({res_path.stat().st_size / 1e6:.2f} MB) — {res_cat['counts']}")
    print(f"Wrote {fac_path} ({fac_path.stat().st_size / 1e6:.2f} MB) — {fac_cat['counts']}")


if __name__ == "__main__":
    main()
