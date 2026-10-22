import type { App, Module } from '../core/app.js';
import { HttpError, bad, str } from '../core/http.js';
import { callRoute } from '../services/route-call.js';
import type { Tool } from './mcp.js';

/**
 * Kurse per KI erstellen – docs/courses.md#create-a-course-with-ai. A topic (and optionally audience, number of modules and lessons)
 * becomes an outline with lesson texts through `app.services.aiRun`; nothing is saved until "Kurs anlegen" creates it as a draft
 * course with unpublished lessons through the normal course routes (so undo, audit and limits apply).
 */

const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    modules: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, lessons: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, duration_min: { type: 'integer' } }, required: ['title', 'body'] } } },
        required: ['title', 'lessons'],
      },
    },
  },
  required: ['title', 'modules'],
  additionalProperties: false,
};

export interface Outline {
  title: string;
  description: string;
  modules: { title: string; lessons: { title: string; body: string; duration_min: number }[] }[];
}

/** Checks and clips an outline (from the model or edited by the team). */
export function cleanOutline(v: any): Outline | null {
  const title = String(v?.title ?? '').trim().slice(0, 160);
  const modules = (Array.isArray(v?.modules) ? v.modules : [])
    .slice(0, 12)
    .map((m: any) => ({
      title: String(m?.title ?? '').trim().slice(0, 160),
      lessons: (Array.isArray(m?.lessons) ? m.lessons : [])
        .slice(0, 12)
        .map((l: any) => ({ title: String(l?.title ?? '').trim().slice(0, 160), body: String(l?.body ?? '').slice(0, 20_000), duration_min: Math.min(240, Math.max(1, Math.round(Number(l?.duration_min) || 10))) }))
        .filter((l: any) => l.title),
    }))
    .filter((m: any) => m.title && m.lessons.length);
  if (!title || !modules.length) return null;
  return { title, description: String(v?.description ?? '').slice(0, 2000), modules };
}

const readJson = (text: string) => {
  const s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    try {
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }
};

export const courseAiModule: Module = {
  name: 'course-ai',
  register(app: App) {
    const { router } = app;

    router.post('/api/course-ai/outline', 'location', async (ctx) => {
      const topic = str(ctx.body?.topic, 'Thema', { required: true, max: 500 });
      const audience = str(ctx.body?.audience, 'Zielgruppe', { max: 300 });
      const modules = Math.min(8, Math.max(2, Math.round(Number(ctx.body?.modules) || 4)));
      const lessons = Math.min(6, Math.max(1, Math.round(Number(ctx.body?.lessons_per_module) || 3)));
      if (!app.services.aiRun) throw new HttpError(409, 'Der KI-Assistent ist nicht verfügbar');
      const r = await app.services.aiRun({
        locationId: ctx.locationId,
        purpose: 'course_ai',
        system: [{ text: 'Du bist Kurs-Designer für Online-Kurse kleiner Unternehmen. Erstelle einen praxisnahen Kurs: klare Lernziele, kurze Lektionen mit Übung am Ende, verständliche Sprache. Lektionstexte in Markdown (Überschriften, Listen), 150–400 Wörter. Erfinde keine Fakten über das Unternehmen. Antworte als JSON nach dem Schema.' }],
        user: `Thema: ${topic}\n${audience ? `Zielgruppe: ${audience}\n` : ''}Module: ${modules}, je ${lessons} Lektionen. Sprache: Deutsch.`,
        schema: OUTLINE_SCHEMA,
        maxTokens: 12_000,
        timeoutMs: 180_000,
        userId: ctx.user?.id ?? null,
      });
      const outline = cleanOutline(readJson(r.text));
      if (!outline) throw new HttpError(502, 'Die KI hat keinen brauchbaren Kursentwurf geliefert – bitte noch einmal versuchen');
      return outline;
    });

    router.post('/api/course-ai/create', 'location', async (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const o = cleanOutline(ctx.body?.outline);
      if (!o) throw bad('Kursentwurf fehlt oder ist leer');
      const course = await callRoute(app, ctx, 'POST', '/api/courses', { title: o.title, description: o.description });
      let n = 0;
      for (const m of o.modules) {
        const mod = await callRoute(app, ctx, 'POST', `/api/courses/${course.id}/modules`, { title: m.title });
        for (const l of m.lessons) {
          await callRoute(app, ctx, 'POST', `/api/courses/${course.id}/lessons`, { module_id: mod.id, title: l.title, body: l.body, duration_min: l.duration_min, published: false });
          n++;
        }
      }
      return { id: course.id, title: course.title, modules: o.modules.length, lessons: n };
    });

    const TOOLS: Tool[] = [
      {
        name: 'ghl_course_ai_outline',
        title: 'Kursentwurf per KI',
        description: 'Erstellt per KI einen Kursentwurf (Titel, Beschreibung, Module, Lektionen mit Text in Markdown) zu einem Thema. Speichert nichts – zum Anlegen ghl_course_ai_create mit dem Entwurf aufrufen. Kostet einen KI-Aufruf.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, topic: { type: 'string' }, audience: { type: 'string' }, modules: { type: 'integer', minimum: 2, maximum: 8 }, lessons_per_module: { type: 'integer', minimum: 1, maximum: 6 } }, required: ['location_id', 'topic'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: (call, a) => call.api('POST', '/api/course-ai/outline', { location: a.location_id, body: { topic: a.topic, audience: a.audience, modules: a.modules, lessons_per_module: a.lessons_per_module } }),
      },
      {
        name: 'ghl_course_ai_create',
        title: 'Kurs aus KI-Entwurf anlegen',
        description: 'Legt einen Kursentwurf (aus ghl_course_ai_outline, ggf. bearbeitet) als Entwurfskurs mit unveröffentlichten Lektionen an.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, outline: { type: 'object' } }, required: ['location_id', 'outline'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: (call, a) => call.api('POST', '/api/course-ai/create', { location: a.location_id, body: { outline: a.outline } }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
