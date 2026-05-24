import depcheck from 'depcheck';
import path from 'path';
import { execFileSync } from 'child_process';
import { debug_mode, download_count_start, download_count_end } from '../config.js'
// import { db } from '../database.js'
import { normalizeRepoUrl } from '../src/repo-url.js';

const threshold = 10000; // minimum downloads to consider

function depcheckAsync(workDir, options) {
    return new Promise((resolve) => {
        depcheck(workDir, options, (results) => resolve(results));
    });
}

async function fetchMetadataWithRetries(url, options = {}, retries = 3, delayMs = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            return res; // success
        } catch (err) {
            if(debug_mode){
                console.warn(`Attempt ${attempt} to get metadata failed: ${err.message}`);
                if (attempt === retries) throw err;
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
}


async function fetchDownloadsWithRetries(package_name, options = {}, retries = 3, delayMs = 1000){
    let url = `https://api.npmjs.org/downloads/range/${download_count_start}:${download_count_end}/${package_name}`; // provide start and end dates as a string in format yyyy-mm-yy

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            return res; // success
        } catch (err) {
            if(debug_mode){
                console.warn(`Attempt ${attempt} failed: ${err.message}`);
                if (attempt === retries) throw err;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    return null;
}

export async function count_downloads(package_name){
    // TODO: Put your own end and start data depending on the number agreed for research
    // Remember that you do not want to include the dates after which you started tinkering with this (post October 9th)
    let data = await fetchDownloadsWithRetries(package_name);
    if(!data){
        return null;
    }
    data = await data.json();
    let count = 0;
    if(data && "downloads" in data){
        for(let i = 0; i < data["downloads"].length; i++){
            count += parseInt(data["downloads"][i]["downloads"]);
        }
    }
    return count;
}


export function is_empty(object){
    if(!object){
        return true;
    }

    for (const el in object) {
        if (Object.hasOwn(object, el)) {
            return false;
        }
    }
    return true;
}

// given an npm package name,
// (1) find the github repo corresponding to it
// (2) clone the repo
// (3) cd into the repo
// (4) npm install
// (5) run depcheck

export async function add_to_db(package_name){
    // try to fetch data from registry.nmpjs.org
    let data;
    try{
        const res = await fetchMetadataWithRetries(`https://registry.npmjs.org/${package_name}`);
        if(!res.ok){
            console.error("Package not found:", package_name);
            return 0;
        }
        data = await res.json();
    }
    catch(error){
        if(debug_mode){
            console.error(error);
        }
        return 0;
    }
    

    if(debug_mode){
        console.log(`--> Working on ${package_name}`)
    }

    // find latest version
    let latest_version = data['dist-tags']?.latest;
    if(latest_version == undefined){
        if("dist-tags" in data){
            console.log("Finding metadata failed. Investigate further:");
            console.log("dist-tags values:", data['dist-tags']);
        }
        else{
            console.log("dist-tags key doesn't exist");
        }
        return 0;
    }

    // if the download count is less than a threshold, skip
    let downloads = await count_downloads(package_name);
    if (downloads > threshold) {
        // Use metadata to find github link
        let metadata = data.versions[latest_version]
        if (!metadata) {
            console.log("Metadata is empty somehow but latest_version is given? Investigate further.");
            return 0;
        }

        let repo_given;
        if (!metadata.hasOwnProperty("repository") || metadata["repository"]?.["type"] != "git") {
            if ("homepage" in metadata) {
                console.log("Github link may be at 'homepage'. Here's given homepage:", metadata["homepage"]);
                // try to work with the homepage
                repo_given = normalizeRepoUrl(metadata["homepage"]);
            }
            else {
                return 0;
            }
        }
        else {
            repo_given = normalizeRepoUrl(metadata["repository"]["url"]);
        }

        if (!repo_given) {
            return 0;
        }

        if (debug_mode) {
            console.log(repo_given);
        }

        // Clone github repo
        const workDir = path.resolve(`./repos/${package_name}`);

        try {
            if (debug_mode) {
                execFileSync('git', ['clone', '--depth=1', repo_given, workDir], { stdio: 'inherit' });
                execFileSync('npm', ['install', '--ignore-scripts'], { cwd: workDir, stdio: 'inherit' });
            }
            else {
                execFileSync('git', ['clone', '--depth=1', repo_given, workDir], { stdio: 'ignore' });
                execFileSync('npm', ['install', '--ignore-scripts'], { cwd: workDir, stdio: 'ignore' });
            }
        
        }
        catch (error) {
            if (debug_mode) {
                console.error("Couldn't run git clone or npm install", error)
            }
            return 0;
        }
    
        // run depcheck
        const options = {
            ignoreDirs: ['dist', 'build', 'test'],  // directories to ignore
            ignoreMatches: ['eslint*', 'eslint-plugin'],     // packages to ignore
        };

        try {
            const results = await depcheckAsync(workDir, options);
            let missing = results.missing ? Object.keys(results.missing).length : 0;

            if (missing > 0) {
                const phantomDeps = Object.keys(results.missing);
                const downloads = await count_downloads(package_name);
                // db.addPhantomDependencies(package_name, phantomDeps, downloads);

                if (debug_mode) {
                    console.log('\n\n===============================================================');
                    console.log("Package:", package_name, ". Number phantom:", missing);
                    console.log("Phantom dependencies:", phantomDeps.join(", "));
                }
            }
            return missing;
        }
        catch (error) {
            if (debug_mode) {
                console.error(error)
            }
        }
    }

    return 0;
}
