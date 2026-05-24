import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function loadAllNpmPackageNames() {
  return require("all-the-package-names");
}
