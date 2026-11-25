import { Schema } from "effect";

const FileConfig = Schema.Struct({
  endpoint: Schema.optionalKey(Schema.String),
  serviceName: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Boolean),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeFile = Schema.decodeUnknownSync(FileConfig);
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  {
    message: Schema.String,
  },
) {}
const decodeHeaders = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String));

export interface Config {
  endpoint?: string;
  serviceName?: string;
  /** Host Pi version, supplied by the extension rather than configuration. */
  serviceVersion?: string;
  content: boolean;
  headers: Record<string, string>;
}
/** Resolve supplied snapshots only; acquiring them belongs to config.ts. */
export function resolveConfig(
  env: Readonly<Record<string, string | undefined>>,
  text?: string,
): Config {
  let file: Partial<Config> = {};
  if (text !== undefined) {
    try {
      file = decodeFile(JSON.parse(text));
    } catch {
      throw new ConfigurationError({ message: "Invalid pi-otel configuration" });
    }
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
  const rawContent = env.PI_OTEL_CONTENT;
  const content =
    rawContent === undefined
      ? file.content === true
      : Schema.decodeUnknownSync(Schema.Literals(["true", "false"]))(rawContent) === "true";
  const rawHeaders = env.PI_OTEL_HEADERS;
  const headers = rawHeaders ? decodeHeaders(JSON.parse(rawHeaders)) : { ...file.headers };
  const serviceName = env.PI_OTEL_SERVICE_NAME ?? file.serviceName ?? "pi";
  if (typeof serviceName !== "string" || !serviceName.trim())
    throw new Error("Invalid service name");
  return { endpoint, content, headers, serviceName };
}
