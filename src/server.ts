import express, { type Request } from "express";
import { randomUUID } from "node:crypto";
import fetch from "node-fetch";
import {
  getAuthStatusView,
  refreshStoredCopilotApiToken,
  resolveCopilotApiToken,
} from "./auth";
import {
  buildTelemetrySummary,
  buildUsageTelemetry,
  computeSavedTokens,
  estimateTokensFromJson,
  parseUpstreamUsage,
} from "./telemetry";
import { optimizePayload } from "./optimizer";
import { applyTerseMode, resolveTerseLevel } from "./terse-mode";
import { createUpstreamFetchAgent } from "./upstream-agent";
import type { RequestUsageTelemetry, ServerOptions } from "./types";

const upstreamFetchAgent = createUpstreamFetchAgent();

export function createServer(customOptions?: Partial<ServerOptions>) {
  const options = resolveServerOptions(customOptions);
  const recentRequests: RequestUsageTelemetry[] = [];
  const app = express();

  // Log ALL incoming requests to debug VS Code routing
  app.use((req, _res, next) => {
    console.log(
      `[${new Date().toISOString()}] PARITY-HIT ${req.method} ${req.path}`,
    );
    next();
  });

  // Handle /p/:project prefix (strip it for internal routing)
  app.use((req, _res, next) => {
    const match = req.path.match(/^\/p\/([^\/]+)(\/.*)?$/);
    if (match) {
      const [, projectName, restOfPath] = match;
      // Store project name for telemetry
      (req as any).projectName = projectName;
      // Rewrite path without /p/:project prefix
      req.url = restOfPath || "/";
    }
    next();
  });

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    const auth = getAuthStatusView();
    res.json({
      ok: true,
      service: "copilot-parity-local",
      copilot_base_url: options.copilotBaseUrl,
      token_configured: Boolean(options.copilotToken) || auth.configured,
      auth,
    });
  });

  app.get("/stats/auth", (_req, res) => {
    res.json({ auth: getAuthStatusView() });
  });

  app.get("/stats/requests", (_req, res) => {
    res.json({ requests: recentRequests });
  });

  app.get("/stats/summary", (_req, res) => {
    res.json({ summary: buildTelemetrySummary(recentRequests) });
  });

  app.get("/stats/latest", (_req, res) => {
    res.json({ request: recentRequests[recentRequests.length - 1] ?? null });
  });

  app.get("/debug/parity", (_req, res) => {
    res.json({
      ok: true,
      parity: "local",
      copilot_base_url: options.copilotBaseUrl,
      time: new Date().toISOString(),
    });
  });

  app.get("/models", async (req, res) => {
    let runtimeToken: string | undefined;
    try {
      runtimeToken = await resolveCopilotApiToken(
        resolveRequestToken(req) ?? options.copilotToken,
      );
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Token resolution failed",
      });
      return;
    }
    if (!runtimeToken) {
      res.status(500).json({ error: "COPILOT_TOKEN is not configured" });
      return;
    }

    const url = resolveUpstreamUrl(req, options, options.copilotModelsPath);
    try {
      const { response: upstreamResponse } = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamGetRequest({
            url,
            token,
            timeoutMs: options.timeoutMs,
          }),
      );

      const rawText = await upstreamResponse.text();
      copyUpstreamHeaders(upstreamResponse.headers, res);
      res.status(upstreamResponse.status).send(rawText);
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Model discovery failed",
      });
    }
  });

  app.get("/v1/models", async (req, res) => {
    let runtimeToken: string | undefined;
    try {
      runtimeToken = await resolveCopilotApiToken(
        resolveRequestToken(req) ?? options.copilotToken,
      );
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Token resolution failed",
      });
      return;
    }
    if (!runtimeToken) {
      res.status(500).json({ error: "COPILOT_TOKEN is not configured" });
      return;
    }

    const url = resolveUpstreamUrl(req, options, options.copilotModelsPath);
    try {
      const { response: upstreamResponse } = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamGetRequest({
            url,
            token,
            timeoutMs: options.timeoutMs,
          }),
      );

      const rawText = await upstreamResponse.text();
      copyUpstreamHeaders(upstreamResponse.headers, res);
      res.status(upstreamResponse.status).send(rawText);
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Model discovery failed",
      });
    }
  });

  app.post("/v1/responses", async (req, res) => {
    const requestId = randomUUID();
    const terseLevel = resolveTerseLevel(
      req.headers["x-copilot-parity-terse"],
      options.defaultTerseLevel,
    );
    const terseBody = applyTerseMode(
      "/v1/responses",
      req.body ?? {},
      terseLevel,
    );
    const beforeTokens = estimateTokensFromJson(terseBody);
    const transformedBody = optimizePayload(
      "/v1/responses",
      terseBody,
      options,
    );
    const transformedTokens = estimateTokensFromJson(transformedBody);

    let runtimeToken: string | undefined;
    try {
      runtimeToken = await resolveCopilotApiToken(
        resolveRequestToken(req) ?? options.copilotToken,
      );
    } catch (error) {
      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: null,
        saved_tokens: null,
        saved_percent: null,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/responses",
        status: 502,
        measurement: "unavailable",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Token resolution failed",
        telemetry,
      });
      return;
    }
    if (!runtimeToken) {
      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: null,
        saved_tokens: null,
        saved_percent: null,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/responses",
        status: 500,
        measurement: "unavailable",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);

      res.status(500).json({
        error: "COPILOT_TOKEN is not configured",
        telemetry,
      });
      return;
    }

    const url = resolveUpstreamUrl(req, options, options.copilotResponsesPath);

    try {
      const { response: upstreamResponse } = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamRequest({
            url,
            token,
            requestId,
            body: transformedBody,
            timeoutMs: options.timeoutMs,
          }),
      );

      const rawText = await upstreamResponse.text();
      const parsedBody = safeJsonParse(rawText);
      const upstreamUsage = parseUpstreamUsage(parsedBody);
      const afterTokens = upstreamUsage.input_tokens ?? transformedTokens;
      const aiuAfter = upstreamUsage.total_nano_aiu;
      const tokenDelta = computeSavedTokens(beforeTokens, afterTokens);

      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: afterTokens,
        saved_tokens: tokenDelta.savedTokens,
        saved_percent: tokenDelta.savedPercent,
        aiu_before: null,
        aiu_after: aiuAfter,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/responses",
        status: upstreamResponse.status,
        measurement:
          upstreamUsage.input_tokens !== null ? "provider" : "estimated",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
      logTelemetry(telemetry);

      res.setHeader("x-copilot-parity-request-id", requestId);
      res.setHeader("x-copilot-parity-telemetry", JSON.stringify(telemetry));

      const contentType = upstreamResponse.headers.get("content-type");
      if (contentType) {
        res.setHeader("content-type", contentType);
      }

      if (isJsonContentType(contentType) && isObject(parsedBody)) {
        res.status(upstreamResponse.status).json({
          ...parsedBody,
          telemetry,
        });
        return;
      }

      res.status(upstreamResponse.status).send(rawText);
    } catch (error) {
      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: transformedTokens,
        saved_tokens: 0,
        saved_percent: 0,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/responses",
        status: 502,
        measurement: "estimated",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);

      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Upstream request failed",
        telemetry,
      });
    }
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const requestId = randomUUID();
    const terseLevel = resolveTerseLevel(
      req.headers["x-copilot-parity-terse"],
      options.defaultTerseLevel,
    );
    const terseBody = applyTerseMode(
      "/v1/chat/completions",
      req.body ?? {},
      terseLevel,
    );
    const beforeTokens = estimateTokensFromJson(terseBody);
    const transformedBody = optimizePayload(
      "/v1/chat/completions",
      terseBody,
      options,
    );
    const transformedTokens = estimateTokensFromJson(transformedBody);

    let runtimeToken: string | undefined;
    try {
      runtimeToken = await resolveCopilotApiToken(
        resolveRequestToken(req) ?? options.copilotToken,
      );
    } catch (error) {
      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: null,
        saved_tokens: null,
        saved_percent: null,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/chat/completions",
        status: 502,
        measurement: "unavailable",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Token resolution failed",
        telemetry,
      });
      return;
    }
    if (!runtimeToken) {
      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: null,
        saved_tokens: null,
        saved_percent: null,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/chat/completions",
        status: 500,
        measurement: "unavailable",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);

      res.status(500).json({
        error: "COPILOT_TOKEN is not configured",
        telemetry,
      });
      return;
    }

    const url = resolveUpstreamUrl(
      req,
      options,
      options.copilotChatCompletionsPath,
    );

    try {
      const { response: upstreamResponse } = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamRequest({
            url,
            token,
            requestId,
            body: transformedBody,
            timeoutMs: options.timeoutMs,
          }),
      );

      const rawText = await upstreamResponse.text();
      const parsedBody = safeJsonParse(rawText);
      const upstreamUsage = parseUpstreamUsage(parsedBody);
      const afterTokens = upstreamUsage.input_tokens ?? transformedTokens;
      const aiuAfter = upstreamUsage.total_nano_aiu;
      const tokenDelta = computeSavedTokens(beforeTokens, afterTokens);

      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: afterTokens,
        saved_tokens: tokenDelta.savedTokens,
        saved_percent: tokenDelta.savedPercent,
        aiu_before: null,
        aiu_after: aiuAfter,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/chat/completions",
        status: upstreamResponse.status,
        measurement:
          upstreamUsage.input_tokens !== null ? "provider" : "estimated",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
      logTelemetry(telemetry);

      res.setHeader("x-copilot-parity-request-id", requestId);
      res.setHeader("x-copilot-parity-telemetry", JSON.stringify(telemetry));

      const contentType = upstreamResponse.headers.get("content-type");
      if (contentType) {
        res.setHeader("content-type", contentType);
      }

      if (isJsonContentType(contentType) && isObject(parsedBody)) {
        res.status(upstreamResponse.status).json({
          ...parsedBody,
          telemetry,
        });
        return;
      }

      res.status(upstreamResponse.status).send(rawText);
    } catch (error) {
      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: transformedTokens,
        saved_tokens: 0,
        saved_percent: 0,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/chat/completions",
        status: 502,
        measurement: "estimated",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);

      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Upstream request failed",
        telemetry,
      });
    }
  });

  app.post("/v1/messages", async (req, res) => {
    const requestId = randomUUID();
    const terseLevel = resolveTerseLevel(
      req.headers["x-copilot-parity-terse"],
      options.defaultTerseLevel,
    );
    const terseBody = applyTerseMode(
      "/v1/messages",
      req.body ?? {},
      terseLevel,
    );
    const beforeTokens = estimateTokensFromJson(terseBody);
    const transformedBody = optimizePayload("/v1/messages", terseBody, options);
    const transformedTokens = estimateTokensFromJson(transformedBody);

    let runtimeToken: string | undefined;
    try {
      runtimeToken = await resolveCopilotApiToken(
        resolveRequestToken(req) ?? options.copilotToken,
      );
    } catch (error) {
      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: null,
        saved_tokens: null,
        saved_percent: null,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/messages",
        status: 502,
        measurement: "unavailable",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Token resolution failed",
        telemetry,
      });
      return;
    }
    if (!runtimeToken) {
      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: null,
        saved_tokens: null,
        saved_percent: null,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/messages",
        status: 500,
        measurement: "unavailable",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);

      res.status(500).json({
        error: "COPILOT_TOKEN is not configured",
        telemetry,
      });
      return;
    }

    const url = resolveUpstreamUrl(req, options, options.copilotMessagesPath);

    try {
      const { response: upstreamResponse } = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamRequest({
            url,
            token,
            requestId,
            body: transformedBody,
            timeoutMs: options.timeoutMs,
          }),
      );

      const rawText = await upstreamResponse.text();
      const parsedBody = safeJsonParse(rawText);
      const upstreamUsage = parseUpstreamUsage(parsedBody);
      const afterTokens = upstreamUsage.input_tokens ?? transformedTokens;
      const aiuAfter = upstreamUsage.total_nano_aiu;
      const tokenDelta = computeSavedTokens(beforeTokens, afterTokens);

      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: afterTokens,
        saved_tokens: tokenDelta.savedTokens,
        saved_percent: tokenDelta.savedPercent,
        aiu_before: null,
        aiu_after: aiuAfter,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/messages",
        status: upstreamResponse.status,
        measurement:
          upstreamUsage.input_tokens !== null ? "provider" : "estimated",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
      logTelemetry(telemetry);

      res.setHeader("x-copilot-parity-request-id", requestId);
      res.setHeader("x-copilot-parity-telemetry", JSON.stringify(telemetry));

      const contentType = upstreamResponse.headers.get("content-type");
      if (contentType) {
        res.setHeader("content-type", contentType);
      }

      if (isJsonContentType(contentType) && isObject(parsedBody)) {
        res.status(upstreamResponse.status).json({
          ...parsedBody,
          telemetry,
        });
        return;
      }

      res.status(upstreamResponse.status).send(rawText);
    } catch (error) {
      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: transformedTokens,
        saved_tokens: 0,
        saved_percent: 0,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/messages",
        status: 502,
        measurement: "estimated",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);

      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Upstream request failed",
        telemetry,
      });
    }
  });

  app.post("/v1/responses/compare", async (req, res) => {
    const requestId = randomUUID();
    const originalBody = req.body ?? {};
    const optimizedBody = optimizePayload(
      "/v1/responses",
      originalBody,
      options,
    );

    let runtimeToken: string | undefined;
    try {
      runtimeToken = await resolveCopilotApiToken(
        resolveRequestToken(req) ?? options.copilotToken,
      );
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Token resolution failed",
        request_id: requestId,
      });
      return;
    }
    if (!runtimeToken) {
      res.status(500).json({
        error: "COPILOT_TOKEN is not configured",
        request_id: requestId,
      });
      return;
    }

    const url = resolveUpstreamUrl(req, options, options.copilotResponsesPath);

    try {
      const baselineResult = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamRequest({
            url,
            token,
            requestId,
            body: originalBody,
            timeoutMs: options.timeoutMs,
          }),
      );
      runtimeToken = baselineResult.token;

      const optimizedResult = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamRequest({
            url,
            token,
            requestId,
            body: optimizedBody,
            timeoutMs: options.timeoutMs,
          }),
      );

      const baselineResponse = baselineResult.response;
      const optimizedResponse = optimizedResult.response;

      const baselineBodyRaw = await baselineResponse.text();
      const optimizedBodyRaw = await optimizedResponse.text();

      const baselineJson = safeJsonParse(baselineBodyRaw);
      const optimizedJson = safeJsonParse(optimizedBodyRaw);

      const baselineUsage = parseUpstreamUsage(baselineJson);
      const optimizedUsage = parseUpstreamUsage(optimizedJson);

      const baselineTokens =
        baselineUsage.input_tokens ?? estimateTokensFromJson(originalBody);
      const optimizedTokens =
        optimizedUsage.input_tokens ?? estimateTokensFromJson(optimizedBody);

      const tokenDelta = computeSavedTokens(baselineTokens, optimizedTokens);
      const aiuDelta = computeSavedTokens(
        baselineUsage.total_nano_aiu,
        optimizedUsage.total_nano_aiu,
      );

      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: baselineTokens,
        after_tokens: optimizedTokens,
        saved_tokens: tokenDelta.savedTokens,
        saved_percent: tokenDelta.savedPercent,
        aiu_before: baselineUsage.total_nano_aiu,
        aiu_after: optimizedUsage.total_nano_aiu,
        aiu_saved: aiuDelta.savedTokens,
        timestamp: new Date().toISOString(),
        route: "/v1/responses/compare",
        status:
          optimizedResponse.status >= baselineResponse.status
            ? optimizedResponse.status
            : baselineResponse.status,
        measurement:
          baselineUsage.input_tokens !== null &&
          optimizedUsage.input_tokens !== null
            ? "provider"
            : "estimated",
      });

      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
      logTelemetry(telemetry);

      res.json({
        request_id: requestId,
        baseline: {
          status: baselineResponse.status,
          usage: baselineUsage,
        },
        optimized: {
          status: optimizedResponse.status,
          usage: optimizedUsage,
        },
        telemetry,
      });
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Compare request failed",
        request_id: requestId,
      });
    }
  });

  app.post("/v1/chat/completions/compare", async (req, res) => {
    const requestId = randomUUID();
    const originalBody = req.body ?? {};
    const optimizedBody = optimizePayload(
      "/v1/chat/completions",
      originalBody,
      options,
    );

    let runtimeToken: string | undefined;
    try {
      runtimeToken = await resolveCopilotApiToken(
        resolveRequestToken(req) ?? options.copilotToken,
      );
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Token resolution failed",
        request_id: requestId,
      });
      return;
    }
    if (!runtimeToken) {
      res.status(500).json({
        error: "COPILOT_TOKEN is not configured",
        request_id: requestId,
      });
      return;
    }

    const url = resolveUpstreamUrl(
      req,
      options,
      options.copilotChatCompletionsPath,
    );

    try {
      const baselineResult = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamRequest({
            url,
            token,
            requestId,
            body: originalBody,
            timeoutMs: options.timeoutMs,
          }),
      );
      runtimeToken = baselineResult.token;

      const optimizedResult = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamRequest({
            url,
            token,
            requestId,
            body: optimizedBody,
            timeoutMs: options.timeoutMs,
          }),
      );

      const baselineResponse = baselineResult.response;
      const optimizedResponse = optimizedResult.response;

      const baselineBodyRaw = await baselineResponse.text();
      const optimizedBodyRaw = await optimizedResponse.text();

      const baselineJson = safeJsonParse(baselineBodyRaw);
      const optimizedJson = safeJsonParse(optimizedBodyRaw);

      const baselineUsage = parseUpstreamUsage(baselineJson);
      const optimizedUsage = parseUpstreamUsage(optimizedJson);

      const baselineTokens =
        baselineUsage.input_tokens ?? estimateTokensFromJson(originalBody);
      const optimizedTokens =
        optimizedUsage.input_tokens ?? estimateTokensFromJson(optimizedBody);

      const tokenDelta = computeSavedTokens(baselineTokens, optimizedTokens);
      const aiuDelta = computeSavedTokens(
        baselineUsage.total_nano_aiu,
        optimizedUsage.total_nano_aiu,
      );

      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: baselineTokens,
        after_tokens: optimizedTokens,
        saved_tokens: tokenDelta.savedTokens,
        saved_percent: tokenDelta.savedPercent,
        aiu_before: baselineUsage.total_nano_aiu,
        aiu_after: optimizedUsage.total_nano_aiu,
        aiu_saved: aiuDelta.savedTokens,
        timestamp: new Date().toISOString(),
        route: "/v1/chat/completions/compare",
        status:
          optimizedResponse.status >= baselineResponse.status
            ? optimizedResponse.status
            : baselineResponse.status,
        measurement:
          baselineUsage.input_tokens !== null &&
          optimizedUsage.input_tokens !== null
            ? "provider"
            : "estimated",
      });

      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
      logTelemetry(telemetry);

      res.json({
        request_id: requestId,
        baseline: {
          status: baselineResponse.status,
          usage: baselineUsage,
        },
        optimized: {
          status: optimizedResponse.status,
          usage: optimizedUsage,
        },
        telemetry,
      });
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Compare request failed",
        request_id: requestId,
      });
    }
  });

  app.post("/v1/messages/compare", async (req, res) => {
    const requestId = randomUUID();
    const originalBody = req.body ?? {};
    const optimizedBody = optimizePayload(
      "/v1/messages",
      originalBody,
      options,
    );

    let runtimeToken: string | undefined;
    try {
      runtimeToken = await resolveCopilotApiToken(
        resolveRequestToken(req) ?? options.copilotToken,
      );
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Token resolution failed",
        request_id: requestId,
      });
      return;
    }
    if (!runtimeToken) {
      res.status(500).json({
        error: "COPILOT_TOKEN is not configured",
        request_id: requestId,
      });
      return;
    }

    const url = resolveUpstreamUrl(req, options, options.copilotMessagesPath);

    try {
      const baselineResult = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamRequest({
            url,
            token,
            requestId,
            body: originalBody,
            timeoutMs: options.timeoutMs,
          }),
      );
      runtimeToken = baselineResult.token;

      const optimizedResult = await requestWithSingleRefresh(
        runtimeToken,
        (token) =>
          sendUpstreamRequest({
            url,
            token,
            requestId,
            body: optimizedBody,
            timeoutMs: options.timeoutMs,
          }),
      );

      const baselineResponse = baselineResult.response;
      const optimizedResponse = optimizedResult.response;

      const baselineBodyRaw = await baselineResponse.text();
      const optimizedBodyRaw = await optimizedResponse.text();

      const baselineJson = safeJsonParse(baselineBodyRaw);
      const optimizedJson = safeJsonParse(optimizedBodyRaw);

      const baselineUsage = parseUpstreamUsage(baselineJson);
      const optimizedUsage = parseUpstreamUsage(optimizedJson);

      const baselineTokens =
        baselineUsage.input_tokens ?? estimateTokensFromJson(originalBody);
      const optimizedTokens =
        optimizedUsage.input_tokens ?? estimateTokensFromJson(optimizedBody);

      const tokenDelta = computeSavedTokens(baselineTokens, optimizedTokens);
      const aiuDelta = computeSavedTokens(
        baselineUsage.total_nano_aiu,
        optimizedUsage.total_nano_aiu,
      );

      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: baselineTokens,
        after_tokens: optimizedTokens,
        saved_tokens: tokenDelta.savedTokens,
        saved_percent: tokenDelta.savedPercent,
        aiu_before: baselineUsage.total_nano_aiu,
        aiu_after: optimizedUsage.total_nano_aiu,
        aiu_saved: aiuDelta.savedTokens,
        timestamp: new Date().toISOString(),
        route: "/v1/messages/compare",
        status:
          optimizedResponse.status >= baselineResponse.status
            ? optimizedResponse.status
            : baselineResponse.status,
        measurement:
          baselineUsage.input_tokens !== null &&
          optimizedUsage.input_tokens !== null
            ? "provider"
            : "estimated",
      });

      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
      logTelemetry(telemetry);

      res.json({
        request_id: requestId,
        baseline: {
          status: baselineResponse.status,
          usage: baselineUsage,
        },
        optimized: {
          status: optimizedResponse.status,
          usage: optimizedUsage,
        },
        telemetry,
      });
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Compare request failed",
        request_id: requestId,
      });
    }
  });

  // --- Dedicated /chat/completions route ---
  // GitHub Copilot API uses /chat/completions (without /v1/) for VS Code Chat.
  // This is the primary path VS Code Copilot Chat extension sends requests to.
  app.post("/chat/completions", async (req, res) => {
    const requestId = randomUUID();
    const terseLevel = resolveTerseLevel(
      req.headers["x-copilot-parity-terse"],
      options.defaultTerseLevel,
    );
    const terseBody = applyTerseMode(
      "/v1/chat/completions",
      req.body ?? {},
      terseLevel,
    );
    const beforeTokens = estimateTokensFromJson(terseBody);
    const transformedBody = optimizePayload(
      "/v1/chat/completions",
      terseBody,
      options,
    );
    const transformedTokens = estimateTokensFromJson(transformedBody);
    const tokenDelta = computeSavedTokens(beforeTokens, transformedTokens);
    console.log(
      `[${new Date().toISOString()}] PARITY-CHAT POST /chat/completions model=${req.body?.model ?? "?"}`,
    );

    let runtimeToken: string | undefined;
    try {
      runtimeToken = await resolveCopilotApiToken(
        resolveRequestToken(req) ?? options.copilotToken,
      );
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Token resolution failed",
      });
      return;
    }
    if (!runtimeToken) {
      res.status(500).json({ error: "COPILOT_TOKEN is not configured" });
      return;
    }

    const url = `${options.copilotBaseUrl}/chat/completions`;
    const isStreaming = req.body?.stream === true;

    try {
      const { response: upstreamResponse, token: finalToken } =
        await requestWithSingleRefresh(runtimeToken, (token) =>
          sendUpstreamRequest({
            url,
            token,
            requestId,
            body: transformedBody,
            timeoutMs: options.timeoutMs,
          }),
        );
      void finalToken;

      const telemetry = buildUsageTelemetry({
        request_id: requestId,
        model: String(req.body?.model ?? "unknown"),
        before_tokens: beforeTokens,
        after_tokens: transformedTokens,
        saved_tokens: tokenDelta.savedTokens,
        saved_percent: tokenDelta.savedPercent,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/chat/completions",
        status: upstreamResponse.status,
        measurement: "estimated",
      });
      pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
      logTelemetry(telemetry);

      copyUpstreamHeaders(upstreamResponse.headers, res);
      res.status(upstreamResponse.status);

      if (isStreaming && upstreamResponse.body) {
        // Pipe streaming SSE response directly to client
        upstreamResponse.body.pipe(res);
      } else {
        const rawText = await upstreamResponse.text();
        res.send(rawText);
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] PARITY-CHAT /chat/completions error:`,
        error,
      );
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Upstream request failed",
      });
    }
  });

  // --- Catch-all passthrough route (like Headroom) ---
  // Handles any path not explicitly registered above. Pipes streaming responses
  // directly to the client so SSE works correctly.
  app.all("*", async (req, res) => {
    const reqPath = req.path;
    console.log(
      `[${new Date().toISOString()}] PARITY-PASSTHROUGH ${req.method} ${reqPath}`,
    );

    let runtimeToken: string | undefined;
    try {
      runtimeToken = await resolveCopilotApiToken(
        resolveRequestToken(req) ?? options.copilotToken,
      );
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Token resolution failed",
      });
      return;
    }
    if (!runtimeToken) {
      res.status(500).json({ error: "COPILOT_TOKEN is not configured" });
      return;
    }

    const upstreamUrl = `${options.copilotBaseUrl}${reqPath}`;
    const method = req.method.toUpperCase();
    const isBodyMethod = ["POST", "PUT", "PATCH"].includes(method);
    const body = isBodyMethod ? req.body : undefined;
    const optimizationRoute =
      reqPath === "/responses" ? "/v1/responses" : reqPath;
    const terseLevel = resolveTerseLevel(
      req.headers["x-copilot-parity-terse"],
      options.defaultTerseLevel,
    );
    const terseBody =
      body === undefined
        ? undefined
        : applyTerseMode(optimizationRoute, body, terseLevel);
    const beforeTokens =
      terseBody === undefined ? null : estimateTokensFromJson(terseBody);
    const transformedBody =
      terseBody === undefined
        ? undefined
        : optimizePayload(optimizationRoute, terseBody, options);
    const transformedTokens =
      transformedBody === undefined
        ? null
        : estimateTokensFromJson(transformedBody);
    const tokenDelta = computeSavedTokens(beforeTokens, transformedTokens);
    const isStreaming =
      isObject(transformedBody) && transformedBody.stream === true;

    try {
      const { response: upstreamResponse } = await requestWithSingleRefresh(
        runtimeToken,
        async (token) => {
          // Pass VS Code's original headers through so endpoint-specific headers
          // (Copilot-Integration-Id, openai-intent, Editor-Version, etc.) reach GitHub.
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === "string") headers[k] = v;
          }
          // Always replace auth with our resolved token.
          headers["Authorization"] = `Bearer ${token}`;
          // Remove hop-by-hop headers that must not be forwarded.
          delete headers["host"];
          delete headers["connection"];
          delete headers["proxy-connection"];
          delete headers["transfer-encoding"];

          return fetch(upstreamUrl, {
            method,
            headers,
            body:
              transformedBody !== undefined
                ? JSON.stringify(transformedBody)
                : undefined,
            agent: upstreamFetchAgent,
          });
        },
      );

      if (beforeTokens !== null && transformedTokens !== null) {
        const telemetry = buildUsageTelemetry({
          request_id: randomUUID(),
          model: String(body?.model ?? "unknown"),
          before_tokens: beforeTokens,
          after_tokens: transformedTokens,
          saved_tokens: tokenDelta.savedTokens,
          saved_percent: tokenDelta.savedPercent,
          aiu_before: null,
          aiu_after: null,
          aiu_saved: null,
          timestamp: new Date().toISOString(),
          route: reqPath,
          status: upstreamResponse.status,
          measurement: "estimated",
        });
        pushTelemetry(recentRequests, telemetry, options.maxRecentRequests);
        logTelemetry(telemetry);
      }

      copyUpstreamHeaders(upstreamResponse.headers, res);
      res.status(upstreamResponse.status);

      if (isStreaming && upstreamResponse.body) {
        upstreamResponse.body.pipe(res);
      } else {
        const rawText = await upstreamResponse.text();
        res.send(rawText);
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] PARITY-PASSTHROUGH error:`,
        error,
      );
      res.status(502).json({
        error:
          error instanceof Error
            ? error.message
            : "Passthrough request failed...",
      });
    }
  });

  return app;
}

