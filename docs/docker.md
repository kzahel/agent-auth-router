# Running the router in Docker

The [`Dockerfile`](../Dockerfile) packages the headless router with the
official `claude` and `codex` CLIs it runs for sign-in and renewal, at the
versions in its `CLAUDE_CODE_VERSION` and `CODEX_VERSION` build arguments.
[`docker/compose.yaml`](../docker/compose.yaml) runs it as a service.

```sh
docker build -t agent-auth-router:local .
install -d -m 700 -o 1000 -g 1000 ./state
AAR_STATE=./state docker compose -f docker/compose.yaml up -d
```

## State

All state, including each account's profile home and credential files, lives
in the volume mounted at `/state` (`AAR_STATE_DIR`). The container runs as
`node` (uid 1000), so the directory must belong to uid 1000 and should be mode
700. Accounts record their profile home as an absolute path, so a state
directory created outside the container does not work inside it, and the
reverse; create accounts through the container.

## Network

The router and the web dashboard listen on loopback only, so the service uses
the host's network: clients on the host reach `http://127.0.0.1:8417`, and the
dashboard is `http://127.0.0.1:8418`. The dashboard's single-use sign-in link
appears in the service log; `docker compose run --rm aar dashboard url` prints
another.

Where build containers cannot resolve names, as on a Lima VM whose resolver is
the systemd-resolved stub on 127.0.0.53, build on the host network first and
start the service without building:

```sh
docker build --network host -t agent-auth-router:local .
AAR_STATE=./state docker compose -f docker/compose.yaml up -d --no-build
```

## Commands

The entry point accepts:

| Command | Effect |
| --- | --- |
| `serve` (default) | Creates the state directory's contents if needed and runs the router. |
| `login ACCOUNT [claude\|codex]` | Adds the account with the file credential store if it is new (default provider `claude`), then runs the official sign-in. Claude prints a URL and asks for the code; Codex uses its device-code flow. |
| anything else | Passed to the `aar` CLI, for example `client add`, `account list`, `account quotas`. |

Run them in a second container while the service runs; they reach the live
router through its control socket in `/state`, so changes take effect without
a restart:

```sh
docker compose -f docker/compose.yaml run --rm aar login work
docker compose -f docker/compose.yaml run --rm aar client add laptop --claude work
```

## Upgrading

Rebuild with new build arguments or a newer checkout and recreate the
service. The state volume carries over.
