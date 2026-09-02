# Copilot Parity Local

Local proxy for VS Code GitHub Copilot. It routes native Copilot requests through
`127.0.0.1`, preserves selected model IDs, compacts eligible input context, and
records per-request token estimates. No duplicate model appears in VS Code picker.

## Requirements

- Node.js 20 or later
- VS Code with GitHub Copilot enabled and signed in
- GitHub account with Copilot access
- Loopback access from VS Code extension host to `127.0.0.1`

## Setup

Install dependencies and build:

```bash
git clone https://github.com/Binod310/ghcp-parity.git
cd ghcp-parity
npm install
npm run build
```

Authorize parity with GitHub Copilot. Follow printed device-login URL and code:

```bash
npm run dev -- copilot-auth login
npm run dev -- copilot-auth status
```

The reusable OAuth credential and refreshed Copilot API token are stored locally
under `~/.copilot-parity-local/auth.json`; this file is ignored by Git.

Existing Headroom auth can be imported instead:

```bash
npm run dev -- copilot-auth import-headroom
npm run dev -- copilot-auth status
```

## Corporate TLS Inspection

On networks that intercept TLS, provide a PEM bundle containing the corporate CA
(for example, Zscaler) plus standard public roots. Node must receive the bundle at
process startup:

```bash
export COPILOT_CA_BUNDLE="$HOME/.headroom/certs/copilot-ca-bundle.pem"
export NODE_EXTRA_CA_CERTS="$HOME/.headroom/certs/copilot-ca-bundle.pem"
```

Without corporate TLS inspection, omit these variables. Never set
`NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Configure VS Code

Add a marker-owned block to VS Code user settings:

```bash
npm run dev -- wrap vscode --port 8796 --project Headroom
```

Use `--project <name>` to label the proxy URL for a project. Use a specific
settings file for Insiders, VSCodium, remote development, or custom profiles:

```bash
npm run dev -- wrap vscode --port 8796 --project MyProject \
  --settings-file /path/to/User/settings.json
```

`--no-configure` prints settings without changing files. The managed block adds:

- `github.copilot.advanced.debug.overrideProxyUrl`
- `github.copilot.advanced.debug.overrideCapiUrl`
- `github.copilot.advanced.chatOverrideProxyUrl`

Restart VS Code after configuring. Continue using native model picker: selected
models travel through parity unchanged.

Remove only parity's settings block:

```bash
npm run dev -- wrap vscode-remove
```

Pass same `--settings-file` value when one was used during setup.

## Run

Start the proxy with input optimization:

```bash
env \
  COPILOT_CA_BUNDLE="$COPILOT_CA_BUNDLE" \
  NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" \
  npm run dev -- proxy --port 8796
```

Enable terse output mode as well. This injects a concise-response instruction into
native Chat Completions, Responses, and Anthropic Messages requests; it preserves
model ID, code, identifiers, error text, negation, and numbers:

```bash
env \
  COPILOT_PARITY_TERSE_MODE=full \
  COPILOT_CA_BUNDLE="$COPILOT_CA_BUNDLE" \
  NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" \
  npm run dev -- proxy --port 8796
```

Supported terse levels: `off` (default), `lite`, `full`, `ultra`. Stop proxy with
`Ctrl+C`. While stopped, configured Copilot requests fail rather than bypass parity.

For Business and Enterprise accounts, parity uses the validated API endpoint
advertised during token exchange, such as `https://api.business.githubcopilot.com`.
Set `COPILOT_BASE_URL` only when intentionally pinning a different Copilot API host.

## Verify

With proxy running:

```bash
curl -sS http://127.0.0.1:8796/health
curl -sS http://127.0.0.1:8796/stats/latest
curl -sS http://127.0.0.1:8796/stats/summary
```

Health response must include `"ok":true`, `"token_configured":true`, and
`"copilot_base_url":"https://api.githubcopilot.com"`. In VS Code, select a model
and send a short chat prompt. Proxy log and `/stats/latest` should show its native
route and model, for example `claude-sonnet-5` on `/v1/messages` or `gpt-5.6-terra`
on `/responses`. `gpt-4o-mini-2024-07-18` requests on `/chat/completions` are
typically Copilot's separate internal title, todo, or command-risk helper calls.

`saved_tokens` measures estimated input-token reduction from request compaction.
Streaming Copilot responses often omit output usage, so output-token savings from
terse mode are verified from response behavior rather than telemetry.

## Local auth flow

1. Direct login: `npm run dev -- copilot-auth login`
2. Import existing Headroom token: `npm run dev -- copilot-auth import-headroom`
3. Check auth status: `npm run dev -- copilot-auth status`
4. Refresh expired API token: `npm run dev -- copilot-auth refresh`

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
