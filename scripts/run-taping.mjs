#!/usr/bin/env node
// Run one taping and write dailies/<runId>/.
//
//   node scripts/window.mjs --date 2026-10-30 > /tmp/window.json
//   node scripts/run-taping.mjs --window /tmp/window.json
//
// STUB MODE. The structure, ids, hashing, diffs and rules here are the real thing; the text is
// deterministic placeholder output (no model is called) so the whole pipeline, workflows and
// presentation layer can be built and tested before Hermes is wired in. Replace `llm` below
// with the Hermes-backed implementation; nothing else in this file needs to change.
//
// Phases: compression -> rehearsals -> pool -> take -> votes -> diffs -> index -> MANIFEST.
// MANIFEST.json is written LAST and lists every file with its sha256: a directory without
// one is an incomplete run. A finished run is never overwritten (a fix is a new --suffix run).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { show, sha256 } from "./lib/git.mjs";
import { parseInput } from "./lib/inputs.mjs";

const LENSES = ["reversal", "escalation", "silence", "object", "callback", "confession", "time-skip", "interruption"];
const h = (...parts) => sha256(parts.join("\u0000"));
const num = (hex) => parseInt(hex.slice(0, 8), 16);
const pick = (arr, ...parts) => arr[num(h(...parts)) % arr.length];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ---- the model seam ------------------------------------------------------------------------
// Each call gets what a real model call would get and returns text. Stub = deterministic.
export const stubLlm = {
  mode: "stub",
  compress: ({ by, of }) => `[stub] What ${cap(by)} believes about ${cap(of)}, compressed from public canon and past transcripts only. A real run replaces this paragraph with a lossy model of ${cap(of)} that ${cap(by)} can simulate in rehearsal.`,
  move: ({ character, input, lens }) => `${cap(character)} tries a ${lens} approach to "${input.data.title}".`,
  line: ({ speaker, ideas }) => `[stub line] ${cap(speaker)} plays: ${ideas.map((i) => `${i.lens} on "${i.title}"`).join("; ")}.`,
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  return a;
}

