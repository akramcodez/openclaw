import { describe, expect, it, afterEach } from "vitest";
import { createRunningTaskRun } from "./task-executor.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "./task-registry.js";

describe("Cron Task Timestamp Invariants", () => {
  const originalDateNow = globalThis.Date.now;

  afterEach(() => {
    globalThis.Date.now = originalDateNow;
    resetTaskRegistryForTests();
  });

  it("cron tasks explicitly passing startedAt automatically clamp startedAt >= createdAt", () => {

    const startOfTime = Date.parse("2026-03-23T12:00:00.000Z");

    globalThis.Date.now = () => startOfTime + 5;

    const runId = "cron:test:run-123";
    createRunningTaskRun({
      runtime: "cron",
      sourceId: "test",
      ownerKey: "system",
      scopeKind: "session",
      requesterOrigin: undefined,
      runId,
      label: "Test cron task",
      task: "Doing work",
      startedAt: startOfTime,
    });

    const task = findTaskByRunId(runId);
    expect(task).toBeDefined();

    expect(task!.createdAt).toBe(startOfTime + 5);

    expect(task!.startedAt).toBeGreaterThanOrEqual(task!.createdAt);
    expect(task!.startedAt).toBe(startOfTime + 5);

  });

  it("default execution handlers implicitly receive startedAt identical to createdAt", () => {

    const startOfTime = Date.parse("2026-03-23T12:00:00.000Z");
    globalThis.Date.now = () => startOfTime;

    const runId = "subagent:test:run-123";
    createRunningTaskRun({
      runtime: "subagent",
      sourceId: "test",
      ownerKey: "system",
      scopeKind: "session",
      requesterOrigin: undefined,
      runId,
      label: "Test subagent task",
      task: "Doing work",
    });

    const task = findTaskByRunId(runId);
    expect(task).toBeDefined();

    expect(task!.createdAt).toBe(startOfTime);
    expect(task!.startedAt).toBeGreaterThanOrEqual(task!.createdAt);
    expect(task!.startedAt).toBe(startOfTime);

  });
});
