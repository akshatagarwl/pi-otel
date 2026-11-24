import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
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

export async function startTelemetry(cfg: Config) {
  const runtime = ManagedRuntime.make(TelemetryService.layer(cfg));
  try {
    const telemetry = await runtime.runPromise(TelemetryService);
    return {
      telemetry,
      close: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
