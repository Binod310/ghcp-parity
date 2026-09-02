import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MARKER_START = "// --- Copilot Parity Proxy ---";
const MARKER_END = "// --- end Copilot Parity Proxy ---";
const PROXY_KEY = "github.copilot.advanced.debug.overrideProxyUrl";
const CAPI_KEY = "github.copilot.advanced.debug.overrideCapiUrl";
const CHAT_PROXY_KEY = "github.copilot.advanced.chatOverrideProxyUrl";
// Detect stale copies but do not write an unsupported setting.
const AUTH_KEY = "github.copilot.advanced.debug.overrideAuthType";

interface VSCodeConfigOptions {
  settingsFile?: string;
  port: number;
  projectName?: string;
  noConfigure?: boolean;
}

export function getDefaultSettingsPath(): string {
  const platform = process.platform;
  const homeDir = os.homedir();

  if (platform === "darwin") {
    return path.join(
      homeDir,
      "Library",
      "Application Support",
      "Code",
      "User",
      "settings.json",
    );
  }
  if (platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, "Code", "User", "settings.json");
  }
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return path.join(configHome, "Code", "User", "settings.json");
}

function settingsPathOrDefault(settingsFile?: string): string {
  return settingsFile || getDefaultSettingsPath();
}

function vscodeProxyUrl(port: number, projectName?: string): string {
  const baseUrl = `http://127.0.0.1:${port}`;
  return projectName ? `${baseUrl}/p/${projectName}` : baseUrl;
}

function readSettings(pathname: string): string {
  return fs.existsSync(pathname) ? fs.readFileSync(pathname, "utf8") : "{}\n";
}

function stripJsoncComments(value: string): string {
  const result: string[] = [];
  let index = 0;
  let inString = false;
  let escaped = false;

  while (index < value.length) {
    const char = value[index];
    if (inString) {
      result.push(char);
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      result.push(char);
      index += 1;
      continue;
    }

    if (value.startsWith("//", index)) {
      const newline = value.indexOf("\n", index);
      if (newline < 0) {
        break;
      }
      result.push("\n");
      index = newline + 1;
      continue;
    }

    if (value.startsWith("/*", index)) {
      const end = value.indexOf("*/", index + 2);
      if (end < 0) {
        throw new Error(
          "VS Code settings contain an unterminated block comment.",
        );
      }
      for (const segment of value.slice(index, end + 2)) {
        if (segment === "\n") {
          result.push("\n");
        }
      }
      index = end + 2;
      continue;
    }

    result.push(char);
    index += 1;
  }

  return result.join("");
}

