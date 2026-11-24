import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const directory = fileURLToPath(new URL("./proto/", import.meta.url));
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => join(directory, target);
root.loadSync(
  ["trace", "logs", "metrics"].map(
    (signal) => `opentelemetry/proto/collector/${signal}/v1/${signal}_service.proto`,
  ),
);
const names: Record<string, string> = {
  Traces: "trace.v1.ExportTraceServiceRequest",
  Logs: "logs.v1.ExportLogsServiceRequest",
  Metrics: "metrics.v1.ExportMetricsServiceRequest",
};
export function decode(kind: string, bytes: Buffer): any {
  const type = root.lookupType(`opentelemetry.proto.collector.${names[kind]}`);
  const decoded = type.toObject(type.decode(bytes), { bytes: String, longs: Number });
  // Collection aliases only; every official message field remains available.
  const resources = decoded.resourceSpans ?? decoded.resourceLogs ?? decoded.resourceMetrics;
  return {
    ...decoded,
    resources: resources.map((resource: any) => ({
      ...resource,
      scopes: (resource.scopeSpans ?? resource.scopeLogs ?? resource.scopeMetrics).map(
        (scope: any) => ({ ...scope, ...(scope.logRecords ? { logs: scope.logRecords } : {}) }),
      ),
    })),
  };
}
