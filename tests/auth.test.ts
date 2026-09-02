import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "mocha";
import {
  clearStoredAuth,
  getAuthStatusView,
  importFromHeadroom,
  isExpired,
  readStoredAuth,
  refreshStoredCopilotApiToken,
  resolveCopilotApiToken,
  writeStoredAuth,
} from "../src/auth";

describe("auth helpers", () => {
  it("evaluates expiration", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const future = new Date(Date.now() + 10_000).toISOString();
    assert.equal(isExpired(past), true);
    assert.equal(isExpired(future), false);
    assert.equal(isExpired(null), false);
  });

  it("imports token from headroom-style file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-auth-"));
    process.env.COPILOT_PARITY_HOME_DIR = path.join(tempDir, "local-home");
    const headroomFile = path.join(tempDir, "copilot_auth.json");

    fs.writeFileSync(
      headroomFile,
      JSON.stringify({
        access_token: "token-123",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      "utf8",
    );

    const stored = importFromHeadroom(headroomFile);
    assert.equal(stored.accessToken, "token-123");
    assert.equal(stored.source, "headroom-import");

    clearStoredAuth();
    delete process.env.COPILOT_PARITY_HOME_DIR;
  });

  it("auto exchanges stored oauth token to api token", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-auth-"));
    process.env.COPILOT_PARITY_HOME_DIR = path.join(tempDir, "local-home");

    writeStoredAuth({
      accessToken: "gho-oauth-token",
      source: "test",
      tokenType: "oauth",
    });

    const resolved = await resolveCopilotApiToken(undefined, {
      exchangeFn: async () => ({
        apiToken: "tid-api-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });

    assert.equal(resolved, "tid-api-token");
    assert.equal(readStoredAuth()?.tokenType, "api");
    assert.equal(readStoredAuth()?.refreshToken, "gho-oauth-token");

    clearStoredAuth();
    delete process.env.COPILOT_PARITY_HOME_DIR;
  });

  it("refreshes expired api token from stored refresh token", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-auth-"));
    process.env.COPILOT_PARITY_HOME_DIR = path.join(tempDir, "local-home");

    writeStoredAuth({
      accessToken: "tid-old",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshToken: "gho-refresh",
      source: "test",
      tokenType: "api",
    });

    const refreshed = await refreshStoredCopilotApiToken({
      exchangeFn: async () => ({
        apiToken: "tid-new",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });

    assert.equal(refreshed, "tid-new");
    assert.equal(readStoredAuth()?.accessToken, "tid-new");

    clearStoredAuth();
    delete process.env.COPILOT_PARITY_HOME_DIR;
  });

  it("refresh command path works from oauth-only stored token", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-auth-"));
    process.env.COPILOT_PARITY_HOME_DIR = path.join(tempDir, "local-home");

    writeStoredAuth({
      accessToken: "gho-oauth",
      source: "test",
      tokenType: "oauth",
    });

    const refreshed = await refreshStoredCopilotApiToken({
      exchangeFn: async () => ({
        apiToken: "tid-from-oauth",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });

    assert.equal(refreshed, "tid-from-oauth");
    assert.equal(readStoredAuth()?.refreshToken, "gho-oauth");
    assert.equal(readStoredAuth()?.tokenType, "api");

    clearStoredAuth();
    delete process.env.COPILOT_PARITY_HOME_DIR;
  });

  it("returns auth status view for configured token", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-auth-"));
    process.env.COPILOT_PARITY_HOME_DIR = path.join(tempDir, "local-home");

    writeStoredAuth({
      accessToken: "tid-token",
      source: "test",
      tokenType: "api",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const status = getAuthStatusView();
    assert.equal(status.configured, true);
    assert.equal(status.tokenType, "api");
    assert.equal(status.expired, false);

    clearStoredAuth();
    delete process.env.COPILOT_PARITY_HOME_DIR;
  });
});
