#!/usr/bin/env node
// Run one taping and write dailies/<runId>/.
//
//   node scripts/window.mjs --date 2026-10-30 > window.json
//   node scripts/run-taping.mjs --window window.json [--llm stub|hermes]
//
// The model sits behind one interface (scripts/lib/llm-stub.mjs documents it). With the stub, the
// structure, ids, hashing, diffs and rules are real and the text is deterministic placeholder.
// With Hermes, each character is a fresh Hermes profile and every reply is validated here before
// it can affect anything: a bad move, ballot or turn is dropped and recorded, never trusted.
//
// Phases: compression -> rehearsals -> pool -> take -> votes -> diffs -> index -> MANIFEST.
// MANIFEST.json is written LAST and lists every file with its sha256: a directory without one is
// an incomplete run. A finished run is never overwritten (a fix is a new --suffix run).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { show, sha256 } from "./lib/git.mjs";
import { parseInput } from "./lib/inputs.mjs";
import { cap } from "./lib/prompts.mjs";
import { createStubLlm } from "./lib/llm-stub.mjs";

export const DEFAULT_LENSES = ["reversal", "escalation", "silence", "object", "callback", "confession", "time-skip", "interruption"];
export const DEFAULT_SCENE = "An open scene: the characters work out together what to do with today's material, each in their own voice.";
const h = (...parts) => sha256(parts.join("\u0000"));

