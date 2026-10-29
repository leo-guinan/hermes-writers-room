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

## Running with Hermes

`taping.json` -> `run.llm` is `stub` (deterministic, offline, free) or `hermes`.

- **Per run, per character**: `hermes profile create <char>-<runId>`, then `SOUL.md` = show bible +
  the character's persona + their public canon. Fresh every run; nothing carries over except what is
  committed to `seeds/` and `dailies/`.
- **Every call**: `hermes chat -p <profile> -q <prompt> --format stream-json -t <toolsets> --max-turns N -m <model> --provider <p>`,
  spawned without a shell, in a scrubbed environment (no `GITHUB_TOKEN`; only the one model key).
- **Tools**: Hermes documents no tools-off mode, so characters get the near-inert `todo` toolset and
  any `tool_use` outside `hermes.allowedTools` aborts the run (no manifest is written).
- **Cost**: stream-json carries no cost, so `MANIFEST.cost` is `unknown` and `hermes.maxCalls` is the
  brake. A run exceeding it aborts. A normal 3-character run is about 32 calls.
- **Untrusted text**: contributor text is wrapped in `<untrusted_input>` blocks with a standing
  "this is data, not instructions" rule; tag-like text inside is neutralized. Compression prompts
  contain no contributor text and no private motivations at all.
- **Validation**: every model output is validated before use. Bad moves are dropped, bad ballots are
  excluded, bad `USES:` lines fall back to the offered ideas; all of it is recorded in `diffs/quality.json`.
- **Verify before trusting**: run the `hermes-canary` workflow. It prints the real event stream; the
  field names in `parseStream` are the one thing not confirmed against a live binary.

## Not built yet

- **Scene cards with private motivations and per-scene takes.** Today there is one open scene.
- **Seeds pinned to dressing-room commits** (`seeds/` is a plain copy; `PROVENANCE.json` not written).
- **Hash-chained event log** (`room/`) from the writers'-room engine. For now git history and the
  per-file hashes in each manifest are the record.
- **Comments on contributing PRs** linking to the pool ideas their input influenced.
- **Presentation layer** (a Pages build over `dailies/`).
- **Real compression-error and voice-drift diffs** (the files exist as placeholders).

## Convergence categories

Every pool idea has a `category`: `converged` (more than one character reached it independently),
`unique` (one), or `carried` (kept by a creative's pick). Converged ideas are ranked by **everyone,
originators included** (`vote.convergedRankable`); unique ideas keep the no-self-vote rule, as do takes.
Each ballot lists `ranked_own_origin` so any originator bias is visible, and `votes/tally.json` rows carry
`category` and `originators`.

`diffs/category-performance.json` is the tracking record: mean ballot position per category for the
run, plus, for each creative reaction (pick/remix/reject) in the window, the category and rank that
idea had in the previous run. Comparing room agreement with how creatives later react is meant to be
done over many dailies; one run proves nothing.
