import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computeWindow } from "../scripts/window.mjs";
import { runTaping } from "../scripts/run-taping.mjs";
import { sha256 } from "../scripts/lib/git.mjs";
import { commit, g, input, makeRepo, write } from "./helpers.mjs";

const CONFIG = JSON.parse(readFileSync(new URL("../taping.json", import.meta.url), "utf8"));
const idea = (title, over = {}) => input({ title, ...over });

async function tape(repo, date, opts = {}) {
  const window = computeWindow({ repo, date, ...opts });
  assert.equal(window.skip, null, window.skip);
  const out = await runTaping({ repo, window, config: CONFIG });
  commit(repo, `dailies ${window.runId}`);
  g(repo, "tag", `dailies-${window.runId}`);
  return { window, ...out };
}

function seeded() {
  const repo = makeRepo();
  write(repo, "inputs/2026-10-30/the-door.md", idea("The door opens on a different year"));
  write(repo, "inputs/2026-10-30/the-ledger.md", idea("A ledger that remembers forecasts"));
  write(repo, "inputs/2026-10-30/the-radio.md", idea("A radio that only plays tomorrow"));
  commit(repo, "inputs day 1");
  return repo;
}

test("first window covers all inputs; skip when run exists; empty window is skipped", async () => {
  const repo = seeded();
  const w = computeWindow({ repo, date: "2026-10-30" });
  assert.equal(w.files.length, 3);
  assert.equal(w.from, null);
  assert.equal(w.skip, null);
  await tape(repo, "2026-10-30");
  const again = computeWindow({ repo, date: "2026-10-30" });
  assert.match(again.skip, /already exists/);
  const next = computeWindow({ repo, date: "2026-10-31" });
  assert.match(next.skip, /no new inputs/);
  assert.equal(computeWindow({ repo, date: "2026-10-31", allowEmpty: true }).skip, null);
});

test("the next window contains only inputs merged after the last tag", async () => {
  const repo = seeded();
  await tape(repo, "2026-10-30");
  write(repo, "inputs/2026-10-31/the-stage.md", idea("A stage with no audience yet"));
  commit(repo, "inputs day 2");
  const w = computeWindow({ repo, date: "2026-10-31" });
  assert.deepEqual(w.files.map((f) => f.path), ["inputs/2026-10-31/the-stage.md"]);
  assert.equal(w.fromTag, "dailies-2026-10-30");
  assert.equal(w.skip, null);
});

test("the window is fixed by cutoff sha, not by what arrives later", async () => {
  const repo = seeded();
  const cutoff = g(repo, "rev-parse", "HEAD");
  write(repo, "inputs/2026-10-30/late-comer.md", idea("Arrived after the cutoff"));
  commit(repo, "late");
  const w = computeWindow({ repo, date: "2026-10-30", to: cutoff });
  assert.equal(w.files.length, 3);
  assert.equal(w.cutoff_sha, cutoff);
});

test("window is stable: same inputs, same hash", async () => {
  const repo = seeded();
  assert.equal(computeWindow({ repo, date: "2026-10-30" }).inputsHash, computeWindow({ repo, date: "2026-10-30" }).inputsHash);
});

test("a taping writes the full dailies layout, MANIFEST last and complete", async () => {
  const repo = seeded();
  const { runDir, manifest } = await tape(repo, "2026-10-30");
  for (const p of ["INDEX.md", "MANIFEST.json", "pool.json", "inputs/index.json", "take/transcript.md", "take/turns.jsonl", "votes/ballots.json", "votes/tally.json",
    "diffs/vs-previous.json", "diffs/convergence.json", "diffs/vote-splits.json", "diffs/rehearsal-to-take.json", "diffs/compression-error.json", "diffs/voice-drift.json",
    "compression/borges__of__leonardo.md", "rehearsals/agnolo/take-03.md", "rehearsals/agnolo/take-03.json"]) {
    assert.ok(existsSync(join(runDir, p)), `missing ${p}`);
  }
  assert.equal(manifest.complete, true);
  assert.equal(manifest.counts.rehearsal_takes, 9);
  // Every listed file exists and matches its recorded hash; the manifest does not list itself.
  for (const f of manifest.files) assert.equal(sha256(readFileSync(join(repo, f.path), "utf8")), f.sha256, f.path);
  assert.ok(!manifest.files.some((f) => f.path.endsWith("MANIFEST.json")));
  assert.equal(manifest.cost.status, "stub");
});

