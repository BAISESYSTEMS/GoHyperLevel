import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import { mayUseMailbox } from '../server/services/mailbox-access.js';
import { gmailToRemote, folderOf, visibleLabels } from '../server/services/mailbox-gmail.js';
import { graphToRemote } from '../server/services/mailbox-graph.js';
import {
  MailError,
  appendReference,
  bodyText,
  buildMime,
  canModify,
  canRead,
  canSend,
  composeBody,
  decodeText,
  formatAddress,
  mailScopes,
  mapLimit,
  missingMailScopes,
  newMessageId,
  parseAddresses,
  replySubject,
  withSignature,
} from '../server/services/mailbox-kit.js';
import { mergeChange } from '../server/services/mailbox-sync.js';
import { scopesFor } from '../server/services/oauth.js';

describe('scopes', () => {
  it('Gmail: modify + send for full access, readonly or send-only as fallbacks (openid email always)', () => {
    expect(mailScopes('google', 'full')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send']);
    expect(mailScopes('google', 'readonly')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']);
    expect(mailScopes('google', 'send')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/gmail.send']);
  });

  it('Graph: Mail.ReadWrite + Mail.Send + offline_access; the .Shared variants for shared mailboxes', () => {
    expect(mailScopes('microsoft', 'full')).toEqual(['openid', 'email', 'offline_access', 'Mail.ReadWrite', 'Mail.Send']);
    expect(mailScopes('microsoft', 'readonly')).toEqual(['openid', 'email', 'offline_access', 'Mail.Read']);
    expect(mailScopes('microsoft', 'send')).toEqual(['openid', 'email', 'offline_access', 'Mail.Send']);
    expect(mailScopes('microsoft', 'full', true)).toEqual(['openid', 'email', 'offline_access', 'Mail.ReadWrite.Shared', 'Mail.Send.Shared']);
  });

  it('checks what was really granted (Google lets people untick; Microsoft answers with URIs)', () => {
    const g = 'https://www.googleapis.com/auth/gmail';
    expect(missingMailScopes('google', 'full', false, `openid ${g}.modify`)).toEqual([]);
    expect(missingMailScopes('google', 'full', false, `openid ${g}.send`)).toEqual([`${g}.modify`]);
    expect(missingMailScopes('google', 'readonly', false, `${g}.readonly`)).toEqual([]);
    // modify covers reading and sending too
    expect(missingMailScopes('google', 'readonly', false, `${g}.modify`)).toEqual([]);
    expect(missingMailScopes('google', 'send', false, `${g}.modify`)).toEqual([]);
    expect(missingMailScopes('microsoft', 'full', false, 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send openid')).toEqual([]);
    expect(missingMailScopes('microsoft', 'full', false, 'Mail.Read openid')).toEqual(['Mail.ReadWrite']);
    expect(missingMailScopes('microsoft', 'full', true, 'Mail.ReadWrite')).toEqual(['Mail.ReadWrite.Shared']);
    // A refresh asks for what was granted (no scope list of its own).
    expect(scopesFor('microsoft', 'mail')).toEqual([]);
    expect(scopesFor('google', 'mail')).toEqual([]);
  });

  it('access levels map to abilities', () => {
    expect([canRead('full'), canModify('full'), canSend('full')]).toEqual([true, true, true]);
    expect([canRead('readonly'), canModify('readonly'), canSend('readonly')]).toEqual([true, false, false]);
    expect([canRead('send'), canModify('send'), canSend('send')]).toEqual([false, false, true]);
  });
});

describe('addresses, subjects, bodies', () => {
  it('parses address lists, groups and quoted names', () => {
    expect(parseAddresses('"Doe, John" <J@X.de>, k@y.de, Team: a@b.de, c@d.de;')).toEqual([
      { email: 'j@x.de', name: 'Doe, John' },
      { email: 'k@y.de', name: '' },
      { email: 'a@b.de', name: '' },
      { email: 'c@d.de', name: '' },
    ]);
    expect(parseAddresses('')).toEqual([]);
    expect(parseAddresses(undefined)).toEqual([]);
  });

  it('formats names safely: no quotes, brackets or line breaks', () => {
    expect(formatAddress({ email: 'a@b.de', name: 'Paul "Boss" <x>\r\nBcc: y@z.de' })).toBe('"Paul Boss x Bcc: y@z.de" <a@b.de>');
    expect(formatAddress({ email: 'a@b.de', name: '' })).toBe('a@b.de');
  });

  it('Re: once, also for AW: and Antw:', () => {
    expect(replySubject('Angebot')).toBe('Re: Angebot');
    expect(replySubject('Re: Angebot')).toBe('Re: Angebot');
    expect(replySubject('AW: Angebot')).toBe('AW: Angebot');
    expect(replySubject('RE[2]: Angebot')).toBe('RE[2]: Angebot');
    expect(replySubject('')).toBe('Re:');
    expect(replySubject('A\r\nB')).toBe('Re: A B');
  });

  it('keeps References within reason and adds the answered id once', () => {
    expect(appendReference('<a@x> <b@x>', 'c@x')).toBe('<a@x> <b@x> <c@x>');
    expect(appendReference('<a@x>', '<a@x>')).toBe('<a@x>');
    const many = Array.from({ length: 20 }, (_, i) => `<m${i}@x>`).join(' ');
    expect(appendReference(many, 'n@x').split(' ')).toHaveLength(10);
    expect(appendReference('', '')).toBe('');
  });

  it('message ids carry the mailbox domain', () => {
    expect(newMessageId('paul@firma.example')).toMatch(/^[0-9a-f-]{36}@firma\.example$/);
    expect(newMessageId('kaputt')).toMatch(/@gohigh\.invalid$/);
  });

  it('decodes bodies by charset and builds text/HTML with a signature', () => {
    expect(decodeText(Buffer.from('Grüße', 'latin1'), 'text/plain; charset=ISO-8859-1')).toBe('Grüße');
    expect(decodeText(Buffer.from('Grüße'), 'text/plain; charset=UTF-8')).toBe('Grüße');
    expect(decodeText(Buffer.from('x'), 'text/plain; charset=gibt-es-nicht')).toBe('x');
    expect(bodyText('', '<p>Hallo <b>Welt</b></p><script>x()</script>')).toBe('Hallo Welt');
    expect(bodyText('Klar\r\ntext', '<p>html</p>')).toBe('Klar\ntext');
    const c = composeBody('Zeile 1\n\nZeile 2 <b>', false);
    expect(c.html).toContain('<p>Zeile 1</p>');
    expect(c.html).toContain('&lt;b&gt;');
    expect(composeBody('<p>Fett <b>x</b></p>', true).text).toBe('Fett x');
    expect(withSignature({ text: 'Hi', html: '<p>Hi</p>' }, 'Paul\nFirma <GmbH>')).toEqual({ text: 'Hi\n\n-- \nPaul\nFirma <GmbH>', html: '<p>Hi</p>\n<p>-- <br>Paul<br>Firma &lt;GmbH&gt;</p>' });
    expect(withSignature({ text: 'Hi', html: 'h' }, '  ')).toEqual({ text: 'Hi', html: 'h' });
  });
});

describe('MIME for Gmail', () => {
  it('builds a message with threading headers, Bcc, umlauts and attachments', async () => {
    const mime = await buildMime({
      from: { email: 'paul@firma.example', name: 'Paul Müller' },
      to: [{ email: 'a@kunde.example', name: 'Änne' }],
      cc: [{ email: 'c@kunde.example', name: '' }],
      bcc: [{ email: 'geheim@intern.example', name: '' }],
      subject: 'Grüße\r\nBcc: boese@evil.example',
      text: 'Hallo Änne',
      html: '<p>Hallo Änne</p>',
      attachments: [{ filename: 'ä/b".txt', contentType: 'text/plain', content: Buffer.from('Inhalt') }],
      messageId: '<id1@firma.example>',
      inReplyTo: 'orig@kunde.example',
      references: '<r1@x> <orig@kunde.example>',
    });
    const raw = mime.toString();
    expect(raw).toMatch(/^Message-ID: <id1@firma\.example>$/m);
    expect(raw).toMatch(/^In-Reply-To: <orig@kunde\.example>$/m);
    expect(raw).toMatch(/^References: <r1@x> <orig@kunde\.example>$/m);
    expect(raw).toMatch(/^Bcc: geheim@intern\.example$/m);
    expect(raw).not.toMatch(/^Bcc: boese/m);
    const p = await simpleParser(mime);
    expect(p.subject).toBe('Grüße Bcc: boese@evil.example');
    expect(p.text).toContain('Hallo Änne');
    expect(p.html).toContain('<p>Hallo Änne</p>');
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0].filename).toBe('ä_b_.txt');
    expect(p.attachments[0].content.toString()).toBe('Inhalt');
    expect((p.from as any).value[0]).toMatchObject({ address: 'paul@firma.example', name: 'Paul Müller' });
  });
});

describe('queued changes', () => {
  it('newer wins; labels add up and cancel each other', () => {
    expect(mergeChange({ read: true }, { read: false, starred: true })).toEqual({ read: false, starred: true });
    expect(mergeChange({ addLabels: ['a', 'b'] }, { removeLabels: ['a'], addLabels: ['c'] })).toEqual({ addLabels: ['b', 'c'], removeLabels: ['a'] });
    expect(mergeChange({ removeLabels: ['a'] }, { addLabels: ['a'] })).toEqual({ addLabels: ['a'] });
    expect(mergeChange({ archived: true }, { archived: false })).toEqual({ archived: false });
  });
});

describe('Gmail message mapping', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  it('walks nested multiparts, prefers plain text, finds attachments and keeps the headers', () => {
    const m = gmailToRemote({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD', 'STARRED', 'Label_5', 'CATEGORY_UPDATES', 'IMPORTANT'],
      internalDate: String(Date.parse('2026-10-01T10:00:00Z')),
      snippet: 'Vorschau',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: '"Müller, Anna" <Anna@Kunde.example>' },
          { name: 'To', value: 'a@x.de, B <b@x.de>' },
          { name: 'Cc', value: 'c@x.de' },
          { name: 'Subject', value: 'Betreff' },
          { name: 'Message-ID', value: '<abc@kunde.example>' },
          { name: 'References', value: '<r@kunde.example>' },
        ],
        parts: [
          { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('Nur Text') } }, { mimeType: 'text/html', body: { data: b64('<p>Nur HTML</p>') } }] },
          { mimeType: 'application/pdf', filename: 'a.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="a.pdf"' }], body: { attachmentId: 'att1', size: 123 } },
          { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-ID', value: '<x>' }], body: { attachmentId: 'att2', size: 5 } },
        ],
      },
    });
    expect(m).toMatchObject({
      id: 'm1',
      threadId: 't1',
      internetId: 'abc@kunde.example',
      references: '<r@kunde.example>',
      folder: 'inbox',
      labels: ['Label_5', 'IMPORTANT'],
      from: { email: 'anna@kunde.example', name: 'Müller, Anna' },
      subject: 'Betreff',
      text: 'Nur Text',
      date: '2026-10-01T10:00:00.000Z',
      unread: true,
      starred: true,
      draft: false,
      partial: false,
    });
    expect(m.to.map((a) => a.email)).toEqual(['a@x.de', 'b@x.de']);
    expect(m.attachments).toEqual([
      { id: 'att1', name: 'a.pdf', type: 'application/pdf', size: 123, inline: false },
      { id: 'att2', name: 'logo.png', type: 'image/png', size: 5, inline: true },
    ]);
  });

  it('falls back to HTML text, and a minimal message is partial', () => {
    expect(gmailToRemote({ id: 'x', labelIds: [], payload: { mimeType: 'text/html', headers: [], body: { data: b64('<p>Hallo <a href="https://x.de">Link</a></p>') } } }).text).toBe('Hallo Link (https://x.de)');
    const min = gmailToRemote({ id: 'x', threadId: 't', labelIds: ['INBOX', 'UNREAD'], snippet: 's' });
    expect(min).toMatchObject({ partial: true, unread: true, folder: 'inbox' });
  });

  it('folder by label: trash and spam first, then draft, inbox, sent, else archive', () => {
    expect(folderOf(['TRASH', 'INBOX'])).toBe('trash');
    expect(folderOf(['SPAM'])).toBe('spam');
    expect(folderOf(['DRAFT', 'INBOX'])).toBe('drafts');
    expect(folderOf(['INBOX', 'SENT'])).toBe('inbox');
    expect(folderOf(['SENT'])).toBe('sent');
    expect(folderOf(['Label_1'])).toBe('archive');
    expect(visibleLabels(['INBOX', 'UNREAD', 'CATEGORY_SOCIAL', 'Label_1', 'IMPORTANT'])).toEqual(['Label_1', 'IMPORTANT']);
  });
});

