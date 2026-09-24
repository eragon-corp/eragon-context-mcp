import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/cli.js";

describe("resolveConfig", () => {
  it("uses Claude Code's existing Gateway environment without storing another secret", () => {
    expect(
      resolveConfig([], {
        ANTHROPIC_BASE_URL: "https://s.eragon.ai/gw",
        ANTHROPIC_API_KEY: "test-token",
      }),
    ).toEqual({
      ok: true,
      gatewayUrl: "https://s.eragon.ai/gw",
      token: "test-token",
    });
  });

  it("lets an explicit URL override the model Gateway URL", () => {
    expect(
      resolveConfig(["--url", "https://preview.s.eragon.ai/gw"], {
        ERAGON_GATEWAY_URL: "https://s.eragon.ai/gw",
        ERAGON_API_KEY: "test-token",
      }),
    ).toEqual({
      ok: true,
      gatewayUrl: "https://preview.s.eragon.ai/gw",
      token: "test-token",
    });
  });
});