function resolveServerOptions(
  customOptions?: Partial<ServerOptions>,
): ServerOptions {
  return {
    copilotBaseUrl:
      customOptions?.copilotBaseUrl ??
      process.env.COPILOT_BASE_URL ??
      getAuthStatusView().copilotApiUrl ??
      "https://api.githubcopilot.com",
    copilotModelsPath:
      customOptions?.copilotModelsPath ??
      process.env.COPILOT_MODELS_PATH ??
      "/models",
    copilotResponsesPath:
      customOptions?.copilotResponsesPath ??
      process.env.COPILOT_RESPONSES_PATH ??
      "/v1/responses",
    copilotChatCompletionsPath:
      customOptions?.copilotChatCompletionsPath ??
      process.env.COPILOT_CHAT_COMPLETIONS_PATH ??
      "/chat/completions",
    copilotMessagesPath:
      customOptions?.copilotMessagesPath ??
      process.env.COPILOT_MESSAGES_PATH ??
      "/v1/messages",
    copilotToken: customOptions?.copilotToken ?? process.env.COPILOT_TOKEN,
    timeoutMs:
      customOptions?.timeoutMs ??
      Number(process.env.COPILOT_TIMEOUT_MS ?? "60000"),
    maxRecentRequests:
      customOptions?.maxRecentRequests ??
      Number(process.env.MAX_RECENT_REQUESTS ?? "200"),
    enableOptimization:
      customOptions?.enableOptimization ??
      process.env.COPILOT_PARITY_ENABLE_OPTIMIZATION !== "0",
    defaultTerseLevel:
      customOptions?.defaultTerseLevel ??
      (process.env
        .COPILOT_PARITY_TERSE_MODE as ServerOptions["defaultTerseLevel"]) ??
      "off",
  };
}

