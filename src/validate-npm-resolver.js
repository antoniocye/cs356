import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { parseCsv } from "./csv.js";
import { readJson, toCsv, writeJson, writeText } from "./fs-utils.js";
import { getOsvVulnerabilitiesForPackages, isVersionAffected } from "./osv.js";
import { mapLimit } from "./concurrency.js";

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        error: error?.message || null,
        stdout: stdout?.toString("utf8") || "",
        stderr: stderr?.toString("utf8") || "",
      });
    });
  });
}

function packagePathParts(packageName) {
  return packageName.startsWith("@") ? packageName.split("/") : [packageName];
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findPackageDirs(rootDir, packageName) {
  const parts = packagePathParts(packageName);
  const results = [];

  async function walk(dir) {
    if (path.basename(dir) === "node_modules") {
      const candidate = path.join(dir, ...parts);
      if (await exists(path.join(candidate, "package.json"))) results.push(candidate);
    }

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules") {
        const candidate = path.join(full, ...parts);
        if (await exists(path.join(candidate, "package.json"))) results.push(candidate);
      }
      if (entry.name !== ".bin") await walk(full);
    }
  }

  await walk(path.join(rootDir, "node_modules"));
  return [...new Set(results)];
}

async function resolvePackageFrom(startDir, packageName, stopDir) {
  const parts = packagePathParts(packageName);
  let current = startDir;
  const stop = path.resolve(stopDir);

  while (current.startsWith(stop)) {
    const candidate = path.join(current, "node_modules", ...parts);
    const packageJson = path.join(candidate, "package.json");
    if (await exists(packageJson)) {
      const data = await readJson(packageJson, {});
      return {
        packageDir: candidate,
        version: data.version || null,
      };
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function rowKey(row) {
  return `${row.seed}\0${row.usingPackage}\0${row.phantomName}`;
}

async function validateSeed(seed, rows, db, rollbackByKey, osvByPackage, {
  keepWork = false,
  logger = console,
} = {}) {
  const seedVersion = db.packages?.[seed]?.version;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "npm-resolve-"));
  const packageSpec = seedVersion ? `${seed}@${seedVersion}` : seed;

  try {
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({
      private: true,
      dependencies: { [seed]: seedVersion || "latest" },
    }, null, 2));

    const install = await execFilePromise("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      packageSpec,
    ], { cwd: tempDir, timeout: 10 * 60 * 1000 });

    if (!install.ok) {
      return rows.map((row) => ({
        ...row,
        seedVersion: seedVersion || "",
        installOk: false,
        installError: install.error || install.stderr.slice(0, 400),
        usingPackageInstalled: false,
        phantomReachable: false,
        resolvedPhantomVersion: "",
        resolvedVersionAffected: false,
        strictRollbackReachable: false,
        weakRollbackReachable: false,
      }));
    }

    const usingDirs = new Map();
    for (const row of rows) {
      if (!usingDirs.has(row.usingPackage)) {
        usingDirs.set(row.usingPackage, await findPackageDirs(tempDir, row.usingPackage));
      }
    }

    const results = [];
    for (const row of rows) {
      const dirs = usingDirs.get(row.usingPackage) || [];
      let resolved = null;
      for (const dir of dirs) {
        resolved = await resolvePackageFrom(dir, row.phantomName, tempDir);
        if (resolved) break;
      }

      const vulns = osvByPackage.get(row.phantomName) || [];
      const affected = resolved?.version
        ? vulns.some((vuln) => isVersionAffected(vuln, "npm", row.phantomName, resolved.version))
        : false;
      const rollbackRows = rollbackByKey.get(rowKey(row)) || [];

      results.push({
        ...row,
        seedVersion: seedVersion || "",
        installOk: true,
        installError: "",
        usingPackageInstalled: dirs.length > 0,
        phantomReachable: Boolean(resolved),
        resolvedPhantomVersion: resolved?.version || "",
        resolvedVersionAffected: affected,
        strictRollbackReachable: Boolean(resolved && rollbackRows.some((item) => item.status === "strict-vulnerable")),
        weakRollbackReachable: Boolean(resolved && rollbackRows.length > 0),
      });
    }
    return results;
  } finally {
    if (!keepWork) await fs.rm(tempDir, { recursive: true, force: true });
    else logger.log?.(`Kept npm resolver workdir for ${seed}: ${tempDir}`);
  }
}

