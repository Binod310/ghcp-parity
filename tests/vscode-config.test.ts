import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "mocha";
import { configureVSCode, unconfigureVSCode } from "../src/vscode-config";

describe("vscode config", () => {
  it("adds and removes a managed marker block without touching unrelated settings", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-vscode-"));
    const settingsPath = path.join(tempDir, "settings.json");
    const original = [
      "{",
      '  "editor.fontSize": 14,',
      '  "workbench.colorTheme": "Night Owl"',
      "}",
      "",
    ].join("\n");

    fs.writeFileSync(settingsPath, original, "utf8");

    configureVSCode({
      settingsFile: settingsPath,
      port: 8796,
      projectName: "Headroom",
    });

    const configured = fs.readFileSync(settingsPath, "utf8");
    assert.match(configured, /Copilot Parity Proxy/);
    assert.match(configured, /overrideProxyUrl/);
    assert.match(configured, /overrideCapiUrl/);
    assert.match(configured, /chatOverrideProxyUrl/);
    assert.match(configured, /overrideAuthType/);
    assert.match(configured, /\/p\/Headroom/);
    assert.match(configured, /editor\.fontSize/);
    assert.match(configured, /Night Owl/);

    unconfigureVSCode(settingsPath);

    const restored = fs.readFileSync(settingsPath, "utf8");
    assert.equal(restored, original);
  });
});
