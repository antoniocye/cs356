import names from "all-the-package-names" assert { type: 'json' };
import fs from 'fs'
import { count_downloads } from "./all_names";


// the following will find the top 1000 packages downlaoded in the past 6 months and will write it to file_name
export async function find_top_1000(file_name, start = 0, end = names.length) {
  const chosen = [];

  for (let i = start; i < end; i++) {
    if(i != 0 && i % 50000 == 0){
        console.log(`Done up to ${i} at ${new Date().toLocaleString()}`);
        fs.writeFileSync(`./output_files/partial_top_1000_${i}.json`, JSON.stringify(chosen, null, 2));
    }
    const name = names[i];
    const back_s = name.indexOf("/");

    const count = parseInt(await count_downloads(name), 10);
    if (!count) continue;

    if (chosen.length < 1000) {
      chosen.push([count, name]);
      chosen.sort((a, b) => a[0] - b[0]);
    } else if (count > chosen[0][0]) {
      chosen[0] = [count, name];
      chosen.sort((a, b) => a[0] - b[0]);
    }
  }
  fs.writeFileSync(file_name, JSON.stringify(chosen, null, 2));
}
console.log(`Started process at ${new Date().toLocaleString()} with a total of ${names.length} packages in npm`);
await find_top_1000("./output_files/top1000.json", 0, names.length);