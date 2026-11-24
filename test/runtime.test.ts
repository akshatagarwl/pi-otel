import { expect, test, vi } from "vitest";
import { startTelemetry } from "../src/runtime.ts";

const cfg = { endpoint: "http://127.0.0.1:1", content: false, headers: {} };

test("concurrent session runtimes have distinct trace IDs and idempotent shutdown", async () => {
  const sessions = await Promise.all([startTelemetry(cfg), startTelemetry(cfg)]);
  try {
    const ids = sessions.map(
      ({ telemetry }) =>
        telemetry.adapter.identity(telemetry.span("synthetic", "test").span)?.traceId,
    );
    expect(new Set(ids).size).toBe(2);
    expect(sessions[0].telemetry).not.toBe(sessions[1].telemetry);
  } finally {
    await Promise.all(sessions.flatMap((session) => [session.close(), session.close()]));
  }
});

test("scope disposal drains exactly once, including repeated shutdown after completion", async () => {
  const session = await startTelemetry(cfg);
  const close = vi.spyOn(session.telemetry, "close");
  const held = session.telemetry.span("held", "synthetic");
  await Promise.all([session.close(), session.close()]);
  await held.done;
  await session.close();
  expect(close).toHaveBeenCalledTimes(1);
});

test("scope disposal does not complete until the exporter has finished", async () => {
  const session = await startTelemetry(cfg);
  const close = session.telemetry.close.bind(session.telemetry);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  session.telemetry.close = async () => {
    entered.resolve();
    await release.promise;
    await close();
  };
  let completed = false;
  const closing = session.close().then(() => {
    completed = true;
  });
  try {
    await entered.promise;
    expect(completed).toBe(false);
  } finally {
    release.resolve();
    await closing;
  }
  expect(completed).toBe(true);
});
