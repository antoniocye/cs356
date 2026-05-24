import semver from "semver";
import { mapLimit } from "./concurrency.js";
import { readJson, writeJson } from "./fs-utils.js";

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

function cacheKey(ecosystem, packageName) {
  return `${ecosystem}:${packageName}`;
}

export async function queryOsvPackage(ecosystem, packageName) {
  const response = await fetch(OSV_QUERY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      package: {
        ecosystem,
        name: packageName,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OSV query failed for ${ecosystem}/${packageName}: HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.vulns || [];
}

export async function getOsvVulnerabilitiesForPackages(packageNames, {
  ecosystem = "npm",
  cacheFile = "cache/osv-npm.json",
  concurrency = 24,
  logger = console,
} = {}) {
  const cache = await readJson(cacheFile, {});
  const uniqueNames = [...new Set(packageNames)].sort();
  const missing = uniqueNames.filter((name) => !cache[cacheKey(ecosystem, name)]);

  if (missing.length > 0) {
    logger.log?.(`OSV cache miss for ${missing.length}/${uniqueNames.length} ${ecosystem} packages`);
  }

  let completed = 0;
  await mapLimit(missing, concurrency, async (packageName) => {
    try {
      const vulns = await queryOsvPackage(ecosystem, packageName);
      cache[cacheKey(ecosystem, packageName)] = {
        queriedAt: new Date().toISOString(),
        vulns,
      };
    } catch (error) {
      cache[cacheKey(ecosystem, packageName)] = {
        queriedAt: new Date().toISOString(),
        error: error.message,
        vulns: [],
      };
      logger.warn?.(error.message);
    }
    completed += 1;
    if (completed % 50 === 0) {
      logger.log?.(`OSV progress: ${completed}/${missing.length}`);
      await writeJson(cacheFile, cache);
    }
  });

  if (missing.length > 0) await writeJson(cacheFile, cache);

  const result = new Map();
  for (const packageName of uniqueNames) {
    result.set(packageName, cache[cacheKey(ecosystem, packageName)]?.vulns || []);
  }
  return result;
}

function normalizedVersion(version) {
  if (!version) return null;
  return semver.valid(version) || semver.valid(semver.coerce(version));
}

function packageMatches(affectedPackage, ecosystem, packageName) {
  return affectedPackage?.ecosystem?.toLowerCase() === ecosystem.toLowerCase()
    && affectedPackage?.name?.toLowerCase() === packageName.toLowerCase();
}

export function vulnHasFixedVersion(vuln, ecosystem, packageName) {
  for (const affected of vuln.affected || []) {
    if (!packageMatches(affected.package, ecosystem, packageName)) continue;
    for (const range of affected.ranges || []) {
      if ((range.events || []).some((event) => event.fixed)) return true;
    }
  }
  return false;
}

export function fixedVersionsForVuln(vuln, ecosystem, packageName) {
  const fixed = [];
  for (const affected of vuln.affected || []) {
    if (!packageMatches(affected.package, ecosystem, packageName)) continue;
    for (const range of affected.ranges || []) {
      for (const event of range.events || []) {
        const version = normalizedVersion(event.fixed);
        if (version) fixed.push(version);
      }
    }
  }
  return [...new Set(fixed)].sort(semver.compare);
}

export function affectedSemverRangesForVuln(vuln, ecosystem, packageName) {
  const ranges = [];
  for (const affected of vuln.affected || []) {
    if (!packageMatches(affected.package, ecosystem, packageName)) continue;

    for (const range of affected.ranges || []) {
      const rangeType = String(range.type || "").toUpperCase();
      if (rangeType !== "SEMVER" && rangeType !== "ECOSYSTEM") continue;

      let introduced = null;
      for (const event of range.events || []) {
        if (event.introduced !== undefined) {
          introduced = event.introduced === "0"
            ? "0.0.0"
            : normalizedVersion(event.introduced);
        }
        if (event.fixed !== undefined || event.last_affected !== undefined) {
          if (!introduced) introduced = "0.0.0";
          const fixed = normalizedVersion(event.fixed);
          const lastAffected = normalizedVersion(event.last_affected);
          if (fixed) {
            ranges.push(`>=${introduced} <${fixed}`);
          } else if (lastAffected) {
            ranges.push(`>=${introduced} <=${lastAffected}`);
          }
          introduced = null;
        }
      }
      if (introduced) ranges.push(`>=${introduced}`);
    }
  }
  return ranges.filter((range) => semver.validRange(range));
}

export function providerRangeRollbackStatus(providerRange, vulns, {
  ecosystem = "npm",
  packageName,
} = {}) {
  const validProviderRange = semver.validRange(providerRange);
  if (!validProviderRange) {
    return {
      validRange: false,
      intersectsAffected: false,
      excludesKnownFixed: false,
        advisoryIds: [],
        strictAdvisoryIds: [],
        fixedVersions: [],
        perAdvisory: [],
      };
  }

  const perAdvisory = [];

  for (const vuln of vulns || []) {
    const affectedRanges = affectedSemverRangesForVuln(vuln, ecosystem, packageName);
    const intersectsAffected = affectedRanges.some((affectedRange) => (
      semver.intersects(validProviderRange, affectedRange, { includePrerelease: true })
    ));
    if (!intersectsAffected) continue;

    const fixedVersions = fixedVersionsForVuln(vuln, ecosystem, packageName);
    const allowsKnownFixed = fixedVersions.some((version) => (
      semver.satisfies(version, validProviderRange, { includePrerelease: true })
    ));

    perAdvisory.push({
      id: vuln.id,
      affectedRanges,
      fixedVersions,
      excludesKnownFixed: fixedVersions.length > 0 && !allowsKnownFixed,
    });
  }

  const uniqueFixedVersions = [...new Set(perAdvisory.flatMap((entry) => entry.fixedVersions))]
    .sort(semver.compare);
  const advisoryIds = perAdvisory.map((entry) => entry.id).filter(Boolean);
  const strictAdvisoryIds = perAdvisory
    .filter((entry) => entry.excludesKnownFixed)
    .map((entry) => entry.id)
    .filter(Boolean);

  return {
    validRange: true,
    intersectsAffected: perAdvisory.length > 0,
    excludesKnownFixed: strictAdvisoryIds.length > 0,
    advisoryIds: [...new Set(advisoryIds)],
    strictAdvisoryIds: [...new Set(strictAdvisoryIds)],
    fixedVersions: uniqueFixedVersions,
    perAdvisory,
  };
}

export function isVersionAffected(vuln, ecosystem, packageName, version) {
  const validVersion = normalizedVersion(version);
  if (!validVersion) return false;

  for (const affected of vuln.affected || []) {
    if (!packageMatches(affected.package, ecosystem, packageName)) continue;

    if ((affected.versions || []).includes(version) || (affected.versions || []).includes(validVersion)) {
      return true;
    }

    for (const range of affected.ranges || []) {
      const rangeType = String(range.type || "").toUpperCase();
      if (rangeType !== "SEMVER" && rangeType !== "ECOSYSTEM") continue;

      let affectedAtVersion = false;
      for (const event of range.events || []) {
        if (event.introduced !== undefined) {
          affectedAtVersion = event.introduced === "0"
            || semver.gte(validVersion, normalizedVersion(event.introduced) || "0.0.0");
        }
        if (event.fixed !== undefined) {
          const fixed = normalizedVersion(event.fixed);
          if (fixed && semver.gte(validVersion, fixed)) affectedAtVersion = false;
        }
        if (event.last_affected !== undefined) {
          const lastAffected = normalizedVersion(event.last_affected);
          if (lastAffected) affectedAtVersion = semver.lte(validVersion, lastAffected);
        }
      }
      if (affectedAtVersion) return true;
    }
  }
  return false;
}

export function severityLabel(vuln) {
  const databaseSeverity = vuln.database_specific?.severity;
  if (databaseSeverity) return String(databaseSeverity).toUpperCase();

  const scores = (vuln.severity || [])
    .map((entry) => {
      const match = String(entry.score || "").match(/CVSS:\d\.\d\/.*?/);
      if (!match && !entry.score) return null;
      const scoreMatch = String(entry.score).match(/(?:^|\/)CVSS:\d\.\d\/.*|^(\d+(?:\.\d+)?)$/);
      if (scoreMatch?.[1]) return Number(scoreMatch[1]);
      const numeric = String(entry.score).match(/(\d+(?:\.\d+)?)/);
      return numeric ? Number(numeric[1]) : null;
    })
    .filter((score) => Number.isFinite(score));

  if (scores.length === 0) return "UNKNOWN";
  const max = Math.max(...scores);
  if (max >= 9) return "CRITICAL";
  if (max >= 7) return "HIGH";
  if (max >= 4) return "MODERATE";
  return "LOW";
}

export function severityRank(label) {
  return {
    CRITICAL: 4,
    HIGH: 3,
    MODERATE: 2,
    MEDIUM: 2,
    LOW: 1,
    UNKNOWN: 0,
  }[String(label || "UNKNOWN").toUpperCase()] ?? 0;
}

export function summarizeVulnerabilities(packageName, version, vulns, {
  ecosystem = "npm",
} = {}) {
  const severities = vulns.map(severityLabel);
  const maxSeverity = severities.sort((a, b) => severityRank(b) - severityRank(a))[0] || null;
  const affectedNow = vulns.filter((vuln) => isVersionAffected(vuln, ecosystem, packageName, version));
  const fixedAvailable = vulns.some((vuln) => vulnHasFixedVersion(vuln, ecosystem, packageName));

  return {
    packageName,
    version,
    vulnerabilityCount: vulns.length,
    vulnerableEver: vulns.length > 0,
    affectedNowCount: affectedNow.length,
    affectedNow: affectedNow.length > 0,
    fixedAvailable,
    maxSeverity,
    advisoryIds: vulns.map((vuln) => vuln.id).filter(Boolean),
  };
}
