/** Deterministic decisions over Pi event data; no SDK handles or runtime ownership. */
export type Outcome = "ok" | "error" | "cancelled" | "interrupted";

export function modelOutcome(stopReason: string): Outcome {
  return stopReason === "aborted" ? "cancelled" : stopReason === "error" ? "error" : "ok";
}
export function completionOutcome(aborted: boolean, failed: boolean): Outcome {
  return aborted ? "cancelled" : failed ? "error" : "ok";
}
export function requestAttributes(model?: { provider: string; id: string }) {
  return {
    "gen_ai.provider.name": model?.provider ?? "unknown",
    "gen_ai.request.model": model?.id ?? "unknown",
  };
}
export function responseAttributes(provider: string, model: string, stopReason: string) {
  return {
    "gen_ai.provider.name": provider,
    "gen_ai.response.model": model,
    "gen_ai.response.finish_reasons": [stopReason],
    ...(modelOutcome(stopReason) === "error" ? { "error.type": "model_error" } : {}),
  };
}
/** Provider error text for failed model calls; absent when Pi recorded none. */
export function modelError(stopReason: string, errorMessage?: string) {
  return modelOutcome(stopReason) === "error" && errorMessage
    ? { name: "model_error", message: errorMessage }
    : undefined;
}
export function toolAttributes(name: string) {
  return { "gen_ai.tool.name": name };
}
export function toolCompletionAttributes(outcome: Outcome, durationMs?: number) {
  return {
    "pi.tool.executed": durationMs !== undefined,
    ...(durationMs !== undefined ? { "pi.tool.execution.duration_ms": durationMs } : {}),
    ...(outcome === "error" ? { "error.type": "tool_error" } : {}),
  };
}
/** Shell tools report the command's exit code in structuredContent. */
export function toolResultAttributes(result: unknown) {
  const code = (result as { structuredContent?: { exit_code?: unknown } } | null)?.structuredContent
    ?.exit_code;
  return Number.isInteger(code) ? { "process.exit.code": code as number } : {};
}
/** Tool results repeat their text in details/structuredContent; the model sees only content. */
export function toolOutputContent(result: unknown) {
  const content = (result as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? content : result;
}
/** Thinking signatures are opaque provider ciphertext: useless to readers, costly to store. */
export function assistantContent(content: unknown) {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block?.type !== "thinking" || !("thinkingSignature" in block)) return block;
    const { thinkingSignature: _signature, ...rest } = block;
    return rest;
  });
}

export interface Usage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown; totalFromProvider?: unknown };
}
const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Pi buckets are disjoint: never add reasoning or cost components a second time. */
export function usageMeasurements(usage: Usage | null | undefined) {
  const tokens = (["input", "output", "cacheRead", "cacheWrite"] as const).flatMap((bucket) => {
    const value = usage?.[bucket];
    return finiteNonnegative(value) ? [{ bucket, value }] : [];
  });
  const total = usage?.cost?.total;
  const cost = finiteNonnegative(total)
    ? { value: total, source: usage?.cost?.totalFromProvider ? "provider" : "estimated" }
    : undefined;
  return { tokens, cost };
}

export type SerializedContent =
  | { kind: "disabled" }
  | { kind: "invalid" }
  | { kind: "content"; body: string; bytes: number };

/** JSON data only: accessors/toJSON supplied by callers may themselves have effects. */
export function serializeContent(enabled: boolean, value: unknown): SerializedContent {
  if (!enabled) return { kind: "disabled" };
  try {
    const body = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
    return { kind: "content", body, bytes: new TextEncoder().encode(body).byteLength };
  } catch {
    return { kind: "invalid" };
  }
}

/** GenAI semconv span usage; input_tokens includes cached input, unlike Pi's disjoint buckets. */
export function usageAttributes(usage: Usage | null | undefined) {
  const tokens = Object.fromEntries(
    usageMeasurements(usage).tokens.map(({ bucket, value }) => [bucket, value]),
  ) as Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite", number>>;
  const attrs: Record<string, number> = {};
  if (
    tokens.input !== undefined ||
    tokens.cacheRead !== undefined ||
    tokens.cacheWrite !== undefined
  )
    attrs["gen_ai.usage.input_tokens"] =
      (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
  if (tokens.output !== undefined) attrs["gen_ai.usage.output_tokens"] = tokens.output;
  if (tokens.cacheRead !== undefined)
    attrs["gen_ai.usage.cache_read.input_tokens"] = tokens.cacheRead;
  if (tokens.cacheWrite !== undefined)
    attrs["gen_ai.usage.cache_creation.input_tokens"] = tokens.cacheWrite;
  return attrs;
}

export type ExportHealth =
  | { state: "failing"; failures: number; signal: string; reason: string }
  | { state: "recovered"; failures: number };

/** User-facing warning text; never includes the endpoint or credentials. */
export function exportHealthMessage(health: ExportHealth): {
  message: string;
  level: "warning" | "info";
} {
  return health.state === "failing"
    ? {
        message: `pi-otel: ${health.failures} telemetry exports failed in a row (${health.signal}: ${health.reason}); data is being dropped`,
        level: "warning",
      }
    : {
        message: `pi-otel: telemetry exports recovered after ${health.failures} failures; data from that window was dropped`,
        level: "info",
      };
}
