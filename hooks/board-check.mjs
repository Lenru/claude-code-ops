#!/usr/bin/env node
// PreToolUse on Write|Edit: stop if another chat is already working in this file.
//
// This is the part Noah asked to be blocking rather than advisory, because the
// failure it prevents is one he cannot see: on 2026-09-01 the same interview was
// transcribed twice by two chats an hour apart, a second clip-cutting tool was
// built while the first was being fixed, and a wiki page was nearly edited by two
// chats at once. In every case the other chat had already written to disk and
// nobody was looking.
//
// It fires before EVERY edit, so it does the least possible work: read one small
// JSON that board.mjs already computed. No scanning, no git, no network.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BOARD = path.join(os.homedir(), ".claude", "board", "board.json");

function allow() { process.exit(0); }          // silence = proceed

let payload = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => (payload += d));
process.stdin.on("end", () => {
  try { main(JSON.parse(payload || "{}")); } catch { allow(); }
});
// A hook must never hang the session waiting on stdin that never comes.
setTimeout(allow, 2000).unref?.();

function main(input) {
  const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (!target) allow();
  // Off switch (Noah, 2026-10-24, so an overnight chat never stalls on a prompt): delete board/PAUSED to re-arm.
  if (fs.existsSync(path.join(os.homedir(), ".claude", "board", "PAUSED"))) allow();

  let board;
  try { board = JSON.parse(fs.readFileSync(BOARD, "utf8")); } catch { allow(); }
  if (!board?.chats?.length) allow();

  const me = (input.session_id ?? "").slice(0, 8);
  const norm = p => p.split(String.fromCharCode(92)).join("/").toLowerCase();
  const want = norm(target);

  const clash = board.chats.filter(c => c.id && c.id !== me && c.files.some(f => norm(f) === want));
  if (!clash.length) allow();

  const who = clash
    .map(c => `"${c.title}" (${Math.round((Date.now() - c.updated) / 60000)}m ago)`)
    .join(", ");

  // "ask" rather than "deny": Noah decides. A stale board must never hard-block
  // work, and the board is only as fresh as the other chat's last turn.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason:
        `Another chat is working in this file: ${who}.\n` +
        `File: ${target}\n` +
        `Check that chat before editing, or allow this if you know they are done.`,
    },
  }));
  process.exit(0);
}
