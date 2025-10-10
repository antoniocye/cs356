import names from "all-the-package-names" assert { type: 'json' };
import depcheck from 'depcheck';
import path from 'path';
import { execSync } from 'child_process';
import fs from "fs"

console.log("Total number of packages:", names.length);

function depcheckAsync(workDir, options) {
    return new Promise((resolve) => {
        depcheck(workDir, options, (results) => resolve(results));
    });
}

async function fetchWithRetries(url, options = {}, retries = 3, delayMs = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            return res; // success
        } catch (err) {
            console.warn(`Attempt ${attempt} failed: ${err.message}`);
            if (attempt === retries) throw err;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

// given an npm package name,
// (1) find the github repo corresponding to it
// (2) clone the repo
// (3) cd into the repo
// (4) npm install
// (5) run depcheck

const debug_mode = false
const filePath = 'phantom.txt';

async function add_to_db(package_name){

    // try to fetch data from registry.nmpjs.org
    let data;
    try{
        const res = await fetchWithRetries(`https://registry.npmjs.org/${package_name}`);
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
        console.log('\n\n===============================================================')
        console.log(`Working on ${package_name}`)
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

    // Use metadata to find github link
    let metadata = data.versions[latest_version]
    if(!metadata){
        console.log("Metadata is empty somehow but latest_version is given? Investigate further.");
        return 0;
    }

    if(!metadata.hasOwnProperty("repository") || metadata["repository"]?.["type"] != "git"){
        if("homepage" in metadata){
            console.log("Github link may be at 'homepage'. Here's given homepage:", metadata["homepage"]);
        }
        return 0;
    }

    let repo_given = metadata["repository"]["url"];
    if(!repo_given){
        return 0;
    }
    if(repo_given.slice(0,9) == "git+https"){
        repo_given = repo_given.slice(4);
    }
    if(repo_given.slice(0,3) == "git" && repo_given.slice(3,12) == "://github"){
        repo_given = "https" + repo_given.slice(3);
    }
    else if(repo_given.slice(0,5) != "https"){
        console.log("Doesn't fit in current model:", repo_given);
        return 0;
    }

    if(debug_mode){
        console.log(repo_given);
    }

    // Clone github link
    const workDir = path.resolve(`./repos/${package_name}`);

    try{
        if(debug_mode){
            execSync(`git clone --depth=1 ${repo_given} ${workDir}`, { stdio: 'inherit' });
            execSync('npm install --ignore-scripts', { cwd: workDir, stdio: 'inherit' });
        }
        else{
            execSync(`git clone --depth=1 ${repo_given} ${workDir}`, { stdio: 'ignore' });
            execSync('npm install --ignore-scripts', { cwd: workDir, stdio: 'ignore' });
        }
        
    }
    catch(error){
        if(debug_mode){
            console.error("Couldn't run git clone or npm install", error)
        }
        return 0;
    }
    
    // run depcheck
    const options = {
      ignoreDirs: ['dist', 'build', 'test'],  // directories to ignore
      ignoreMatches: ['eslint*', 'eslint-plugin'],     // packages to ignore
    };

    try{
        const results = await depcheckAsync(workDir, options);
        let missing = results.missing ? Object.keys(results.missing).length : 0;

        if(missing > 0){
            let newLine = package_name + ": ";
            for(let missing_name in results.missing){
                newLine += missing_name + " ";
            }
            newLine += "\n"
            fs.appendFileSync(filePath, newLine, 'utf-8');

            if (debug_mode) {
                console.log('\n\n===============================================================');
                console.log("Package:", package_name, ". Number phantom:", missing);
            }
        }
        return missing;
    }
    catch(error){
        if(debug_mode){
            console.error(error)
        }
    }

    return 0;
}

let num_missing = 0;
let start = 150000;
let end = 150200;
console.log("Starting process for range", "[" + start + ":" + end + "]");
for(let i=start; i<end; i++){
    const package_name = names[i]
    num_missing += await add_to_db(package_name)
    if((i-start) % 20 == 0){
        console.log("Processed:", 100 * ((i-start) / (end-start)), "%. Number phantom found:", num_missing);
    }
}