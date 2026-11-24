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
  child.finish("ok");
  parent.finish("ok");
  await Promise.all([child.done, parent.done]);
  await telemetry.metrics.forceFlush();
  await telemetry.metrics.forceFlush();
  await telemetry.close();
  const traceResource = decode("Traces", payloads["/v1/traces"][0]).resources[0];
  const logResource = decode("Logs", payloads["/v1/logs"][0]).resources[0];
  const metricResource = decode("Metrics", payloads["/v1/metrics"][0]).resources[0];
  const identity = (resource: any) =>
    resource.resource.attributes.filter((attr: any) =>
      ["service.name", "service.instance.id"].includes(attr.key),
    );
  assert.equal(identity(traceResource).length, 2);
  assert.deepEqual(identity(traceResource), identity(logResource));
  assert.deepEqual(identity(traceResource), identity(metricResource));
  const spans = traceResource.scopes[0].spans;
  const log = decode("Logs", payloads["/v1/logs"][0]).resources[0].scopes[0].logs[0];
  assert.equal(spans[0].parentSpanId, spans[1].spanId);
  assert.equal(log.traceId, spans[0].traceId);
  assert.equal(log.spanId, spans[0].spanId);
  assert.equal(log.body.stringValue.length, 135000);
  const first = decode("Metrics", payloads["/v1/metrics"][0]).resources[0].scopes[0].metrics;
  const second = decode("Metrics", payloads["/v1/metrics"][1]).resources[0].scopes[0].metrics;
  for (let i = 0; i < first.length; i++) {
    assert.equal(first[i].name, second[i].name);
    assert.equal(first[i].sum.aggregationTemporality, second[i].sum.aggregationTemporality);
    for (let j = 0; j < first[i].sum.dataPoints.length; j++) {
      const a = first[i].sum.dataPoints[j];
      const b = second[i].sum.dataPoints[j];
      assert.ok(a.timeUnixNano > 0);
      assert.ok(b.timeUnixNano >= a.timeUnixNano);
      assert.equal(a.startTimeUnixNano, b.startTimeUnixNano);
      const { timeUnixNano: _a, ...stableA } = a;
      const { timeUnixNano: _b, ...stableB } = b;
      assert.deepEqual(stableA, stableB);
    }
  }
  assert.equal(first[0].sum.aggregationTemporality, 2);
  assert.ok(payloads["/v1/logs"]?.[0].includes(Buffer.from("x".repeat(135000))));
  assert.ok(payloads["/v1/metrics"]?.length >= 2);
  assert.ok(!payloads["/v1/metrics"][0].includes(Buffer.from("conversation")));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
