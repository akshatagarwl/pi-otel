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
    traceparent: `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, "0")}`,
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
for (const c of cases) {
  // OTel aggregates measurements; this fixture has no ordered measurement reader.
  if (c.group === "metrics") {
    it.skip(`${c.group}: ${c.name} (no ordered SDK measurement fixture)`, c.run);
  } else {
    it(`${c.group}: ${c.name}`, c.run);
  }
}

it("interoperates with remote W3C traceparent and tracestate without globals", async () => {
  const { ROOT_CONTEXT, trace } = await import("@opentelemetry/api");
  const { expect } = await import("vitest");
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const adapter = new OTelTelemetryAdapter(provider.getTracer("remote"));
  const remote = {
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    tracestate: "vendor=value",
  };
  try {
    expect(adapter.propagation.inject(adapter)).toBeUndefined();
    expect(adapter.propagation.extract({ traceparent: "malformed" })).toBe(adapter);
    const parent = adapter.propagation.extract(remote);
    expect(adapter.propagation.inject(parent)).toEqual(remote);
    let retained;
    await parent.startSpan({ name: "child" }, (span) => {
      retained = span;
    });
    const sc = adapter.identity(retained!);
    expect(sc?.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(adapter.propagation.inject(retained!)?.tracestate).toBe("vendor=value");
    expect(exporter.getFinishedSpans()[0].parentSpanContext?.isRemote).toBe(true);
    expect(trace.getSpanContext(ROOT_CONTEXT)).toBeUndefined();
  } finally {
    await provider.shutdown();
  }
});
