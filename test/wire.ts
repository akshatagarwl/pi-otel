import protobuf from "protobufjs";
// Wire-compatible subset of the public OTLP schema, sufficient to inspect IDs and sums.
const root = protobuf.parse(`syntax="proto3";
message AnyValue { string string_value=1; int64 int_value=3; double double_value=4; }
message KV {string key=1; AnyValue value=2;}
message Span {bytes trace_id=1; bytes span_id=2; bytes parent_span_id=4; string name=5; repeated KV attributes=9; Status status=15;}
message Status {int32 code=3;}
message Log {bytes trace_id=9; bytes span_id=10; AnyValue body=5; repeated KV attributes=6;}
message Point {double as_double=4; int64 as_int=6; repeated KV attributes=7;}
message Sum {repeated Point data_points=1; int32 aggregation_temporality=2;}
message Metric {string name=1; Sum sum=7;}
message Scope {repeated Span spans=2;}
message LogScope {repeated Log logs=2;}
message MetricScope {repeated Metric metrics=2;}
message ResourceSpans {repeated Scope scopes=2;}
message ResourceLogs {repeated LogScope scopes=2;}
message ResourceMetrics {repeated MetricScope scopes=2;}
message Traces {repeated ResourceSpans resources=1;}
message Logs {repeated ResourceLogs resources=1;}
message Metrics {repeated ResourceMetrics resources=1;}
`).root;
export function decode(kind: string, bytes: Buffer): any {
  const type = root.lookupType(kind);
  return type.toObject(type.decode(bytes), { bytes: String, longs: Number });
}
