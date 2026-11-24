import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";

export type Outcome = "ok" | "error" | "cancelled" | "interrupted";
/** Event hooks cannot return the callback promise (it would block event delivery). */
export class SpanLifetime {
  readonly span: TelemetrySpan;
  readonly done: Promise<void>;
  private release!: () => void;
  private finished = false;
  constructor(context: TelemetryContext, name: string, attributes: SpanAttributes) {
    let admitted!: TelemetrySpan;
    const gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.done = context.startSpan({ name, attributes }, (span) => {
      admitted = span;
      return gate;
    });
    // Install rejection handling immediately; the owner also observes completion on close.
    void this.done.catch(() => {});
    this.span = admitted;
  }
  setAttribute(name: string, value: SpanAttributes[string]) {
    this.span.setAttributes({ [name]: value });
  }
  setAttributes(attrs: SpanAttributes) {
    this.span.setAttributes(attrs);
  }
  finish(outcome: Outcome) {
    if (this.finished) return;
    this.finished = true;
    this.span.setAttributes({ "pi.outcome": outcome });
    if (outcome === "error") this.span.setStatus({ status: "error" });
    this.release();
  }
}
