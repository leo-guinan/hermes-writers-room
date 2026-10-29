import test from "node:test";
import assert from "node:assert/strict";
import { validatePr } from "../scripts/validate-input.mjs";
import { CONFIG, commit, g, input, link, makeRepo, write } from "./helpers.mjs";

function pr(setup, author = "leo-guinan") {
  const repo = makeRepo();
  const base = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "-b", "pr");
  setup(repo);
  const head = commit(repo, "pr");
  return validatePr({ repo, base, head, author, config: CONFIG });
}
const has = (r, text) => r.errors.some((e) => e.includes(text));

test("a valid idea from a collaborator passes", () => {
  const r = pr((repo) => write(repo, "inputs/2026-10-30/the-door.md", input()));
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("a valid art-bus input from a listed bot passes", () => {
  const r = pr((repo) => write(repo, "inputs/2026-10-30/via-bus.md", input({
    provenance: { via: "art-bus", submitted_by: "leo-guinan", bus_message_id: "msg_123", bus_received_at: "2026-10-30T01:02:03Z", original_sha256: "a".repeat(64) },
  })), "art-bus[bot]");
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("art-bus provenance from a normal author is rejected", () => {
  const r = pr((repo) => write(repo, "inputs/2026-10-30/via-bus.md", input({
    provenance: { via: "art-bus", submitted_by: "leo-guinan", bus_message_id: "m", bus_received_at: "2026-10-30T01:02:03Z", original_sha256: "a".repeat(64) },
  })));
  assert.equal(r.ok, false);
  assert.ok(has(r, "only accepted from a bot"));
});

test("art-bus input without bus fields is rejected", () => {
  const r = pr((repo) => write(repo, "inputs/2026-10-30/via-bus.md", input({ provenance: { via: "art-bus", submitted_by: "leo-guinan" } })), "art-bus[bot]");
  assert.equal(r.ok, false);
});

test("an author not on the list is rejected", () => {
  const r = pr((repo) => write(repo, "inputs/2026-10-30/x-idea.md", input({ provenance: { via: "direct", submitted_by: "stranger" } })), "stranger");
  assert.equal(r.ok, false);
  assert.ok(has(r, "not on the collaborators list"));
});

test("direct input must be submitted_by the PR author", () => {
  const r = pr((repo) => write(repo, "inputs/2026-10-30/x-idea.md", input({ provenance: { via: "direct", submitted_by: "someone-else" } })));
  assert.equal(r.ok, false);
  assert.ok(has(r, "must be the PR author"));
});

test("consent must be true", () => {
  const r = pr((repo) => write(repo, "inputs/2026-10-30/no-consent.md", input({ consent: false })));
  assert.equal(r.ok, false);
});

test("credit true needs a credit_name; an idea needs a source", () => {
  assert.equal(pr((repo) => write(repo, "inputs/2026-10-30/a-name.md", input({ credit_name: undefined }))).ok, false);
  assert.equal(pr((repo) => write(repo, "inputs/2026-10-30/a-source.md", input({ source: undefined }))).ok, false);
});

test("a reaction needs a reaction block; an asset needs uri + sha256", () => {
  assert.equal(pr((repo) => write(repo, "inputs/2026-10-30/react-me.md", input({ kind: "reaction", source: undefined }))).ok, false);
  const ok = pr((repo) => write(repo, "inputs/2026-10-30/react-me.md", input({ kind: "reaction", source: undefined, reaction: { action: "pick", target: "P-abc12345", reason: "this one sings" } })));
  assert.equal(ok.ok, true, ok.errors.join("\n"));
  assert.equal(pr((repo) => write(repo, "inputs/2026-10-30/an-asset.md", input({ kind: "asset", source: undefined }))).ok, false);
});

test("unknown front matter keys are rejected", () => {
  assert.equal(pr((repo) => write(repo, "inputs/2026-10-30/extra-key.md", input({ sneaky: "yes" }))).ok, false);
});

test("empty body is rejected", () => {
  const r = pr((repo) => write(repo, "inputs/2026-10-30/no-body.md", input().split("---\n").slice(0, 2).join("---\n") + "---\n"));
  assert.equal(r.ok, false);
  assert.ok(has(r, "body is empty"));
});

test("paths outside inputs/ are rejected (workflows, scripts, dailies)", () => {
  for (const p of [".github/workflows/x.yml", "scripts/validate-input.mjs", "dailies/2026-10-30/INDEX.md", "taping.json"]) {
    const r = pr((repo) => { write(repo, p, "x"); write(repo, "inputs/2026-10-30/fine-one.md", input()); });
    assert.equal(r.ok, false, p);
    assert.ok(has(r, "may only add files"), p);
  }
});

test("bad dates and bad slugs are rejected", () => {
  assert.equal(pr((repo) => write(repo, "inputs/2026-13-45/fine-one.md", input())).ok, false);
  assert.equal(pr((repo) => write(repo, "inputs/2026-10-30/Bad_Slug.md", input())).ok, false);
  assert.equal(pr((repo) => write(repo, "inputs/2026-10-30/ab.md", input())).ok, false);
});

test("symlinks are rejected", () => {
  const r = pr((repo) => link(repo, "inputs/2026-10-30/sneaky.md", "/etc/passwd"));
  assert.equal(r.ok, false);
  assert.ok(has(r, "regular files"));
});

test("merged inputs cannot be edited or deleted", () => {
  const repo = makeRepo();
  write(repo, "inputs/2026-10-29/old-one.md", input());
  commit(repo, "merged earlier");
  const base = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "-b", "pr");
  write(repo, "inputs/2026-10-29/old-one.md", input({ title: "Edited after the fact" }));
  const edit = validatePr({ repo, base, head: commit(repo, "edit"), author: "leo-guinan", config: CONFIG });
  assert.equal(edit.ok, false);
  assert.ok(has(edit, "append-only"));
  g(repo, "rm", "-q", "inputs/2026-10-29/old-one.md");
  const del = validatePr({ repo, base, head: commit(repo, "delete"), author: "leo-guinan", config: CONFIG });
  assert.equal(del.ok, false);
});

test("a slug already used on another day is rejected", () => {
  const repo = makeRepo();
  write(repo, "inputs/2026-10-29/the-door.md", input());
  commit(repo, "earlier");
  const base = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "-b", "pr");
  write(repo, "inputs/2026-10-30/the-door.md", input());
  const r = validatePr({ repo, base, head: commit(repo, "dup"), author: "leo-guinan", config: CONFIG });
  assert.equal(r.ok, false);
  assert.ok(has(r, "already used"));
});

test("too many files in one PR is rejected", () => {
  const r = pr((repo) => { for (let i = 0; i < 11; i++) write(repo, `inputs/2026-10-30/idea-${String(i).padStart(2, "0")}.md`, input()); });
  assert.equal(r.ok, false);
  assert.ok(has(r, "the limit is 10"));
});

test("an unreadable base or head is reported, not thrown", () => {
  const repo = makeRepo();
  const r = validatePr({ repo, base: "nope", head: "HEAD", author: "leo-guinan", config: CONFIG });
  assert.equal(r.ok, false);
});
