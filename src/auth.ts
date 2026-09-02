import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fetch from "node-fetch";
import { createUpstreamFetchAgent } from "./upstream-agent";
import type { AuthStatusView } from "./types";

const authFetchAgent = createUpstreamFetchAgent();

export interface StoredAuth {
  accessToken: string;
  expiresAt: string | null;
  source: string;
  updatedAt: string;
  refreshToken?: string | null;
  tokenType?: "api" | "oauth";
}

const COPILOT_CHAT_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEFAULT_GITHUB_DOMAIN = "github.com";
const DEFAULT_USER_AGENT = "GitHubCopilotChat/0.35.0";
const DEFAULT_EDITOR_VERSION = "vscode/1.107.0";
const DEFAULT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
const DEFAULT_COPILOT_INTEGRATION_ID = "vscode-chat";

export interface DeviceAuthorizationStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  rawVerificationUriComplete: string | null;
}

export function authFilePath(): string {
  return path.join(appDirPath(), "auth.json");
}

export function readStoredAuth(): StoredAuth | null {
  try {
    const authFile = authFilePath();
    if (!fs.existsSync(authFile)) {
      return null;
    }
    const raw = fs.readFileSync(authFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (!parsed.accessToken || typeof parsed.accessToken !== "string") {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
      source: typeof parsed.source === "string" ? parsed.source : "unknown",
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
      refreshToken:
        typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
      tokenType: parsed.tokenType === "oauth" ? "oauth" : "api",
    };
  } catch {
    return null;
  }
}

export function writeStoredAuth(input: {
  accessToken: string;
  expiresAt?: string | null;
  source: string;
  refreshToken?: string | null;
  tokenType?: "api" | "oauth";
}): StoredAuth {
  const appDir = appDirPath();
  const authFile = authFilePath();
  fs.mkdirSync(appDir, { recursive: true });
  const stored: StoredAuth = {
    accessToken: input.accessToken,
    expiresAt: input.expiresAt ?? null,
    source: input.source,
    updatedAt: new Date().toISOString(),
    refreshToken: input.refreshToken ?? null,
    tokenType: input.tokenType ?? "api",
  };
  fs.writeFileSync(authFile, JSON.stringify(stored, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return stored;
}

export function clearStoredAuth(): void {
  const authFile = authFilePath();
  if (fs.existsSync(authFile)) {
    fs.unlinkSync(authFile);
  }
}

export function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) {
    return false;
  }
  const epoch = Date.parse(expiresAt);
  if (Number.isNaN(epoch)) {
    return false;
  }
  return epoch <= Date.now();
}

function appDirPath(): string {
  return (
    process.env.COPILOT_PARITY_HOME_DIR ??
    path.join(os.homedir(), ".copilot-parity-local")
  );
}

export function resolveCopilotToken(
  explicitToken?: string,
): string | undefined {
  if (explicitToken) {
    return explicitToken;
  }
  const stored = readStoredAuth();
  if (!stored) {
    return undefined;
  }
  if (isExpired(stored.expiresAt)) {
    return undefined;
  }
  return stored.accessToken;
}

export async function resolveCopilotApiToken(
  explicitToken?: string,
  deps?: {
    exchangeFn?: typeof exchangeOAuthForCopilotApiToken;
  },
): Promise<string | undefined> {
  if (explicitToken) {
    return explicitToken;
  }

  const stored = readStoredAuth();
  if (!stored) {
    return undefined;
  }

  const exchangeFn = deps?.exchangeFn ?? exchangeOAuthForCopilotApiToken;

  if (stored.tokenType === "oauth") {
    const exchanged = await exchangeFn(stored.accessToken);
    const updated = writeStoredAuth({
      accessToken: exchanged.apiToken,
      expiresAt: exchanged.expiresAt,
      refreshToken: stored.accessToken,
      source: `${stored.source}:auto-exchange`,
      tokenType: "api",
    });
    return updated.accessToken;
  }

  if (!isExpired(stored.expiresAt)) {
    return stored.accessToken;
  }

  if (!stored.refreshToken) {
    return undefined;
  }

  const exchanged = await exchangeFn(stored.refreshToken);
  const updated = writeStoredAuth({
    accessToken: exchanged.apiToken,
    expiresAt: exchanged.expiresAt,
    refreshToken: stored.refreshToken,
    source: `${stored.source}:auto-refresh`,
    tokenType: "api",
  });
  return updated.accessToken;
}

export async function refreshStoredCopilotApiToken(deps?: {
  exchangeFn?: typeof exchangeOAuthForCopilotApiToken;
}): Promise<string | undefined> {
  const stored = readStoredAuth();
  if (!stored) {
    return undefined;
  }

  const refreshSourceToken =
    stored.refreshToken ??
    (stored.tokenType === "oauth" ? stored.accessToken : null);
  if (!refreshSourceToken) {
    return undefined;
  }

  const exchangeFn = deps?.exchangeFn ?? exchangeOAuthForCopilotApiToken;
  const exchanged = await exchangeFn(refreshSourceToken);
  const updated = writeStoredAuth({
    accessToken: exchanged.apiToken,
    expiresAt: exchanged.expiresAt,
    refreshToken: refreshSourceToken,
    source: `${stored.source}:forced-refresh`,
    tokenType: "api",
  });
  return updated.accessToken;
}

export function importFromHeadroom(headroomPath?: string): StoredAuth {
  const sourcePath =
    headroomPath ?? path.join(os.homedir(), ".headroom", "copilot_auth.json");
  const raw = fs.readFileSync(sourcePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const accessToken =
    pickString(parsed, [
      "access_token",
      "accessToken",
      "bearer_token",
      "token",
    ]) ?? "";

  if (!accessToken) {
    throw new Error("Could not find an access token in the headroom auth file");
  }

  const expiresAt =
    pickString(parsed, ["expires_at", "expiresAt"]) ??
    deriveExpiryFromSeconds(parsed.expires_in);

  return writeStoredAuth({
    accessToken,
    expiresAt,
    source: "headroom-import",
    tokenType: accessToken.startsWith("tid_") ? "api" : "oauth",
  });
}

export async function startDeviceAuthorization(options?: {
  domain?: string;
  timeoutMs?: number;
}): Promise<DeviceAuthorizationStart> {
  const domain = normalizeGithubDomain(options?.domain);
  const timeoutMs = options?.timeoutMs ?? 10_000;

  const params = new URLSearchParams({
    client_id: COPILOT_CHAT_OAUTH_CLIENT_ID,
    scope: "read:user",
  });

  const response = await fetch(`https://${domain}/login/device/code`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": DEFAULT_USER_AGENT,
    },
    body: params.toString(),
    agent: authFetchAgent,
    timeout: timeoutMs,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Device authorization failed: HTTP ${response.status} ${body}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const deviceCode = str(payload.device_code);
  const userCode = str(payload.user_code);
  const verificationUri = str(payload.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("Device authorization returned an invalid response");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: num(payload.expires_in) ?? 900,
    interval: num(payload.interval) ?? 5,
    rawVerificationUriComplete: str(payload.verification_uri_complete) ?? null,
  };
}

export async function pollDeviceAuthorization(
  deviceCode: string,
  options?: {
    domain?: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
    timeoutMs?: number;
  },
): Promise<string> {
  const domain = normalizeGithubDomain(options?.domain);
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const expiresInSeconds = Math.max(1, options?.expiresInSeconds ?? 900);
  let pollIntervalSeconds = Math.max(1, options?.intervalSeconds ?? 5);
  const deadline = Date.now() + expiresInSeconds * 1000;

  while (Date.now() < deadline) {
    const params = new URLSearchParams({
      client_id: COPILOT_CHAT_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    const response = await fetch(`https://${domain}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": DEFAULT_USER_AGENT,
      },
      body: params.toString(),
      agent: authFetchAgent,
      timeout: timeoutMs,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Token polling failed: HTTP ${response.status} ${body}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = str(payload.access_token);
    if (accessToken) {
      return accessToken;
    }

    const error = str(payload.error) ?? "";
    if (error === "authorization_pending") {
      await sleep(pollIntervalSeconds * 1000);
      continue;
    }
    if (error === "slow_down") {
      pollIntervalSeconds += 5;
      await sleep(pollIntervalSeconds * 1000);
      continue;
    }
    if (error === "expired_token") {
      throw new Error("Device authorization expired");
    }
    if (error) {
      throw new Error(
        `Device authorization failed: ${str(payload.error_description) ?? error}`,
      );
    }

    await sleep(pollIntervalSeconds * 1000);
  }

  throw new Error("Device authorization expired");
}

export async function exchangeOAuthForCopilotApiToken(
  oauthToken: string,
  options?: {
    tokenExchangeUrl?: string;
    timeoutMs?: number;
  },
): Promise<{ apiToken: string; expiresAt: string | null }> {
  const tokenExchangeUrl =
    options?.tokenExchangeUrl ??
    process.env.GITHUB_COPILOT_TOKEN_EXCHANGE_URL ??
    "https://api.github.com/copilot_internal/v2/token";

  const response = await fetch(tokenExchangeUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${oauthToken}`,
      "User-Agent": DEFAULT_USER_AGENT,
      "Editor-Version":
        process.env.GITHUB_COPILOT_EDITOR_VERSION ?? DEFAULT_EDITOR_VERSION,
      "Editor-Plugin-Version":
        process.env.GITHUB_COPILOT_EDITOR_PLUGIN_VERSION ??
        DEFAULT_EDITOR_PLUGIN_VERSION,
      "Copilot-Integration-Id":
        process.env.GITHUB_COPILOT_INTEGRATION_ID ??
        DEFAULT_COPILOT_INTEGRATION_ID,
    },
    agent: authFetchAgent,
    timeout: options?.timeoutMs ?? 10_000,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Copilot token exchange failed: HTTP ${response.status} ${body}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const apiToken = str(payload.token);
  if (!apiToken) {
    throw new Error("Copilot token exchange returned an empty token");
  }

  return {
    apiToken,
    expiresAt: parseExpiry(payload.expires_at),
  };
}

export function getAuthStatusView(): AuthStatusView {
  const stored = readStoredAuth();
  return {
    configured: Boolean(stored),
    expired: stored ? isExpired(stored.expiresAt) : false,
    source: stored?.source ?? null,
    updatedAt: stored?.updatedAt ?? null,
    expiresAt: stored?.expiresAt ?? null,
    tokenType: stored?.tokenType ?? null,
    hasRefreshToken: Boolean(stored?.refreshToken),
    authFilePath: authFilePath(),
  };
}

function pickString(
  parsed: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function deriveExpiryFromSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return new Date(Date.now() + value * 1000).toISOString();
}

function normalizeGithubDomain(input?: string): string {
  const raw = (
    input ??
    process.env.GITHUB_COPILOT_HOST ??
    DEFAULT_GITHUB_DOMAIN
  )
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  return raw || DEFAULT_GITHUB_DOMAIN;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseExpiry(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const millis = Date.parse(value);
    return Number.isNaN(millis) ? null : new Date(millis).toISOString();
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
