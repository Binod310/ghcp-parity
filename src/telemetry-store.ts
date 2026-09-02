import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RequestUsageTelemetry } from "./types";

function telemetryFilePath(): string {
  return (
    process.env.COPILOT_PARITY_TELEMETRY_FILE ??
    path.join(os.homedir(), ".copilot-parity-local", "telemetry.jsonl")
  );
}

export function loadTelemetry(maxRecords: number): RequestUsageTelemetry[] {
  const filePath = telemetryFilePath();
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const records = fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RequestUsageTelemetry];
        } catch {
          return [];
        }
      })
      .reduce((byRequestId, telemetry) => {
        byRequestId.set(telemetry.request_id, telemetry);
        return byRequestId;
      }, new Map<string, RequestUsageTelemetry>());
    return [...records.values()].slice(-maxRecords);
  } catch {
    return [];
  }
}

export function appendTelemetry(telemetry: RequestUsageTelemetry): void {
  const filePath = telemetryFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, `${JSON.stringify(telemetry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[copilot-parity] telemetry persistence failed: ${message}\n`,
    );
  }
}
