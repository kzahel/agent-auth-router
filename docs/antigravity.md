# Experimental Antigravity subscription routing

Antigravity CLI 1.5.14 accepts `CLOUD_CODE_URL` in personal Google account mode.
`agy acp --cloud_code_endpoint URL` selects the same endpoint through a launch
argument. The CLI sends its Cloud Code `/v1internal:*` RPCs there, including
its model catalog and streamed inference. `AGY_LLM_GATEWAY_URL` selects a
separate Google authentication mode with a different inference protocol.

This experiment uses a single file-backed personal Google login on the router
and a revocable client token per execution host. Google determines subscription
access. A loopback test streamed a reply through Yep Anywhere, `agy acp`, the
bridge and AAR. A separate loopback OAuth fixture verified that `agy models`
renewed and saved an expired credential.

One live run on 2026-11-25 used a personal Google subscription, `agy` 1.5.14
on macOS arm64, a local router at `d270e9c` and a paired Yep Anywhere at
`9793c4832` with an account grant. Sign-in used the command printed by `aar
account add`. `aar owner accounts/refresh` returned eight models, and `aar
account quotas` returned four windows. Two text turns and one file-read tool
turn succeeded, and the session resumed after its `agy` process was killed.
Every registered Antigravity call in the request log returned 200.

`agy` also sent `writeTrajectoryAcls`, which this router answered with 404
before checking the token, and the session went on. This run did not exercise
renewal of an expired login, a pool, a hosted origin or the standalone
bridge.

## Turning it on

Antigravity routing is off until the router owner checks **Enable
experimental Antigravity routing** in Settings. The warning beside the box
reads: "This integration can break when Antigravity changes. Google may
restrict account access for unsupported third-party use." It links to
[Google's Antigravity terms](https://antigravity.google/terms). The setting is
stored in `settings.json` and changed with the `settings/experimental-providers`
owner operation, so only the owner can change it:

```sh
echo '{"provider":"antigravity","enabled":true}' | aar owner settings/experimental-providers
```

While it is off:

- **Paired integrations** are offered no Antigravity account or pool.
  `/v1/selection` and `/v1/overview` list none and carry `disabledProviders:
  ["antigravity"]`. `GET /v1/accounts` still lists the granted accounts.
- **Bindings** cannot be prepared, committed or inspected, and catalog and
  quota reads are refused. Each answers 409 with `code: "provider_disabled"`
  and "Antigravity routing is turned off; the router owner can turn it on in
  AAR Settings". Cancel still works.
- **Inference** on `/antigravity` answers 403 with the same text to an
  authenticated client, standalone bridge clients included. A stream accepted
  earlier runs to its end.
- **The router's own reads** stop: it sends no catalog or quota request to
  Cloud Code for an Antigravity account and runs no renewal for it, and the
  account shows the same text in the dashboard. Work under way when the owner
  turns it off is not retried or renewed. Sign-in with the official CLI is
  unaffected.

Accounts, pools, grants and bindings are kept. Turning it on grants nothing
new, and a session pinned earlier runs again on the same binding and token.
Turning it off does not sign the account out of Google.

## On the router host

Use the AAR CLI to add an account and run the sign-in command it prints:

```sh
aar account add google --provider antigravity
```

For a paired Yep Anywhere, grant the integration the account or a pool that
holds it, in the dashboard or with the `grants/save` owner operation. YA
starts its own loopback proxy for each routed session and needs none of the
standalone steps below. A standalone host needs a client token instead:

```sh
aar client add devbox --antigravity google
```

The printed `agy acp --login` command uses a dedicated home directory and the
CLI's SSH sign-in path to isolate its token file from the OS keyring. `aar
account list` reports whether the store is readable. AAR reads the access token
on demand and runs `agy models` without a prompt when it expires, then checks
whether the official CLI persisted a replacement. Use a fresh client grant
and token file per host. Hosted gateways use the same TLS reverse proxy and
public origin as [other AAR routes](remote.md).

## On each standalone execution host

Save the token from `aar client add` in an owner-only file. Start the bridge
with a dedicated profile directory and an available loopback port:

```sh
aar antigravity bridge --gateway https://aar.example.com \
  --token-file "$HOME/.config/aar/antigravity-token" \
  --home "$HOME/.aar-antigravity" --port 8421
```

Launch the Yep Anywhere server with these values in its environment. A build
with Antigravity Cloud Code endpoint support passes the profile explicitly to
`agy acp` and uses the same profile for native history:

```sh
export CLOUD_CODE_URL=http://127.0.0.1:8421
export GEMINI_HOME="$HOME/.aar-antigravity"
export SSH_CONNECTION='127.0.0.1 0 127.0.0.1 0'
```

Select Antigravity normally. The bridge stays running alongside Yep Anywhere.
Use an `agy` executable on the server's `PATH` or set `ANTIGRAVITY_ACP_PATH`
to that executable. Use a profile dedicated to the bridge and an environment
without a separate Gemini API key or Antigravity Enterprise Gateway config.
The bridge supplies a local profile marker to `agy`. Only the bridge holds
the AAR client token, because `agy` also attempts a direct Google UserInfo
request. AAR sends the enrolled account's access token only to its configured
Cloud Code upstream. The bridge accepts only the allowlisted setup and
streaming RPCs. AAR records route, account, timing, status and byte counts.
This setup uses a dedicated file-backed personal Google login per enrolled
account on the router and supports both:

- **Paired integrations & pools (`antigravity-control-v1`):** Antigravity
  accounts can be added to AAR pools, granted to paired integrations like Yep
  Anywhere, queried for catalogs (`v1internal:fetchAvailableModels`) and quota
  windows (`v1internal:retrieveUserQuotaSummary`, scoped to `gemini`,
  `gemini-argon`, `gemini-carbon`, and `3p`), and bound per session without
  server-wide environment variables. Yep Anywhere runs a per-session loopback
  proxy tied to each routed `agy acp` child process. It forwards below the
  route the binding describes and leaves it to this router to decide which
  calls that route serves.
- **Standalone manual clients (`aar client add` + `aar antigravity bridge`):**
  The manual client token and long-lived bridge workflow above remains supported
  for standalone CLI hosts.
