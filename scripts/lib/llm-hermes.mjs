// The Hermes-backed model: same interface as the stub (see llm-stub.mjs), one fresh Hermes
// profile per character per run, every call audited by runHermes.
//
// Cost: stream-json output carries no cost figure that I could confirm, so cost is recorded
// as unknown (never free), and the binding limit is a call cap, not a dollar budget.

import { HermesCapError, HermesError, HermesPolicyError, profileName, runHermes } from "./hermes.mjs";
import { compressPrompt, extractJson, rehearsePrompt, splitUses, turnPrompt, votePrompt } from "./prompts.mjs";

export function createHermesLlm({ config, runId, seeds, run = runHermes, env = {}, secrets = [] }) {
  const h = config.hermes;
  const calls = { n: 0 };
  const failures = [];
  const toolUseCounts = {};

  async function ask(character, prompt, { retryHint = null } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (calls.n >= h.maxCalls) throw new HermesCapError(`call cap reached (${h.maxCalls}); stopping rather than spending more`);
      calls.n++;
      try {
        const r = await run({
          bin: h.bin, binArgs: h.binArgs, profile: profileName(character, runId), prompt: attempt && retryHint ? `${prompt}\n\n${retryHint}` : prompt,
          toolsets: h.toolsets, allowedTools: h.allowedTools, model: h.model, provider: h.provider, maxTurns: h.maxTurns, timeoutMs: h.timeoutSeconds * 1000, env, secrets,
        });
        for (const t of r.toolUses) toolUseCounts[t] = (toolUseCounts[t] ?? 0) + 1;
        return r.text;
      } catch (e) {
        if (e instanceof HermesPolicyError || e instanceof HermesCapError || attempt === 1 || !retryHint) throw e; // policy, cap and final failures propagate
      }
    }
    throw new HermesError("unreachable");
  }

  const askJson = async (character, prompt, task, ctx) => {
    const hint = "Your last reply was not usable. Reply with ONLY the JSON object described above, nothing else.";
    let text;
    try {
      text = await ask(character, prompt, { retryHint: hint });
    } catch (e) {
      if (e instanceof HermesPolicyError || e instanceof HermesCapError) throw e;
      failures.push({ task, character, ...ctx, reason: e.message });
      return null;
    }
    let json = extractJson(text);
    if (!json) {
      try { json = extractJson(await ask(character, prompt, { retryHint: hint })); } catch (e) { if (e instanceof HermesPolicyError || e instanceof HermesCapError) throw e; }
    }
    if (!json) failures.push({ task, character, ...ctx, reason: "reply was not valid JSON" });
    return json;
  };

  return {
    mode: "hermes",
    async compress({ by, of, persona, canon }) {
      const text = await ask(by, compressPrompt({ by, of, persona, canon }));
      return text.slice(0, 1500);
    },
    async rehearse({ character, take, k, inputs, compressions, lenses, scene, maxBodyChars }) {
      const json = await askJson(character, rehearsePrompt({ character, take, k, inputs, compressions, lenses, scene, maxBodyChars }), "rehearse", { take });
      return Array.isArray(json?.moves) ? json.moves : [];
    },
    async turn({ speaker, n, total, ideas, transcript, scene }) {
      const text = await ask(speaker, turnPrompt({ speaker, n, total, ideas, transcript, scene }));
      return splitUses(text);
    },
    async vote({ voter, ideaCards, takeCards }) {
      const json = await askJson(voter, votePrompt({ voter, ideaCards, takeCards }), "vote", {});
      return json && Array.isArray(json.ideas) && Array.isArray(json.takes) ? { ideas: json.ideas.map(String), takes: json.takes.map(String) } : null;
    },
    stats: () => ({ mode: "hermes", calls: calls.n, max_calls: h.maxCalls, failures, tool_uses: toolUseCounts, model: h.model, provider: h.provider, toolsets: h.toolsets }),
  };
}
