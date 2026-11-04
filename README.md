# claude-code-ops

Tooling for running many Claude Code chats on one machine at once, so they stop editing the same files without knowing it.

I usually have several chats open across different projects. Each one only knows its own conversation. On 2026-09-01 that cost me three ways in one day: the same interview was transcribed twice by two chats an hour apart, a second clip-cutting tool was built while another chat was fixing the first, and a wiki page was nearly edited by two chats at once. Every time, the other chat had already written to disk and nobody was looking.

These four small tools are what I built to fix that. They run on every chat on my machine.

## What it does

| Tool | Runs | What it does |
|---|---|---|
| `scripts/board.mjs` | Stop hook | Rebuilds `BOARD.md`: every chat by its tab name, the files it touched, and what it last said. Also writes a small `board.json` for the check below. |
| `hooks/board-check.mjs` | PreToolUse hook on edits | Before a chat writes a file, asks you first if another chat touched that file in the last 2 hours, and names that chat. |
| `scripts/rename-chat.mjs` | Called by the chat | Lets a chat rename its own tab, so the board and the tab bar say what each chat is doing now. |
| `scripts/ticket.mjs` | Stop hook | Files one ticket per chat: title, the first thing you asked, the last thing Claude said, the files it edited. `--done`, `--list`, `--add` for side issues. |

What the board looks like, from `npm run demo`:

```
## Live now (2)

| Chat | Last active | Touching |
|---|---|---|
| **Billing · refunds bug** | 03:52 AM (4m ago) | `billing/refunds.ts`<br>`test/refunds.test.ts` |
| **Billing · invoice lines** | 03:31 AM (25m ago) | `billing/invoice.ts`<br>`billing/refunds.ts` |
```

And what the refunds chat gets when it tries to edit `refunds.ts`:

```
Another chat is working in this file: "Billing · invoice lines" (25m ago).
File: /home/dev/shop-api/src/billing/refunds.ts
Check that chat before editing, or allow this if you know they are done.
```

## Decisions worth knowing

- **It stores nothing.** Claude Code already writes a transcript for every chat: the tab title, every tool call with its file path, every message. The board is a view over those files, rebuilt on each Stop. No chat has to remember to report in, so it cannot forget to.
- **Zero model calls.** Everything is parsed out of the transcripts with plain code. These hooks run at the end of every turn of every chat, so they have to be free and fast.
- **It asks, it does not block.** The pre-edit check returns `ask`, not `deny`. The board is only as fresh as the other chat's last turn, and a stale board must never hard-block real work. You see who else is in the file and decide.
- **The check that runs before every edit does almost nothing.** It reads one small JSON file the board already computed. No scanning, no git, no network. The expensive part (reading transcripts) happens on Stop, where it reads only the tail of each file and caches by size and modification time. A naive full scan of one day was about 0.95s across 1.1 GB of transcripts; with the cache, a run re-reads one or two files instead of all of them.
- **Hooks never cost a chat anything.** A hook that crashes or hangs would get in the way of every chat on the machine. The edit check gives up on stdin after 2 seconds and allows the edit on any error. The ticket hook always exits 0 and writes its last result to `ticket-last.json`, because a hook that fails silently is how one of my scheduled jobs stayed dead for a month.
- **Headless runs are not chats.** `claude -p` and SDK sessions are skipped by their entrypoint. My scheduled jobs would otherwise have opened over a dozen tickets a day. A one-question chat with no edits gets no ticket either, so the list stays worth reading.
- **A chat renames itself.** When I tested it, the VS Code tab updated live only when the chat appended its own title. Writing another chat's title from outside landed on disk, and its open tab ignored it.

## Install

Needs Node 20.12 or newer. No dependencies.

```bash
git clone <this repo> ~/claude-code-ops
cd ~/claude-code-ops
npm test        # 16 tests, uses the fake transcripts in example/
npm run demo    # renders the board, the edit warning and tickets from example/
```

Then add the hooks to `~/.claude/settings.json` (use absolute paths):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "node /home/you/claude-code-ops/hooks/board-check.mjs", "timeout": 10 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /home/you/claude-code-ops/scripts/board.mjs", "timeout": 30 },
          { "type": "command", "command": "node /home/you/claude-code-ops/scripts/ticket.mjs --hook", "timeout": 15 }
        ]
      }
    ]
  }
}
```

To let chats name themselves, tell them so in your `CLAUDE.md`, for example: after the first real task, run `node /home/you/claude-code-ops/scripts/rename-chat.mjs "<Project> · <topic>"`. It reads `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for commands a chat runs.

Open `~/.claude/board/BOARD.md` in your editor and pin it.

### Paths

| Variable | Default | Used for |
|---|---|---|
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Transcripts to read |
| `CLAUDE_BOARD_DIR` | `~/.claude/board` | `BOARD.md`, `board.json`, `tickets.json`, `ticket-last.json` |

Both follow `CLAUDE_CONFIG_DIR` if you start Claude Code with one. To switch the edit check off for a while (for example during an unattended overnight run, so nothing waits on a prompt), create an empty `PAUSED` file in the board folder. Delete it to turn the check back on.

## Provenance

These ran inside my own setup, with their git history kept: the ticket hook from my dashboard repo, the board tools from a backup mirror of `~/.claude` started on 2026-09-25 (so the board's earlier history is not in it). Commit dates are real. Client names and local paths were replaced throughout. In the original, tickets went to a database table and showed up on a web dashboard; the last commit keeps the same rules (`scripts/lib/ticket-store.mjs`) over a local JSON file so it runs anywhere.

MIT licensed.
