#!/usr/bin/env python3
"""Download HFEP Drive resources via authenticated rclone, then zip each folder.

Requires a working rclone remote (default: hfep) with Google Drive OAuth.

Examples:
  python scripts/download_with_rclone.py --limit 3
  python scripts/download_with_rclone.py --resource RES-0003 RES-0004
  python scripts/download_with_rclone.py --status public          # default
  python scripts/download_with_rclone.py --status public,auth_required
  python scripts/download_with_rclone.py --no-zip                 # keep unpacked only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INVENTORY = ROOT / "data" / "csv" / "link_inventory.csv"
DEFAULT_OUT = ROOT / "downloads"
MANIFEST_NAME = "manifest_rclone.json"
RCLONE_BIN = os.environ.get("RCLONE_BIN", str(Path.home() / ".local/bin/rclone"))


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
    return {"version": 1, "generated_at": None, "remote": None, "resources": []}


def save_manifest(out_dir: Path, manifest: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest["generated_at"] = now_iso()
    path = out_dir / MANIFEST_NAME
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def find_entry(manifest: dict, code: str) -> dict | None:
    for item in manifest["resources"]:
        if item.get("resource_code") == code:
            return item
    return None


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=check, text=True, capture_output=True)


def rclone_ok(remote: str) -> None:
    bin_path = Path(RCLONE_BIN)
    if not bin_path.exists():
        raise SystemExit(f"rclone not found at {bin_path}. Set RCLONE_BIN or install rclone.")
    # lightweight probe
    proc = run([str(bin_path), "about", f"{remote}:"], check=False)
    if proc.returncode != 0:
        raise SystemExit(
            f"rclone remote '{remote}' not usable:\n{proc.stderr or proc.stdout}\n"
            "Fix auth first (rclone authorize / config)."
        )


def zip_directory(src_dir: Path, zip_path: Path) -> dict:
    if zip_path.exists():
        zip_path.unlink()
    count = 0
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for path in sorted(src_dir.rglob("*")):
            if path.is_file():
                zf.write(path, arcname=str(path.relative_to(src_dir)))
                count += 1
    return {
        "zip_path": zip_path.name,
        "zip_bytes": zip_path.stat().st_size,
        "zip_sha256": sha256_file(zip_path),
        "zip_file_count": count,
    }


def count_files(dir_path: Path) -> int:
    if not dir_path.exists():
        return 0
    return sum(1 for p in dir_path.rglob("*") if p.is_file())


def download_folder(remote: str, folder_id: str, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    cmd = [
        RCLONE_BIN,
        "copy",
        f"--drive-root-folder-id={folder_id}",
        f"{remote}:",
        str(dest),
        "--create-empty-src-dirs",
        "--drive-skip-dangling-shortcuts",
        "--transfers=4",
        "--checkers=8",
        "--retries=5",
        "--low-level-retries=10",
        "--stats=30s",
        "--stats-one-line",
    ]
    proc = subprocess.run(cmd, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"rclone copy failed (exit {proc.returncode}) for folder_id={folder_id}")


def download_file(remote: str, file_id: str, dest: Path) -> None:
    """Copy a single Drive file id into dest/ using backend copyid.

    Falls back to download_folder if the ID resolves to a directory (common for open?id= links).
    """
    dest.mkdir(parents=True, exist_ok=True)
    # copyid syntax: rclone backend copyid remote: ID dest/
    # dest must end with / to keep original filename
    dest_arg = str(dest) + "/"
    cmd = [
        RCLONE_BIN,
        "backend",
        "copyid",
        f"{remote}:",
        file_id,
        dest_arg,
    ]
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        err_text = (proc.stderr or "") + (proc.stdout or "")
        if "can't copyid directory" in err_text:
            download_folder(remote, file_id, dest)
            return
        raise RuntimeError(
            f"rclone copyid failed for file_id={file_id}: {proc.stderr or proc.stdout}"
        )


def process_resource(row: dict, out_dir: Path, manifest: dict, args: argparse.Namespace) -> dict:
    code = row["resource_code"]
    kind = row["resource_kind"]
    rid = str(row.get("resource_id") or "")
    url = row.get("canonical_url")
    dest = out_dir / code
    zip_path = out_dir / f"{code}.zip"

    existing = find_entry(manifest, code)
    if (
        existing
        and existing.get("status") == "downloaded"
        and not args.force
        and (zip_path.exists() if not args.no_zip else count_files(dest) > 0)
    ):
        print(f"  SKIP {code} (already downloaded)")
        return existing

    entry = {
        "resource_code": code,
        "resource_kind": kind,
        "resource_id": rid,
        "source_url": url,
        "access_status": row.get("access_status"),
        "local_dir": code,
        "status": "pending",
        "error": None,
        "downloaded_at": None,
        "file_count": 0,
    }

    try:
        if args.force and dest.exists():
            shutil.rmtree(dest)
        if args.force and zip_path.exists():
            zip_path.unlink()

        if kind == "folder":
            if not rid:
                raise RuntimeError("missing folder resource_id")
            download_folder(args.remote, rid, dest)
        elif kind in ("file", "open_id"):
            if not rid:
                raise RuntimeError("missing file resource_id")
            download_file(args.remote, rid, dest)
        elif kind == "spreadsheet":
            # Sheets: export via rclone with drive export formats into dest
            dest.mkdir(parents=True, exist_ok=True)
            # Use copyid; rclone exports Google Docs formats when downloading
            download_file(args.remote, rid, dest)
        else:
            raise RuntimeError(f"unsupported kind={kind}")

        n = count_files(dest)
        if n == 0:
            raise RuntimeError("no files downloaded")

        entry["file_count"] = n
        if not args.no_zip:
            zinfo = zip_directory(dest, zip_path)
            entry.update(zinfo)
            if args.keep_unpacked is False:
                shutil.rmtree(dest)
                entry["local_dir"] = None

        entry["status"] = "downloaded"
        entry["downloaded_at"] = now_iso()
        print(f"  OK   {code} → {n} file(s)" + (f" + {zip_path.name}" if not args.no_zip else ""))
    except Exception as exc:  # noqa: BLE001
        n = count_files(dest)
        entry["error"] = f"{type(exc).__name__}: {exc}"
        entry["downloaded_at"] = now_iso()
        entry["file_count"] = n
        if n > 0:
            entry["status"] = "partial"
            if not args.no_zip:
                try:
                    zinfo = zip_directory(dest, zip_path)
                    entry.update(zinfo)
                except Exception as zexc:  # noqa: BLE001
                    entry["error"] += f" | zip failed: {zexc}"
            print(f"  PARTIAL {code} → {n} file(s); {entry['error'][:200]}")
        else:
            entry["status"] = "error"
            print(f"  FAIL {code}: {entry['error']}")

    resources = manifest["resources"]
    for i, item in enumerate(resources):
        if item.get("resource_code") == code:
            resources[i] = entry
            break
    else:
        resources.append(entry)
    return entry


def select_rows(df: pd.DataFrame, args: argparse.Namespace) -> pd.DataFrame:
    statuses = {s.strip() for s in args.status.split(",") if s.strip()}
    q = df[df["access_status"].isin(statuses)].copy()
    kinds = args.kinds or ["folder", "file", "open_id"]
    q = q[q["resource_kind"].isin(kinds)]
    if args.resource:
        wanted = set(args.resource)
        q = q[q["resource_code"].isin(wanted)]
        missing = wanted - set(q["resource_code"])
        if missing:
            print(f"WARNING: not in selected status/kinds: {sorted(missing)}", file=sys.stderr)
    q = q.sort_values(["resource_kind", "resource_code"])
    if args.limit is not None:
        q = q.head(args.limit)
    return q


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--remote", default="hfep", help="rclone remote name")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--resource", nargs="+", default=None)
    parser.add_argument(
        "--status",
        default="public",
        help="Comma list from inventory access_status (public,auth_required,...)",
    )
    parser.add_argument(
        "--kinds",
        nargs="+",
        choices=["folder", "file", "open_id", "spreadsheet"],
        default=None,
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-zip", action="store_true", help="Do not create RES-####.zip")
    parser.add_argument(
        "--keep-unpacked",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Keep unpacked RES-####/ dir after zipping (default: keep)",
    )
    parser.add_argument("--sleep", type=float, default=0.5)
    args = parser.parse_args(argv)

    if not args.inventory.exists():
        print(f"Missing inventory: {args.inventory}", file=sys.stderr)
        return 1

    rclone_ok(args.remote)
    df = pd.read_csv(args.inventory)
    rows = select_rows(df, args)
    if rows.empty:
        print("No matching resources.")
        return 0

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest(args.out)
    manifest["remote"] = args.remote
    print(f"Downloading {len(rows)} resource(s) via rclone remote '{args.remote}' → {args.out}")

    ok = partial = fail = skip = 0
    for _, row in rows.iterrows():
        before = find_entry(manifest, row["resource_code"])
        entry = process_resource(row.to_dict(), args.out, manifest, args)
        save_manifest(args.out, manifest)
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
