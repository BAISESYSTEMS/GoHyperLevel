import type { Module } from '../core/app.js';
import { bad, str, type Ctx } from '../core/http.js';
import { bodyLocation, callRoute } from '../services/mobile.js';

/**
 * "Teilen" from the phone into the CRM (iOS share extension, Android share target – docs/apps.md#share): a link, a text or a
 * file (picture or PDF, like every upload) becomes a task in the chosen sub-account, the file stored in its uploads. Runs the
 * regular routes in-process (validation, events and audit log as in the web app).
 */
export const appShareModule: Module = {
  name: 'app-share',
  register(app) {
    app.router.post('/api/mobile/share', 'user', async (ctx: Ctx) => {
      ctx.skipAfterWrite = true;
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      const link = str(b.url, 'url', { max: 2000 });
      if (link && !/^https?:\/\//i.test(link)) throw bad('url muss mit http(s):// beginnen');
      const note = str(b.text, 'text', { max: 5000 });
      let fileUrl = '';
      let fileName = '';
      if (b.file) {
        fileName = str(b.file.name, 'Dateiname', { required: true, max: 200 });
        const mime = str(b.file.mime, 'mime', { required: true, max: 100 });
        const data = String(b.file.data ?? '');
        if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) throw bad('file.data: Base64');
        const up = await callRoute(app, ctx, 'POST', '/api/uploads', { locationId: loc.id, body: { name: fileName, data: `data:${mime};base64,${data.replace(/\s+/g, '')}` } });
        fileUrl = String(up.url);
      }
      if (!link && !note && !fileUrl) throw bad('Nichts zum Teilen (url, text oder file)');
      const title = str(b.title, 'Titel', { max: 200 }) || fileName || link.replace(/^https?:\/\//, '').slice(0, 120) || note.slice(0, 120);
      const description = [note, link, fileUrl && `Datei: ${fileUrl}`].filter(Boolean).join('\n\n');
      const task = await callRoute(app, ctx, 'POST', '/api/tasks', { locationId: loc.id, body: { title: `Geteilt: ${title}`.slice(0, 300), description, contact_id: b.contact_id || null } });
      return { ok: true, task_id: task.id, file_url: fileUrl || null };
    });
  },
};
