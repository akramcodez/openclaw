import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/loop-detection");

export type LoopDetectionResult =
  | { stuck: false }
  | { stuck: true; level: "warning" | "critical"; message: string };

export const TOOL_CALL_HISTORY_SIZE = 30;
export const WARNING_THRESHOLD = 10;
export const CRITICAL_THRESHOLD = 20;
export const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;

/**
 * Hash a tool call for pattern matching.
 * Uses tool name + deterministic JSON stringification of params.
 */
export function hashToolCall(toolName: string, params: unknown): string {
  try {
    const paramsStr = stableStringify(params);
    return `${toolName}:${paramsStr}`;
  } catch {
    return `${toolName}:${String(params)}`;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownPollToolCall(toolName: string, params: unknown): boolean {
  if (toolName === "command_status") {
    return true;
  }
  if (toolName !== "process" || !isPlainObject(params)) {
    return false;
  }
  const action = params.action;
  return action === "poll" || action === "log";
}

function extractTextContent(result: unknown): string {
  if (!isPlainObject(result) || !Array.isArray(result.content)) {
    return "";
  }
  return result.content
    .filter(
      (entry): entry is { type: string; text: string } =>
        isPlainObject(entry) && typeof entry.type === "string" && typeof entry.text === "string",
    )
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function formatErrorForHash(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return `${error}`;
  }
  return stableStringify(error);
}

function hashToolOutcome(
  toolName: string,
  params: unknown,
  result: unknown,
  error: unknown,
): string | undefined {
  if (error !== undefined) {
    return `error:${formatErrorForHash(error)}`;
  }
  if (!isPlainObject(result)) {
    return result === undefined ? undefined : stableStringify(result);
  }

  const details = isPlainObject(result.details) ? result.details : {};
  const text = extractTextContent(result);
  if (isKnownPollToolCall(toolName, params) && toolName === "process" && isPlainObject(params)) {
    const action = params.action;
    if (action === "poll") {
      return stableStringify({
        action,
        status: details.status,
        exitCode: details.exitCode ?? null,
        exitSignal: details.exitSignal ?? null,
        aggregated: details.aggregated ?? null,
        text,
      });
    }
    if (action === "log") {
      return stableStringify({
        action,
        status: details.status,
        totalLines: details.totalLines ?? null,
        totalChars: details.totalChars ?? null,
        truncated: details.truncated ?? null,
        exitCode: details.exitCode ?? null,
        exitSignal: details.exitSignal ?? null,
        text,
      });
    }
  }

  return stableStringify({
    details,
    text,
  });
}

function getNoProgressStreak(
  history: Array<{ toolName: string; argsHash: string; resultHash?: string }>,
  toolName: string,
  argsHash: string,
): number {
  let streak = 0;
  let latestResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName || record.argsHash !== argsHash) {
      continue;
    }
    if (typeof record.resultHash !== "string" || !record.resultHash) {
      continue;
    }
    if (!latestResultHash) {
      latestResultHash = record.resultHash;
      streak = 1;
      continue;
    }
    if (record.resultHash !== latestResultHash) {
      break;
    }
    streak += 1;
  }

  return streak;
}

/**
 * Detect if an agent is stuck in a repetitive tool call loop.
 * Checks if the same tool+params combination has been called excessively.
 */
