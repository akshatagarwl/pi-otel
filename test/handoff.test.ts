import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  claim,
  clearHandoffs,
  envCarrier,
  HANDOFF_TTL_MS,
  handoffTexts,
  offer,
} from "../src/handoff.ts";
import { decode } from "./wire.ts";

const carrier = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" };
afterEach(clearHandoffs);

test("handoff texts come from spawn tasks and tell messages only", () => {
  assert.deepEqual(
    handoffTexts("spawn", { tasks: [{ task: "audit the exporter" }, { task: "tiny" }, {}] }),
    ["audit the exporter"],
  );
  assert.deepEqual(handoffTexts("tell", { id: "x", message: "keep the tests" }), [
    "keep the tests",
  ]);
  assert.deepEqual(handoffTexts("bash", { command: "echo spawn something long" }), []);
  assert.deepEqual(handoffTexts("spawn", null), []);
});

test("a child claims its task once, never its own session's offer, and offers expire", () => {
  offer(["audit the exporter", "fix the flaky test"], { carrier, session: "parent" }, 0);
  assert.equal(claim("view\n\nTask:\naudit the exporter", "parent", 1), undefined);
  assert.deepEqual(claim("view\n\nTask:\naudit the exporter", "child-a", 1), {
    carrier,
    session: "parent",
  });
  assert.equal(claim("view\n\nTask:\naudit the exporter", "child-b", 1), undefined);
  assert.equal(claim("unrelated prompt", "child-b", 1), undefined);
  assert.equal(claim("Task:\nfix the flaky test", "child-b", HANDOFF_TTL_MS), undefined);
});

test("TRACEPARENT and TRACESTATE from the environment", () => {
  assert.equal(envCarrier({}), undefined);
  assert.deepEqual(envCarrier({ TRACEPARENT: carrier.traceparent }), carrier);
  assert.deepEqual(envCarrier({ TRACEPARENT: carrier.traceparent, TRACESTATE: "a=1" }), {
    ...carrier,
    tracestate: "a=1",
  });
});

test("a subagent session in the same process joins its parent's spawn trace", async () => {
  const payloads: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/v1/traces") payloads.push(Buffer.concat(chunks));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.PI_OTEL_ENDPOINT = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const { loadExtensions } =
      await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
    // Each Pi session loads its own copy of the extension.
    const session = async (id: string) => {
      const loaded = await loadExtensions([resolve("src/index.ts")], process.cwd());
      assert.deepEqual(loaded.errors, []);
      const ctx: any = {
        sessionManager: { getSessionId: () => id },
        model: { provider: "synthetic", id: "test" },
        signal: new AbortController().signal,
        ui: { notify() {} },
      };
      return async (name: string, event = {}) => {
        for (const fn of loaded.extensions[0].handlers.get(name) ?? []) await fn(event, ctx);
      };
    };
    const parent = await session("parent-session");
    const child = await session("child-session");
    const task = "audit the exporter for silent drops";
    await parent("session_start");
    await child("session_start");
    await parent("before_agent_start", { messageType: "user", prompt: "delegate an audit" });
    await parent("message_start", { message: { role: "assistant" } });
    await parent("message_end", { message: { role: "assistant", stopReason: "toolUse" } });
    await parent("tool_execution_start", {
      toolCallId: "s",
      toolName: "spawn",
      args: { tasks: [{ task }] },
    });
    await child("before_agent_start", { messageType: "user", prompt: `memory view\n\n${task}` });
    await child("agent_settled", { aborted: false });
    await parent("tool_execution_end", {
      toolCallId: "s",
      toolName: "spawn",
      result: { content: "Started" },
      isError: false,
    });
    await parent("agent_settled", { aborted: false });
    await child("session_shutdown");
    await parent("session_shutdown");
    const spans = payloads.flatMap((b) =>
      decode("Traces", b).resources.flatMap((r: any) => r.scopes.flatMap((s: any) => s.spans)),
    );
    const attr = (s: any, k: string) => s.attributes?.find((a: any) => a.key === k)?.value;
    const conversation = (s: any) => attr(s, "gen_ai.conversation.id")?.stringValue;
    const spawn = spans.find((s: any) => s.name === "pi.tool");
    const sub = spans.find(
      (s: any) => s.name === "pi.interaction" && conversation(s) === "child-session",
    );
    const root = spans.find(
      (s: any) => s.name === "pi.interaction" && conversation(s) === "parent-session",
    );
    assert.ok(spawn && sub && root);
    assert.deepEqual(sub.traceId, spawn.traceId);
    assert.deepEqual(sub.parentSpanId, spawn.spanId);
    assert.equal(attr(sub, "pi.parent.conversation.id").stringValue, "parent-session");
    assert.equal(attr(root, "pi.parent.conversation.id"), undefined);
  } finally {
    delete process.env.PI_OTEL_ENDPOINT;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
