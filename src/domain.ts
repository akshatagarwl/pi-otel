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
