import fs from 'fs';
import path from 'path';

class DatabaseManager {
    constructor(dbFilePath) {
        this.dbFilePath = dbFilePath;
        this.createIfNotExists();
    }

    createIfNotExists() {
        if (!fs.existsSync(this.dbFilePath)) {
            fs.writeFileSync(this.dbFilePath, '', 'utf-8');
        }
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

export const db = new DatabaseManager('phantom_deps.json');