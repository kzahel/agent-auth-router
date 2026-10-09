#!/bin/sh
# Container entry point.
#   serve [ARGS]               create the state directory if needed and run the router
#   login ACCOUNT [PROVIDER]   add the account if it is new (claude or codex, default
#                              claude, file credential store), then run the official
#                              sign-in; Codex uses its device-code flow
#   anything else              passed to the aar CLI
set -eu

aar() { node /opt/aar/src/cli.ts "$@"; }

case "${1:-serve}" in
  serve)
    [ $# -gt 0 ] && shift
    aar init >/dev/null
    exec node /opt/aar/src/cli.ts serve "$@"
    ;;
  login)
    account=${2:?usage: login ACCOUNT [claude|codex]}
    provider=$(aar account list | awk -F '\t' -v id="$account" '$1 == id { print $2 }')
    if [ -z "$provider" ]; then
      provider=${3:-claude}
      aar account add "$account" --provider "$provider" --credential-store file >/dev/null
    fi
    command=$(aar account login-command "$account")
    [ "$provider" = codex ] && command="$command --device-auth"
    exec sh -c "$command"
    ;;
  *)
    exec node /opt/aar/src/cli.ts "$@"
    ;;
esac
