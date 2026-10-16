import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("is the package version, which the Gateway's metrics see in the user agent", () => {
    const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg).toMatchObject({ version: VERSION });
  });
});
