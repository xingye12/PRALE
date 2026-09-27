#!/usr/bin/env bash
#
# Start one deployment of the agent-harness web UI.
#
#   deploy/start-web.sh                    # serve on the configured address
#   deploy/start-web.sh --print-config     # show what resolved, bind nothing
#   deploy/start-web.sh --port 9000        # flags pass through to the server
#
# Configuration lives in a shell file of PRALE_* assignments — see
# web.env.example next to this script.  This script adds only what a local run
# needs: a place for the stores, the repository's own source on the import path
# when the package is not installed, and a check that the value it must not
# invent — the scope identity — is actually set.  It never echoes a credential,
# and it warns rather than guesses when a deployment would be unauthenticated.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# --- source ---------------------------------------------------------------
# Run from the checkout even when the package is not installed; an installed
# package wins, because PYTHONPATH would otherwise shadow it.
if ! python -c "import agent_harness" >/dev/null 2>&1; then
  export PYTHONPATH="$ROOT/src${PYTHONPATH:+:$PYTHONPATH}"
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  echo
  echo "Server options (each also read from a PRALE_* variable):"
  exec python -m agent_harness.api.serve --help
fi

# --- configuration --------------------------------------------------------
# First file that exists wins: the explicit one, then a per-user file, then the
# checkout's own (which is why the example sits next to this script).
config_file="${PRALE_CONFIG:-}"
if [[ -z "$config_file" ]]; then
  for candidate in "$HOME/.config/prale/web.env" "$ROOT/deploy/web.env"; do
    if [[ -f "$candidate" ]]; then
      config_file="$candidate"
      break
    fi
  done
fi

if [[ -n "$config_file" ]]; then
  if [[ ! -f "$config_file" ]]; then
    echo "start-web: PRALE_CONFIG=$config_file does not exist" >&2
    exit 2
  fi
  echo "start-web: config $config_file"
  if [[ "$config_file" == "$ROOT"/* ]] && ! git -C "$ROOT" check-ignore -q "$config_file" 2>/dev/null; then
    echo "start-web: warning: that file is inside the checkout and is not git-ignored;" >&2
    echo "           a credential written there can be committed by accident." >&2
  fi
  set -a
  # shellcheck disable=SC1090  # the path is the deployment's own config
  . "$config_file"
  set +a
fi

# --- defaults -------------------------------------------------------------
export PRALE_PROJECT_ROOT="${PRALE_PROJECT_ROOT:-$ROOT}"
export PRALE_DATA_DIR="${PRALE_DATA_DIR:-$HOME/.local/share/prale}"

# The scope is an identity, and memory accumulated under one id is invisible
# under another, so it is never guessed: a remote is offered as a suggestion and
# the run stops until the value is spelled out.
if [[ -z "${PRALE_REPOSITORY_ID:-}" ]]; then
  remote="$(git -C "$PRALE_PROJECT_ROOT" remote get-url origin 2>/dev/null || true)"
  echo "start-web: PRALE_REPOSITORY_ID is required." >&2
  echo "  It scopes every memory and skill: changing it later hides what was accumulated." >&2
  if [[ -n "$remote" ]]; then
    echo "  This checkout's origin is: $remote" >&2
    echo "  PRALE_REPOSITORY_ID='$remote' deploy/start-web.sh $*" >&2
  else
    echo "  No origin remote here; pick a stable name, e.g. PRALE_REPOSITORY_ID=my-project" >&2
  fi
  exit 2
fi

# A key may live in a file instead of the environment, so it stays out of shell
# history and out of `ps e` for other users on the box.
if [[ -z "${PRALE_API_KEY:-}" && -n "${PRALE_API_KEY_FILE:-}" ]]; then
  if [[ ! -f "$PRALE_API_KEY_FILE" ]]; then
    echo "start-web: PRALE_API_KEY_FILE=$PRALE_API_KEY_FILE does not exist" >&2
    exit 2
  fi
  PRALE_API_KEY="$(tr -d '\r\n' < "$PRALE_API_KEY_FILE")"
  export PRALE_API_KEY
fi

# --- serve ----------------------------------------------------------------
# Everything the operator looks at first, said once, without the credential.
# An unset key is the server's call to refuse, not this script's: a deployment
# without one can still be browsed, and the server is where that is decided.
echo "start-web: scope        ${PRALE_REPOSITORY_ID:-<unset>}"
echo "start-web: project_root ${PRALE_PROJECT_ROOT}"
echo "start-web: data_dir     ${PRALE_DATA_DIR}"
if [[ -z "${PRALE_TOKENS:-}" ]]; then
  echo "start-web: no PRALE_TOKENS — unauthenticated; keep PRALE_HOST on loopback (the default)."
fi
echo "start-web: open http://${PRALE_HOST:-127.0.0.1}:${PRALE_PORT:-8787}/"

exec python -m agent_harness.api.serve "$@"
