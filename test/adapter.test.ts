import { it } from "vitest";
import { createTelemetryAdapterConformance } from "@earendil-works/pi-telemetry/testing";
import type { RecordedTelemetrySpan, SpanAttributes } from "@earendil-works/pi-telemetry";
import {
  TracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { OTelTelemetryAdapter } from "../src/adapter.ts";

const cases = createTelemetryAdapterConformance(async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const meters = new MeterProvider();
  const adapter = new OTelTelemetryAdapter(
    provider.getTracer("conformance"),
    meters.getMeter("conformance"),
  );
  const carrier = (sc: { traceId: string; spanId: string; traceFlags: number }) => ({
    traceId: sc.traceId,
    spanId: sc.spanId,
    traceFlags: String(sc.traceFlags),
  });
  return {
    context: adapter,
    propagation: adapter.propagation,
    async getSpans(): Promise<RecordedTelemetrySpan[]> {
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      const starts = [...spans].sort(
        (a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1],
      );
      return starts.map((span, index) => {
        const attrs = { ...span.attributes };
        const error = attrs["exception.type"]
          ? { name: String(attrs["exception.type"]), message: String(attrs["exception.message"]) }
          : undefined;
        delete attrs["exception.type"];
        delete attrs["exception.message"];
        return {
          id: index + 1,
          parentId: span.parentSpanContext
            ? starts.findIndex((s) => s.spanContext().spanId === span.parentSpanContext!.spanId) +
                1 || null
            : null,
          context: carrier(span.spanContext()),
          parentContext: span.parentSpanContext ? carrier(span.parentSpanContext) : null,
          name: span.name,
          attributes: attrs as SpanAttributes,
          events: span.events.map((event) => ({
            name: event.name,
            attributes: (event.attributes ?? {}) as SpanAttributes,
          })),
          links: span.links.map((link) => ({
            context: carrier(link.context),
            attributes: (link.attributes ?? {}) as SpanAttributes,
          })),
          status:
            span.status.code === 2
              ? { status: "error", ...(error ? { error } : {}) }
              : { status: "ok" },
          settled: true,
          endSequence: spans.indexOf(span) + 1,
        };
      });
    },
    async [Symbol.asyncDispose]() {
      await Promise.all([provider.shutdown(), meters.shutdown()]);
    },
  };
});
for (const c of cases) it(`${c.group}: ${c.name}`, c.run);
