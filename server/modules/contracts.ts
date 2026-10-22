import type { App, Module } from '../core/app.js';
import { HttpError, bad, html, notFound, str } from '../core/http.js';
import { jsonForScript, messagePage, publicPage } from '../core/page.js';
import { escapeHtml, render } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import { id, now, sha256, token } from '../core/util.js';
import { contactVars, getContact, logActivity } from '../services/contacts.js';
import { notifyTeam, sendToContact } from '../services/messaging.js';

/**
 * Contracts with electronic signature: write (or start from a template), send a link, the client
 * reads, draws or types the signature and signs. The signed text is frozen with a hash and an audit trail.
 */

const SIG_MAX = 400 * 1024;

const inline = (s: string) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

/** Paragraphs, headings (#), lists (-) and **bold**; the rest is escaped. */
export function contractHtml(text: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
    para = [];
    list = [];
  };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    const li = line.match(/^\s*[-*•]\s+(.+)$/);
    if (!line.trim() || h) flush();
    if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
    else if (li) {
      if (para.length) flush();
      list.push(li[1]);
    } else if (line.trim()) {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join('\n');
}

function get(app: App, locationId: string, cid: string) {
  return app.db.get('SELECT * FROM contracts WHERE id = ? AND location_id = ?', cid, locationId);
}

function publicUrl(app: App, c: any) {
  return `${app.baseUrl()}/s/${c.public_token}`;
}

function auditHtml(app: App, c: any) {
  const loc = app.location(c.location_id)!;
  const when = (v: string) => (v ? formatInTz(v, loc.timezone, { weekday: undefined }) + ' Uhr' : '');
  const rows = [
    ['Gesendet', when(c.sent_at)],
    ['Geöffnet', when(c.viewed_at)],
    [c.status === 'declined' ? 'Abgelehnt' : 'Unterschrieben', when(c.signed_at)],
    ['Unterzeichner', c.signer_name ? `${c.signer_name}${c.signer_email ? ` (${c.signer_email})` : ''}` : ''],
    ['IP-Adresse', c.signer_ip],
    ['Dokument-Prüfsumme (SHA-256)', c.content_hash],
  ].filter(([, v]) => v);
  return `<table style="width:100%;font-size:13px;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 8px 4px 0;color:#6b7280;white-space:nowrap">${k}</td><td style="padding:4px 0;overflow-wrap:anywhere">${escapeHtml(v)}</td></tr>`).join('')}</table>`;
}

function signPage(app: App, c: any) {
  const loc = app.location(c.location_id)!;
  const signed = c.status === 'signed';
  const contact = c.contact_id ? getContact(app, c.location_id, c.contact_id) : undefined;
  const body = `<div class="wrap" style="max-width:820px"><div class="card contract">
  <div class="row" style="align-items:center;justify-content:space-between">
    <div>${loc.logo_url ? `<img src="${escapeHtml(loc.logo_url)}" alt="" style="max-height:44px">` : `<strong>${escapeHtml(loc.name)}</strong>`}</div>
    <div class="muted" style="text-align:right;font-size:13px">${escapeHtml(loc.name)}${loc.address ? `<br>${escapeHtml(loc.address)}` : ''}</div>
  </div>
  <h1 style="margin-top:24px">${escapeHtml(c.title)}</h1>
  <div class="doc">${contractHtml(c.content)}</div>
  ${
    signed
      ? `<div style="margin-top:28px;border-top:1px solid var(--line);padding-top:16px">
    <p><strong>Unterschrift</strong></p>
    <img src="${escapeHtml(c.signature)}" alt="Unterschrift" style="max-width:320px;max-height:120px;border-bottom:1px solid #111">
    <p style="margin:4px 0 16px">${escapeHtml(c.signer_name)}</p>
    ${auditHtml(app, c)}
    <p class="noprint" style="margin-top:18px"><button onclick="print()">Als PDF speichern / drucken</button></p>
  </div>`
      : c.status === 'declined'
        ? `<p class="error" style="margin-top:24px">Dieser Vertrag wurde abgelehnt.</p>`
        : c.status === 'void'
          ? `<p class="error" style="margin-top:24px">Dieser Vertrag ist nicht mehr gültig.</p>`
          : `<form id="sign" style="margin-top:28px;border-top:1px solid var(--line);padding-top:16px">
    <label for="n">Vollständiger Name</label><input id="n" name="name" required value="${escapeHtml(contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : '')}" autocomplete="name">
    <label style="margin-top:14px">Unterschrift <span class="muted" style="font-weight:400">(mit Maus oder Finger zeichnen)</span></label>
    <canvas id="pad" width="600" height="180" style="width:100%;max-width:600px;height:180px;border:1px dashed #9ca3af;border-radius:9px;background:#fff;touch-action:none;display:block"></canvas>
    <p style="margin:6px 0"><button type="button" class="btn secondary" id="clear" style="padding:6px 12px">Löschen</button></p>
    <label class="check" style="margin-top:12px"><input type="checkbox" name="agree" required> Ich habe den Vertrag gelesen und stimme ihm mit meiner elektronischen Unterschrift zu.</label>
    <div class="row" style="margin-top:16px"><button type="submit">Verbindlich unterschreiben</button><button type="button" class="btn secondary" id="decline">Ablehnen</button></div>
    <div class="error" id="err"></div>
  </form>
  <script>
  (function(){
    var T=${jsonForScript(c.public_token)},cv=document.getElementById('pad'),x=cv.getContext('2d'),draw=false,ink=false;
    x.lineWidth=2.4;x.lineCap='round';x.lineJoin='round';x.strokeStyle='#111';
    function pos(e){var r=cv.getBoundingClientRect();return [(e.clientX-r.left)*cv.width/r.width,(e.clientY-r.top)*cv.height/r.height]}
    cv.addEventListener('pointerdown',function(e){draw=true;cv.setPointerCapture(e.pointerId);var p=pos(e);x.beginPath();x.moveTo(p[0],p[1])});
    cv.addEventListener('pointermove',function(e){if(!draw)return;var p=pos(e);x.lineTo(p[0],p[1]);x.stroke();ink=true});
    cv.addEventListener('pointerup',function(){draw=false});
    document.getElementById('clear').onclick=function(){x.clearRect(0,0,cv.width,cv.height);ink=false};
    var f=document.getElementById('sign'),err=document.getElementById('err');
    async function post(path,data){var r=await fetch('/api/public/contracts/'+T+'/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});var j=await r.json();if(!r.ok)throw new Error(j.error||'Fehler');location.reload()}
    f.onsubmit=async function(e){e.preventDefault();err.textContent='';if(!ink){err.textContent='Bitte unterschreiben.';return}
      try{await post('sign',{name:f.name.value,agree:f.agree.checked,signature:cv.toDataURL('image/png')})}catch(x){err.textContent=x.message}};
    document.getElementById('decline').onclick=async function(){var why=prompt('Ablehnen – möchtest du uns einen Grund nennen? (optional)');if(why===null)return;try{await post('decline',{reason:why})}catch(x){err.textContent=x.message}};
  })();
  </script>`
  }
