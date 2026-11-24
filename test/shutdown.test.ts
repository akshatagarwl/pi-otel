import { test } from "node:test";
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
  span.end();
  const start = performance.now();
  const first = telemetry.close();
  assert.equal(first, telemetry.close());
  await first;
  assert.ok(performance.now() - start < 4500);
  assert.ok(telemetry.failures > 0);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
