# Pinned Sigstore trust root (a copy)

`fulcio.pem` (the Fulcio CA certificate chain) and `rekor.pub` (the Rekor
transparency log's public key) are what every signature this plugin checks is
ultimately anchored to.

**This directory is a copy. It is not where the root is maintained.** The
canonical copy lives in
[promptsign-core](https://github.com/PromptSign/promptsign-core/tree/main/trust),
which owns the root for the whole project. This plugin carries its own copy
because tier 1 runs a standalone `promptsign` binary with no `node_modules` to
read `@promptsign/verify`'s copy from, so the files have to be present in the
repo.

They are committed so that a fresh plugin install can verify **offline**, with
no `promptsign trust fetch` and no network call on the first hook. A verifier
that has to phone home before it can verify is a verifier that fails when you
most want it.

Rekor log id (hex SHA-256 of the log key's SPKI DER), for cross-checking:

```
c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d
```

## Precedence

`scripts/runtime.mjs` applies this directory **only** when the machine sets
neither `PROMPTSIGN_TRUST_DIR` nor `PROMPTSIGN_HOME`. An operator running a
private trust root is never silently overridden by the copy shipped here.

## Staying in step

`scripts/check-trust-root.mjs` compares these two files against the canonical
ones and fails when they diverge. It runs in CI on every push and pull request,
so an edit made here turns the build red, and weekly on a schedule, so a
rotation landing in core is noticed even in a quiet week.

Run it yourself with:

```bash
node scripts/check-trust-root.mjs
```

Exit codes: `0` in step, `1` core was unreachable and nothing was compared, `2`
the roots differ.

## Updating

Sigstore rotates these rarely, but it does. **Rotate in promptsign-core, never
here.** Rotation is append, never replace: `fulcio.pem` holds a chain of CA
certificates and `rekor.pub` holds one PEM block per trusted log, and each is
selected by identity rather than position. Keeping the retired material is what
lets everything signed before the rotation carry on verifying. Copying over
these files, or editing them in place, is how that material gets dropped. That
silently invalidates the entire back catalogue.

So: land the rotation in promptsign-core first, following the procedure in
[its `trust/README.md`](https://github.com/PromptSign/promptsign-core/blob/main/trust/README.md).
Then bring the result across:

```bash
base=https://raw.githubusercontent.com/PromptSign/promptsign-core/main/trust
curl -fsSL "$base/fulcio.pem" -o trust/fulcio.pem
curl -fsSL "$base/rekor.pub"  -o trust/rekor.pub
node scripts/check-trust-root.mjs   # confirm, and update the log id above
```

A change to either file is a security-relevant change to this plugin: it must be
its own commit, with the new log id stated in the message, and it must bump the
plugin version.
