#!/usr/bin/env node
// Render the cross-chat noticeboard.
//
// Nothing writes to this board. Every field it needs is already in the session
// transcripts Claude Code writes anyway: the tab title you gave the chat
// (`custom-title`), the files it touched (`tool_use` inputs), and when it last
// spoke. So this is a VIEW, not a store, and no chat has to remember anything.
//
// Speed matters twice over: this runs on Stop, and the numbers it writes are read
// before every file edit. A naive full scan of one day is ~0.95s across 1.1GB of
// transcripts, so two things keep it cheap:
//   - only the tail of each transcript is read (recent activity lives at the end)
//   - results are cached per file and only re-read when mtime or size changed,
//     which in practice means 1-2 files per run instead of 14
//
// Writes BOARD.md (for a human, pinned in VS Code) and board.json (for the
// pre-edit check, which must be fast).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const PROJECTS = path.join(HOME, ".claude", "projects");
const OUT_DIR = path.join(HOME, ".claude", "board");
const CACHE = path.join(OUT_DIR, ".cache.json");
const TAIL_BYTES = 400_000;   // enough for the recent turns of a busy chat
const ACTIVE_HOURS = 2;       // how recent counts as "someone is in there now"
const KEEP_DAYS = 14;         // how far back the board still lists a chat

fs.mkdirSync(OUT_DIR, { recursive: true });

const cache = readJson(CACHE) ?? {};
const now = Date.now();

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function readTail(file, bytes) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // a partial first line is unparseable; drop it
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally { fs.closeSync(fd); }
}

// The title is written once and rarely changes, so it is worth a bounded scan
// from the START when the tail does not contain it.
function findTitle(file) {
  for (const chunk of [readTail(file, TAIL_BYTES), headOf(file, 200_000)]) {
    let title = null;
    for (const line of chunk.split("\n")) {
      if (!line.includes("custom-title")) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
      } catch { /* partial line */ }
    }
    if (title) return title;
  }
  return null;
}

function headOf(file, bytes) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(bytes, fs.statSync(file).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}

function scan(file) {
  const tail = readTail(file, TAIL_BYTES);
  const files = new Set();
  let lastTs = null, cwd = null, note = null, sessionId = null, title = null;

  for (const line of tail.split("\n")) {
    if (!line.startsWith("{")) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.sessionId) sessionId = o.sessionId;
    if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
    if (o.timestamp) lastTs = o.timestamp;
    if (o.cwd) cwd = o.cwd;
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "tool_use") {
        const fp = c.input?.file_path ?? c.input?.notebook_path;
        // Per-session scratchpads are temp files unique to one chat, so two chats
        // can never collide on them. Written without a single backslash literal on
        // purpose: every escaped-separator version of this test got mangled in
        // transit and silently matched nothing, which is the worst failure mode.
        if (fp) {
          const norm = fp.split(String.fromCharCode(92)).join("/").toLowerCase();
          if (!norm.includes("/temp/")) files.add(fp);
        }
      }
      if (o.type === "assistant" && c?.type === "text" && c.text?.trim()) {
        note = c.text.trim().replace(/\s+/g, " ").slice(0, 160);
      }
    }
  }
  if (!title) title = findTitle(file);
  return { sessionId, title, lastTs, cwd, note, files: [...files].slice(-12) };
}

// ---- gather ----
const rows = [];
const cutoff = now - KEEP_DAYS * 86400_000;

for (const projDir of safeReaddir(PROJECTS)) {
  const dir = path.join(PROJECTS, projDir);
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;

    const key = file;
    const hit = cache[key];
    let data;
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      data = hit.data;                       // unchanged since last render
    } else {
      data = scan(file);
      cache[key] = { mtimeMs: st.mtimeMs, size: st.size, data };
    }
    rows.push({ ...data, project: projDir, mtimeMs: st.mtimeMs, file });
  }
}

function safeReaddir(p) { try { return fs.readdirSync(p); } catch { return []; } }

rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
fs.writeFileSync(CACHE, JSON.stringify(cache));

// ---- board.json: what the pre-edit check reads, so keep it small ----
const activeCut = now - ACTIVE_HOURS * 3600_000;
const active = rows.filter(r => r.mtimeMs >= activeCut && r.files.length);
fs.writeFileSync(
  path.join(OUT_DIR, "board.json"),
  JSON.stringify({
    generated: new Date().toISOString(),
    activeHours: ACTIVE_HOURS,
    chats: active.map(r => ({
      id: (r.sessionId ?? "").slice(0, 8),
      title: r.title ?? "(untitled)",
      updated: r.mtimeMs,
      files: r.files,
    })),
  }),
);

// ---- BOARD.md: what Noah reads ----
const fmt = ms => {
  const d = new Date(ms), mins = Math.round((now - ms) / 60000);
  const when = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (mins < 60) return `${when} (${mins}m ago)`;
  if (mins < 1440) return `${when} (${Math.round(mins / 60)}h ago)`;
  return d.toLocaleDateString() + " " + when;
};
const short = p => p.replace(HOME, "~").replace(/\\/g, "/");

const L = [];
L.push("# Who is working on what");
L.push("");
L.push(`_Rebuilt ${new Date().toLocaleString()}. A chat counts as **live** if it acted in the last ${ACTIVE_HOURS}h._`);
L.push("");
L.push(`## Live now (${active.length})`);
L.push("");
if (!active.length) L.push("_Nothing active._");
else {
  L.push("| Chat | Last active | Touching |");
  L.push("|---|---|---|");
  for (const r of active) {
    L.push(`| **${r.title ?? "(untitled)"}** | ${fmt(r.mtimeMs)} | ${r.files.slice(-3).map(short).map(f => `\`${f.split("/").slice(-2).join("/")}\``).join("<br>") || "—"} |`);
  }
}
L.push("");
const idle = rows.filter(r => r.mtimeMs < activeCut).slice(0, 25);
L.push(`## Earlier (${idle.length} shown)`);
L.push("");
L.push("| Chat | Last active | Was doing |");
L.push("|---|---|---|");
for (const r of idle) {
  L.push(`| ${r.title ?? "(untitled)"} | ${fmt(r.mtimeMs)} | ${(r.note ?? "").slice(0, 90).replace(/\|/g, "\\|")} |`);
}
L.push("");
fs.writeFileSync(path.join(OUT_DIR, "BOARD.md"), L.join("\n"));

if (process.argv.includes("--print")) {
  console.log(`chats: ${rows.length} total, ${active.length} live`);
  for (const r of active) console.log(`  ${r.title ?? "(untitled)"} — ${r.files.length} files — ${fmt(r.mtimeMs)}`);
}
