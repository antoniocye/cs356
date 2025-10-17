import fs from 'fs';
import path from 'path';
import { db } from './database.js';

const phantomPath = path.resolve('./phantom.txt');

function parsePhantomLine(line){
  // Example line: "@boklisten/bl-web: @types/resize-observer-browser node_modules/codelyzer @types/jasminewd2 "
  const parts = line.split(':');
  if(parts.length < 2) return null;
  const packageName = parts[0].trim();
  const depsStr = parts.slice(1).join(':').trim();
  if(!depsStr) return null;
  // split by whitespace, filter empty
  const deps = depsStr.split(/\s+/).filter(Boolean);
  return { packageName, deps };
}

function seedFromPhantomTxt(){
  if(!fs.existsSync(phantomPath)){
    console.error('phantom.txt not found at', phantomPath);
    process.exit(1);
  }

  const content = fs.readFileSync(phantomPath, 'utf-8');
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let count = 0;
  for(const line of lines){
    const parsed = parsePhantomLine(line);
    if(parsed){
      db.addPhantomDependencies(parsed.packageName, parsed.deps, null);
      count++;
    }
  }

  console.log(`Seeded ${count} entries from phantom.txt`);
}

seedFromPhantomTxt();
