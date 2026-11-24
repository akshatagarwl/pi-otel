import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { startTelemetry } from "../src/runtime.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(start: typeof startTelemetry) {
  const handlers = new Map<string, Function>();
  const notify = vi.fn();
  let status!: Function;
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (_name: string, command: { handler: Function }) => {
      status = command.handler;
    },
  };
  extension(pi as unknown as ExtensionAPI, start);
  const ctx = { sessionManager: { getSessionId: () => "synthetic" }, ui: { notify } };
  return {
    emit: (name: string, event = {}, session = "synthetic") =>
      handlers.get(name)!(event, { ...ctx, sessionManager: { getSessionId: () => session } }),
    pendingTools: async () => {
      await status("", ctx);
      return notify.mock.lastCall![0];
    },
  };
}

afterEach(() => vi.unstubAllEnvs());
const cfg = { endpoint: "http://127.0.0.1:1", content: false, headers: {} };

test("shutdown owns startup in flight and cannot resurrect telemetry", async () => {
  vi.stubEnv("PI_OTEL_ENDPOINT", cfg.endpoint);
  const created = await startTelemetry(cfg);
  const gate = deferred<typeof created>();
  const started = deferred<void>();
  const close = vi.spyOn(created, "close");
  const f = fixture(() => {
    started.resolve();
    return gate.promise;
  });
  const startup = f.emit("session_start");
  await started.promise;
  const shutdown = f.emit("session_shutdown");
  gate.resolve(created);
  await Promise.all([startup, shutdown]);
  await f.emit("tool_execution_start", { toolCallId: "late", toolName: "bash", args: {} });
  expect(await f.pendingTools()).toContain("pending tools=0");
  expect(close).toHaveBeenCalledTimes(1);
});

test("an old shutdown neither records tools nor clears a replacement session", async () => {
  vi.stubEnv("PI_OTEL_ENDPOINT", cfg.endpoint);
  const old = await startTelemetry(cfg);
  const replacement = await startTelemetry(cfg);
  const gate = deferred<void>();
  const realClose = old.close;
  old.close = () => gate.promise.then(realClose);
  let calls = 0;
  const f = fixture(async () => (calls++ === 0 ? old : replacement));
  try {
    await f.emit("session_start");
    const shutdown = f.emit("session_shutdown");
    await f.emit("tool_execution_start", { toolCallId: "during", toolName: "bash", args: {} });
    expect(await f.pendingTools()).toContain("pending tools=0");
    await f.emit("session_start");
    gate.resolve();
    await shutdown;
    await f.emit("tool_execution_start", { toolCallId: "new", toolName: "bash", args: {} });
    expect(await f.pendingTools()).toContain("pending tools=1");
  } finally {
    gate.resolve();
    await f.emit("session_shutdown");
    await Promise.all([realClose(), replacement.close()]);
  }
});

test("reverse acquisition completion keeps only the newest session and rejects old callbacks", async () => {
  vi.stubEnv("PI_OTEL_ENDPOINT", cfg.endpoint);
  const a = await startTelemetry(cfg);
  const b = await startTelemetry(cfg);
  const first = deferred<typeof a>();
  const second = deferred<typeof b>();
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const closeA = vi.spyOn(a, "close");
  let calls = 0;
  const f = fixture(() => {
    if (calls++ === 0) {
      firstStarted.resolve();
      return first.promise;
    }
    secondStarted.resolve();
    return second.promise;
  });
  try {
    const startA = f.emit("session_start", {}, "A");
    await firstStarted.promise;
    const startB = f.emit("session_start", {}, "B");
    await secondStarted.promise;
    second.resolve(b);
    await startB;
    first.resolve(a);
    await startA;
    expect(closeA).toHaveBeenCalledTimes(1);
    await f.emit(
      "tool_execution_end",
      { toolCallId: "stale", toolName: "bash", result: {}, isError: true },
      "A",
    );
    expect(await f.pendingTools()).toContain("pending tools=0");
    await f.emit(
      "tool_execution_start",
      { toolCallId: "current", toolName: "bash", args: {} },
      "B",
    );
    expect(await f.pendingTools()).toContain("pending tools=1");
  } finally {
    first.resolve(a);
    second.resolve(b);
    await f.emit("session_shutdown", {}, "B");
    await Promise.all([a.close(), b.close()]);
  }
});

test("a repeated start explicitly disposes the previous runtime", async () => {
  vi.stubEnv("PI_OTEL_ENDPOINT", cfg.endpoint);
  const a = await startTelemetry(cfg);
  const b = await startTelemetry(cfg);
  const closeA = vi.spyOn(a, "close");
  let calls = 0;
  const f = fixture(async () => (calls++ === 0 ? a : b));
  try {
    await f.emit("session_start");
    await f.emit("session_start");
    expect(closeA).toHaveBeenCalledTimes(1);
    await f.emit("tool_execution_start", { toolCallId: "current", toolName: "bash", args: {} });
    expect(await f.pendingTools()).toContain("pending tools=1");
  } finally {
    await f.emit("session_shutdown");
    await Promise.all([a.close(), b.close()]);
  }
});
