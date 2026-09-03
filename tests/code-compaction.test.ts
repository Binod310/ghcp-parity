import assert from "node:assert";
import { describe, it } from "mocha";
import { compactDuplicateImports } from "../src/code-compaction";
import { foldRepeatedParagraphs } from "../src/lossless-compaction";

describe("code compaction", () => {
  it("removes exact duplicate bound imports", () => {
    const source = [
      'import { join } from "node:path";',
      'import { readFile } from "node:fs";',
      'import { join } from "node:path";',
      "export const file = join('a', 'b');",
      "",
    ].join("\n");

    const compacted = compactDuplicateImports(source);
    assert.equal((compacted.match(/import \{ join \}/g) ?? []).length, 1);
    assert.match(compacted, /readFile/);
    assert.match(compacted, /export const file/);
  });

  it("preserves side-effect imports and distinct imports", () => {
    const source = [
      'import "./setup";',
      'import "./setup";',
      'import { a } from "./module";',
      'import { b } from "./module";',
      "",
    ].join("\n");

    assert.equal(compactDuplicateImports(source), source);
  });

  it("folds only identical long paragraphs with an explicit reference", () => {
    const paragraph = "Repeated operational detail. ".repeat(20);
    const input = `${paragraph}\n\nUnique conclusion.\n\n${paragraph}`;
    const compacted = foldRepeatedParagraphs(input);

    assert.match(compacted, /identical to paragraph 1/);
    assert.match(compacted, /Unique conclusion/);
    assert.ok(compacted.length < input.length);
  });
});
