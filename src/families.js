import { getGithubOwner, getRepoUrlFromPackageRecord } from "./repo-url.js";

export function getNpmScope(packageName) {
  if (!packageName?.startsWith("@") || !packageName.includes("/")) return null;
  return packageName.slice(1, packageName.indexOf("/")).toLowerCase();
}

function hostFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    const url = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function emailDomain(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return null;
  return email.split("@").pop().toLowerCase();
}

export function familyKeysForPackage(packageName, packageRecord, {
  includeAuthorHeuristics = false,
} = {}) {
  const keys = new Set();
  const scope = getNpmScope(packageName);
  if (scope) keys.add(`npm-scope:${scope}`);

  const repoOwner = getGithubOwner(getRepoUrlFromPackageRecord(packageRecord));
  if (repoOwner) keys.add(`github-owner:${repoOwner}`);

  if (includeAuthorHeuristics) {
    const author = packageRecord?.meta?.author;
    const authorUrlHost = hostFromUrl(author?.url);
    const homepageHost = hostFromUrl(packageRecord?.meta?.homepage);
    const authorDomain = emailDomain(author?.email);
    if (authorUrlHost) keys.add(`author-url:${authorUrlHost}`);
    if (homepageHost) keys.add(`homepage:${homepageHost}`);
    if (authorDomain) keys.add(`author-email:${authorDomain}`);
  }

  return keys;
}

export function buildFamilyIndex(db, options = {}) {
  const packageKeys = new Map();
  for (const [packageName, packageRecord] of Object.entries(db.packages || {})) {
    packageKeys.set(packageName, familyKeysForPackage(packageName, packageRecord, options));
  }

  for (const family of db.families || []) {
    const familyPackages = Array.isArray(family.packages) ? family.packages : [];
    const familyProperties = Array.isArray(family.properties) ? family.properties : [];
    for (const packageName of familyPackages) {
      if (!packageKeys.has(packageName)) packageKeys.set(packageName, new Set());
      for (const property of familyProperties) {
        if (property) packageKeys.get(packageName).add(`legacy:${String(property).toLowerCase()}`);
      }
    }
  }

  return packageKeys;
}

export function packagesShareFamily(packageKeys, leftName, rightName) {
  const left = packageKeys.get(leftName);
  const right = packageKeys.get(rightName);
  if (!left?.size || !right?.size) return false;
  for (const key of left) {
    if (right.has(key)) return true;
  }
  return false;
}

export function constructMetaLight(packageName, packageRecord) {
  const meta = packageRecord?.meta || {};
  const metaLight = {};
  const scope = getNpmScope(packageName);
  if (scope) metaLight.domain = scope;

  const repoOwner = getGithubOwner(getRepoUrlFromPackageRecord(packageRecord));
  if (repoOwner) metaLight.repo_domain = repoOwner;

  if (meta.author?.url) metaLight.author_url = meta.author.url;
  if (meta.author?.email) metaLight.author_email = meta.author.email;
  if (meta.homepage) metaLight.homepage = meta.homepage;

  return metaLight;
}
