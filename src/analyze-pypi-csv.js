import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./csv.js";
import { toCsv, writeJson, writeText } from "./fs-utils.js";
import {
  getOsvVulnerabilitiesForPackages,
  summarizeVulnerabilities,
} from "./osv.js";
import { barChartSvg, histogramSvg } from "./svg.js";

const PYPI_NAME_ALIASES = new Map(Object.entries({
  pil: "pillow",
  yaml: "pyyaml",
  jwt: "pyjwt",
  grpc: "grpcio",
  "typing_extensions": "typing-extensions",
  pydantic_core: "pydantic-core",
}));

const DEFAULT_PYPI_EXCLUDE = new Set([
  "build",
  "conftest",
  "coverage",
  "distutils",
  "flit-core",
  "git",
  "hatchling",
  "hatch-vcs",
  "hypothesis",
  "importlib-metadata",
  "mypy",
  "nox",
  "pkg-resources",
  "pip",
  "poetry",
  "poetry-core",
  "pre-commit",
  "pytest",
  "ruff",
  "setuptools",
  "sphinx",
  "typeshed",
  "tox",
  "twine",
  "wheel",
]);

const AMBIGUOUS_NAMESPACE_ROOTS = new Set([
  "azure",
  "google",
  "opentelemetry",
  "zope",
]);

function canonicalPypiName(name) {
  const normalized = String(name || "")
    .trim()
    .replaceAll("_", "-")
    .replace(/\.+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
  return PYPI_NAME_ALIASES.get(normalized) || normalized;
}

function shouldExcludePypiPhantom(name) {
  if (!name) return true;
  if (name.startsWith("-") || name.startsWith("_")) return true;
  if (DEFAULT_PYPI_EXCLUDE.has(name)) return true;
  if (AMBIGUOUS_NAMESPACE_ROOTS.has(name)) return true;
  return false;
}

function splitPhantoms(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => canonicalPypiName(item))
    .filter((item) => !shouldExcludePypiPhantom(item));
}

