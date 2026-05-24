import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFamilyIndex,
  familyKeysForPackage,
  packagesShareFamily,
} from "../src/families.js";

test("uses npm scope and GitHub owner as family identifiers", () => {
  const keys = familyKeysForPackage("@scope/pkg", {
    meta: {
      repository: { url: "git+https://github.com/owner/repo.git" },
    },
  });

  assert.equal(keys.has("npm-scope:scope"), true);
  assert.equal(keys.has("github-owner:owner"), true);
});

test("detects packages in the same inferred family", () => {
  const db = {
    packages: {
      "@scope/a": { meta: { repository: { url: "https://github.com/one/a" } } },
      "@scope/b": { meta: { repository: { url: "https://github.com/two/b" } } },
      "external": { meta: { repository: { url: "https://github.com/other/c" } } },
    },
    families: [],
  };
  const index = buildFamilyIndex(db);

  assert.equal(packagesShareFamily(index, "@scope/a", "@scope/b"), true);
  assert.equal(packagesShareFamily(index, "@scope/a", "external"), false);
});
