import test from "node:test";
import assert from "node:assert/strict";
import { getGithubOwner, normalizeRepoUrl } from "../src/repo-url.js";

test("normalizes common npm repository URL formats", () => {
  assert.equal(
    normalizeRepoUrl("git+https://github.com/example/project.git#readme"),
    "https://github.com/example/project",
  );
  assert.equal(
    normalizeRepoUrl("git@github.com:example/project.git"),
    "https://github.com/example/project",
  );
  assert.equal(
    normalizeRepoUrl("git://github.com/example/project.git"),
    "https://github.com/example/project",
  );
  assert.equal(
    normalizeRepoUrl("github:example/project"),
    "https://github.com/example/project",
  );
});

test("extracts GitHub owners", () => {
  assert.equal(getGithubOwner("https://github.com/Example/Project"), "example");
  assert.equal(getGithubOwner("https://gitlab.com/example/project"), null);
});
