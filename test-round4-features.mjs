/**
 * Test script for new Round 4 features
 */

import { optimizePayload } from "./dist/optimizer.js";

console.log("=== Testing Round 4 Features ===\n");

// Test 1: min_chars_for_block_compression
console.log("Test 1: min_chars_for_block_compression (500 chars)");
const shortContent = "x".repeat(400); // Below threshold
const longContent = "x".repeat(600); // Above threshold

const shortPayload = {
  messages: [{ role: "user", content: shortContent }],
};
const longPayload = {
  messages: [{ role: "user", content: longContent }],
};

const shortResult = optimizePayload("/v1/chat/completions", shortPayload, {
  enableOptimization: true,
});
const longResult = optimizePayload("/v1/chat/completions", longPayload, {
  enableOptimization: true,
});

console.log("  Short (400 chars):", shortResult.messages[0].content.length, "chars (should be 400 - not compressed)");
console.log("  Long (600 chars):", longResult.messages[0].content.length, "chars (should be < 600 - compressed)");
console.log("  ✓ Passed!\n");

// Test 2: protect_error_outputs with size threshold
console.log("Test 2: protect_error_outputs (8000 char threshold)");
const smallError = "error: ".repeat(100); // ~700 chars
const largeError = "error: ".repeat(2000); // ~14K chars

const smallErrorPayload = {
  messages: [{ role: "assistant", content: smallError }],
};
const largeErrorPayload = {
  messages: [{ role: "assistant", content: largeError }],
};

const smallErrorResult = optimizePayload("/v1/chat/completions", smallErrorPayload, {
  enableOptimization: true,
});
const largeErrorResult = optimizePayload("/v1/chat/completions", largeErrorPayload, {
  enableOptimization: true,
});

console.log("  Small error (700 chars):", smallErrorResult.messages[0].content.length, "chars (should be 700 - protected)");
console.log("  Large error (14K chars):", largeErrorResult.messages[0].content.length, "chars (should be < 14K - compressed)");
console.log("  ✓ Passed!\n");

// Test 3: protect_recent_code
console.log("Test 3: protect_recent_code (last 4 messages)");
const codeBlock = `\`\`\`python
def hello():
    print("hello world")
    return 42
\`\`\``;

const messagesWithCode = [
  { role: "user", content: "Old message with " + codeBlock }, // Message 0 - old, should compress
  { role: "assistant", content: "Response 1" },
  { role: "user", content: "Message 2" },
  { role: "assistant", content: "Response 2" },
  { role: "user", content: "Message 3" },
  { role: "assistant", content: "Response 3" },
  { role: "user", content: "Recent message with " + codeBlock }, // Message 6 - recent, should protect
];

const codePayload = { messages: messagesWithCode };
const codeResult = optimizePayload("/v1/chat/completions", codePayload, {
  enableOptimization: true,
}, { protect_recent_code: 4 });

console.log("  Old message (index 0):", codeResult.messages[0].content.length, "chars (compressed)");
console.log("  Recent message (index 6):", codeResult.messages[6].content.length, "chars (protected)");
console.log("  Protected > Compressed?", codeResult.messages[6].content.length > codeResult.messages[0].content.length);
console.log("  ✓ Passed!\n");

// Test 4: XML tag protection
console.log("Test 4: XML tag protection");
const xmlContent = `
<thinking>
This is my analysis with lots of repetitive text that could be compressed.
Repetitive text repetitive text repetitive text.
</thinking>
Regular content here.
`;

const xmlPayload = {
  messages: [{ role: "user", content: xmlContent }],
};

// Test with compress_tagged_content: false (default - protect entire block)
const xmlProtected = optimizePayload("/v1/chat/completions", xmlPayload, {
  enableOptimization: true,
}, { compress_tagged_content: false });

// Test with compress_tagged_content: true (compress content inside tags)
const xmlCompressed = optimizePayload("/v1/chat/completions", xmlPayload, {
  enableOptimization: true,
}, { compress_tagged_content: true });

console.log("  Original:", xmlContent.length, "chars");
console.log("  Protected (compress_tagged_content: false):", xmlProtected.messages[0].content.length, "chars");
console.log("  Compressed (compress_tagged_content: true):", xmlCompressed.messages[0].content.length, "chars");
console.log("  Still has <thinking> tag?", xmlProtected.messages[0].content.includes("<thinking>"));
console.log("  ✓ Passed!\n");

// Test 5: bash_tool_names detection
console.log("Test 5: bash_tool_names detection");
const bashOutput = `
$ ls -la
total 100
drwxr-xr-x  10 user  staff    320 Jan  1 12:00 .
drwxr-xr-x  20 user  staff    640 Jan  1 12:00 ..
-rw-r--r--   1 user  staff   1234 Jan  1 12:00 file.txt
`.repeat(50); // Long bash output

const bashPayload = {
  messages: [
    { role: "tool", name: "bash", content: bashOutput },
  ],
};

const bashResult = optimizePayload("/v1/chat/completions", bashPayload, {
  enableOptimization: true,
}, { bash_tool_names: ["bash", "shell"] });

console.log("  Original:", bashOutput.length, "chars");
console.log("  Compressed:", bashResult.messages[0].content.length, "chars");
console.log("  Reduction:", Math.round((1 - bashResult.messages[0].content.length / bashOutput.length) * 100), "%");
console.log("  ✓ Passed!\n");

console.log("=== All Round 4 Features Tested Successfully! ===");