test("compression never uses private motivations", async () => {
  const repo = seeded();
  const { runDir } = await tape(repo, "2026-10-30");
  assert.match(readFileSync(join(runDir, "compression/borges__of__leonardo.md"), "utf8"), /usesPrivateMotivation: false/);
});

test("no self-voting on unique ideas or takes; converged ideas are ranked by everyone", async () => {
  const repo = seeded();
  const { runDir } = await tape(repo, "2026-10-30");
  const pool = JSON.parse(readFileSync(join(runDir, "pool.json"), "utf8")).ideas;
  const { ballots } = JSON.parse(readFileSync(join(runDir, "votes/ballots.json"), "utf8"));
  for (const b of ballots) {
    for (const id of b.ideas) {
      const idea = pool.find((i) => i.id === id);
      if (idea.category !== "converged") assert.ok(!idea.characters.includes(b.voter), `${b.voter} ranked own unique idea ${id}`);
    }
    for (const id of b.takes) assert.ok(!id.startsWith(`T-${b.voter}-`), `${b.voter} ranked own take ${id}`);
    assert.ok(b.takes.includes("T-final"));
  }
});

test("every turn cites pool ideas, and the cited ids exist", async () => {
  const repo = seeded();
  const { runDir } = await tape(repo, "2026-10-30");
  const ids = new Set(JSON.parse(readFileSync(join(runDir, "pool.json"), "utf8")).ideas.map((i) => i.id));
  const turns = readFileSync(join(runDir, "take/turns.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(turns.length, CONFIG.take.turnLimit);
  for (const t of turns) { assert.ok(t.uses.length > 0); for (const u of t.uses) assert.ok(ids.has(u), u); }
});

test("deterministic: same inputs and config give identical output, except the cutoff sha INDEX.md records", async () => {
  const a = (await tape(seeded(), "2026-10-30")).manifest;
  await new Promise((r) => setTimeout(r, 1100)); // different commit time => different cutoff sha
  const b = (await tape(seeded(), "2026-10-30")).manifest;
  assert.equal(a.window.inputs_hash, b.window.inputs_hash);
  assert.notEqual(a.window.cutoff_sha, b.window.cutoff_sha);
  const strip = (m) => m.files.filter((f) => !f.path.endsWith("/INDEX.md")).map((f) => [f.path, f.sha256]);
  assert.deepEqual(strip(a), strip(b));
});

test("dailies are immutable: a second run of the same id throws, a suffix run works", async () => {
  const repo = seeded();
  const { window } = await tape(repo, "2026-10-30");
  await assert.rejects(() => runTaping({ repo, window, config: CONFIG }), /immutable/);
  const fix = computeWindow({ repo, date: "2026-10-30", suffix: "r2", allowEmpty: true });
  assert.equal(fix.runId, "2026-10-30-r2");
  await runTaping({ repo, window: fix, config: CONFIG });
  assert.ok(readdirSync(join(repo, "dailies")).includes("2026-10-30-r2"));
});

test("day two diffs against day one; reactions carry forward picks and drop rejects", async () => {
  const repo = seeded();
  const day1 = await tape(repo, "2026-10-30");
  const pool1 = JSON.parse(readFileSync(join(day1.runDir, "pool.json"), "utf8")).ideas;
  assert.ok(pool1.length >= 2, "need at least two pool ideas for this test");
  const [keep, drop] = [pool1[0].id, pool1[1].id];
  write(repo, "inputs/2026-10-31/pick-one.md", input({ kind: "reaction", source: undefined, title: "Keep this one", reaction: { action: "pick", target: keep, reason: "this is the scene" } }));
  write(repo, "inputs/2026-10-31/drop-one.md", input({ kind: "reaction", source: undefined, title: "Cut this one", reaction: { action: "reject", target: drop, reason: "does not land" } }));
  write(repo, "inputs/2026-10-31/new-idea.md", idea("A stage with no audience yet"));
  commit(repo, "day 2 inputs");
  const day2 = await tape(repo, "2026-10-31");
  const diff = JSON.parse(readFileSync(join(day2.runDir, "diffs/vs-previous.json"), "utf8"));
  assert.equal(diff.previous_run, "2026-10-30");
  assert.ok(diff.rejected_by_creatives.includes(drop) || !JSON.parse(readFileSync(join(day2.runDir, "pool.json"), "utf8")).ideas.some((i) => i.id === drop));
  const pool2 = JSON.parse(readFileSync(join(day2.runDir, "pool.json"), "utf8"));
  assert.ok(!pool2.ideas.some((i) => i.id === drop), "rejected idea must not be in the pool");
  assert.ok(pool2.ideas.some((i) => i.id === keep), "picked idea must carry forward");
});

test("an invalid file in the window is skipped and recorded, not fatal", async () => {
  const repo = seeded();
  write(repo, "inputs/2026-10-30/broken-one.md", "not front matter at all");
  commit(repo, "broken slipped in");
  const { manifest } = await tape(repo, "2026-10-30");
  assert.equal(manifest.window.skipped_inputs.length, 1);
  assert.equal(manifest.window.input_count, 3);
});

test("converged ideas are ranked by all voters and tracked as a category", async () => {
  const repo = seeded();
  const { runDir } = await tape(repo, "2026-10-30");
  const pool = JSON.parse(readFileSync(join(runDir, "pool.json"), "utf8")).ideas;
  const converged = pool.filter((i) => i.characters.length > 1);
  const unique = pool.filter((i) => i.characters.length === 1);
  assert.ok(converged.length > 0 && unique.length > 0, "stub should produce both categories");
  assert.ok(pool.every((i) => i.category === (i.characters.length > 1 ? "converged" : "unique")));
  const { ballots } = JSON.parse(readFileSync(join(runDir, "votes/ballots.json"), "utf8"));
  for (const b of ballots) for (const i of converged) assert.ok(b.ideas.includes(i.id), `${b.voter} must rank converged ${i.id}`);
  assert.ok(ballots.some((b) => b.ranked_own_origin.length > 0), "originator bias must be visible");
  const tally = JSON.parse(readFileSync(join(runDir, "votes/tally.json"), "utf8"));
  assert.ok(tally.ideas.every((r) => r.category && Array.isArray(r.originators)));
  const perf = JSON.parse(readFileSync(join(runDir, "diffs/category-performance.json"), "utf8"));
  assert.equal(perf.categories.converged.count, converged.length);
  assert.ok(perf.categories.converged.mean_position >= 0 && perf.categories.converged.mean_position <= 1);
});

test("with convergedRankable off, originators cannot rank converged ideas", async () => {
  const repo = seeded();
  const window = computeWindow({ repo, date: "2026-10-30" });
  const config = structuredClone(CONFIG);
  config.vote.convergedRankable = false;
  const { runDir } = await runTaping({ repo, window, config });
  const pool = JSON.parse(readFileSync(join(runDir, "pool.json"), "utf8")).ideas;
  const { ballots } = JSON.parse(readFileSync(join(runDir, "votes/ballots.json"), "utf8"));
  for (const b of ballots) for (const id of b.ideas) assert.ok(!pool.find((i) => i.id === id).characters.includes(b.voter));
});

test("a creative's reaction is joined to the idea's previous category and rank", async () => {
  const repo = seeded();
  const day1 = await tape(repo, "2026-10-30");
  const pool1 = JSON.parse(readFileSync(join(day1.runDir, "pool.json"), "utf8")).ideas;
  write(repo, "inputs/2026-10-31/pick-one.md", input({ kind: "reaction", source: undefined, title: "Keep this one", reaction: { action: "pick", target: pool1[0].id, reason: "yes" } }));
  commit(repo, "reaction");
  const day2 = await tape(repo, "2026-10-31");
  const perf = JSON.parse(readFileSync(join(day2.runDir, "diffs/category-performance.json"), "utf8"));
  assert.equal(perf.creative_reactions_on_previous_run.length, 1);
  const r = perf.creative_reactions_on_previous_run[0];
  assert.equal(r.category, pool1[0].category);
  assert.ok(Number.isInteger(r.previous_rank) || r.previous_rank === null);
});
