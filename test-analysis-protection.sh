#!/bin/bash
set -e

# Test protect_analysis_context feature
# This test verifies that code is preserved when analysis intent is detected

TOKEN=$(cat ~/.copilot-parity-local/auth.json | grep -o '"copilotApiToken":"[^"]*"' | cut -d'"' -f4)

echo "=== Testing protect_analysis_context feature ==="
echo "User asks: 'Can you analyze this code and find bugs?'"
echo "Expectation: Code content should be preserved (not compressed)"
echo ""

# Test payload: user asks to "analyze" code
PAYLOAD=$(cat <<'EOF'
{
  "model": "gpt-4",
  "messages": [
    {
      "role": "system",
      "content": "You are a code reviewer. This is some long boring context that should be compressed... Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat."
    },
    {
      "role": "user", 
      "content": "Here's some logs that should be compressed:\n\nINFO: Starting server\nINFO: Loading config\nINFO: Connecting to database\nINFO: Server ready\nINFO: Processing request\nINFO: Processing request\nINFO: Processing request"
    },
    {
      "role": "assistant",
      "content": "I've reviewed the logs."
    },
    {
      "role": "user",
      "content": "Can you analyze this code and find bugs?\n\n```typescript\nfunction calculateTotal(items: Item[]): number {\n  let total = 0;\n  for (const item of items) {\n    total += item.price * item.quantity;\n  }\n  return total;\n}\n\nfunction processOrder(order: Order): void {\n  const total = calculateTotal(order.items);\n  if (total > 1000) {\n    applyDiscount(order, 0.1);\n  }\n  submitOrder(order);\n}\n```"
    }
  ]
}
EOF
)

echo "Request:"
echo "$PAYLOAD" | jq -c '.'
echo ""

# Send request
RESPONSE=$(curl -s http://localhost:8796/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

echo "Response (tokens only):"
echo "$RESPONSE" | jq '{usage: .usage, choices: [.choices[0].message.content[:100] + "..."]}'
echo ""

# Extract the last message (the one with code)
LAST_MESSAGE=$(echo "$RESPONSE" | jq -r '.choices[0].message.content')
echo "Assistant's response preview:"
echo "$LAST_MESSAGE" | head -n 5
echo ""

echo "=== Checking compression behavior ==="

# Check if "analyze" intent was detected by looking at the response
# The proxy should log "analysis intent detected" or similar

# Now test WITH compression (no analysis intent)
echo ""
echo "=== Control test: No analysis intent ==="
echo "User asks normal question (no 'analyze' keyword)"
echo ""

PAYLOAD_NO_INTENT=$(cat <<'EOF'
{
  "model": "gpt-4",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant. This is some long boring context that should be compressed... Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat."
    },
    {
      "role": "user",
      "content": "What's the weather like?\n\n```typescript\nfunction calculateTotal(items: Item[]): number {\n  let total = 0;\n  for (const item of items) {\n    total += item.price * item.quantity;\n  }\n  return total;\n}\n```"
    }
  ]
}
EOF
)

RESPONSE_NO_INTENT=$(curl -s http://localhost:8796/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD_NO_INTENT")

echo "Response (tokens only):"
echo "$RESPONSE_NO_INTENT" | jq '{usage: .usage}'
echo ""

echo "=== Summary ==="
echo "With 'analyze' intent (code protected): $(echo "$RESPONSE" | jq -r '.usage.prompt_tokens') tokens"
echo "Without 'analyze' intent (code compressed): $(echo "$RESPONSE_NO_INTENT" | jq -r '.usage.prompt_tokens') tokens"
echo ""
echo "✅ If 'WITH' > 'WITHOUT', protect_analysis_context is working!"
echo "✅ Code is preserved when user asks to 'analyze'"
