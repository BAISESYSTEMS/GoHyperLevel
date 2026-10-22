#!/usr/bin/env python3
"""
HyperLevel domain agent. Runs on the Docker host (entered from the `domain-agent` container with
nsenter) next to the host's nginx + certbot, and keeps one nginx site per custom domain:

  1. asks the app which domains it wants (funnel domains + the agency app domain),
  2. waits until a domain's DNS points at this server,
  3. writes /etc/nginx/sites-available/pghl-<domain> (proxy to the app), checks nginx, reloads,
  4. gets a Let's Encrypt certificate with certbot --nginx,
  5. reports the result back, so the app can show it.

It only ever touches files named pghl-*, never another site's config, and refuses a domain that
another site on the server already serves. Domains are validated before they reach any command,
and commands run without a shell.
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

APP_PORT = os.environ.get('PGHL_APP_PORT', '4700')
APP = os.environ.get('PGHL_APP_URL', f'http://127.0.0.1:{APP_PORT}')
TOKEN = os.environ.get('PGHL_AGENT_TOKEN', '')
SERVER_IPS = {ip.strip() for ip in os.environ.get('PGHL_SERVER_IP', '').split(',') if ip.strip()}
AVAILABLE = os.environ.get('PGHL_NGINX_AVAILABLE', '/etc/nginx/sites-available')
ENABLED = os.environ.get('PGHL_NGINX_ENABLED', '/etc/nginx/sites-enabled')
LIVE = os.environ.get('PGHL_LETSENCRYPT_LIVE', '/etc/letsencrypt/live')
INTERVAL = int(os.environ.get('PGHL_AGENT_INTERVAL', '60'))
RETRY_AFTER_ERROR = int(os.environ.get('PGHL_AGENT_RETRY', '1800'))
ONCE = os.environ.get('PGHL_AGENT_ONCE') == '1'
MARK = '# managed by gohigh domain agent'
# Files written by earlier versions carry the project's former name; they stay ours.
MARKS = (MARK, '# managed by private-ghl domain agent')
DOMAIN_RE = re.compile(r'^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')

last_attempt = {}


def log(*a):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *a, flush=True)


def api(path, body=None):
    req = urllib.request.Request(
        APP + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'x-agent-token': TOKEN, 'content-type': 'application/json'},
        method='POST' if body is not None else 'GET',
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read() or b'{}')


def report(domain, status, message=''):
    try:
        api('/api/agent/domains/report', {'domain': domain, 'status': status, 'message': message[-1500:]})
    except Exception as e:  # the app may be restarting
        log('report failed', domain, e)


def resolves_here(domain):
    try:
        ips = {ai[4][0] for ai in socket.getaddrinfo(domain, 443, proto=socket.IPPROTO_TCP)}
    except socket.gaierror:
        return False, set()
    return (bool(ips & SERVER_IPS) if SERVER_IPS else bool(ips)), ips


def site_file(domain):
    return os.path.join(AVAILABLE, f'pghl-{domain}')


def served_elsewhere(domain):
    """True when a site this agent doesn't manage already has the domain in its server_name."""
    for name in os.listdir(ENABLED):
        if name.startswith('pghl-'):
            continue
        path = os.path.join(ENABLED, name)
        try:
            with open(path, encoding='utf-8', errors='ignore') as f:
                conf = f.read()
        except OSError:
            continue
        for m in re.finditer(r'server_name\s+([^;]+);', conf):
            if domain in m.group(1).split():
                return True
    return False


def current_names(domain):
    try:
        with open(site_file(domain), encoding='utf-8') as f:
            for line in f:
                if line.startswith('# names:'):
                    return line[len('# names:'):].split()
    except OSError:
        pass
    return None


def has_tls(domain):
    try:
        with open(site_file(domain), encoding='utf-8') as f:
            conf = f.read()
    except OSError:
        return False
    return 'ssl_certificate' in conf and os.path.exists(os.path.join(LIVE, domain, 'fullchain.pem'))


