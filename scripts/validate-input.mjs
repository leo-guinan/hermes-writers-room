#!/usr/bin/env node
// Validate an input PR. Run from a TRUSTED checkout (the base branch), against PR content
// that is only ever read as git blobs:
//
//   node scripts/validate-input.mjs --repo . --base <sha> --head <sha> --author <login>
//
// A PR may only ADD markdown files at inputs/YYYY-MM-DD/<slug>.md. Anything else (edits to
// merged inputs, deletions, other paths, symlinks, scripts, workflows) is rejected, which is what
// makes auto-merge safe. Exit 0 = valid, 1 = invalid (errors listed), 2 = usage/internal error.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { git, modeAt, resolve, show } from "./lib/git.mjs";
import { INPUT_PATH, LIMITS, parseInput, validDate } from "./lib/inputs.mjs";

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

export function validatePr({ repo, base, head, author, config }) {
  const errors = [];
  const files = [];
  const baseSha = resolve(repo, base);
  const headSha = resolve(repo, head);
  if (!baseSha || !headSha) return { ok: false, errors: [`cannot resolve base '${base}' or head '${head}'`], files };

  const cfg = {
    authors: (config.authors ?? []).map((s) => s.toLowerCase()),
    bots: (config.bots ?? []).map((s) => s.toLowerCase()),
  };
  const who = String(author ?? "").toLowerCase();
  const isAuthor = cfg.authors.includes(who);
  const isBot = cfg.bots.includes(who);
  if (!isAuthor && !isBot) errors.push(`'${author}' is not on the collaborators list (collaborators.json)`);

  // What changed, relative to the merge base.
  const raw = git(repo, ["diff", "--name-status", "--no-renames", "-z", `${baseSha}...${headSha}`]);
  const tokens = raw.split("\0").filter(Boolean);
  const changes = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) changes.push({ status: tokens[i], path: tokens[i + 1] });
  if (changes.length === 0) errors.push("the PR changes nothing");
  if (changes.length > LIMITS.filesPerPr) errors.push(`the PR changes ${changes.length} files; the limit is ${LIMITS.filesPerPr}`);

  // Slugs already used anywhere under inputs/ at base.
  const taken = new Set(
    (git(repo, ["ls-tree", "-r", "--name-only", baseSha, "--", "inputs/"], { allowFail: true }) ?? "")
      .split("\n").filter(Boolean).map((p) => p.split("/").pop()),
  );
  const seenInPr = new Set();

  for (const { status, path } of changes) {
    const fileErrors = [];
    const m = INPUT_PATH.exec(path);
    if (status !== "A") fileErrors.push(`status ${status}: inputs are append-only; merged inputs are never edited or deleted`);
    if (!m) fileErrors.push("PRs may only add files at inputs/YYYY-MM-DD/<slug>.md (lowercase letters, digits, dashes; 3-61 chars)");
    if (m && !validDate(m[1])) fileErrors.push(`'${m[1]}' is not a real date`);
    if (m) {
      const file = `${m[2]}.md`;
      if (taken.has(file) || seenInPr.has(file)) fileErrors.push(`slug '${m[2]}' is already used; pick a new one`);
      seenInPr.add(file);
    }
    let parsed = null;
    if (status === "A" && m) {
      const mode = modeAt(repo, headSha, path);
      if (mode !== "100644") fileErrors.push(`file mode ${mode}: only regular files are allowed (no symlinks, no executables)`);
      else {
        const text = show(repo, headSha, path);
        if (text === null) fileErrors.push("cannot read the file at the PR head");
        else {
          parsed = parseInput(text);
          fileErrors.push(...parsed.errors);
          const p = parsed.data?.provenance;
          if (p) {
            if (p.via === "direct" && String(p.submitted_by).toLowerCase() !== who) fileErrors.push(`provenance.submitted_by ('${p.submitted_by}') must be the PR author ('${author}') for direct inputs`);
            if (p.via === "art-bus" && !isBot) fileErrors.push(`via 'art-bus' is only accepted from a bot on the collaborators list; '${author}' is not one`);
          }
        }
      }
    }
    files.push({ path, status, kind: parsed?.data?.kind ?? null, errors: fileErrors });
    errors.push(...fileErrors.map((e) => `${path}: ${e}`));
  }
  return { ok: errors.length === 0, errors, files, base: baseSha, head: headSha };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = args(process.argv.slice(2));
  if (!a.base || !a.head || !a.author) {
    console.error("usage: validate-input.mjs --repo <dir> --base <rev> --head <rev> --author <login> [--config collaborators.json]");
    process.exit(2);
  }
  const repo = resolvePath(a.repo ?? ".");
  const config = JSON.parse(readFileSync(resolvePath(a.config ?? "collaborators.json"), "utf8"));
  const report = validatePr({ repo, base: a.base, head: a.head, author: a.author, config });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error("\nInput rejected:\n" + report.errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }
}
