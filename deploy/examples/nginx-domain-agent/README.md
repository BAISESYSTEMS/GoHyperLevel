# nginx domain agent (optional)

For servers where **nginx + certbot run on the host** and you don't want Caddy or Traefik. HyperLevel lists the
domains it wants (funnel/website domains with their `www` partner, the agency app domain, client login
domains); the agent

1. asks the app every 60 s (`GET /api/agent/domains`, header `x-agent-token`),
2. waits until a domain's DNS points at `PGHL_SERVER_IP`,
3. writes `/etc/nginx/sites-available/pghl-<domain>` (proxy to the app), runs `nginx -t` and reloads,
4. gets a Let's Encrypt certificate with `certbot --nginx` and reports the result (visible under *Agentur → Domains*).

It only touches files named `pghl-*`, refuses domains another site on the server already serves, validates
every domain against a strict pattern and runs commands without a shell. Removed domains are cleaned up.

| Variable | Meaning |
| --- | --- |
| `PGHL_AGENT_TOKEN` | Shared secret between HyperLevel and the agent (set it for both) |
| `PGHL_SERVER_IP` | Public IP(s) of the server, comma-separated – also shown to customers as DNS target |
| `PGHL_APP_PORT` | Port HyperLevel listens on at the host (default 4700) |
| `PGHL_AGENT_PREFIX` | File prefix of this agent's nginx sites (default `pghl-`) – give a second instance on the same host its own prefix (e.g. `ghyl-`), so neither agent removes the other's sites |

Start: `docker compose -f docker-compose.yml -f deploy/examples/nginx-domain-agent/compose.yaml up -d`.
With Caddy (`--profile caddy`) you don't need this – it issues certificates for custom domains on demand.
