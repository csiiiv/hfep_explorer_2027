#!/usr/bin/env python3
"""Download public HFEP Drive resources into downloads/RES-####/.

Reads data/csv/link_inventory.csv, downloads access_status=public resources
(folders + files), and writes a resume-safe manifest.json.

Conceptual model adapted from philgeps_data_v2 RAW_DATA_DOWNLOADER:
parse → classify → download → hash → record status; failures don't abort the batch.

Examples:
  # smoke test: 3 public resources
  python scripts/download_public_resources.py --limit 3

  # specific codes
  python scripts/download_public_resources.py --resource RES-0003 RES-0155 RES-0001

  # all public folders + files
  python scripts/download_public_resources.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import gdown
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INVENTORY = ROOT / "data" / "csv" / "link_inventory.csv"
DEFAULT_OUT = ROOT / "downloads"
MANIFEST_NAME = "manifest.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest(out_dir: Path) -> dict:
    path = out_dir / MANIFEST_NAME
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {
        "version": 1,
        "generated_at": None,
        "inventory": str(DEFAULT_INVENTORY),
        "resources": [],
    }


def save_manifest(out_dir: Path, manifest: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest["generated_at"] = now_iso()
    path = out_dir / MANIFEST_NAME
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def find_entry(manifest: dict, resource_code: str) -> dict | None:
    for item in manifest["resources"]:
        if item.get("resource_code") == resource_code:
            return item
    return None


def list_files(dir_path: Path) -> list[dict]:
    files = []
    if not dir_path.exists():
        return files
    for p in sorted(dir_path.rglob("*")):
        if p.is_file():
            rel = str(p.relative_to(dir_path)).replace("\\", "/")
            files.append(
                {
                    "relative_path": rel,
                    "bytes": p.stat().st_size,
                    "sha256": sha256_file(p),
                }
            )
    return files


def download_folder(url: str, dest: Path) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    # gdown writes into output/; if folder already has nested Drive title dir, that's ok
    result = gdown.download_folder(
        url=url,
        output=str(dest),
        quiet=False,
        use_cookies=False,
        resume=True,
    )
    if result is None:
        raise RuntimeError("gdown.download_folder returned None (folder empty, private, or failed)")
    return [str(x) for x in result]


def download_file(file_id: str, dest: Path, filename_hint: str | None = None) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    # Let gdown choose the name from Content-Disposition when possible
    out = str(dest / (filename_hint or ""))
    path = gdown.download(
        id=file_id,
        output=out if filename_hint else str(dest) + "/",
        quiet=False,
        resume=True,
    )
    if not path:
        raise RuntimeError(f"gdown.download failed for id={file_id}")
    return Path(path)


def process_resource(row: dict, out_dir: Path, manifest: dict, force: bool) -> dict:
    code = row["resource_code"]
    kind = row["resource_kind"]
    url = row["canonical_url"]
    rid = row.get("resource_id")
    dest = out_dir / code

    existing = find_entry(manifest, code)
    if existing and existing.get("status") == "downloaded" and not force:
        files = list_files(dest)
        if files:
            existing["files"] = files
            existing["file_count"] = len(files)
            print(f"  SKIP {code} (already downloaded, {len(files)} file(s))")
            return existing

    entry = {
        "resource_code": code,
        "resource_kind": kind,
        "resource_id": rid,
        "source_url": url,
        "local_dir": code,
        "n_facilities": int(row.get("n_facilities") or 0),
        "status": "pending",
        "error": None,
        "downloaded_at": None,
        "file_count": 0,
        "files": [],
    }

    try:
        if dest.exists() and force:
            shutil.rmtree(dest)

        if kind == "folder":
            download_folder(url, dest)
        elif kind in ("file", "open_id"):
            if not rid:
                raise RuntimeError("missing resource_id for file/open_id")
            download_file(str(rid), dest)
        elif kind == "spreadsheet":
            raise RuntimeError("spreadsheet downloads deferred (auth_required in inventory)")
        else:
            raise RuntimeError(f"unsupported resource_kind={kind}")

        files = list_files(dest)
        if not files:
            raise RuntimeError("download reported success but no files found on disk")

        entry["status"] = "downloaded"
        entry["downloaded_at"] = now_iso()
        entry["files"] = files
        entry["file_count"] = len(files)
        print(f"  OK   {code} → {len(files)} file(s)")
    except Exception as exc:  # noqa: BLE001 - record and continue
        files = list_files(dest)
        entry["downloaded_at"] = now_iso()
        entry["error"] = f"{type(exc).__name__}: {exc}"
        if files:
            # Folder often partially succeeds: some nested files are private/rate-limited
            entry["status"] = "partial"
            entry["files"] = files
            entry["file_count"] = len(files)
            print(f"  PARTIAL {code} → {len(files)} file(s); {entry['error'][:180]}")
        else:
            entry["status"] = "error"
            entry["files"] = []
            entry["file_count"] = 0
            print(f"  FAIL {code}: {entry['error']}")

    # upsert into manifest
    resources = manifest["resources"]
    for i, item in enumerate(resources):
        if item.get("resource_code") == code:
            resources[i] = entry
            break
    else:
        resources.append(entry)
    return entry


def select_rows(df: pd.DataFrame, args: argparse.Namespace) -> pd.DataFrame:
    q = df[df["access_status"] == "public"].copy()
    if args.kinds:
        q = q[q["resource_kind"].isin(args.kinds)]
    else:
        # default: folders + files only (sheets need auth)
        q = q[q["resource_kind"].isin(["folder", "file", "open_id"])]
    if args.resource:
        wanted = set(args.resource)
        q = q[q["resource_code"].isin(wanted)]
        missing = wanted - set(q["resource_code"])
        if missing:
            print(f"WARNING: not public / not found: {sorted(missing)}", file=sys.stderr)
    q = q.sort_values(["resource_kind", "resource_code"])
    if args.limit is not None:
        q = q.head(args.limit)
    return q


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--limit", type=int, default=None, help="Max resources to process")
    parser.add_argument("--resource", nargs="+", default=None, help="Specific RES-#### codes")
    parser.add_argument(
        "--kinds",
        nargs="+",
        choices=["folder", "file", "open_id", "spreadsheet"],
        default=None,
    )
    parser.add_argument("--force", action="store_true", help="Re-download even if present")
    parser.add_argument("--sleep", type=float, default=0.5, help="Pause between resources")
    args = parser.parse_args(argv)

    if not args.inventory.exists():
        print(f"Inventory not found: {args.inventory}", file=sys.stderr)
        return 1

    df = pd.read_csv(args.inventory)
    rows = select_rows(df, args)
    if rows.empty:
        print("No matching public resources.")
        return 0

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest(args.out)
    print(f"Downloading {len(rows)} resource(s) → {args.out}")

    ok = partial = fail = skip = 0
    for _, row in rows.iterrows():
        before = find_entry(manifest, row["resource_code"])
        entry = process_resource(row.to_dict(), args.out, manifest, force=args.force)
        save_manifest(args.out, manifest)  # incremental
        if entry["status"] == "downloaded":
            if before and before.get("status") == "downloaded" and not args.force:
                skip += 1
            else:
                ok += 1
        elif entry["status"] == "partial":
            partial += 1
        else:
            fail += 1
        if args.sleep:
            time.sleep(args.sleep)

    print(
        f"\nDone. downloaded={ok} partial={partial} skipped={skip} failed={fail} "
        f"manifest={args.out / MANIFEST_NAME}"
    )
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