export async function validateNpmResolver({
  dbFile = "database_manager_npm/database.json",
  occurrencesFile = "results/external-phantom-occurrences.csv",
  rollbackFile = "results/rollback-candidates.csv",
  outFile = "results/npm-resolver-validation.json",
  outCsv = "results/npm-resolver-validation.csv",
  osvCacheFile = "cache/osv-npm.json",
  onlySeedsWithVulnerablePhantoms = true,
  concurrency = 4,
  keepWork = false,
  logger = console,
} = {}) {
  const db = await readJson(dbFile);
  const occurrenceRows = parseCsv(await fs.readFile(occurrencesFile, "utf8"));
  const rollbackRows = parseCsv(await fs.readFile(rollbackFile, "utf8"));
  const rollbackByKey = new Map();
  for (const row of rollbackRows) {
    const key = rowKey(row);
    if (!rollbackByKey.has(key)) rollbackByKey.set(key, []);
    rollbackByKey.get(key).push(row);
  }

  const uniquePhantoms = [...new Set(occurrenceRows.map((row) => row.phantomName))];
  const osvByPackage = await getOsvVulnerabilitiesForPackages(uniquePhantoms, {
    ecosystem: "npm",
    cacheFile: osvCacheFile,
    concurrency: 24,
    logger,
  });

  let rows = occurrenceRows;
  if (onlySeedsWithVulnerablePhantoms) {
    const vulnerableNames = new Set(uniquePhantoms.filter((name) => (osvByPackage.get(name) || []).length > 0));
    rows = rows.filter((row) => vulnerableNames.has(row.phantomName));
  }

  const rowsBySeed = new Map();
  for (const row of rows) {
    if (!rowsBySeed.has(row.seed)) rowsBySeed.set(row.seed, []);
    rowsBySeed.get(row.seed).push(row);
  }

  const seedEntries = [...rowsBySeed.entries()];
  const validatedGroups = await mapLimit(seedEntries, concurrency, async ([seed, seedRows], index) => {
    logger.log?.(`npm resolver validation ${index + 1}/${seedEntries.length}: ${seed}`);
    return validateSeed(seed, seedRows, db, rollbackByKey, osvByPackage, { keepWork, logger });
  });

  const validatedRows = validatedGroups.flat();
  const reachableRows = validatedRows.filter((row) => row.phantomReachable);
  const affectedRows = reachableRows.filter((row) => row.resolvedVersionAffected);
  const strictRows = reachableRows.filter((row) => row.strictRollbackReachable);
  const weakRows = reachableRows.filter((row) => row.weakRollbackReachable);

  const summary = {
    generatedAt: new Date().toISOString(),
    inputs: {
      dbFile,
      occurrencesFile,
      rollbackFile,
      onlySeedsWithVulnerablePhantoms,
      seedCount: seedEntries.length,
      occurrenceRows: rows.length,
    },
    validation: {
      installFailures: new Set(validatedRows.filter((row) => !row.installOk).map((row) => row.seed)).size,
      rowsValidated: validatedRows.length,
      reachableRows: reachableRows.length,
      reachableSeeds: new Set(reachableRows.map((row) => row.seed)).size,
      observedAffectedRows: affectedRows.length,
      observedAffectedSeeds: new Set(affectedRows.map((row) => row.seed)).size,
      strictRollbackReachableRows: strictRows.length,
      strictRollbackReachableSeeds: new Set(strictRows.map((row) => row.seed)).size,
      weakRollbackReachableRows: weakRows.length,
      weakRollbackReachableSeeds: new Set(weakRows.map((row) => row.seed)).size,
    },
  };

  await writeJson(outFile, summary);
  await writeText(outCsv, toCsv(validatedRows, [
    "seed",
    "seedVersion",
    "usingPackage",
    "usingVersion",
    "phantomName",
    "phantomVersion",
    "installOk",
    "installError",
    "usingPackageInstalled",
    "phantomReachable",
    "resolvedPhantomVersion",
    "resolvedVersionAffected",
    "strictRollbackReachable",
    "weakRollbackReachable",
  ]));

  return summary;
}
