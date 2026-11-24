import { expect, test } from "vitest";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { OTelTelemetryAdapter } from "../src/adapter.ts";

test("native metric capability records counters, signed gauges and histogram buckets through local SDK", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const meters = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 })],
  });
  const traces = new TracerProvider();
  const adapter = new OTelTelemetryAdapter(traces.getTracer("test"), meters.getMeter("test"));
  try {
    const attributes = { direction: "out", ignored: undefined };
    adapter.metrics!.counter("bytes", { unit: "By" }).add(12, attributes);
    attributes.direction = "mutated";
    const active = adapter.metrics!.upDownCounter("active");
    active.add(1);
    active.add(-1);
    await adapter.startSpan({ name: "measured" }, (span) => {
      expect(span.metrics).toBe(adapter.metrics);
      span
        .metrics!.histogram("duration", { unit: "ms", boundaries: [1, 10] })
        .record(5, { method: "read" }, span);
    });
    await meters.forceFlush();
    const metrics = exporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
    expect(metrics.map((m) => m.descriptor.name).sort()).toEqual(["active", "bytes", "duration"]);
    const bytes = metrics.find((m) => m.descriptor.name === "bytes")!;
    expect(bytes.dataPoints[0].attributes).toEqual({ direction: "out" });
    expect(bytes.dataPoints[0].value).toBe(12);
    expect(metrics.find((m) => m.descriptor.name === "active")!.dataPoints[0].value).toBe(0);
    expect(
      metrics.find((m) => m.descriptor.name === "duration")!.dataPoints[0].value,
    ).toMatchObject({ count: 1, sum: 5 });
  } finally {
    await Promise.all([meters.shutdown(), traces.shutdown()]);
  }
});
