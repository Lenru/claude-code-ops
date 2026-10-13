#!/usr/bin/env node
// Renames the CURRENT chat: the tab name in VS Code and the name in history.
// Usage (from inside a chat): node ~/.claude/scripts/rename-chat.mjs "Clinic · posting"
// Works by appending the same line /rename writes to the chat's transcript.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const title = (process.argv[2] || "").trim();
const id = process.env.CLAUDE_CODE_SESSION_ID;
if (!title || !id) {
  console.error("need a title and CLAUDE_CODE_SESSION_ID (run it from inside a chat)");
  process.exit(1);
}

// Both accounts on this PC: ~/.claude (personal) and ~/.claude-work (work).
// ponytail: scans every project folder; fine at a few hundred chats
const roots = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".claude-work")]
  .filter(Boolean).map((r) => path.join(r, "projects")).filter((r) => fs.existsSync(r));
const file = roots
  .flatMap((root) => fs.readdirSync(root).map((d) => path.join(root, d, `${id}.jsonl`)))
  .find((f) => fs.existsSync(f));
if (!file) {
  console.error(`no transcript for ${id} under ${roots.join(", ")}`);
  process.exit(1);
}

fs.appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: title, sessionId: id }) + "\n");
console.log(`renamed: ${title}`);
