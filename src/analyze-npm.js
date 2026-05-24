import path from "node:path";
import { buildFamilyIndex, packagesShareFamily } from "./families.js";
import { readJson, toCsv, writeJson, writeText } from "./fs-utils.js";
import {
  getOsvVulnerabilitiesForPackages,
  providerRangeRollbackStatus,
  summarizeVulnerabilities,
} from "./osv.js";
import { barChartSvg, histogramSvg } from "./svg.js";

function seedName(row) {
  if (Array.isArray(row)) return row[1];
  return row.name || row.packageName;
}

function seedDownloads(row) {
  if (Array.isArray(row)) return Number(row[0] || 0);
  return Number(row.downloads || 0);
}

function depsFor(db, packageName) {
  return Object.keys(db.packages?.[packageName]?.deps || {});
}

export function makeClosureComputer(db) {
  const cache = new Map();

  function closure(packageName) {
    if (cache.has(packageName)) return cache.get(packageName);

    const seen = new Set();
    const stack = depsFor(db, packageName);
    while (stack.length > 0) {
      const dep = stack.pop();
      if (seen.has(dep)) continue;
      seen.add(dep);
      for (const transitive of depsFor(db, dep)) {
        if (!seen.has(transitive)) stack.push(transitive);
      }
    }

    cache.set(packageName, seen);
    return seen;
  }

  return closure;
}

