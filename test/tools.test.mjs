// The four tools end to end, against the example transcripts in a temp folder.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stage, CHAT, SHARED_FILE } from "../example/stage.mjs";

const s = stage();
after(() => fs.rmSync(s.root, { recursive: true, force: true }));

const run = (script, args = [], input = "", env = {}) =>
  spawnSync(process.execPath, [script, ...args], { env: { ...s.env, ...env }, input, encoding: "utf8" });
const check = (session_id, file_path) =>
  run("hooks/board-check.mjs", [], JSON.stringify({ session_id, tool_input: { file_path } }));

test("board: live chats with their files, the older one under Earlier with its last words", () => {
  assert.equal(run("scripts/board.mjs").status, 0);
  const board = JSON.parse(fs.readFileSync(path.join(s.board, "board.json"), "utf8"));
  assert.deepEqual(board.chats.map((c) => c.title), ["Billing · refunds bug", "Billing · invoice lines"]);
  assert.ok(board.chats[1].files.includes(SHARED_FILE));
  const md = fs.readFileSync(path.join(s.board, "BOARD.md"), "utf8");
  assert.match(md, /## Live now \(2\)/);
  assert.match(md, /Docs · README setup .*Setup now says Node 20/);
});

test("board-check asks before editing a file another live chat touched", () => {
  const out = JSON.parse(check(CHAT.refunds, SHARED_FILE).stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "ask");
  assert.match(out.permissionDecisionReason, /"Billing · invoice lines"/);
});

test("board-check stays silent for its own files, untouched files, and when paused", () => {
  assert.equal(check(CHAT.refunds, "/home/dev/shop-api/test/refunds.test.ts").stdout, "");
  assert.equal(check(CHAT.refunds, "/home/dev/shop-api/src/new.ts").stdout, "");
  fs.writeFileSync(path.join(s.board, "PAUSED"), "");
  assert.equal(check(CHAT.refunds, SHARED_FILE).stdout, "");
  fs.rmSync(path.join(s.board, "PAUSED"));
});

test("rename-chat appends the same line /rename writes, and the board picks it up", () => {
  const r = run("scripts/rename-chat.mjs", ["Billing · refunds cap"], "", { CLAUDE_CODE_SESSION_ID: CHAT.refunds });
  assert.equal(r.status, 0, r.stderr);
  run("scripts/board.mjs");
  const board = JSON.parse(fs.readFileSync(path.join(s.board, "board.json"), "utf8"));
  assert.equal(board.chats[0].title, "Billing · refunds cap");
  assert.equal(run("scripts/rename-chat.mjs", ["x"], "", { CLAUDE_CODE_SESSION_ID: "" }).status, 1);
});

test("ticket hook files one ticket per chat, never fails the chat, and --done closes it", () => {
  const transcript_path = fs.readdirSync(s.projects, { recursive: true }).map((f) => path.join(s.projects, f)).find((f) => f.includes(CHAT.refunds));
  const hook = (input) => run("scripts/ticket.mjs", ["--hook"], JSON.stringify(input));
  assert.equal(hook({ session_id: CHAT.refunds, transcript_path }).status, 0);
  assert.equal(hook({ session_id: CHAT.refunds, transcript_path }).status, 0);
  const db = JSON.parse(fs.readFileSync(path.join(s.board, "tickets.json"), "utf8"));
  assert.deepEqual(Object.keys(db), [CHAT.refunds]);
  assert.equal(db[CHAT.refunds].why, "Refunds over the original charge are going through. Find out why and fix it.");

  assert.equal(hook({ session_id: CHAT.refunds, transcript_path: "/nope.jsonl" }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.board, "ticket-last.json"), "utf8")).ok, false);

  assert.match(run("scripts/ticket.mjs", ["--done=a1f3"]).stdout, /closed a1f3c2d4/);
  assert.match(run("scripts/ticket.mjs", ["--list"]).stdout, /0 open ticket/);
});