</div></div>`;
  const head = `<style>.doc{font-size:15px}.doc h2{font-size:19px;margin-top:22px}.doc h3{font-size:16px}@media print{.noprint{display:none}.card{box-shadow:none;border:0}body{background:#fff}}</style><meta name="robots" content="noindex">`;
  return publicPage({ title: c.title, body, head, color: loc.settings?.branding?.color || undefined });
}

/** A drawn signature as the sign page sends it: a PNG data URL of a sensible size. */
export const isSignatureImage = (sig: unknown): sig is string => typeof sig === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) && sig.length <= SIG_MAX;

/**
 * A contract that is signed at the moment it is made – the customer signs an offer on its own page (modules/quotes.ts). The record is
 * the one /s/:token signs: the frozen text with its SHA-256, signer, IP address, device and the drawn signature, so it shows in
 * "Verträge" and its page keeps the proof. The caller has checked the signature (isSignatureImage) and tells the team itself.
 */
export function createSignedContract(
  app: App,
  o: { locationId: string; contactId: string | null; title: string; content: string; signerName: string; signature: string; ip: string; userAgent: string },
): { id: string; token: string; url: string; hash: string } {
  const contact = o.contactId ? getContact(app, o.locationId, o.contactId) : undefined;
  const at = now();
  const row = {
    id: id(),
    location_id: o.locationId,
    kind: 'contract',
    contact_id: o.contactId,
    title: o.title.slice(0, 200),
    content: o.content.slice(0, 200_000),
    status: 'signed',
    public_token: token(24),
    sent_at: at,
    viewed_at: at,
    signed_at: at,
    signer_name: o.signerName.slice(0, 200),
    signer_email: contact?.email ?? '',
    signer_ip: o.ip,
    signer_ua: o.userAgent.slice(0, 300),
    signature: o.signature,
    content_hash: sha256(`${o.title.slice(0, 200)}\n\n${o.content.slice(0, 200_000)}`),
    created_at: at,
    updated_at: at,
  };
  app.db.insert('contracts', row);
  if (o.contactId) logActivity(app, o.locationId, o.contactId, 'contract.signed', `Vertrag „${row.title}“ unterschrieben`);
  app.events.emit(o.locationId, 'contract.signed', { contactId: o.contactId, contract: { id: row.id, title: row.title } });
  return { id: row.id, token: row.public_token, url: publicUrl(app, row), hash: row.content_hash };
}

