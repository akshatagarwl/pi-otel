import { it } from "@effect/vitest";
import { Effect } from "effect";
import { createEffectActor, join, send, waitFor } from "@xstate/effect";
import { expect, test } from "vitest";
import { sessionMachine, TelemetryService, startTelemetry } from "../src/runtime.ts";

test("concurrent session runtimes have distinct trace IDs and idempotent shutdown", async () => {
  const cfg = { endpoint: "http://127.0.0.1:1", content: false, headers: {} };
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

it.effect("shutdown drains once and repeated shutdown cannot restart the exporter", () =>
  Effect.gen(function* () {
    let closes = 0;
    const telemetry = yield* TelemetryService;
    const close = telemetry.close.bind(telemetry);
    telemetry.close = async () => {
      closes++;
      await close();
    };
    const actor = yield* createEffectActor(sessionMachine);
    expect(actor.getSnapshot().value).toBe("recording");
    yield* send(actor, { type: "SHUTDOWN" });
    yield* join(actor);
    expect(actor.getSnapshot().value).toBe("closed");
    yield* send(actor, { type: "SHUTDOWN" });
    expect(closes).toBe(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      TelemetryService.layer({
        endpoint: "http://127.0.0.1:1",
        content: false,
        headers: {},
      }),
    ),
  ),
);

it.effect("draining remains nonterminal until the exporter has finished", () =>
  Effect.gen(function* () {
    const telemetry = yield* TelemetryService;
    const close = telemetry.close.bind(telemetry);
    let release!: () => void;
    telemetry.close = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const actor = yield* createEffectActor(sessionMachine);
    yield* send(actor, { type: "SHUTDOWN" });
    yield* waitFor(actor, (snapshot) => snapshot.matches("draining"));
    yield* Effect.yieldNow;
    expect(actor.getSnapshot().status).toBe("active");
    release();
    yield* join(actor);
    telemetry.close = close;
    expect(actor.getSnapshot().status).toBe("done");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      TelemetryService.layer({
        endpoint: "http://127.0.0.1:1",
        content: false,
        headers: {},
      }),
    ),
  ),
);
