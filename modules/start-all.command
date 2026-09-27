#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT_APP="$PROJECT_DIR/build/CodexRemoteContactClient.app"

cd "$PROJECT_DIR"

"$PROJECT_DIR/modules/chat-hub-start.command"

if [ -d "$CLIENT_APP" ]; then
  echo "Opening codexremotecontact client..."
  /usr/bin/open -a "$CLIENT_APP"
else
  echo "Client app is not built yet: $CLIENT_APP"
fi

echo ""
echo "QQ recovery runs in a separate launchd job. Configure your existing SnowLuma runtime before enabling it."