async function sendUpstreamGetRequest(input: {
  url: string;
  token: string;
  timeoutMs: number;
}) {
  const editorVersion =
    process.env.GITHUB_COPILOT_EDITOR_VERSION ?? "vscode/1.107.0";
  const editorPluginVersion =
    process.env.GITHUB_COPILOT_EDITOR_PLUGIN_VERSION ?? "copilot-chat/0.35.0";
  const integrationId =
    process.env.GITHUB_COPILOT_INTEGRATION_ID ?? "vscode-chat";

  return fetch(input.url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/json",
      "User-Agent": "copilot-parity-local/0.1.0",
      "Editor-Version": editorVersion,
      "Editor-Plugin-Version": editorPluginVersion,
      "Copilot-Integration-Id": integrationId,
    },
    agent: upstreamFetchAgent,
    timeout: input.timeoutMs,
  });
}

async function sendUpstreamRequest(input: {
  url: string;
  token: string;
  requestId: string;
  body: unknown;
  timeoutMs: number;
}) {
  const editorVersion =
    process.env.GITHUB_COPILOT_EDITOR_VERSION ?? "vscode/1.107.0";
  const editorPluginVersion =
    process.env.GITHUB_COPILOT_EDITOR_PLUGIN_VERSION ?? "copilot-chat/0.35.0";
  const integrationId =
    process.env.GITHUB_COPILOT_INTEGRATION_ID ?? "vscode-chat";

  return fetch(input.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Request-Id": input.requestId,
      "User-Agent": "copilot-parity-local/0.1.0",
      "Editor-Version": editorVersion,
      "Editor-Plugin-Version": editorPluginVersion,
      "Copilot-Integration-Id": integrationId,
    },
    body: JSON.stringify(input.body),
    agent: upstreamFetchAgent,
    timeout: input.timeoutMs,
  });
}

