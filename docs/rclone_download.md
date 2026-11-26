# HFEP Drive downloads via rclone (authenticated)

Authenticated Google Drive downloads for HFEP documentary links. Each inventory resource is fetched into `downloads/RES-####/` and zipped as `downloads/RES-####.zip`. Progress is tracked in `downloads/manifest_rclone.json` and is resume-safe.

Project overview: [`../README.md`](../README.md).  
Budget CSVs, link inventory, and HTTP probes: [`data_and_links.md`](data_and_links.md).

Unauthenticated `gdown` (`scripts/download_public_resources.py`) remains available for public-only experiments, but **rclone is the preferred path**.

## Prerequisites

- `rclone` on `PATH` (project setup uses `~/.local/bin/rclone`)
- Python deps: `pandas` (already used by inventory scripts)
- Google account that can open the HFEP Drive folders/files

```bash
export PATH="$HOME/.local/bin:$PATH"
rclone version
```

## One-time Google authentication

### 1. Authorize

```bash
export PATH="$HOME/.local/bin:$PATH"
rclone authorize "drive"
```

1. Open the URL rclone prints.
2. Sign in with the Google account that has access to the HFEP docs.
3. Approve Drive access.
4. Copy the **entire token JSON** rclone prints. It must look like:

```json
{"access_token":"ya29....","token_type":"Bearer","refresh_token":"1//....","expiry":"2026-..."}
```

It must start with `{` and end with `}`. A bare `ya29...` string will **not** work.

### 2. Create the `hfep` remote

```bash
rclone config delete hfep   # only if recreating
rclone config create hfep drive \
  scope=drive.readonly \
  config_is_local=false
```

If the token was not picked up interactively:

```bash
rclone config update hfep token='{"access_token":"...","token_type":"Bearer","refresh_token":"...","expiry":"..."}'
```

Use single quotes around the JSON.

### 3. Verify

```bash
rclone lsd hfep:
rclone about hfep:
```

Expected: folder listing and quota summary without `invalid character` / oauth errors.

Config file location: `~/.config/rclone/rclone.conf`  
(Do not commit this file; it contains secrets.)

### Common auth errors

| Symptom | Cause | Fix |
|---|---|---|
| `invalid character 'y' looking for beginning of value` | Token saved as bare `ya29...` instead of JSON | Re-run `rclone authorize` and set the full JSON token |
| `Failed to create file system for "hfep:"` | Missing/broken remote | Recreate with steps above |
| NOTICE about shared `client_id` retiring in 2026 | rclone default OAuth client | Optional later: create your own client ID per [rclone Drive docs](https://rclone.org/drive/#making-your-own-client-id) |

## Inventory inputs

Built earlier from `COMP-FINAL`:

| File | Role |
|---|---|
| `data/csv/link_inventory.csv` | Unique Drive/Docs resources (`RES-####`), kind, URL, `access_status` |
| `data/csv/facility_link_map.csv` | Facilities (`FAC-####`) → `RES-####` |
| `data/csv/links_needing_action_by_resource.csv` | auth_required / no_url / not_found for owners |

`access_status` values used by the downloader:

- `public` — reachable without login in probes (still use rclone)
- `auth_required` — needs a Google account with access
- `no_url` / `not_found` — skip; fix upstream links first

## Download script

```bash
cd /path/to/HFEP
export PATH="$HOME/.local/bin:$PATH"

# smoke test
python3 scripts/download_with_rclone.py --resource RES-0003 --force

# first N public folders/files
python3 scripts/download_with_rclone.py --limit 10

# all public folders + files + open_id (default kinds)
python3 scripts/download_with_rclone.py

# also try links that need auth (if your account has access)
python3 scripts/download_with_rclone.py --status public,auth_required

# folders only, keep unpacked dirs + zips
python3 scripts/download_with_rclone.py --kinds folder

# zip only (delete unpacked after zip)
python3 scripts/download_with_rclone.py --no-keep-unpacked
```

### Useful flags

| Flag | Meaning |
|---|---|
| `--remote hfep` | rclone remote name (default `hfep`) |
| `--status public` | Inventory filter (comma list) |
| `--kinds folder file open_id spreadsheet` | Resource kinds |
| `--resource RES-0003 ...` | Explicit codes |
| `--limit N` | Cap batch size |
| `--force` | Re-download even if manifest says done |
| `--no-zip` | Skip creating `RES-####.zip` |
| `--keep-unpacked` / `--no-keep-unpacked` | Keep or remove `downloads/RES-####/` after zip (default: keep) |
| `--sleep 0.5` | Pause between resources |

### What rclone does for folders

There is **no stable public “folder as one Drive zip” API**. rclone:

1. Treats the folder ID as root (`--drive-root-folder-id`)
2. Copies all nested files into `downloads/RES-####/`
3. The script then builds `downloads/RES-####.zip` locally (zip64)

So you still get **one archive per resource**, created after a reliable authenticated recursive copy.

## Outputs

```text
downloads/
  RES-0003/                 # unpacked files (if kept)
  RES-0003.zip              # archive
  RES-0155/
  RES-0155.zip
  manifest_rclone.json      # resume + provenance
  download.log              # optional if you redirect stdout
```

### Manifest (`manifest_rclone.json`)

Per resource roughly:

- `resource_code`, `resource_kind`, `resource_id`, `source_url`
- `status`: `downloaded` | `partial` | `error`
- `file_count`, `zip_path`, `zip_bytes`, `zip_sha256`
- `error` when failed/partial

## Resume behavior

Re-run the same command anytime:

- **`downloaded`** + zip/files present → **skipped**
- **`partial` / `error` / missing** → **retried** (rclone copy is incremental; existing files are not re-transferred unless `--force`)
- `--force` deletes local `RES-####/` and `.zip` then re-fetches

Background example:

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /path/to/HFEP
nohup python3 -u scripts/download_with_rclone.py --status public \
  > downloads/download_rclone.log 2>&1 &
tail -f downloads/download_rclone.log
```

## Manual one-off rclone commands

```bash
# list a folder by ID
rclone lsf --drive-root-folder-id=FOLDER_ID hfep:

# copy a folder by ID
rclone copy --drive-root-folder-id=FOLDER_ID hfep: ./downloads/RES-XXXX/ \
  --create-empty-src-dirs -P

# copy a single file by ID
rclone backend copyid hfep: FILE_ID ./downloads/RES-XXXX/
```

## Suggested rollout

1. Auth verified (`rclone lsd hfep:`).
2. Smoke: `--resource RES-0003 --force`.
3. Batch public folders: `python3 scripts/download_with_rclone.py`.
4. After owners fix sharing, retry `--status auth_required` (and `--kinds spreadsheet` if needed).
5. Join docs back to projects via `facility_link_map.csv` (`FAC-####` → `RES-####`).

## Security notes

- Do not commit `~/.config/rclone/rclone.conf` or tokens.
- `downloads/` is gitignored.
- Prefer `scope=drive.readonly` (already used) so the remote cannot write to Drive.
