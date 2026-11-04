#!/usr/bin/env node
// Renames the CURRENT chat: the tab name in VS Code and the name in history.
// Usage (from inside a chat): node scripts/rename-chat.mjs "Billing · refunds bug"
// Works by appending the same line /rename writes to the chat's transcript.
import fs from "node:fs";
import path from "node:path";
import { PROJECTS } from "./lib/paths.mjs";

const title = (process.argv[2] || "").trim();
const id = process.env.CLAUDE_CODE_SESSION_ID;
if (!title || !id) {
  console.error("need a title and CLAUDE_CODE_SESSION_ID (run it from inside a chat)");
  process.exit(1);
}

// ponytail: scans every project folder; fine at a few hundred chats
const file = (fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : [])
  .map((d) => path.join(PROJECTS, d, `${id}.jsonl`))
  .find((f) => fs.existsSync(f));
if (!file) {
  console.error(`no transcript for ${id} under ${PROJECTS}`);
  process.exit(1);
}

fs.appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: title, sessionId: id }) + "\n");
console.log(`renamed: ${title}`);
