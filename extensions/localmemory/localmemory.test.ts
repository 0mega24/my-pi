/**
 * Tests for pi-localmemory pure helpers + a SQLite round-trip.
 *
 * Run with Node 24 (built-in test runner + type stripping + node:sqlite):
 *
 *     cd nix/pi-localmemory
 *     npm install
 *     node --test --disable-warning=ExperimentalWarning extension.test.ts
 *
 * Or via Nix:
 *
 *     nix flake check        # runs the pi-localmemory-tests derivation
 *     nix build .#checks.<system>.pi-localmemory-tests
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  GLOBAL_SCOPE,
  defaultDbPath,
  detectProject,
  getLastAssistantText,
  getText,
  openDb,
  parseRememberBlocks,
  toFtsQuery,
} from "./index.ts";

// ─── toFtsQuery ─────────────────────────────────────────────────────────────

test("toFtsQuery: empty / whitespace-only → empty string", () => {
  assert.equal(toFtsQuery(""), "");
  assert.equal(toFtsQuery("   "), "");
  assert.equal(toFtsQuery("\n\t  "), "");
});

test("toFtsQuery: simple words become AND-joined prefix tokens", () => {
  assert.equal(toFtsQuery("hello world"), "hello* AND world*");
});

test("toFtsQuery: lowercases input", () => {
  assert.equal(toFtsQuery("Hello WORLD"), "hello* AND world*");
});

test("toFtsQuery: drops single-character tokens", () => {
  assert.equal(toFtsQuery("a hello b world c"), "hello* AND world*");
});

test("toFtsQuery: caps token count at 8", () => {
  const q = toFtsQuery("aa bb cc dd ee ff gg hh ii jj kk");
  assert.equal(q.split(" AND ").length, 8);
});

// Regression: `-` is the FTS5 column-restriction operator and previously
// produced "no such column: …" errors. Hyphens must be split into separate
// tokens (or dropped entirely if they leave nothing behind).
test("toFtsQuery: regression — hyphenated input does not leak `-` to FTS5", () => {
  assert.equal(
    toFtsQuery("bug-tracker auth-flow"),
    "bug* AND tracker* AND auth* AND flow*",
  );
  assert.equal(
    toFtsQuery("--experimental-sqlite"),
    "experimental* AND sqlite*",
  );
  assert.equal(toFtsQuery("foo -1 bar"), "foo* AND bar*"); // "-1" → "1" (1 char, filtered)
  assert.equal(toFtsQuery("-- dash --"), "dash*");
});

test("toFtsQuery: strips quotes, colons, brackets and other FTS5-meaningful chars", () => {
  assert.equal(
    toFtsQuery('"weird" prompt with "quotes" and: colons; and brackets[]'),
    "weird* AND prompt* AND with* AND quotes* AND and* AND colons* AND and* AND brackets*",
  );
});

test("toFtsQuery: every produced query is accepted by real FTS5", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x);");
  const stmt = db.prepare("SELECT 1 FROM t WHERE t MATCH ?");
  const corpus = [
    "hello world",
    "bug-tracker auth-flow",
    "--experimental-sqlite Node flag",
    "what about -1 indexing",
    '"weird" prompt with "quotes" and: colons; and brackets[]',
    "fix issue #1234 in repo/foo-bar",
    "AND OR NOT NEAR matchinfo",
    "café résumé naïve", // unicode (stripped to ascii by the regex)
    "1 2 3 4 5", // all single-digit → empty
    "",
  ];
  for (const prompt of corpus) {
    const fts = toFtsQuery(prompt);
    if (!fts) continue;
    assert.doesNotThrow(
      () => stmt.all(fts),
      new Error(
        `MATCH should accept ${JSON.stringify(fts)} (from ${JSON.stringify(prompt)})`,
      ),
    );
  }
  db.close();
});

// ─── parseRememberBlocks ────────────────────────────────────────────────────

test("parseRememberBlocks: returns [] when no tag present", () => {
  assert.deepEqual(parseRememberBlocks("just a normal message"), []);
});

test("parseRememberBlocks: single block, title only", () => {
  const blocks = parseRememberBlocks(
    "intro\n<remember>Prefer ripgrep</remember>\noutro",
  );
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    kind: "note",
    tags: "",
    scope: "project",
    title: "Prefer ripgrep",
    body: "",
  });
});

test("parseRememberBlocks: title/body separator `---`", () => {
  const text = `<remember kind="decision" tags="auth,oauth">
Use PKCE for native clients
---
Native apps cannot keep a client secret safe.
Multi-line bodies are preserved.
</remember>`;
  const [b] = parseRememberBlocks(text);
  assert.equal(b.kind, "decision");
  assert.equal(b.tags, "auth,oauth");
  assert.equal(b.scope, "project");
  assert.equal(b.title, "Use PKCE for native clients");
  assert.equal(
    b.body,
    "Native apps cannot keep a client secret safe.\nMulti-line bodies are preserved.",
  );
});

test("parseRememberBlocks: no `---`, first line is title and rest is body", () => {
  const [b] = parseRememberBlocks(
    "<remember>Title line\nbody line 1\nbody line 2</remember>",
  );
  assert.equal(b.title, "Title line");
  assert.equal(b.body, "body line 1\nbody line 2");
});

test("parseRememberBlocks: scope attribute honoured (project / global)", () => {
  const [a, b] = parseRememberBlocks(
    '<remember scope="global">One</remember><remember scope="project">Two</remember>',
  );
  assert.equal(a.scope, "global");
  assert.equal(b.scope, "project");
});

test("parseRememberBlocks: unknown scope value falls back to project", () => {
  const [b] = parseRememberBlocks('<remember scope="weird">Hi</remember>');
  assert.equal(b.scope, "project");
});

test("parseRememberBlocks: empty body is skipped", () => {
  assert.deepEqual(parseRememberBlocks("<remember>   </remember>"), []);
  assert.deepEqual(parseRememberBlocks("<remember></remember>"), []);
});

test("parseRememberBlocks: multiple blocks all returned", () => {
  const blocks = parseRememberBlocks(`
    <remember>First</remember>
    intermezzo
    <remember kind="bug">Second\n---\nbody</remember>
  `);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].title, "First");
  assert.equal(blocks[1].title, "Second");
  assert.equal(blocks[1].kind, "bug");
  assert.equal(blocks[1].body, "body");
});

test("parseRememberBlocks: case-insensitive tag matching", () => {
  const [b] = parseRememberBlocks("<REMEMBER>Hi</REMEMBER>");
  assert.equal(b?.title, "Hi");
});

// ─── getText / getLastAssistantText ─────────────────────────────────────────

test("getText: string passthrough", () => {
  assert.equal(getText("hello"), "hello");
});

test("getText: array of text blocks gets joined", () => {
  assert.equal(
    getText([
      { type: "text", text: "one" },
      { type: "tool_use", input: { x: 1 } },
      { type: "text", text: "two" },
    ]),
    "one\ntwo",
  );
});

test("getText: non-string / non-array returns empty", () => {
  assert.equal(getText(undefined), "");
  assert.equal(getText(null), "");
  assert.equal(getText(42), "");
  assert.equal(getText({}), "");
});

test("getLastAssistantText: picks the last assistant message", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "first reply" },
    { role: "user", content: "follow up" },
    {
      role: "assistant",
      content: [{ type: "text", text: "final" }, { type: "tool_use" }],
    },
  ];
  assert.equal(getLastAssistantText(messages), "final");
});

test("getLastAssistantText: empty when no assistant messages", () => {
  assert.equal(getLastAssistantText([{ role: "user", content: "hi" }]), "");
  assert.equal(getLastAssistantText([]), "");
});

// ─── SQLite round-trip ──────────────────────────────────────────────────────

function tmpDb(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-localmem-test-")),
    "memory.db",
  );
}

test("openDb: creates schema, FTS index, triggers", () => {
  const db = openDb(tmpDb());
  // Insert and confirm FTS index is populated via trigger.
  db.prepare(
    "INSERT INTO memories(ts, project, kind, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    Date.now(),
    "/proj/a",
    "decision",
    "Use SQLite",
    "It's built into Node",
    "sqlite,decision",
  );
  const hits = db
    .prepare(
      `SELECT m.title FROM memories_fts f JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ?`,
    )
    .all("sqlite*") as Array<{ title: string }>;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "Use SQLite");
  db.close();
});

test("openDb: delete trigger removes row from FTS", () => {
  const db = openDb(tmpDb());
  const ins = db.prepare(
    "INSERT INTO memories(ts, project, kind, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)",
  );
  ins.run(Date.now(), "/p", "note", "alpha bravo", "", "");
  ins.run(Date.now(), "/p", "note", "alpha charlie", "", "");
  const before = db
    .prepare(
      "SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?",
    )
    .get("alpha*") as { n: number };
  assert.equal(before.n, 2);
  db.prepare("DELETE FROM memories WHERE title = 'alpha bravo'").run();
  const after = db
    .prepare(
      "SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?",
    )
    .get("alpha*") as { n: number };
  assert.equal(after.n, 1);
  db.close();
});

test("openDb: project-scoped search returns project rows + global, hides other projects", () => {
  const db = openDb(tmpDb());
  const ins = db.prepare(
    "INSERT INTO memories(ts, project, kind, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const now = Date.now();
  ins.run(now, "/proj/a", "note", "alpha in project A", "", "");
  ins.run(now, "/proj/b", "note", "alpha in project B", "", "");
  ins.run(now, GLOBAL_SCOPE, "pref", "alpha global", "", "");

  const rows = db
    .prepare(
      `SELECT m.title FROM memories_fts f JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? AND (m.project = ? OR m.project = '*')
       ORDER BY m.title`,
    )
    .all("alpha*", "/proj/a") as Array<{ title: string }>;
  assert.deepEqual(
    rows.map((r) => r.title),
    ["alpha global", "alpha in project A"],
  );
  db.close();
});

// Regression test that ties the two layers together: a realistic user prompt
// containing hyphens must not crash MATCH.
test("regression: hyphenated user prompt does not crash MATCH", () => {
  const db = openDb(tmpDb());
  db.prepare(
    "INSERT INTO memories(ts, project, kind, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(Date.now(), "/p", "bug", "auth flow login redirect", "details", "");
  const fts = toFtsQuery("fix the bug-tracker auth-flow --redirect");
  assert.ok(fts.length > 0);
  assert.doesNotThrow(() => {
    db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?").all(
      fts,
    );
  });
  db.close();
});

// ─── path helpers ───────────────────────────────────────────────────────────

test("defaultDbPath: honours PI_MEMORY_DB", () => {
  const prev = process.env.PI_MEMORY_DB;
  process.env.PI_MEMORY_DB = "/tmp/custom-pi.db";
  try {
    assert.equal(defaultDbPath(), "/tmp/custom-pi.db");
  } finally {
    if (prev === undefined) delete process.env.PI_MEMORY_DB;
    else process.env.PI_MEMORY_DB = prev;
  }
});

test("defaultDbPath: falls back to XDG_DATA_HOME", () => {
  const prevDb = process.env.PI_MEMORY_DB;
  const prevXdg = process.env.XDG_DATA_HOME;
  delete process.env.PI_MEMORY_DB;
  process.env.XDG_DATA_HOME = "/tmp/xdg";
  try {
    assert.equal(defaultDbPath(), "/tmp/xdg/pi/memory.db");
  } finally {
    if (prevDb === undefined) delete process.env.PI_MEMORY_DB;
    else process.env.PI_MEMORY_DB = prevDb;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
  }
});

test("detectProject: honours PI_MEMORY_PROJECT override", () => {
  const prev = process.env.PI_MEMORY_PROJECT;
  process.env.PI_MEMORY_PROJECT = "/explicit/project";
  try {
    assert.equal(detectProject("/wherever"), "/explicit/project");
  } finally {
    if (prev === undefined) delete process.env.PI_MEMORY_PROJECT;
    else process.env.PI_MEMORY_PROJECT = prev;
  }
});

test("detectProject: non-git directory falls back to cwd", () => {
  const prev = process.env.PI_MEMORY_PROJECT;
  delete process.env.PI_MEMORY_PROJECT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-localmem-nogit-"));
  try {
    assert.equal(detectProject(dir), dir);
  } finally {
    if (prev !== undefined) process.env.PI_MEMORY_PROJECT = prev;
  }
});
