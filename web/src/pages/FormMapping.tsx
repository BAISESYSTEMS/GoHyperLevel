import { useEffect, useState } from 'react';
import { api } from '../api';
import { Check, Field, Select } from '../ui';
import { useT } from '../i18n';

/**
 * Formulare: ein Feld zusätzlich in eine Firma, einen Deal oder ein eigenes Objekt schreiben (docs/forms.md#field-mapping).
 * Die Zuordnung steht in settings.mapping; der Server prüft sie beim Speichern (modules/form-mapping.ts).
 */

interface Targets {
  company: { key: string; label: string }[];
  opportunity: { key: string; label: string }[];
  objects: { key: string; label: string; properties: { key: string; label: string }[] }[];
  pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[];
}

const cache = new Map<string, Promise<Targets>>();
const targetsOf = (formId: string) => {
  let p = cache.get(formId);
  if (!p) {
    p = api.get<any>(`/api/forms/${formId}/mapping`).then((r) => r.targets as Targets);
    p.catch(() => cache.delete(formId));
    cache.set(formId, p);
  }
  return p;
};

const NO_ANSWER = ['heading', 'page_break', 'payment', 'file', 'signature'];

export function FormMapPicker({ formId, field, s, setS }: { formId: string; field: any; s: any; setS: (patch: any) => void }) {
  const t = useT('formmap');
  const [targets, setTargets] = useState<Targets>();
  useEffect(() => {
    let live = true;
    targetsOf(formId).then((x) => live && setTargets(x), () => undefined);
    return () => void (live = false);
  }, [formId]);
  if (NO_ANSWER.includes(field.type)) return null;
  const mapping = s.mapping ?? { fields: {} };
  const cur = mapping.fields?.[field.id];
  const which = cur ? (cur.target === 'object' ? `object:${cur.object}` : cur.target) : '';
  const setMapping = (next: any) => setS({ mapping: Object.keys(next.fields ?? {}).length ? next : null });
  const setEntry = (entry: any) => {
    const fields = { ...(mapping.fields ?? {}) };
    if (entry) fields[field.id] = entry;
    else delete fields[field.id];
    setMapping({ ...mapping, fields });
  };
  const keyOptions: [string, string][] = !targets
    ? []
    : which === 'company'
      ? targets.company.map((x) => [x.key, x.label])
      : which === 'opportunity'
        ? targets.opportunity.map((x) => [x.key, x.label])
        : which.startsWith('object:')
          ? (targets.objects.find((o) => o.key === which.slice(7))?.properties ?? []).map((x) => [x.key, x.label])
          : [];
  const deal = mapping.deal ?? {};
  const pipelineId = deal.pipeline_id || s.pipeline_id || targets?.pipelines[0]?.id || '';
  const pipe = targets?.pipelines.find((p) => p.id === pipelineId);
  const setDeal = (patch: any) => setMapping({ ...mapping, deal: { mode: 'new', ...deal, pipeline_id: pipelineId, ...patch } });

  return (
    <div className="form-map">
      <Field label={t('Zusätzlich speichern in')} hint={t('Firma, Deal oder eigenes Objekt des Kontakts')}>
        <Select
          value={which}
          placeholder={t('Nicht zusätzlich')}
          options={[
            ['company', t('Firma')],
            ['opportunity', t('Deal')],
            ...(targets?.objects ?? []).map((o) => [`object:${o.key}`, o.label] as [string, string]),
          ]}
          onChange={(v) => {
            if (!v) return setEntry(null);
            const [target, object] = v.startsWith('object:') ? ['object', v.slice(7)] : [v, undefined];
            const first = target === 'company' ? 'name' : target === 'opportunity' ? 'name' : (targets?.objects.find((o) => o.key === object)?.properties[0]?.key ?? 'name');
            const entry = { target, key: first, ...(object ? { object } : {}) };
            const next = { ...mapping, fields: { ...(mapping.fields ?? {}), [field.id]: entry } };
            // the first deal field brings the pipeline along (the form's "Opportunity anlegen" pipeline, else the first one)
            if (target === 'opportunity' && !mapping.deal && pipelineId) next.deal = { mode: 'new', pipeline_id: pipelineId, stage_id: s.pipeline_id === pipelineId ? (s.stage_id ?? '') : '' };
            setMapping(next);
          }}
        />
      </Field>
      {cur && (
        <Field label={t('Feld')}>
          <Select value={cur.key} onChange={(v) => setEntry({ ...cur, key: v })} options={keyOptions} />
        </Field>
      )}
      {cur?.target === 'opportunity' && targets && (
        <>
          <Field label={t('Deal-Pipeline (für alle Deal-Felder)')}>
            <Select value={pipelineId} onChange={(v) => setDeal({ pipeline_id: v, stage_id: '' })} options={targets.pipelines.map((p) => [p.id, p.name] as [string, string])} />
          </Field>
          {pipe && (
            <Field label={t('Stufe')}>
              <Select value={deal.stage_id || pipe.stages[0]?.id} onChange={(v) => setDeal({ stage_id: v })} options={pipe.stages.map((x) => [x.id, x.name] as [string, string])} />
            </Field>
          )}
          <Field label={t('Welcher Deal')}>
            <Select
              value={deal.mode === 'open' ? 'open' : 'new'}
              onChange={(v) => setDeal({ mode: v })}
              options={[
                ['new', t('Immer ein neuer Deal')],
                ['open', t('Offenen Deal des Kontakts ergänzen (sonst neu)')],
              ]}
            />
          </Field>
        </>
      )}
      {cur?.target === 'object' && (
        <Field label={t('Welcher Datensatz')}>
          <Select
            value={mapping.objects?.[cur.object]?.mode === 'linked' ? 'linked' : 'new'}
            onChange={(v) => setMapping({ ...mapping, objects: { ...(mapping.objects ?? {}), [cur.object]: { mode: v } } })}
            options={[
              ['new', t('Neuer Datensatz (gleicher eindeutiger Wert: ergänzen)')],
              ['linked', t('Zuletzt verknüpften Datensatz ergänzen (sonst neu)')],
            ]}
          />
        </Field>
      )}
      {cur && <Check checked={!!mapping.overwrite} onChange={(v) => setMapping({ ...mapping, overwrite: v || undefined })} label={t('Vorhandene Werte überschreiben (sonst nur leere Felder füllen)')} />}
    </div>
  );
}
