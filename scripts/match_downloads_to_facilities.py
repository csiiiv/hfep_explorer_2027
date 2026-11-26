#!/usr/bin/env python3
"""Inventory downloaded RES-#### folders and match facilities to subfolders/files.

Produces:
  - data/csv/downloaded_files_inventory.csv
  - data/csv/downloaded_subfolders_inventory.csv
  - data/csv/facility_download_match.csv
  - data/csv/shared_subfolder_match_detail.csv
"""

from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CSV_DIR = ROOT / "data" / "csv"
DL_DIR = ROOT / "downloads"
MANIFEST = DL_DIR / "manifest_rclone.json"

STOPWORDS = {
    "municipality", "city", "of", "the", "and", "in", "for", "with", "at", "de", "del",
    "barangay", "brgy", "health", "station", "stations", "bhs", "center", "centre",
    "rural", "unit", "rhu", "super", "shc", "primary", "care", "facility", "facilities",
    "hospital", "district", "provincial", "municipal", "general", "medical", "memorial",
    "community", "integrated", "infirmary", "clinic", "lyingin", "lying", "birthing",
    "home", "office", "mho", "cho", "doh", "lgu", "hfep", "2027", "2026", "infra",
    "infrastructure", "equipment", "eqpt", "ambulance", "mv", "me", "me1", "me2", "me3",
    "proof", "land", "lot", "ownership", "site", "development", "plan", "sdp", "hazard",
    "assessment", "report", "geohazard", "maps", "map", "tax", "dec", "declaration",
    "daed", "pdf", "jpg", "jpeg", "png", "docx", "xlsx", "new", "main", "satellite",
    "bureau", "quarantine", "boq", "sub", "national", "regional", "reference", "laboratory",
    "blood", "wellness", "treatment", "rehabilitation", "proposed", "proposal", "project",
    "certification", "readiness", "implementation", "manpower", "availability", "letter",
    "commitment", "model", "architectural", "floorplan", "page", "pg",
}

ABBREV_MAP = {
    "brgy": "barangay",
    "bhs": "barangay health station",
    "rhu": "rural health unit",
    "shc": "super health center",
    "dh": "district hospital",
    "ph": "provincial hospital",
    "gh": "general hospital",
    "mc": "medical center",
    "cho": "city health office",
    "mho": "municipal health office",
    "sta": "santa",
    "sto": "santo",
    "mt": "mountain",
    "st": "saint",
    "snrl": "sub national reference laboratory",
    "boq": "bureau of quarantine",
}


def norm_text(s: str) -> str:
    s = str(s or "").lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def tokens(s: str, drop_stop: bool = True) -> set[str]:
    words = norm_text(s).split()
    out = set()
    for w in words:
        if len(w) <= 1 and not w.isdigit():
            continue
        if drop_stop and w in STOPWORDS:
            continue
        out.add(w)
        if w in ABBREV_MAP:
            for exp in ABBREV_MAP[w].split():
                if not drop_stop or exp not in STOPWORDS:
                    out.add(exp)
    return out


def facility_signature(facility: str, province: str) -> tuple[set[str], set[str]]:
    """Return (distinctive_tokens, all_tokens) for a facility."""
    # Strip leading "City of X," or "Municipality of X," when a specific facility name follows
    cleaned = re.sub(r"^(?:City|Municipality)\s+of\s+[^,]+,\s*", "", str(facility or ""), flags=re.I)
    cleaned = re.sub(r",\s*(?:City|Municipality)\s+of\s+[^,]+$", "", cleaned, flags=re.I)
    dist = tokens(cleaned, drop_stop=True)
    if not dist:
        dist = tokens(facility, drop_stop=True)
    prov_toks = tokens(province, drop_stop=True)
    non_prov = dist - prov_toks
    if non_prov:
        dist = non_prov
    return dist, tokens(facility, drop_stop=False)


