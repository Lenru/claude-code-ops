// Pure transcript parsing for scripts/ticket.mjs. No imports and no side effects,
// so it can be tested without a transcript on disk.
//
// A Claude Code transcript is JSONL. The records that matter here:
//   custom-title / ai-title   the tab name Noah typed, or the automatic one
//   user                      Noah typing, but ALSO tool results, skill loads, IDE
//                             context and harness notifications, all as role "user"
//   assistant                 text blocks (what Claude said) and tool_use blocks
// Every record carries `entrypoint` and `cwd`.

// claude -p and the Agent SDK. The heartbeats run hourly under these and edit
// files, so without this guard the answer-slack loop alone opens 14 tickets a day.
const HEADLESS = /^sdk-/;

// role "user" text that Noah did not type.
const NOT_NOAH = [/^</, /^\[SYSTEM NOTIFICATION/, /^\[Request interrupted/, /^Base directory for this skill:/, /^Caveat:/];

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_FILES = 12;

const typed = (s) => typeof s === "string" && s.trim() !== "" && !NOT_NOAH.some((re) => re.test(s.trim()));

/** What Noah typed in one `user` record, or null when the record is not him typing. */
export function promptText(rec) {
  if (rec.isMeta || rec.isSidechain) return null;
  const content = rec.message?.content;
  if (typeof content === "string") return typed(content) ? content.trim() : null;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b?.type === "tool_result")) return null;
  const text = content
    .filter((b) => b?.type === "text" && typed(b.text))
    .map((b) => b.text.trim())
    .join("\n");
  return text || null;
}

/**
 * Everything a ticket needs, from the transcript lines that were read. The caller
 * may pass a head window plus a tail window of a long file, so a line can be a
 * fragment: anything that does not parse is skipped.
 */
export function parseTranscript(lines) {
  let custom = null;
  let ai = null;
  let why = null;
  let prompts = 0;
  let lastSaid = null;
  let cwd = null;
  let headless = false;
  const files = [];

  for (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;

    if (typeof rec.entrypoint === "string" && HEADLESS.test(rec.entrypoint)) headless = true;
    // The FIRST cwd is where the chat was opened, which is what files it under a
    // thread. Later ones follow Claude's `cd`, which wanders into ~/.claude and temp.
    if (typeof rec.cwd === "string") cwd ??= rec.cwd;

    if (rec.type === "custom-title" && rec.customTitle) custom = rec.customTitle;
    else if (rec.type === "ai-title" && rec.aiTitle) ai = rec.aiTitle;
    else if (rec.type === "user") {
      const text = promptText(rec);
      if (text) {
        prompts++;
        why ??= text;
      }
    } else if (rec.type === "assistant" && !rec.isSidechain && Array.isArray(rec.message?.content)) {
      for (const b of rec.message.content) {
        if (b?.type === "text" && b.text?.trim()) lastSaid = b.text.trim();
        if (b?.type !== "tool_use" || !EDITS.has(b.name)) continue;
        const f = b.input?.file_path ?? b.input?.notebook_path;
        // Scratchpad and temp files are Claude's working paper, not the work.
        if (typeof f !== "string" || /[\\/]temp[\\/]/i.test(f)) continue;
        const at = files.indexOf(f);
        if (at !== -1) files.splice(at, 1);
        files.push(f);
      }
    }
  }

  return { title: custom ?? ai, why, prompts, files: files.slice(-MAX_FILES), lastSaid, cwd, headless };
}

/**
 * Is this chat worth a ticket? A one-shot question is not: it would sit open
 * forever and teach Noah to ignore the page. `big` means the transcript was too
 * long to read whole, which only happens to a chat that did real work.
 */
export function qualifies(t, big) {
  if (t.headless) return false;
  return big || t.prompts >= 2 || t.files.length >= 1;
}
