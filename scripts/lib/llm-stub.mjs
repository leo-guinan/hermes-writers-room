// The stub model: deterministic placeholder output behind the same interface as the Hermes one.
// No model is called. Structure and ids are real; the text is not.
//
// Interface (all async):
//   compress({by, of, persona, canon})                      -> string
//   rehearse({character, take, k, inputs, lenses, seed})    -> [{input_id, lens, text}]
//   turn({speaker, n, total, ideas, transcript})            -> {line, declared}
//   vote({voter, ideaCards, takeCards, seed})               -> {ideas:[labels], takes:[labels]}
//   stats()                                                 -> {mode, calls, failures, ...}

import { sha256 } from "./git.mjs";
import { cap } from "./prompts.mjs";

const h = (...parts) => sha256(parts.join("\u0000"));
const num = (hex) => parseInt(hex.slice(0, 8), 16);
const pick = (arr, ...parts) => arr[num(h(...parts)) % arr.length];

export function createStubLlm() {
  let calls = 0;
  return {
    mode: "stub",
    async compress({ by, of }) {
      calls++;
      return `[stub] What ${cap(by)} believes about ${cap(of)}, compressed from public canon and past transcripts only. A real run replaces this paragraph with a lossy model of ${cap(of)} that ${cap(by)} can simulate in rehearsal.`;
    },
    async rehearse({ character, take, k, inputs, lenses, seed }) {
      calls++;
      const out = [];
      for (let i = 1; i <= k && inputs.length; i++) {
        const input = pick(inputs, seed, character, take, i, "input");
        const lens = pick(lenses, seed, character, take, i, "lens");
        out.push({ input_id: input.id, lens, text: `${cap(character)} tries a ${lens} approach to "${input.title}".` });
      }
      return out;
    },
    async turn({ speaker, ideas }) {
      calls++;
      return { line: `[stub line] ${cap(speaker)} plays: ${ideas.map((i) => `${i.lens} on "${i.title}"`).join("; ")}.`, declared: null };
    },
    async vote({ voter, ideaCards, takeCards, seed }) {
      calls++;
      const order = (cards, key) => [...cards].sort((a, b) => h(seed, voter, key, a.label).localeCompare(h(seed, voter, key, b.label))).map((c) => c.label);
      return { ideas: order(ideaCards, "idea"), takes: order(takeCards, "take") };
    },
    stats: () => ({ mode: "stub", calls, failures: [] }),
  };
}
