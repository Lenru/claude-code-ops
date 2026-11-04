// The ticket rules, over a plain object { [id]: ticket } that ticket.mjs keeps in
// tickets.json. Pure, so the rules are tested without a file. In the original
// setup these were SQL functions over a database table; the rules are the same.

const REOPEN_AFTER_MS = 30 * 60_000;
const blank = (s) => typeof s !== "string" || s.trim() === "";

/** A chat ticket: insert, or update the one this chat already has. Returns what happened. */
export function upsert(db, { p_id, p_title, p_why = null, p_note = null, p_files = null, p_cwd = null, p_at }) {
  const at = p_at ?? new Date().toISOString();
  const old = db[p_id];
  if (!old) {
    db[p_id] = {
      id: p_id, kind: "chat", status: "open",
      title: blank(p_title) ? (p_why ?? "Untitled chat").slice(0, 80) : p_title.trim(),
      why: p_why, note: p_note, files: p_files ?? [], cwd: p_cwd, project: null,
      created_at: at, updated_at: at, closed_at: null,
    };
    return "created";
  }

  // A closed ticket reopens when its chat is used again. People go back to old chats
  // because the context is there, and work nobody can see is what tickets exist to
  // prevent. The half hour lets you close it and still type "thanks". A backfill
  // passes the transcript's own time as p_at, so replaying history reopens nothing.
  const reopen = old.status === "done" && Date.parse(at) > Date.parse(old.closed_at ?? old.updated_at) + REOPEN_AFTER_MS;

  if (!blank(p_title)) old.title = p_title.trim();
  old.why ??= p_why;
  old.note = p_note ?? old.note;
  old.files = p_files ?? old.files;
  old.cwd ??= p_cwd;
  if (reopen) Object.assign(old, { status: "open", closed_at: null });
  if (at > old.updated_at) old.updated_at = at;
  return reopen ? "reopened" : "updated";
}

/** "Ticket this": a side issue raised mid-chat, with its own id. */
export function add(db, { title, why = null, project = null }, id, at = new Date().toISOString()) {
  if (blank(title)) throw new Error("a ticket needs a title");
  db[id] = {
    id, kind: "raised", status: "open", title: title.trim(), why, note: null, files: [], cwd: null,
    project: blank(project) ? null : project.trim(), created_at: at, updated_at: at, closed_at: null,
  };
  return id;
}

export function setStatus(db, id, status, at = new Date().toISOString()) {
  if (status !== "open" && status !== "done") throw new Error(`invalid status: ${status}`);
  const t = db[id];
  if (!t) throw new Error(`no such ticket: ${id}`);
  Object.assign(t, { status, closed_at: status === "done" ? at : null, updated_at: at });
}

/** The one ticket whose id starts with this prefix. */
export function resolve(db, prefix) {
  const hits = Object.values(db).filter((r) => r.id.toLowerCase().startsWith(prefix.toLowerCase()));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length === 0 ? `no ticket starts with ${prefix}` : `${hits.length} tickets start with ${prefix}, give more of the id`);
}
