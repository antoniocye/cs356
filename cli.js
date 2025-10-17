import inquirer from 'inquirer';
import names from "all-the-package-names" assert { type: 'json' };
import { count_downloads, add_to_db } from './all_names.js';
import { auto_range_start, auto_range_end } from './config.js';
import { db } from './database.js';

async function run_cli(){
    let num_packages = names.length;
    console.log("Total number of packages (from all-the-package-names):", num_packages, "\n");
    
    let range_start = auto_range_start, range_end = auto_range_end;

    const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'task',
      message: 'What task do you want to do?',
      choices: [
        { name: 'Count downloads (custom range)', value: 1 },
        { name: 'Count downloads (auto range)', value: 2 },
        { name: 'Add to database (custom range)', value: 3 },
        { name: 'Add to database (auto range)', value: 4 }
      ]
    },
    {
      type: 'input',
      name: 'range_start',
      message: 'Start range:',
      when: (answers) => answers.task === 1 || answers.task === 3,
      validate: (input) => {
        const val = parseInt(input, 10);
        if (isNaN(val) || val <= 0) return 'Must be a positive integer';
        if (val > num_packages) return `Must be <= ${num_packages-1}`;
        range_start = val;
        return true;
      }
    },
    {
      type: 'input',
      name: 'range_end',
      message: 'End range:',
      when: (answers) => answers.task === 1 || answers.task === 3,
      validate: (input, answers) => {
        const val = parseInt(input, 10);
        if (isNaN(val) || val <= 0) return 'Must be a positive integer';
        if (val > num_packages) return `Must be <= ${num_packages}`;
        if (val < range_start) return 'End range cannot be less than start range';
        return true;
      }
    }
  ]);

  if(answers.task === 1 || answers.task === 3){
    range_start = answers.range_start;
    range_end = answers.range_end;
  }

  console.log("Starting process for range", "[" + range_start + ":" + range_end + "]\n");

  if(answers.task === 1 || answers.task === 2){
    for(let i = range_start; i < range_end; i++){
        let package_name = names[i];
        let count = await count_downloads(package_name);
        if(count > 0){
            console.log(`${package_name}: ${count}`);
        }
    }
  }

  if(answers.task === 3 || answers.task === 4){
    let num_missing = 0;

    for(let i = range_start; i < range_end; i++){
        let package_name = names[i]
        num_missing += await add_to_db(package_name);
        if((i-range_start) % 20 == 0){
            console.log("Processed:", 100 * ((i-range_start) / (range_end-range_start)), "%. Number phantom found:", num_missing);
        }
    }
  }

}


run_cli();