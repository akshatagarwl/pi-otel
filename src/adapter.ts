import {
  ROOT_CONTEXT,
  trace,
  SpanStatusCode,
  type Attributes,
  type SpanContext,
  type Tracer,
  type Meter,
} from "@opentelemetry/api";
import {
  NOOP_TELEMETRY_CONTEXT,
  type TelemetryContext,
  type TelemetrySpan,
  type TelemetryPropagation,
  type TelemetryMetrics,
  type SpanAttributes,
  type SpanOptions,
  type SpanStatus,
  type SpanLink,
} from "@earendil-works/pi-telemetry";

const copy = (attrs: SpanAttributes = {}): Attributes =>
  Object.fromEntries(
    Object.entries(attrs)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
  );

/** Explicit, provider-local adapter. Never registers global OTel state. */
export class OTelTelemetryAdapter implements TelemetryContext {
  private identities = new WeakMap<TelemetryContext, SpanContext>();
  readonly propagation: TelemetryPropagation;
  readonly metrics?: TelemetryMetrics;
  constructor(
    private tracer: Tracer,
    meter?: Meter,
  ) {
    this.propagation = {
      inject: (context) => {
        const sc = this.identities.get(context);
        return sc
          ? { traceId: sc.traceId, spanId: sc.spanId, traceFlags: String(sc.traceFlags) }
          : undefined;
      },
      extract: (carrier) => {
        if (
          typeof carrier?.traceId !== "string" ||
          typeof carrier.spanId !== "string" ||
          typeof carrier.traceFlags !== "string"
        )
          return this;
        return this.parent({
          traceId: carrier.traceId,
          spanId: carrier.spanId,
          traceFlags: Number(carrier.traceFlags),
          isRemote: true,
        });
      },
    };
    if (meter)
      this.metrics = {
        counter: (name, options) => {
          const instrument = meter.createCounter(name, options);
          return { add: (value, attrs) => instrument.add(value, copy(attrs)) };
        },
        upDownCounter: (name, options) => {
          const instrument = meter.createUpDownCounter(name, options);
          return { add: (value, attrs) => instrument.add(value, copy(attrs)) };
        },
        histogram: (name, options) => {
          const instrument = meter.createHistogram(name, {
            ...options,
            advice: {
              explicitBucketBoundaries: options?.boundaries ? [...options.boundaries] : undefined,
            },
          });

          return {
            record: (value, attrs, parent) =>
              instrument.record(value, copy(attrs), this.nativeContext(parent)),
          };
        },
      };
  }
  /** Backend identity is deliberately separate from the generic span contract. */
  identity(context: TelemetryContext) {
    return this.identities.get(context);
  }
  private nativeContext(parent?: TelemetryContext) {
    const sc = parent && this.identities.get(parent);
    return sc ? trace.setSpanContext(ROOT_CONTEXT, sc) : ROOT_CONTEXT;
  }
  private link(link: SpanLink) {
    const context = this.identities.get(link.context);
    return context ? { context, attributes: copy(link.attributes) } : undefined;
  }
  private parent(identity: SpanContext): TelemetryContext {
    const parent: TelemetryContext = {
      propagation: this.propagation,
      metrics: this.metrics,
      startSpan: (options, callback) => this.run(parent, options, callback),
    };
    this.identities.set(parent, identity);
    return parent;
  }
  startSpan<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    return this.run(undefined, options, callback);
  }
  private inert<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    return NOOP_TELEMETRY_CONTEXT.startSpan(options, (noop) =>
      callback({
        ...noop,
        metrics: this.metrics,
        propagation: this.propagation,
        startSpan: (child, cb) => this.inert(child, cb),
      }),
    );
  }
  private async run<T>(
    parent: TelemetryContext | undefined,
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    const native = this.tracer.startSpan(
      options.name,
      {
        attributes: copy(options.attributes),
        links: options.links?.flatMap((link) => {
          const value = this.link(link);
          return value ? [value] : [];
        }),
      },
      this.nativeContext(parent),
    );
    let settled = false;
    let status: SpanStatus | undefined;
    const span: TelemetrySpan = {
      metrics: this.metrics,
      propagation: this.propagation,
      startSpan: (child, cb) => (settled ? this.inert(child, cb) : this.run(span, child, cb)),
      setAttributes: (attrs) => {
        if (!settled) native.setAttributes(copy(attrs));
      },
      addEvent: (name, attrs) => {
        if (!settled) native.addEvent(name, copy(attrs));
      },
      addLink: (link) => {
        const value = this.link(link);
        if (!settled && value) native.addLink(value);
      },
      setStatus: (value) => {
        if (!settled)
          status =
            value.status === "ok"
              ? { status: "ok" }
              : { status: "error", ...(value.error ? { error: { ...value.error } } : {}) };
      },
    };
    this.identities.set(span, native.spanContext());
    try {
      return await callback(span);
    } catch (error) {
      status ??=
        error instanceof Error
          ? { status: "error", error: { name: error.name, message: error.message } }
          : { status: "error" };
      throw error;
    } finally {
      settled = true;
      native.setStatus({
        code: status?.status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
        message: status?.status === "error" ? status.error?.message : undefined,
      });
      if (status?.status === "error" && status.error)
        native.setAttributes({
          "exception.type": status.error.name,
          "exception.message": status.error.message,
        });
      native.end();
    }
  }
}
