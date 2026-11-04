#!/usr/bin/env node
// Tickets: one per Claude chat, kept in <board dir>/tickets.json.
//
//   node scripts/ticket.mjs --hook                     the global Stop hook (reads stdin)
//   node scripts/ticket.mjs --list                     open tickets, id first
//   node scripts/ticket.mjs --add --title="…" [--why="…"] [--project=<label>]
//                                                      "ticket this": raise one mid-chat
//   node scripts/ticket.mjs --done=<id or prefix>      close one
//   node scripts/ticket.mjs --reopen=<id or prefix>
//   node scripts/ticket.mjs --backfill [--days=7] [--write]
//                                                      tickets for chats that predate the hook
//
// Noah, 2026-09-21: he wanted an issue ticket for every piece of work he does with
// Claude, the way a dev team has issue numbers, because his notes and session logs
// record all of this already and he opens neither.
//
// A chat ticket's id IS the Claude session id (the transcript's filename), so the
// hook upserts blind and cannot double-insert. Everything on a ticket is parsed out
// of the transcript Claude Code writes anyway: no model call, nothing to remember.
//
// THE HOOK MUST NEVER COST A CHAT ANYTHING. It always exits 0, waits at most two
// seconds for stdin, and writes what happened to <board dir>/ticket-last.json,
// because a hook that fails silently is how one of the scheduled jobs stayed dead for a month.
//
// The original wrote to a database table through definer functions. This version
// keeps the same rules (scripts/lib/ticket-store.mjs) over a local JSON file.

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { parseTranscript, qualifies } from "./lib/ticket-parse.mjs";
import { add, resolve, setStatus, upsert } from "./lib/ticket-store.mjs";
import { BOARD_DIR, PROJECTS } from "./lib/paths.mjs";

const LAST = join(BOARD_DIR, "ticket-last.json");
const STORE = join(BOARD_DIR, "tickets.json");

// Read a transcript whole up to here; past it, a head window (the first prompt and
// where the chat started) plus a tail window (the title, the recent edits).
const WHOLE = 4 * 1024 * 1024;
const HEAD = 256 * 1024;
const TAIL = 1536 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name) => process.argv.includes(`--${name}`);
const cut = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? null);

function readLines(path) {
  const size = statSync(path).size;
  if (size <= WHOLE) return { lines: readFileSync(path, "utf8").split("\n"), big: false };
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(HEAD);
    const tail = Buffer.alloc(TAIL);
    readSync(fd, head, 0, HEAD, 0);
    readSync(fd, tail, 0, TAIL, size - TAIL);
    // Each window ends or starts mid-line. The parser skips what will not parse,
    // and dropping the two known fragments saves it the attempt.
    return {
      lines: [...head.toString("utf8").split("\n").slice(0, -1), ...tail.toString("utf8").split("\n").slice(1)],
      big: true,
    };
  } finally {
    closeSync(fd);
  }
}

// shortcut: read-modify-write with no lock, so two chats stopping in the same
// millisecond can drop one update. The next turn of that chat writes it again.
// Upgrade to a lock file if tickets ever carry state that is not re-derived.
function load() {
  let text;
  try { text = readFileSync(STORE, "utf8"); } catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  // A file that will not parse throws rather than reading as empty: saving over it
  // would wipe every ticket. The hook records the error in ticket-last.json instead.
  return JSON.parse(text);
}
function save(db) {
  mkdirSync(BOARD_DIR, { recursive: true });
  // write then rename, so a reader never sees half a file
  writeFileSync(`${STORE}.tmp`, JSON.stringify(db, null, 2));
  renameSync(`${STORE}.tmp`, STORE);
}

/** The upsert arguments for one transcript, or a reason there is no ticket. */
function ticketFor(sessionId, transcriptPath, { lastSaid = null, at = null } = {}) {
  const { lines, big } = readLines(transcriptPath);
  const t = parseTranscript(lines);
  if (t.headless) return { skip: "headless (claude -p or the SDK)" };
  if (!qualifies(t, big)) return { skip: "one prompt and no edits: a question, not a piece of work" };
  return {
    args: {
      p_id: sessionId,
      p_title: cut(t.title, 120),
      p_why: cut(t.why, 600),
      p_note: cut(lastSaid ?? t.lastSaid, 2000),
      // null, not []: an empty parse of a long transcript's tail must not wipe the
      // files an earlier turn recorded.
      p_files: t.files.length ? t.files : null,
      p_cwd: t.cwd,
      ...(at ? { p_at: at } : {}),
    },
  };
}

