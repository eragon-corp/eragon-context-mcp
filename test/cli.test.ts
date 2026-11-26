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

  it("refuses to forward an inherited Claude Code key to a different Gateway", () => {
    const result = resolveConfig(["--url", "https://second.example/gw"], {
      ANTHROPIC_BASE_URL: "https://first.example/gw",
      ANTHROPIC_AUTH_TOKEN: "first-gateway-key",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("Claude Code Gateway URL"),
    });
  });

  it("accepts equivalent spellings of the Claude Code Gateway URL", () => {
    const result = resolveConfig(["--url", "https://tenant.example/gw"], {
      ANTHROPIC_BASE_URL: "https://TENANT.example:443/gw/",
      ANTHROPIC_API_KEY: "claude-code-key",
    });

    expect(result).toEqual({ ok: true, gatewayUrl: "https://tenant.example/gw", token: "claude-code-key" });
  });

  it("uses the key the Connect page gives Claude Code in ANTHROPIC_AUTH_TOKEN", () => {
    expect(
      resolveConfig([], {
        ANTHROPIC_BASE_URL: "https://s.eragon.ai/gw",
        ANTHROPIC_AUTH_TOKEN: "model-key",
      }),
    ).toEqual({ ok: true, gatewayUrl: "https://s.eragon.ai/gw", token: "model-key" });
  });

  it("rejects multiline credentials before the server can advertise Memory tools", () => {
    const result = resolveConfig([], {
      ERAGON_GATEWAY_URL: "http://127.0.0.1:1/gw",
      ERAGON_API_KEY: "fixture-key\nhelper diagnostics",
    });

    expect(result).toEqual({ ok: false, error: "The Gateway key must be a single printable token." });
  });

  it("refuses to save Memory under a different key than the model calls use", () => {
    const resolved = resolveConfig([], {
      ANTHROPIC_BASE_URL: "https://s.eragon.ai/gw",
      ANTHROPIC_AUTH_TOKEN: "new-model-key",
      ERAGON_API_KEY: "old-memory-key",
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain("ERAGON_API_KEY");
      expect(resolved.error).not.toContain("old-memory-key");
      expect(resolved.error).not.toContain("new-model-key");
    }
  });

  it("checks the key Claude Code sends, which is ANTHROPIC_API_KEY when both are set", () => {
    expect(
      resolveConfig([], {
        ANTHROPIC_BASE_URL: "https://s.eragon.ai/gw",
        ANTHROPIC_API_KEY: "model-key",
        ANTHROPIC_AUTH_TOKEN: "unused-token",
        ERAGON_API_KEY: "model-key",
      }),
    ).toEqual({ ok: true, gatewayUrl: "https://s.eragon.ai/gw", token: "model-key" });
  });

  it("accepts ERAGON_API_KEY beside the same model key", () => {
    expect(
      resolveConfig([], {
        ANTHROPIC_BASE_URL: "https://s.eragon.ai/gw",
        ANTHROPIC_AUTH_TOKEN: "one-key",
        ERAGON_API_KEY: "one-key",
      }),
    ).toEqual({ ok: true, gatewayUrl: "https://s.eragon.ai/gw", token: "one-key" });
  });

  it("does not compare keys when model calls do not go through a base URL", () => {
    expect(
      resolveConfig(["--url", "https://s.eragon.ai/gw"], {
        ANTHROPIC_API_KEY: "anthropic-direct-key",
        ERAGON_API_KEY: "memory-key",
      }),
    ).toEqual({ ok: true, gatewayUrl: "https://s.eragon.ai/gw", token: "memory-key" });
  });
});
