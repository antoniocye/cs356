import names from "all-the-package-names" assert { type: 'json' };
import fs from 'fs'
import { count_downloads } from "./util.js";


export async function find_random_1000(file_name) {
  const chosenIndices = [];
  const chosen = [];

  while(chosen.length < 1000){
    const randomIndex = Math.floor(Math.random() * names.length);
    if(!chosenIndices.includes(randomIndex)){
        chosenIndices.push(randomIndex);
        const count = parseInt(await count_downloads(names[randomIndex]), 10);
        if (!count) continue;
        chosen.push([count, names[randomIndex]]);
    }
  }
  fs.writeFileSync(file_name, JSON.stringify(chosen, null, 2));
}
await find_random_1000("../output_file_random_1000/random1000.json");