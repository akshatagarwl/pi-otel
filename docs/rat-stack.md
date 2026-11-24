# rat-stack migration

Reference: joelhooks/rat-stack `25296bbe66a689db9ac732ef1bb92155ef29f02f`.

## Kept

- Effect **4.1.5** (registry `latest`), schemas at configuration boundaries, a typed startup error, a scoped telemetry service and Layer, and one ManagedRuntime per started session.
- Effect scope disposal is the single shutdown owner. The shutdown-only XState actor and duplicate session service were removed; disposal awaits the acquired telemetry finalizer exactly once.
- Official OpenTelemetry providers and protobuf exporters, explicit content-log correlation, cumulative metrics, tool hierarchy, and final settlement semantics remain unchanged. The migration does not export Effect's internal spans.
- TypeScript **7.0.2**, pnpm **12.21.0**, Vitest **5.1.1**, `@effect/vitest` **4.1.5**, Oxlint **1.95.0**, Oxfmt **0.80.0**, lefthook **2.1.4**. Pi's physical development dependency remains **1.6.0**; it is never linked to the live host installation.

## Cut

No Turborepo for one package; no extra apps, infrastructure, HTTP/MCP surfaces, UI framework, or custom OTLP implementation. Pi loads TypeScript directly, so `build` is the compiler validation gate rather than a second extension artifact.

## Functional core, imperative shell

- `src/domain.ts` derives outcomes, model/tool attributes, disjoint usage measurements and content serialization results from supplied values. It has no SDK, filesystem, environment, clock, random or network dependencies. Serialization assumes ordinary JSON data; caller-defined getters/`toJSON` can execute code and serialization failures remain explicit results.
- `src/config-core.ts` validates supplied environment snapshots and optional file text using the pinned Effect schemas. `src/config.ts` alone acquires that text and the default environment/path. A malformed file still fails even when environment overrides are present.
- Pi callbacks in `src/index.ts` interpret these decisions. They retain session/generation guards, parent and lifetime handles, and asynchronous startup ownership. `runtime.ts`, `lifetime.ts`, `telemetry.ts` and `adapter.ts` own Effect resources, SDK creation, randomness, span settlement, W3C propagation and correlated export. No general command framework or second event-state machine was added.
- `test/domain.test.ts` exercises deterministic decisions independently of providers and I/O; existing config filesystem, loader, lifecycle, ownership and decoded-exporter suites remain integration coverage. Pure tests make no live-provider or performance claims. A separate isolated Pi print-mode smoke of this branch received five spans (interaction, two models, two tools including one error), seven content logs with actual OTLP correlation, four token buckets and cost. Both tools were issued in one response. Retry/switch/cancellation still rely on synthetic coverage.

## Verify without activation

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm exec lefthook run pre-commit --force --no-auto-install
```

Checks do not install Git hooks. Hook installation is an explicit developer choice (`pnpm exec lefthook install`), not an install/prepare/CI side effect. In a worktree, Git hooks may be shared with the main checkout.

A separate temporary `npm install --ignore-scripts --omit=dev --package-lock=false` succeeded; the physical Pi 1.6.0 loader loaded that npm-installed extension with zero errors. Thus Pi's npm installation path does not require a pnpm lockfile reader. Direct Node strip-only import is not supported (the existing telemetry constructor uses a TypeScript parameter property); Pi's loader handles it.

The parent also verified isolated live Pi 1.6.0 `-p -e` execution against the branch: six spans (one interaction, three model, two tool), an error-status tool, eight correlated content logs, four token buckets and one cost series. This proves normal execution only; retry and cancellation are covered by synthetic lifecycle tests, not live-provider E2E.

The tests retain actual Pi loader and decoded official-exporter checks using synthetic payloads. They cover retry settlement, nested/parallel tools, invalid calls, tool/model errors, cancellation, privacy, metric temporality and bounded shutdown. Lifecycle tests cover asynchronous finalization and repeated disposal after completion. No real prompts or production captures are fixtures.

## Cost and limits

A local three-process `node --import tsx` import probe (not a Pi startup benchmark) measured main at 258–539 ms / 14–15 MiB used heap, and this branch at 450–494 ms / 41–42 MiB. Timing is noisy; the roughly 27 MiB heap increase is material. Those historical measurements included the now-removed experimental XState bridge; they do not measure the simplified runtime. No per-event throughput improvement is claimed.

The existing four-second exporter shutdown deadline and content opt-in policy remain. No live extension activation, global configuration changes, push, or main merge are part of this branch's verification.
