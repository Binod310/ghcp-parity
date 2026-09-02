import assert from "node:assert";
import { describe, it } from "mocha";
import { optimizePayload } from "../src/optimizer";

describe("optimizer", () => {
  it("compacts chat message text", () => {
    const input = {
      model: "claude-sonnet-4.6",
      messages: [
        {
          role: "user",
          content: "Hello    there\n\n\nThis   is   a   test.  ",
        },
      ],
    };

    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
    }) as any;

    assert.equal(
      optimized.messages[0].content,
      "Hello there\n\nThis is a test.",
    );
  });

  it("keeps payload unchanged when optimization is disabled", () => {
    const input = {
      input: "Hello    there",
    };

    const optimized = optimizePayload("/v1/responses", input, {
      enableOptimization: false,
    });

    assert.deepEqual(optimized, input);
  });

  it("compacts anthropic messages content blocks", () => {
    const input = {
      model: "claude-sonnet-4.6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Line one.\n\n\nLine    two with    spaces.  ",
            },
          ],
        },
      ],
    };

    const optimized = optimizePayload("/v1/messages", input, {
      enableOptimization: true,
    }) as any;

    assert.equal(
      optimized.messages[0].content[0].text,
      "Line one.\n\nLine two with spaces.",
    );
  });
});
