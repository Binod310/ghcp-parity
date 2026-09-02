export type NullableNumber = number | null;

export interface RequestUsageTelemetry {
  request_id: string;
  model: string;
  before_tokens: NullableNumber;
  after_tokens: NullableNumber;
  saved_tokens: NullableNumber;
  saved_percent: NullableNumber;
  output_tokens?: NullableNumber;
  aiu_before: NullableNumber;
  aiu_after: NullableNumber;
  aiu_saved: NullableNumber;
  timestamp: string;
  route: string;
  status: number;
  measurement: "provider" | "estimated" | "unavailable";
}

export interface ParsedUpstreamUsage {
  input_tokens: NullableNumber;
  output_tokens: NullableNumber;
  total_tokens: NullableNumber;
  total_nano_aiu: NullableNumber;
}

export interface ServerOptions {
  copilotBaseUrl: string;
  copilotModelsPath: string;
  copilotResponsesPath: string;
  copilotChatCompletionsPath: string;
  copilotMessagesPath: string;
  copilotToken?: string;
  timeoutMs: number;
  maxRecentRequests: number;
  enableOptimization: boolean;
  defaultTerseLevel: "off" | "lite" | "full" | "ultra";
}

export interface AuthStatusView {
  configured: boolean;
  expired: boolean;
  source: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  tokenType: "api" | "oauth" | null;
  hasRefreshToken: boolean;
  copilotApiUrl: string | null;
  authFilePath: string;
}

export interface TelemetrySummary {
  request_count: number;
  success_count: number;
  error_count: number;
  total_before_tokens: number;
  total_after_tokens: number;
  total_saved_tokens: number;
  total_output_tokens: number;
  average_saved_percent: number;
  total_aiu_after: number;
}
