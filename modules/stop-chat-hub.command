#!/bin/zsh
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="local.codexremotecontact.chat-hub"
PORT="3789"
USER_DOMAIN="gui/$(id -u)"

launchctl bootout "$USER_DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootout "$USER_DOMAIN/local.codexremotecontact.qq-runtime" >/dev/null 2>&1 || true

pid=$(lsof -tiTCP:$PORT -sTCP:LISTEN)

if [ -z "$pid" ]; then
  echo "codexremotecontact Chat Hub is not running."
  exit 0
fi

kill -TERM $pid
echo "Stopped codexremotecontact Chat Hub on port $PORT."