function validateSettings(raw: string, pathname: string): void {
  let candidate = stripJsoncComments(raw);
  candidate = candidate.replace(/,\s*([}\]])/g, "$1");
  if (candidate.startsWith("\ufeff")) {
    candidate = candidate.slice(1);
  }
  try {
    const parsed = JSON.parse(candidate);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not safely parse ${pathname}: ${message}. Refusing to edit it.`,
    );
  }
}

function managedBlock(
  proxyUrl: string,
  ownsPrecedingComma: boolean,
  lineSep: string,
): string {
  const marker = `${MARKER_START}${ownsPrecedingComma ? " (comma-added)" : ""}`;
  return [
    `\t${marker}`,
    `\t${JSON.stringify(PROXY_KEY)}: ${JSON.stringify(proxyUrl)},`,
    `\t${JSON.stringify(CAPI_KEY)}: ${JSON.stringify(proxyUrl)},`,
    `\t${JSON.stringify(CHAT_PROXY_KEY)}: ${JSON.stringify(proxyUrl)}`,
    `\t${MARKER_END}`,
  ].join(lineSep);
}

function removeManagedBlock(raw: string): string {
  const startCount = (
    raw.match(
      new RegExp(MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    ) || []
  ).length;
  const endCount = (
    raw.match(
      new RegExp(MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    ) || []
  ).length;
  const start = raw.indexOf(MARKER_START);
  const end = raw.indexOf(MARKER_END);
  if (startCount !== 1 || endCount !== 1 || start < 0 || end < start) {
    throw new Error(
      "Incomplete Copilot Parity marker block; refusing to edit.....",
    );
  }
  const lineStart = raw.lastIndexOf("\n", start) + 1;
  const lineEndIndex = raw.indexOf("\n", end);
  const lineEnd = lineEndIndex < 0 ? raw.length : lineEndIndex + 1;
  const prefix = raw.slice(0, lineStart);
  const suffix = raw.slice(lineEnd);
  const markerLine = raw.slice(
    lineStart,
    raw.indexOf("\n", start) < 0 ? raw.length : raw.indexOf("\n", start),
  );
  const separator =
    prefix.endsWith("\n") || prefix.endsWith("\r")
      ? ""
      : raw.includes("\r\n")
        ? "\r\n"
        : "\n";

  if (markerLine.includes("(comma-added)") && prefix.trimEnd().endsWith(",")) {
    const commaIndex = prefix.lastIndexOf(",");
    return `${prefix.slice(0, commaIndex)}${separator}${suffix}`;
  }

  return `${prefix}${separator}${suffix}`;
}

function hasUnmanagedOverride(raw: string): boolean {
  if (raw.includes(MARKER_START) || raw.includes(MARKER_END)) {
    return false;
  }
  return (
    raw.includes(PROXY_KEY) ||
    raw.includes(CAPI_KEY) ||
    raw.includes(CHAT_PROXY_KEY) ||
    raw.includes(AUTH_KEY)
  );
}

export function configureVSCode(options: VSCodeConfigOptions): void {
  const settingsPath = settingsPathOrDefault(options.settingsFile);
  const proxyUrl = vscodeProxyUrl(options.port, options.projectName);

  if (options.noConfigure) {
    console.log("\nAdd these settings to your VS Code User settings:\n");
    console.log(`\t${MARKER_START}`);
    console.log(`\t${JSON.stringify(PROXY_KEY)}: ${JSON.stringify(proxyUrl)},`);
    console.log(`\t${JSON.stringify(CAPI_KEY)}: ${JSON.stringify(proxyUrl)},`);
    console.log(
      `\t${JSON.stringify(CHAT_PROXY_KEY)}: ${JSON.stringify(proxyUrl)},`,
    );
    console.log(`\t${MARKER_END}`);
    console.log(`\nSettings file location: ${settingsPath}\n`);
    return;
  }

  const raw = readSettings(settingsPath);
  validateSettings(raw, settingsPath);
  if (hasUnmanagedOverride(raw)) {
    throw new Error(
      `${settingsPath} already configures a Copilot proxy override outside the managed block. Remove it manually or use --no-configure.`,
    );
  }

  const hadManagedBlock =
    raw.includes(MARKER_START) && raw.includes(MARKER_END);
  const cleaned = hadManagedBlock ? removeManagedBlock(raw) : raw;
  const close = cleaned.lastIndexOf("}");
  if (close < 0) {
    throw new Error(`Could not locate the root object in ${settingsPath}.`);
  }

  const before = cleaned.slice(0, close).trimEnd();
  const after = cleaned.slice(close);
  const lineSep = cleaned.includes("\r\n") ? "\r\n" : "\n";
  const inner = stripJsoncComments(before).trimEnd();
  const needsComma = !inner.endsWith("{") && !inner.endsWith(",");
  const newline = before.endsWith("\n") || before.endsWith("\r") ? "" : lineSep;
  const updated = `${before}${needsComma ? "," : ""}${newline}${managedBlock(proxyUrl, needsComma, lineSep)}${lineSep}${after}`;

  validateSettings(updated, settingsPath);
  fs.writeFileSync(settingsPath, updated, "utf8");
  console.log(`✓ VS Code settings configured`);
  console.log(`  Settings file: ${settingsPath}`);
  console.log(`  Proxy URL: ${proxyUrl}`);
  console.log(`\n⚠️  Please restart VS Code for changes to take effect.\n`);
}

export function unconfigureVSCode(settingsFile?: string): void {
  const settingsPath = settingsPathOrDefault(settingsFile);

  if (!fs.existsSync(settingsPath)) {
    console.log(`Settings file not found: ${settingsPath}`);
    return;
  }

  const raw = fs.readFileSync(settingsPath, "utf8");
  if (!raw.includes(MARKER_START) || !raw.includes(MARKER_END)) {
    console.log("No managed proxy configuration found in settings.");
    return;
  }

  let updated = removeManagedBlock(raw);
  const closingBrace = updated.lastIndexOf("}");
  if (
    closingBrace > 0 &&
    updated[closingBrace - 1] !== "\n" &&
    updated[closingBrace - 1] !== "\r"
  ) {
    const lineSep = updated.includes("\r\n") ? "\r\n" : "\n";
    updated = `${updated.slice(0, closingBrace)}${lineSep}${updated.slice(closingBrace)}`;
  }
  validateSettings(updated, settingsPath);
  fs.writeFileSync(settingsPath, updated, "utf8");
  console.log(`✓ Proxy configuration removed`);
  console.log(`  Settings file: ${settingsPath}`);
  console.log(`\n⚠️  Please restart VS Code for changes to take effect.\n`);
}
