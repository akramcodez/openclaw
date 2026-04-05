/**
 * Unit tests for llm-slug-generator — verifies that the config-driven
 * `slugTimeoutMs` is correctly forwarded to runEmbeddedPiAgent.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

// Hoist the mock reference so vi.mock can close over it.
const mocks = vi.hoisted(() => ({
  runEmbeddedPiAgent: vi.fn(),
}));

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: mocks.runEmbeddedPiAgent,
}));

// Stub out filesystem helpers so no temp dirs are created.
vi.mock("node:fs/promises", () => ({
  default: {
    mkdtemp: vi.fn().mockResolvedValue("/tmp/fake-slug-dir"),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

// Minimal stubs for agent-scope helpers.
vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn().mockReturnValue("main"),
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent"),
  resolveAgentEffectiveModelPrimary: vi.fn().mockReturnValue(null),
}));

let generateSlugViaLLM: typeof import("./llm-slug-generator.js").generateSlugViaLLM;

beforeAll(async () => {
  ({ generateSlugViaLLM } = await import("./llm-slug-generator.js"));
});

function makeResult(text: string) {
  return { payloads: [{ text }] };
}

describe("generateSlugViaLLM — timeout wiring", () => {
  it("uses the default 15 s timeout when slugTimeoutMs is unset", async () => {
    mocks.runEmbeddedPiAgent.mockResolvedValueOnce(makeResult("api-design"));

    await generateSlugViaLLM({ sessionContent: "hello", cfg: {} });

    expect(mocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it("forwards a custom slugTimeoutMs from config", async () => {
    mocks.runEmbeddedPiAgent.mockResolvedValueOnce(makeResult("vendor-pitch"));

    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: { agents: { defaults: { slugTimeoutMs: 60_000 } } },
    });

    expect(mocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });
});
