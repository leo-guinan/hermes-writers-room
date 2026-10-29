# Hermes Writers' Room

A daily "taping" for a show, run entirely through GitHub. Creatives send in ideas, notes and
reactions as pull requests. Once a day, a set of AI characters (each a fresh
[Hermes Agent](https://hermes-agent.nousresearch.com) instance) rehearse, play one scene together,
and vote. Everything they produce is committed as plain text under `dailies/<date>/`, so the next
morning the creatives can read it, compare it with yesterday, and react with more PRs.

It adapts the [Future Radio writers' room](https://github.com/leo-guinan) model: fixed roles, swappable
characters, a public record. The votes are **advisory**. The creatives decide.

```
creative / Art Bus ──PR──▶ validate ──auto-merge──▶ inputs/YYYY-MM-DD/<slug>.md
                                                          │  (commit window)
                          daily Action ◀──────────────────┘
                               │  compression → rehearsals → pool → take → votes → diffs
                               ▼
                       dailies/<date>/  ──▶ creatives react (PRs) ──▶ next day
```

## What happens in a taping

1. **Window.** The inputs merged since the last `dailies-*` tag, fixed by commit (not by clock), so a
   late scheduler can't change what a run contains.
2. **Compression.** Each character writes a short model of every other character from public
   material only (persona and public canon). Private motivations and today's inputs are never used.
3. **Rehearsals.** Each character, alone, runs a configurable number of takes. Each take tries several
   ideas on today's material, using their compressions of the others.
4. **Pool.** All rehearsal ideas are deduplicated into one pool with stable ids (`P-xxxxxxxx`).
   Creatives' earlier picks carry in; rejects stay out.
5. **The take.** All characters play the whole pool together as one scene.
6. **Votes.** Each character ranks the pooled ideas and the takes, blind (authors hidden). Nobody
   ranks their own take or an idea only they came up with. Ideas that several characters reached
   independently (`converged`) are ranked by everyone.
7. **Diffs.** Precomputed comparisons so a presentation layer can show what changed: versus
   yesterday, convergence, vote splits, rehearsal-to-take, category performance, and a quality log of
   everything a model returned that was dropped.

## Sending an input

Open a PR that **only adds** `inputs/YYYY-MM-DD/<slug>.md`:

```markdown
---
kind: idea                 # idea | note | goal | asset | reaction
title: The door opens on a different year
consent: true
credit: true
credit_name: Leo
reuse: show-only           # cc-by | show-only | ask-first
source: yesterday's walk   # required for ideas
provenance:
  via: direct
  submitted_by: your-github-login
---
What if the door opens onto a different year each time?
```

A check validates it and, if valid, the PR merges automatically. Only collaborators listed in
`collaborators.json` can submit. To react to yesterday's output, use `kind: reaction` with
`reaction: {action: pick | remix | reject, target: P-…, reason: …}`. Inputs are append-only: a
correction is a new input. The full schema is in [`schemas/input.schema.json`](schemas/input.schema.json).

The Art Bus will eventually open these PRs and record provenance (`via: art-bus` plus message id,
receipt time and the original message's hash). See [`docs/DAILIES.md`](docs/DAILIES.md).

## What you get

```
dailies/2026-10-30/
  INDEX.md               start here
  MANIFEST.json          written last; every file with its sha256; cost; model calls
  inputs/                what went in
  compression/           each character's model of each other
  rehearsals/<char>/     every rehearsal take, as text and JSON
  pool.json              pooled ideas, with category and who originated them
  take/                  transcript.md and turns.jsonl
  votes/                 ballots.json (blind labels) and tally.json (Borda, advisory)
  diffs/                 vs-previous, convergence, category-performance, vote-splits,
                         rehearsal-to-take, quality
```

Dailies are immutable. A fix is a new run with a suffix (`2026-10-30-r2`), never an overwrite.

## Safety model

- Contributor text reaches the models only inside `<untrusted_input>` blocks, with a standing rule
  that it is data, not instructions.
- Input validation runs trusted code from the base branch. PR content is read as git blobs and is
  never checked out or executed.
- Each Hermes call runs without a shell, in a scrubbed environment: it gets the one model API key and
  nothing else (no `GITHUB_TOKEN`).
- Hermes has no documented tools-off mode, so characters get the near-inert `todo` toolset and any
  other tool use aborts the run with no manifest.
- Cost can't be read from Hermes output, so a call cap (`hermes.maxCalls`) is the brake.

## Running it

```
npm ci
npm test                                        # includes a fake Hermes binary
node scripts/window.mjs --date 2026-10-30 > window.json
node scripts/run-taping.mjs --window window.json            # uses run.llm from taping.json
node scripts/run-taping.mjs --window window.json --llm stub # offline, deterministic
```

The stub writes the full structure with placeholder text, so everything downstream can be built
without spending anything. Set `run.llm` to `hermes` in `taping.json` only after the
`hermes-canary` workflow has passed against the real binary.

## Configuration

`taping.json` is producer-owned (see `.github/CODEOWNERS`): the cast, rehearsal takes per character,
ideas per take, pool size and lenses, turn limit, vote rules, and the Hermes model, provider,
toolsets and call cap. Character seeds live in `seeds/<name>/` (`CHARACTER.md`, `CANON.md`), with the
shared `seeds/SHOW_BIBLE.md`. The cast is a placeholder (Borges, Leonardo, Agnolo) until replaced.

## Repo setup (one time)

1. Settings → Actions → General: workflow permissions read and write; allow auto-merge.
2. A ruleset on the default branch requiring a PR, the `validate` check and code-owner review, with
   GitHub Actions allowed to bypass so the daily run can push `dailies/`.
3. Secret `OPENROUTER_API_KEY`.
4. Run the `hermes-canary` workflow, then switch `run.llm` to `hermes`.

## Not built yet

Scene cards with private motivations, seeds pinned to dressing-room commits, a hash-chained event
log, PR comments crediting contributors, the presentation layer, and real compression-error and
voice-drift diffs. Details in [`docs/DAILIES.md`](docs/DAILIES.md).
