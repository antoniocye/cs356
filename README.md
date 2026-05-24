# Phantom Dependencies

Reproducible research pipeline for measuring externally managed phantom
dependency candidates in npm and PyPI packages.

## Setup

Use Node 20 or newer.

```bash
npm install
npm test
npm audit --audit-level=moderate
```

The Dockerized npm depcheck runner is optional. It requires a running Docker
daemon:

```bash
npm run build:depcheck-image
```

## Reproduce the Results

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

## Data Collection Commands

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

## Generated Artifacts

Important generated files:

- `results/npm-analysis.json`: npm summary with coverage and filter diagnostics.
- `results/external-phantom-occurrences.csv`: npm occurrence table after closure
  and family filtering.
- `results/rollback-candidates.csv`: npm rollback-candidate table before
  resolver validation.
- `results/npm-resolver-validation.json`: resolver-backed npm vulnerability and
  rollback validation summary.
- `results/npm-resolver-validation.csv`: row-level npm resolver validation.
- `results/pypi-collected.csv`: PyPI static collector output.
- `results/pypi-collected-analysis.json`: PyPI collected-output analysis.
- `paper_usenix/`: USENIX-style LaTeX paper folder and built PDF.

## Methodology Notes

The npm analyzer uses a stricter definition than raw depcheck output:

1. depcheck reports a package as used but missing from direct dependencies.
2. the missing package exists in the package's transitive dependency closure.
3. the missing package is not in the same inferred family as the package under
   analysis.

Family inference uses npm scope and GitHub repository owner, and also honors
legacy family metadata already present in `database_manager_npm/database.json`.

Vulnerability data comes from OSV, which aggregates public advisory sources,
including GHSA entries for npm and PyPI packages. npm advisory-history
candidates are additionally checked with a resolver validation pass that records
reachability and observed installed versions.

OSV responses are cached locally under `cache/` when analyses run. The cache is
ignored by git because raw advisory payloads can contain example credentials or
other strings that trigger repository push protection; the published result
artifacts contain the summarized advisory data used by the paper.

Rollback values are candidates rather than an end-to-end exploit proof. The npm
pipeline reports both affected-range candidates and stricter advisory-level
range candidates, then validates whether those rows are reachable in actual npm
install layouts. The PyPI pipeline is static and does not make version-aware
rollback claims.
