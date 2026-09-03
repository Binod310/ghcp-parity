import assert from "node:assert";
import { describe, it } from "mocha";
import { applyTerseMode, resolveTerseLevel } from "../src/terse-mode";

describe("terse mode", () => {
  it("leaves disabled mode unchanged", () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    assert.equal(applyTerseMode("/v1/chat/completions", body, "off"), body);
  });

  it("prepends a full-mode system message to chat completions", () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const transformed = applyTerseMode(
      "/v1/chat/completions",
      body,
      "full",
    ) as { messages: Array<{ role: string; content: string }> };

    assert.equal(transformed.messages[0].role, "system");
    assert.match(transformed.messages[0].content, /negation/);
    assert.deepEqual(transformed.messages[1], body.messages[0]);
  });

  it("adds instructions to Responses and Anthropic requests", () => {
    const responses = applyTerseMode(
      "/v1/responses",
      { input: "Hello" },
      "lite",
    ) as { instructions: string };
    const messages = applyTerseMode(
      "/v1/messages",
      { system: "Existing system", messages: [] },
      "ultra",
    ) as { system: string };

    assert.match(responses.instructions, /Respond concisely/);
    assert.match(messages.system, /Existing system/);
    assert.match(messages.system, /minimum words/);
  });

  it("accepts valid header levels and rejects invalid values", () => {
    assert.equal(resolveTerseLevel("ultra", "off"), "ultra");
    assert.equal(resolveTerseLevel("wenyan-ultra", "off"), "wenyan-ultra");
    assert.equal(resolveTerseLevel("invalid", "full"), "full");
  });

  it("injects Wenyan instructions", () => {
    const transformed = applyTerseMode(
      "/v1/chat/completions",
      { messages: [{ role: "user", content: "Hello" }] },
      "wenyan-full",
    ) as { messages: Array<{ role: string; content: string }> };

    assert.equal(transformed.messages[0].role, "system");
    assert.match(transformed.messages[0].content, /文言/);
  });
});
