import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { OTelTelemetryAdapter } from "./adapter.ts";
import { SpanLifetime, type Outcome } from "./lifetime.ts";
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

export class Telemetry {
  traces: TracerProvider;
  logs: LoggerProvider;
  metrics: MeterProvider;
  failures = 0;
  readonly adapter: OTelTelemetryAdapter;
  private held = new Set<SpanLifetime>();
  private tokenCounter;
  private costCounter;
  private closing?: Promise<void>;
  constructor(readonly cfg: Config) {
    const resource = resourceFromAttributes({
      "service.name": cfg.serviceName ?? "pi",
      "service.instance.id": randomUUID(),
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
          exporter: this.monitor(new OTLPTraceExporter(options("traces"))),
        }),
      ],
    });
    this.logs = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: this.monitor(new OTLPLogExporter(options("logs"))),
        }),
      ],
    });
    this.metrics = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: this.monitor(
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
  private monitor<T extends { export: (...args: any[]) => void }>(exporter: T): T {
    const original = exporter.export.bind(exporter);
    exporter.export = ((data: unknown, callback: (result: any) => void) => {
      original(data, (result: any) => {
        if (result.code !== 0) this.failures++;
        callback(result);
      });
    }) as T["export"];
    return exporter;
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
    if (!this.cfg.content) return;
    let body: string;
    try {
      body = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
    } catch {
      this.failures++;
      return;
    }
    const sc = this.adapter.identity(span.span);
    if (!sc) return;
    this.logs.getLogger("pi-otel").emit({
      context: trace.setSpanContext(ROOT_CONTEXT, sc),
      body,
      attributes: {
        "gen_ai.conversation.id": session,
        "pi.content.kind": kind,
        "pi.content.bytes": Buffer.byteLength(body),
        trace_id: sc.traceId,
        span_id: sc.spanId,
      },
    });
  }
  usage(usage: any, attrs: Record<string, string>) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      const value = usage?.[key];
      if (Number.isFinite(value) && value >= 0)
        this.tokenCounter.add(value, { ...attrs, "pi.token.type": key });
    }
    if (Number.isFinite(usage?.cost?.total) && usage.cost.total >= 0)
      this.costCounter.add(usage.cost.total, {
        ...attrs,
        "pi.cost.source": usage.cost.totalFromProvider ? "provider" : "estimated",
      });
  }
  close() {
    return (this.closing ??= this.shutdown());
  }
  private async shutdown() {
    let timer: ReturnType<typeof setTimeout>;
    const held = [...this.held];
    for (const span of held) span.finish("interrupted");
    const work = Promise.allSettled(held.map((span) => span.done)).then(() =>
      Promise.allSettled([this.traces.shutdown(), this.logs.shutdown(), this.metrics.shutdown()]),
    );
    try {
      const result = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), 4000);
        }),
      ]);
      this.failures += result.filter((r) => r.status === "rejected").length;
    } catch {
      this.failures++;
    } finally {
      clearTimeout(timer!);
    }
  }
}
export function finish(span: SpanLifetime | undefined, outcome: Outcome) {
  span?.finish(outcome);
}
