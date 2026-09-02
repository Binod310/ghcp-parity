import assert from "node:assert";
import { describe, it } from "mocha";
import {
  buildTelemetrySummary,
  buildUsageTelemetry,
  computeSavedTokens,
  parseUpstreamUsage,
} from "../src/telemetry";

describe("usage telemetry schema", () => {
  it("accepts null AIU values", () => {
    const telemetry = buildUsageTelemetry({
      request_id: "req-1",
      model: "gpt-4.1",
      before_tokens: 120,
      after_tokens: 100,
      saved_tokens: 20,
      saved_percent: 16.67,
      aiu_before: null,
      aiu_after: null,
      aiu_saved: null,
      timestamp: new Date().toISOString(),
      route: "/v1/responses",
      status: 200,
      measurement: "provider",
    });

    assert.equal(telemetry.saved_tokens, 20);
    assert.equal(telemetry.aiu_before, null);
  });

  it("extracts usage and copilot aiu from upstream body", () => {
    const usage = parseUpstreamUsage({
      usage: {
        input_tokens: 111,
        output_tokens: 22,
        total_tokens: 133,
      },
      copilot_usage: {
        total_nano_aiu: 9001,
      },
    });

    assert.equal(usage.input_tokens, 111);
    assert.equal(usage.output_tokens, 22);
    assert.equal(usage.total_tokens, 133);
    assert.equal(usage.total_nano_aiu, 9001);
  });

  it("computes saved tokens and percentage", () => {
    const delta = computeSavedTokens(200, 150);
    assert.equal(delta.savedTokens, 50);
    assert.equal(delta.savedPercent, 25);
  });

  it("builds telemetry summary aggregates", () => {
    const summary = buildTelemetrySummary([
      {
        request_id: "r1",
        model: "gpt-4.1",
        before_tokens: 100,
        after_tokens: 80,
        saved_tokens: 20,
        saved_percent: 20,
        aiu_before: 1000,
        aiu_after: 800,
        aiu_saved: 200,
        timestamp: new Date().toISOString(),
        route: "/v1/responses",
        status: 200,
        measurement: "provider",
      },
      {
        request_id: "r2",
        model: "gpt-4.1",
        before_tokens: 50,
        after_tokens: 50,
        saved_tokens: 0,
        saved_percent: 0,
        aiu_before: null,
        aiu_after: null,
        aiu_saved: null,
        timestamp: new Date().toISOString(),
        route: "/v1/responses",
        status: 500,
        measurement: "estimated",
      },
    ]);

    assert.equal(summary.request_count, 2);
    assert.equal(summary.success_count, 1);
    assert.equal(summary.error_count, 1);
    assert.equal(summary.total_before_tokens, 150);
    assert.equal(summary.total_after_tokens, 130);
    assert.equal(summary.total_saved_tokens, 20);
    assert.equal(summary.average_saved_percent, 10);
    assert.equal(summary.total_aiu_after, 800);
  });
});
