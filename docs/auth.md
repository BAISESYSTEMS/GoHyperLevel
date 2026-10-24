# Sign-in, SSO & passkeys

HyperLevel signs people in with whatever the agency allows – on the main address, on the agency's own app
domain and on each client's white-label login domain:

| Method | What it is | Configure in |
| --- | --- | --- |
| E-mail + password | Classic login, optional authenticator-app 2FA with backup codes | on by default |
| Passkeys | WebAuthn: fingerprint, face or device PIN instead of a password; also usable as second factor | on by default |
| E-mail link | Passwordless "magic link": single use, valid 15 minutes, rate limited | Agency → Anmeldung |
| Google, Microsoft, GitHub, Apple | Social sign-in with account linking | Agency → Anmeldung (+ Integrationen for Google/Microsoft) |
| OpenID Connect SSO | Keycloak, Authentik, Authelia, Zitadel, Okta, Microsoft Entra ID, Google Workspace, any OIDC provider – with just-in-time accounts, group mapping and "enforce SSO" per e-mail domain | Agency → Anmeldung → Single Sign-on |
| SAML 2.0 | Not built in – connect SAML IdPs through an OIDC broker (see [SAML](#saml)) | – |

Everything lives under **Agentur → Anmeldung** (admins only). Secrets (client secrets, the Apple key) are
stored encrypted (AES-256-GCM with the key in `data/secret`) and never sent back to the browser.

## Redirect URIs

Every provider needs the redirect (callback) URI registered exactly as shown on the settings page:

```
https://<PGHL_BASE_URL>/auth/sso/<provider>/callback
```

`<provider>` is `google`, `microsoft`, `github`, `apple` or the short name ("slug") of an OIDC provider,
e.g. `https://crm.example.com/auth/sso/keycloak/callback`. When the agency app domain is live, its
address is listed as well – register both.

**Client login domains** (`crm.client.com`) don't need their own redirect URI: the provider sends the
browser back to the main address, which hands the result to the client domain (see
[how it works](#security-model)). You only register the one or two addresses above.

These routes are separate from the MCP OAuth server for ChatGPT/Claude.ai connectors (`/oauth/*`,
`/.well-known/oauth-*`), which is a different feature.

## Google

Uses the agency's Google OAuth app from **Agentur → Integrationen → Google & Microsoft (OAuth)** – the
same one the calendar sync uses ([setup](self-hosting.md#connect-google--microsoft-oauth)).

1. Google Cloud Console → *APIs & Services → Credentials* → your OAuth client (type *Web application*) →
   add `https://<base>/auth/sso/google/callback` to *Authorized redirect URIs*.
2. Consent screen scopes: `openid`, `email`, `profile` (sign-in asks for nothing else).
3. Agentur → Anmeldung → tick **Google** → Speichern.

Only addresses Google reports as `email_verified` are used for matching accounts.

## Microsoft (Entra ID, multi-tenant)

Uses the Microsoft app from Integrationen. Tenant `common` = work/school and personal accounts,
`organizations` = work accounts only, `consumers` = personal only, or a tenant ID for one company.

1. Entra admin center → *App registrations* → your app → *Authentication* → add the Web redirect URI
   `https://<base>/auth/sso/microsoft/callback`.
2. *Token configuration* → *Add optional claim* (ID token): `email` and `xms_edov` (e-mail domain owner
   verified).
3. Agentur → Anmeldung → tick **Microsoft**.

**Why `xms_edov`:** in Entra the `email` claim can be set by any tenant admin (the "nOAuth" problem).
HyperLevel therefore identifies Microsoft accounts by tenant + object ID and treats the e-mail as verified
only for personal Microsoft accounts or when `xms_edov` is true. Without it a work account still signs
in once linked, but is never matched to an existing account by e-mail alone.

## GitHub

1. GitHub → *Settings → Developer settings → OAuth Apps → New OAuth App* (or a GitHub App with "Request
   user authorization"). Callback URL: `https://<base>/auth/sso/github/callback`. OAuth Apps allow only
   one callback URL – use a GitHub App if you need the agency domain as well.
2. Copy client ID and generate a client secret; enter both under Agentur → Anmeldung → GitHub.

Scopes: `read:user user:email`. Only the **verified primary** e-mail counts.

## Apple

1. Apple Developer → *Certificates, IDs & Profiles*:
   - an **App ID** with *Sign in with Apple*,
   - a **Services ID** (this is the client ID, e.g. `com.example.login`) with *Sign in with Apple* →
     *Configure*: primary App ID, domain `crm.example.com`, return URL
     `https://<base>/auth/sso/apple/callback`,
   - a **Key** with *Sign in with Apple* → download the `.p8` file (only once!) and note the Key ID.
2. Agentur → Anmeldung → Apple: Services ID, Team ID (10 characters, top right in the developer portal),
   Key ID and the full content of the `.p8` file (`-----BEGIN PRIVATE KEY----- …`). <!-- oss-check: allow -->

HyperLevel signs the client secret itself (ES256 JWT, renewed per login). Apple posts the result back
(`form_post`) and sends the name only on the very first sign-in – it is stored with the linked account.
"Hide my e-mail" relay addresses work like any verified address.

## OpenID Connect (SSO)

**+ SSO-Anbieter** opens the provider form. Fields:

| Field | Meaning |
| --- | --- |
| Vorlage | Preset that fills scopes and the groups claim (Keycloak, Authentik, Authelia, Zitadel, Okta, Entra ID, Google Workspace, other) |
| Für | *Agentur* (all logins) or one client (sub-account) – see [client SSO](#client-sso-and-white-label-domains) |
| Name / Kurzname | Button label and the slug used in URLs (`/auth/sso/<slug>`, `/auth/sso/<slug>/callback`) |
| Issuer- oder Discovery-URL | The issuer (`https://sso.example.com/realms/acme`) or the full `…/.well-known/openid-configuration` URL. The discovered `issuer` must match exactly. |
| Client-ID / Client-Secret | From the IdP. Leave the secret empty for a public client (PKCE only). `client_secret_basic` is used unless the IdP only lists `client_secret_post`. |
| Scopes | Must contain `openid`; add `groups` where the IdP needs it |
| Claims | Where e-mail, name and groups come from. Dotted paths work (`realm_access.roles`), and so do keys like `urn:zitadel:iam:org:project:roles` (object keys become groups) |
| E-Mail vertrauen | Accept the e-mail without `email_verified` (Entra ID never sends it). Only for IdPs whose addresses you control. |
| Userinfo zusätzlich | Also read the userinfo endpoint (for IdPs that keep groups out of the ID token) |
| JIT | Create an account on first login |
| Anbieter prüft MFA | The IdP enforces MFA, so HyperLevel asks no extra second factor (otherwise users with authenticator 2FA confirm it after SSO). An `amr` claim with `mfa`/`otp`/`hwk`… counts as MFA, too. |
| Rolle & Sub-Accounts bei jedem Login übernehmen | Re-apply the group mapping on every login (never demotes the last admin) |
| Nur Mitglieder zugeordneter Gruppen | Refuse users without a matching group rule |
| SSO erzwingen für Domains | Addresses of these domains can only sign in through this provider – no password, no e-mail link, no passkey, no social login. One provider per domain. |
| Erlaubte Domains | Only these e-mail domains may use the provider (required for the Google Workspace preset) |
| Neue Konten | Default role, sub-accounts and areas for JIT accounts |
| Gruppen → Rolle & Sub-Accounts | Rules: group name → admin/member, sub-accounts. Admin if any matching rule says so; sub-accounts are the union of defaults and matching rules; areas likewise (a rule may grant all areas). |

**Testen** fetches discovery and the signing keys once – a quick check for typos before anyone signs in.
Users can start SSO from the login button, by typing an address of an enforced domain (the password field
turns into "Weiter mit …") or with a direct link `https://<base>/auth/sso/<slug>?next=/app/contacts`
(e.g. as an app tile in the IdP's portal).

The server fetches discovery, keys and tokens with the same protection as webhooks (no private/internal
addresses). If your IdP is only reachable on an internal network (e.g. `http://keycloak:8080` in the same
Docker network), set `PGHL_ALLOW_PRIVATE_FETCH=1`; the IdP's authorize page must still be reachable for the
browser. Plain `http://` issuers are only accepted when `PGHL_BASE_URL` itself is `http://` (local dev).

### Keycloak

Realm → *Clients → Create client*: type *OpenID Connect*, client ID `gohigh`, *Client authentication*
on, *Standard flow* on; *Valid redirect URIs* = the redirect URI. Credentials tab → client secret.
Groups: *Client scopes → gohigh-dedicated → Add mapper → Group Membership*, token claim name `groups`,
*Full group path* off. Issuer: `https://sso.example.com/realms/<realm>`. Roles instead of groups: claim
`realm_access.roles`.

### Authentik

*Applications → Providers → Create → OAuth2/OpenID Provider*: client type *Confidential*, redirect URI as
above, signing key = a certificate (RS256). Create an *Application* with slug `gohigh` using it.
Issuer: `https://auth.example.com/application/o/gohigh/`. Groups are in the `groups` claim by default.

### Authelia

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: gohigh
        client_name: HyperLevel
        client_secret: '$pbkdf2-sha512$…'   # authelia crypto hash generate
        public: false
        require_pkce: true
        pkce_challenge_method: S256
        redirect_uris: ['https://crm.example.com/auth/sso/authelia/callback']
        scopes: [openid, email, profile, groups]
        token_endpoint_auth_method: client_secret_basic
```

Issuer: your Authelia URL. Scopes in HyperLevel: `openid email profile groups`.

### Zitadel

Project → *New application* → *Web* → *Code* (PKCE). Redirect URI as above. In the project enable
*Assert Roles on Authentication* and add the scope `urn:zitadel:iam:org:project:roles`; the groups claim
is `urn:zitadel:iam:org:project:roles` (role keys become groups). Issuer: `https://<instance>.zitadel.cloud`.

### Okta

*Applications → Create App Integration → OIDC – Web Application*: sign-in redirect URI as above, grant
type *Authorization Code*. Authorization server (`default`) → *Claims → Add claim* `groups` (ID token,
filter e.g. "Matches regex .*"). Issuer: `https://<org>.okta.com/oauth2/default`, scopes
`openid email profile groups`.

### Microsoft Entra ID (as company SSO)

For a company directory use a separate single-tenant app registration (the social "Microsoft" button
is multi-tenant). Redirect URI (Web) as above, client secret, *Token configuration*: optional claim
`email` and *Add groups claim* (security groups → group object IDs). Issuer:
`https://login.microsoftonline.com/<tenant-id>/v2.0` (not `common`). Tick *E-Mail vertrauen* – it's your
own tenant. Group rules use the group object IDs.

### Google Workspace

OAuth client of type *Web application* in your Workspace's Google Cloud project (consent screen
*Internal*), redirect URI as above. Issuer `https://accounts.google.com`, and **allowed domains** = your
Workspace domain(s) – otherwise any Google account could sign in. Google sends no groups in the ID token.

### Client SSO and white-label domains

A provider set to one client (*Für: Kunde …*) can only ever create or sign in **members of that client
alone**: it can't grant admin rights or other sub-accounts, and it is never matched to the agency's
accounts or to people who also work for other clients – even if the IdP claims their e-mail address.
Its button always shows on that client's login domain; elsewhere it is reachable via e-mail discovery or
the direct link.

Under **Kunden-Logins** you choose per client what its login domain offers (password, passkey, e-mail
link and which providers). The login page on `crm.client.com` then shows exactly those buttons in the
client's branding.

## SAML

SAML 2.0 is not built in: secure XML signature verification (canonicalization, signature wrapping) would
need an XML security library, and HyperLevel ships without extra dependencies. Connect SAML identity providers
(ADFS, Shibboleth, older Okta/OneLogin setups …) through an OIDC broker – Keycloak (*Identity providers →
SAML v2.0*), Authentik (*SAML source*) or Zitadel – and add the broker as an OpenID Connect provider here.

## Passkeys

- **Register:** Einstellungen → Mein Konto → *Passkeys* → *Passkey hinzufügen*. Discoverable credentials,
  user verification preferred, attestation `none` (no device attestation is collected or trusted).
  ES256, RS256 and EdDSA keys are supported.
- **Sign in:** *Mit Passkey anmelden* on the login page – no e-mail needed. A passkey with user
  verification (PIN/biometrics) counts as two factors.
- **Second factor:** users with authenticator 2FA can confirm a password login with a passkey instead of
  the code. Admins under the 2FA duty who only have a passkey must use it after a password login.
- A passkey belongs to the domain it was created on (WebAuthn *rpId*): main address, agency domain and
  each client domain need their own. The list in Mein Konto shows the domain of each passkey.
- Signature counters are checked: a counter that goes backwards (a cloned authenticator) is refused.
  Synced passkeys (iCloud, Google) always report 0, which is fine.
- Lost device: remove the passkey in Mein Konto, or an admin resets all passkeys of a login
  (`POST /api/users/:id/passkeys/reset`).
- Android app: passkeys need WebAuthn support in the app's WebView; until then create and use them in
  the browser – the app's login offers the other methods.

## Magic links

When **Link per E-Mail** is on, the login page offers "Ohne Passwort: Link per E-Mail". The link
(`https://<domain>/app/?magic=…`) is valid **15 minutes** and **once**; it opens a confirmation step
("Weiter als …?"), so mail scanners that open links don't use it up. At most 3 links per address per
15 minutes (plus a per-IP limit); the answer never reveals whether an account exists. Users with
authenticator 2FA enter their code afterwards. The mail is sent through the e-mail settings of the
sub-account chosen under *E-Mail-Links senden über* (default: the client of the login domain, the
user's first sub-account, or the oldest one). In the Android app the link opens directly in the app
(App Link).

## Policies

| Setting | Effect |
| --- | --- |
| Anmeldearten | Password, passkeys and e-mail links can be switched off. At least one way in must stay on. |
| Admins brauchen einen zweiten Faktor | An admin without 2FA (authenticator or passkey) can sign in, but only reaches the setup screen until a factor exists. SSO logins from a provider that enforces MFA count. |
| Social-Login mit bestehenden Kunden-Logins verbinden | A social login with a verified e-mail joins the existing **member** account of that address. Admin accounts are never linked silently: the user confirms with the account's password (and 2FA). |
| Angemeldet bleiben (Tage) | Lifetime of new sessions (1–365, default 30). |
| Neue Konten beim ersten Login | *Geschlossen* (only existing logins), *Nur mit Einladung* (invite list, optional invite e-mail with a 14-day link) or *Erlaubte E-Mail-Domains*; new accounts are members with the chosen sub-accounts and areas. Applies to social logins and e-mail links; OIDC providers use their own JIT setting. The paid SaaS signup (`/signup`) is separate. |
| Kunden-Logins | Methods and buttons per client login domain. |

Accounts created by SSO or a link have no password; their owners can set one under Mein Konto. Linked
accounts can be added and removed there, but the last way in (password, linked account or passkey)
can't be removed.

**Break glass:** if an enforced SSO provider is down, start the server with
`PGHL_AUTH_BREAK_GLASS=1`: admins may sign in with their password again (SSO enforcement and the 2FA duty
are lifted for admins) and the settings page shows a warning. Remove it once fixed. Existing sessions
stay valid when you turn on SSO enforcement; sign people out under *Angemeldete Geräte* or wait for the
session lifetime. Signing someone out also ends the live streams their tabs keep open (Team-Chat, inbox, Canvas,
Living Boards, presence) – at once, an expired session within 20 seconds ([security](security.md#sign-in-and-sessions)).

## Android app

The app's WebView must not show Google's (or any provider's) sign-in page itself – Google blocks
embedded WebViews. HyperLevel never uses popups: the login button navigates, the app opens the provider in a
Custom Tab, and the login page inside the app polls for the result. After signing in, the Custom Tab
shows "Fast geschafft – zurück zur App"; the WebView is already signed in. Nothing is passed through
URLs, so this works without App Links on any self-hosted domain.

## Security model

- Authorization-code flow with **PKCE (S256)**, a random **state** (single use, 10 minutes) and an OIDC
  **nonce** checked in the ID token. Apple documents no PKCE; its code is bound to the signed client
  secret instead.
- **ID tokens** are verified with node:crypto against the provider's **JWKS** (RS256/384/512, PS256,
  ES256/384; `none` and HMAC are refused). Keys are cached for an hour; an unknown `kid` triggers at most
  one refetch per minute. Claims: `iss` (Microsoft: tenant-aware), `aud`/`azp`, `exp`, `nbf`, `iat`
  (max. 10 minutes old, 60 s clock skew), `sub`, `nonce`.
- The callback never signs a browser in by itself. It stores a short-lived **ticket bound to a random
  cookie** of the browser that started the flow; that browser redeems it (`POST /api/auth/sso/poll`).
  A stolen or forced callback URL can't log a victim into someone else's account (login CSRF), the
  client-domain hand-off needs no redirect URI per domain, and the Android Custom Tab works.
- Accounts are identified by provider + subject; e-mail matching only with verified addresses and the
  linking rules above. A client's IdP can't reach agency accounts.
- Every login, failure and link ends up in the audit log (Agentur → Protokoll); sessions record the method
  (`password`, `passkey`, `magic`, `sso:<provider>`) and whether it was multi-factor.

## API

Endpoints are listed in [docs/api.md](api.md#sign-in-sso--passkeys).
