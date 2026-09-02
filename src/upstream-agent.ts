import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";

type UpstreamAgentResolver = (parsedUrl: URL) => http.Agent | https.Agent;

function resolveCaBundlePath(): string | undefined {
  const candidates = [
    process.env.COPILOT_CA_BUNDLE,
    process.env.SSL_CERT_FILE,
    process.env.REQUESTS_CA_BUNDLE,
    process.env.NODE_EXTRA_CA_CERTS,
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function createUpstreamFetchAgent(): UpstreamAgentResolver | undefined {
  const caBundlePath = resolveCaBundlePath();
  if (!caBundlePath) {
    return undefined;
  }

  try {
    const caBundle = fs.readFileSync(caBundlePath, "utf8");
    const ca = [...tls.rootCertificates, caBundle].join("\n");
    const httpAgent = new http.Agent({ keepAlive: true });
    const httpsAgent = new https.Agent({ keepAlive: true, ca });

    process.stdout.write(
      `[copilot-parity] using custom CA bundle from ${caBundlePath}\n`,
    );

    return (parsedUrl: URL) =>
      parsedUrl.protocol === "http:" ? httpAgent : httpsAgent;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load CA bundle";
    process.stderr.write(
      `[copilot-parity] could not load CA bundle ${caBundlePath}: ${message}\n`,
    );
    return undefined;
  }
}
