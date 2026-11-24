import { test } from "vitest";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";

test("private defaults, explicit opt-in and invalid configuration", () => {
  assert.equal(config({}, "/nonexistent").content, false);
  assert.equal(
    config({ PI_OTEL_SERVICE_NAME: "pi-otel-validation" }, "/nonexistent").serviceName,
    "pi-otel-validation",
  );
  assert.throws(() => config({ PI_OTEL_SERVICE_NAME: "" }, "/nonexistent"));
  assert.equal(config({ PI_OTEL_CONTENT: "true" }, "/nonexistent").content, true);
  assert.throws(() => config({ PI_OTEL_ENDPOINT: "http://user:secret@localhost" }, "/nonexistent"));
  assert.throws(() => config({ PI_OTEL_CONTENT: "yes" }, "/nonexistent"));
  assert.throws(() => config({ PI_OTEL_HEADERS: '["secret"]' }, "/nonexistent"));
});

test("file precedence preserves false, empty overrides and strict malformed inputs", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-otel-config-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        endpoint: "http://localhost:4318",
        content: true,
        headers: { Authorization: "synthetic" },
        serviceName: " original ",
      }),
    );
    const resolved = config(
      { PI_OTEL_CONTENT: "false", PI_OTEL_ENDPOINT: "", PI_OTEL_HEADERS: "" },
      path,
    );
    assert.equal(resolved.content, false);
    assert.equal(resolved.endpoint, "");
    assert.equal(resolved.serviceName, " original ");
    assert.deepEqual(resolved.headers, { Authorization: "synthetic" });
    assert.equal(config({}, path).content, true);
    assert.throws(() => config({ PI_OTEL_CONTENT: "" }, path));
    assert.throws(() => config({ PI_OTEL_HEADERS: "{" }, path));
    for (const body of ["{", "null", '{"content":"false"}', '{"headers":{"a":1}}']) {
      writeFileSync(path, body);
      assert.throws(() => config({}, path));
    }
    assert.throws(() => config({}, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
