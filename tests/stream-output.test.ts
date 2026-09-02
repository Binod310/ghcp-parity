import assert from "node:assert";
import { describe, it } from "mocha";
import {
  createSseOutputCounter,
  estimateOutputTokens,
} from "../src/stream-output";

describe("stream output", () => {
  it("counts OpenAI SSE text without changing stream bytes", (done) => {
    let counted = 0;
    const counter = createSseOutputCounter((tokens) => {
      counted = tokens;
    });
    let relayed = "";
    counter.on("data", (chunk) => {
      relayed += chunk.toString();
    });
    counter.on("end", () => {
      assert.equal(
        relayed,
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      );
      assert.equal(counted, estimateOutputTokens("Hello world"));
      done();
    });
    counter.end(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    );
  });

  it("handles split UTF-8 chunks and ignores done events", (done) => {
    let counted = 0;
    const counter = createSseOutputCounter((tokens) => {
      counted = tokens;
    });
    counter.on("end", () => {
      assert.equal(counted, estimateOutputTokens("done"));
      done();
    });
    counter.resume();
    counter.write('data: {"delta":"do');
    counter.end('ne"}\n\ndata: [DONE]\n\n');
  });
});
