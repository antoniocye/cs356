import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch'

class DatabaseManager {
    constructor(dbFilePath) {
        this.dbFilePath = dbFilePath;
        this.seen = new Set();
        this.data = {};
        this.has_data_changed = false;
        this.db_len = 0;
    }

    // init should be called once at the beginning of a session
    async init() {
        const text_in_file = await fs.readFile(this.dbFilePath, 'utf-8');
        const json = text_in_file.trim() ? JSON.parse(text_in_file) : {};
        for(let pkg in json){
            this.seen.add(pkg);
        }
        console.log("Database initialized");
        this.data = json;
        this.db_len = Object.keys(this.data).length;
    }

    // saveChanges should be called periodically
    async saveChanges() {
        if(this.has_data_changed){
            await fs.writeFile(this.dbFilePath, JSON.stringify(this.data, null, 2), "utf8");
            // console.log("Changes so far have been saved in database file");
        }
    }

    // the following functions perform basic queries on working copy of db
    containsEntry(key){
        return this.seen.has(key);
    }

    saveEntry(key, value){
        let db_len_temp = Object.keys(this.data).length;
        if(db_len_temp != this.db_len){
            this.db_len = db_len_temp;
            if(this.db_len % 500 == 0){
                console.log(`----> Progress log: Processed ${this.db_len} packages on ${new Date().toLocaleString()}`);
            }
        }

        if(!this.containsEntry(key)){
            this.seen.add(key);
            this.data[key] = value;
            if(!this.has_data_changed){
                this.has_data_changed = true;
            }
        }
    }

    getEntry(key){
        return this.data[key] ?? null;
    }

    // the following functions manage packages and dependencies
    async getMetadata(packageName) {
        try {
            const url = `https://registry.npmjs.org/${packageName}/latest`;
            const res = await fetch(url);

            if (!res.ok) {
                console.error(`Error: could not fetch package ${packageName}`);
                return {};
            }

            const data = await res.json();
            const meta = {
                ...(data.author && { author: data.author }),
                ...(data.maintainers && { maintainers: data.maintainers }),
                ...(data.homepage && { homepage: data.homepage }),
                ...(data.bugs && { bugs: data.bugs }),
                ...(data.repository && { repository: data.repository })
            };

            return {
                "dev_deps": data.devDependencies,
                "deps": data.dependencies, 
                "version": data.version, 
                "meta": meta
            };
        } catch (err) {
            console.error(`Error fetching ${packageName}:`, err.message);
            return {};
        }
    }


    // Adding a package and (recursively) all of its full transitive dependency list to the database
    async recursiveAdd(packageName, depth=0) {
        if(depth == 0 && Math.random() < .15){
            console.log(`Starting work on package ${packageName}`);
        }

        let metadata = await this.getMetadata(packageName);
        this.saveEntry(packageName, metadata);

        if(metadata.deps === null || typeof metadata.deps !== 'object' || Object.keys(metadata.deps).length === 0){
            return;
        }

        for(let dep in metadata.deps){
            if(!this.containsEntry(dep)){
                await this.recursiveAdd(dep, depth + 1);
            }
        }

        if(depth == 0){
            await this.saveChanges();
        }
    }


    // given a file (example format is in output_xxx folders), call recursiveAdd on each package found
    async fileRecursiveAdd(fileName){
        let text = await fs.readFile(fileName, 'utf-8');
        const json = text.trim () ? JSON.parse(text) : {};
        for(let i in json){
            await this.recursiveAdd(json[i][1]);
        }
        console.log("\n ------------------------------- \n Finished adding packages from the file to the database")
    }

    /**
     * Add phantom dependencies for a package to the database
     * @param {string} packageName - The name of the npm package
     * @param {string[]} phantomDeps - Array of phantom dependency names
     * @param {number} downloadCount - Optional download count for the package
     */
    addPhantomDependencies(packageName, phantomDeps, downloadCount = null) {
        if (!phantomDeps || phantomDeps.length === 0) return;

        const entry = {
            packageName,
            phantomDeps,
            downloadCount,
            timestamp: new Date().toISOString()
        };
        // Read existing content
        let content = [];
        try {
            const fileContent = fs.readFileSync(this.dbFilePath, 'utf-8');
            if (fileContent) {
                content = JSON.parse(fileContent);
            }
        } catch (error) {
            // If file is empty or invalid JSON, start with empty array
            content = [];
        }

        // If package already exists, merge phantom deps and update metadata
        const idx = content.findIndex(e => e.packageName === packageName);
        if (idx !== -1) {
            const existing = content[idx];
            const merged = new Set([...(existing.phantomDeps || []), ...phantomDeps]);
            existing.phantomDeps = Array.from(merged);
            // Update download count if provided (not null)
            if (downloadCount !== null && downloadCount !== undefined) {
                existing.downloadCount = downloadCount;
            }
            existing.timestamp = new Date().toISOString();
            content[idx] = existing;
        } else {
            // Add new entry
            content.push(entry);
        }

        fs.writeFileSync(this.dbFilePath, JSON.stringify(content, null, 2), 'utf-8');
    }
    getPackagePhantomDeps(packageName) {
        try {
            const content = fs.readFileSync(this.dbFilePath, 'utf-8');
            if (!content) return null;

            const data = JSON.parse(content);
            return data.find(entry => entry.packageName === packageName) || null;
        } catch (error) {
            return null;
        }
    }
    getAllEntries() {
        try {
            const content = fs.readFileSync(this.dbFilePath, 'utf-8');
            if (!content) return [];
            return JSON.parse(content);
        } catch (error) {
            return [];
        }
    }

    /**
     * Search for packages with specific phantom dependencies
     * @param {string} dependencyName - The phantom dependency to search for
     * @returns {Array} Array of packages that have the specified phantom dependency
     */
    searchByPhantomDep(dependencyName) {
        const entries = this.getAllEntries();
        return entries.filter(entry => 
            entry.phantomDeps.some(dep => dep.toLowerCase() === dependencyName.toLowerCase())
        );
    }

    /**
     * Get statistics about phantom dependencies
     * @returns {Object} Statistics about the phantom dependencies
     */
    getStats() {
        const entries = this.getAllEntries();
        const stats = {
            totalPackages: entries.length,
            totalPhantomDeps: 0,
            mostCommonPhantomDeps: {},
            averagePhantomDepsPerPackage: 0
        };
        // Calculate statistics
        entries.forEach(entry => {
            stats.totalPhantomDeps += entry.phantomDeps.length;
            entry.phantomDeps.forEach(dep => {
                stats.mostCommonPhantomDeps[dep] = (stats.mostCommonPhantomDeps[dep] || 0) + 1;
            });
        });
        // Calculate average
        stats.averagePhantomDepsPerPackage = 
            entries.length > 0 ? stats.totalPhantomDeps / entries.length : 0;
        // Sort most common phantom deps
        stats.mostCommonPhantomDeps = Object.entries(stats.mostCommonPhantomDeps)
            .sort(([,a], [,b]) => b - a)
            .reduce((r, [k, v]) => ({ ...r, [k]: v }), {});

        return stats;
    }
    clear() {
        fs.writeFileSync(this.dbFilePath, '', 'utf-8');
    }
}

const db = new DatabaseManager('database.json');
await db.init();
await db.fileRecursiveAdd("../output_files_top_1000/top1000.json");
await db.fileRecursiveAdd("../output_file_random_1000/random1000.json");