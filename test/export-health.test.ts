import { test } from "vitest";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EXPORT_WARN_AFTER, Telemetry, exportReason } from "../src/telemetry.ts";
import { exportHealthMessage, type ExportHealth } from "../src/domain.ts";

test("warns once per failing streak and reports recovery", async () => {
  let status = 404;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  const telemetry = new Telemetry({ endpoint, content: false, headers: {} });
  const seen: ExportHealth[] = [];
  telemetry.onExportHealth = (health) => seen.push(health);
  const exportSpan = async () => {
    const span = telemetry.span("pi.tool", "conversation");
    span.finish("ok");
    await span.done;
    await telemetry.traces.forceFlush().catch(() => {});
  };
  for (let i = 0; i < EXPORT_WARN_AFTER + 2; i++) await exportSpan();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, "failing");
  assert.equal(seen[0].failures, EXPORT_WARN_AFTER);
  assert.equal(telemetry.exportFailures, EXPORT_WARN_AFTER + 2);
  const failing = seen[0] as Extract<ExportHealth, { state: "failing" }>;
  assert.equal(failing.signal, "traces");
  assert.ok(!failing.reason.includes(endpoint));

  status = 200;
  await exportSpan();
  assert.deepEqual(seen[1], { state: "recovered", failures: EXPORT_WARN_AFTER + 2 });
  assert.equal(telemetry.exportFailures, 0);
  await telemetry.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a throwing listener does not break exports", async () => {
  const telemetry = new Telemetry({ endpoint: "http://127.0.0.1:1", content: false, headers: {} });
  telemetry.onExportHealth = () => {
    throw new Error("listener broke");
  };
  for (let i = 0; i < EXPORT_WARN_AFTER; i++) {
    const span = telemetry.span("pi.tool", "conversation");
    span.finish("ok");
    await span.done;
    await telemetry.traces.forceFlush().catch(() => {});
  }
  assert.equal(telemetry.exportFailures, EXPORT_WARN_AFTER);
  await telemetry.close();
});

test("export reasons and messages never carry the endpoint", () => {
  const reason = exportReason(new Error("connect ECONNREFUSED http://user:pw@host:14318/v1/logs"));
  assert.equal(reason, "connect ECONNREFUSED <endpoint>");
  assert.equal(exportReason(undefined), "unknown error");
  assert.deepEqual(
    exportHealthMessage({ state: "failing", failures: 3, signal: "logs", reason: "Not Found" }),
    {
      message:
        "pi-otel: 3 telemetry exports failed in a row (logs: Not Found); data is being dropped",
      level: "warning",
    },
  );
  assert.equal(exportHealthMessage({ state: "recovered", failures: 7 }).level, "info");
});
