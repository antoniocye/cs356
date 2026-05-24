import { execFile } from "node:child_process";
import { getRepoUrlFromPackageRecord } from "./repo-url.js";

export function runDepcheckContainer(repoUrl, {
  image = "depcheck-runner:latest",
  timeoutMs = 15 * 60 * 1000,
} = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      "docker",
      ["run", "--rm", image, repoUrl],
      { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            repoUrl,
            phantomDeps: [],
            unusedDeps: [],
            unusedDevDeps: [],
            error: `Docker error: ${error.message}${stderr ? `; stderr: ${stderr}` : ""}`,
          });
          return;
        }

        if (!stdout) {
          resolve({
            ok: false,
            repoUrl,
            phantomDeps: [],
            unusedDeps: [],
            unusedDevDeps: [],
            error: "No output from depcheck container.",
          });
          return;
        }

        try {
          const parsed = JSON.parse(stdout.toString("utf8"));
          resolve({
            ok: Boolean(parsed.ok),
            repoUrl,
            phantomDeps: parsed.phantomDeps || parsed.missing || [],
            unusedDeps: parsed.unusedDeps || [],
            unusedDevDeps: parsed.unusedDevDeps || [],
            error: parsed.ok ? undefined : parsed.error || "depcheck runner reported failure.",
          });
        } catch (parseError) {
          resolve({
            ok: false,
            repoUrl,
            phantomDeps: [],
            unusedDeps: [],
            unusedDevDeps: [],
            error: `Failed to parse depcheck JSON: ${parseError.message}`,
          });
        }
      },
    );

    child.on("error", (error) => {
      resolve({
        ok: false,
        repoUrl,
        phantomDeps: [],
        unusedDeps: [],
        unusedDevDeps: [],
        error: `Failed to start docker: ${error.message}`,
      });
    });
  });
}

export async function runPackageDepcheck(packageName, packageRecord, options = {}) {
  const repoUrl = getRepoUrlFromPackageRecord(packageRecord);
  if (!repoUrl) {
    return {
      ok: false,
      packageName,
      repoUrl: null,
      phantomDeps: [],
      unusedDeps: [],
      unusedDevDeps: [],
      error: "No usable source repository URL found.",
    };
  }

  const result = await runDepcheckContainer(repoUrl, options);
  return { packageName, ...result };
}
