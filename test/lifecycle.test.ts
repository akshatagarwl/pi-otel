import { test } from "vitest";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { decode } from "./wire.ts";

test("Pi loader lifecycle: retries, parallel/nested/failing tools, cancellation and privacy", async () => {
  const payloads: Record<string, Buffer[]> = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      (payloads[req.url!] ??= []).push(Buffer.concat(chunks));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.PI_OTEL_ENDPOINT = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.PI_OTEL_CONTENT = "true";
  const { loadExtensions } =
    await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const loaded = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const handlers = loaded.extensions[0].handlers;
  const ctx: any = {
    sessionManager: { getSessionId: () => "session-private" },
    model: { provider: "synthetic", id: "test" },
    signal: new AbortController().signal,
  };
  const emit = async (name: string, event = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };
  const assistant = (stopReason: string, errorMessage?: string) => ({
    message: {
      role: "assistant",
      provider: "synthetic",
      model: "test",
      stopReason,
      errorMessage,
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "opaque-cipher" },
        { type: "text", text: "answer-secret" },
      ],
      usage: {
        input: 300,
        cacheRead: 600,
        cacheWrite: 100,
        output: 80,
        cost: { total: 0.2 },
      },
    },
  });
  try {
    await emit("session_start");
    await emit("before_agent_start", {
      messageType: "user",
      prompt: "prompt-secret",
    });
    await emit("message_start", { message: { role: "assistant" } });
    await emit("message_end", assistant("error", "token expired"));
    await emit("agent_end");
    await emit("agent_start");
    await emit("message_start", { message: { role: "assistant" } });
    await emit("message_end", assistant("toolUse"));
    for (const id of ["a", "b"])
      await emit("tool_execution_start", {
        toolCallId: id,
        toolName: "bash",
        args: { command: id },
      });
    await emit("tool_execution_start", {
      toolCallId: "a/1",
      parentToolCallId: "a",
      toolName: "read",
      args: { path: "synthetic" },
    });
    await emit("tool_execution_end", {
      toolCallId: "b",
      toolName: "bash",
      result: { content: "failed-secret", structuredContent: { exit_code: 2 } },
      isError: true,
      durationMs: 5,
    });
    const circular: any = {};
    circular.self = circular;
    await emit("tool_execution_end", {
      toolCallId: "a/1",
      parentToolCallId: "a",
      toolName: "read",
      result: circular,
      isError: false,
      durationMs: 2,
    });
    await emit("tool_execution_end", {
      toolCallId: "a",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "ok-output" }],
        details: { duplicate: "details-copy" },
        structuredContent: { output: "structured-copy", exit_code: 0 },
      },
      isError: false,
      durationMs: 10,
    });
    await emit("tool_execution_end", {
      toolCallId: "unknown",
      toolName: "unknown",
      result: { content: "invalid" },
      isError: true,
    });
    await emit("message_start", { message: { role: "assistant" } });
    await emit("message_end", assistant("stop"));
    await emit("agent_settled", { aborted: false });
    await emit("before_agent_start", { messageType: "user", prompt: "cancel" });
    await emit("tool_execution_start", {
      toolCallId: "pending",
      toolName: "bash",
      args: {},
    });
    await emit("agent_settled", { aborted: true });
    await emit("session_shutdown");
    const spans = payloads["/v1/traces"].flatMap((b) =>
      decode("Traces", b).resources.flatMap((r: any) => r.scopes.flatMap((s: any) => s.spans)),
    );
    const resource = decode("Traces", payloads["/v1/traces"][0]).resources[0].resource;
    const version = resource.attributes.find((a: any) => a.key === "service.version");
    assert.match(version?.value.stringValue ?? "", /^\d+\.\d+\.\d+/);
    const attr = (s: any, k: string) => s.attributes?.find((a: any) => a.key === k)?.value;
    const interactions = spans.filter((s: any) => s.name === "pi.interaction");
    assert.equal(interactions.length, 2);
    assert.equal(attr(interactions[0], "pi.outcome").stringValue, "ok");
    assert.equal(attr(interactions[1], "pi.outcome").stringValue, "cancelled");
    assert.equal(spans.filter((s: any) => s.name === "pi.tool").length, 5);
    for (const span of spans.filter((s: any) => s.name !== "pi.interaction"))
      assert.ok(spans.some((s: any) => s.spanId === span.parentSpanId));
    const errors = spans.filter((s: any) => s.status?.code === 2);
    assert.equal(errors.length, 3);
    const failedModel = spans.find(
      (s: any) => s.name === "pi.model" && attr(s, "pi.outcome")?.stringValue === "error",
    );
    const failedTool = spans.find((s: any) => s.name === "pi.tool" && attr(s, "process.exit.code"));
    assert.equal(Number(attr(failedTool, "process.exit.code").intValue), 2);
    assert.equal(Number(attr(failedModel, "gen_ai.usage.input_tokens").intValue), 1000);
    assert.equal(attr(failedModel, "pi.cost.usd").doubleValue, 0.2);
    assert.equal(attr(failedModel, "pi.cost.source").stringValue, "estimated");
    assert.equal(attr(failedModel, "pi.cache.miss").boolValue, false);
    assert.equal(failedModel.status.message, "token expired");
    assert.equal(attr(failedModel, "exception.message").stringValue, "token expired");
    const logs = payloads["/v1/logs"].flatMap((b) =>
      decode("Logs", b).resources.flatMap((r: any) => r.scopes.flatMap((s: any) => s.logs)),
    );
    const bodies = logs.map((log: any) => log.body?.stringValue ?? "");
    assert.ok(bodies.some((b: string) => b.includes("ok-output")));
    assert.ok(bodies.some((b: string) => b.includes("answer-secret")));
    assert.ok(!bodies.some((b: string) => b.includes("opaque-cipher")));
    assert.ok(
      !bodies.some((b: string) => b.includes("details-copy") || b.includes("structured-copy")),
    );
    for (const log of logs)
      assert.ok(spans.some((s: any) => s.spanId === log.spanId && s.traceId === log.traceId));
    process.env.PI_OTEL_CONTENT = "false";
    const before = payloads["/v1/logs"].length;
    await emit("session_start");
    await emit("before_agent_start", {
      messageType: "user",
      prompt: "never-export",
    });
    await emit("session_shutdown");
    assert.equal(payloads["/v1/logs"].length, before);
  } finally {
    delete process.env.PI_OTEL_ENDPOINT;
    delete process.env.PI_OTEL_CONTENT;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
