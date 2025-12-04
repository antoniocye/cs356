import { execSync } from "child_process";
import depcheck from "depcheck";

async function main() {
  const repoUrl = process.argv[2];

  if (!repoUrl) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: "no repo url provided" })
    );
    process.exit(1);
  }

  const workDir = "/workspace";

  try {
    execSync(`git clone --depth=1 ${repoUrl} ${workDir}`, {
      stdio: "ignore",
    });

    const options = {
      ignoreDirs: ["dist", "build", "test"],
      ignoreMatches: ["eslint*", "eslint-plugin"],
    };

    const results = await depcheck(workDir, options);


    const output = {
      ok: true,
      phantomDeps: Object.keys(results.missing || {}),                               
      unusedDeps: results.unusedDependencies || [],
      unusedDevDeps: results.unusedDevDependencies || [],
    };

    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: err && err.message ? err.message : String(err),
      })
    );
  }
}

main();