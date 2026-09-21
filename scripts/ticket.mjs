#!/usr/bin/env node
// Tickets: one row per Claude chat, shown at /hub/desk/tickets.
//
//   node scripts/ticket.mjs --hook                     the global Stop hook (reads stdin)
//   node scripts/ticket.mjs --list                     open tickets, id first
//   node scripts/ticket.mjs --add --title="…" [--why="…"] [--project=<thread slug>]
//                                                      "ticket this": raise one mid-chat
//   node scripts/ticket.mjs --done=<id or prefix>      close one
//   node scripts/ticket.mjs --reopen=<id or prefix>
//   node scripts/ticket.mjs --backfill [--days=7] [--write]
//                                                      tickets for chats that predate the hook
//
// Noah, 2026-09-21: he wanted an issue ticket for every piece of work he does with
// Claude, the way a dev team has issue numbers, because the vault and the PRIMER files record
// all of this already and he opens neither.
//
// A chat ticket's id IS the Claude session id (the transcript's filename), so the
// hook upserts blind and cannot double-insert. Everything on a ticket is parsed out
// of the transcript Claude Code writes anyway: no model call, nothing to remember.
//
// THE HOOK MUST NEVER COST A CHAT ANYTHING. It always exits 0, gives the network five
// seconds, and writes what happened to ~/.claude/board/ticket-last.json, because a
// hook that fails silently is how NewsRadar stayed dead for a month.
//
// The database call is scripts/lib/hub-rpc.mjs: raw fetch, not supabase-js, because
// this runs at the end of every turn of every chat on the machine.

import { join } from "node:path";
import { homedir } from "node:os";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { parseTranscript, qualifies } from "./lib/ticket-parse.mjs";
import { rpc } from "./lib/hub-rpc.mjs";

const PROJECTS = join(homedir(), ".claude", "projects");
const LAST = join(homedir(), ".claude", "board", "ticket-last.json");

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

/** The ticket_upsert arguments for one transcript, or a reason there is no ticket. */
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
      record.result = t.skip ? `skipped: ${t.skip}` : await rpc("ticket_upsert", t.args, { timeoutMs: 5000 });
    }
  } catch (e) {
    record.ok = false;
    record.error = String(e?.message ?? e);
  }
  try { writeFileSync(LAST, JSON.stringify(record, null, 2)); } catch { /* the board dir is gone; nothing to tell */ }
}

// Every row, but only the columns a list needs. The free-tier org behind this
// database is over its egress quota (vault: Cross-cutting/ops-schema.md), and the
// note and why columns are nine tenths of a ticket's bytes.
const allTickets = () => rpc("tickets_list", { p_limit: 5000 }, { select: "id,kind,title,status,project,client,cwd,updated_at" });

async function resolveId(prefix) {
  const rows = await allTickets();
  const hits = rows.filter((r) => r.id.toLowerCase().startsWith(prefix.toLowerCase()));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length === 0 ? `no ticket starts with ${prefix}` : `${hits.length} tickets start with ${prefix}, give more of the id`);
}

const folder = (cwd) => (cwd ? cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() : null);

async function list() {
  const rows = (await allTickets()).filter((r) => r.status === "open");
  for (const r of rows) {
    const where = r.client ?? r.project ?? folder(r.cwd) ?? "-";
    const days = Math.floor((Date.now() - Date.parse(r.updated_at)) / 86_400_000);
    console.log(`${r.id.slice(0, 8)}  ${r.kind === "raised" ? "[raised] " : ""}${r.title}  (${where}, ${days === 0 ? "today" : `${days}d ago`})`);
  }
  console.log(`\n${rows.length} open ticket(s).`);
}

async function backfill() {
  const days = Number(arg("days") ?? 7);
  const since = Date.now() - days * 86_400_000;
  const have = new Set((await allTickets()).map((r) => r.id));
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
  let made = 0;
  for (const a of found) {
    await rpc("ticket_upsert", a);
    made++;
  }
  console.log(`\nCreated ${made}.`);
}

// Falls off the end rather than calling process.exit(): exiting while a fetch handle
// is still closing trips a libuv assertion on Windows and returns 127 (thread.mjs).
try {
  if (flag("hook")) await hook();
  else if (flag("list")) await list();
  else if (flag("backfill")) await backfill();
  else if (flag("add")) {
    const title = arg("title");
    if (!title) throw new Error('need --title="…"');
    const id = await rpc("ticket_add", { p_title: title, p_why: arg("why"), p_project: arg("project") });
    console.log(`raised ${String(id).slice(0, 8)}  ${title}`);
  } else if (arg("done") || arg("reopen")) {
    const status = arg("done") ? "done" : "open";
    const row = await resolveId(arg("done") ?? arg("reopen"));
    await rpc("ticket_set", { p_id: row.id, p_status: status });
    console.log(`${status === "done" ? "closed" : "reopened"} ${row.id.slice(0, 8)}  ${row.title}`);
  } else {
    console.error("usage: ticket.mjs --hook | --list | --add --title= [--why=] [--project=] | --done=<id> | --reopen=<id> | --backfill [--days=7] [--write]");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exitCode = flag("hook") ? 0 : 1;
}
