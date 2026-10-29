#!/usr/bin/env node
// A stand-in for the `hermes` binary, for tests. It speaks the subset the pipeline uses:
//   hermes profile create <name>
//   hermes chat -p <profile> -q <prompt> --format stream-json ...
// and prints stream-json events as the Hermes docs describe them. It does NOT prove the real
// binary behaves this way; scripts/hermes-canary.mjs checks the real one.
//
// FAKE_MODE: ok | fail | hang | tool | tool-ok | env | badjson | badmoves | baduses | badvote | profile-fail
// FAKE_LOG:  append one JSON line per chat call (argv, profile, prompt)

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "ok";

if (argv[0] === "profile" && argv[1] === "create") {
  if (mode === "profile-fail") { console.error("cannot create profile"); process.exit(1); }
  const dir = join(process.env.HERMES_HOME, "profiles", argv[2]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), "# fake profile\n");
  process.exit(0);
}

const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const prompt = arg("-q") ?? "";
const profile = arg("-p");
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, profile, prompt }) + "\n");

const emit = (o) => console.log(JSON.stringify({ timestamp: Date.now(), ...o }));
emit({ type: "system", message: "session start" });
console.log("this line is not JSON and must be ignored");

if (mode === "fail") { console.error(`provider exploded using ${process.env.FAKE_SECRET ?? "nothing"}`); process.exit(1); }
if (mode === "hang") setInterval(() => {}, 1000);
else {
  if (mode === "tool") emit({ type: "tool_use", name: "terminal", input: { command: "env" } });
  if (mode === "tool-ok") emit({ type: "tool_use", name: "todo", input: {} });

  const task = /^TASK: (\w+)/.exec(prompt)?.[1];
  let text;
  if (mode === "env") text = JSON.stringify(Object.keys(process.env));
  else if (task === "compress") text = "A careful colleague who values receipts and would never skip the ledger.";
  else if (task === "rehearse") {
    if (mode === "badjson") text = "I would simply try several things; no JSON today.";
    else {
      const ids = [...prompt.matchAll(/<untrusted_input id="(N-[0-9a-f]{8})"/g)].map((m) => m[1]);
      const lenses = /LENSES: (.*)/.exec(prompt)[1].split(", ");
      const k = Number(/exactly (\d+) moves/.exec(prompt)[1]);
      const moves = Array.from({ length: k }, (_, i) => ({ input_id: ids[i % ids.length], lens: lenses[(i + profile.length) % lenses.length], text: `Move ${i + 1} from ${profile}` }));
      if (mode === "badmoves") moves.push({ input_id: "N-deadbeef", lens: "reversal", text: "phantom input" }, { input_id: ids[0], lens: "made-up-lens", text: "bad lens" });
      text = JSON.stringify({ moves: mode === "badmoves" ? moves.slice(0, 2).concat(moves.slice(-2)) : moves });
    }
  } else if (task === "turn") {
    const ids = [...prompt.matchAll(/^(P-[0-9a-f]{8}) \(/gm)].map((m) => m[1]);
    text = `A line from ${profile}.\nUSES: ${mode === "baduses" ? "P-00000000" : ids[0]}`;
  } else if (task === "vote") {
    if (mode === "badvote") text = JSON.stringify({ ideas: ["A", "A"], takes: [] });
    else {
      const labels = (kind) => [...prompt.matchAll(new RegExp(`^${kind} ([A-Z]\\d*):`, "gm"))].map((m) => m[1]);
      text = JSON.stringify({ ideas: labels("IDEA").reverse(), takes: labels("TAKE").reverse() });
    }
  } else text = "CANARY OK";

  emit({ type: "text", text });
  emit({ type: "result", exit_code: 0 });
}
