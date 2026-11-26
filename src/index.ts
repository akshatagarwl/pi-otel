import {
  assistantContent,
  modelError,
  modelOutcome,
  completionOutcome,
  exportHealthMessage,
  requestAttributes,
  responseAttributes,
  toolAttributes,
  toolCompletionAttributes,
  toolResultAttributes,
  toolOutputContent,
  usageAttributes,
} from "./domain.ts";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SpanLifetime as Span } from "./lifetime.ts";
import { config } from "./config.ts";
import { Telemetry } from "./telemetry.ts";
import { startTelemetry } from "./runtime.ts";

export default function extension(pi: ExtensionAPI, start = startTelemetry) {
  let telemetry: Telemetry | undefined;
  let runtime: Awaited<ReturnType<typeof startTelemetry>> | undefined;
  let generation = 0;
  const starting = new Set<Promise<void>>();
  let session = "";
  let interaction: Span | undefined;
  let model: Span | undefined;
  let lastModel: Span | undefined;
  let failed = false;
  let diagnostic = "disabled: configure an endpoint";
  const tools = new Map<string, Span>();
  const ensureInteraction = () => {
    interaction ??= telemetry?.span("pi.interaction", session);
    return interaction;
  };
  const cleanup = (outcome: "cancelled" | "interrupted" | "error" | "ok") => {
    for (const span of tools.values()) span.finish(outcome);
    tools.clear();
    model?.finish(outcome);
    interaction?.finish(outcome);
    model = interaction = lastModel = undefined;
    failed = false;
  };
  pi.on("session_start", async (_event, ctx) => {
    const ownGeneration = ++generation;
    session = ctx.sessionManager.getSessionId();
    cleanup("interrupted");
    const previous = runtime;
    runtime = undefined;
    telemetry = undefined;
    try {
      await previous?.close();
      if (generation !== ownGeneration) return;
      const cfg = config();
      if (cfg.endpoint) {
        const pending = start({ ...cfg, serviceVersion: VERSION }).then(async (created) => {
          if (generation !== ownGeneration) {
            await created.close();
            return;
          }
          runtime = created;
          telemetry = created.telemetry;
          telemetry.onExportHealth = (health) => {
            const { message, level } = exportHealthMessage(health);
            ctx.ui.notify(message, level);
          };
        });
        starting.add(pending);
        try {
          await pending;
        } finally {
          starting.delete(pending);
        }
      }
      if (generation !== ownGeneration) return;
      diagnostic = cfg.endpoint
        ? `enabled; content=${cfg.content}; OTLP HTTP/protobuf`
        : diagnostic;
    } catch {
      if (generation === ownGeneration) diagnostic = "disabled: configuration invalid";
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== session) return;
    const span = ensureInteraction();
    if (span && event.messageType === "user")
      telemetry?.content(span, session, "prompt", event.prompt);
  });
  pi.on("message_start", (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== session) return;
    if (event.message.role !== "assistant" || !telemetry) return;
    model?.finish("interrupted");
    model = telemetry.span("pi.model", session, ensureInteraction(), requestAttributes(ctx.model));
  });
  pi.on("message_end", (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== session) return;
    const message = event.message;
    if (message.role !== "assistant" || !model) return;
    model.setAttributes({
      ...responseAttributes(message.provider, message.model, message.stopReason),
      ...usageAttributes(message.usage),
    });
    telemetry?.content(model, session, "assistant", assistantContent(message.content));
    telemetry?.usage(message.usage, {
      "gen_ai.provider.name": message.provider,
      "gen_ai.request.model": message.model,
    });
    const outcome = modelOutcome(message.stopReason);
    failed = outcome === "error";
    // Provider error text can echo request content, so it follows the content opt-in.
    const error = telemetry?.cfg.content
      ? modelError(message.stopReason, message.errorMessage)
      : undefined;
    model.finish(outcome, error);
    lastModel = model;
    model = undefined;
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== session) return;
    if (!telemetry || tools.has(event.toolCallId)) return;
    const parent = event.parentToolCallId ? tools.get(event.parentToolCallId) : lastModel;
    const span = telemetry.span(
      "pi.tool",
      session,
      parent ?? ensureInteraction(),
      toolAttributes(event.toolName),
    );
    tools.set(event.toolCallId, span);
    telemetry.content(span, session, "tool.preflight.input", event.args);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== session) return;
    if (!telemetry) return;
    const parent = event.parentToolCallId ? tools.get(event.parentToolCallId) : lastModel;
    const span =
      tools.get(event.toolCallId) ??
      telemetry.span(
        "pi.tool",
        session,
        parent ?? ensureInteraction(),
        toolAttributes(event.toolName),
      );
    telemetry.content(span, session, "tool.output", toolOutputContent(event.result));
    const outcome = completionOutcome(ctx.signal?.aborted === true, event.isError);
    span.setAttributes({
      ...toolCompletionAttributes(outcome, event.durationMs),
      ...toolResultAttributes(event.result),
    });
    span.finish(outcome);
    tools.delete(event.toolCallId);
  });
  pi.on("agent_settled", (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== session) return;
    cleanup(completionOutcome(event.aborted, failed));
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== session) return;
    ++generation;
    cleanup("interrupted");
    const previous = runtime;
    runtime = undefined;
    telemetry = undefined;
    await Promise.all([
      previous?.close(),
      ...Array.from(starting, (pending) => pending.catch(() => {})),
    ]);
  });
  pi.registerCommand("otel-status", {
    description: "Show privacy and exporter status without endpoints or credentials",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        `${diagnostic}; pending tools=${tools.size}; failed exports in a row=${telemetry?.exportFailures ?? 0}; shutdown failures=${telemetry?.failures ?? 0}`,
        "info",
      ),
  });
}