function histogram(values) {
  const bins = [
    { label: "0", min: 0, max: 0, count: 0 },
    { label: "1", min: 1, max: 1, count: 0 },
    { label: "2-5", min: 2, max: 5, count: 0 },
    { label: "6-10", min: 6, max: 10, count: 0 },
    { label: "11-25", min: 11, max: 25, count: 0 },
    { label: "26-50", min: 26, max: 50, count: 0 },
    { label: "51-100", min: 51, max: 100, count: 0 },
    { label: "101+", min: 101, max: Infinity, count: 0 },
  ];
  for (const value of values) {
    const bin = bins.find((candidate) => value >= candidate.min && value <= candidate.max);
    bin.count += 1;
  }
  return bins.map(({ label, count }) => ({ label, count }));
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function addCount(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function sortCountMap(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function packagePhantoms(db, closureFor, packageKeys, packageName, diagnostics = null) {
  const packageRecord = db.packages?.[packageName];
  if (!packageRecord?.depcheck_result) {
    diagnostics?.missingDepcheckPackages.add(packageName);
    return [];
  }
  if (!packageRecord.depcheck_result.ok) {
    diagnostics?.failedDepcheckPackages.add(packageName);
    return [];
  }
  const rawPhantoms = packageRecord?.depcheck_result?.phantomDeps || [];
  if (rawPhantoms.length === 0) return [];

  const dependencyClosure = closureFor(packageName);
  const filtered = [];
  for (const phantomName of rawPhantoms) {
    diagnostics?.rawDepcheckPairs.add(`${packageName}\0${phantomName}`);
    diagnostics?.rawDepcheckPhantoms.add(phantomName);
    if (!db.packages?.[phantomName]) {
      diagnostics?.notInDatabasePairs.add(`${packageName}\0${phantomName}`);
      diagnostics?.notInDatabasePhantoms.add(phantomName);
      continue;
    }
    diagnostics?.databasePresentPairs.add(`${packageName}\0${phantomName}`);
    diagnostics?.databasePresentPhantoms.add(phantomName);
    if (!dependencyClosure.has(phantomName)) {
      diagnostics?.notInTransitiveClosurePairs.add(`${packageName}\0${phantomName}`);
      diagnostics?.notInTransitiveClosurePhantoms.add(phantomName);
      continue;
    }
    diagnostics?.transitiveConfirmedPairs.add(`${packageName}\0${phantomName}`);
    diagnostics?.transitiveConfirmedPhantoms.add(phantomName);
    if (packagesShareFamily(packageKeys, packageName, phantomName)) {
      diagnostics?.sameFamilyPairs.add(`${packageName}\0${phantomName}`);
      diagnostics?.sameFamilyPhantoms.add(phantomName);
      continue;
    }
    diagnostics?.retainedPairs.add(`${packageName}\0${phantomName}`);
    diagnostics?.retainedPhantoms.add(phantomName);
    filtered.push({
      packageName,
      packageVersion: packageRecord.version || null,
      phantomName,
      phantomVersion: db.packages[phantomName]?.version || null,
    });
  }
  return filtered;
}

function writeAnalysisArtifacts({
  outFile,
  summary,
  seedSummaries,
  phantomOccurrences,
  vulnerablePhantoms,
  rootPhantoms,
  rollbackRows,
  detailedOccurrences,
}) {
  const baseDir = path.dirname(outFile);
  const writes = [
    writeJson(outFile, summary),
    writeText(
      path.join(baseDir, "seed-summary.csv"),
      toCsv(seedSummaries, [
        "seed",
        "downloads",
        "closureSize",
        "closureExternalPhantomCount",
        "rootExternalPhantomCount",
        "vulnerablePhantomCount",
        "observedAffectedPhantomCount",
        "rollbackCandidatePhantomCount",
        "strictRollbackVulnerable",
        "affectedRangeRollbackCandidate",
        "depcheckOkPackages",
        "depcheckFailedPackages",
        "depcheckMissingPackages",
        "depcheckCoverage",
        "fullyDepcheckCovered",
      ]),
    ),
    writeText(
      path.join(baseDir, "phantom-occurrences.csv"),
      toCsv(phantomOccurrences, ["phantomName", "occurrences", "seeds", "packages"]),
    ),
    writeText(
      path.join(baseDir, "external-phantom-occurrences.csv"),
      toCsv(detailedOccurrences, [
        "seed",
        "usingPackage",
        "usingVersion",
        "phantomName",
        "phantomVersion",
      ]),
    ),
    writeText(
      path.join(baseDir, "vulnerable-phantoms.csv"),
      toCsv(vulnerablePhantoms, [
        "phantomName",
        "version",
        "occurrences",
        "vulnerabilityCount",
        "affectedNowCount",
        "fixedAvailable",
        "maxSeverity",
        "advisoryIds",
      ]),
    ),
    writeText(
      path.join(baseDir, "root-phantoms.csv"),
      toCsv(rootPhantoms, ["seed", "phantomName", "phantomVersion"]),
    ),
    writeText(
      path.join(baseDir, "rollback-candidates.csv"),
      toCsv(rollbackRows, [
        "seed",
        "usingPackage",
        "phantomName",
        "providerPackage",
        "providerRange",
        "status",
        "advisoryIds",
        "strictAdvisoryIds",
        "fixedVersions",
      ]),
    ),
    writeText(
      path.join(baseDir, "fig-top-phantoms.svg"),
      barChartSvg({
        title: "Top externally managed npm phantom dependencies",
        rows: phantomOccurrences.slice(0, 15).map((row) => ({
          label: row.phantomName,
          value: row.occurrences,
        })),
        color: "#3867d6",
      }),
    ),
    writeText(
      path.join(baseDir, "fig-phantom-histogram.svg"),
      histogramSvg({
        title: "External phantom counts per npm seed closure",
        bins: histogram(seedSummaries.map((row) => row.closureExternalPhantomCount)),
      }),
    ),
    writeText(
      path.join(baseDir, "fig-root-phantom-histogram.svg"),
      histogramSvg({
        title: "Root-level external phantom counts per npm seed",
        bins: histogram(seedSummaries.map((row) => row.rootExternalPhantomCount)),
        color: "#fa8231",
      }),
    ),
  ];

  const severityRows = Object.entries(summary.vulnerabilities.severityCounts)
    .map(([label, value]) => ({ label, value }));
  if (severityRows.length > 0) {
    writes.push(writeText(
      path.join(baseDir, "fig-severity.svg"),
      barChartSvg({
        title: "Severity of vulnerable npm phantom packages",
        rows: severityRows,
        color: "#eb3b5a",
      }),
    ));
  }

  return Promise.all(writes);
}

export async function analyzeNpm({
  dbFile,
  seedsFile,
  outFile = "results/npm-analysis.json",
  osvCacheFile = "cache/osv-npm.json",
  osvConcurrency = 24,
  includeAuthorHeuristics = false,
  logger = console,
} = {}) {
  const db = await readJson(dbFile);
  const seedRows = await readJson(seedsFile, []);
  const seeds = seedRows.map((row) => ({
    name: seedName(row),
    downloads: seedDownloads(row),
  })).filter((row) => row.name);

  const closureFor = makeClosureComputer(db);
  const packageKeys = buildFamilyIndex(db, { includeAuthorHeuristics });
  const diagnostics = Object.fromEntries([
    "rawDepcheckPairs",
    "rawDepcheckPhantoms",
    "notInDatabasePairs",
    "notInDatabasePhantoms",
    "databasePresentPairs",
    "databasePresentPhantoms",
    "notInTransitiveClosurePairs",
    "notInTransitiveClosurePhantoms",
    "transitiveConfirmedPairs",
    "transitiveConfirmedPhantoms",
    "sameFamilyPairs",
    "sameFamilyPhantoms",
    "retainedPairs",
    "retainedPhantoms",
    "failedDepcheckPackages",
    "missingDepcheckPackages",
  ].map((key) => [key, new Set()]));

  const allPackageNames = Object.keys(db.packages || {});
  const depcheckOkPackages = allPackageNames
    .filter((packageName) => db.packages?.[packageName]?.depcheck_result?.ok).length;
  const depcheckFailedPackages = allPackageNames
    .filter((packageName) => db.packages?.[packageName]?.depcheck_result && !db.packages[packageName].depcheck_result.ok).length;
  const depcheckMissingPackages = allPackageNames.length - depcheckOkPackages - depcheckFailedPackages;

  const phantomsByPackage = new Map();
  for (const packageName of Object.keys(db.packages || {})) {
    phantomsByPackage.set(
      packageName,
      packagePhantoms(db, closureFor, packageKeys, packageName, diagnostics),
    );
  }

  const occurrenceCounts = new Map();
  const occurrenceSeeds = new Map();
  const occurrencePackages = new Map();
  const rootPhantomRows = [];
  const seedSummaries = [];
  const allClosureOccurrences = [];

  for (const seed of seeds) {
    const closure = closureFor(seed.name);
    const closureWithRoot = new Set([seed.name, ...closure]);
    const closurePackageNames = [...closureWithRoot];
    const seedDepcheckOk = closurePackageNames
      .filter((packageName) => db.packages?.[packageName]?.depcheck_result?.ok).length;
    const seedDepcheckFailed = closurePackageNames
      .filter((packageName) => db.packages?.[packageName]?.depcheck_result && !db.packages[packageName].depcheck_result.ok).length;
    const seedDepcheckMissing = closurePackageNames.length - seedDepcheckOk - seedDepcheckFailed;
    const seedPhantomNames = new Set();
    const seedVulnerableNames = new Set();
    const seedAffectedNames = new Set();
    const seedRollbackNames = new Set();
    const rootPhantoms = phantomsByPackage.get(seed.name) || [];

    for (const rootPhantom of rootPhantoms) {
      rootPhantomRows.push({
        seed: seed.name,
        phantomName: rootPhantom.phantomName,
        phantomVersion: rootPhantom.phantomVersion,
      });
    }

    for (const packageName of closureWithRoot) {
      for (const phantom of phantomsByPackage.get(packageName) || []) {
        const key = `${seed.name}\0${packageName}\0${phantom.phantomName}`;
        allClosureOccurrences.push({ key, seed: seed.name, ...phantom });
        seedPhantomNames.add(phantom.phantomName);
        addCount(occurrenceCounts, phantom.phantomName);
        if (!occurrenceSeeds.has(phantom.phantomName)) occurrenceSeeds.set(phantom.phantomName, new Set());
        if (!occurrencePackages.has(phantom.phantomName)) occurrencePackages.set(phantom.phantomName, new Set());
        occurrenceSeeds.get(phantom.phantomName).add(seed.name);
        occurrencePackages.get(phantom.phantomName).add(packageName);
      }
    }

    seedSummaries.push({
      seed: seed.name,
      downloads: seed.downloads,
      closureSize: closure.size,
      closureExternalPhantomCount: seedPhantomNames.size,
      rootExternalPhantomCount: new Set(rootPhantoms.map((row) => row.phantomName)).size,
      vulnerablePhantomCount: seedVulnerableNames.size,
      observedAffectedPhantomCount: seedAffectedNames.size,
      rollbackCandidatePhantomCount: seedRollbackNames.size,
      depcheckOkPackages: seedDepcheckOk,
      depcheckFailedPackages: seedDepcheckFailed,
      depcheckMissingPackages: seedDepcheckMissing,
      depcheckCoverage: closurePackageNames.length ? seedDepcheckOk / closurePackageNames.length : 0,
      fullyDepcheckCovered: seedDepcheckFailed === 0 && seedDepcheckMissing === 0,
    });
  }

  const uniquePhantoms = [...occurrenceCounts.keys()].sort();
  const osvByPackage = await getOsvVulnerabilitiesForPackages(uniquePhantoms, {
    ecosystem: "npm",
    cacheFile: osvCacheFile,
    concurrency: osvConcurrency,
    logger,
  });

  const vulnSummaryByName = new Map();
  for (const phantomName of uniquePhantoms) {
    const version = db.packages?.[phantomName]?.version || null;
    vulnSummaryByName.set(
      phantomName,
      summarizeVulnerabilities(phantomName, version, osvByPackage.get(phantomName) || []),
    );
  }

  const rollbackRows = [];
  const seedsWithStrictRollback = new Set();
  const seedsWithWeakRollback = new Set();
  const packagesWithStrictRollback = new Set();
  const packagesWithWeakRollback = new Set();

  for (const occurrence of allClosureOccurrences) {
    const vulns = osvByPackage.get(occurrence.phantomName) || [];
    if (vulns.length === 0) continue;

    for (const providerPackage of closureFor(occurrence.packageName)) {
      const providerRange = db.packages?.[providerPackage]?.deps?.[occurrence.phantomName];
      if (!providerRange) continue;

      const status = providerRangeRollbackStatus(providerRange, vulns, {
        ecosystem: "npm",
        packageName: occurrence.phantomName,
      });
      if (!status.validRange || !status.intersectsAffected) continue;

      const rowStatus = status.excludesKnownFixed
        ? "strict-vulnerable"
        : "affected-range-admitted";
      rollbackRows.push({
        seed: occurrence.seed,
        usingPackage: occurrence.packageName,
        phantomName: occurrence.phantomName,
        providerPackage,
        providerRange,
        status: rowStatus,
        advisoryIds: status.advisoryIds,
        strictAdvisoryIds: status.strictAdvisoryIds,
        fixedVersions: status.fixedVersions,
      });

      seedsWithWeakRollback.add(occurrence.seed);
      packagesWithWeakRollback.add(occurrence.packageName);
      if (status.excludesKnownFixed) {
        seedsWithStrictRollback.add(occurrence.seed);
        packagesWithStrictRollback.add(occurrence.packageName);
      }
    }
  }

  for (const seedSummary of seedSummaries) {
    const seedPhantoms = new Set(
      allClosureOccurrences
        .filter((row) => row.seed === seedSummary.seed)
        .map((row) => row.phantomName),
    );
    const vulnerable = [...seedPhantoms].filter((name) => vulnSummaryByName.get(name)?.vulnerableEver);
    const affected = [...seedPhantoms].filter((name) => vulnSummaryByName.get(name)?.affectedNow);
    const rollback = [...seedPhantoms].filter((name) => vulnSummaryByName.get(name)?.fixedAvailable);
    seedSummary.vulnerablePhantomCount = vulnerable.length;
    seedSummary.observedAffectedPhantomCount = affected.length;
    seedSummary.rollbackCandidatePhantomCount = rollback.length;
    seedSummary.strictRollbackVulnerable = seedsWithStrictRollback.has(seedSummary.seed);
    seedSummary.affectedRangeRollbackCandidate = seedsWithWeakRollback.has(seedSummary.seed);
  }

  const severityCounts = {};
  for (const summary of vulnSummaryByName.values()) {
    if (!summary.vulnerableEver) continue;
    const label = summary.maxSeverity || "UNKNOWN";
    severityCounts[label] = (severityCounts[label] || 0) + 1;
  }

  const phantomOccurrences = sortCountMap(occurrenceCounts).map((row) => ({
    phantomName: row.name,
    occurrences: row.count,
    seeds: occurrenceSeeds.get(row.name)?.size || 0,
    packages: occurrencePackages.get(row.name)?.size || 0,
  }));

  const vulnerablePhantoms = phantomOccurrences
    .map((row) => {
      const vuln = vulnSummaryByName.get(row.phantomName);
      return {
        ...row,
        version: vuln?.version || null,
        vulnerabilityCount: vuln?.vulnerabilityCount || 0,
        affectedNowCount: vuln?.affectedNowCount || 0,
        fixedAvailable: Boolean(vuln?.fixedAvailable),
        maxSeverity: vuln?.maxSeverity || null,
        advisoryIds: vuln?.advisoryIds || [],
      };
    })
    .filter((row) => row.vulnerabilityCount > 0);

  const closureCounts = seedSummaries.map((row) => row.closureExternalPhantomCount);
  const rootCounts = seedSummaries.map((row) => row.rootExternalPhantomCount);
  const summary = {
    generatedAt: new Date().toISOString(),
    inputs: {
      dbFile,
      seedsFile,
      osvCacheFile,
      seedCount: seeds.length,
      databasePackageCount: Object.keys(db.packages || {}).length,
      familyCount: (db.families || []).length,
      includeAuthorHeuristics,
    },
    methodologyNotes: [
      "Phantoms are retained only when depcheck reported the package as missing, the package appears in the analyzed package's transitive dependency closure, and the package is not in the same inferred family.",
      "Family inference uses npm scope and GitHub repository owner by default; legacy family properties in the existing database are also honored.",
      "Vulnerabilities are queried from OSV, which aggregates public advisory sources including GHSA for npm packages.",
      "Rollback candidates are packages with a vulnerable phantom that has at least one fixed version in OSV; this is a conservative reproducibility signal, not an end-to-end exploit proof.",
      "Seed-level prevalence is reported as a lower bound because failed depcheck jobs are tracked as unknown coverage, not clean packages.",
    ],
    depcheckCoverage: {
      packageCount: allPackageNames.length,
      depcheckOkPackages,
      depcheckFailedPackages,
      depcheckMissingPackages,
      depcheckOkRate: allPackageNames.length ? depcheckOkPackages / allPackageNames.length : 0,
      fullyCoveredSeeds: seedSummaries.filter((row) => row.fullyDepcheckCovered).length,
      seedsWithFailedOrMissingDepcheckInClosure: seedSummaries
        .filter((row) => !row.fullyDepcheckCovered).length,
      meanSeedClosureDepcheckCoverage: mean(seedSummaries.map((row) => row.depcheckCoverage)),
    },
    filterDiagnostics: {
      rawDepcheckPairs: diagnostics.rawDepcheckPairs.size,
      rawDepcheckUniquePhantoms: diagnostics.rawDepcheckPhantoms.size,
      databasePresentPairs: diagnostics.databasePresentPairs.size,
      databasePresentUniquePhantoms: diagnostics.databasePresentPhantoms.size,
      discardedNotInDatabasePairs: diagnostics.notInDatabasePairs.size,
      discardedNotInDatabaseUniquePhantoms: diagnostics.notInDatabasePhantoms.size,
      transitiveConfirmedPairs: diagnostics.transitiveConfirmedPairs.size,
      transitiveConfirmedUniquePhantoms: diagnostics.transitiveConfirmedPhantoms.size,
      discardedNotInTransitiveClosurePairs: diagnostics.notInTransitiveClosurePairs.size,
      discardedNotInTransitiveClosureUniquePhantoms: diagnostics.notInTransitiveClosurePhantoms.size,
      discardedSameFamilyPairs: diagnostics.sameFamilyPairs.size,
      discardedSameFamilyUniquePhantoms: diagnostics.sameFamilyPhantoms.size,
      retainedExternalPairs: diagnostics.retainedPairs.size,
      retainedExternalUniquePhantoms: diagnostics.retainedPhantoms.size,
      packagesWithFailedDepcheckEncountered: diagnostics.failedDepcheckPackages.size,
      packagesMissingDepcheckEncountered: diagnostics.missingDepcheckPackages.size,
    },
    phantoms: {
      uniqueExternalPhantoms: uniquePhantoms.length,
      totalClosureOccurrences: allClosureOccurrences.length,
      seedsWithClosurePhantoms: seedSummaries.filter((row) => row.closureExternalPhantomCount > 0).length,
      closurePhantomsPerSeed: {
        mean: mean(closureCounts),
        median: median(closureCounts),
        max: Math.max(0, ...closureCounts),
      },
      uniqueRootExternalPhantoms: new Set(rootPhantomRows.map((row) => row.phantomName)).size,
      rootOccurrences: rootPhantomRows.length,
      seedsWithRootPhantoms: seedSummaries.filter((row) => row.rootExternalPhantomCount > 0).length,
      rootPhantomsPerSeed: {
        mean: mean(rootCounts),
        median: median(rootCounts),
        max: Math.max(0, ...rootCounts),
      },
      topExternalPhantoms: phantomOccurrences.slice(0, 20),
    },
    vulnerabilities: {
      vulnerableExternalPhantoms: vulnerablePhantoms.length,
      vulnerableExternalPhantomOccurrences: vulnerablePhantoms
        .reduce((total, row) => total + row.occurrences, 0),
      observedAffectedExternalPhantoms: vulnerablePhantoms
        .filter((row) => row.affectedNowCount > 0).length,
      rollbackCandidateExternalPhantoms: vulnerablePhantoms
        .filter((row) => row.fixedAvailable).length,
      seedsWithAnyVulnerablePhantom: seedSummaries
        .filter((row) => row.vulnerablePhantomCount > 0).length,
      seedsWithObservedAffectedPhantom: seedSummaries
        .filter((row) => row.observedAffectedPhantomCount > 0).length,
      seedsWithRollbackCandidate: seedSummaries
        .filter((row) => row.rollbackCandidatePhantomCount > 0).length,
      severityCounts,
      topVulnerablePhantoms: vulnerablePhantoms.slice(0, 20),
    },
    rollbackAttack: {
      definition: "strict-vulnerable requires an externally managed phantom, at least one provider dependency constraint that intersects a known affected range, and no known fixed version satisfying that provider constraint. affected-range-admitted is a looser upper-bound where the provider range intersects an affected range but also admits at least one known fixed version.",
      strictVulnerableSeeds: seedsWithStrictRollback.size,
      strictVulnerableUsingPackages: packagesWithStrictRollback.size,
      strictRows: rollbackRows.filter((row) => row.status === "strict-vulnerable").length,
      affectedRangeAdmittedSeeds: seedsWithWeakRollback.size,
      affectedRangeAdmittedUsingPackages: packagesWithWeakRollback.size,
      affectedRangeRowsIncludingStrict: rollbackRows.length,
      weakOnlyRows: rollbackRows.filter((row) => row.status === "affected-range-admitted").length,
      topStrictRollbackPhantoms: sortCountMap(
        rollbackRows
          .filter((row) => row.status === "strict-vulnerable")
          .reduce((map, row) => {
            addCount(map, row.phantomName);
            return map;
          }, new Map()),
      ).slice(0, 20),
    },
  };

  await writeAnalysisArtifacts({
    outFile,
    summary,
    seedSummaries,
    phantomOccurrences,
    vulnerablePhantoms,
    rootPhantoms: rootPhantomRows,
    rollbackRows,
    detailedOccurrences: allClosureOccurrences.map((row) => ({
      seed: row.seed,
      usingPackage: row.packageName,
      usingVersion: row.packageVersion,
      phantomName: row.phantomName,
      phantomVersion: row.phantomVersion,
    })),
  });

  return summary;
}