describe('Graph message mapping', () => {
  const wk = { inbox: 'I', sentitems: 'S', drafts: 'D', archive: 'A' };
  it('maps folder, flags, categories, recipients and HTML bodies', () => {
    const m = graphToRemote(
      {
        id: 'g1',
        conversationId: 'c1',
        internetMessageId: '<x@outlook.example>',
        subject: 'Betreff',
        body: { contentType: 'html', content: '<p>Hallo <b>Welt</b></p>' },
        bodyPreview: 'Hallo Welt',
        from: { emailAddress: { address: 'Anna@Kunde.example', name: 'Anna' } },
        toRecipients: [{ emailAddress: { address: 'b@x.de', name: 'B' } }],
        receivedDateTime: '2026-10-01T10:00:00Z',
        isRead: false,
        isDraft: false,
        flag: { flagStatus: 'flagged' },
        categories: ['Rot'],
        hasAttachments: true,
        parentFolderId: 'A',
      },
      wk,
    );
    expect(m).toMatchObject({ id: 'g1', threadId: 'c1', internetId: 'x@outlook.example', folder: 'archive', folderId: 'A', labels: ['Rot'], from: { email: 'anna@kunde.example', name: 'Anna' }, text: 'Hallo Welt', unread: true, starred: true, draft: false, hasAttachments: true, date: '2026-10-01T10:00:00.000Z' });
    expect(graphToRemote({ id: 'd', isDraft: true, parentFolderId: 'D', toRecipients: [] }, wk)).toMatchObject({ folder: 'drafts', draft: true, from: { email: '' } });
    expect(graphToRemote({ id: 'o', parentFolderId: 'custom' }, wk).folder).toBe('other');
  });
});

