import { test } from "node:test";
import assert from "node:assert/strict";
import { add, resolve, setStatus, upsert } from "./ticket-store.mjs";

const ID = "a1f3c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const at = (min) => new Date(Date.UTC(2026, 10, 3, 12, min)).toISOString();

test("a chat's first turn creates its ticket; an untitled chat is named by its first prompt", () => {
  const db = {};
  assert.equal(upsert(db, { p_id: ID, p_title: null, p_why: "fix the refunds cap", p_at: at(0) }), "created");
  assert.equal(db[ID].title, "fix the refunds cap");
  assert.equal(db[ID].status, "open");
  assert.deepEqual(db[ID].files, []);
});

test("later turns keep the first why, and an empty file list never wipes the recorded files", () => {
  const db = {};
  upsert(db, { p_id: ID, p_title: "Refunds", p_why: "first", p_files: ["a.ts"], p_at: at(0) });
  assert.equal(upsert(db, { p_id: ID, p_title: "", p_why: "second", p_note: "done", p_files: null, p_at: at(5) }), "updated");
  assert.equal(db[ID].title, "Refunds");
  assert.equal(db[ID].why, "first");
  assert.equal(db[ID].note, "done");
  assert.deepEqual(db[ID].files, ["a.ts"]);
  assert.equal(db[ID].updated_at, at(5));
});

test("a closed ticket reopens when its chat is used again, but not within the half hour", () => {
  const db = {};
  upsert(db, { p_id: ID, p_title: "Refunds", p_at: at(0) });
  setStatus(db, ID, "done", at(1));
  assert.equal(upsert(db, { p_id: ID, p_title: "Refunds", p_at: at(10) }), "updated");
  assert.equal(db[ID].status, "done");
  assert.equal(upsert(db, { p_id: ID, p_title: "Refunds", p_at: at(40) }), "reopened");
  assert.equal(db[ID].status, "open");
  assert.equal(db[ID].closed_at, null);
});

test("a backfill replaying older times moves nothing backwards and reopens nothing", () => {
  const db = {};
  upsert(db, { p_id: ID, p_title: "Refunds", p_at: at(30) });
  setStatus(db, ID, "done", at(31));
  assert.equal(upsert(db, { p_id: ID, p_title: "Refunds", p_at: at(0) }), "updated");
  assert.equal(db[ID].status, "done");
  assert.equal(db[ID].updated_at, at(31));
});

test("raised tickets need a title; ids resolve by unique prefix", () => {
  const db = {};
  assert.throws(() => add(db, { title: "  " }, "x"), /needs a title/);
  add(db, { title: "flaky test", project: "shop-api" }, "abc-1");
  add(db, { title: "slow build" }, "abd-2");
  assert.equal(db["abc-1"].kind, "raised");
  assert.equal(resolve(db, "ABC").id, "abc-1");
  assert.throws(() => resolve(db, "ab"), /2 tickets/);
  assert.throws(() => resolve(db, "zz"), /no ticket/);
  assert.throws(() => setStatus(db, "abc-1", "closed"), /invalid status/);
});
