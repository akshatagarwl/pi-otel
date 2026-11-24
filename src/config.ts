import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  endpoint?: string;
  content: boolean;
  headers: Record<string, string>;
}
export function config(
  env = process.env,
  path = join(homedir(), ".pi/agent/pi-otel.json"),
): Config {
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Invalid pi-otel configuration");
  }
  const endpoint = env.PI_OTEL_ENDPOINT ?? file.endpoint;
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid pi-otel endpoint");
  }
  const content =
    env.PI_OTEL_CONTENT === undefined
      ? file.content === true
      : env.PI_OTEL_CONTENT === "true";
  if (
    env.PI_OTEL_CONTENT !== undefined &&
    !["true", "false"].includes(env.PI_OTEL_CONTENT)
  )
    throw new Error("PI_OTEL_CONTENT must be true or false");
  const headers = env.PI_OTEL_HEADERS
    ? JSON.parse(env.PI_OTEL_HEADERS)
    : (file.headers ?? {});
  if (
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    Object.values(headers).some((v) => typeof v !== "string")
  )
    throw new Error("Invalid pi-otel headers");
  return { endpoint, content, headers };
}