export function runTaping({ repo, window, outRoot = "dailies", config, llm = stubLlm }) {
  const runDir = join(repo, outRoot, window.runId);
  if (existsSync(runDir)) throw new Error(`${outRoot}/${window.runId} already exists. Dailies are immutable; use a new suffix for a fix.`);
  const written = [];
  const emit = (rel, content) => {
    const p = join(runDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n";
    writeFileSync(p, text);
    written.push({ path: `${outRoot}/${window.runId}/${rel}`, sha256: sha256(text) });
  };

  const chars = config.characters;
  const cfgHash = sha256(JSON.stringify(config));
  const seed = h(window.inputsHash, cfgHash);

  // ---- inputs: read at the cutoff commit, never from the working tree ----------------------
  const inputs = [];
  const skippedInputs = [];
  for (const f of window.files) {
    const text = show(repo, window.cutoff_sha, f.path) ?? "";
    const parsed = parseInput(text);
    if (!parsed.ok) { skippedInputs.push({ path: f.path, errors: parsed.errors }); continue; }
    inputs.push({ id: `N-${f.sha256.slice(0, 8)}`, path: f.path, sha256: f.sha256, data: parsed.data, body: parsed.body });
  }
  emit("inputs/index.json", inputs.map(({ id, path, sha256: s, data }) => ({
    id, path, sha256: s, kind: data.kind, title: data.title, credit: data.credit, credit_name: data.credit_name ?? null, reuse: data.reuse, provenance: data.provenance, refs: data.refs ?? [],
  })));
  for (const i of inputs) emit(`inputs/${i.id}.md`, `# ${i.data.title}\n\n_${i.data.kind} · ${i.path} · reuse: ${i.data.reuse} · via ${i.data.provenance.via} (${i.data.provenance.submitted_by})_\n\n${i.body.trim()}\n`);

  const creative = inputs.filter((i) => i.data.kind !== "reaction");
  const reactions = inputs.filter((i) => i.data.kind === "reaction").map((i) => ({ input: i.id, ...i.data.reaction }));
  const reactedWith = (...actions) => new Set(reactions.filter((r) => actions.includes(r.action) && r.target.startsWith("P-")).map((r) => r.target));
  const picked = reactedWith("pick", "remix");
  const rejected = reactedWith("reject");

  // ---- previous run (for carry-forward and diffs) -------------------------------------------
  const root = join(repo, outRoot);
  const prevId = existsSync(root)
    ? readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}(-[a-z0-9]+)?$/.test(d) && d < window.runId && existsSync(join(root, d, "MANIFEST.json"))).sort().at(-1) ?? null
    : null;
  const prevPool = prevId ? JSON.parse(readFileSync(join(root, prevId, "pool.json"), "utf8")) : null;

  // ---- 1. compression: every ordered pair, public canon only -------------------------------
  for (const by of chars) for (const of of chars) {
    if (by === of) continue;
    emit(`compression/${by}__of__${of}.md`, `# ${cap(by)}'s compression of ${cap(of)}\n\nusesPrivateMotivation: ${config.compression.usePrivateMotivations}\ndepth: ${config.compression.depth}\n\n${llm.compress({ by, of })}\n`);
  }

  // ---- 2. rehearsals: N takes x K moves per character --------------------------------------
  const moves = [];
  const { takesPerCharacter: N, ideasPerTake: K } = config.rehearsal;
  for (const character of chars) for (let t = 1; t <= N; t++) {
    const takeMoves = [];
    for (let k = 1; k <= K && creative.length; k++) {
      const input = pick(creative, seed, character, t, k, "input");
      const lens = pick(LENSES, seed, character, t, k, "lens");
      takeMoves.push({
        id: `M-${character}-${t}-${k}`, character, take: `T-${character}-${t}`, pool_id: `P-${h(input.id, lens).slice(0, 8)}`,
        input_id: input.id, input_title: input.data.title, lens, text: llm.move({ character, input, lens }),
      });
    }
    moves.push(...takeMoves);
    emit(`rehearsals/${character}/take-${String(t).padStart(2, "0")}.md`, `# ${cap(character)} · rehearsal take ${t}\n\n_Simulating the others from compression. Stub text._\n\n${takeMoves.map((m) => `- **${m.id}** → ${m.pool_id}: ${m.text}`).join("\n") || "_No inputs to work with._"}\n`);
    emit(`rehearsals/${character}/take-${String(t).padStart(2, "0")}.json`, { take: `T-${character}-${t}`, character, moves: takeMoves });
  }

  // ---- 3. pool: dedupe, carry forward picks, drop rejects, cap -----------------------------
  const byId = new Map();
  for (const m of moves) {
    const e = byId.get(m.pool_id) ?? { id: m.pool_id, text: `${m.lens} on "${m.input_title}"`, title: m.input_title, lens: m.lens, input_ids: [m.input_id], origins: [], characters: [], carried: false };
    e.origins.push(m.id);
    if (!e.characters.includes(m.character)) e.characters.push(m.character);
    byId.set(m.pool_id, e);
  }
  for (const p of prevPool?.ideas ?? []) if (picked.has(p.id) && !byId.has(p.id)) byId.set(p.id, { ...p, origins: [], characters: [], carried: true });
  const droppedRejected = [...byId.keys()].filter((id) => rejected.has(id));
  for (const id of droppedRejected) byId.delete(id);
  const ranked = [...byId.values()].sort((a, b) => b.characters.length - a.characters.length || a.id.localeCompare(b.id));
  const poolIdeas = ranked.slice(0, config.pool.maxIdeas);
  const overCap = ranked.slice(config.pool.maxIdeas).map((i) => i.id);
  emit("pool.json", { run: window.runId, ideas: poolIdeas, dropped_over_cap: overCap, dropped_rejected: droppedRejected });

  // ---- 4. the take: everyone, all ideas pooled, one scene ----------------------------------
  const turns = [];
  const turnLimit = config.take.turnLimit;
  for (let n = 0; n < turnLimit && poolIdeas.length; n++) {
    const speaker = chars[n % chars.length];
    const used = [...new Set([poolIdeas[(n * 2) % poolIdeas.length], poolIdeas[(n * 2 + 1) % poolIdeas.length]])];
    turns.push({ turn: n + 1, speaker, uses: used.map((u) => u.id), line: llm.line({ speaker, ideas: used }) });
  }
  emit("take/turns.jsonl", turns.map((t) => JSON.stringify(t)).join("\n") + (turns.length ? "\n" : ""));
  emit("take/transcript.md", `# The take · ${window.runId}\n\n_All pooled ideas, one scene. Stub text._\n\n${turns.map((t) => `**${cap(t.speaker)}** (turn ${t.turn}; ideas ${t.uses.join(", ")}): ${t.line}`).join("\n\n") || "_No ideas in the pool._"}\n`);

  // ---- 5. votes: ranked, blind labels, no self-voting, advisory ----------------------------
  const takeIds = [...chars.flatMap((c) => Array.from({ length: N }, (_, i) => ({ id: `T-${c}-${i + 1}`, author: c }))), { id: "T-final", author: null }];
  const ballots = chars.map((voter) => {
    const ideas = poolIdeas.filter((i) => config.vote.selfVote || !i.characters.includes(voter));
    const takes = takeIds.filter((t) => config.vote.selfVote || t.author !== voter);
    const order = (list, key) => [...list].sort((a, b) => h(seed, voter, key, a.id).localeCompare(h(seed, voter, key, b.id)));
    const ri = order(ideas, "idea"), rt = order(takes, "take");
    const labels = (list) => Object.fromEntries(order(list, "label").map((x, i) => [String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ""), x.id]));
    return { voter, blind_labels: { ideas: labels(ideas), takes: labels(takes) }, ideas: ri.map((x) => x.id), takes: rt.map((x) => x.id) };
  });
  const borda = (field) => {
    const pts = {};
    for (const b of ballots) b[field].forEach((id, pos) => { pts[id] = (pts[id] ?? 0) + (b[field].length - 1 - pos); });
    const rows = Object.entries(pts).map(([id, points]) => ({ id, points })).sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
    return rows.map((r, i) => ({ ...r, tie: rows.some((o, j) => j !== i && o.points === r.points) }));
  };
  emit("votes/ballots.json", { advisory: config.vote.advisory, blind: config.vote.blind, self_vote: config.vote.selfVote, ballots });
  emit("votes/tally.json", { advisory: config.vote.advisory, method: "borda", tiebreak: config.vote.tiebreak, ideas: borda("ideas"), takes: borda("takes") });

  // ---- 6. diffs: everything a presentation layer needs to show differences -----------------
  const ids = new Set(poolIdeas.map((i) => i.id));
  const prevIds = new Set((prevPool?.ideas ?? []).map((i) => i.id));
  emit("diffs/vs-previous.json", {
    previous_run: prevId,
    new: [...ids].filter((i) => !prevIds.has(i)),
    persisting: [...ids].filter((i) => prevIds.has(i)),
    dropped: [...prevIds].filter((i) => !ids.has(i)),
    carried_by_creative_pick: poolIdeas.filter((i) => i.carried).map((i) => i.id),
    rejected_by_creatives: droppedRejected,
    reactions,
  });
  emit("diffs/convergence.json", {
    converged: poolIdeas.filter((i) => i.characters.length > 1).map((i) => ({ id: i.id, characters: i.characters })),
    unique: poolIdeas.filter((i) => i.characters.length === 1).map((i) => ({ id: i.id, character: i.characters[0] })),
  });
  const rank = (b, id) => b.ideas.indexOf(id);
  emit("diffs/vote-splits.json", poolIdeas.map((i) => {
    const positions = Object.fromEntries(ballots.filter((b) => rank(b, i.id) >= 0).map((b) => [b.voter, rank(b, i.id) / Math.max(1, b.ideas.length - 1)]));
    const v = Object.values(positions);
    return { id: i.id, positions, spread: v.length ? Math.max(...v) - Math.min(...v) : 0 };
  }).sort((a, b) => b.spread - a.spread || a.id.localeCompare(b.id)));
  emit("diffs/rehearsal-to-take.json", poolIdeas.map((i) => ({ id: i.id, origins: i.origins, used_in_turns: turns.filter((t) => t.uses.includes(i.id)).map((t) => t.turn) })));
  emit("diffs/compression-error.json", { status: "not-computed", note: "Needs real compressions and real takes: predicted vs actual behaviour per ordered pair." });
  emit("diffs/voice-drift.json", { status: "not-computed", note: "Needs real lines compared against each character's pinned seed." });

  // ---- 7. index, then the manifest (last) --------------------------------------------------
  emit("INDEX.md", `# Dailies · ${window.runId}\n\n> STUB RUN: structure is real, text is placeholder.\n\n- Window: ${window.fromTag ?? "start of history"} → \`${window.cutoff_sha.slice(0, 10)}\` (${inputs.length} inputs${skippedInputs.length ? `, ${skippedInputs.length} skipped` : ""})\n- Characters: ${chars.map(cap).join(", ")}\n- Rehearsal takes: ${chars.length * N} · moves: ${moves.length} · pool ideas: ${poolIdeas.length}${prevId ? ` · previous run: ${prevId}` : ""}\n- Votes are advisory; ties go to the producer.\n\n## Read\n- [take/transcript.md](take/transcript.md)\n- [votes/tally.json](votes/tally.json)\n- [pool.json](pool.json)\n- diffs/: vs-previous, convergence, vote-splits, rehearsal-to-take\n`);
  const manifest = {
    schema: "dailies/1",
    run: window.runId,
    date: window.date,
    complete: true,
    window: { from: window.from, from_tag: window.fromTag, cutoff_sha: window.cutoff_sha, inputs_hash: window.inputsHash, input_count: inputs.length, skipped_inputs: skippedInputs },
    config_sha256: cfgHash,
    characters: chars,
    llm: { mode: llm.mode },
    seeds: llm.mode === "stub" ? "none (stub run)" : "see seeds/",
    cost: llm.mode === "stub" ? { status: "stub", usd: 0 } : { status: "unknown", usd: null },
    counts: { rehearsal_takes: chars.length * N, moves: moves.length, pool_ideas: poolIdeas.length, turns: turns.length },
    files: written.sort((a, b) => a.path.localeCompare(b.path)),
  };
  const mp = join(runDir, "MANIFEST.json");
  writeFileSync(mp, JSON.stringify(manifest, null, 2) + "\n");
  return { runDir, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.window) { console.error("usage: run-taping.mjs --window <window.json> [--repo .] [--config taping.json]"); process.exit(2); }
  const repo = resolvePath(a.repo ?? ".");
  const window = JSON.parse(readFileSync(resolvePath(a.window), "utf8"));
  if (window.skip) { console.error(`skipped: ${window.skip}`); process.exit(3); }
  const config = JSON.parse(readFileSync(resolvePath(a.config ?? join(repo, "taping.json")), "utf8"));
  try {
    const { manifest } = runTaping({ repo, window, config });
    console.log(`wrote dailies/${manifest.run}: ${manifest.files.length} files, ${manifest.counts.pool_ideas} pool ideas`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
