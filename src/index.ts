import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Span } from "@opentelemetry/api";
import { config } from "./config.ts";
import { Telemetry, finish } from "./telemetry.ts";

export default function extension(pi: ExtensionAPI) {
  let telemetry: Telemetry | undefined;
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
    for (const span of tools.values()) finish(span, outcome);
    tools.clear();
    finish(model, outcome);
    finish(interaction, outcome);
    model = interaction = lastModel = undefined;
    failed = false;
  };
  pi.on("session_start", (_event, ctx) => {
    try {
      const cfg = config();
      session = ctx.sessionManager.getSessionId();
      if (cfg.endpoint) telemetry = new Telemetry(cfg);
      diagnostic = cfg.endpoint
        ? `enabled; content=${cfg.content}; OTLP HTTP/protobuf`
        : diagnostic;
    } catch {
      diagnostic = "disabled: configuration invalid";
    }
  });
  pi.on("before_agent_start", (event) => {
    const span = ensureInteraction();
    if (span && event.messageType === "user")
      telemetry?.content(span, session, "prompt", event.prompt);
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant" || !telemetry) return;
    finish(model, "interrupted");
    model = telemetry.span("pi.model", session, ensureInteraction(), {
      "gen_ai.provider.name": ctx.model?.provider ?? "unknown",
      "gen_ai.request.model": ctx.model?.id ?? "unknown",
    });
  });
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant" || !model) return;
    model.setAttributes({
      "gen_ai.provider.name": message.provider,
      "gen_ai.response.model": message.model,
    });
    telemetry?.content(model, session, "assistant", message.content);
    telemetry?.usage(message.usage, {
      "gen_ai.provider.name": message.provider,
      "gen_ai.request.model": message.model,
    });
    const outcome =
      message.stopReason === "aborted"
        ? "cancelled"
        : message.stopReason === "error"
          ? "error"
          : "ok";
    failed = outcome === "error";
    model.setAttribute("gen_ai.response.finish_reasons", [message.stopReason]);
    if (outcome === "error") model.setAttribute("error.type", "model_error");
    finish(model, outcome);
    lastModel = model;
    model = undefined;
  });
  pi.on("tool_execution_start", (event) => {
    if (!telemetry || tools.has(event.toolCallId)) return;
    const parent = event.parentToolCallId ? tools.get(event.parentToolCallId) : lastModel;
    const span = telemetry.span("pi.tool", session, parent ?? ensureInteraction(), {
      "gen_ai.tool.name": event.toolName,
    });
    tools.set(event.toolCallId, span);
    telemetry.content(span, session, "tool.preflight.input", event.args);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (!telemetry) return;
    const parent = event.parentToolCallId ? tools.get(event.parentToolCallId) : lastModel;
    const span =
      tools.get(event.toolCallId) ??
      telemetry.span("pi.tool", session, parent ?? ensureInteraction(), {
        "gen_ai.tool.name": event.toolName,
      });
    telemetry.content(span, session, "tool.output", event.result);
    const outcome = ctx.signal?.aborted ? "cancelled" : event.isError ? "error" : "ok";
    if (outcome === "error") span.setAttribute("error.type", "tool_error");
    if (event.durationMs !== undefined)
      span.setAttribute("pi.tool.execution.duration_ms", event.durationMs);
    span.setAttribute("pi.tool.executed", event.durationMs !== undefined);
    finish(span, outcome);
    tools.delete(event.toolCallId);
  });
  pi.on("agent_settled", (event) => cleanup(event.aborted ? "cancelled" : failed ? "error" : "ok"));
  pi.on("session_shutdown", async () => {
    cleanup("interrupted");
    await telemetry?.close();
    telemetry = undefined;
  });
  pi.registerCommand("otel-status", {
    description: "Show privacy and exporter status without endpoints or credentials",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        `${diagnostic}; pending tools=${tools.size}; shutdown failures=${telemetry?.failures ?? 0}`,
        "info",
      ),
  });
}
