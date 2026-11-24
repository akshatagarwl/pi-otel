import { expect, test } from "vitest";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { Telemetry } from "../src/telemetry.ts";
import { OTelTelemetryAdapter } from "../src/adapter.ts";

test("close settles every held callback before exporter shutdown, including unfinished tools", async () => {
  const telemetry = new Telemetry({ endpoint: "http://127.0.0.1:1", content: false, headers: {} });
  const parent = telemetry.span("model", "synthetic");
  parent.finish("ok");
  await parent.done;
  const tool = telemetry.span("tool", "synthetic", parent);
  const nested = telemetry.span("nested", "synthetic", tool);
  await telemetry.close();
  await Promise.all([parent.done, tool.done, nested.done]);
  expect(telemetry.adapter.identity(tool.span)?.traceId).toBe(
    telemetry.adapter.identity(parent.span)?.traceId,
  );
});

test("explicit ok then error is last-write-wins despite OTel status precedence", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const adapter = new OTelTelemetryAdapter(provider.getTracer("test"));
  try {
    await adapter.startSpan({ name: "synthetic" }, (span) => {
      span.setStatus({ status: "ok" });
      span.setStatus({ status: "error", error: { name: "Synthetic", message: "expected" } });
    });
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()[0].status).toEqual({ code: 2, message: "expected" });
  } finally {
    await provider.shutdown();
  }
});
