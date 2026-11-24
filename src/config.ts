import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

const FileConfig = Schema.Struct({
  endpoint: Schema.optionalKey(Schema.String),
  serviceName: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Boolean),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeFileConfig = Schema.decodeUnknownSync(FileConfig);
const decodeHeaders = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String));

export interface Config {
  endpoint?: string;
  serviceName?: string;
  content: boolean;
  headers: Record<string, string>;
}
export function config(
  env = process.env,
  path = join(homedir(), ".pi/agent/pi-otel.json"),
): Config {
  let file: Partial<Config> = {};
  try {
    file = decodeFileConfig(JSON.parse(readFileSync(path, "utf8")));
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
    env.PI_OTEL_CONTENT === undefined ? file.content === true : env.PI_OTEL_CONTENT === "true";
  if (env.PI_OTEL_CONTENT !== undefined && !["true", "false"].includes(env.PI_OTEL_CONTENT))
    throw new Error("PI_OTEL_CONTENT must be true or false");
  const headers = decodeHeaders(
    env.PI_OTEL_HEADERS ? JSON.parse(env.PI_OTEL_HEADERS) : (file.headers ?? {}),
  );
  const serviceName = env.PI_OTEL_SERVICE_NAME ?? file.serviceName ?? "pi";
  if (typeof serviceName !== "string" || !serviceName.trim())
    throw new Error("Invalid service name");
  return { endpoint, content, headers, serviceName };
}
