import { loadAllNpmPackageNames } from "./package-names.js";
import { mapLimit } from "./concurrency.js";
import { writeJson } from "./fs-utils.js";

export const DEFAULT_DOWNLOAD_START = "2025-05-11";
export const DEFAULT_DOWNLOAD_END = "2025-11-11";

export async function fetchJsonWithRetries(url, {
  retries = 3,
  delayMs = 1000,
  fetchOptions = {},
  allow404 = false,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, fetchOptions);
      if (allow404 && response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

export async function getNpmLatestMetadata(packageName) {
  const encoded = encodeURIComponent(packageName).replace("%2F", "/");
  const data = await fetchJsonWithRetries(
    `https://registry.npmjs.org/${encoded}/latest`,
    { allow404: true },
  );
  if (!data) return {};

  const meta = {
    ...(data.author && { author: data.author }),
    ...(data.maintainers && { maintainers: data.maintainers }),
    ...(data.homepage && { homepage: data.homepage }),
    ...(data.bugs && { bugs: data.bugs }),
    ...(data.repository && { repository: data.repository }),
  };

  return {
    dev_deps: data.devDependencies || {},
    deps: data.dependencies || {},
    version: data.version || null,
    meta,
  };
}

export async function getNpmDownloadCount(
  packageName,
  {
    startDate = DEFAULT_DOWNLOAD_START,
    endDate = DEFAULT_DOWNLOAD_END,
  } = {},
) {
  const encoded = encodeURIComponent(packageName).replace("%2F", "/");
  const data = await fetchJsonWithRetries(
    `https://api.npmjs.org/downloads/range/${startDate}:${endDate}/${encoded}`,
    { allow404: true },
  );
  if (!data?.downloads) return 0;
  return data.downloads.reduce((total, entry) => total + Number(entry.downloads || 0), 0);
}

function updateTopList(top, candidate, limit) {
  if (!Number.isFinite(candidate.downloads) || candidate.downloads <= 0) return;
  if (top.length < limit) {
    top.push(candidate);
  } else if (candidate.downloads > top[0].downloads) {
    top[0] = candidate;
  } else {
    return;
  }
  top.sort((a, b) => a.downloads - b.downloads);
}

export async function collectTopNpmPackages({
  outFile,
  limit = 1000,
  startIndex = 0,
  endIndex = null,
  startDate = DEFAULT_DOWNLOAD_START,
  endDate = DEFAULT_DOWNLOAD_END,
  concurrency = 48,
  checkpointEvery = 50000,
  logger = console,
} = {}) {
  const names = loadAllNpmPackageNames();
  const boundedEnd = endIndex === null ? names.length : Math.min(endIndex, names.length);
  const indexes = [];
  for (let i = startIndex; i < boundedEnd; i += 1) indexes.push(i);

  const top = [];
  let processed = 0;

  await mapLimit(indexes, concurrency, async (index) => {
    const name = names[index];
    try {
      const downloads = await getNpmDownloadCount(name, { startDate, endDate });
      updateTopList(top, { downloads, name }, limit);
    } catch (error) {
      logger.warn?.(`download count failed for ${name}: ${error.message}`);
    }

    processed += 1;
    if (checkpointEvery > 0 && processed % checkpointEvery === 0) {
      const checkpoint = top
        .slice()
        .sort((a, b) => b.downloads - a.downloads)
        .map(({ downloads, name }) => [downloads, name]);
      await writeJson(outFile.replace(/\.json$/, `.partial-${processed}.json`), checkpoint);
      logger.log?.(`Processed ${processed}/${indexes.length} package names`);
    }
  });

  const result = top
    .slice()
    .sort((a, b) => b.downloads - a.downloads)
    .map(({ downloads, name }) => [downloads, name]);
  await writeJson(outFile, result);
  return result;
}
