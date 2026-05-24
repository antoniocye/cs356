import test from "node:test";
import assert from "node:assert/strict";
import { makeClosureComputer } from "../src/analyze-npm.js";

test("computes transitive dependency closure without looping on cycles", () => {
  const db = {
    packages: {
      root: { deps: { a: "^1.0.0" } },
      a: { deps: { b: "^1.0.0" } },
      b: { deps: { a: "^1.0.0", c: "^1.0.0" } },
      c: { deps: {} },
    },
  };

  const closureFor = makeClosureComputer(db);
  assert.deepEqual([...closureFor("root")].sort(), ["a", "b", "c"]);
});
