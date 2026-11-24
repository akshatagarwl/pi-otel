import { ROOT_CONTEXT, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
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
    this.tokenCounter = meter.createCounter("pi.tokens", { unit: "{token}" });
    this.costCounter = meter.createCounter("pi.cost", { unit: "USD" });
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
  span(name: string, session: string, parent?: Span, attrs = {}) {
    return this.traces
      .getTracer("pi-otel")
      .startSpan(
        name,
        { attributes: { "gen_ai.conversation.id": session, ...attrs } },
        parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT,
      );
  }
  content(span: Span, session: string, kind: string, value: unknown) {
    if (!this.cfg.content) return;
    let body: string;
    try {
      body = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
    } catch {
      this.failures++;
      return;
    }
    const sc = span.spanContext();
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
    const work = Promise.allSettled([
      this.traces.shutdown(),
      this.logs.shutdown(),
      this.metrics.shutdown(),
    ]);
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
export function finish(
  span: Span | undefined,
  outcome: "ok" | "error" | "cancelled" | "interrupted",
) {
  if (!span) return;
  span.setAttribute("pi.outcome", outcome);
  if (outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}
