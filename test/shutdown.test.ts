import { test } from "vitest";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Telemetry } from "../src/telemetry.ts";

test("unresponsive exporter has bounded, idempotent shutdown and safe failure counter", async () => {
  const server = createServer(() => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const telemetry = new Telemetry({
    endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
    content: true,
    headers: {},
  });
  const span = telemetry.span("synthetic", "session");
  telemetry.content(span, "session", "prompt", "synthetic");
  span.finish("ok");
  await span.done;
  const start = performance.now();
  const first = telemetry.close();
  assert.equal(first, telemetry.close());
  await first;
  assert.ok(performance.now() - start < 4500);
  assert.ok(telemetry.failures > 0);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

test("held callbacks settle before shutdown; timeout safely observes late SDK rejection", async () => {
  const { vi } = await import("vitest");
  const telemetry = new Telemetry({ endpoint: "http://127.0.0.1:1", content: false, headers: {} });
  const held = telemetry.span("held", "synthetic");
  let settled = false;
  void held.done.then(() => {
    settled = true;
  });
  const late = Promise.withResolvers<void>();
  const originals = [telemetry.traces, telemetry.logs, telemetry.metrics].map((p) =>
    p.shutdown.bind(p),
  );
  telemetry.traces.shutdown = () => {
    assert.equal(settled, true);
    return late.promise;
  };
  telemetry.logs.shutdown = async () => {
    assert.equal(settled, true);
  };
  telemetry.metrics.shutdown = async () => {
    assert.equal(settled, true);
  };
  vi.useFakeTimers();
  try {
    const closing = telemetry.close();
    assert.equal(closing, telemetry.close());
    await vi.advanceTimersByTimeAsync(4001);
    await closing;
    assert.equal(telemetry.failures, 1);
    late.reject(new Error("late synthetic failure"));
    await vi.advanceTimersByTimeAsync(1);
  } finally {
    vi.useRealTimers();
    await Promise.allSettled(originals.map((shutdown) => shutdown()));
  }
});
