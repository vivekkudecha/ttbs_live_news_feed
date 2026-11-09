#!/usr/bin/env bash
# One command for every environment:   ./deploy.sh <dev|uat|prod> [up|down|ps|logs|restart|config]
#
#   stage   settings     database                    gateway listens on
#   dev     .env.dev     MySQL container + phpMyAdmin  127.0.0.1:5173
#   uat     .env.uat     MySQL container + phpMyAdmin  127.0.0.1:5175
#   prod    .env.prod    external (DATABASE_URL)       GATEWAY_BIND:GATEWAY_PORT (default 0.0.0.0:80)
#
# "up" builds and (re)starts everything; data volumes are kept. "down" stops it; volumes are kept.
set -euo pipefail
cd "$(dirname "$0")"

STAGE=${1:-}
CMD=${2:-up}
shift $(( $# > 2 ? 2 : $# ))

case "$STAGE" in
  dev) port=5173 ;;
  uat) port=5175 ;;
  prod) ;;
  *) echo "usage: $0 <dev|uat|prod> [up|down|ps|logs|restart|config] [extra args]" >&2; exit 2 ;;
esac

ENV_FILE=".env.$STAGE"
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE is missing: cp .env.example $ENV_FILE, then fill it in" >&2; exit 1; }
[ "$(stat -c %a "$ENV_FILE")" = 600 ] || echo "warning: $ENV_FILE holds secrets, run: chmod 600 $ENV_FILE" >&2

export STAGE
files=(-f compose.yml)
if [ "$STAGE" != prod ]; then
  files+=(-f compose.db.yml)
  export WITH_TOOLS=true GATEWAY_BIND=127.0.0.1 GATEWAY_PORT=$port
  PMA_USER_CONFIG_BASE64=$(base64 -w0 deploy/phpmyadmin.php)
  export PMA_USER_CONFIG_BASE64
fi

if command -v podman-compose >/dev/null; then compose=(podman-compose)
elif [ -x "$HOME/.local/bin/podman-compose" ]; then compose=("$HOME/.local/bin/podman-compose")
else compose=(docker compose)
fi
compose+=(-p "ttbs-$STAGE" --env-file "$ENV_FILE" "${files[@]}")

case "$CMD" in
  # --force-recreate: podman-compose would otherwise keep containers whose image was rebuilt.
  up)      "${compose[@]}" up -d --build --force-recreate --remove-orphans "$@" ;;
  logs)    "${compose[@]}" logs -f --tail 100 "$@" ;;
  *)       "${compose[@]}" "$CMD" "$@" ;;
esac
