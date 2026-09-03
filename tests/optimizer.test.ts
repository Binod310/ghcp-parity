import assert from "node:assert";
import { describe, it } from "mocha";
import {
  loadExternalCompressors,
  optimizePayload,
  registerExternalCompressor,
} from "../src/optimizer";
import {
  clearCcrContent,
  configureCcrRetention,
  deleteCcrContent,
  retrieveCcrContent,
  storeCcrContent,
} from "../src/ccr";

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

  it("removes only exact duplicate tool schemas", () => {
    const weatherTool = {
      type: "function",
      function: {
        name: "weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    };
    const input = {
      messages: [],
      tools: [
        weatherTool,
        {
          ...weatherTool,
          function: {
            ...weatherTool.function,
            parameters: {
              properties: { city: { type: "string" } },
              type: "object",
            },
          },
        },
        {
          type: "function",
          function: { name: "forecast", parameters: { type: "object" } },
        },
      ],
    };

    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
    }) as { tools: unknown[] };

    assert.equal(optimized.tools.length, 2);
    assert.equal((optimized.tools[0] as any).function.name, "weather");
    assert.equal((optimized.tools[1] as any).function.name, "forecast");
  });

  it("preserves duplicate schemas when optimization is disabled", () => {
    const input = { tools: [{ name: "same" }, { name: "same" }] };
    const optimized = optimizePayload("/v1/responses", input, {
      enableOptimization: false,
    }) as { tools: unknown[] };

    assert.equal(optimized.tools.length, 2);
  });

  it("preserves cache-anchored message prefixes byte-for-byte", () => {
    const anchored = "ERROR:   exact    cached   spacing\n".repeat(200);
    const mutable = "INFO:   repeated    mutable   data\n".repeat(200);
    const input = {
      messages: [
        {
          role: "user",
          content: anchored,
          cache_control: { type: "ephemeral" },
        },
        { role: "user", content: mutable },
      ],
    };

    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
    }) as { messages: Array<{ content: string }> };

    assert.equal(optimized.messages[0].content, anchored);
    assert.ok(optimized.messages[1].content.length < mutable.length);
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

  it("compresses assistant text only when explicitly enabled", () => {
    const repeated = "Repeated assistant output.\n".repeat(300);
    const input = {
      messages: [
        { role: "assistant", content: repeated },
        { role: "user", content: "Continue" },
      ],
    };

    const unchanged = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      compressAssistantTextBlocks: false,
    }) as any;
    const compressed = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      compressAssistantTextBlocks: true,
    }) as any;

    assert.equal(unchanged.messages[0].content, repeated);
    assert.ok(compressed.messages[0].content.length < repeated.length);
  });

  it("rejects marginal compression at a stricter ratio threshold", () => {
    const input = {
      messages: [
        {
          role: "user",
          content: "Repeated line.\n".repeat(300),
        },
        { role: "user", content: "Continue" },
      ],
    };

    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minCompressionRatioRelaxed: 0.01,
    }) as any;

    assert.equal(optimized.messages[0].content, input.messages[0].content);
  });

  it("preserves sections below the section token threshold", () => {
    const smallSection = "Keep    this   section unchanged.";
    const largeSection = "Compress    this   repeated section.\n".repeat(80);
    const input = {
      messages: [
        { role: "user", content: `${smallSection}\n\n${largeSection}` },
        { role: "user", content: "Continue" },
      ],
    };

    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
    }) as any;

    assert.match(
      optimized.messages[0].content,
      /Keep    this   section unchanged\./,
    );
    assert.ok(!optimized.messages[0].content.includes("Compress    this"));
  });

  it("accepts runtime minimum compression thresholds", () => {
    const input = {
      messages: [
        { role: "user", content: "A    repeated line.\n".repeat(100) },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
    }) as any;

    assert.ok(
      optimized.messages[0].content.length < input.messages[0].content.length,
    );
  });

  it("protects configured frozen and recent messages", () => {
    const repeated = "Protected    message.\n".repeat(100);
    const input = {
      messages: [
        { role: "user", content: repeated },
        { role: "user", content: repeated },
        { role: "user", content: repeated },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      frozenMessageCount: 1,
      protectRecentMessages: 1,
    }) as any;

    assert.equal(optimized.messages[0].content, repeated);
    assert.ok(optimized.messages[1].content.length < repeated.length);
    assert.equal(optimized.messages[2].content, repeated);
  });

  it("protects source code in configured recent messages", () => {
    const code = "const value = 1;\n".repeat(100);
    const input = {
      messages: [
        { role: "user", content: "Continue" },
        { role: "user", content: code },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 1,
    }) as any;

    assert.equal(optimized.messages[1].content, code);
  });

  it("preserves small errors and compresses them when protection is disabled", () => {
    const error = "ERROR:   failed   operation.\n".repeat(40);
    const input = {
      messages: [
        { role: "user", content: error },
        { role: "user", content: "Continue" },
      ],
    };
    const protectedResult = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectErrorOutputs: true,
      errorProtectionMaxChars: 8000,
    }) as any;
    const unprotectedResult = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectErrorOutputs: false,
    }) as any;

    assert.equal(protectedResult.messages[0].content, error);
    assert.ok(unprotectedResult.messages[0].content.length < error.length);
  });

  it("preserves XML-tagged content by default and compresses opt-in content", () => {
    const tagged =
      "<context>" +
      "Repeated    tagged   content.\n".repeat(100) +
      "</context>";
    const input = {
      messages: [
        { role: "user", content: tagged },
        { role: "user", content: "Continue" },
      ],
    };
    const protectedResult = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      compressTaggedContent: false,
      protectRecentCode: 0,
    }) as any;
    const compressedResult = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      compressTaggedContent: true,
      protectRecentCode: 0,
    }) as any;

    assert.equal(protectedResult.messages[0].content, tagged);
    assert.ok(compressedResult.messages[0].content.length < tagged.length);
    assert.match(compressedResult.messages[0].content, /^<context>/);
    assert.match(compressedResult.messages[0].content, /<\/context>$/);
  });

  it("preserves custom excluded tool output", () => {
    const output = "Custom    tool   output.\n".repeat(100);
    const input = {
      messages: [
        {
          role: "tool",
          name: "database_snapshot",
          content: output,
        },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      excludeTools: ["database_snapshot"],
    }) as any;

    assert.equal(optimized.messages[0].content, output);
  });

  it("supports disabling user and system role compression", () => {
    const repeated = "Role    content.\n".repeat(100);
    const input = {
      messages: [
        { role: "system", content: repeated },
        { role: "user", content: repeated },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      compressUserMessages: false,
      compressSystemMessages: false,
    }) as any;

    assert.equal(optimized.messages[0].content, repeated);
    assert.equal(optimized.messages[1].content, repeated);
  });

  it("supports disabling lossless log compaction", () => {
    const log =
      "\u001b[31mERROR\u001b[0m 2026-09-03 repeated output line\n".repeat(100);
    const input = {
      messages: [
        { role: "user", content: log },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      losslessCompaction: false,
    }) as any;

    assert.match(optimized.messages[0].content, /\u001b\[31mERROR\u001b\[0m/);
  });

  it("supports lossless-only mode", () => {
    const log = Array.from(
      { length: 100 },
      (_, index) => `\u001b[31mINFO\u001b[0m unique log line ${index}\n`,
    ).join("");
    const input = {
      messages: [
        { role: "user", content: log },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload(
      "/v1/chat/completions",
      input,
      {
        enableOptimization: true,
        minTokensToCompress: 1,
        minCharsForBlockCompression: 1,
        minSectionTokens: 1,
        protectRecentCode: 0,
        protectErrorOutputs: false,
      },
      { lossless_only: true },
    ) as any;

    assert.ok(optimized.messages[0].content.length < log.length);
    assert.ok(!optimized.messages[0].content.includes("\u001b[31m"));
  });

  it("creates a retrievable CCR marker only when enabled", () => {
    clearCcrContent();
    const content = "CCR original content.\n".repeat(600);
    const input = {
      messages: [
        { role: "user", content },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      ccrEnabled: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
    }) as any;
    const marker = optimized.messages[0].content as string;
    const id = marker.match(/\[CCR:(ccr_\d+)\]/)?.[1];

    assert.ok(id);
    assert.equal(retrieveCcrContent(id), content);
  });

  it("supports a custom CCR activation threshold", () => {
    clearCcrContent();
    const content = "Short CCR threshold content.\n".repeat(20);
    const optimized = optimizePayload(
      "/v1/chat/completions",
      {
        messages: [
          { role: "user", content },
          { role: "user", content: "Continue" },
        ],
      },
      {
        enableOptimization: true,
        ccrEnabled: true,
        ccrMinChars: 100,
        minTokensToCompress: 1,
        minCharsForBlockCompression: 1,
        minSectionTokens: 1,
        protectRecentCode: 0,
      },
    ) as any;

    assert.match(optimized.messages[0].content, /\[CCR:ccr_\d+\]/);
  });

  it("supports disabling CCR marker injection", () => {
    clearCcrContent();
    const content = "CCR marker-disabled content.\n".repeat(600);
    const optimized = optimizePayload(
      "/v1/chat/completions",
      {
        messages: [
          { role: "user", content },
          { role: "user", content: "Continue" },
        ],
      },
      {
        enableOptimization: true,
        ccrEnabled: true,
        ccrInjectMarker: false,
        ccrMinChars: 100,
        minTokensToCompress: 1,
        minCharsForBlockCompression: 1,
        minSectionTokens: 1,
        protectRecentCode: 0,
      },
    ) as any;

    assert.ok(!optimized.messages[0].content.includes("[CCR:"));
    assert.ok(optimized.messages[0].content.length < content.length);
  });

  it("evicts oldest CCR entries at configured capacity", () => {
    clearCcrContent();
    configureCcrRetention({ ttlMs: 60000, maxEntries: 1 });
    const firstId = storeCcrContent("first");
    const secondId = storeCcrContent("second");
    assert.equal(retrieveCcrContent(firstId), undefined);
    assert.equal(retrieveCcrContent(secondId), "second");
    configureCcrRetention({ ttlMs: 3600000, maxEntries: 1000 });
  });

  it("deletes individual CCR entries", () => {
    clearCcrContent();
    const id = storeCcrContent("delete me");
    assert.equal(deleteCcrContent(id), true);
    assert.equal(retrieveCcrContent(id), undefined);
    assert.equal(deleteCcrContent(id), false);
  });

  it("supports explicit lossless compression mode", () => {
    const input = {
      messages: [
        {
          role: "user",
          content: Array.from(
            { length: 10 },
            (_, index) => `\u001b[31mINFO\u001b[0m unique line ${index}\n`,
          ).join(""),
        },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      compressionMode: "lossless",
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
    }) as any;

    assert.ok(!optimized.messages[0].content.includes("\u001b[31m"));
  });

  it("requires meaningful savings in strict accuracy mode", () => {
    const content = Array.from(
      { length: 100 },
      (_, index) =>
        `Unique line ${index} with    spacing and distinct value ${index}.`,
    ).join("\n");
    const input = {
      messages: [
        { role: "user", content },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      strictAccuracyGuard: true,
    }) as any;

    assert.equal(optimized.messages[0].content, content);
  });

  it("supports disabling code-aware import deduplication", () => {
    const code = `import { value } from "./value";\nimport { value } from "./value";\n${"const output = value;\n".repeat(100)}`;
    const input = {
      messages: [
        { role: "user", content: code },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      codeAwareImportDeduplication: false,
      losslessCompaction: false,
    }) as any;

    const importCount = (
      optimized.messages[0].content.match(
        /import \{value\} from "\.\/value";/g,
      ) ?? []
    ).length;
    assert.equal(importCount, 2);
  });

  it("applies case-insensitive per-tool compression profiles", () => {
    const output = "Profile    protected   output.\n".repeat(100);
    const input = {
      messages: [
        {
          role: "tool",
          name: "Database_Snapshot",
          content: output,
        },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      toolProfiles: {
        database_snapshot: { lossless_compaction: false },
      },
      losslessCompaction: true,
    }) as any;

    assert.match(optimized.messages[0].content, /Profile protected output\./);
  });

  it("protects code for analysis prompts when enabled", () => {
    const code = "const value = 1;\n".repeat(100);
    const input = {
      messages: [
        { role: "user", content: code },
        { role: "user", content: "Review this code for bugs." },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      protectAnalysisContext: true,
    }) as any;

    assert.equal(optimized.messages[0].content, code);
  });

  it("accepts custom shell-tool names", () => {
    const output = "INFO 2026-09-03 custom shell output line\n".repeat(100);
    const input = {
      messages: [
        {
          role: "tool",
          name: "terminal_exec",
          content: output,
        },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      bashToolNames: ["terminal_exec"],
    }) as any;

    assert.ok(optimized.messages[0].content.length < output.length);
  });

  it("deduplicates repeated long content only when enabled", () => {
    const repeated = "Repeated context block.\n".repeat(40);
    const input = {
      messages: [
        { role: "user", content: repeated },
        { role: "user", content: repeated },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      enableCrossTurnDedup: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      losslessCompaction: false,
    }) as any;

    assert.match(
      optimized.messages[1].content,
      /Repeated content appears earlier/,
    );
  });

  it("preserves relevant sections when relevance splitting is enabled", () => {
    const relevant = "Database connection pooling configuration.\n".repeat(30);
    const unrelated = "Unrelated deployment history details.\n".repeat(30);
    const input = {
      messages: [
        { role: "user", content: `${relevant}\n\n${unrelated}` },
        { role: "user", content: "Explain database pooling." },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      relevanceSplit: true,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      losslessCompaction: false,
    }) as any;

    assert.match(optimized.messages[0].content, /Database connection pooling/);
    assert.ok(
      optimized.messages[0].content.length < input.messages[0].content.length,
    );
  });

  it("deduplicates repeated Responses input items", () => {
    const repeated = "Responses repeated context.\n".repeat(40);
    const optimized = optimizePayload(
      "/v1/responses",
      { input: [{ text: repeated }, { text: repeated }] },
      {
        enableOptimization: true,
        enableCrossTurnDedup: true,
        minTokensToCompress: 1,
        minCharsForBlockCompression: 1,
        minSectionTokens: 1,
      },
    ) as any;

    assert.match(optimized.input[1].text, /Repeated content appears earlier/);
  });

  it("runs active external compressors shrink-only and isolates failures", () => {
    registerExternalCompressor("test_shrink", (text) => text.replace(/ /g, ""));
    registerExternalCompressor("test_throw", () => {
      throw new Error("plugin failure");
    });
    const input = {
      messages: [
        { role: "user", content: "External plugin content.\n".repeat(30) },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      activeExternalCompressors: ["test_shrink", "test_throw"],
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      losslessCompaction: false,
    }) as any;

    assert.ok(
      optimized.messages[0].content.length < input.messages[0].content.length,
    );
  });

  it("preserves relevant Responses sections", () => {
    const relevant = "Database pooling details.\n".repeat(30);
    const unrelated = "Unrelated release notes.\n".repeat(30);
    const optimized = optimizePayload(
      "/v1/responses",
      {
        input: [
          { text: `${relevant}\n\n${unrelated}` },
          { role: "user", content: "Explain database pooling." },
        ],
      },
      {
        enableOptimization: true,
        relevanceSplit: true,
        minTokensToCompress: 1,
        minCharsForBlockCompression: 1,
        minSectionTokens: 1,
      },
    ) as any;

    assert.match(optimized.input[0].text, /Database pooling details/);
    assert.ok(
      optimized.input[0].text.length < (relevant + "\n\n" + unrelated).length,
    );
  });

  it("loads external compressor modules by explicit path", () => {
    const loaded = loadExternalCompressors([
      require.resolve("./fixtures/external-compressor.cjs"),
      "/missing/external-compressor.cjs",
    ]);
    assert.deepEqual(loaded, ["fixture_shrink"]);
  });

  it("supports disabling JSON text compaction", () => {
    const jsonText = `Payload: [{"id":1,"name":"alpha"},{"id":2,"name":"beta"}]`;
    const input = {
      messages: [
        { role: "user", content: jsonText },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      jsonCompaction: false,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
      losslessCompaction: false,
    }) as any;

    assert.equal(optimized.messages[0].content, jsonText);
  });

  it("supports independent diff compaction control", () => {
    const diff =
      "diff --git a/file b/file\nindex 123..456 100644\n" +
      "@@ -1 +1 @@\n" +
      "-old\n+new\n";
    const input = {
      messages: [
        { role: "user", content: diff },
        { role: "user", content: "Continue" },
      ],
    };
    const optimized = optimizePayload("/v1/chat/completions", input, {
      enableOptimization: true,
      diffCompaction: false,
      minTokensToCompress: 1,
      minCharsForBlockCompression: 1,
      minSectionTokens: 1,
      protectRecentCode: 0,
    }) as any;

    assert.match(optimized.messages[0].content, /index 123\.\.456 100644/);
  });
});
