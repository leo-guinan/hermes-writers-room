// Run Hermes Agent one-shot, safely.
//
//   hermes chat -p <profile> -q <prompt> --format stream-json -t <toolsets> --max-turns N
//
// Facts from the Hermes docs this relies on: `-p` selects a profile, `-q` runs one prompt,
// `--format stream-json` prints one JSON event per line (types system, text, tool_use,
// tool_result, result; the last is always `result` with an exit_code), `-t` restricts toolsets.
// NOT verified against a live run: the exact field names inside those events. All of that
// knowledge lives in parseStream() below, and scripts/hermes-canary.mjs exists to check it
// against the real binary before anything depends on it.
//
// Fail closed:
//  - the process is spawned without a shell (arguments are an array);
//  - any tool_use whose name is not in `allowedTools` aborts the call (HermesPolicyError);
//  - a non-zero exit, a timeout, or an empty answer is an error, never a silent blank;
//  - secrets passed in `env` are redacted from anything that gets thrown or logged.

import { spawn } from "node:child_process";

export class HermesError extends Error {}
export class HermesPolicyError extends HermesError {}
export class HermesCapError extends HermesError {}

export const MAX_PROMPT_BYTES = 100_000; // stays well under the Linux per-argument limit (128 KiB)
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Parse stream-json output. Defensive about field names; ignores non-JSON lines. */
export function parseStream(stdout) {
  const toolUses = [];
  const texts = [];
  let result = null;
  let events = 0;
  for (const raw of String(stdout).split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    events++;
    if (ev.type === "text") texts.push(String(ev.text ?? ev.content ?? ev.delta ?? ""));
    else if (ev.type === "tool_use") toolUses.push(String(ev.name ?? ev.tool ?? ev.tool_name ?? "unknown"));
    else if (ev.type === "result") result = { exit_code: ev.exit_code ?? null, text: typeof ev.result === "string" ? ev.result : typeof ev.text === "string" ? ev.text : null };
  }
  const text = (result?.text && result.text.trim()) || texts.join("").trim();
  return { text, toolUses, result, events };
}

/** A profile name that is unique per character per run, so every taping starts from fresh instances. */
export const profileName = (character, runId) => `${character}-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

// The child gets a minimal environment, not ours: no GITHUB_TOKEN, no ACTIONS_* runtime tokens,
// nothing else that happens to be in the runner's environment. Only what is passed in `env`
// (for example the one model API key) is added.
const ENV_ALLOW = ["PATH", "HOME", "HERMES_HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];
export const scrubbedEnv = (src = process.env) => Object.fromEntries(ENV_ALLOW.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));

const redactor = (secrets) => (s) => secrets.filter((v) => v && String(v).length >= 6).reduce((acc, v) => acc.split(String(v)).join("[redacted]"), String(s));

/** Spawn `bin [...binArgs, ...args]`, collect output, enforce a timeout. Never uses a shell. */
export function exec({ bin = "hermes", binArgs = [], args, env = {}, timeoutMs = 180_000, secrets = [] }) {
  const redact = redactor(secrets);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...binArgs, ...args], { env: { ...scrubbedEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", size = 0, done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new HermesError(`hermes timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    const add = (chunk, which) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) { child.kill("SIGKILL"); finish(reject, new HermesError("hermes output exceeded 8 MiB")); return; }
      if (which === "out") out += chunk; else err += chunk;
    };
    child.stdout.on("data", (c) => add(c, "out"));
    child.stderr.on("data", (c) => add(c, "err"));
    child.on("error", (e) => finish(reject, new HermesError(`cannot run '${bin}': ${redact(e.message)}`)));
    child.on("close", (code) => finish(resolve, { code, stdout: out, stderr: redact(err) }));
  });
}

/** One audited chat call. Returns { text, toolUses, events }. */
export async function runHermes({ bin, binArgs, profile, prompt, toolsets = [], allowedTools = [], model, provider, maxTurns = 3, timeoutMs, env, secrets, safeMode = false }) {
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new HermesError(`prompt is ${Buffer.byteLength(prompt)} bytes; the limit is ${MAX_PROMPT_BYTES}`);
  const args = ["chat", "-p", profile, "-q", prompt, "--format", "stream-json", "--max-turns", String(maxTurns)];
  if (safeMode) args.push("--safe-mode");
  if (toolsets.length) args.push("-t", toolsets.join(","));
  if (model) args.push("-m", model);
  if (provider) args.push("--provider", provider);
  const { code, stdout, stderr } = await exec({ bin, binArgs, args, env, timeoutMs, secrets });
  const parsed = parseStream(stdout);

  const forbidden = parsed.toolUses.filter((t) => !allowedTools.includes(t));
  if (forbidden.length) throw new HermesPolicyError(`profile '${profile}' tried to use tools outside the allowlist: ${[...new Set(forbidden)].join(", ")}`);
  const exit = parsed.result?.exit_code ?? code;
  if (code !== 0 || (exit !== null && exit !== 0)) throw new HermesError(`hermes exited ${exit ?? code} for profile '${profile}': ${stderr.trim().slice(-400) || "(no stderr)"}`);
  if (!parsed.text) throw new HermesError(`hermes returned no text for profile '${profile}' (${parsed.events} events)`);
  return { text: parsed.text, toolUses: parsed.toolUses, events: parsed.events };
}
