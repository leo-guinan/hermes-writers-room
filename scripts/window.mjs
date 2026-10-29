#!/usr/bin/env node
// Work out what a daily run covers: the inputs merged since the last run.
//
//   node scripts/window.mjs --date 2026-10-30 [--to HEAD] [--suffix r2] [--allow-empty]
//
// The window is defined by commits, not wall-clock time: from the commit the last
// `dailies-*` tag points at (or the start of history) to `--to`. A delayed or repeated
// schedule therefore cannot change which inputs a run contains. Output is JSON on stdout.
//
// `skip` is set when the run id already has a MANIFEST.json (dailies are immutable; a fix is a
// new run with --suffix) or when there are no new inputs (unless --allow-empty).

import { resolve as resolvePath } from "node:path";
import { git, resolve, sha256, show } from "./lib/git.mjs";
import { INPUT_PATH, validDate } from "./lib/inputs.mjs";

export function lastRunTag(repo, to) {
  const tags = (git(repo, ["tag", "--list", "dailies-*", "--sort=-creatordate"], { allowFail: true }) ?? "").split("\n").filter(Boolean);
  for (const tag of tags) {
    const sha = resolve(repo, tag);
    if (sha && git(repo, ["merge-base", "--is-ancestor", sha, to], { allowFail: true }) !== null) return { tag, sha };
  }
  return null;
}

export function computeWindow({ repo, date, to = "HEAD", suffix = "", allowEmpty = false }) {
  if (!validDate(date)) throw new Error(`'${date}' is not a real date (YYYY-MM-DD)`);
  if (suffix && !/^[a-z0-9]{1,8}$/.test(suffix)) throw new Error("suffix must be 1-8 lowercase letters/digits, e.g. r2");
  const toSha = resolve(repo, to);
  if (!toSha) throw new Error(`cannot resolve '${to}'`);
  const runId = suffix ? `${date}-${suffix}` : date;
  const last = lastRunTag(repo, toSha);

  const listed = last
    ? git(repo, ["diff", "--name-status", "--no-renames", "-z", `${last.sha}..${toSha}`, "--", "inputs/"]).split("\0").filter(Boolean)
    : null;
  let paths;
  if (listed) {
    paths = [];
    for (let i = 0; i + 1 < listed.length; i += 2) if (listed[i] === "A") paths.push(listed[i + 1]);
  } else {
    paths = git(repo, ["ls-tree", "-r", "--name-only", toSha, "--", "inputs/"], { allowFail: true })?.split("\n").filter(Boolean) ?? [];
  }
  paths = paths.filter((p) => INPUT_PATH.test(p)).sort();
  const files = paths.map((path) => ({ path, sha256: sha256(show(repo, toSha, path) ?? "") }));
  const inputsHash = sha256(files.map((f) => `${f.path}:${f.sha256}`).join("\n"));

  let skip = null;
  if (show(repo, toSha, `dailies/${runId}/MANIFEST.json`) !== null) skip = `dailies/${runId} already exists; dailies are immutable. Use --suffix for a new run.`;
  else if (files.length === 0 && !allowEmpty) skip = "no new inputs since the last run";

  return {
    runId,
    date,
    from: last?.sha ?? null,
    fromTag: last?.tag ?? null,
    cutoff_sha: toSha,
    files,
    inputsHash,
    skip,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allow-empty") a.allowEmpty = true;
    else a[argv[i].replace(/^--/, "")] = argv[++i];
  }
  if (!a.date) {
    console.error("usage: window.mjs --date YYYY-MM-DD [--to <rev>] [--suffix r2] [--allow-empty] [--repo <dir>]");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(computeWindow({ repo: resolvePath(a.repo ?? "."), date: a.date, to: a.to, suffix: a.suffix, allowEmpty: a.allowEmpty }), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
