import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";

test("private defaults, explicit opt-in and invalid configuration", () => {
  assert.equal(config({}, "/nonexistent").content, false);
  assert.equal(
    config({ PI_OTEL_SERVICE_NAME: "pi-otel-validation" }, "/nonexistent")
      .serviceName,
    "pi-otel-validation",
  );
  assert.throws(() => config({ PI_OTEL_SERVICE_NAME: "" }, "/nonexistent"));
  assert.equal(
    config({ PI_OTEL_CONTENT: "true" }, "/nonexistent").content,
    true,
  );
  assert.throws(() =>
    config(
      { PI_OTEL_ENDPOINT: "http://user:secret@localhost" },
      "/nonexistent",
    ),
  );
  assert.throws(() => config({ PI_OTEL_CONTENT: "yes" }, "/nonexistent"));
  assert.throws(() =>
    config({ PI_OTEL_HEADERS: '["secret"]' }, "/nonexistent"),
  );
});
