# pi-telemetry adapter

The Coding Agent extension now routes trace recording and usage metrics through
`@earendil-works/pi-telemetry` **1.6.0**. No configuration change is required.
Effect **4.1.5** scoped ownership and XState **6.0.0-beta.3** remain unchanged.

```text
Pi lifecycle hooks → owned deferred callback → TelemetrySpan
                                              ↓
                                     local OTel SDK providers
opt-in content ─────────────────────→ correlated OTLP logs
```

`pi-otel/adapter` exports `OTelTelemetryAdapter`, constructed with an explicit
OTel tracer and optional meter. It registers no globals. The generic adapter has
no content capture. Content remains separately opt-in via `PI_OTEL_CONTENT`;
existing prompt/assistant/tool bodies, explicit log trace/span correlation,
session identity, provider attributes and disjoint cumulative token/cost buckets
are retained. It does not read session history.

## Lifetime bridge

Native callbacks are admitted synchronously exactly once; returning/throwing or
settling their promise ends the span. Explicit statuses are buffered until end
because OTel's status precedence otherwise breaks last-write-wins. Recording
is inert after settlement, including child admission, but identities remain
injectable/linkable. Normal completion now explicitly exports OTel OK rather
than the previous implicit UNSET.

Pi notification hooks cannot await a model/tool's full lifetime without blocking
the matching end hook. `SpanLifetime` therefore owns a deferred promise. End
hooks resolve it idempotently; close resolves **all** remaining callbacks and
awaits settlement before shutting down providers, inside the existing four-second
bound. Rejections are handled immediately and counted by the owner.

Tools begin after their model finishes. The bridge extracts the retained model
identity into a new parent context, preserving the original single model/tool
hierarchy without violating settled-span inertness. Carriers are adapter-owned
opaque maps, not authorization or W3C headers. There is no ambient propagation.

## Verification and cost

Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`, `pnpm test`.
Dependencies are installed in this worktree, never linked to live Pi.

The official runner-independent conformance suite exercises callback admission,
result/rejection identity, status, inert recording, links, nesting/concurrency,
and multi-adapter propagation. Its two optional ordered-measurement cases are
explicitly skipped in the test runner: OTel aggregates measurements rather than
keeping an ordered log.
A separate real SDK metric-export test covers all three instrument kinds;
existing decoded OTLP tests cover cumulative token/cost metrics and content.
Existing real Pi-loader and ownership/race/privacy/cancellation/shutdown tests
remain. The runner reports **27 passed, 2 skipped** (29 total). The skipped official
`metrics` cases are “records ordered measurements and optional histogram
exemplars” and “copies instrument metadata and measurement attributes”. No
measurement-log shadow adapter is used. All committed fixtures are synthetic.

A separate parent-run real Pi `-p` smoke (`NATIVE_PI_TELEMETRY_V1`) passed:
six spans in one trace with root → model → tool parentage, including tools
parented to ended models; normal status OK (1), failed tool ERROR (2); eight
of eight content logs correlated with both IDs; four token buckets and cost
received. This is parent-reported live verification, not a committed fixture.
Decoded captures (`native-{spans,logs,metrics}.json`) and
`native-live-smoke.txt` remain private; no real telemetry is checked in.

A local sequential microprobe (Node 26.13.1, 20,000 synchronous spans/run,
1,000 warmup, three runs, no processors/export/network) measured native SDK
**0.83–1.49 µs/span**, adapter **2.47–2.79 µs/span**. This is not a Pi latency,
RSS, exporter throughput or live-provider benchmark. Deferred lifetimes add one
promise and a small handle per open operation, released on end/close.

The exported generic adapter prepares reuse; Durable integration is not
implemented or tested. Native content instrumentation, global activation,
publishing and main-branch integration are outside this change.