function histogram(values) {
  const bins = [
    { label: "0", min: 0, max: 0, count: 0 },
    { label: "1", min: 1, max: 1, count: 0 },
    { label: "2-5", min: 2, max: 5, count: 0 },
    { label: "6-10", min: 6, max: 10, count: 0 },
    { label: "11-25", min: 11, max: 25, count: 0 },
    { label: "26+", min: 26, max: Infinity, count: 0 },
  ];
  for (const value of values) {
    const bin = bins.find((candidate) => value >= candidate.min && value <= candidate.max);
    bin.count += 1;
  }
  return bins.map(({ label, count }) => ({ label, count }));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function analyzePypiCsv({
  csvFile = "results/pypi-collected.csv",
  outFile = "results/pypi-collected-analysis.json",
  osvCacheFile = "cache/osv-pypi.json",
  osvConcurrency = 24,
  logger = console,
} = {}) {
  const isFreshCollectorOutput = csvFile.includes("pypi-collected");
  const artifactPrefix = path.basename(outFile, ".json").replace(/-analysis$/, "");
  const text = await fs.readFile(csvFile, "utf8");
  const rows = parseCsv(text);
  const successRows = rows.filter((row) => row.status === "success");
  const phantomOccurrences = new Map();
  const packagesByPhantom = new Map();

  for (const row of successRows) {
    for (const phantomName of splitPhantoms(row.phantom_deps)) {
      phantomOccurrences.set(phantomName, (phantomOccurrences.get(phantomName) || 0) + 1);
      if (!packagesByPhantom.has(phantomName)) packagesByPhantom.set(phantomName, new Set());
      packagesByPhantom.get(phantomName).add(row.package_name);
    }
  }

  const uniquePhantoms = [...phantomOccurrences.keys()].sort();
  const osvByPackage = await getOsvVulnerabilitiesForPackages(uniquePhantoms, {
    ecosystem: "PyPI",
    cacheFile: osvCacheFile,
    concurrency: osvConcurrency,
    logger,
  });

  const phantomRows = uniquePhantoms
    .map((phantomName) => {
      const vuln = summarizeVulnerabilities(
        phantomName,
        null,
        osvByPackage.get(phantomName) || [],
        { ecosystem: "PyPI" },
      );
      return {
        phantomName,
        occurrences: phantomOccurrences.get(phantomName),
        packages: packagesByPhantom.get(phantomName)?.size || 0,
        vulnerabilityCount: vuln.vulnerabilityCount,
        fixedAvailable: vuln.fixedAvailable,
        maxSeverity: vuln.maxSeverity,
        advisoryIds: vuln.advisoryIds,
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences || a.phantomName.localeCompare(b.phantomName));

  const vulnerable = phantomRows.filter((row) => row.vulnerabilityCount > 0);
  const severityCounts = {};
  for (const row of vulnerable) {
    const label = row.maxSeverity || "UNKNOWN";
    severityCounts[label] = (severityCounts[label] || 0) + 1;
  }

  const packageRows = successRows.map((row) => {
    const phantoms = splitPhantoms(row.phantom_deps);
    const vulnerablePhantoms = phantoms.filter((name) => (
      phantomRows.find((phantom) => phantom.phantomName === name)?.vulnerabilityCount || 0
    ) > 0);
    return {
      packageName: row.package_name,
      rank: Number(row.rank || 0),
      downloads: Number(row.downloads || 0),
      phantomCount: phantoms.length,
      vulnerablePhantomCount: vulnerablePhantoms.length,
      phantomDeps: phantoms,
    };
  });
  const phantomCounts = packageRows.map((row) => row.phantomCount);

  const summary = {
    generatedAt: new Date().toISOString(),
    inputs: {
      csvFile,
      osvCacheFile,
      rows: rows.length,
    },
    methodologyNotes: isFreshCollectorOutput ? [
      "This analysis summarizes results from pypi_pipeline/pypi_phantoms.py, the reproducible static collector.",
      "The collector clones source repositories, parses declared dependencies from common Python manifests, AST-scans imports, filters stdlib/local modules, and records static phantom candidates.",
      "Analysis excludes obvious build/test/tooling artifacts, private imports, and ambiguous namespace roots such as google and azure.",
      "This remains conservative static analysis rather than a full Python packaging resolver; optional dependency and import-name false positives are still possible.",
      "Vulnerabilities are queried from OSV for PyPI package names.",
    ] : [
      "This analysis summarizes a PyPI CSV with static phantom dependency candidates.",
      "Analysis excludes obvious build/test/tooling artifacts, private imports, and ambiguous namespace roots such as google and azure.",
      "It does not perform Python resolver validation or version-aware vulnerability assessment.",
      "Vulnerabilities are queried from OSV for PyPI package names.",
    ],
    packages: {
      totalRows: rows.length,
      successfulAnalyses: successRows.length,
      failedAnalyses: rows.length - successRows.length,
      packagesWithPhantoms: packageRows.filter((row) => row.phantomCount > 0).length,
      phantomCountPerSuccessfulPackage: {
        mean: mean(phantomCounts),
        median: median(phantomCounts),
        max: Math.max(0, ...phantomCounts),
      },
    },
    phantoms: {
      uniquePhantoms: uniquePhantoms.length,
      totalOccurrences: [...phantomOccurrences.values()].reduce((total, value) => total + value, 0),
      topPhantoms: phantomRows.slice(0, 20),
    },
    vulnerabilities: {
      vulnerablePhantoms: vulnerable.length,
      vulnerablePhantomOccurrences: vulnerable.reduce((total, row) => total + row.occurrences, 0),
      packagesWithVulnerablePhantoms: packageRows
        .filter((row) => row.vulnerablePhantomCount > 0).length,
      rollbackCandidatePhantoms: vulnerable.filter((row) => row.fixedAvailable).length,
      severityCounts,
      topVulnerablePhantoms: vulnerable.slice(0, 20),
    },
  };

  const baseDir = path.dirname(outFile);
  await Promise.all([
    writeJson(outFile, summary),
    writeText(
      path.join(baseDir, `${artifactPrefix}-package-summary.csv`),
      toCsv(packageRows, [
        "packageName",
        "rank",
        "downloads",
        "phantomCount",
        "vulnerablePhantomCount",
        "phantomDeps",
      ]),
    ),
    writeText(
      path.join(baseDir, `${artifactPrefix}-phantoms.csv`),
      toCsv(phantomRows, [
        "phantomName",
        "occurrences",
        "packages",
        "vulnerabilityCount",
        "fixedAvailable",
        "maxSeverity",
        "advisoryIds",
      ]),
    ),
    writeText(
      path.join(baseDir, `fig-${artifactPrefix}-top-phantoms.svg`),
      barChartSvg({
        title: isFreshCollectorOutput
          ? "Top PyPI phantom packages in collected dataset"
          : "Top PyPI phantom packages in CSV dataset",
        rows: phantomRows.slice(0, 15).map((row) => ({
          label: row.phantomName,
          value: row.occurrences,
        })),
        color: "#8854d0",
      }),
    ),
    writeText(
      path.join(baseDir, `fig-${artifactPrefix}-phantom-histogram.svg`),
      histogramSvg({
        title: "PyPI phantom counts per successful package analysis",
        bins: histogram(phantomCounts),
        color: "#2bcbba",
      }),
    ),
  ]);

  return summary;
}