async function requestWithSingleRefresh<T extends { status: number }>(
  token: string,
  send: (token: string) => Promise<T>,
): Promise<{ response: T; token: string }> {
  let currentToken = token;
  let response = await send(currentToken);
  if (response.status === 401) {
    const refreshedToken = await refreshStoredCopilotApiToken();
    if (refreshedToken) {
      currentToken = refreshedToken;
      response = await send(currentToken);
    }
  }
  return { response, token: currentToken };
}

function pushTelemetry(
  recentRequests: RequestUsageTelemetry[],
  telemetry: RequestUsageTelemetry,
  maxRecentRequests: number,
): void {
  recentRequests.push(telemetry);
  if (recentRequests.length > maxRecentRequests) {
    recentRequests.shift();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  return contentType.toLowerCase().includes("application/json");
}

function extractBearerToken(req: Request): string | undefined {
  const authHeader = req.header("authorization");
  if (!authHeader) {
    return undefined;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return undefined;
  }
  const token = match[1]?.trim();
  return token ? token : undefined;
}

function resolveRequestToken(req: Request): string | undefined {
  const token = extractBearerToken(req);
  if (!token) {
    return undefined;
  }
  if (!isForwardableCopilotBearer(token)) {
    return undefined;
  }
  return token;
}

function isForwardableCopilotBearer(token: string): boolean {
  const normalized = token.trim();
  if (!normalized) {
    return false;
  }
  if (
    ["token", "placeholder", "copilot-token"].includes(normalized.toLowerCase())
  ) {
    return false;
  }
  return /^(tid_|gho_|ghu_|github_pat_)/.test(normalized);
}

function resolveUpstreamUrl(
  req: Request,
  options: ServerOptions,
  defaultPath: string,
): string {
  const overrideBase = req.header("x-headroom-base-url");
  const overridePath = req.header("x-headroom-original-path");
  const baseUrl =
    normalizeUpstreamBaseUrl(overrideBase) ?? options.copilotBaseUrl;
  const path = normalizeUpstreamPath(overridePath) ?? defaultPath;
  return new URL(path, ensureBaseUrl(baseUrl)).toString();
}

function normalizeUpstreamBaseUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const path =
    parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

function normalizeUpstreamPath(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return null;
  }
  if (/^\/\/?[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return null;
  }
  const queryIndex = trimmed.indexOf("?");
  const hashIndex = trimmed.indexOf("#");
  if (queryIndex >= 0 || hashIndex >= 0) {
    return null;
  }
  return trimmed;
}

function ensureBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function logTelemetry(telemetry: RequestUsageTelemetry): void {
  process.stdout.write(
    [
      `[${telemetry.timestamp}]`,
      telemetry.route,
      `status=${telemetry.status}`,
      `request_id=${telemetry.request_id}`,
      `before_tokens=${telemetry.before_tokens}`,
      `after_tokens=${telemetry.after_tokens}`,
      `saved_tokens=${telemetry.saved_tokens}`,
      `saved_percent=${telemetry.saved_percent}`,
      `aiu_after=${telemetry.aiu_after}`,
    ].join(" ") + "\n",
  );
}

function copyUpstreamHeaders(
  headers: {
    forEach: (callback: (value: string, key: string) => void) => void;
  },
  res: { setHeader: (name: string, value: string) => void },
): void {
  const blocked = new Set([
    "content-length",
    "transfer-encoding",
    "connection",
  ]);
  headers.forEach((value, key) => {
    if (blocked.has(key.toLowerCase())) {
      return;
    }
    res.setHeader(key, value);
  });
}
