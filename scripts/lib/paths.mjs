// Where Claude Code keeps transcripts, and where these tools write.
//
//   CLAUDE_PROJECTS_DIR  transcripts to read   (default <config>/projects)
//   CLAUDE_BOARD_DIR     BOARD.md, board.json, tickets.json   (default <config>/board)
//
// <config> is CLAUDE_CONFIG_DIR when Claude Code was started with one, else ~/.claude.

import path from "node:path";
import os from "node:os";

const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

export const PROJECTS = path.resolve(process.env.CLAUDE_PROJECTS_DIR || path.join(CONFIG, "projects"));
export const BOARD_DIR = path.resolve(process.env.CLAUDE_BOARD_DIR || path.join(CONFIG, "board"));
