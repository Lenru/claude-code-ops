import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, qualifies } from "./ticket-parse.mjs";

const j = (o) => JSON.stringify(o);
const user = (content, extra = {}) => j({ type: "user", message: { role: "user", content }, ...extra });
const said = (text) => j({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (name, input) =>
  j({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });

test("why is what Noah typed, not what the editor or the harness injected", () => {
  const t = parseTranscript([
    j({ type: "environment", entrypoint: "claude-vscode", cwd: "C:\\Users\\me\\Desktop\\noah-os-dashboard" }),
    user([
      { type: "text", text: "<ide_opened_file>The user opened CLAUDE.md</ide_opened_file>" },
      { type: "text", text: "can tickets be automatic?" },
    ]),
    user([{ type: "tool_result", tool_use_id: "x", content: "ok" }]),
    user("[SYSTEM NOTIFICATION - NOT USER INPUT]\nagent finished"),
    user("Base directory for this skill: C:\\x", { isMeta: true }),
    user("subagent prompt", { isSidechain: true }),
    user("one per chat", { cwd: "C:\\Users\\me\\.claude\\projects" }),
  ]);
  assert.equal(t.why, "can tickets be automatic?");
  assert.equal(t.prompts, 2);
  assert.equal(t.headless, false);
  assert.equal(t.cwd, "C:\\Users\\me\\Desktop\\noah-os-dashboard");
});

test("the tab name Noah typed beats the auto title, whichever came last", () => {
  const t = parseTranscript([
    j({ type: "custom-title", customTitle: "Hub tickets" }),
    j({ type: "ai-title", aiTitle: "Automatic issue tracking" }),
  ]);
  assert.equal(t.title, "Hub tickets");
  assert.equal(parseTranscript([j({ type: "ai-title", aiTitle: "Auto" })]).title, "Auto");
  assert.equal(parseTranscript([user("hello")]).title, null);
});

test("claude -p and the SDK are heartbeats, not chats", () => {
  assert.equal(parseTranscript([j({ type: "user", entrypoint: "sdk-cli", message: { content: "go" } })]).headless, true);
  assert.equal(parseTranscript([j({ type: "user", entrypoint: "sdk-py", message: { content: "go" } })]).headless, true);
});

test("files are the ones edited: no reads, no scratch, no repeats, newest twelve", () => {
  const lines = [
    tool("Read", { file_path: "C:\\repo\\read-only.ts" }),
    tool("Write", { file_path: "C:\\Users\\me\\AppData\\Local\\Temp\\claude\\scratch.mjs" }),
    tool("Edit", { file_path: "C:\\repo\\a.ts" }),
    tool("Edit", { file_path: "C:\\repo\\a.ts" }),
    tool("NotebookEdit", { notebook_path: "C:\\repo\\n.ipynb" }),
  ];
  for (let i = 0; i < 14; i++) lines.push(tool("Write", { file_path: `C:\\repo\\f${i}.ts` }));
  const t = parseTranscript(lines);
  assert.equal(t.files.length, 12);
  assert.ok(!t.files.includes("C:\\repo\\read-only.ts"));
  assert.ok(!t.files.some((f) => f.includes("scratch")));
  assert.equal(t.files.at(-1), "C:\\repo\\f13.ts");
  assert.equal(new Set(t.files).size, 12);
});

test("a tail window starts mid-line; the broken line is skipped, the rest is read", () => {
  const t = parseTranscript(['on":"x"}]}}', said("first"), "", said("Committed as abc123.")]);
  assert.equal(t.lastSaid, "Committed as abc123.");
});

test("a one-shot question is not a ticket; two prompts, an edit, or a long transcript is", () => {
  assert.equal(qualifies({ prompts: 1, files: [] }, false), false);
  assert.equal(qualifies({ prompts: 2, files: [] }, false), true);
  assert.equal(qualifies({ prompts: 1, files: ["a"] }, false), true);
  assert.equal(qualifies({ prompts: 1, files: [] }, true), true);
  assert.equal(qualifies({ prompts: 5, files: ["a"], headless: true }, true), false);
});
