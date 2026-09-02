#!/usr/bin/env node
import { Command } from "commander";
import {
  clearStoredAuth,
  exchangeOAuthForCopilotApiToken,
  getAuthStatusView,
  importFromHeadroom,
  pollDeviceAuthorization,
  readStoredAuth,
  refreshStoredCopilotApiToken,
  startDeviceAuthorization,
  writeStoredAuth,
} from "./auth";
import * as http from "node:http";
import { createServer } from "./server";
import { configureVSCode, unconfigureVSCode } from "./vscode-config";

const program = new Command();

program
  .name("copilot-parity")
  .description("Standalone local Copilot-compatible proxy");

program
  .command("proxy")
  .description("Start local proxy")
  .option("-p, --port <port>", "port to bind", "8792")
  .action((options) => {
    const port = Number(options.port);
    const app = createServer();
    const httpServer = app.listen(port, "127.0.0.1", () => {
      process.stdout.write(
        `copilot-parity-local listening on 127.0.0.1:${port}\n`,
      );
    }) as http.Server;
  });

program
  .command("copilot-auth")
  .description("Manage local Copilot authentication state");

const copilotAuth = program.commands.find(
  (cmd) => cmd.name() === "copilot-auth",
);

copilotAuth
  ?.command("status")
  .description("Show local auth token status")
  .action(() => {
    process.stdout.write(JSON.stringify(getAuthStatusView(), null, 2) + "\n");
  });

copilotAuth
  ?.command("login")
  .description("Run GitHub Copilot device login and store token locally")
  .option("--domain <domain>", "GitHub host for OAuth device flow")
  .option("--no-exchange", "Skip API token exchange and store OAuth token only")
  .action(async (options) => {
    const start = await startDeviceAuthorization({
      domain: options.domain ? String(options.domain) : undefined,
    });

    process.stdout.write("Open this URL and enter the code:\n");
    process.stdout.write(`  ${start.verificationUri}\n`);
    process.stdout.write(`Code: ${start.userCode}\n`);
    if (start.rawVerificationUriComplete) {
      process.stdout.write(
        `Direct link: ${start.rawVerificationUriComplete}\n`,
      );
    }
    process.stdout.write("Waiting for authorization...\n");

    const oauthToken = await pollDeviceAuthorization(start.deviceCode, {
      domain: options.domain ? String(options.domain) : undefined,
      intervalSeconds: start.interval,
      expiresInSeconds: start.expiresIn,
    });

    if (options.exchange !== false) {
      const exchanged = await exchangeOAuthForCopilotApiToken(oauthToken);
      const stored = writeStoredAuth({
        accessToken: exchanged.apiToken,
        expiresAt: exchanged.expiresAt,
        copilotApiUrl: exchanged.copilotApiUrl,
        refreshToken: oauthToken,
        source: "device-login",
        tokenType: "api",
      });
      process.stdout.write(
        JSON.stringify(
          {
            loggedIn: true,
            tokenType: stored.tokenType,
            source: stored.source,
            expiresAt: stored.expiresAt,
            authFilePath: getAuthStatusView().authFilePath,
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }

    const stored = writeStoredAuth({
      accessToken: oauthToken,
      source: "device-login",
      tokenType: "oauth",
    });
    process.stdout.write(
      JSON.stringify(
        {
          loggedIn: true,
          tokenType: stored.tokenType,
          source: stored.source,
          authFilePath: getAuthStatusView().authFilePath,
        },
        null,
        2,
      ) + "\n",
    );
  });

copilotAuth
  ?.command("set-token")
  .description("Store a Copilot token for local proxy usage")
  .requiredOption("--token <token>", "access token")
  .option("--expires-at <iso>", "optional ISO timestamp")
  .action((options) => {
    writeStoredAuth({
      accessToken: String(options.token),
      expiresAt: options.expiresAt ? String(options.expiresAt) : null,
      source: "manual",
      tokenType: String(options.token).startsWith("tid_") ? "api" : "oauth",
    });
    process.stdout.write("Token stored\n");
  });

copilotAuth
  ?.command("import-headroom")
  .description("Import token from ~/.headroom/copilot_auth.json")
  .option("--path <path>", "custom headroom auth file path")
  .action((options) => {
    const stored = importFromHeadroom(
      options.path ? String(options.path) : undefined,
    );
    process.stdout.write(
      JSON.stringify(
        {
          imported: true,
          source: stored.source,
          updatedAt: stored.updatedAt,
          expiresAt: stored.expiresAt,
          authFilePath: getAuthStatusView().authFilePath,
        },
        null,
        2,
      ) + "\n",
    );
  });

copilotAuth
  ?.command("logout")
  .description("Remove locally stored token")
  .action(() => {
    clearStoredAuth();
    process.stdout.write("Token removed\n");
  });

copilotAuth
  ?.command("refresh")
  .description("Force refresh Copilot API token using stored OAuth token")
  .action(async () => {
    const refreshedToken = await refreshStoredCopilotApiToken();
    if (!refreshedToken) {
      process.stderr.write(
        "No refresh source token found. Run copilot-auth login first.\n",
      );
      process.exitCode = 1;
      return;
    }

    const stored = readStoredAuth();
    process.stdout.write(
      JSON.stringify(
        {
          refreshed: true,
          tokenType: stored?.tokenType ?? null,
          source: stored?.source ?? null,
          expiresAt: stored?.expiresAt ?? null,
          updatedAt: stored?.updatedAt ?? null,
          authFilePath: getAuthStatusView().authFilePath,
        },
        null,
        2,
      ) + "\n",
    );
  });

program
  .command("serve")
  .description("Alias for proxy")
  .option("-p, --port <port>", "port to bind", "8792")
  .action((options) => {
    const port = Number(options.port);
    const app = createServer();
    const httpServer = app.listen(port, "127.0.0.1", () => {
      process.stdout.write(
        `copilot-parity-local listening on 127.0.0.1:${port}\n`,
      );
    }) as http.Server;
  });

program
  .command("wrap")
  .description("Configure external tools to use the parity proxy");

const wrap = program.commands.find((cmd) => cmd.name() === "wrap");

wrap
  ?.command("vscode")
  .description("Configure VS Code to route GitHub Copilot through the proxy")
  .option("-p, --port <port>", "proxy port", "8796")
  .option("--settings-file <path>", "custom VS Code user settings file path")
  .option("--project <name>", "project name for usage attribution")
  .option("--no-configure", "print settings without editing the file")
  .action((options) => {
    try {
      configureVSCode({
        port: Number(options.port),
        settingsFile: options.settingsFile,
        projectName: options.project,
        noConfigure: options.configure === false,
      });
    } catch (error) {
      if (error instanceof Error) {
        process.stderr.write(`Error: ${error.message}\n`);
      } else {
        process.stderr.write(`Error: ${String(error)}\n`);
      }
      process.exitCode = 1;
    }
  });

wrap
  ?.command("vscode-remove")
  .description("Remove proxy configuration from VS Code settings")
  .option("--settings-file <path>", "custom VS Code user settings file path")
  .action((options) => {
    try {
      unconfigureVSCode(options.settingsFile);
    } catch (error) {
      if (error instanceof Error) {
        process.stderr.write(`Error: ${error.message}\n`);
      } else {
        process.stderr.write(`Error: ${String(error)}\n`);
      }
      process.exitCode = 1;
    }
  });

program.parse();
