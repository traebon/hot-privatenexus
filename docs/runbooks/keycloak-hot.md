# Recovery Runbook — Keycloak (House of Trae SSO)

External dependency, not run or backed up by PrivateNexus. Hosted on the
Gateway VPS (`auth.house-of-trae.com`), PostgreSQL-backed, serves as the
identity provider for every HoT app including PrivateNexus's own login
(`privatenexus` realm).

## Why PrivateNexus doesn't back this up

Keycloak is shared infrastructure owned by the wider House of Trae stack, not
part of the PrivateNexus deployment. Its actual recovery procedure —
including the 10-realm broker setup, WebAuthn/passkey policy, and
realm-federation gotchas — is documented in the main infrastructure
CLAUDE.md, not here, since that's the canonical, actively-maintained source
and duplicating it here would just create a second copy to go stale.

**See:** `https://github.com/traebon/hot-config/blob/main/CLAUDE.md`,
section **"Keycloak SSO"**.

## Impact of Keycloak being down

New logins to PrivateNexus fail (OIDC redirect can't complete). Existing
authenticated sessions are unaffected until they expire (8h session cookie
lifetime). No PrivateNexus data is at risk — this is an availability
dependency, not a data dependency.

## Verify

`https://auth.house-of-trae.com/realms/privatenexus` should return the
realm's public OIDC discovery metadata (200).
