import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("agent defaults schema", () => {
  it("accepts subagent archiveAfterMinutes=0 to disable archiving", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          archiveAfterMinutes: 0,
        },
      }),
    ).not.toThrow();
  });

  it("accepts a valid slugTimeoutMs", () => {
    expect(() => AgentDefaultsSchema.parse({ slugTimeoutMs: 60_000 })).not.toThrow();
  });

  it("rejects slugTimeoutMs of zero or negative", () => {
    expect(() => AgentDefaultsSchema.parse({ slugTimeoutMs: 0 })).toThrow();
    expect(() => AgentDefaultsSchema.parse({ slugTimeoutMs: -1 })).toThrow();
  });

  it("rejects slugTimeoutMs above 300000", () => {
    expect(() => AgentDefaultsSchema.parse({ slugTimeoutMs: 300_001 })).toThrow();
  });
});
