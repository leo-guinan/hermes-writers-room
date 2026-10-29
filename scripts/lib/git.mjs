// Thin git helpers. Everything goes through execFileSync with an argument array
// (no shell), and file contents are read as blobs with `git show <rev>:<path>`,
// so untrusted PR content is never checked out or executed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export function git(repo, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} failed: ${String(e.stderr || e.message).trim()}`);
  }
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Contents of a blob at a revision, or null if it doesn't exist there. */
export const show = (repo, rev, path) => git(repo, ["show", `${rev}:${path}`], { allowFail: true });

/** Resolve a revision to a full commit sha, or null. */
export const resolve = (repo, rev) => {
  const out = git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { allowFail: true });
  return out ? out.trim() : null;
};

/** Mode of a path at a revision (e.g. "100644", "120000" for a symlink), or null. */
export function modeAt(repo, rev, path) {
  const out = git(repo, ["ls-tree", rev, "--", path], { allowFail: true });
  if (!out || !out.trim()) return null;
  return out.split(/\s+/)[0];
}
