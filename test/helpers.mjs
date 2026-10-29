import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const g = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

export function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "hwr-"));
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "t");
  g(repo, "config", "commit.gpgsign", "false");
  write(repo, "README.md", "base\n");
  commit(repo, "base");
  return repo;
}

export function write(repo, rel, text) {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

export const link = (repo, rel, target) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  symlinkSync(target, join(repo, rel));
};

export function commit(repo, msg) {
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", msg);
  return g(repo, "rev-parse", "HEAD");
}

export const CONFIG = { authors: ["leo-guinan"], bots: ["art-bus[bot]"] };

export function input(over = {}) {
  const fm = {
    kind: "idea",
    title: "The door opens on a different year",
    consent: true,
    credit: true,
    credit_name: "Leo",
    reuse: "show-only",
    source: "a note from yesterday's walk",
    provenance: { via: "direct", submitted_by: "leo-guinan" },
    ...over,
  };
  const yaml = (o, ind = 0) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => {
    const pad = " ".repeat(ind);
    if (v && typeof v === "object" && !Array.isArray(v)) return `${pad}${k}:\n${yaml(v, ind + 2)}`;
    if (Array.isArray(v)) return `${pad}${k}: ${JSON.stringify(v)}`;
    return `${pad}${k}: ${JSON.stringify(v)}`;
  }).join("\n");
  return `---\n${yaml(fm)}\n---\nWhat if the door opens onto a different year each time?\n`;
}
