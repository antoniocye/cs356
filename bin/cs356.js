#!/usr/bin/env node
import { analyzeNpm } from "../src/analyze-npm.js";
import { analyzePypiCsv } from "../src/analyze-pypi-csv.js";
import { collectTopNpmPackages } from "../src/npm-registry.js";
import { DatabaseManager } from "../src/database-manager.js";
import { readJson } from "../src/fs-utils.js";
import { validateNpmResolver } from "../src/validate-npm-resolver.js";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
    } else if (rest[i + 1] && !rest[i + 1].startsWith("--")) {
      options[key] = rest[i + 1];
      i += 1;
    } else {
      options[key] = true;
    }
  }

  return { command, options };
}

function numberOption(options, key, fallback) {
  if (options[key] === undefined) return fallback;
  const parsed = Number(options[key]);
  if (!Number.isFinite(parsed)) throw new Error(`--${key.replaceAll("_", "-")} must be a number`);
  return parsed;
}

function help() {
  console.log(`Usage: node bin/cs356.js <command> [options]

Commands:
  analyze-npm       Analyze npm phantom dependency results and query/cache OSV vulnerabilities.
  analyze-pypi-csv  Analyze a PyPI collector CSV and query/cache OSV vulnerabilities.
  collect-npm-top  Collect the top N npm packages by downloads for a date range.
  build-npm-db     Add seed packages and their dependency closures to a JSON database.
  depcheck-npm     Run Dockerized depcheck for packages in the JSON database.
  validate-npm     Install affected npm seeds and validate phantom reachability.

Examples:
  node bin/cs356.js analyze-npm --db database_manager_npm/database.json --seeds output_files_top_1000/top1000.json --out results/npm-analysis.json
  node bin/cs356.js analyze-pypi-csv --csv results/pypi-collected.csv --out results/pypi-collected-analysis.json
  node bin/cs356.js collect-npm-top --out data/npm/top1000.json --limit 1000 --concurrency 64
  node bin/cs356.js build-npm-db --db data/npm/database.json --seeds data/npm/top1000.json
  node bin/cs356.js depcheck-npm --db data/npm/database.json --concurrency 20
  node bin/cs356.js validate-npm --concurrency 4
`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || command === "--help") {
    help();
    return;
  }

  if (command === "analyze-npm") {
    const summary = await analyzeNpm({
      dbFile: options.db || "database_manager_npm/database.json",
      seedsFile: options.seeds || "output_files_top_1000/top1000.json",
      outFile: options.out || "results/npm-analysis.json",
      osvCacheFile: options.osv_cache || "cache/osv-npm.json",
      osvConcurrency: numberOption(options, "osv_concurrency", 24),
      includeAuthorHeuristics: Boolean(options.include_author_heuristics),
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (command === "analyze-pypi-csv") {
    const summary = await analyzePypiCsv({
      csvFile: options.csv || "results/pypi-collected.csv",
      outFile: options.out || "results/pypi-collected-analysis.json",
      osvCacheFile: options.osv_cache || "cache/osv-pypi.json",
      osvConcurrency: numberOption(options, "osv_concurrency", 24),
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (command === "collect-npm-top") {
    await collectTopNpmPackages({
      outFile: options.out || "data/npm/top1000.json",
      limit: numberOption(options, "limit", 1000),
      startIndex: numberOption(options, "start_index", 0),
      endIndex: options.end_index === undefined ? null : numberOption(options, "end_index", null),
      startDate: options.start_date || "2025-05-11",
      endDate: options.end_date || "2025-11-11",
      concurrency: numberOption(options, "concurrency", 48),
      checkpointEvery: numberOption(options, "checkpoint_every", 50000),
    });
    return;
  }

  if (command === "build-npm-db") {
    const manager = new DatabaseManager(options.db || "data/npm/database.json");
    await manager.init({ repair: Boolean(options.repair) });
    await manager.fileRecursiveAdd(options.seeds || "data/npm/top1000.json");
    return;
  }

  if (command === "depcheck-npm") {
    const manager = new DatabaseManager(options.db || "data/npm/database.json");
    await manager.init();
    let packageNames = Object.keys(manager.data.packages || {});
    if (options.packages) {
      packageNames = (await readJson(options.packages, [])).map((row) => Array.isArray(row) ? row[1] : row);
    }
    await manager.runDepcheck({
      packageNames,
      concurrency: numberOption(options, "concurrency", 20),
      force: Boolean(options.force),
      saveEvery: numberOption(options, "save_every", 100),
    });
    return;
  }

  if (command === "validate-npm") {
    const summary = await validateNpmResolver({
      dbFile: options.db || "database_manager_npm/database.json",
      occurrencesFile: options.occurrences || "results/external-phantom-occurrences.csv",
      rollbackFile: options.rollback || "results/rollback-candidates.csv",
      outFile: options.out || "results/npm-resolver-validation.json",
      outCsv: options.csv || "results/npm-resolver-validation.csv",
      osvCacheFile: options.osv_cache || "cache/osv-npm.json",
      onlySeedsWithVulnerablePhantoms: options.all ? false : true,
      concurrency: numberOption(options, "concurrency", 4),
      keepWork: Boolean(options.keep_work),
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
