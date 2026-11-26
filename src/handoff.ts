import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";

/**
 * Trace handoff between sessions in one Pi process.
 *
 * Subagent extensions (pi-optchat and similar) run each child as its own Pi session in
 * the same process, so each child loads its own copy of this extension and would start
 * an unrelated trace. The parent's delegating tool call offers its span context together
 * with the task text it sent; the child claims it when its first prompt contains that
 * text, and its interaction becomes a child span of the delegating tool call.
 *
 * The registry lives on globalThis because every session loads the module separately.
 */
export type Handoff = { carrier: TelemetryCarrier; session: string };
type Offer = Handoff & { texts: string[]; expires: number };

const KEY = Symbol.for("pi-otel.handoffs");
/** An offer nobody claims (a tell to a running child is steering, not a new prompt) expires. */
export const HANDOFF_TTL_MS = 10 * 60_000;
const MAX_OFFERS = 64;
/** Very short texts would match unrelated prompts. */
const MIN_TEXT = 8;

const offers = (): Offer[] => ((globalThis as { [KEY]?: Offer[] })[KEY] ??= []);

/** The text a delegating tool sends to child sessions, by tool name. */
export function handoffTexts(tool: string, args: unknown): string[] {
  const a = args as { tasks?: unknown; message?: unknown } | null | undefined;
  const texts =
    tool === "spawn" && Array.isArray(a?.tasks)
      ? a.tasks.map((t: { task?: unknown } | null) => t?.task)
      : tool === "tell"
        ? [a?.message]
        : [];
  return texts.filter((t): t is string => typeof t === "string" && t.trim().length >= MIN_TEXT);
}

export function offer(texts: string[], handoff: Handoff, now = Date.now()) {
  if (!texts.length) return;
  const list = offers();
  prune(list, now);
  list.push({ ...handoff, texts: texts.map((t) => t.trim()), expires: now + HANDOFF_TTL_MS });
  if (list.length > MAX_OFFERS) list.splice(0, list.length - MAX_OFFERS);
}

/** Claims the newest offer from another session whose text the prompt contains. Each text is claimed once. */
export function claim(prompt: string, session: string, now = Date.now()): Handoff | undefined {
  const list = offers();
  prune(list, now);
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i]!;
    if (o.session === session) continue;
    const at = o.texts.findIndex((t) => prompt.includes(t));
    if (at < 0) continue;
    o.texts.splice(at, 1);
    if (!o.texts.length) list.splice(i, 1);
    return { carrier: o.carrier, session: o.session };
  }
  return undefined;
}

/** W3C trace context from the environment (`TRACEPARENT`, `TRACESTATE`), for a Pi started by a traced process. */
export function envCarrier(env: NodeJS.ProcessEnv = process.env): TelemetryCarrier | undefined {
  const traceparent = env.TRACEPARENT?.trim();
  if (!traceparent) return undefined;
  const tracestate = env.TRACESTATE?.trim();
  return tracestate ? { traceparent, tracestate } : { traceparent };
}

/** For tests. */
export function clearHandoffs() {
  offers().length = 0;
}

function prune(list: Offer[], now: number) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.expires <= now) list.splice(i, 1);
}
