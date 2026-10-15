# Owner commands when configuring AAR

Use the selected AAR executable and explicit `--state` throughout. Owner
requests read JSON on stdin; never put owner keys in command arguments.
`aar owner <operation>` contacts the running owner or briefly starts one when
offline. Interactive login requires a persistent owner. Do not use owner
administration as a substitute for passive doctor discovery.

Useful operations and input shapes:

| Operation | JSON input | Purpose |
| --- | --- | --- |
| `overview` | `{}` | Local accounts, pools, integrations, current revisions and login jobs. No provider request. |
| `profiles/discover` | `{"provider":"claude"}` | Normal/environment profile directories; no credential discovery scan. |
| `profiles/inspect` | `{"provider":"claude","home":"/chosen/path","credentialStore":"file"}` | Explicit supported-store inspection; reads the selected profile credentials, no inference. |
| `accounts/add` | `{"id":"work","provider":"claude","credentialStore":"claude-keychain"}` | Create a dedicated managed profile on macOS. For Codex use `provider: "codex"` and file storage. |
| `accounts/add` | `{"id":"existing","provider":"codex","home":"/chosen/path","enrollment":"existing","credentialStore":"file"}` | Enroll the user's chosen existing profile without copying its credentials or repairing its permissions. |
| `accounts/login-status` | `{"id":"work"}` | Read local credential/sign-in state and the managed login job state. |
| `accounts/cancel-login` | `{"id":"work"}` | Cancel managed sign-in; wait for the owned terminal process to exit. |
| `pools/save` | `{"id":"<new UUID>","name":"Personal","provider":"claude","accountIds":["work"],"policy":"weekly-pace","revision":0}` | Generate a UUID for a new router-owned pool. Use the returned ID and revision for edits. |
| `grants/save` | `{"id":"<integration ID>","revision":1,"poolIds":["<pool ID>"]}` | Update requested integration access. Read current revision and preserve unrelated existing grants. |

The general form is `aar --state /absolute/state owner overview` with `{}` on
stdin. For mutations, construct JSON with a real JSON encoder or a literal
quoted here-document; do not interpolate untrusted labels/paths into shell
code. Read command output before constructing a dependent request.

`aar --state /absolute/state account add work --provider claude
--credential-store claude-keychain` is a convenient dedicated-profile command.
`aar --state /absolute/state terminal-login work --browser link` is the
interactive runner for a user who chose to open their own link. Use
`--browser open` only after an explicit request to open a browser here. If
omitted, the runner asks, and Enter chooses a link.
There is no required JSON login-dialogue parser or machine-readable device-code
protocol; inspect the tmux pane for official CLI instructions.

For ordinary gateway clients, `client add NAME --claude-pool POOL` or
`--codex-pool POOL` creates a scoped token, shown once. This output contains a
secret: arrange private storage/redirection before invoking it. `client list`
and `client revoke ID` manage these clients. Integration pairing and gateway
clients are distinct; do not manufacture a YA pairing by copying owner state.

New `grants/save` and `pools/save` calls must preserve IDs and use current
revisions. Avoid expanding access implicitly while solving a login problem.
Pool names, membership and policies are owner preferences; ask if unspecified
and consequential. Account retirement/removal is not a routine setup step.