def write_site(domain, names):
    conf = f"""{MARK}
# names: {' '.join(names)}
server {{
    listen 80;
    listen [::]:80;
    server_name {' '.join(names)};
    client_max_body_size 20m;
    location / {{
        proxy_pass http://127.0.0.1:{APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }}
}}
"""
    with open(site_file(domain), 'w', encoding='utf-8') as f:
        f.write(conf)
    link = os.path.join(ENABLED, f'pghl-{domain}')
    if not os.path.lexists(link):
        os.symlink(site_file(domain), link)


def remove_site(domain):
    for p in (os.path.join(ENABLED, f'pghl-{domain}'), site_file(domain)):
        if os.path.lexists(p):
            os.remove(p)


def run(cmd, timeout=300):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return r.returncode == 0, (r.stdout + r.stderr).strip()


def nginx_reload():
    ok, out = run(['nginx', '-t'], 60)
    if not ok:
        return False, out
    ok, out2 = run(['nginx', '-s', 'reload'], 60)
    return ok, out2


def ensure(entry):
    domain = entry.get('domain', '')
    if not DOMAIN_RE.match(domain):
        return
    ok_dns, ips = resolves_here(domain)
    if not ok_dns:
        want = ', '.join(sorted(SERVER_IPS)) or 'diesen Server'
        report(domain, 'pending_dns', f"DNS zeigt noch nicht auf {want} (gefunden: {', '.join(sorted(ips)) or 'nichts'})")
        return
    if served_elsewhere(domain):
        report(domain, 'error', 'Die Domain ist auf dem Server schon von einer anderen Seite belegt.')
        return
    names = [domain]
    alias = entry.get('alias')
    if alias and DOMAIN_RE.match(alias) and resolves_here(alias)[0] and not served_elsewhere(alias):
        names.append(alias)

    if current_names(domain) == names and has_tls(domain):
        if entry.get('status') != 'active':
            report(domain, 'active', 'HTTPS aktiv: ' + ', '.join(names))
        return
    if time.time() - last_attempt.get(domain, 0) < RETRY_AFTER_ERROR and entry.get('status') == 'error':
        return
    last_attempt[domain] = time.time()

    log('setting up', names)
    write_site(domain, names)
    ok, out = nginx_reload()
    if not ok:
        remove_site(domain)
        nginx_reload()
        report(domain, 'error', 'nginx-Konfiguration abgelehnt: ' + out)
        return
    cmd = ['certbot', '--nginx', '--non-interactive', '--agree-tos', '--register-unsafely-without-email', '--redirect', '--keep-until-expiring', '--expand']
    for n in names:
        cmd += ['-d', n]
    ok, out = run(cmd)
    if ok and has_tls(domain):
        nginx_reload()
        report(domain, 'active', 'HTTPS aktiv: ' + ', '.join(names))
        log('active', names)
    else:
        report(domain, 'error', 'Zertifikat fehlgeschlagen: ' + out)
        log('certbot failed', names, out[-400:])


def cleanup(wanted):
    for name in os.listdir(AVAILABLE):
        if not name.startswith('pghl-'):
            continue
        domain = name[len('pghl-'):]
        with open(os.path.join(AVAILABLE, name), encoding='utf-8', errors='ignore') as f:
            text = f.read()
            if not any(m in text for m in MARKS):
                continue
        if domain not in wanted:
            log('removing', domain)
            remove_site(domain)
            nginx_reload()
            report(domain, 'removed')


def loop():
    if not TOKEN:
        log('PGHL_AGENT_TOKEN fehlt')
        sys.exit(1)
    log('domain agent started; app', APP, 'server ip', ','.join(sorted(SERVER_IPS)) or '?')
    while True:
        try:
            data = api('/api/agent/domains')
            entries = data.get('domains', [])
            for e in entries:
                try:
                    ensure(e)
                except Exception as ex:
                    log('error', e.get('domain'), ex)
                    report(e.get('domain', ''), 'error', str(ex))
            cleanup({e.get('domain') for e in entries})
        except Exception as ex:
            log('app not reachable:', ex)
        if ONCE:
            return
        time.sleep(INTERVAL)


if __name__ == '__main__':
    loop()