export function detectToolCallLoop(
  state: SessionState,
  toolName: string,
  params: unknown,
): LoopDetectionResult {
  const history = state.toolCallHistory ?? [];
  const currentHash = hashToolCall(toolName, params);
  const noProgressStreak = getNoProgressStreak(history, toolName, currentHash);
  const knownPollTool = isKnownPollToolCall(toolName, params);

  if (noProgressStreak >= GLOBAL_CIRCUIT_BREAKER_THRESHOLD) {
    log.error(
      `Global circuit breaker triggered: ${toolName} repeated ${noProgressStreak} times with no progress`,
    );
    return {
      stuck: true,
      level: "critical",
      message: `CRITICAL: ${toolName} has repeated identical no-progress outcomes ${noProgressStreak} times. Session execution blocked by global circuit breaker to prevent runaway loops.`,
    };
  }

  if (knownPollTool && noProgressStreak >= CRITICAL_THRESHOLD) {
    log.error(`Critical polling loop detected: ${toolName} repeated ${noProgressStreak} times`);
    return {
      stuck: true,
      level: "critical",
      message: `CRITICAL: Called ${toolName} with identical arguments and no progress ${noProgressStreak} times. This appears to be a stuck polling loop. Session execution blocked to prevent resource waste.`,
    };
  }

  if (knownPollTool && noProgressStreak >= WARNING_THRESHOLD) {
    log.warn(`Polling loop warning: ${toolName} repeated ${noProgressStreak} times`);
    return {
      stuck: true,
      level: "warning",
      message: `WARNING: You have called ${toolName} ${noProgressStreak} times with identical arguments and no progress. Stop polling and either (1) increase wait time between checks, or (2) report the task as failed if the process is stuck.`,
    };
  }

  // Generic detector: warn-only for repeated identical calls.
  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === currentHash,
  ).length;

  if (!knownPollTool && recentCount >= WARNING_THRESHOLD) {
    log.warn(`Loop warning: ${toolName} called ${recentCount} times with identical arguments`);
    return {
      stuck: true,
      level: "warning",
      message: `WARNING: You have called ${toolName} ${recentCount} times with identical arguments. If this is not making progress, stop retrying and report the task as failed.`,
    };
  }

  return { stuck: false };
}

/**
 * Record a tool call in the session's history for loop detection.
 * Maintains sliding window of last N calls.
 */
export function recordToolCall(
  state: SessionState,
  toolName: string,
  params: unknown,
  toolCallId?: string,
): void {
  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }

  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    toolCallId,
    timestamp: Date.now(),
  });

  if (state.toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    state.toolCallHistory.shift();
  }
}

/**
 * Record a completed tool call outcome so loop detection can identify no-progress repeats.
 */
export function recordToolCallOutcome(
  state: SessionState,
  params: {
    toolName: string;
    toolParams: unknown;
    toolCallId?: string;
    result?: unknown;
    error?: unknown;
  },
): void {
  const resultHash = hashToolOutcome(
    params.toolName,
    params.toolParams,
    params.result,
    params.error,
  );
  if (!resultHash) {
    return;
  }

  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }

  const argsHash = hashToolCall(params.toolName, params.toolParams);
  let matched = false;
  for (let i = state.toolCallHistory.length - 1; i >= 0; i -= 1) {
    const call = state.toolCallHistory[i];
    if (!call) {
      continue;
    }
    if (params.toolCallId && call.toolCallId !== params.toolCallId) {
      continue;
    }
    if (call.toolName !== params.toolName || call.argsHash !== argsHash) {
      continue;
    }
    if (call.resultHash !== undefined) {
      continue;
    }
    call.resultHash = resultHash;
    matched = true;
    break;
  }

  if (!matched) {
    state.toolCallHistory.push({
      toolName: params.toolName,
      argsHash,
      toolCallId: params.toolCallId,
      resultHash,
      timestamp: Date.now(),
    });
  }

  if (state.toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    state.toolCallHistory.splice(0, state.toolCallHistory.length - TOOL_CALL_HISTORY_SIZE);
  }
}

/**
 * Get current tool call statistics for a session (for debugging/monitoring).
 */
export function getToolCallStats(state: SessionState): {
  totalCalls: number;
  uniquePatterns: number;
  mostFrequent: { toolName: string; count: number } | null;
} {
  const history = state.toolCallHistory ?? [];
  const patterns = new Map<string, { toolName: string; count: number }>();

  for (const call of history) {
    const key = call.argsHash;
    const existing = patterns.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      patterns.set(key, { toolName: call.toolName, count: 1 });
    }
  }

  let mostFrequent: { toolName: string; count: number } | null = null;
  for (const pattern of patterns.values()) {
    if (!mostFrequent || pattern.count > mostFrequent.count) {
      mostFrequent = pattern;
    }
  }

  return {
    totalCalls: history.length,
    uniquePatterns: patterns.size,
    mostFrequent,
  };
}
