# Architecture & Codebase Guide

This document describes the runtime architecture, SQLite schema, API endpoints, and frontend routing for **HFEP 2027 — Facilities Explorer & Validator**.

## Overview

```text
Browser (http://127.0.0.1:5177 or https://hfep.simple-systems.dev)
  │
  ▼
Vite Dev Server (web/, port 5177)
  ├── Static React 19 + TypeScript SPA
  └── Proxy: /api/* and /local-files/* ──▶ Node.js + SQLite Backend (server/index.mjs, port 8787)
                                              ├── data/json/facilities_catalog.json
                                              ├── data/json/resources_catalog.json
                                              ├── data/hfep_validator.sqlite (users, sessions, validations, audit_logs)
                                              └── downloads/ (local PDFs, images, ZIPs)
```

## Backend (`server/index.mjs`)

- **Runtime**: Node.js 26+ using built-in `node:http`, `node:crypto`, and `node:sqlite` (`DatabaseSync`) — zero third-party npm dependencies.
- **Port**: `8787` (override via `PORT` env var).
- **Database**: `data/hfep_validator.sqlite` (gitignored, WAL mode enabled).

### SQLite Schema

| Table | Purpose |
|---|---|
| `users` | Reviewer accounts (`id`, `username`, `display_name`, `role`, salted `scrypt` `password_hash`, `created_at`). Seeds default `admin` / `admin123` (override via `HFEP_ADMIN_PASSWORD`) on first boot. |
| `sessions` | Opaque random tokens stored in `HttpOnly; SameSite=Lax` cookie `hfep_session` (14-day TTL). |
| `validations` | Current validation state per `facility_code` (`status`, `checklist_json`, `note`, `updated_at`, `updated_by`). Auto-migrates legacy `data/json/validations.json` if present. |
| `audit_logs` | Append-only event log (`timestamp`, `user_id`, `username`, `action`, `facility_code`, `before_json`, `after_json`, `ip`) recording `login`, `logout`, `register`, `validation_update`, and `validation_clear`. |

### HTTP API Endpoints

| Method & Path | Auth | Description |
|---|---|---|
| `GET /api/auth/me` | Public | Returns `{ user }` or `{ user: null }` |
| `POST /api/auth/login` | Public | Authenticates `{ username, password }` and sets `hfep_session` cookie |
| `POST /api/auth/register` | Public | Creates a new reviewer account and signs in |
| `POST /api/auth/logout` | Public | Revokes session and clears cookie |
| `GET /api/facilities` | Public | Serves `data/json/facilities_catalog.json` |
| `GET /api/resources` | Public | Serves `data/json/resources_catalog.json` |
| `GET /api/validations` | Public | Returns all saved validations keyed by `facility_code` |
| `POST /api/validations` | **Required** | Upserts or clears a validation record (`401` if unauthenticated) and appends to `audit_logs` |
| `GET /api/validations/export.csv` | Public | Downloads all saved validations as CSV |
| `GET /api/audit-logs` | Public | Lists recent audit entries (supports `?facility_code=FAC-####&limit=50`) |
| `GET\|HEAD /local-files/*` | Public | Streams local files from `downloads/` with path-traversal protection and inline PDF/image headers |

## Frontend (`web/`)

- **Stack**: React 19, TypeScript, Vite 6 (pinned to port `5177` with `strictPort: true`).
- **Components**:
  - `web/src/App.tsx` — Shell, topbar, auth & audit-log modals, URL routing, and the 3-column **Explorer** (facilities list, details/budget/documents, validator + inline PDF/image viewer).
  - `web/src/PendingView.tsx` — **Pending** tab with **By Facility** / **By Pending Source** toggle, allocation source & reason filters, and CSV export.
  - `web/src/StatsView.tsx` — **Statistics** tab showing coverage, document types, match methods, resource kinds, validation progress, allocation sources, regions, and categories.
  - `web/src/AboutView.tsx` — **About** tab summarizing data sources, coverage, caveats, and validation workflow.
  - `web/src/allocFilter.ts` — Shared budget allocation source filter options (`NEP Only`, `HGAB Only`, `Senate Only`, combinations, and `All X funded`) and live count helper.
  - `web/src/types.ts` — Shared TypeScript interfaces.

### URL Routes & Query Parameters

| Route | View | Supported Query Params |
|---|---|---|
| `/` (or `/explorer`) | Explorer | `q`, `region`, `budget`, `download`, `validation`, `alloc`, `facility` |
| `/pending` | Pending | `view=source`, `q`, `reason`, `region`, `alloc` |
| `/statistics` (or `/stats`) | Statistics | — |
| `/about` | About | — |

## Data Pipeline (`scripts/`)

1. Extract & verify workbook links → `data/csv/*.csv` (documented in [`docs/data_and_links.md`](data_and_links.md)).
2. Download accessible Google Drive resources via `rclone` → `downloads/RES-####/` + `downloads/RES-####.zip` (`scripts/download_with_rclone.py`, documented in [`docs/rclone_download.md`](rclone_download.md)).
3. Match downloaded subfolders/files back to facilities → `scripts/match_downloads_to_facilities.py`.
4. Build unified JSON catalogs for the web app → `scripts/build_json_catalogs.py` → `data/json/facilities_catalog.json` and `data/json/resources_catalog.json`.
