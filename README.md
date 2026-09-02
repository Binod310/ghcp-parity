# Copilot Parity Local

Standalone implementation workspace for a local-only Copilot-compatible proxy with per-request usage telemetry.

## Goals

- Keep implementation separate from the upstream Headroom repository.
- Support local proxy login and request forwarding.
- Emit per-request before/after token and AIU usage metrics.

## Quick start

1. Install dependencies:
   npm install
2. Run in dev mode:
   npm run dev -- proxy --port 8792
3. Run tests:
   npm test

## Local auth flow

1. Direct login (recommended):
   npm run dev -- copilot-auth login
2. Import existing Headroom token (alternative):
   npm run dev -- copilot-auth import-headroom
3. Check auth status:
   npm run dev -- copilot-auth status
4. Start proxy:
   npm run dev -- proxy --port 8792
5. Force-refresh token manually (optional):
   npm run dev -- copilot-auth refresh

Device-login options:

- Enterprise/custom GitHub host:
  npm run dev -- copilot-auth login --domain github.example.com
- Store OAuth token without Copilot API token exchange:
  npm run dev -- copilot-auth login --no-exchange

Automatic runtime behavior:

- If a stored token is OAuth, proxy auto-exchanges it to a Copilot API token.
- If a stored API token is expired and refresh token exists, proxy auto-refreshes it.
- If upstream returns 401 once, proxy attempts one forced refresh retry.
- If caller sends Authorization: Bearer <token>, proxy forwards that token first.
- Proxy applies lightweight prompt compaction before forwarding requests.
- Proxy honors x-headroom-base-url and x-headroom-original-path headers for upstream override routing.
- All upstream model and inference calls use COPILOT_TIMEOUT_MS (default 60000).

Optimization toggle:

- Enabled by default.
- Disable with environment variable:
  COPILOT_PARITY_ENABLE_OPTIMIZATION=0

Optional manual token setup:

1. Set token directly:
   npm run dev -- copilot-auth set-token --token <TOKEN>
2. Remove stored token:
   npm run dev -- copilot-auth logout

Status output fields include:

- configured
- expired
- tokenType (api or oauth)
- hasRefreshToken

## Telemetry endpoints

- Health: GET /health
- Auth status: GET /stats/auth
- Latest request telemetry: GET /stats/latest
- Request telemetry history: GET /stats/requests
- Request summary totals: GET /stats/summary

## Comparison endpoint

- Compare baseline and optimized runs for one payload:
  POST /v1/responses/compare
  POST /v1/chat/completions/compare
  POST /v1/messages/compare

## Request endpoints

- Responses API passthrough:
  POST /v1/responses
- Chat Completions passthrough:
  POST /v1/chat/completions
- Anthropic Messages passthrough:
  POST /v1/messages
- GHCP model discovery passthrough:
  GET /models
  GET /v1/models

## VS Code Copilot integration

Configure the native Copilot model picker to use the local proxy:

```bash
npm run dev -- wrap vscode --port 8796 --project Headroom
```

The wrapper adds a marker-owned block containing
`github.copilot.advanced.debug.overrideProxyUrl`,
`github.copilot.advanced.debug.overrideCapiUrl`, and
`github.copilot.advanced.chatOverrideProxyUrl`. The selected Copilot model is
forwarded unchanged; no Headroom model is registered. Use
`--settings-file /path/to/User/settings.json` for alternate VS Code profiles or
remote environments, and `--no-configure` to print the settings without editing.

## Model compatibility

- Some models are endpoint-specific and may be rejected with 400 errors.
- To discover supported models for your account, query:
  GET https://api.githubcopilot.com/models
- Use models whose supported_endpoints include the route you call
  (for example /chat/completions for chat-completions passthrough).

Response includes:

- baseline.status and baseline.usage
- optimized.status and optimized.usage
- telemetry with before/after/saved token and AIU values

Telemetry measurement field:

- provider: usage from upstream provider fields
- estimated: usage estimated locally when provider usage is missing
- unavailable: no usable token metrics available