// Cheap, transparent gate for the room's stopping rule. This is a heuristic receipt, not a
// semantic claim: it records whether a line contains observable evidence of a new contribution.
function marginalSignals(line, previous = []) {
  const text = String(line ?? "").toLowerCase();
  const signals = [];
  if (/receipt|evidence|unknown|establish|resolve|rights-holder|provenance/.test(text)) signals.push("new evidence");
  if (/original|scene|stage|write|make|create|alternative|adapt/.test(text)) signals.push("new creative alternative");
  if (/choose|do |seek|record|test|calculate|pause|continue|build/.test(text)) signals.push("executed action");
  if (/but|instead|cannot|can't|no clearance|disagree|refuse/.test(text)) signals.push("consequential disagreement");
  if (/\$|\b\d+(?:\.\d+)?\b|seconds?|minutes?|zero|one|two|three|four/.test(text)) signals.push("measurable result");
  const duplicate = previous.some((p) => String(p).trim().toLowerCase() === text.trim());
  return { signals: [...new Set(signals)], duplicate, contributes: signals.length > 0 && !duplicate };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  return a;
}

/** Persona, canon and show bible from seeds/. A real (non-stub) run needs every character's persona. */
export function loadSeeds(repo, chars, required) {
  const dir = join(repo, "seeds");
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const showBible = read(join(dir, "SHOW_BIBLE.md")) ?? "";
  const seeds = {};
  for (const c of chars) {
    const persona = read(join(dir, c, "CHARACTER.md"));
    if (persona === null && required) throw new Error(`seeds/${c}/CHARACTER.md is missing; a real run needs a seed for every character`);
    seeds[c] = { persona: persona ?? "", canon: read(join(dir, c, "CANON.md")) ?? "" };
  }
  return { showBible, seeds };
}

export async function runTaping({ repo, window, outRoot = "dailies", config, llm = createStubLlm() }) {
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
  const lenses = config.pool.lenses ?? DEFAULT_LENSES;
  const scene = config.prompt?.scene ?? DEFAULT_SCENE;
  const maxInputs = config.prompt?.maxInputs ?? 30;
  const maxBodyChars = config.prompt?.maxBodyChars ?? 2000;
  const cfgHash = sha256(JSON.stringify(config));
  const seed = h(window.inputsHash, cfgHash);
  const { showBible, seeds } = loadSeeds(repo, chars, llm.mode !== "stub");
  const quality = { dropped_moves: [], invalid_ballots: [], turns_without_declared_uses: [] };

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
  const promptInputs = creative.slice(0, maxInputs).map((i) => ({ id: i.id, kind: i.data.kind, title: i.data.title, body: i.body }));
  const promptLimits = { max_inputs: maxInputs, max_body_chars: maxBodyChars, inputs_omitted: creative.length - promptInputs.length, bodies_truncated: promptInputs.filter((i) => i.body.trim().length > maxBodyChars).length };
  const byInput = new Map(promptInputs.map((i) => [i.id, i]));
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
  const compressions = Object.fromEntries(chars.map((c) => [c, {}]));
  for (const by of chars) for (const of of chars) {
    if (by === of) continue;
    const text = String(await llm.compress({ by, of, persona: seeds[of].persona, canon: seeds[of].canon })).trim();
    compressions[by][of] = text;
    emit(`compression/${by}__of__${of}.md`, `# ${cap(by)}'s compression of ${cap(of)}\n\nusesPrivateMotivation: ${config.compression.usePrivateMotivations}\ndepth: ${config.compression.depth}\n\n${text}\n`);
  }

  // ---- 2. rehearsals: N takes x K moves per character, every move validated ----------------
  const moves = [];
  const { takesPerCharacter: N, ideasPerTake: K } = config.rehearsal;
  for (const character of chars) for (let t = 1; t <= N; t++) {
    const raw = promptInputs.length
      ? await llm.rehearse({ character, take: t, k: K, inputs: promptInputs, compressions: compressions[character], lenses, scene, maxBodyChars, seed })
      : [];
    const takeMoves = [];
    for (const m of (Array.isArray(raw) ? raw : []).slice(0, K)) {
      const input = byInput.get(m?.input_id);
      const lens = String(m?.lens ?? "").trim().toLowerCase();
      const text = String(m?.text ?? "").trim().slice(0, 600);
      const reason = !input ? "input_id is not one of today's inputs" : !lenses.includes(lens) ? "lens is not in the vocabulary" : !text ? "empty text" : null;
      if (reason) { quality.dropped_moves.push({ character, take: `T-${character}-${t}`, reason, move: m ?? null }); continue; }
      takeMoves.push({
        id: `M-${character}-${t}-${takeMoves.length + 1}`, character, take: `T-${character}-${t}`, pool_id: `P-${h(input.id, lens).slice(0, 8)}`,
        input_id: input.id, input_title: input.title, lens, text,
      });
    }
    moves.push(...takeMoves);
    const n2 = String(t).padStart(2, "0");
    emit(`rehearsals/${character}/take-${n2}.md`, `# ${cap(character)} · rehearsal take ${t}\n\n_Simulating the others from compression._\n\n${takeMoves.map((m) => `- **${m.id}** → ${m.pool_id} (${m.lens}): ${m.text}`).join("\n") || "_No usable moves._"}\n`);
    emit(`rehearsals/${character}/take-${n2}.json`, { take: `T-${character}-${t}`, character, moves: takeMoves });
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
  // category: converged = more than one character reached it independently; unique = one; carried = kept by a creative's pick.
  const categoryOf = (i) => (i.characters.length > 1 ? "converged" : i.characters.length === 1 ? "unique" : "carried");
  const poolIdeas = ranked.slice(0, config.pool.maxIdeas).map((i) => ({ ...i, category: categoryOf(i) }));
  const overCap = ranked.slice(config.pool.maxIdeas).map((i) => i.id);
  emit("pool.json", { run: window.runId, ideas: poolIdeas, dropped_over_cap: overCap, dropped_rejected: droppedRejected });

  // ---- 4. the take: everyone, all ideas pooled, one scene ----------------------------------
  const turns = [];
  const turnLimit = config.take.turnLimit;
  for (let n = 0; n < turnLimit && poolIdeas.length; n++) {
    const speaker = chars[n % chars.length];
    const offered = [...new Set([poolIdeas[(n * 2) % poolIdeas.length], poolIdeas[(n * 2 + 1) % poolIdeas.length]])];
    const r = await llm.turn({ speaker, n: n + 1, total: turnLimit, ideas: offered, transcript: turns.map((t) => ({ speaker: t.speaker, line: t.line })), scene });
    const offeredIds = offered.map((o) => o.id);
    const declared = (r.declared ?? []).filter((id) => offeredIds.includes(id));
    if (!declared.length) quality.turns_without_declared_uses.push(n + 1);
    turns.push({ turn: n + 1, speaker, offered: offeredIds, uses: declared.length ? declared : offeredIds, uses_declared: declared.length > 0, line: String(r.line || "[empty reply]").trim() });
  }
  emit("take/turns.jsonl", turns.map((t) => JSON.stringify(t)).join("\n") + (turns.length ? "\n" : ""));
  emit("take/transcript.md", `# The take · ${window.runId}\n\n_All pooled ideas, one scene._\n\n${turns.map((t) => `**${cap(t.speaker)}** (turn ${t.turn}; ideas ${t.uses.join(", ")}): ${t.line}`).join("\n\n") || "_No ideas in the pool._"}\n`);
  const marginal = turns.map((t, i) => ({ turn: t.turn, speaker: t.speaker, ...marginalSignals(t.line, turns.slice(0, i).map((x) => x.line)) }));

  // ---- 5. votes: ranked, blind labels, no self-voting, advisory, validated -----------------
  const poolById = new Map(poolIdeas.map((i) => [i.id, i]));
  const takeIds = [...chars.flatMap((c) => Array.from({ length: N }, (_, i) => ({ id: `T-${c}-${i + 1}`, author: c }))), { id: "T-final", author: null }];
  const takeSummary = (id) => id === "T-final"
    ? turns.slice(0, 6).map((t) => `${cap(t.speaker)}: ${t.line}`).join(" ").slice(0, 500) || "(empty)"
    : moves.filter((m) => m.take === id).map((m) => m.text).join(" / ").slice(0, 400) || "(no usable moves)";
  const labelKey = (voter, id) => h(seed, voter, "label", id);
  const labelsFor = (voter, list) => Object.fromEntries([...list].sort((a, b) => labelKey(voter, a.id).localeCompare(labelKey(voter, b.id))).map((x, i) => [String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ""), x.id]));
  const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && [...a].sort().join() === [...b].sort().join();
  const ballots = [];
  for (const voter of chars) {
    // Converged ideas are ranked by everyone, originators included: otherwise the ideas the room
    // agreed on most would be the ones nobody could rank. Unique ideas keep the no-self-vote rule.
    const convergedRankable = config.vote.convergedRankable !== false;
    const ideas = poolIdeas.filter((i) => config.vote.selfVote || (convergedRankable && i.category === "converged") || !i.characters.includes(voter));
    const takes = takeIds.filter((t) => config.vote.selfVote || t.author !== voter);
    const blind_labels = { ideas: labelsFor(voter, ideas), takes: labelsFor(voter, takes) };
    const ideaCards = Object.entries(blind_labels.ideas).map(([label, id]) => ({ label, text: `${poolById.get(id).text}` }));
    const takeCards = Object.entries(blind_labels.takes).map(([label, id]) => ({ label, summary: takeSummary(id) }));
    const resp = await llm.vote({ voter, ideaCards, takeCards, seed });
    if (resp && sameSet(resp.ideas, Object.keys(blind_labels.ideas)) && sameSet(resp.takes, Object.keys(blind_labels.takes))) {
      const rankedIdeas = resp.ideas.map((l) => blind_labels.ideas[l]);
      ballots.push({ voter, blind_labels, ideas: rankedIdeas, takes: resp.takes.map((l) => blind_labels.takes[l]), ranked_own_origin: rankedIdeas.filter((id) => poolById.get(id).characters.includes(voter)) });
    } else {
      quality.invalid_ballots.push({ voter, reason: resp ? "labels were not each used exactly once" : "no usable ballot returned" });
      ballots.push({ voter, blind_labels, invalid: true });
    }
  }
  const counted = ballots.filter((b) => !b.invalid);
  const borda = (field) => {
    const pts = {};
    for (const b of counted) b[field].forEach((id, pos) => { pts[id] = (pts[id] ?? 0) + (b[field].length - 1 - pos); });
    const rows = Object.entries(pts).map(([id, points]) => ({ id, points })).sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
    return rows.map((r, i) => ({ ...r, tie: rows.some((o, j) => j !== i && o.points === r.points) }));
  };
  emit("votes/ballots.json", { advisory: config.vote.advisory, blind: config.vote.blind, self_vote: config.vote.selfVote, converged_rankable: config.vote.convergedRankable !== false, ballots });
  emit("votes/tally.json", { advisory: config.vote.advisory, method: "borda", tiebreak: config.vote.tiebreak, ballots_counted: counted.length, ballots_invalid: ballots.length - counted.length, ideas: borda("ideas").map((r) => ({ ...r, category: poolById.get(r.id).category, originators: poolById.get(r.id).characters })), takes: borda("takes") });

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
    const positions = Object.fromEntries(counted.filter((b) => rank(b, i.id) >= 0).map((b) => [b.voter, rank(b, i.id) / Math.max(1, b.ideas.length - 1)]));
    const v = Object.values(positions);
    return { id: i.id, positions, spread: v.length ? Math.max(...v) - Math.min(...v) : 0 };
  }).sort((a, b) => b.spread - a.spread || a.id.localeCompare(b.id)));
  // Track converged vs unique vs carried, so the room's agreement can be compared with how ideas do later.
  // position: 1 = ranked first on a ballot, 0 = last. The reactions section joins creatives' picks and
  // rejects (this window's inputs) to the category and rank those ideas had in the PREVIOUS run.
  const prevTally = prevId && existsSync(join(root, prevId, "votes/tally.json")) ? JSON.parse(readFileSync(join(root, prevId, "votes/tally.json"), "utf8")) : null;
  const prevById = new Map((prevPool?.ideas ?? []).map((i) => [i.id, i]));
  const prevRank = new Map((prevTally?.ideas ?? []).map((r, i) => [r.id, i + 1]));
  const byCategory = {};
  for (const i of poolIdeas) {
    const pos = counted.filter((b) => rank(b, i.id) >= 0).map((b) => 1 - rank(b, i.id) / Math.max(1, b.ideas.length - 1));
    const c = (byCategory[i.category] ??= { ideas: [], ballots: 0, position_sum: 0 });
    c.ideas.push(i.id); c.ballots += pos.length; c.position_sum += pos.reduce((a, x) => a + x, 0);
  }
  emit("diffs/category-performance.json", {
    categories: Object.fromEntries(Object.entries(byCategory).map(([k, c]) => [k, { count: c.ideas.length, ideas: c.ideas, ballots: c.ballots, mean_position: c.ballots ? +(c.position_sum / c.ballots).toFixed(4) : null }])),
    creative_reactions_on_previous_run: reactions.filter((r) => prevById.has(r.target)).map((r) => ({ target: r.target, action: r.action, category: prevById.get(r.target).category ?? "unknown", previous_rank: prevRank.get(r.target) ?? null })),
    note: "mean_position: 1 = always ranked first, 0 = always last. Reactions are advisory outcomes from creatives; the join to category and prior rank is how room agreement gets compared with actual performance.",
  });
  emit("diffs/rehearsal-to-take.json", poolIdeas.map((i) => ({ id: i.id, origins: i.origins, used_in_turns: turns.filter((t) => t.uses.includes(i.id)).map((t) => t.turn) })));
  emit("diffs/compression-error.json", { status: "not-computed", note: "Needs real compressions and real takes: predicted vs actual behaviour per ordered pair." });
  emit("diffs/voice-drift.json", { status: "not-computed", note: "Needs real lines compared against each character's pinned seed." });
  emit("diffs/marginal-contribution.json", {
    evaluator: "heuristic-v1",
    signals: config.identityArc?.marginalContributionSignals ?? ["new evidence", "new creative alternative", "executed action", "consequential disagreement", "measurable result"],
    turns: marginal,
    stop_recommendation: marginal.find((m) => !m.contributes)?.turn ?? null,
    note: "Heuristic receipt only. It is not an independent semantic EVAL or a legal judgment. A future evaluator may replace it, but must preserve this receipt.",
  });
  const stats = llm.stats();
  emit("diffs/quality.json", { ...quality, llm_failures: stats.failures, note: "Everything a model returned that was dropped, rejected or missing. Nothing here was used." });

  // ---- 7. index, then the manifest (last) --------------------------------------------------
  const problems = quality.dropped_moves.length + quality.invalid_ballots.length + stats.failures.length;
  emit("INDEX.md", `# Dailies · ${window.runId}\n\n${llm.mode === "stub" ? "> STUB RUN: structure is real, text is placeholder.\n\n" : ""}- Window: ${window.fromTag ?? "start of history"} → \`${window.cutoff_sha.slice(0, 10)}\` (${inputs.length} inputs${skippedInputs.length ? `, ${skippedInputs.length} skipped` : ""})\n- Characters: ${chars.map(cap).join(", ")}\n- Rehearsal takes: ${chars.length * N} · moves: ${moves.length} · pool ideas: ${poolIdeas.length}${prevId ? ` · previous run: ${prevId}` : ""}\n- Model: ${llm.mode} · calls: ${stats.calls}${problems ? ` · **${problems} problems recorded** (diffs/quality.json)` : ""}\n- Votes are advisory; ties go to the producer.\n\n## Read\n- [take/transcript.md](take/transcript.md)\n- [votes/tally.json](votes/tally.json)\n- [pool.json](pool.json)\n- diffs/: vs-previous, convergence, category-performance, vote-splits, rehearsal-to-take, quality\n`);
  const manifest = {
    schema: "dailies/1",
    run: window.runId,
    date: window.date,
    complete: true,
    window: { from: window.from, from_tag: window.fromTag, cutoff_sha: window.cutoff_sha, inputs_hash: window.inputsHash, input_count: inputs.length, skipped_inputs: skippedInputs },
    config_sha256: cfgHash,
    characters: chars,
    llm: stats,
    seeds: Object.fromEntries([["show_bible", sha256(showBible)], ...chars.map((c) => [c, { persona_sha256: sha256(seeds[c].persona), canon_sha256: sha256(seeds[c].canon) }])]),
    prompt_limits: promptLimits,
    cost: llm.mode === "stub" ? { status: "stub", usd: 0 } : { status: "unknown", usd: null, note: "Hermes stream-json reports no cost; the binding limit is the call cap." },
    counts: { rehearsal_takes: chars.length * N, moves: moves.length, pool_ideas: poolIdeas.length, turns: turns.length, problems },
    files: written.sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFileSync(join(runDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { runDir, manifest };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.window) { console.error("usage: run-taping.mjs --window <window.json> [--repo .] [--config taping.json] [--llm stub|hermes]"); process.exit(2); }
  const repo = resolvePath(a.repo ?? ".");
  const window = JSON.parse(readFileSync(resolvePath(a.window), "utf8"));
  if (window.skip) { console.error(`skipped: ${window.skip}`); process.exit(3); }
  const config = JSON.parse(readFileSync(resolvePath(a.config ?? join(repo, "taping.json")), "utf8"));
  const mode = a.llm ?? config.run?.llm ?? "stub";
  try {
    let llm = createStubLlm();
    if (mode === "hermes") {
      const { createHermesLlm } = await import("./lib/llm-hermes.mjs");
      const { setupProfiles } = await import("./lib/hermes-profiles.mjs");
      const hc = config.hermes;
      const key = hc.apiKeyEnv ? process.env[hc.apiKeyEnv] : undefined;
      if (hc.apiKeyEnv && !key) throw new Error(`${hc.apiKeyEnv} is not set; the Hermes run needs it (add it as a repository secret)`);
      const env = key ? { [hc.apiKeyEnv]: key } : {};
      const { showBible, seeds } = loadSeeds(repo, config.characters, true);
      await setupProfiles({ chars: config.characters, runId: window.runId, showBible, seeds, bin: hc.bin, binArgs: hc.binArgs, env });
      llm = createHermesLlm({ config, runId: window.runId, seeds, env, secrets: key ? [key] : [] });
    } else if (mode !== "stub") throw new Error(`unknown llm mode '${mode}' (stub or hermes)`);
    const { manifest } = await runTaping({ repo, window, config, llm });
    console.log(`wrote dailies/${manifest.run}: ${manifest.files.length} files, ${manifest.counts.pool_ideas} pool ideas, ${manifest.counts.problems} problems (${manifest.llm.mode})`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