def score_match(fac_dist: set[str], fac_all: set[str], fac_norm: str, cand_text: str) -> float:
    cand_norm = norm_text(cand_text)
    if not cand_norm or not fac_dist:
        return 0.0
    cand_dist = tokens(cand_text, drop_stop=True)
    cand_all = tokens(cand_text, drop_stop=False)

    # Exact substring of normalized name
    if fac_norm in cand_norm or (len(cand_norm) >= 6 and cand_norm in fac_norm):
        return 0.98

    # Distinctive token recall (how much of the facility's unique name appears in candidate)
    overlap = fac_dist & cand_dist
    if not overlap:
        # Check prefix/fuzzy token match (handles typos like "Cagadungan" vs "Cagandungan", "Buevavista")
        fuzzy_hits = 0.0
        for ft in fac_dist:
            if len(ft) < 4:
                continue
            best = max((SequenceMatcher(None, ft, ct).ratio() for ct in cand_dist if len(ct) >= 4), default=0.0)
            if best >= 0.84:
                fuzzy_hits += best
        if fuzzy_hits == 0:
            return 0.0
        recall = fuzzy_hits / len(fac_dist)
        return round(min(0.85, recall * 0.85), 3)

    recall = len(overlap) / len(fac_dist)
    precision = len(overlap) / max(1, len(cand_dist))
    all_overlap = len(fac_all & cand_all) / max(1, len(fac_all))
    seq = SequenceMatcher(None, fac_norm, cand_norm).ratio()

    # Weighted blend favoring recall of distinctive facility tokens
    score = 0.60 * recall + 0.15 * precision + 0.15 * all_overlap + 0.10 * seq
    # Penalize single-token generic matches when facility has multiple distinctive tokens
    if len(fac_dist) >= 2 and len(overlap) == 1:
        only_tok = next(iter(overlap))
        if len(only_tok) <= 3 or only_tok.isdigit():
            score *= 0.4
    return round(min(0.97, score), 3)


