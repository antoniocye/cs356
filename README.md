# Phantom Dependencies

This repository contains the code, data artifacts, and paper for a measurement
study of phantom dependencies in npm and PyPI.

**Study PDF:** [Phantom Dependencies: Ghost Busting](paper_usenix/main.pdf)  
**LaTeX source:** [paper_usenix/main.tex](paper_usenix/main.tex)

## Overview

A phantom dependency is a package that project code imports or requires without
declaring it as a direct dependency. The project may still be able to access the
package because another dependency installs it transitively. This repository
measures externally managed phantom dependencies: cases where the phantom
package is present in the dependency closure and is outside the inferred
maintainer family of the package using it.

The current paper reports:

- npm: 118 unique externally managed phantom packages across 567 seed-closure
  occurrences in the top-1,000 package study.
- npm resolver validation: 18 reachable affected-version rows across 5 seeds.
- npm rollback analysis: 15 reachable strict rollback-candidate rows across 6
  seeds.
- PyPI: 801 successful static source analyses, with 593 packages containing at
  least one filtered phantom candidate.

PyPI vulnerability results are reported as advisory-history signals only; they
are not version-resolved exploitability claims.

## Repository Layout

- `bin/cs356.js`: command-line entry point for analysis tasks.
- `src/`: npm/PyPI analysis, OSV querying, resolver validation, and utilities.
- `pypi_pipeline/`: PyPI source collector and static import scanner.
- `database_manager_npm/`: npm database and Dockerized depcheck runner.
- `results/`: generated CSV/JSON/SVG artifacts used by the study.
- `paper_usenix/`: USENIX-style LaTeX paper folder and built PDF.
- `data/`: publication-facing seed inputs.
- `test/`: Node test suite for core helpers.

## Setup

Use Node 20 or newer.

```bash
npm install
npm run check
```

The Dockerized npm depcheck runner is optional and requires a running Docker
daemon:

```bash
npm run build:depcheck-image
```

## Reproduce the Main Artifacts

Analyze the checked-in npm database and top-1,000 seed set:

```bash
npm run analyze:npm
```

Validate npm security-relevant candidates in real npm install layouts:

```bash
npm run validate:npm -- --concurrency 16
```

Run the PyPI static collector:

```bash
python3 pypi_pipeline/pypi_phantoms.py \
  --input data/pypi/top1000.csv \
  --out results/pypi-collected.csv \
  --workers 16 \
  --clone-timeout 75 \
  --resume
```

Analyze the collected PyPI output:

```bash
npm run analyze:pypi
```

Build the paper:

```bash
npm run paper
```

## Additional npm Collection Commands

Collect a fresh top-N npm seed set:

```bash
node bin/cs356.js collect-npm-top \
  --out data/npm/top1000.json \
  --limit 1000 \
  --concurrency 64
```

Build an npm dependency database from a seed file:

```bash
node bin/cs356.js build-npm-db \
  --db data/npm/database.json \
  --seeds data/npm/top1000.json
```

Run Dockerized depcheck over a database:

```bash
node bin/cs356.js depcheck-npm \
  --db data/npm/database.json \
  --concurrency 20
```

## Notes

Vulnerability data comes from OSV, which aggregates public advisory sources
including GHSA entries for npm and PyPI packages. OSV responses are cached
locally under `cache/` when analyses run. That directory is ignored by git
because raw advisory payloads can contain example credentials or other strings
that trigger repository push protection; the published result artifacts contain
the summarized advisory data used by the paper.

Rollback values are candidates rather than end-to-end exploit proofs. The npm
pipeline reports both affected-range candidates and stricter advisory-level
range candidates, then validates whether those rows are reachable in actual npm
install layouts. The PyPI pipeline is static and does not make version-aware
rollback claims.
