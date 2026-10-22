import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id } from '../core/util.js';
import { GhlClient, IMPORT_PARTS, importFromGhl, locationTokenFromAgency, probeGhl, type ImportPart, type ImportProgress } from '../services/ghl-import.js';

interface Job {
  id: string;
  locationId: string;
  status: 'running' | 'done' | 'failed';
  progress: ImportProgress;
  error?: string;
  startedAt: string;
}

/** Import jobs live in memory only: the GHL token is never written to disk. */
const jobs = new Map<string, Job>();

export const ghlImportModule: Module = {
  name: 'ghl-import',
  register(app) {
    const { router } = app;

    router.post('/api/import/ghl/probe', 'location', async (ctx) => {
      if (ctx.viaApiKey) throw new HttpError(403, 'Nur in der Oberfläche');
      const tokenStr = str(ctx.body.token, 'GHL-Token', { required: true });
      return probeGhl(new GhlClient(tokenStr), str(ctx.body.ghl_location_id, 'GHL-Location'));
    });

    router.post('/api/import/ghl', 'location', async (ctx) => {
      if (ctx.viaApiKey) throw new HttpError(403, 'Nur in der Oberfläche');
      let tokenStr = str(ctx.body.token, 'GHL-Token', { required: true });
      const ghlLoc = str(ctx.body.ghl_location_id, 'GHL-Location', { required: true });
      const parts = (Array.isArray(ctx.body.parts) && ctx.body.parts.length ? ctx.body.parts : IMPORT_PARTS).filter((p: string) => (IMPORT_PARTS as readonly string[]).includes(p)) as ImportPart[];
      if ([...jobs.values()].some((j) => j.locationId === ctx.locationId && j.status === 'running')) throw bad('Es läuft schon ein Import');
      if (ctx.body.company_id) {
        const minted = await locationTokenFromAgency(new GhlClient(tokenStr), ctx.body.company_id, ghlLoc);
        if (minted) tokenStr = minted;
      }
      const job: Job = { id: id(), locationId: ctx.locationId, status: 'running', progress: { part: 'start', done: 0, log: [], counts: {} }, startedAt: new Date().toISOString() };
      jobs.set(job.id, job);
      importFromGhl(app, ctx.locationId, new GhlClient(tokenStr), ghlLoc, parts, job.progress)
        .then(() => (job.status = 'done'))
        .catch((e) => {
          job.status = 'failed';
          job.error = (e as Error).message;
        });
      return { id: job.id };
    });

    router.get('/api/import/jobs/:id', 'location', (ctx) => {
      const job = jobs.get(ctx.params.id);
      if (!job || job.locationId !== ctx.locationId) throw notFound();
      return job;
    });
  },
};