function readStdin(ms = 2000) {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(buf);
    };
    const timer = setTimeout(done, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

async function hook() {
  const record = { at: new Date().toISOString(), ok: true };
  try {
    const input = JSON.parse((await readStdin()) || "{}");
    record.session = input.session_id ?? null;
    if (!input.session_id || !UUID.test(input.session_id) || !input.transcript_path) {
      record.result = "skipped: no session on stdin";
    } else {
      const t = ticketFor(input.session_id, input.transcript_path, { lastSaid: input.last_assistant_message });
      if (t.skip) record.result = `skipped: ${t.skip}`;
      else {
        const db = load();
        record.result = upsert(db, t.args);
        save(db);
      }
    }
  } catch (e) {
    record.ok = false;
    record.error = String(e?.message ?? e);
  }
  try {
    mkdirSync(BOARD_DIR, { recursive: true });
    writeFileSync(LAST, JSON.stringify(record, null, 2));
  } catch { /* the board dir is unwritable; nothing to tell */ }
}

const folder = (cwd) => (cwd ? cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() : null);

function list() {
  const rows = Object.values(load())
    .filter((r) => r.status === "open")
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  for (const r of rows) {
    const where = r.project ?? folder(r.cwd) ?? "-";
    const days = Math.floor((Date.now() - Date.parse(r.updated_at)) / 86_400_000);
    console.log(`${r.id.slice(0, 8)}  ${r.kind === "raised" ? "[raised] " : ""}${r.title}  (${where}, ${days === 0 ? "today" : `${days}d ago`})`);
  }
  console.log(`\n${rows.length} open ticket(s).`);
}

function backfill() {
  const days = Number(arg("days") ?? 7);
  const since = Date.now() - days * 86_400_000;
  const db = load();
  const have = new Set(Object.keys(db));
  const found = [];
  const skipped = {};
  for (const dir of readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(PROJECTS, dir.name))) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -6);
      const path = join(PROJECTS, dir.name, f);
      const st = statSync(path);
      if (!UUID.test(id) || st.mtimeMs < since) continue;
      if (have.has(id)) { skipped.exists = (skipped.exists ?? 0) + 1; continue; }
      const t = ticketFor(id, path, { at: new Date(st.mtimeMs).toISOString() });
      if (t.skip) { skipped[t.skip] = (skipped[t.skip] ?? 0) + 1; continue; }
      found.push(t.args);
    }
  }
  found.sort((a, b) => (a.p_at < b.p_at ? 1 : -1));
  for (const a of found) console.log(`${a.p_at.slice(0, 10)}  ${a.p_id.slice(0, 8)}  ${a.p_title ?? cut(a.p_why, 60)}  (${folder(a.p_cwd)})`);
  console.log(`\n${found.length} chat(s) from the last ${days} day(s) would become tickets.`);
  for (const [why, n] of Object.entries(skipped)) console.log(`  left out, ${n}: ${why}`);
  if (!flag("write")) return console.log("\nDry run. Add --write to create them.");
  for (const a of found) upsert(db, a);
  save(db);
  console.log(`\nCreated ${found.length}.`);
}

try {
  if (flag("hook")) await hook();
  else if (flag("list")) list();
  else if (flag("backfill")) backfill();
  else if (flag("add")) {
    const title = arg("title");
    if (!title) throw new Error('need --title="…"');
    const db = load();
    const id = add(db, { title, why: arg("why"), project: arg("project") }, randomUUID());
    save(db);
    console.log(`raised ${id.slice(0, 8)}  ${title}`);
  } else if (arg("done") || arg("reopen")) {
    const status = arg("done") ? "done" : "open";
    const db = load();
    const row = resolve(db, arg("done") ?? arg("reopen"));
    setStatus(db, row.id, status);
    save(db);
    console.log(`${status === "done" ? "closed" : "reopened"} ${row.id.slice(0, 8)}  ${row.title}`);
  } else {
    console.error("usage: ticket.mjs --hook | --list | --add --title= [--why=] [--project=] | --done=<id> | --reopen=<id> | --backfill [--days=7] [--write]");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exitCode = flag("hook") ? 0 : 1;
}
