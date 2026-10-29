// Create one fresh Hermes profile per character for this run, and give each its identity.
//
// A profile is a directory under $HERMES_HOME/profiles/<name>/ with its own config, memory,
// sessions and SOUL.md. SOUL.md is the agent's primary identity (slot 1 of its system prompt),
// so it is where the show bible, the persona and the public canon go. Names include the run id,
// so a taping never reuses or deletes a previous one.

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HermesError, exec, profileName } from "./hermes.mjs";

export const hermesHome = () => process.env.HERMES_HOME ?? join(homedir(), ".hermes");

export const soulFor = (showBible, seed) => [showBible.trim(), "---", seed.persona.trim(), seed.canon.trim()].filter(Boolean).join("\n\n") + "\n";

export async function setupProfiles({ chars, runId, showBible, seeds, bin = "hermes", binArgs = [], home = hermesHome(), env = {} }) {
  const names = {};
  for (const c of chars) {
    const name = profileName(c, runId);
    const r = await exec({ bin, binArgs, args: ["profile", "create", name], env: { HERMES_HOME: home, ...env }, timeoutMs: 120_000 });
    if (r.code !== 0) throw new HermesError(`'hermes profile create ${name}' failed (exit ${r.code}): ${r.stderr.trim().slice(-300) || "(no stderr)"}`);
    const dir = join(home, "profiles", name);
    if (!existsSync(dir)) throw new HermesError(`expected profile directory ${dir} after create; Hermes may keep profiles elsewhere`);
    writeFileSync(join(dir, "SOUL.md"), soulFor(showBible, seeds[c]));
    names[c] = name;
  }
  return names;
}
