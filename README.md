# pi-otel

Standalone Pi 1.6.0 extension using official OpenTelemetry JS SDKs and OTLP HTTP/protobuf. No global providers, context managers, tool overrides, or provider payload interception. Compatible with an OTLP receiver such as [sigiro](https://sigiro.com).

## Install (not automatic)

Disable any other Pi telemetry extension (including desek) first. Do not run both.

```sh
npm ci
pi -e ./src/index.ts
# After verifying that invocation, optionally persist installation:
pi install /absolute/path/to/pi-otel
```

Create `~/.pi/agent/pi-otel.json` (protect it with mode 600):

```json
{
  "endpoint": "http://127.0.0.1:4318",
  "content": true,
  "headers": {}
}
```

The endpoint is a base URL; `/v1/traces`, `/v1/logs`, `/v1/metrics` are appended. No endpoint means disabled. Configuration is read at session start. Environment overrides: `PI_OTEL_ENDPOINT`, `PI_OTEL_CONTENT` (`true` or `false`), `PI_OTEL_HEADERS` (JSON string-to-string object), `PI_OTEL_SERVICE_NAME` (default `pi`, also configurable as `serviceName`). Remote endpoints are allowed only when explicitly configured; use HTTPS and appropriate authentication.

**Content defaults off.** The example explicitly opts into full prompts, assistant content (including reasoning if exposed by Pi), preflight tool arguments, and tool results/details. These can contain secrets and personal data. There is no content redaction or extension-level truncation. JSON bodies have UTF-8 byte counts. Cyclic/non-JSON-serializable values are omitted and counted as diagnostic failures. Pi itself may already have truncated tool output. Provider request histories and system prompts are not captured.

## Data contract

- One interaction root until `agent_settled`, including retries; `agent_end` does not close it. Child model failures remain errors even after recovery. A successful final model response makes the interaction successful; failed tools remain independently marked.
- Model spans cover Pi assistant message lifecycle, not individual HTTP attempts. Provider/model are taken from Pi. Finish reasons and generic error types are recorded; raw provider error strings are not.
- One span per tool call, including blocked/invalid calls. Parallel calls use independent contexts; nested calls use `parentToolCallId`. Tool spans parent to the originating model span (which may already have ended). `pi.tool.execution.duration_ms` is Pi's supplied execution duration; wall span duration includes preflight/scheduling. `tool.preflight.input` precedes later input-mutating hooks and is not claimed to be the executed input.
- Cancellation has `pi.outcome=cancelled`, not ERROR. Pending spans close on settlement or session shutdown. Reload/new/resume/fork recreate the runtime; tree navigation does not.
- Content logs carry explicit OTel context, producing actual OTLP `traceId`/`spanId`, plus readable correlation attributes. Conversation identity appears only on spans/logs, never metric dimensions.
- `pi.tokens` is a cumulative monotonic counter with **disjoint Pi buckets** `input`, `output`, `cacheRead`, `cacheWrite`. Input is not the inclusive GenAI input metric. Reasoning is already part of output and is not added again. Usage is recorded once per assistant `message_end`; failed requests contribute only usage Pi actually reports.
- `pi.cost` sums Pi's reported USD total, labeled `pi.cost.source=provider` when `totalFromProvider` is true, otherwise `estimated`. Never sums the total plus its components. Dimensions are provider/model and bucket/source, not session/tool IDs. Random `service.instance.id` isolates counter lifetimes across processes and replacement runtimes; no session-history replay.

`/otel-status` reports enablement/privacy, pending tools and diagnostic failures without exposing endpoints, headers or content. Diagnostic failures include exporter errors and serialization failures. The extension never prints exporter errors itself or installs a global diagnostic logger.

Shutdown is idempotent and awaits exporters for at most four seconds (transport timeout two seconds). SDK batch queues are bounded; saturation, receiver rejection, shutdown timeout, or abrupt process termination can lose telemetry. This is not durable delivery or zero-overhead instrumentation. Receiver-side payload limits still apply.

## Verification

```sh
npm run check
npm test
npm audit
```

Synthetic fixtures only. Tests load the actual pinned Pi 1.6.0 extension loader, exercise its registered event handlers, decode exported OTLP protobuf correlation/parentage and cumulative metrics, and check retry recovery, parallel/nested tools, unknown calls, cancellation, content privacy, 135 KB content and bounded shutdown. They do not call a live model or prove every provider's event behavior. A separate isolated Pi 1.6.0 print-mode smoke verified a real model/tool interaction: six spans (one interaction, three model, two tool), a failed exit-7 tool marked ERROR, eight correlated content logs and received token/cost metrics. Retry/switch/cancellation remain synthetic-handler checks, not live-provider E2E.

Development uses an isolated physical Pi dev dependency. Never symlink a host package tree into `node_modules` before running npm.
