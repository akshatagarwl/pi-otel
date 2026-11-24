import { test } from "vitest";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Telemetry } from "../src/telemetry.ts";
import { decode } from "./wire.ts";

test("official exporters emit correlated full content, hierarchy and cumulative metrics", async () => {
  const payloads: Record<string, Buffer[]> = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      (payloads[req.url!] ??= []).push(Buffer.concat(chunks));
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  const cfg = { endpoint, content: true, headers: {} };
  const telemetry = new Telemetry(cfg);
  const parent = telemetry.span("parent", "conversation");
  const child = telemetry.span("child", "conversation", parent);
  telemetry.content(child, "conversation", "tool.output", "x".repeat(135000));
  telemetry.usage(
    {
      input: 300,
      output: 80,
      cacheRead: 600,
      cacheWrite: 100,
      cost: { total: 0.2 },
    },
    { "gen_ai.provider.name": "synthetic" },
  );
  child.end();
  parent.end();
  await telemetry.metrics.forceFlush();
  await telemetry.metrics.forceFlush();
  await telemetry.close();
  const spans = decode("Traces", payloads["/v1/traces"][0]).resources[0].scopes[0].spans;
  const log = decode("Logs", payloads["/v1/logs"][0]).resources[0].scopes[0].logs[0];
  assert.equal(spans[0].parentSpanId, spans[1].spanId);
  assert.equal(log.traceId, spans[0].traceId);
  assert.equal(log.spanId, spans[0].spanId);
  assert.equal(log.body.stringValue.length, 135000);
  const first = decode("Metrics", payloads["/v1/metrics"][0]).resources[0].scopes[0].metrics;
  const second = decode("Metrics", payloads["/v1/metrics"][1]).resources[0].scopes[0].metrics;
  assert.deepEqual(first, second);
  assert.equal(first[0].sum.aggregationTemporality, 2);
  assert.ok(payloads["/v1/logs"]?.[0].includes(Buffer.from("x".repeat(135000))));
  assert.ok(payloads["/v1/metrics"]?.length >= 2);
  assert.ok(!payloads["/v1/metrics"][0].includes(Buffer.from("conversation")));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
