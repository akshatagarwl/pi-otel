import { Config as EffectConfig, ConfigProvider, Effect, Schema } from "effect";

const FileConfig = Schema.Struct({
  endpoint: Schema.optionalKey(Schema.String),
  serviceName: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Boolean),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const fileConfig = EffectConfig.schema(FileConfig);
function loadFile(value: unknown) {
  return Effect.runSync(
    fileConfig.parse(
      ConfigProvider.fromUnknown(Schema.decodeUnknownSync(FileConfig)(value), {
        preserveEmptyStrings: true,
      }),
    ),
  );
}
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
      file = loadFile(JSON.parse(text));
    } catch {
      throw new ConfigurationError({ message: "Invalid pi-otel configuration" });
    }
  }
  const source = ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true });
  const read = (key: string) =>
    Effect.runSync(EffectConfig.schema(Schema.optional(Schema.String), key).parse(source));
  const endpoint = read("PI_OTEL_ENDPOINT") ?? file.endpoint;
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
  const rawContent = read("PI_OTEL_CONTENT");
  const content =
    rawContent === undefined
      ? file.content === true
      : Schema.decodeUnknownSync(Schema.Literals(["true", "false"]))(rawContent) === "true";
  const rawHeaders = read("PI_OTEL_HEADERS");
  const headers = decodeHeaders(rawHeaders ? JSON.parse(rawHeaders) : (file.headers ?? {}));
  const serviceName = read("PI_OTEL_SERVICE_NAME") ?? file.serviceName ?? "pi";
  if (typeof serviceName !== "string" || !serviceName.trim())
    throw new Error("Invalid service name");
  return { endpoint, content, headers, serviceName };
}
