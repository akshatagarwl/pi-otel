import { serializeContent, usageMeasurements, type ExportHealth, type Usage } from "./domain.ts";
import { Effect } from "effect";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { OTelTelemetryAdapter } from "./adapter.ts";
import { SpanLifetime } from "./lifetime.ts";
import { ExportResultCode } from "@opentelemetry/core";
import { TracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";

/** Consecutive failed exports before the user is warned that data is being dropped. */
export const EXPORT_WARN_AFTER = 3;

/** Exporter errors can echo the endpoint; keep the reason without it. */
export function exportReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<endpoint>").slice(0, 160);
}

export class Telemetry {
  traces: TracerProvider;
  logs: LoggerProvider;
  metrics: MeterProvider;
  failures = 0;
  /** Failed exports since the last successful one, across all signals. */
  exportFailures = 0;
  onExportHealth?: (health: ExportHealth) => void;
  readonly adapter: OTelTelemetryAdapter;
  private held = new Set<SpanLifetime>();
  private tokenCounter;
  private costCounter;
  private closing?: Promise<void>;
  constructor(readonly cfg: Config) {
    const resource = resourceFromAttributes({
      "service.name": cfg.serviceName ?? "pi",
      "service.instance.id": randomUUID(),
      ...(cfg.serviceVersion ? { "service.version": cfg.serviceVersion } : {}),
    });
    const options = (signal: string) => ({
      url: `${cfg.endpoint!.replace(/\/$/, "")}/v1/${signal}`,
      headers: cfg.headers,
      timeoutMillis: 2000,
    });
    this.traces = new TracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: this.monitor("traces", new OTLPTraceExporter(options("traces"))),
        }),
      ],
    });
    this.logs = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: this.monitor("logs", new OTLPLogExporter(options("logs"))),
        }),
      ],
    });
    this.metrics = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: this.monitor(
            "metrics",
            new OTLPMetricExporter({
              ...options("metrics"),
              temporalityPreference: AggregationTemporality.CUMULATIVE,
            }),
          ),
          exportIntervalMillis: 30000,
          exportTimeoutMillis: 3000,
        }),
      ],
    });
    const meter = this.metrics.getMeter("pi-otel");
    this.adapter = new OTelTelemetryAdapter(this.traces.getTracer("pi-otel"), meter);
    this.tokenCounter = this.adapter.metrics!.counter("pi.tokens", { unit: "{token}" });
    this.costCounter = this.adapter.metrics!.counter("pi.cost", { unit: "USD" });
  }
  private monitor<T extends { export: (...args: any[]) => void }>(signal: string, exporter: T): T {
    const original = exporter.export.bind(exporter);
    exporter.export = ((data: unknown, callback: (result: any) => void) => {
      original(data, (result: any) => {
        if (result.code === ExportResultCode.SUCCESS) this.exportSucceeded();
        else this.exportFailed(signal, result.error);
        callback(result);
      });
    }) as T["export"];
    return exporter;
  }
  private exportFailed(signal: string, error: unknown) {
    this.failures++;
    // Warn once per failing streak, not on every dropped batch.
    if (++this.exportFailures !== EXPORT_WARN_AFTER) return;
    const reason = exportReason(error);
    this.report({ state: "failing", failures: this.exportFailures, signal, reason });
  }
  private exportSucceeded() {
    const failures = this.exportFailures;
    this.exportFailures = 0;
    if (failures >= EXPORT_WARN_AFTER) this.report({ state: "recovered", failures });
  }
  private report(health: ExportHealth) {
    try {
      this.onExportHealth?.(health);
    } catch {
      // A broken listener must not break the export pipeline.
    }
  }
  span(name: string, session: string, parent?: SpanLifetime, attrs = {}) {
    const context = parent
      ? this.adapter.propagation.extract(this.adapter.propagation.inject(parent.span))
      : this.adapter;
    const held = new SpanLifetime(context, name, { "gen_ai.conversation.id": session, ...attrs });
    this.held.add(held);
    void held.done.then(
      () => this.held.delete(held),
      () => {
        this.held.delete(held);
        this.failures++;
      },
    );
    if (this.closing) held.finish("interrupted");
    return held;
  }
  content(span: SpanLifetime, session: string, kind: string, value: unknown) {
    const content = serializeContent(this.cfg.content, value);
    if (content.kind === "disabled") return;
    if (content.kind === "invalid") {
      this.failures++;
      return;
    }
    const sc = this.adapter.identity(span.span);
    if (!sc) return;
    this.logs.getLogger("pi-otel").emit({
      context: trace.setSpanContext(ROOT_CONTEXT, sc),
      body: content.body,
      attributes: {
        "gen_ai.conversation.id": session,
        "pi.content.kind": kind,
        "pi.content.bytes": content.bytes,
        trace_id: sc.traceId,
        span_id: sc.spanId,
      },
    });
  }
  usage(usage: Usage | null | undefined, attrs: Record<string, string>) {
    const { tokens, cost } = usageMeasurements(usage);
    for (const { bucket, value } of tokens)
      this.tokenCounter.add(value, { ...attrs, "pi.token.type": bucket });
    if (cost) this.costCounter.add(cost.value, { ...attrs, "pi.cost.source": cost.source });
  }
  close() {
    return (this.closing ??= this.shutdown());
  }
  private async shutdown() {
    const held = [...this.held];
    for (const span of held) span.finish("interrupted");
    const work = Promise.allSettled(held.map((span) => span.done)).then(() =>
      Promise.allSettled([this.traces.shutdown(), this.logs.shutdown(), this.metrics.shutdown()]),
    );
    try {
      // Timeout interrupts the waiter, not SDK work. allSettled observes late rejections.
      const result = await Effect.runPromise(
        Effect.tryPromise(() => work).pipe(Effect.timeout("4 seconds")),
      );
      this.failures += result.filter((r) => r.status === "rejected").length;
    } catch {
      this.failures++;
    }
  }
}
