import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigurationError, resolveConfig, type Config } from "./config-core.ts";
export { ConfigurationError, type Config } from "./config-core.ts";

export function config(
  env = process.env,
  path = join(homedir(), ".pi/agent/pi-otel.json"),
): Config {
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new ConfigurationError({ message: "Invalid pi-otel configuration" });
  }
  return resolveConfig(env, text);
}
