import { test } from "vitest";
import assert from "node:assert/strict";
import { resolve } from "node:path";
const host = process.env.PI_HOST_ROOT ?? resolve("node_modules/@earendil-works/pi-coding-agent");

test("installed Pi 1.6.0 loader accepts package and lifecycle hooks", async () => {
  const { loadExtensions } = await import(`${host}/dist/core/extensions/loader.js`);
  const result = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const handlers = result.extensions[0].handlers;
  assert.equal(handlers.has("agent_end"), false);
  assert.equal(handlers.has("agent_settled"), true);
});
