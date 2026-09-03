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
  buildModelTelemetrySummaries,
  buildUsageTelemetry,
  computeSavedTokens,
  estimateTokensFromJson,
  parseUpstreamUsage,
} from "./telemetry";
import { loadExternalCompressors, optimizePayload } from "./optimizer";
import { applyTerseMode, resolveTerseLevel } from "./terse-mode";
import { appendTelemetry, loadTelemetry } from "./telemetry-store";
import { createSseOutputCounter } from "./stream-output";
import { createUpstreamFetchAgent } from "./upstream-agent";
import {
  clearAllCcrContent,
  configureCcrRetention,
  deleteCcrContent,
  getCcrStatus,
  retrieveCcrContent,
} from "./ccr";
import type { RequestUsageTelemetry, ServerOptions } from "./types";

const upstreamFetchAgent = createUpstreamFetchAgent();

export function createServer(customOptions?: Partial<ServerOptions>) {
  const options = resolveServerOptions(customOptions);
  loadExternalCompressors(options.externalCompressorModules);
  configureCcrRetention({
    ttlMs: options.ccrTtlMs,
    maxEntries: options.ccrMaxEntries,
  });
  const recentRequests = loadTelemetry(options.maxRecentRequests);
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

  app.get("/stats/models", (_req, res) => {
    res.json({ models: buildModelTelemetrySummaries(recentRequests) });
  });

  app.get("/stats/config", (_req, res) => {
    if (!authorizeManagementRequest(_req, res)) return;
    res.json({
      optimization: {
        enabled: options.enableOptimization,
        terse_level: options.defaultTerseLevel,
        compression_mode: options.compressionMode,
        assistant_compression: options.compressAssistantTextBlocks,
        user_compression: options.compressUserMessages,
        system_compression: options.compressSystemMessages,
        json_compaction: options.jsonCompaction,
        lossless_compaction: options.losslessCompaction,
        lossless_only: options.losslessOnly,
        strict_accuracy: options.strictAccuracyGuard,
        relevance_split: options.relevanceSplit,
        cross_turn_dedup: options.enableCrossTurnDedup,
        ccr: options.ccrEnabled,
        ccr_inject_marker: options.ccrInjectMarker,
        ccr_min_chars: options.ccrMinChars,
        ccr_ttl_ms: options.ccrTtlMs,
        ccr_max_entries: options.ccrMaxEntries,
        min_tokens: options.minTokensToCompress,
        min_chars: options.minCharsForBlockCompression,
        min_section_tokens: options.minSectionTokens,
        frozen_messages: options.frozenMessageCount,
        protect_recent: options.protectRecentMessages,
        protect_recent_code: options.protectRecentCode,
        protect_errors: options.protectErrorOutputs,
        error_max_chars: options.errorProtectionMaxChars,
        tagged_content: options.compressTaggedContent,
        excluded_tools: options.excludeTools,
        shell_tools: options.bashToolNames,
        external_compressors: options.activeExternalCompressors,
      },
    });
  });

  app.get("/stats/latest", (_req, res) => {
    res.json({ request: recentRequests[recentRequests.length - 1] ?? null });
  });

  app.get("/ccr/retrieve/:id", (req, res) => {
    if (!authorizeManagementRequest(req, res)) return;
    const content = retrieveCcrContent(req.params.id);
    if (content === undefined) {
      res.status(404).json({ error: "CCR content not found" });
      return;
    }
    res.type("text/plain").send(content);
  });

  app.delete("/ccr/retrieve/:id", (req, res) => {
    if (!authorizeManagementRequest(req, res)) return;
    if (!deleteCcrContent(req.params.id)) {
      res.status(404).json({ error: "CCR content not found" });
      return;
    }
    res.status(204).end();
  });

  app.post("/ccr/clear", (_req, res) => {
    if (!authorizeManagementRequest(_req, res)) return;
    clearAllCcrContent();
    res.status(204).end();
  });

  app.get("/ccr/status", (req, res) => {
    if (!authorizeManagementRequest(req, res)) return;
    res.json({ ccr: getCcrStatus() });
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
        output_tokens: null,
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
        const outputCounter = createSseOutputCounter((outputTokens) => {
          telemetry.output_tokens = outputTokens;
          appendTelemetry(telemetry);
          logTelemetry(telemetry);
        });
        upstreamResponse.body.pipe(outputCounter).pipe(res);
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

      let telemetry: RequestUsageTelemetry | undefined;
      if (beforeTokens !== null && transformedTokens !== null) {
        telemetry = buildUsageTelemetry({
          request_id: randomUUID(),
          model: String(body?.model ?? "unknown"),
          before_tokens: beforeTokens,
          after_tokens: transformedTokens,
          saved_tokens: tokenDelta.savedTokens,
          saved_percent: tokenDelta.savedPercent,
          output_tokens: null,
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
        const outputCounter = createSseOutputCounter((outputTokens) => {
          if (!telemetry) {
            return;
          }
          telemetry.output_tokens = outputTokens;
          appendTelemetry(telemetry);
          logTelemetry(telemetry);
        });
        upstreamResponse.body.pipe(outputCounter).pipe(res);
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
    compressUserMessages:
      customOptions?.compressUserMessages ??
      process.env.COPILOT_PARITY_COMPRESS_USER !== "0",
    compressSystemMessages:
      customOptions?.compressSystemMessages ??
      process.env.COPILOT_PARITY_COMPRESS_SYSTEM !== "0",
    compressAssistantTextBlocks:
      customOptions?.compressAssistantTextBlocks ??
      process.env.COPILOT_PARITY_COMPRESS_ASSISTANT === "1",
    minCompressionRatioRelaxed:
      customOptions?.minCompressionRatioRelaxed ??
      parseRatioEnvironment(process.env.COPILOT_PARITY_MIN_RATIO_RELAXED, 1),
    minCompressionRatioAggressive:
      customOptions?.minCompressionRatioAggressive ??
      parseRatioEnvironment(process.env.COPILOT_PARITY_MIN_RATIO_AGGRESSIVE, 1),
    minTokensToCompress:
      customOptions?.minTokensToCompress ??
      parsePositiveEnvironment(process.env.COPILOT_PARITY_MIN_TOKENS, 250),
    minCharsForBlockCompression:
      customOptions?.minCharsForBlockCompression ??
      parsePositiveEnvironment(process.env.COPILOT_PARITY_MIN_CHARS, 500),
    minSectionTokens:
      customOptions?.minSectionTokens ??
      parsePositiveEnvironment(
        process.env.COPILOT_PARITY_MIN_SECTION_TOKENS,
        20,
      ),
    frozenMessageCount:
      customOptions?.frozenMessageCount ??
      parseNonNegativeEnvironment(
        process.env.COPILOT_PARITY_FROZEN_MESSAGES,
        0,
      ),
    protectRecentMessages:
      customOptions?.protectRecentMessages ??
      parseNonNegativeEnvironment(process.env.COPILOT_PARITY_PROTECT_RECENT, 0),
    protectRecentCode:
      customOptions?.protectRecentCode ??
      parseNonNegativeEnvironment(
        process.env.COPILOT_PARITY_PROTECT_RECENT_CODE,
        4,
      ),
    protectErrorOutputs:
      customOptions?.protectErrorOutputs ??
      process.env.COPILOT_PARITY_PROTECT_ERRORS !== "0",
    errorProtectionMaxChars:
      customOptions?.errorProtectionMaxChars ??
      parsePositiveEnvironment(
        process.env.COPILOT_PARITY_ERROR_MAX_CHARS,
        8000,
      ),
    compressTaggedContent:
      customOptions?.compressTaggedContent ??
      process.env.COPILOT_PARITY_COMPRESS_TAGGED === "1",
    excludeTools:
      customOptions?.excludeTools ??
      parseListEnvironment(process.env.COPILOT_PARITY_EXCLUDE_TOOLS),
    losslessCompaction:
      customOptions?.losslessCompaction ??
      process.env.COPILOT_PARITY_LOSSLESS !== "0",
    losslessOnly:
      customOptions?.losslessOnly ??
      process.env.COPILOT_PARITY_LOSSLESS_ONLY === "1",
    compressionMode:
      customOptions?.compressionMode ??
      (process.env.COPILOT_PARITY_COMPRESSION_MODE === "lossless"
        ? "lossless"
        : "lossless_then_lossy"),
    enableCrossTurnDedup:
      customOptions?.enableCrossTurnDedup ??
      process.env.COPILOT_PARITY_CROSS_TURN_DEDUP === "1",
    ccrEnabled:
      customOptions?.ccrEnabled ?? process.env.COPILOT_PARITY_CCR === "1",
    ccrInjectMarker:
      customOptions?.ccrInjectMarker ??
      process.env.COPILOT_PARITY_CCR_INJECT_MARKER !== "0",
    ccrMinChars:
      customOptions?.ccrMinChars ??
      parsePositiveEnvironment(process.env.COPILOT_PARITY_CCR_MIN_CHARS, 10000),
    ccrTtlMs:
      customOptions?.ccrTtlMs ??
      parsePositiveEnvironment(process.env.COPILOT_PARITY_CCR_TTL_MS, 3600000),
    ccrMaxEntries:
      customOptions?.ccrMaxEntries ??
      parsePositiveEnvironment(
        process.env.COPILOT_PARITY_CCR_MAX_ENTRIES,
        1000,
      ),
    relevanceSplit:
      customOptions?.relevanceSplit ??
      process.env.COPILOT_PARITY_RELEVANCE_SPLIT === "1",
    strictAccuracyGuard:
      customOptions?.strictAccuracyGuard ??
      process.env.COPILOT_PARITY_STRICT_ACCURACY === "1",
    protectAnalysisContext:
      customOptions?.protectAnalysisContext ??
      process.env.COPILOT_PARITY_PROTECT_ANALYSIS !== "0",
    codeAwareImportDeduplication:
      customOptions?.codeAwareImportDeduplication ??
      process.env.COPILOT_PARITY_CODE_IMPORT_DEDUP !== "0",
    toolProfiles:
      customOptions?.toolProfiles ??
      parseToolProfiles(process.env.COPILOT_PARITY_TOOL_PROFILES),
    bashToolNames:
      customOptions?.bashToolNames ??
      parseListEnvironment(process.env.COPILOT_PARITY_BASH_TOOLS),
    activeExternalCompressors:
      customOptions?.activeExternalCompressors ??
      parseListEnvironment(process.env.COPILOT_PARITY_EXTERNAL_COMPRESSORS),
    logCompaction:
      customOptions?.logCompaction ??
      process.env.COPILOT_PARITY_LOG_COMPACTION !== "0",
    searchCompaction:
      customOptions?.searchCompaction ??
      process.env.COPILOT_PARITY_SEARCH_COMPACTION !== "0",
    diffCompaction:
      customOptions?.diffCompaction ??
      process.env.COPILOT_PARITY_DIFF_COMPACTION !== "0",
    jsonCompaction:
      customOptions?.jsonCompaction ??
      process.env.COPILOT_PARITY_JSON_COMPACTION !== "0",
    externalCompressorModules:
      customOptions?.externalCompressorModules ??
      parseListEnvironment(
        process.env.COPILOT_PARITY_EXTERNAL_COMPRESSOR_MODULES,
      ),
    defaultTerseLevel:
      customOptions?.defaultTerseLevel ??
      (process.env
        .COPILOT_PARITY_TERSE_MODE as ServerOptions["defaultTerseLevel"]) ??
      "off",
  };
}

function parseRatioEnvironment(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1
    ? parsed
    : fallback;
}

function parsePositiveEnvironment(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeEnvironment(
  value: string | undefined,
  fallback: number,
) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseListEnvironment(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseToolProfiles(value: string | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function authorizeManagementRequest(req: Request, res: express.Response) {
  const expected = process.env.COPILOT_PARITY_MANAGEMENT_TOKEN?.trim();
  if (!expected || req.header("authorization") === `Bearer ${expected}`) {
    return true;
  }
  res.status(401).json({ error: "Management authorization required" });
  return false;
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
  appendTelemetry(telemetry);
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
