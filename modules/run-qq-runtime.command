#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${CODEX_REMOTE_CONTACT_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="$PROJECT_DIR/config/qq-only.env"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
COLIMA_PROFILE="${CODEX_REMOTE_CONTACT_COLIMA_PROFILE:-snowluma}"
SNOWLUMA_CONTAINER="${CODEX_REMOTE_CONTACT_SNOWLUMA_CONTAINER:-snowluma}"
COLIMA_BIN="${CODEX_REMOTE_CONTACT_COLIMA_PATH:-/opt/homebrew/bin/colima}"
DOCKER_BIN="${CODEX_REMOTE_CONTACT_DOCKER_PATH:-/opt/homebrew/bin/docker}"
DOCKER_CONTEXT="${CODEX_REMOTE_CONTACT_DOCKER_CONTEXT:-colima-snowluma}"
NODE_BIN="${CODEX_REMOTE_CONTACT_NODE_PATH:-/opt/homebrew/bin/node}"
if [[ ! "$COLIMA_PROFILE" =~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' ]]; then
  echo "Invalid Colima profile; refusing runtime recovery." >&2
  exit 1
fi
for required_bin in "$COLIMA_BIN" "$DOCKER_BIN" "$NODE_BIN"; do
  if [ ! -x "$required_bin" ]; then
    echo "QQ runtime executable missing: $required_bin; Hub remains independent." >&2
    exit 1
  fi
done
if ! "$COLIMA_BIN" status --profile "$COLIMA_PROFILE" >/dev/null 2>&1; then
  "$NODE_BIN" "$PROJECT_DIR/scripts/colima-stale-state.mjs" "$HOME/.colima/_lima/colima-$COLIMA_PROFILE"
  "$COLIMA_BIN" start --profile "$COLIMA_PROFILE"
fi
if ! "$DOCKER_BIN" --context "$DOCKER_CONTEXT" inspect "$SNOWLUMA_CONTAINER" >/dev/null 2>&1; then
  echo "SnowLuma container not installed; will retry, never recreate it or delete login data." >&2
  exit 1
fi
if [ "$("$DOCKER_BIN" --context "$DOCKER_CONTEXT" inspect -f '{{.State.Running}}' "$SNOWLUMA_CONTAINER")" != "true" ]; then
  "$DOCKER_BIN" --context "$DOCKER_CONTEXT" start "$SNOWLUMA_CONTAINER" >/dev/null
  echo "QQ runtime recovered; existing SnowLuma container started."
fi
