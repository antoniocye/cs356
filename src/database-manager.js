import { getNpmLatestMetadata } from "./npm-registry.js";
import { readJson, writeJson } from "./fs-utils.js";
import { constructMetaLight } from "./families.js";
import { getRepoUrlFromPackageRecord } from "./repo-url.js";
import { runPackageDepcheck } from "./depcheck-docker.js";
import { mapLimit } from "./concurrency.js";

export class DatabaseManager {
  constructor(dbFilePath, { logger = console } = {}) {
    this.dbFilePath = dbFilePath;
    this.logger = logger;
    this.seen = new Set();
    this.seenFamily = new Set();
    this.data = { packages: {}, families: [] };
    this.hasDataChanged = false;
  }

  async init({ repair = false } = {}) {
    this.data = await readJson(this.dbFilePath, { packages: {}, families: [] });
    this.data.packages ||= {};
    this.data.families ||= [];
    this.seen = new Set(Object.keys(this.data.packages));
    this.seenFamily = new Set();

    for (const family of this.data.families) {
      for (const packageName of family.packages || []) {
        this.seenFamily.add(packageName);
      }
    }

    if (repair) {
      for (const packageName of Object.keys(this.data.packages)) {
        const packageRecord = this.data.packages[packageName];
        if (!packageRecord || Object.keys(packageRecord).length === 0) {
          this.data.packages[packageName] = await getNpmLatestMetadata(packageName);
          this.hasDataChanged = true;
        }
        if (this.data.packages[packageName]?.meta && !this.data.packages[packageName].meta_light) {
          this.data.packages[packageName].meta_light = constructMetaLight(
            packageName,
            this.data.packages[packageName],
          );
          this.hasDataChanged = true;
        }
        this.findFamily(packageName);
      }
      await this.saveChanges();
    }

    this.logger.log?.(
      `Database initialized: ${Object.keys(this.data.packages).length} packages, ${this.data.families.length} families.`,
    );
  }

  containsEntry(packageName) {
    return this.seen.has(packageName);
  }

  getEntry(packageName) {
    return this.data.packages[packageName] ?? null;
  }

  saveEntry(packageName, packageRecord) {
    if (this.containsEntry(packageName)) return false;
    this.seen.add(packageName);
    this.data.packages[packageName] = packageRecord;
    this.hasDataChanged = true;
    return true;
  }

  async saveChanges() {
    if (!this.hasDataChanged) return;
    await writeJson(this.dbFilePath, this.data);
    this.hasDataChanged = false;
  }

  async recursiveAdd(packageName, depth = 0) {
    if (this.containsEntry(packageName) && this.getEntry(packageName)) return;

    const metadata = await getNpmLatestMetadata(packageName);
    this.saveEntry(packageName, metadata);

    for (const dep of Object.keys(metadata.deps || {})) {
      if (!this.containsEntry(dep)) {
        await this.recursiveAdd(dep, depth + 1);
      }
    }

    if (depth === 0) await this.saveChanges();
  }

  async fileRecursiveAdd(seedFilePath) {
    const seedRows = await readJson(seedFilePath, []);
    for (const row of seedRows) {
      const packageName = Array.isArray(row) ? row[1] : row.name || row.packageName;
      if (packageName) await this.recursiveAdd(packageName);
    }
    await this.saveChanges();
  }

  findFamily(packageName) {
    const packageRecord = this.data.packages[packageName];
    if (this.seenFamily.has(packageName) || !packageRecord?.meta_light) return;

    const properties = [...new Set(Object.values(packageRecord.meta_light).filter(Boolean))];
    if (properties.length === 0) return;

    for (const family of this.data.families) {
      const familyProperties = family.properties || [];
      const matches = properties.filter((value) => familyProperties.includes(value));
      if (matches.length === 0) continue;

      for (const property of properties) {
        if (!familyProperties.includes(property)) familyProperties.push(property);
      }
      family.properties = familyProperties;
      family.packages ||= [];
      if (!family.packages.includes(packageName)) family.packages.push(packageName);
      this.seenFamily.add(packageName);
      this.hasDataChanged = true;
      return;
    }

    this.data.families.push({ properties, packages: [packageName] });
    this.seenFamily.add(packageName);
    this.hasDataChanged = true;
  }

  getRepoUrl(packageName) {
    return getRepoUrlFromPackageRecord(this.getEntry(packageName));
  }

  async onePackageDepcheck(packageName, options = {}) {
    const packageRecord = this.getEntry(packageName);
    if (!packageRecord) {
      return {
        ok: false,
        packageName,
        repoUrl: null,
        phantomDeps: [],
        unusedDeps: [],
        unusedDevDeps: [],
        error: "Package is not in the database.",
      };
    }
    return runPackageDepcheck(packageName, packageRecord, options);
  }

  async runDepcheck({
    packageNames = Object.keys(this.data.packages),
    concurrency = 20,
    force = false,
    saveEvery = 100,
  } = {}) {
    let processed = 0;
    await mapLimit(packageNames, concurrency, async (packageName) => {
      if (!force && this.data.packages?.[packageName]?.depcheck_result) {
        processed += 1;
        return;
      }

      this.data.packages[packageName].depcheck_result = await this.onePackageDepcheck(packageName);
      this.hasDataChanged = true;
      processed += 1;

      if (processed % saveEvery === 0) {
        this.logger.log?.(`depcheck progress: ${processed}/${packageNames.length}`);
        await this.saveChanges();
      }
    });

    await this.saveChanges();
  }
}
