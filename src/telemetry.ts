import { z } from "zod";
import type {
  NullableNumber,
  ParsedUpstreamUsage,
  RequestUsageTelemetry,
  TelemetrySummary,
} from "./types";

const usageTelemetrySchema = z.object({
  request_id: z.string(),
  model: z.string(),
  before_tokens: z.number().nullable(),
  after_tokens: z.number().nullable(),
  saved_tokens: z.number().nullable(),
  saved_percent: z.number().nullable(),
  output_tokens: z.number().nullable().optional().default(null),
  aiu_before: z.number().nullable(),
  aiu_after: z.number().nullable(),
  aiu_saved: z.number().nullable(),
  timestamp: z.string(),
  route: z.string(),
  status: z.number().int(),
  measurement: z.enum(["provider", "estimated", "unavailable"]),
});

export function buildUsageTelemetry(
  input: RequestUsageTelemetry,
): RequestUsageTelemetry {
  return usageTelemetrySchema.parse(input);
}

export function estimateTokensFromJson(value: unknown): number {
  const text = JSON.stringify(value ?? {});
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

export function parseUpstreamUsage(body: unknown): ParsedUpstreamUsage {
  if (!isRecord(body)) {
    return {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      total_nano_aiu: null,
    };
  }

  const usage = isRecord(body.usage) ? body.usage : null;
  const copilotUsage = isRecord(body.copilot_usage)
    ? body.copilot_usage
    : usage && isRecord(usage.copilot_usage)
      ? usage.copilot_usage
      : null;

  return {
    input_tokens:
      asNullableNumber(usage?.input_tokens) ??
      asNullableNumber(usage?.prompt_tokens),
    output_tokens:
      asNullableNumber(usage?.output_tokens) ??
      asNullableNumber(usage?.completion_tokens),
    total_tokens: asNullableNumber(usage?.total_tokens),
    total_nano_aiu: asNullableNumber(copilotUsage?.total_nano_aiu),
  };
}

export function computeSavedTokens(
  before: NullableNumber,
  after: NullableNumber,
): { savedTokens: NullableNumber; savedPercent: NullableNumber } {
  if (before === null || after === null) {
    return { savedTokens: null, savedPercent: null };
  }

  const savedTokens = before - after;
  const savedPercent = before > 0 ? (savedTokens / before) * 100 : 0;
  return { savedTokens, savedPercent };
}

export function buildTelemetrySummary(
  requests: RequestUsageTelemetry[],
): TelemetrySummary {
  let totalBefore = 0;
  let totalAfter = 0;
  let totalSaved = 0;
  let totalOutput = 0;
  let savedPercentSum = 0;
  let savedPercentCount = 0;
  let totalAiuAfter = 0;
  let successCount = 0;

  for (const request of requests) {
    if (request.status >= 200 && request.status < 400) {
      successCount += 1;
    }

    if (typeof request.before_tokens === "number") {
      totalBefore += request.before_tokens;
    }
    if (typeof request.after_tokens === "number") {
      totalAfter += request.after_tokens;
    }
    if (typeof request.saved_tokens === "number") {
      totalSaved += request.saved_tokens;
    }
    if (typeof request.output_tokens === "number") {
      totalOutput += request.output_tokens;
    }
    if (typeof request.saved_percent === "number") {
      savedPercentSum += request.saved_percent;
      savedPercentCount += 1;
    }
    if (typeof request.aiu_after === "number") {
      totalAiuAfter += request.aiu_after;
    }
  }

  return {
    request_count: requests.length,
    success_count: successCount,
    error_count: requests.length - successCount,
    total_before_tokens: totalBefore,
    total_after_tokens: totalAfter,
    total_saved_tokens: totalSaved,
    total_output_tokens: totalOutput,
    average_saved_percent:
      savedPercentCount > 0 ? savedPercentSum / savedPercentCount : 0,
    total_aiu_after: totalAiuAfter,
  };
}

function asNullableNumber(value: unknown): NullableNumber {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
