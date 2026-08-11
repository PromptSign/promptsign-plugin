# Pinned Sigstore trust root

`fulcio.pem` (the Fulcio CA certificate chain) and `rekor.pub` (the Rekor
transparency log's public key) are what every signature this plugin checks is
ultimately anchored to. They are committed so that a fresh plugin install can
verify **offline**, with no `promptsign trust fetch` and no network call on the
first hook. A verifier that has to phone home before it can verify is a
verifier that fails when you most want it.

These two files were produced by `promptsign trust fetch`, which reads:

- `https://fulcio.sigstore.dev/api/v1/rootCert`
- `https://rekor.sigstore.dev/api/v1/log/publicKey`

Rekor log id (hex SHA-256 of the log key's SPKI DER), for cross-checking:

```
c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d
```

## Precedence

`scripts/runtime.mjs` applies this directory **only** when the machine sets
neither `PROMPTSIGN_TRUST_DIR` nor `PROMPTSIGN_HOME`. An operator running a
private trust root is never silently overridden by the copy shipped here.

## Updating

Sigstore rotates these rarely, but it does rotate them. To refresh:

```bash
promptsign trust fetch
cp ~/.promptsign/trust/fulcio.pem ~/.promptsign/trust/rekor.pub trust/
promptsign trust show          # confirm the log id above still matches, or update it
```

A change to either file is a security-relevant change to this plugin: it must be
its own commit, with the new log id stated in the message, and it must bump the
plugin version.
