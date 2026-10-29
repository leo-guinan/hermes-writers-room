# Dailies

Inputs come in as pull requests. Valid ones auto-merge. Once a day, every input merged since the
last run goes through a taping and the results are committed as `dailies/<date>/`. The creatives
look at the dailies the next day and react by opening more input PRs, which seeds the next taping.

```
creative / Art Bus ──PR──▶ validate ──auto-merge──▶ inputs/YYYY-MM-DD/<slug>.md
                                                          │  (cutoff_sha window)
                          daily Action ◀──────────────────┘
                               │  compression → rehearsals → pool → take → votes → diffs
                               ▼
                       dailies/<date>/  ──▶ creatives react (PRs) ──▶ next day
```

Status: **the pipeline is real, the model calls are stubbed.** `scripts/run-taping.mjs` writes the
full dailies structure with deterministic placeholder text so the workflows, ids, diffs and a
presentation layer can be built now. Hermes plugs in at one seam (`llm` in `run-taping.mjs`).

## Inputs

One file per input, `inputs/YYYY-MM-DD/<slug>.md`: YAML front matter, then the input as markdown.
Schema: [`schemas/input.schema.json`](../schemas/input.schema.json).

```markdown
---
kind: idea                 # idea | note | goal | asset | reaction
title: The door opens on a different year
consent: true              # must be true
credit: true
credit_name: Leo           # required when credit is true
reuse: show-only           # cc-by | show-only | ask-first
source: yesterday's walk   # required for ideas
refs: [P-1a2b3c4d]         # optional: I- idea, D- dailies, T- take, P- pool, N- input ids
provenance:
  via: direct              # direct | art-bus
  submitted_by: leo-guinan
---
What if the door opens onto a different year each time?
```

- A **reaction** carries `reaction: {action: pick | remix | reject, target: P-…, reason}`. Picked and
  remixed pool ideas carry into the next pool; rejected ones are dropped from it.
- An **asset** carries `asset: {uri (https), sha256}`. Assets are recorded by URI and hash, never stored.
- Inputs are **append-only**. A merged input is never edited or deleted; a correction is a new input.

### What the Art Bus has to supply

The validator accepts `via: art-bus` only from an account listed under `bots` in
`collaborators.json`, and then requires:

| Field | Meaning |
|---|---|
| `provenance.bus_message_id` | The bus's own id for the message |
| `provenance.bus_received_at` | When the bus received it (UTC, `…Z`) |
| `provenance.original_sha256` | sha256 of the original message, before standardizing |
| `provenance.submitted_by` | The human GitHub login the input is from |

`bus_channel` is optional. This is what this repo needs from the bus; it says nothing about how the
bus works internally. The bus must open PRs as a GitHub App or with a PAT: PRs created with a
workflow's `GITHUB_TOKEN` do not trigger other workflows, so the check would never run.

## Validation (`validate-input.yml`)

A PR may only **add** files matching `inputs/YYYY-MM-DD/<slug>.md`: real date, lowercase slug of 3 to
61 characters, regular files only (no symlinks or executables), at most 10 files, front matter under
4 KB, body under 20,000 characters, slug unique across all days. The author must be on
`collaborators.json`. Rejections come back as a PR comment with the reasons.

Auto-merge is safe because nothing else can ride along: workflows, scripts, config and `dailies/`
are all outside the allowed path. The workflow runs on `pull_request_target` so the workflow file and
validator come from the **base** branch and a PR cannot weaken its own check. PR content is only read
as git blobs (`git show <sha>:<path>`); it is never checked out, installed or executed. Do not add a
step that does.

## The window (`scripts/window.mjs`)

A run covers the inputs added between the commit the last `dailies-*` tag points at and `cutoff_sha`.
The window is defined by commits, not by the clock, so a late scheduler cannot change what a run
contains. A run is skipped when its id already has a `MANIFEST.json` or when there are no new inputs
(unless `--allow-empty`). A fix is a new run with `--suffix r2`; it never overwrites.

## The taping

1. **Compression.** Every ordered pair: what *a* believes about *b*, from public canon and past
   transcripts only. Never private motivations (recorded in each file).
2. **Rehearsals.** Each character plays `takesPerCharacter` takes of `ideasPerTake` moves against the
   compressed others.
3. **Pool.** Moves are deduplicated into pool ideas with stable ids (`P-` plus a hash of input and
   approach, so the same idea keeps its id across days). Creatives' picks carry forward, rejects drop out.
4. **The take.** All characters, all pooled ideas, one scene. Every turn lists the pool ideas it used.
5. **Votes.** Each character ranks pool ideas and takes (every rehearsal take plus `T-final`) on a
   blind ballot, never their own. Borda tally. **Advisory**: ties and decisions go to the producer.
6. **Diffs.** Precomputed so a presentation layer only has to display them.

Everything is text, with stable ids, in `dailies/<run>/`:

```
MANIFEST.json   written last; every file with its sha256; complete: true
INDEX.md        window, counts, where to start
inputs/         the day's inputs, normalized, plus index.json (credit, reuse, provenance)
compression/    <a>__of__<b>.md
rehearsals/<c>/take-NN.md + .json
pool.json       merged ideas: origins, characters, carried, dropped_over_cap, dropped_rejected
take/           transcript.md, turns.jsonl
votes/          ballots.json (with blind labels), tally.json
diffs/          vs-previous, convergence, vote-splits, rehearsal-to-take,
                compression-error*, voice-drift*       (* not computed in stub mode)
```

## Rules that carry over from the writers' room

- **Immutable.** A finished run is never edited. `MANIFEST.json` with `complete: true` marks a finished
  run; a directory without one is incomplete.
- **Consent travels with the input** (`consent`, `credit`, `reuse`) and is copied into `inputs/index.json`.
- **Signals stay separate.** Character votes and creatives' reactions are creative signals; nothing
  here lets money or volume decide.
- **Cost is honest.** Stub runs say `stub`. Real runs record observed cost, or `unknown`, never free.

## One-time repo setup (a person has to do this)

1. Settings → General: enable **Allow auto-merge** and **Allow squash merging**.
2. Protect `main` (branch rule or ruleset): require a PR, require the status check **`validate`**,
   require code-owner review. `CODEOWNERS` covers everything except `inputs/` and `dailies/`, so input
   PRs are not blocked by it.
3. Let the daily run commit to `main`. `dailies.yml` pushes `dailies/<run>` directly, which a
   "require a pull request" rule blocks. Either allow GitHub Actions to bypass that rule (what I'd do),
   or change the workflow to open a PR for its output.
4. Settings → Actions → General → Workflow permissions: read and write.
5. Keep the repo private, or leave it public and rely on `collaborators.json`. Either way PRs from
   anyone not listed are rejected.

## Not built yet

- **Hermes behind the `llm` seam**: fresh profile per character per run, seeds pinned to dressing-room
  commits (`seeds/`, `PROVENANCE.json`), the room channel as the only tool, model keys kept out of the
  agents' environment.
- **Hash-chained event log** (`room/`) from the writers'-room engine. For now git history and the
  per-file hashes in each manifest are the record.
- **Comments on contributing PRs** linking to the pool ideas their input influenced.
- **Presentation layer** (a Pages build over `dailies/`).
- **Real compression-error and voice-drift diffs.**

## Stub behavior to revisit

An idea that *every* character reached independently cannot be ranked by anyone, because nobody may
vote on an idea they originated. That is consistent with the no-self-vote rule, but it hides the
strongest convergence from the ballots. `diffs/convergence.json` still shows it. Worth deciding
whether converged ideas should be rankable by everyone.
