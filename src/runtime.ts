import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { createEffectActor, createEffectLogic, join, send, setupEffect } from "@xstate/effect";
import type { Config } from "./config.ts";
import { Telemetry } from "./telemetry.ts";

export class TelemetryStartupError extends Schema.TaggedError<TelemetryStartupError>()(
  "TelemetryStartupError",
  { message: Schema.String },
) {}

export class TelemetryService extends Context.Service<TelemetryService, Telemetry>()(
  "pi-otel/TelemetryService",
) {
  static layer(cfg: Config) {
    return Layer.effect(
      TelemetryService,
      Effect.acquireRelease(
        Effect.try({
          try: () => new Telemetry(cfg),
          catch: () => new TelemetryStartupError({ message: "Telemetry initialization failed" }),
        }),
        (telemetry) => Effect.promise(() => telemetry.close()),
      ),
    );
  }
}

const drain = createEffectLogic({
  effect: () => TelemetryService.use((telemetry) => Effect.promise(() => telemetry.close())),
});

export const sessionMachine = setupEffect({
  actors: { drain },
  schemas: { events: { SHUTDOWN: Schema.Struct({}) } },
}).createMachine({
  initial: "recording",
  states: {
    recording: { on: { SHUTDOWN: { target: "draining" } } },
    draining: { invoke: { src: "drain", onDone: { target: "closed" } } },
    closed: { type: "final" },
  },
});

const SessionService = Context.Service<{
  readonly telemetry: Telemetry;
  readonly close: Effect.Effect<void>;
}>("pi-otel/Session");

export async function startTelemetry(cfg: Config) {
  const runtime = ManagedRuntime.make(
    Layer.effect(
      SessionService,
      Effect.gen(function* () {
        const telemetry = yield* TelemetryService;
        const actor = yield* createEffectActor(sessionMachine);
        const close = Effect.gen(function* () {
          yield* send(actor, { type: "SHUTDOWN" });
          yield* join(actor).pipe(Effect.orDie);
        });
        return { telemetry, close };
      }),
    ).pipe(Layer.provide(TelemetryService.layer(cfg))),
  );
  try {
    const session = await runtime.runPromise(SessionService);
    let closing: Promise<void> | undefined;
    return {
      telemetry: session.telemetry,
      close: () => (closing ??= runtime.runPromise(session.close).finally(() => runtime.dispose())),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
