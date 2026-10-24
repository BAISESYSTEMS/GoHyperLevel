# HyperLevel documentation website

The source of [docs.gohyperlevel.com](https://docs.gohyperlevel.com) (Astro + Starlight). The pages themselves live in
[`../docs/`](../docs/README.md) – edit them there; `scripts/sync-docs.mjs` turns them into the site on every build:

- `docs/<page>.md` is English (the default), `docs/<page>.de.md` the German version behind the language switcher,
- the sidebar comes from `docs/README.md` and `docs/README.de.md`,
- links between pages become site URLs, links outside `docs/` point to GitHub.

Every push to `main` that touches the docs publishes the site on GitHub Pages (`.github/workflows/docs.yml`).

```bash
cd docs-site
npm ci
npm run dev     # http://localhost:4321
npm run build   # static site in dist/
```
