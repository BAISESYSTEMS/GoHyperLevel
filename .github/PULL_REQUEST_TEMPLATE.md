## What and why

<!-- What does this change do, and which problem does it solve? Link issues: Fixes #123 -->

## How to test

<!-- Steps a reviewer can follow; screenshots (light/dark, mobile width) for UI changes -->

## Checklist

- [ ] `npm run typecheck`, `npm test` and `npm run build` pass locally
- [ ] New behaviour is covered by tests (signatures, parsing, permissions, state changes)
- [ ] A new feature lives in its own module/page and plugs in through the registries (`app.services`, `modules/index.ts`, `permissions.ts`) – see CONTRIBUTING.md
- [ ] No secrets, real customer data or private hostnames (`npm run oss:check`)
- [ ] New dependencies (if any) have AGPL-compatible licenses (`npm run licenses`)
- [ ] `CHANGELOG.md` (`## [Unreleased]`), `README.md` and `docs/` updated where users notice the change
- [ ] Modals have a ✕ and close on Esc; new screens have `data-tour` attributes
- [ ] I have signed the [CLA](../CLA.md) (the CLA Assistant asks on your first pull request)
