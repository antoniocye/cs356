export function normalizeRepoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;

  let repo = rawUrl.trim().replace(/^git\+/, "").replace(/#.*$/, "");

  if (repo.startsWith("github:")) {
    repo = `https://github.com/${repo.slice("github:".length)}`;
  } else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    repo = `https://github.com/${repo}`;
  }

  if (repo.startsWith("git://github.com/")) {
    repo = `https://${repo.slice("git://".length)}`;
  } else if (repo.startsWith("ssh://git@github.com/")) {
    repo = repo.replace("ssh://git@", "https://");
  } else if (repo.startsWith("git@github.com:")) {
    repo = repo.replace("git@github.com:", "https://github.com/");
  }

  if (repo.startsWith("http://github.com/")) {
    repo = repo.replace("http://", "https://");
  }

  if (!repo.startsWith("https://")) return null;

  try {
    const url = new URL(repo);
    if (!url.hostname) return null;
    url.search = "";
    url.hash = "";
    let pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.endsWith(".git")) pathname = pathname.slice(0, -4);
    if (!pathname || pathname === "/") return null;
    url.pathname = pathname;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function getRepoUrlFromPackageRecord(packageRecord) {
  if (!packageRecord?.meta) return null;
  const { repository, homepage } = packageRecord.meta;

  const repositoryUrl = typeof repository === "string" ? repository : repository?.url;
  const normalizedRepository = normalizeRepoUrl(repositoryUrl);
  if (normalizedRepository) return normalizedRepository;

  const normalizedHomepage = normalizeRepoUrl(homepage);
  if (normalizedHomepage) return normalizedHomepage;

  return null;
}

export function getGithubOwner(repoUrl) {
  const normalized = normalizeRepoUrl(repoUrl);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    if (url.hostname !== "github.com") return null;
    const [, owner] = url.pathname.split("/");
    return owner ? owner.toLowerCase() : null;
  } catch {
    return null;
  }
}
