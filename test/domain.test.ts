import { describe, expect, test } from "vitest";
import {
  completionOutcome,
  modelOutcome,
  requestAttributes,
  responseAttributes,
  toolAttributes,
  toolCompletionAttributes,
  serializeContent,
  usageMeasurements,
} from "../src/domain.ts";
import { resolveConfig } from "../src/config-core.ts";

describe("pure event decisions (no providers or I/O)", () => {
  test("retry recovery has no sticky failure; cancellation outranks tool errors", () => {
    expect(modelOutcome("error")).toBe("error");
    expect(modelOutcome("stop")).toBe("ok");
    expect(modelOutcome("aborted")).toBe("cancelled");
    expect(completionOutcome(true, true)).toBe("cancelled");
    expect(completionOutcome(false, true)).toBe("error");
    expect(completionOutcome(false, false)).toBe("ok");
  });
  test("attribute decisions do not mutate model snapshots", () => {
    const model = Object.freeze({ provider: "synthetic", id: "model" });
    expect(requestAttributes(model)).toEqual({
      "gen_ai.provider.name": "synthetic",
      "gen_ai.request.model": "model",
    });
    expect(requestAttributes()["gen_ai.request.model"]).toBe("unknown");
    expect(responseAttributes("p", "m", "error")["error.type"]).toBe("model_error");
    expect(responseAttributes("p", "m", "stop")["error.type"]).toBeUndefined();
    expect(toolAttributes("read")).toEqual({ "gen_ai.tool.name": "read" });
    expect(toolCompletionAttributes("cancelled")["error.type"]).toBeUndefined();
    expect(toolCompletionAttributes("error", 0)).toEqual({
      "pi.tool.executed": true,
      "pi.tool.execution.duration_ms": 0,
      "error.type": "tool_error",
    });
  });
  test("disjoint finite usage includes zero and ignores totals/reasoning/components", () => {
    const usage = Object.freeze({
      input: 0,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
      reasoning: 99,
      totalTokens: 999,
      cost: Object.freeze({ total: 0, input: 5, totalFromProvider: true }),
    });
    const before = JSON.stringify(usage);
    expect(usageMeasurements(usage)).toEqual({
      tokens: [
        { bucket: "input", value: 0 },
        { bucket: "output", value: 3 },
        { bucket: "cacheRead", value: 4 },
        { bucket: "cacheWrite", value: 5 },
      ],
      cost: { value: 0, source: "provider" },
    });
    expect(JSON.stringify(usage)).toBe(before);
    expect(
      usageMeasurements({
        input: NaN,
        output: Infinity,
        cacheRead: -1,
        cacheWrite: "3",
        cost: { total: -1 },
      }),
    ).toEqual({ tokens: [], cost: undefined });
    expect(usageMeasurements(undefined).tokens).toEqual([]);
    expect(usageMeasurements({ cost: { total: 2 } }).cost?.source).toBe("estimated");
  });
  test("content serialization is opt-in, full, UTF-8 and failure-explicit", () => {
    const hostile = {
      toJSON() {
        throw new Error("must not run when disabled");
      },
    };
    expect(serializeContent(false, hostile)).toEqual({ kind: "disabled" });
    expect(serializeContent(true, hostile)).toEqual({ kind: "invalid" });
    expect(serializeContent(true, undefined)).toEqual({ kind: "content", body: "null", bytes: 4 });
    expect(serializeContent(true, "é🙂")).toEqual({ kind: "content", body: "é🙂", bytes: 6 });
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(serializeContent(true, cycle)).toEqual({ kind: "invalid" });
    expect(serializeContent(true, 1n)).toEqual({ kind: "invalid" });
    const value = Object.freeze({ text: "x".repeat(135000) });
    const serialized = serializeContent(true, value);
    expect(serialized.kind === "content" && JSON.parse(serialized.body)).toEqual(value);
  });
});

describe("pure configuration snapshots", () => {
  test("precedence preserves empty endpoint, empty header fallback and false", () => {
    const env = Object.freeze({
      PI_OTEL_ENDPOINT: "",
      PI_OTEL_HEADERS: "",
      PI_OTEL_CONTENT: "false",
    });
    const text = JSON.stringify({
      endpoint: "http://localhost:4318",
      content: true,
      headers: { Example: "synthetic" },
    });
    const result = resolveConfig(env, text);
    expect(result).toEqual({
      endpoint: "",
      content: false,
      headers: { Example: "synthetic" },
      serviceName: "pi",
    });
    result.headers.Example = "changed";
    expect(resolveConfig(env, text).headers.Example).toBe("synthetic");
    expect(env.PI_OTEL_CONTENT).toBe("false");
  });
  test("file schemas retain empty strings and tolerate unrelated keys without coercion", () => {
    expect(resolveConfig({}, '{"endpoint":"","headers":{},"unrelated":42}')).toEqual({
      endpoint: "",
      content: false,
      headers: {},
      serviceName: "pi",
    });
    for (const text of ['{"endpoint":5}', '{"serviceName":false}', '{"content":0}'])
      expect(() => resolveConfig({}, text)).toThrow("Invalid pi-otel configuration");
    expect(() => resolveConfig({}, '{"serviceName":""}')).toThrow("Invalid service name");
  });
  test("invalid files reject even with complete environment overrides", () => {
    const env = {
      PI_OTEL_ENDPOINT: "http://localhost",
      PI_OTEL_CONTENT: "true",
      PI_OTEL_HEADERS: "{}",
    };
    for (const text of ["{", "null", '{"content":"false"}', '{"headers":{"a":1}}'])
      expect(() => resolveConfig(env, text)).toThrow("Invalid pi-otel configuration");
    for (const env of [
      { PI_OTEL_CONTENT: "" },
      { PI_OTEL_HEADERS: "{" },
      { PI_OTEL_SERVICE_NAME: " " },
      { PI_OTEL_ENDPOINT: "file:///tmp" },
    ])
      expect(() => resolveConfig(env)).toThrow();
  });
});
