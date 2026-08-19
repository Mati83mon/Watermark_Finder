# Bundled data

## `c2pa-trust-list.pem`

The official C2PA trust list: the root and intermediate certificate authorities
permitted to issue Content Credential signing certificates under the C2PA
Certificate Policy.

- Source: <https://github.com/c2pa-org/conformance-public/blob/main/trust-list/C2PA-TRUST-LIST.pem>
- Fetched: 2026-08-19 · 30 certificates · 37 911 bytes

It is vendored rather than fetched at runtime for three reasons: the engine
would otherwise need network access on the request path, a remote fetch is a
supply-chain dependency evaluated on every boot rather than once at review time,
and a trust list that silently changes underneath a deployment makes past
verdicts unreproducible.

**It has to be refreshed deliberately.** New authorities join the programme and
compromised ones are removed. A stale list understates trust — a genuine signer
whose CA joined after this file was fetched reports as `unrecognised` — which is
the safe direction to fail, but still wrong. Re-download from the URL above and
commit the change.
