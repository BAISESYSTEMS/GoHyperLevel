# Security policy

HyperLevel stores customer data, credentials for e-mail, SMS, payment and AI providers, and runs on the
public internet. We take security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for security problems.**

Report privately through GitHub's security advisories:

1. Open the repository's **Security** tab → **Report a vulnerability**
   (`https://github.com/BAISESYSTEMS/GoHyperLevel/security/advisories/new`).
2. Describe the issue, the affected version (`GET /api/version`), steps to reproduce and the impact.
   A proof of concept is welcome; please use your own test instance and fictional data.

<a id="contact"></a>
### Contact

If you cannot use GitHub advisories, write to **security@gohyperlevel.com** (placeholder until the mailbox
is live – GitHub advisories are the preferred channel). This address is also the contact for Code of Conduct reports.

## What to expect

- Acknowledgement within **3 working days**, a first assessment within **10 working days**.
- We agree on a fix and a disclosure date with you; the default embargo is 90 days or until a fixed
  release is available, whichever comes first.
- Fixes ship as a new `0.0.N` release with a GitHub security advisory and a CHANGELOG entry. We credit
  reporters who want to be named.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest `0.0.N` release (and `main`) | ✅ security fixes |
| Older `0.0.N` releases | ❌ please update |
| Android app: latest `1.0.x` from your server's `/downloads/hyperlevel.apk` | ✅ |

Only the **latest release** receives security fixes. HyperLevel releases often (`0.0.N`, one step per
production deploy); please update before reporting and keep your installation current
(`docker compose pull && docker compose up -d`).

## Scope

In scope: the HyperLevel server and web app in this repository, the Android app in `android/`, the Docker
image, the install script and the example deployment files.

Out of scope: third-party services HyperLevel connects to (Stripe, Twilio, Meta, Google, Anthropic, Postiz,
OpenShorts …), denial of service through sheer request volume, findings that require a compromised admin
account or server, missing best-practice headers without a concrete impact, and the public demo instance's
fictional data (it is reset nightly and cannot send anything).

## Hardening checklist for self-hosters

- Serve HyperLevel only over HTTPS (the Caddy profile does this automatically) and keep `PGHL_BASE_URL`
  exact – webhook signatures (Twilio, Meta, Stripe) depend on it.
- Keep the data folder private and back it up: it holds the database and the `secret` that encrypts
  stored credentials (AES-256-GCM). Never commit `.env` or the data folder.
- Turn on two-factor login for every admin, give client logins only the areas they need, and review
  *Einstellungen → Sicherheit* (audit log, signed-in devices) regularly.
- Leave `PGHL_ALLOW_PRIVATE_FETCH` off unless you know you need webhooks into your private network.
