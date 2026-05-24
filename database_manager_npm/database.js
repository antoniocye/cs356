import { fileURLToPath } from "node:url";
import { DatabaseManager } from "../src/database-manager.js";

export { DatabaseManager };

async function main() {
  const dbPath = process.argv[2] || "database.json";
  const manager = new DatabaseManager(dbPath);
  await manager.init({ repair: process.argv.includes("--repair") });

  if (process.argv.includes("--run-depcheck")) {
    await manager.runDepcheck();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
