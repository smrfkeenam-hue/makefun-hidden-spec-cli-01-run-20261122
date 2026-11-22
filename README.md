# mend

One patch tool for every AI edit format. `mend` reads an edit a model wrote —
a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the
V4A patch format, or text-editor tool calls as JSON — and applies it to a
tree of text files, every change or none.

## Run

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, or `-` / absent for standard input.
- `--format=NAME` forces one format (`unified`, `search-replace`, `v4a`,
  `json`); the default `auto` detects it.
- `--check` does everything but write: same output and exit code, no file
  is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Each edit names old lines that are found at the first of three matching
tiers: exact, trailing-whitespace-tolerant, both-sides-whitespace-tolerant
(with tier-2 re-indentation). A patch that changes nothing prints
`ok: 0 files`; a failed edit reports `error: <code> <path>` and
`failed: <k> of <n> edits`, and nothing is written. See SPEC.md for the
whole contract.

## Practice score

100/100 checks (score 1000) on the kit's public practice set, verified
with `node check.ts <practice.json>` and with the kit's own
`grade-local` (replay matched byte for byte). Node 22, standard library
only; no model calls.
