# rat-stack migration

Reference: joelhooks/rat-stack `25296bbe66a689db9ac732ef1bb92155ef29f02f`.

## Kept

- Effect **4.1.5** (registry `latest`), schemas at configuration boundaries, a typed startup error, a scoped telemetry service and Layer, and one ManagedRuntime per started session.
- XState **6.0.0-beta.3** and `@xstate/effect` **1.0.0-beta.2**, matching the reference. The session moves from recording to draining to closed. A declared Effect actor performs shutdown; scope disposal is the idempotent safety net.
- Official OpenTelemetry providers and protobuf exporters, explicit content-log correlation, cumulative metrics, tool hierarchy, and final settlement semantics remain unchanged. The migration does not export Effect's internal spans.
- TypeScript **7.0.2**, pnpm **12.21.0**, Vitest **5.1.1**, `@effect/vitest` **4.1.5**, Oxlint **1.95.0**, Oxfmt **0.80.0**, lefthook **2.1.4**. Pi's physical development dependency remains **1.6.0**; it is never linked to the live host installation.

## Cut

No Turborepo for one package; no extra apps, infrastructure, HTTP/MCP surfaces, UI framework, or custom OTLP implementation. Pi loads TypeScript directly, so `build` is the compiler validation gate rather than a second extension artifact.

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

The tests retain actual Pi loader and decoded official-exporter checks using synthetic payloads. They cover retry settlement, nested/parallel tools, invalid calls, tool/model errors, cancellation, privacy, metric temporality and bounded shutdown. Effect lifecycle tests cover asynchronous draining and terminal-state behavior. No real prompts or production captures are fixtures.

## Cost and limits

A local three-process `node --import tsx` import probe (not a Pi startup benchmark) measured main at 258–539 ms / 14–15 MiB used heap, and this branch at 450–494 ms / 41–42 MiB. Timing is noisy; the roughly 27 MiB heap increase is material. Effect and the experimental XState bridge add runtime dependencies; their installed directories total roughly 75 MiB, which is not bundle size or RSS. No per-event throughput improvement is claimed.

The existing four-second exporter shutdown deadline and content opt-in policy remain. No live extension activation, global configuration changes, push, or main merge are part of this branch's verification.