def main() -> None:
    m = json.loads(MANIFEST.read_text(encoding="utf-8"))
    fmap = pd.read_csv(CSV_DIR / "facility_link_map.csv")
    files_df = pd.read_csv(CSV_DIR / "downloaded_files_inventory.csv")
    folders_df = pd.read_csv(CSV_DIR / "downloaded_subfolders_inventory.csv")

    dl_codes = {r["resource_code"] for r in m["resources"] if r.get("status") == "downloaded"}
    dl_fmap = fmap[fmap["resource_code"].isin(dl_codes)].copy()

    fac_per_res = dl_fmap.groupby("resource_code")["facility_code"].nunique().to_dict()

    match_rows = []
    shared_detail_rows = []

    for code in sorted(dl_codes):
        res_facs = dl_fmap[dl_fmap["resource_code"] == code].drop_duplicates("facility_code")
        res_files = files_df[files_df["resource_code"] == code]
        res_folders = folders_df[
            (folders_df["resource_code"] == code) & (folders_df["direct_files"] > 0)
        ]

        n_facs = len(res_facs)

        # Case 1: 1:1 resource
        if n_facs == 1:
            r = res_facs.iloc[0]
            match_rows.append({
                "facility_code": r["facility_code"],
                "facility": r["facility"],
                "region": r["region"],
                "province": r["province"],
                "category": r["category"],
                "status": r["status"],
                "resource_code": code,
                "resource_n_facilities": 1,
                "match_type": "direct_1to1",
                "match_confidence": 1.0,
                "matched_subfolders": "; ".join(sorted(res_folders["subfolder"].unique()[:10])),
                "matched_file_count": int(len(res_files)),
                "matched_mb": round(res_files["bytes"].sum() / 1e6, 2),
                "sample_files": " | ".join(res_files["relative_path"].head(4).tolist()),
                "needs_review": False,
            })
            continue

        # Case 2: Shared resource (>1 facility)
        # Candidate leaf subfolders (those with direct_files > 0, excluding root)
        leaf_subs = res_folders[res_folders["subfolder"] != "(root)"].copy()

        # Precompute facility signatures
        fac_sigs = []
        for _, r in res_facs.iterrows():
            fdist, fall = facility_signature(r["facility"], str(r["province"] or ""))
            fac_sigs.append((r, fdist, fall, norm_text(r["facility"])))

        # Track subfolder -> best facility matches for the detail table
        sub_to_facs: dict[str, list[tuple[str, str, float]]] = {}

        for r, fdist, fall, fnorm in fac_sigs:
            fcode = r["facility_code"]
            fname = r["facility"]

            # 2a. Score every leaf subfolder (matching against full subfolder path & leaf name)
            matched_subs = []
            for _, sf in leaf_subs.iterrows():
                s_leaf = score_match(fdist, fall, fnorm, sf["leaf_name"])
                s_path = score_match(fdist, fall, fnorm, sf["subfolder"])
                sc = max(s_leaf, s_path)
                if sc >= 0.55:
                    matched_subs.append((sf["subfolder"], sc, int(sf["direct_files"]), int(sf["total_bytes_under"])))
                    sub_to_facs.setdefault(sf["subfolder"], []).append((fcode, fname, sc))

            # 2b. Also score individual filenames (crucial for flat/doc-type-grouped folders like BOQ, Valenzuela, Iloilo)
            matched_file_rows = []
            for _, fl in res_files.iterrows():
                sc_f = score_match(fdist, fall, fnorm, fl["filename"])
                if sc_f >= 0.58:
                    matched_file_rows.append((fl["relative_path"], sc_f, int(fl["bytes"])))

            if matched_subs:
                # Keep top scoring subfolders (within 0.18 of best, or >=0.65)
                matched_subs.sort(key=lambda x: -x[1])
                best_sc = matched_subs[0][1]
                kept_subs = [x for x in matched_subs if x[1] >= max(0.55, best_sc - 0.18)]
                sub_names = [x[0] for x in kept_subs]
                sub_files = res_files[res_files["subfolder"].isin(sub_names)]
                # Union with any directly matched files outside those subfolders
                extra_paths = {x[0] for x in matched_file_rows} - set(sub_files["relative_path"])
                all_matched = res_files[
                    res_files["subfolder"].isin(sub_names) | res_files["relative_path"].isin(extra_paths)
                ]
                match_rows.append({
                    "facility_code": fcode,
                    "facility": fname,
                    "region": r["region"],
                    "province": r["province"],
                    "category": r["category"],
                    "status": r["status"],
                    "resource_code": code,
                    "resource_n_facilities": n_facs,
                    "match_type": "shared_subfolder_match",
                    "match_confidence": round(best_sc, 3),
                    "matched_subfolders": "; ".join(sub_names),
                    "matched_file_count": int(len(all_matched)),
                    "matched_mb": round(all_matched["bytes"].sum() / 1e6, 2),
                    "sample_files": " | ".join(all_matched["relative_path"].head(4).tolist()),
                    "needs_review": best_sc < 0.72,
                })
            elif matched_file_rows:
                matched_file_rows.sort(key=lambda x: -x[1])
                best_sc = matched_file_rows[0][1]
                kept_files = [x for x in matched_file_rows if x[1] >= max(0.58, best_sc - 0.15)]
                paths = [x[0] for x in kept_files]
                sub_set = sorted({str(Path(p).parent) if str(Path(p).parent) != "." else "(root)" for p in paths})
                match_rows.append({
                    "facility_code": fcode,
                    "facility": fname,
                    "region": r["region"],
                    "province": r["province"],
                    "category": r["category"],
                    "status": r["status"],
                    "resource_code": code,
                    "resource_n_facilities": n_facs,
                    "match_type": "shared_filename_match",
                    "match_confidence": round(best_sc, 3),
                    "matched_subfolders": "; ".join(sub_set),
                    "matched_file_count": len(paths),
                    "matched_mb": round(sum(x[2] for x in kept_files) / 1e6, 2),
                    "sample_files": " | ".join(paths[:4]),
                    "needs_review": best_sc < 0.75,
                })
            else:
                # Check if this shared resource is a flat co-located compound (no subfolders)
                # or an LGU/agency bundle with umbrella root documents
                is_flat_compound = len(leaf_subs) == 0 and len(res_files) > 0
                root_files = res_files[res_files["subfolder"].isna() | (res_files["subfolder"] == "")]
                if is_flat_compound:
                    match_rows.append({
                        "facility_code": fcode,
                        "facility": fname,
                        "region": r["region"],
                        "province": r["province"],
                        "category": r["category"],
                        "status": r["status"],
                        "resource_code": code,
                        "resource_n_facilities": n_facs,
                        "match_type": "shared_compound_bundle",
                        "match_confidence": 0.85,
                        "matched_subfolders": "(root)",
                        "matched_file_count": int(len(res_files)),
                        "matched_mb": round(res_files["bytes"].sum() / 1e6, 2),
                        "sample_files": " | ".join(res_files["relative_path"].head(4).tolist()),
                        "needs_review": False,
                    })
                elif len(root_files) > 0 and len(leaf_subs) <= 4:
                    # LGU/agency-wide umbrella docs (e.g. Valenzuela/Caloocan/Navotas/BOQ) without a facility-named file
                    match_rows.append({
                        "facility_code": fcode,
                        "facility": fname,
                        "region": r["region"],
                        "province": r["province"],
                        "category": r["category"],
                        "status": r["status"],
                        "resource_code": code,
                        "resource_n_facilities": n_facs,
                        "match_type": "shared_umbrella_docs_only",
                        "match_confidence": 0.5,
                        "matched_subfolders": "(root umbrella)",
                        "matched_file_count": int(len(root_files)),
                        "matched_mb": round(root_files["bytes"].sum() / 1e6, 2),
                        "sample_files": " | ".join(root_files["relative_path"].head(4).tolist()),
                        "needs_review": True,
                    })
                else:
                    match_rows.append({
                        "facility_code": fcode,
                        "facility": fname,
                        "region": r["region"],
                        "province": r["province"],
                        "category": r["category"],
                        "status": r["status"],
                        "resource_code": code,
                        "resource_n_facilities": n_facs,
                        "match_type": "shared_unmatched",
                        "match_confidence": 0.0,
                        "matched_subfolders": "",
                        "matched_file_count": 0,
                        "matched_mb": 0.0,
                        "sample_files": "",
                        "needs_review": True,
                    })

        # Emit subfolder detail for this shared resource
        for _, sf in leaf_subs.iterrows():
            cands = sorted(sub_to_facs.get(sf["subfolder"], []), key=lambda x: -x[2])
            shared_detail_rows.append({
                "resource_code": code,
                "subfolder": sf["subfolder"],
                "leaf_name": sf["leaf_name"],
                "direct_files": int(sf["direct_files"]),
                "mb": round(sf["total_bytes_under"] / 1e6, 2),
                "matched_facility_count": len(cands),
                "best_facility_code": cands[0][0] if cands else "",
                "best_facility_name": cands[0][1] if cands else "",
                "best_score": cands[0][2] if cands else 0.0,
                "all_matches": " | ".join(f"{fc}:{fn} ({sc})" for fc, fn, sc in cands[:4]),
            })

    match_df = pd.DataFrame(match_rows).sort_values(["resource_code", "facility_code"])
    detail_df = pd.DataFrame(shared_detail_rows).sort_values(["resource_code", "subfolder"])

    match_df.to_csv(CSV_DIR / "facility_download_match.csv", index=False)
    detail_df.to_csv(CSV_DIR / "shared_subfolder_match_detail.csv", index=False)

    print("=== FACILITY MATCH SUMMARY (263 downloaded facilities) ===")
    print(match_df["match_type"].value_counts().to_string())
    print(f"\nNeeds manual review: {int(match_df['needs_review'].sum())} / {len(match_df)}")

    print("\n=== SHARED RESOURCES BREAKDOWN (15 resources, 98 facilities) ===")
    sh = match_df[match_df["resource_n_facilities"] > 1]
    piv = pd.crosstab(sh["resource_code"], sh["match_type"], margins=True)
    print(piv.to_string())

    print("\n=== UNMATCHED FACILITIES IN SHARED RESOURCES ===")
    unm = sh[sh["match_type"] == "shared_unmatched"]
    if len(unm):
        print(unm[["resource_code", "facility_code", "province", "facility"]].to_string(index=False))
    else:
        print("None!")

    print(f"\n=== SHARED SUBFOLDERS: {len(detail_df)} leaf subfolders across shared resources ===")
    print(f"  Matched to a COMP-FINAL facility: {(detail_df['matched_facility_count'] > 0).sum()}")
    print(f"  Extra / unmatched subfolders:     {(detail_df['matched_facility_count'] == 0).sum()}")


if __name__ == "__main__":
    main()
