#!/usr/bin/env node
// Check the real `hermes` binary against the assumptions the pipeline makes, with one tiny call.
// Prints the raw stream-json events (secrets redacted) so a human can see the true field names.
//
//   node scripts/hermes-canary.mjs [--config taping.json]
//
// Exit 0 only if: a profile can be created non-interactively, the call exits 0, the stream
// parses to non-empty text, the reply contains the expected token, and no tool outside the
// allowlist was used. Anything else exits 1 with the reason.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exec, parseStream, scrubbedEnv } from "./lib/hermes.mjs";
import { hermesHome, soulFor } from "./lib/hermes-profiles.mjs";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const a = process.argv.slice(2);
const cfgPath = resolve(a[a.indexOf("--config") + 1] ?? "taping.json");
const hc = JSON.parse(readFileSync(a.includes("--config") ? cfgPath : "taping.json", "utf8")).hermes;
const key = hc.apiKeyEnv ? process.env[hc.apiKeyEnv] : undefined;
const secrets = key ? [key] : [];
const redact = (s) => secrets.reduce((acc, v) => (v.length >= 6 ? acc.split(v).join("[redacted]") : acc), String(s));
const fail = (m) => { console.error(`CANARY FAILED: ${m}`); process.exit(1); };
const ok = (m) => console.log(`ok: ${m}`);

if (hc.apiKeyEnv && !key) fail(`${hc.apiKeyEnv} is not set`);
const env = { ...(key ? { [hc.apiKeyEnv]: key } : {}) };
const home = hermesHome();
const name = `canary-${Date.now()}`;
const TOKEN = "CANARY-7f3a";

console.log(`HERMES_HOME=${home}`);
const v = await exec({ bin: hc.bin, args: ["--version"], env: { HERMES_HOME: home }, timeoutMs: 60_000, secrets }).catch((e) => fail(e.message));
console.log(`version: ${(v.stdout || v.stderr).trim().split("\n")[0]}`);

const pc = await exec({ bin: hc.bin, args: ["profile", "create", name], env: { HERMES_HOME: home, ...env }, timeoutMs: 120_000, secrets }).catch((e) => fail(e.message));
if (pc.code !== 0) fail(`profile create exited ${pc.code}: ${pc.stderr.slice(-400)}`);
const dir = join(home, "profiles", name);
if (!existsSync(dir)) fail(`no profile directory at ${dir}; Hermes keeps profiles elsewhere (look at 'hermes profile --help')`);
ok(`profile create works non-interactively; directory is ${dir}`);
writeFileSync(join(dir, "SOUL.md"), soulFor("You are a test fixture.", { persona: "Answer exactly as asked.", canon: "" }));

const args = ["chat", "-p", name, "-q", `Reply with exactly this token and nothing else: ${TOKEN}`, "--format", "stream-json", "--max-turns", String(hc.maxTurns ?? 3)];
if (hc.toolsets?.length) args.push("-t", hc.toolsets.join(","));
if (hc.model) args.push("-m", hc.model);
if (hc.provider) args.push("--provider", hc.provider);
const r = await exec({ bin: hc.bin, args, env: { HERMES_HOME: home, ...env }, timeoutMs: (hc.timeoutSeconds ?? 180) * 1000, secrets }).catch((e) => fail(e.message));

console.log("---- raw stdout (redacted) ----");
console.log(redact(r.stdout).slice(0, 8000));
console.log("---- stderr tail (redacted) ----");
console.log(redact(r.stderr).slice(-800));
console.log("---- event inventory ----");
const inv = new Map();
for (const line of r.stdout.split("\n")) {
  if (!line.trim().startsWith("{")) continue;
  try { const ev = JSON.parse(line); const k = `${ev.type}: ${Object.keys(ev).sort().join(",")}`; inv.set(k, (inv.get(k) ?? 0) + 1); } catch { /* not json */ }
}
for (const [k, n] of inv) console.log(`${n} x ${k}`);

if (r.code !== 0) fail(`chat exited ${r.code}`);
const p = parseStream(r.stdout);
if (p.events === 0) fail("no JSON events on stdout; --format stream-json may not do what the pipeline assumes");
ok(`${p.events} JSON events parsed`);
if (!p.result) fail("no 'result' event; parseStream cannot see the exit code");
ok(`result event present (exit_code=${p.result.exit_code})`);
if (!p.text) fail("parseStream extracted no text; the event field names differ from what parseStream expects (see inventory above)");
ok(`text extracted (${p.text.length} chars)`);
if (!p.text.includes(TOKEN)) fail(`reply did not contain ${TOKEN}: ${JSON.stringify(p.text.slice(0, 200))}`);
ok("model reply is correct");
const bad = p.toolUses.filter((t) => !(hc.allowedTools ?? []).includes(t));
if (bad.length) fail(`tool use outside allowlist: ${bad.join(", ")}`);
ok(`tool uses: ${p.toolUses.length ? p.toolUses.join(", ") : "none"} (allowlist: ${(hc.allowedTools ?? []).join(", ") || "empty"})`);
const leaked = Object.keys(scrubbedEnv()).length;
ok(`child environment is scrubbed (${leaked} inherited variables)`);
console.log("CANARY PASSED");
