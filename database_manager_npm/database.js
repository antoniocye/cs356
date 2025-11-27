import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch'
import { is_empty } from "../scripts_npm/util.js"

class DatabaseManager {
    constructor(dbFilePath) {
        this.dbFilePath = dbFilePath; // This file contains the local copy of the database.
        this.seen = new Set(); // Keeps track of all packages in the database for fast checks.
        this.seen_fam = new Set(); // Keeps track of all packages which have been an attributed a family for fast checks.
        this.data = {}; // The working copy of the database. First loaded when init() is called.
        this.has_data_changed = false; // Avoiding unnecessary writes to db file by keeping track of whether there are unsaved changes.
        this.db_len = 0; // Keeps track of the length of the database in terms of number of packages.
    }

    /** Loads the data from the database file into the working copy.
     *  Should be called once at the beginning of a working session.
     */
    async init() {
        const text_in_file = await fs.readFile(this.dbFilePath, 'utf-8');
        const json = text_in_file.trim() ? JSON.parse(text_in_file) : {};
        this.data = json;

        for(let fam of this.data.families){
            for(let pkg in fam.packages){
                this.seen_fam.add(pkg);
            }
        }

        for(let pkg in this.data.packages){
            this.seen.add(pkg);

            // Fetches data for the package (calls recursiveAdd) if not given.
            // It is important that this is done sequentially!
            if(is_empty(this.data.packages[pkg])){
                await this.recursiveAdd(pkg);
                this.has_data_changed = true;
            }

            // Constructs meta_light of the package if not given.
            if(!is_empty(this.data.packages[pkg]?.meta) && !this.data.packages[pkg]?.meta_light){
                this.constructMetaLight(pkg);
                this.has_data_changed = true;
            }

            // Assigns package to a family if not given.
            this.findFamily(pkg);
        }

        await this.saveChanges();
        this.db_len = Object.keys(this.data["packages"]).length;
        
        console.log("The database was initialized.");
        console.log(`Found ${this.db_len} packages and ${this.seen_fam.size} families.`)
    }

    /** Saves changes from the working copy to the database file.
     *  Should be called periodically during a working session.
     */
    async saveChanges() {
        if(this.has_data_changed){
            await fs.writeFile(this.dbFilePath, JSON.stringify(this.data, null, 2), "utf8");
            this.has_data_changed = false;
        }
    }


    /** (The following functions) perform various queries on the working copy.
     */

    containsEntry(key){
        return this.seen.has(key);
    }

    saveEntry(key, value){
        // Calling saveEntry will produce a progress log when (number of packages) % 500 = 0.
        let db_len_temp = Object.keys(this.data.packages).length;
        if(db_len_temp != this.db_len){
            this.db_len = db_len_temp;
            if(this.db_len % 500 == 0){
                console.log(`----> Progress log: Processed ${this.db_len} packages on ${new Date().toLocaleString()}`);
            }
        }

        if(!this.containsEntry(key)){
            this.seen.add(key);
            this.data["packages"][key] = value;
            if(!this.has_data_changed){
                this.has_data_changed = true;
            }
        }
    }

    getEntry(key){
        return this.data["packages"][key] ?? null;
    }

    /** Fetch the metadata for the latest release of a package from registry.npmjs.org.
     * @param {string} packageName - Package to fetch metadata for.
     */
    async getMetadata(packageName) {
        try {
            const url = `https://registry.npmjs.org/${packageName}/latest`;
            const res = await fetch(url);

            if (!res.ok) {
                // The package doesn't exist in the repository.
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

    /** Recursively finds all the transitive dependencies of a package and adds them to the database.
     * @param {string} packageName  - The package to add to the database.
     * @param {number} depth - Depth of the recursion (mainly for testing purposes).
     */
    async recursiveAdd(packageName, depth=0) {
        // Periodically log progress for heavier loads.
        if(depth == 0 && Math.random() < .5){
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


    /** Calls recursiveAdd on all packages in the file called fileName of correct format (an example format is given in output_xxx folders).
    * @param {string} fileName
    */
    async fileRecursiveAdd(fileName){
        let text = await fs.readFile(fileName, 'utf-8');
        const json = text.trim () ? JSON.parse(text) : {};
        for(let i in json){
            await this.recursiveAdd(json[i][1]);
        }
        console.log("\n ------------------------------- \n Finished adding packages from the file to the database")
    }

    /** Takes a package from the working copy and summarizes its meta property into meta_light
     *  for the goal of easily constructing families of packages.
     * @param {string} packageName
     */
    async constructMetaLight(packageName){
        let meta_light = {};
        let meta = this.data["packages"][packageName]["meta"];

        // Finds the domain of the name of the package if in format @domain/subdomain.
        if(packageName[0] == "@" && packageName.includes("/")){
            meta_light.domain = packageName.slice(1,packageName.indexOf("/"));
        }

        // Finds the repo domain (if it exists) from the repository field in the meta field of the package.
        if(meta?.repository?.url && meta?.repository?.url.includes("github.com/")){
            let repo_url = meta.repository.url;
            let start_index_slice = repo_url.indexOf("github.com/") + "github.com/".length;
            if(repo_url.slice(start_index_slice).includes("/")){
                let end_index_slice = start_index_slice + repo_url.slice(start_index_slice).indexOf("/");
                let repo_domain = repo_url.slice(start_index_slice, end_index_slice);
                meta_light.repo_domain = repo_domain;
            }
        }

        // Finds the authors' email addresses and urls.
        if(meta?.author?.url){
            meta_light.author_url = meta.author.url;
        }
        if(meta?.author?.email){
            meta_light.author_email = meta.author.email;
        }
        if(meta?.homepage){
            meta_light.homepage = meta.homepage;
        }

        this.data.packages[packageName].meta_light = meta_light;
    }

    findFamily(packageName){
        let pkg_data = this.data.packages[packageName];

        if(packageName in this.seen_fam || !pkg_data?.meta_light){
            return;
        }

        let families = this.data.families;
        let pkg_properties = [...new Set(Object.values(pkg_data.meta_light))];

        if(pkg_properties){
            for(let fam of families){
                // Find the meta_light values from pkg_data that match any properties from fam.
                let matches = pkg_properties.filter(v => fam.properties.includes(v));
                if (matches.length > 0) {
                    // Add the new properties brought by pkg_data to this family.
                    for (const m of matches) {
                        if (!fam.properties.includes(m)) {
                            fam.properties.push(m);
                        }
                    }

                    // Add the package to the family.
                    if (!fam.packages.includes(packageName)) {
                        fam.packages.push(packageName);
                    }
                    return;
                }
            }

            // If it doesn't belong to any family, create one for it.
            families.push({"properties": pkg_properties, "packages": [packageName]});
            this.seen_fam.add(packageName);
            this.has_data_changed = true;
        }
    }
}

const db = new DatabaseManager('database.json');
await db.init();