export const contractsModule: Module = {
  name: 'contracts',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE contracts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'contract', contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', public_token TEXT NOT NULL UNIQUE,
        sent_at TEXT, viewed_at TEXT, signed_at TEXT, signer_name TEXT, signer_email TEXT, signer_ip TEXT, signer_ua TEXT,
        signature TEXT, content_hash TEXT, decline_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX contracts_loc ON contracts(location_id, kind, updated_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const out = (c: any, full = false) => {
      const { signature, ...rest } = c;
      return { ...rest, url: publicUrl(app, c), ...(full ? { signature } : {}) };
    };

    router.get('/api/contracts', 'location', (ctx) =>
      db
        .all(
          `SELECT k.*, c.first_name, c.last_name, c.email, c.company FROM contracts k LEFT JOIN contacts c ON c.id = k.contact_id
           WHERE k.location_id = ? AND k.kind = ? ORDER BY k.updated_at DESC LIMIT 500`,
          ctx.locationId,
          ctx.query.get('kind') === 'template' ? 'template' : 'contract',
        )
        .map((c) => out(c)),
    );
    router.get('/api/contracts/:id', 'location', (ctx) => {
      const c = get(app, ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      return { ...out(c, true), audit: c.status === 'signed' || c.status === 'declined' ? auditHtml(app, c) : '' };
    });
    router.post('/api/contracts', 'location', (ctx) => {
      const tpl = ctx.body.template_id ? get(app, ctx.locationId, String(ctx.body.template_id)) : undefined;
      if (ctx.body.template_id && !tpl) throw notFound('Vorlage nicht gefunden');
      const contactId = ctx.body.contact_id ? String(ctx.body.contact_id) : null;
      if (contactId && !getContact(app, ctx.locationId, contactId)) throw notFound('Kontakt nicht gefunden');
      const row = {
        id: id(),
        location_id: ctx.locationId,
        kind: ctx.body.kind === 'template' ? 'template' : 'contract',
        contact_id: contactId,
        title: str(ctx.body.title, 'Titel', { max: 200 }) || tpl?.title || 'Vertrag',
        content: ctx.body.content !== undefined ? str(ctx.body.content, 'Text', { max: 200_000 }) : (tpl?.content ?? ''),
        status: 'draft',
        public_token: token(24),
        created_at: now(),
        updated_at: now(),
      };
      db.insert('contracts', row);
      return out(row);
    });
    router.patch('/api/contracts/:id', 'location', (ctx) => {
      const c = get(app, ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body.status === 'void') {
        if (c.status === 'signed') throw bad('Unterschriebene Verträge bleiben unverändert');
        patch.status = 'void';
      } else {
        if (c.status !== 'draft') throw bad('Nach dem Versand lässt sich der Text nicht mehr ändern – neu anlegen oder stornieren');
        if (ctx.body.title !== undefined) patch.title = str(ctx.body.title, 'Titel', { required: true, max: 200 });
        if (ctx.body.content !== undefined) patch.content = str(ctx.body.content, 'Text', { max: 200_000 });
        if (ctx.body.contact_id !== undefined) {
          if (ctx.body.contact_id && !getContact(app, ctx.locationId, String(ctx.body.contact_id))) throw notFound('Kontakt nicht gefunden');
          patch.contact_id = ctx.body.contact_id || null;
        }
      }
      db.update('contracts', c.id, patch);
      return out(get(app, ctx.locationId, c.id));
    });
    router.delete('/api/contracts/:id', 'location', (ctx) => {
      const c = get(app, ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      if (c.kind === 'contract' && !['draft', 'void'].includes(c.status)) throw bad('Nur Entwürfe oder stornierte Verträge löschen');
      db.run('DELETE FROM contracts WHERE id = ?', c.id);
      return { ok: true };
    });
    router.post('/api/contracts/:id/send', 'location', async (ctx) => {
      const c = get(app, ctx.locationId, ctx.params.id);
      if (!c || c.kind !== 'contract') throw notFound();
      if (!c.contact_id) throw bad('Erst einen Kontakt wählen');
      if (['signed', 'declined', 'void'].includes(c.status)) throw bad('Dieser Vertrag ist abgeschlossen');
      const loc = app.location(ctx.locationId)!;
      const contact = getContact(app, ctx.locationId, c.contact_id)!;
      const vars = { contact: contactVars(contact), location: loc, contract: { title: c.title, url: publicUrl(app, c) } };
      // Placeholders are filled once, on the first send; afterwards the text is frozen.
      if (c.status === 'draft') db.update('contracts', c.id, { content: render(c.content, vars), title: render(c.title, vars), status: 'sent', sent_at: now(), updated_at: now() });
      const channel = ctx.body.channel === 'sms' ? 'sms' : 'email';
      const msg = await sendToContact(app, ctx.locationId, {
        contactId: contact.id,
        channel,
        subject: render(str(ctx.body.subject, 'Betreff', { max: 300 }) || 'Bitte unterschreiben: {{contract.title}}', vars),
        body: render(str(ctx.body.body, 'Nachricht', { max: 20_000 }) || 'Hallo {{contact.first_name|}},\n\nhier ist der Vertrag „{{contract.title}}“ zum Lesen und Unterschreiben:\n{{contract.url}}\n\nViele Grüße\n{{location.name}}', vars),
        userId: ctx.user?.id,
        source: 'Vertrag',
      });
      logActivity(app, ctx.locationId, contact.id, 'contract.sent', `Vertrag „${c.title}“ gesendet`);
      return { ...out(get(app, ctx.locationId, c.id)), message: { status: msg.status, error: msg.error } };
    });

    router.get('/s/:token', 'public', (ctx) => {
      const c = db.get('SELECT * FROM contracts WHERE public_token = ?', ctx.params.token);
      if (!c || c.kind !== 'contract' || c.status === 'draft') return html(messagePage('Nicht gefunden', 'Diesen Vertrag gibt es nicht.'), 404);
      if (c.status === 'sent') {
        db.run(`UPDATE contracts SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'`, now(), c.id);
        if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'contract.viewed', `Vertrag „${c.title}“ geöffnet`);
      }
      return html(signPage(app, c));
    });
    const open = (tok: string) => {
      const c = db.get('SELECT * FROM contracts WHERE public_token = ?', tok);
      if (!c || c.kind !== 'contract' || c.status === 'draft') throw notFound();
      if (!['sent', 'viewed'].includes(c.status)) throw new HttpError(409, 'Dieser Vertrag ist schon abgeschlossen');
      return c;
    };
    router.post('/api/public/contracts/:token/sign', 'public', (ctx) => {
      const c = open(ctx.params.token);
      const name = str(ctx.body.name, 'Name', { required: true, max: 200 });
      if (!ctx.body.agree) throw bad('Bitte der Unterschrift zustimmen');
      const sig = String(ctx.body.signature ?? '');
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length > SIG_MAX) throw bad('Unterschrift fehlt');
      const contact = c.contact_id ? getContact(app, c.location_id, c.contact_id) : undefined;
      const at = now();
      const hash = sha256(`${c.title}\n\n${c.content}`);
      const done = db.run(
        `UPDATE contracts SET status = 'signed', signed_at = ?, signer_name = ?, signer_email = ?, signer_ip = ?, signer_ua = ?, signature = ?, content_hash = ?, updated_at = ?
         WHERE id = ? AND status IN ('sent','viewed')`,
        at, name, contact?.email ?? '', ctx.ip, String(ctx.req.headers['user-agent'] ?? '').slice(0, 300), sig, hash, at, c.id,
      ).changes;
      if (!done) throw new HttpError(409, 'Dieser Vertrag ist schon abgeschlossen');
      if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'contract.signed', `Vertrag „${c.title}“ unterschrieben`);
      void notifyTeam(app, c.location_id, `Vertrag unterschrieben: ${c.title}`, `${name} hat „${c.title}“ unterschrieben.\n\n${publicUrl(app, c)}`);
      if (contact?.email)
        void sendToContact(app, c.location_id, {
          contactId: contact.id,
          channel: 'email',
          subject: `Deine Kopie: ${c.title}`,
          body: `Hallo ${name},\n\ndanke für deine Unterschrift. Hier kannst du den unterschriebenen Vertrag jederzeit ansehen und als PDF speichern:\n${publicUrl(app, c)}`,
          source: 'Vertrag',
          ignoreDnd: true,
        });
      app.events.emit(c.location_id, 'contract.signed', { contactId: c.contact_id, contract: { id: c.id, title: c.title } });
      return { ok: true };
    });
    router.post('/api/public/contracts/:token/decline', 'public', (ctx) => {
      const c = open(ctx.params.token);
      db.run(`UPDATE contracts SET status = 'declined', signed_at = ?, decline_reason = ?, signer_ip = ?, updated_at = ? WHERE id = ?`, now(), str(ctx.body.reason, 'Grund', { max: 2000 }), ctx.ip, now(), c.id);
      if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'contract.declined', `Vertrag „${c.title}“ abgelehnt`);
      void notifyTeam(app, c.location_id, `Vertrag abgelehnt: ${c.title}`, `Grund: ${ctx.body.reason || '–'}\n\n${publicUrl(app, c)}`);
      app.events.emit(c.location_id, 'contract.declined', { contactId: c.contact_id, contract: { id: c.id, title: c.title } });
      return { ok: true };
    });
  },
};
