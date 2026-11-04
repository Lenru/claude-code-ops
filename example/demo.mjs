// npm run demo: every tool against the example transcripts, no Claude Code needed.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stage, CHAT, SHARED_FILE } from "./stage.mjs";

const s = stage();
const node = (script, args = [], input) =>
  spawnSync(process.execPath, [script, ...args], { env: s.env, input, encoding: "utf8" }).stdout.trim();

console.log("$ node scripts/board.mjs\n");
node("scripts/board.mjs");
console.log(fs.readFileSync(path.join(s.board, "BOARD.md"), "utf8"));

console.log(`\n$ the refunds chat tries to edit ${SHARED_FILE}\n`);
const ask = node("hooks/board-check.mjs", [], JSON.stringify({ session_id: CHAT.refunds, tool_input: { file_path: SHARED_FILE } }));
console.log(JSON.parse(ask).hookSpecificOutput.permissionDecisionReason);

console.log("\n$ the Stop hook files a ticket for each chat, then --list\n");
for (const f of fs.readdirSync(s.projects, { recursive: true }).filter((f) => f.endsWith(".jsonl"))) {
  const transcript_path = path.join(s.projects, f);
  node("scripts/ticket.mjs", ["--hook"], JSON.stringify({ session_id: path.basename(f, ".jsonl"), transcript_path }));
}
console.log(node("scripts/ticket.mjs", ["--list"]));

fs.rmSync(s.root, { recursive: true, force: true });
