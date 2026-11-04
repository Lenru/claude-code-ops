// Copies the example transcripts to a temp folder and dates them like a real
// afternoon: two chats active minutes ago, one from this morning. The board goes by
// file times, so a fresh clone needs this or every chat would look as old as the
// checkout.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MINUTES_AGO = { a1f3c2d4: 4, b7e8d9c0: 25, c3d4e5f6: 6 * 60 };

export const CHAT = { refunds: "a1f3c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", invoices: "b7e8d9c0-1a2b-4c3d-9e4f-5a6b7c8d9e0f" };
export const SHARED_FILE = "/home/dev/shop-api/src/billing/refunds.ts";

export function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-ops-"));
  const projects = path.join(root, "projects");
  fs.cpSync(path.join(HERE, "projects"), projects, { recursive: true });
  for (const dir of fs.readdirSync(projects)) {
    for (const f of fs.readdirSync(path.join(projects, dir))) {
      const t = new Date(Date.now() - MINUTES_AGO[f.slice(0, 8)] * 60_000);
      fs.utimesSync(path.join(projects, dir, f), t, t);
    }
  }
  // the env every tool reads its paths from (scripts/lib/paths.mjs)
  return { root, projects, board: path.join(root, "board"), env: { ...process.env, CLAUDE_PROJECTS_DIR: projects, CLAUDE_BOARD_DIR: path.join(root, "board") } };
}
