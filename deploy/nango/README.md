# Self-hosted Nango for HyperLevel (optional)

HyperLevel's **Nango** connector works with [Nango Cloud](https://nango.dev) (`https://api.nango.dev`) or
with a Nango instance you run yourself. This folder explains the second option with the `nango`
profile of the repository's `docker-compose.yml`. What the connector does and who sets up what:
[docs/nango.md](../../docs/nango.md).

## Licence – read this first

- Nango is published under the **Elastic License 2.0 (ELv2)**: source-available, **not** an OSI open
  source licence. HyperLevel itself is AGPL-3.0 and contains **no Nango code**; the compose profile only
  pulls the official `nangohq/nango-server` image from Docker Hub.
- ELv2 forbids offering Nango *itself* to third parties as a hosted or managed service, and
  circumventing its licence-key features. Using Nango as the auth backend of your own HyperLevel
  installation is its normal use – but you are responsible for checking the licence for your setup
  (for example if you run HyperLevel as a SaaS for other agencies). Full text:
  <https://github.com/NangoHQ/nango/blob/master/LICENSE>.
- The **free self-hosted edition** includes **Auth + Proxy** only – exactly what HyperLevel uses.
  Syncs, actions, **webhooks**, triggers and Nango's MCP server need Nango Cloud or an Enterprise
  licence. Without webhooks HyperLevel checks the connection list when the user comes back from the
  sign-in (and on „Aktualisieren“).

## Start

1. Add to `.env` (next to `docker-compose.yml`):

   ```bash
   NANGO_ENCRYPTION_KEY=$(openssl rand -base64 32)   # paste the value; never change it afterwards
   NANGO_DB_PASSWORD=<long random password>
   NANGO_DASHBOARD_PASSWORD=<password for the Nango dashboard (basic auth)>
   NANGO_SERVER_URL=https://nango.example.com            # public URL of the API
   NANGO_PUBLIC_CONNECT_URL=https://connect.nango.example.com
   ```

   Without `NANGO_ENCRYPTION_KEY` Nango stores credentials unencrypted and its Connect UI does not work;
   without `NANGO_DB_PASSWORD` the database container does not start.

2. `docker compose --profile nango up -d` – starts `nango-server` (API on port 3003, Connect UI on 3009,
   both bound to `127.0.0.1`), `nango-db` (Postgres 16, volume `nango-db`) and `nango-redis`.

3. Put both ports behind your HTTPS proxy. With the bundled Caddy, add to `deploy/caddy/Caddyfile`:

   ```
   nango.example.com {
   	reverse_proxy nango-server:3003
   }
   connect.nango.example.com {
   	reverse_proxy nango-server:3009
   }
   ```

   OAuth providers redirect to `NANGO_SERVER_URL/oauth/callback`, so the API must be reachable over
   public HTTPS. The dashboard is on the same host (basic auth, sign-up disabled); keep the password
   strong or restrict the dashboard path in your proxy.

4. In the Nango dashboard (`https://nango.example.com`, user `admin` or `NANGO_DASHBOARD_USERNAME`):
   copy the **secret key** of the environment you want to use (Environment Settings), then create one
   **integration per provider** with your own OAuth app (client id/secret; callback URL
   `https://nango.example.com/oauth/callback`).

5. In HyperLevel: **Agentur → Integrationen → Einrichtung → Nango** → „Selbst gehostet“, address and
   secret key, **Verbindung testen**. Two ways to reach the instance:
   - the public URL (`https://nango.example.com`) – nothing else to set, or
   - inside the Docker network: `http://nango-server:3003` and tick **„Internes Netz erlauben“**
     (HyperLevel blocks internal addresses unless an agency admin allows them). The browser still uses
     the public URLs Nango generates (`NANGO_SERVER_URL`, `NANGO_PUBLIC_CONNECT_URL`).

## Updates and backups

`docker compose --profile nango pull && docker compose --profile nango up -d`. Pin a version with
`NANGO_IMAGE=nangohq/nango-server:<tag>` if you prefer controlled upgrades. Back up the `nango-db`
volume together with `NANGO_ENCRYPTION_KEY` – one is useless without the other.