describe('helpers', () => {
  it('limits concurrency and keeps the order', async () => {
    let running = 0;
    let max = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(max).toBe(2);
  });

  it('classifies provider errors: only network, rate limits and 5xx are worth retrying', () => {
    expect([0, 408, 429, 500, 503].every((s) => new MailError('x', s).transient)).toBe(true);
    expect([400, 401, 403, 404, 409].some((s) => new MailError('x', s).transient)).toBe(false);
  });

  it('personal mailboxes need the owner in a browser session or the app', () => {
    const personal = { scope: 'user', location_id: null, owner_user_id: 'u1', access: 'full' } as const;
    const user = { id: 'u1', email: '', name: '', role: 'member', locations: ['L'], permissions: null } as const;
    expect(mayUseMailbox({ locationId: 'L', user: user as any, via: 'session' }, personal as any)).toBe(true);
    expect(mayUseMailbox({ locationId: 'L', user: user as any, via: 'app' }, personal as any)).toBe(true);
    for (const via of ['api_key', 'agency_key', 'mcp'] as const) expect(mayUseMailbox({ locationId: 'L', user: user as any, via }, personal as any)).toBe(false);
    expect(mayUseMailbox({ locationId: 'L', user: { ...user, id: 'u2' } as any, via: 'session' }, personal as any)).toBe(false);
    const sub = { scope: 'location', location_id: 'L', owner_user_id: 'u1', access: 'readonly' } as const;
    expect(mayUseMailbox({ locationId: 'L', via: 'api_key' }, sub as any)).toBe(true);
    expect(mayUseMailbox({ locationId: 'M', via: 'api_key' }, sub as any)).toBe(false);
    expect(mayUseMailbox({ locationId: 'L', via: 'api_key' }, sub as any, 'send')).toBe(false);
    expect(mayUseMailbox({ locationId: 'L', via: 'api_key' }, { ...sub, access: 'send' } as any, 'read')).toBe(false);
    expect(mayUseMailbox({ locationId: '', via: 'api_key' }, sub as any)).toBe(false);
  });
});
