#!/usr/bin/env node
/**
 * HFEP 2027 Local Backend Server (Node 22+/26 built-in node:sqlite, zero deps)
 *
 * Serves:
 *   - /api/auth/{me,login,register,logout}
 *   - /api/facilities, /api/resources
 *   - /api/validations (GET, POST auth-gated), /api/validations/export.csv
 *   - /api/audit-logs (GET, optional ?facility_code=FAC-XXXX&limit=50)
 *   - /local-files/* (streams downloads/ PDFs, images, ZIPs)
 *   - Optional static web/dist when SERVE_STATIC=1
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const JSON_DIR = path.join(DATA_DIR, "json");
const DOWNLOADS_DIR = path.join(REPO_ROOT, "downloads");
const DB_PATH = path.join(DATA_DIR, "hfep_validator.sqlite");
const LEGACY_VALIDATIONS_JSON = path.join(JSON_DIR, "validations.json");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const COOKIE_NAME = "hfep_session";
const SESSION_DAYS = 14;

const MIME_TYPES = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hex, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// SQLite initialization
// ---------------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'reviewer',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS validations (
    facility_code TEXT PRIMARY KEY,
    status TEXT,
    checklist_json TEXT NOT NULL DEFAULT '{}',
    note TEXT NOT NULL DEFAULT '',
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id),
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    facility_code TEXT,
    before_json TEXT,
    after_json TEXT,
    ip TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_facility ON audit_logs(facility_code, id DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(id DESC);
`);

function nowIso() {
  return new Date().toISOString();
}

// Seed default admin account if no users exist yet
const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
if (userCount === 0) {
  const defaultPass = process.env.HFEP_ADMIN_PASSWORD || "admin123";
  db.prepare(
    "INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run("admin", "Admin Reviewer", "admin", hashPassword(defaultPass), nowIso());
  console.log(`[hfep-server] Seeded default user: username="admin" password="${defaultPass}"`);
}

// Migrate legacy validations.json if SQLite validations table is empty
const valCount = db.prepare("SELECT COUNT(*) AS n FROM validations").get().n;
if (valCount === 0 && fs.existsSync(LEGACY_VALIDATIONS_JSON)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_VALIDATIONS_JSON, "utf-8"));
    const adminRow = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get();
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO validations (facility_code, status, checklist_json, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    let migrated = 0;
    for (const [fcode, rec] of Object.entries(legacy)) {
      if (!rec || typeof rec !== "object") continue;
      stmt.run(
        fcode,
        rec.status ?? null,
        JSON.stringify(rec.checklist || {}),
        String(rec.note || ""),
        adminRow?.id ?? null,
        rec.updated_at || nowIso()
      );
      migrated++;
    }
    if (migrated > 0) {
      console.log(`[hfep-server] Migrated ${migrated} record(s) from validations.json into SQLite.`);
    }
  } catch (err) {
    console.warn("[hfep-server] Could not migrate legacy validations.json:", err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    token,
  };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const created = nowIso();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token,
    userId,
    created,
    expires
  );
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
  return { token, cookie };
}

function writeAudit({ user, action, facilityCode = null, before = null, after = null, ip = "" }) {
  db.prepare(
    `INSERT INTO audit_logs (timestamp, user_id, username, action, facility_code, before_json, after_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nowIso(),
    user?.id ?? null,
    user?.username ?? "anonymous",
    action,
    facilityCode,
    before !== null ? JSON.stringify(before) : null,
    after !== null ? JSON.stringify(after) : null,
    ip
  );
}

function getAllValidationsMap() {
  const rows = db
    .prepare(
      `SELECT v.facility_code, v.status, v.checklist_json, v.note, v.updated_at,
              u.username AS updated_by_username, u.display_name AS updated_by_name
       FROM validations v
       LEFT JOIN users u ON u.id = v.updated_by`
    )
    .all();
  const map = {};
  for (const r of rows) {
    let checklist = {};
    try {
      checklist = JSON.parse(r.checklist_json || "{}");
    } catch {
      checklist = {};
    }
    map[r.facility_code] = {
      status: r.status || null,
      checklist,
      note: r.note || "",
      updated_at: r.updated_at,
      updated_by_username: r.updated_by_username || null,
      updated_by_name: r.updated_by_name || null,
    };
  }
  return map;
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// HTTP Request Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const urlPath = parsed.pathname;
    const method = req.method || "GET";
    const ip = getClientIp(req);

    // --- Auth routes ---
    if (urlPath === "/api/auth/me" && method === "GET") {
      const user = getSessionUser(req);
      return sendJson(res, 200, {
        user: user
          ? { id: user.id, username: user.username, display_name: user.display_name, role: user.role }
          : null,
      });
    }

    if (urlPath === "/api/auth/login" && method === "POST") {
      const { username, password } = await readJsonBody(req);
      if (!username || !password) {
        return sendJson(res, 400, { error: "Username and password are required." });
      }
      const row = db
        .prepare("SELECT id, username, display_name, role, password_hash FROM users WHERE username = ?")
        .get(String(username).trim());
      if (!row || !verifyPassword(String(password), row.password_hash)) {
        return sendJson(res, 401, { error: "Invalid username or password." });
      }
      const { cookie } = createSession(row.id);
      const user = { id: row.id, username: row.username, display_name: row.display_name, role: row.role };
      writeAudit({ user, action: "login", ip });
      return sendJson(res, 200, { user }, { "Set-Cookie": cookie });
    }

    if (urlPath === "/api/auth/register" && method === "POST") {
      const { username, display_name, password } = await readJsonBody(req);
      const uname = String(username || "").trim();
      const dname = String(display_name || uname).trim();
      const pass = String(password || "");
      if (!/^[a-zA-Z0-9._-]{2,32}$/.test(uname)) {
        return sendJson(res, 400, { error: "Username must be 2–32 chars (letters, digits, . _ -)." });
      }
      if (pass.length < 4) {
        return sendJson(res, 400, { error: "Password must be at least 4 characters." });
      }
      const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(uname);
      if (exists) {
        return sendJson(res, 409, { error: "Username already exists." });
      }
      const info = db
        .prepare(
          "INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES (?, ?, 'reviewer', ?, ?)"
        )
        .run(uname, dname, hashPassword(pass), nowIso());
      const userId = Number(info.lastInsertRowid);
      const { cookie } = createSession(userId);
      const user = { id: userId, username: uname, display_name: dname, role: "reviewer" };
      writeAudit({ user, action: "register", ip });
      return sendJson(res, 201, { user }, { "Set-Cookie": cookie });
    }

    if (urlPath === "/api/auth/logout" && method === "POST") {
      const user = getSessionUser(req);
      if (user) {
        db.prepare("DELETE FROM sessions WHERE token = ?").run(user.token);
        writeAudit({ user, action: "logout", ip });
      }
      const clear = `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": clear });
    }

    // --- Catalog routes ---
    if (urlPath === "/api/facilities" && method === "GET") {
      const p = path.join(JSON_DIR, "facilities_catalog.json");
      if (!fs.existsSync(p)) return sendJson(res, 404, { error: "facilities_catalog.json not found" });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return fs.createReadStream(p).pipe(res);
    }

    if (urlPath === "/api/resources" && method === "GET") {
      const p = path.join(JSON_DIR, "resources_catalog.json");
      if (!fs.existsSync(p)) return sendJson(res, 404, { error: "resources_catalog.json not found" });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return fs.createReadStream(p).pipe(res);
    }

    // --- Validations routes ---
    if (urlPath === "/api/validations" && method === "GET") {
      return sendJson(res, 200, getAllValidationsMap());
    }

    if (urlPath === "/api/validations" && method === "POST") {
      const user = getSessionUser(req);
      if (!user) {
        return sendJson(res, 401, { error: "Sign in required to save validation reviews." });
      }
      const { facility_code, record } = await readJsonBody(req);
      if (!facility_code || typeof facility_code !== "string") {
        return sendJson(res, 400, { error: "facility_code is required." });
      }

      const prevRow = db
        .prepare("SELECT status, checklist_json, note, updated_at FROM validations WHERE facility_code = ?")
        .get(facility_code);
      const before = prevRow
        ? {
            status: prevRow.status || null,
            checklist: JSON.parse(prevRow.checklist_json || "{}"),
            note: prevRow.note || "",
          }
        : null;

      if (!record) {
        db.prepare("DELETE FROM validations WHERE facility_code = ?").run(facility_code);
        writeAudit({ user, action: "validation_clear", facilityCode: facility_code, before, after: null, ip });
        return sendJson(res, 200, { ok: true, facility_code, record: null });
      }

      const status = record.status ?? null;
      const checklist = record.checklist && typeof record.checklist === "object" ? record.checklist : {};
      const note = String(record.note ?? "");
      const ts = nowIso();

      db.prepare(
        `INSERT INTO validations (facility_code, status, checklist_json, note, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(facility_code) DO UPDATE SET
           status = excluded.status,
           checklist_json = excluded.checklist_json,
           note = excluded.note,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      ).run(facility_code, status, JSON.stringify(checklist), note, user.id, ts);

      const after = { status, checklist, note };
      writeAudit({ user, action: "validation_update", facilityCode: facility_code, before, after, ip });

      return sendJson(res, 200, {
        ok: true,
        facility_code,
        record: {
          ...after,
          updated_at: ts,
          updated_by_username: user.username,
          updated_by_name: user.display_name,
        },
      });
    }

    if (urlPath === "/api/validations/export.csv" && method === "GET") {
      const vals = getAllValidationsMap();
      const facPath = path.join(JSON_DIR, "facilities_catalog.json");
      const facs = fs.existsSync(facPath) ? JSON.parse(fs.readFileSync(facPath, "utf-8")).facilities : [];
      const facByCode = new Map(facs.map((f) => [f.facility_code, f]));

      const headers = [
        "facility_code",
        "facility",
        "region",
        "province",
        "resource_code",
        "validation_status",
        "site_readiness",
        "land_ownership",
        "hazard_assessment",
        "sdp_daed",
        "manpower",
        "note",
        "updated_by",
        "updated_at",
      ];
      const lines = [headers.join(",")];
      for (const [fcode, v] of Object.entries(vals).sort()) {
        const f = facByCode.get(fcode);
        const c = v.checklist || {};
        lines.push(
          [
            fcode,
            f?.facility || "",
            f?.region || "",
            f?.province || "",
            f?.resource?.resource_code || "",
            v.status || "",
            c.site_readiness ? "yes" : "no",
            c.land_ownership ? "yes" : "no",
            c.hazard_assessment ? "yes" : "no",
            c.sdp_daed ? "yes" : "no",
            c.manpower ? "yes" : "no",
            v.note || "",
            v.updated_by_username || "",
            v.updated_at || "",
          ]
            .map(csvEscape)
            .join(",")
        );
      }
      const csv = lines.join("\n") + "\n";
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="hfep_validations.csv"',
      });
      return res.end(csv);
    }

    // --- Audit logs route ---
    if (urlPath === "/api/audit-logs" && method === "GET") {
      const fcode = parsed.searchParams.get("facility_code");
      const limit = Math.min(200, Math.max(1, Number(parsed.searchParams.get("limit") || 50)));
      const rows = fcode
        ? db
            .prepare(
              `SELECT id, timestamp, username, action, facility_code, before_json, after_json
               FROM audit_logs WHERE facility_code = ? ORDER BY id DESC LIMIT ?`
            )
            .all(fcode, limit)
        : db
            .prepare(
              `SELECT id, timestamp, username, action, facility_code, before_json, after_json
               FROM audit_logs ORDER BY id DESC LIMIT ?`
            )
            .all(limit);
      const logs = rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        username: r.username,
        action: r.action,
        facility_code: r.facility_code,
        before: r.before_json ? JSON.parse(r.before_json) : null,
        after: r.after_json ? JSON.parse(r.after_json) : null,
      }));
      return sendJson(res, 200, { logs });
    }

    // --- Local files streaming ---
    if (urlPath.startsWith("/local-files/") && (method === "GET" || method === "HEAD")) {
      const rel = decodeURIComponent(urlPath.slice("/local-files/".length));
      const stripped = rel.startsWith("downloads/") ? rel.slice("downloads/".length) : rel;
      const resolved = path.resolve(DOWNLOADS_DIR, stripped);
      if (!resolved.startsWith(DOWNLOADS_DIR + path.sep)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        res.writeHead(404);
        return res.end("File not found");
      }
      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      const stat = fs.statSync(resolved);
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": String(stat.size),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`,
      });
      if (method === "HEAD") return res.end();
      return fs.createReadStream(resolved).pipe(res);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[hfep-server] error:", err);
    return sendJson(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[hfep-server] Listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
});
