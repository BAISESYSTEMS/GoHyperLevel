import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { Field, Input, Modal, Select, act, navigate } from '../ui';

/** Kurse → "Mit KI erstellen" (modules/course-ai.ts, docs/courses.md#create-a-course-with-ai): topic → outline → draft course. */
export function CourseAiButton() {
  const t = useT('gaps');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ topic: '', audience: '', modules: '4', lessons_per_module: '3' });
  const [outline, setOutline] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const close = () => (setOpen(false), setOutline(null));
  const draft = async () => {
    setBusy('draft');
    const r = await act(() => api.post('/api/course-ai/outline', { ...f, modules: Number(f.modules), lessons_per_module: Number(f.lessons_per_module) }));
    setBusy('');
    if (r) setOutline(r);
  };
  const create = async () => {
    setBusy('create');
    const r = await act(() => api.post('/api/course-ai/create', { outline }), t('Kurs angelegt'));
    setBusy('');
    if (r) navigate(`courses/${r.id}`);
  };
  return (
    <>
      <button className="btn secondary" data-tour="course-ai" onClick={() => setOpen(true)}>
        ✨ {t('Mit KI erstellen')}
      </button>
      {open && (
        <Modal
          title={t('Kurs mit KI erstellen')}
          onClose={close}
          wide
          footer={
            outline ? (
              <>
                <button className="btn secondary" disabled={!!busy} onClick={() => setOutline(null)}>
                  {t('Neuer Entwurf')}
                </button>
                <button className="btn" disabled={!!busy} onClick={create}>
                  {busy === 'create' ? t('Lege an …') : t('Kurs anlegen')}
                </button>
              </>
            ) : (
              <button className="btn" disabled={!f.topic.trim() || !!busy} onClick={draft}>
                {busy === 'draft' ? t('KI schreibt …') : t('Entwurf erstellen')}
              </button>
            )
          }
        >
          {!outline ? (
            <>
              <Field label={t('Worum geht es im Kurs?')}>
                <Input value={f.topic} onChange={(v) => setF({ ...f, topic: v })} placeholder={t('z. B. Social Media für Handwerksbetriebe')} />
              </Field>
              <MoreFields id="course-ai-more" values={[f.audience, f.modules !== '4' ? f.modules : '', f.lessons_per_module !== '3' ? f.lessons_per_module : '']}>
                <Field label={t('Zielgruppe')}>
                  <Input value={f.audience} onChange={(v) => setF({ ...f, audience: v })} />
                </Field>
                <div className="grid2">
                  <Field label={t('Module')}>
                    <Select value={f.modules} onChange={(v) => setF({ ...f, modules: v })} options={['2', '3', '4', '5', '6', '7', '8']} />
                  </Field>
                  <Field label={t('Lektionen je Modul')}>
                    <Select value={f.lessons_per_module} onChange={(v) => setF({ ...f, lessons_per_module: v })} options={['1', '2', '3', '4', '5', '6']} />
                  </Field>
                </div>
              </MoreFields>
              <p className="muted small">{t('Die KI schreibt Gliederung und Lektionstexte. Angelegt wird erst nach deinem Klick – als Entwurf mit unveröffentlichten Lektionen.')}</p>
            </>
          ) : (
            <>
              <Field label={t('Titel')}>
                <Input value={outline.title} onChange={(v) => setOutline({ ...outline, title: v })} />
              </Field>
              {outline.modules.map((m: any, i: number) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <strong>{m.title}</strong>
                  <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {m.lessons.map((l: any, j: number) => (
                      <li key={j}>
                        {l.title} <span className="muted">· {l.duration_min} {t('Min.')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
