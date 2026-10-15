# Profiles, copies and moving a router

AAR enrollment points to an official CLI profile. The official CLI owns its
credential store and renewal; AAR does not exchange OAuth codes or refresh
tokens. Enrolling a folder is different from importing/copying its credentials.

Dedicated directories isolate account configuration. Two copies of the same
OAuth refresh state, especially on different machines, are not independently
coordinated by those directories. Refresh rotation can leave one copy stale.
Do not diagnose every renewal failure as revocation or promise a provider's
exact concurrent-login behavior without evidence.

Choose a deployment that the user understands:

- Perform a fresh official login on each intended authentication host using
  its own supported profile; observe the provider's rules for those logins.
- Or let clients share one central router/authentication host over a supported,
  explicitly configured transport. AAR's present loopback-only listener is not
  permission to expose it to a LAN or invent remote administration.

Pool names/policies can be reconstructed as preferences. A copied router state
contains more: machine paths, private authorization material, router identity,
durable session bindings and potentially dashboard access. Copying a config
file alone does not make another router an equivalent continuation endpoint.
An exported diagnostic report is intentionally insufficient to restore access.

There is no new export/import command in this skill. For a deliberate backup
restore or move, stop all writers, preserve a complete consistent backup and
the required private permissions, and leave the old instance stopped. Review
machine-specific paths and credential-store portability before starting the
destination. macOS Keychain storage is not a portable profile-folder file.
Do not run two router instances against one state directory.

For test cleanup, stopping a task-owned router and deleting a task-owned tmux
pane do not revoke provider credentials. Keep successful enrollments unless
their removal is requested. AAR account removal defaults to keeping profile
files; deleting a profile requires an explicit, eligible deletion operation.
Deleting a folder does not remove Keychain entries. Do not log out the user's
normal CLI account or copy secrets into repository files to simplify cleanup.
