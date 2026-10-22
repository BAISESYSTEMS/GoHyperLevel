import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { Field, Input, Link, Modal, Spinner, act, useLoad } from '../ui';

/** AI Studio extras (docs/ai-studio.md): the empty state without an AI key, the example prompts and the publish dialog. */

/** Three starting points: the prompt fills the chat of a new project. */
export const EXAMPLES: { id: string; title: string; stack: 'react' | 'html'; prompt: string }[] = [
  { id: 'landing', title: 'Landingpage', stack: 'html', prompt: 'Baue eine moderne Landingpage für ein Café mit Hero-Bereich, drei Angeboten, Öffnungszeiten, Kundenstimmen und einem Kontakt-Button.' },
  { id: 'booking', title: 'Buchungs-Widget', stack: 'react', prompt: 'Baue ein Buchungs-Widget: Leistung wählen, Datum und freie Uhrzeit auswählen, Name und E-Mail eintragen, am Ende eine Zusammenfassung zur Bestätigung.' },
  { id: 'calculator', title: 'Rechner-App', stack: 'react', prompt: 'Baue einen kleinen Preisrechner: Menge und Paket wählen, optional Express-Zuschlag, Rabatt ab 10 Stück, Netto, MwSt. und Brutto live anzeigen.' },
];

/** Shown instead of the chat's promise when no text connection is set up. */
export function ConnectKey() {
  const t = useT('aistudio');
  return (
    <div className="card studio-connect" data-tour="studio-connect">
      <b>{t('Verbinde deinen Claude-, OpenAI- oder OpenRouter-Key')}</b>
      <p className="muted small">{t('Das AI Studio arbeitet mit deinem eigenen KI-Anbieter: Du zahlst direkt dort, die Kosten jeder Anfrage siehst du hier.')}</p>
      <Link to="settings/ai-providers" className="btn primary">
        {t('Zu den KI-Anbietern')}
      </Link>
    </div>
  );
}

export function Examples({ onPick }: { onPick: (e: (typeof EXAMPLES)[number]) => void }) {
  const t = useT('aistudio');
  return (
    <div className="studio-examples" data-tour="studio-examples">
      {EXAMPLES.map((e) => (
        <button key={e.id} className="card studio-example" onClick={() => onPick(e)}>
          <b>{t(e.title)}</b>
          <span className="muted small">{t(e.prompt)}</span>
        </button>
      ))}
    </div>
  );
}

export function PublishDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT('aistudio');
  const st = useLoad(() => api.get<any>(`/api/ai-studio/projects/${id}/publish`), [id]);
  const [slug, setSlug] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = st.data;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    if (await act(fn, ok)) st.reload();
    setBusy(false);
  };
  const publish = () => run(() => api.post(`/api/ai-studio/projects/${id}/publish`, { slug: slug ?? s?.slug ?? '', ...(domain !== null ? { domain } : {}) }), s?.published ? t('Neu veröffentlicht') : t('Veröffentlicht'));
  const unpublish = () => run(() => api.del(`/api/ai-studio/projects/${id}/publish`), t('Offline genommen'));
  return (
    <Modal
      title={t('Veröffentlichen')}
      onClose={onClose}
      footer={
        <>
          {s?.published && (
            <button className="danger" disabled={busy} onClick={unpublish}>
              {t('Offline nehmen')}
            </button>
          )}
          <button className="primary" disabled={busy || !s} onClick={publish}>
            {busy ? t('Arbeitet …') : s?.published ? t('Neu veröffentlichen') : t('Veröffentlichen')}
          </button>
        </>
      }
    >
      {!s ? (
        <Spinner />
      ) : (
        <>
          {s.published && (
            <p data-tour="studio-public-url">
              {t('Öffentlich unter')}{' '}
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.url}
              </a>
            </p>
          )}
          <Field label={t('Adresse')} hint={t('Die App liegt unter /apps/<adresse>/ – statische Dateien, ohne Cookies, mit strenger Sicherheitsrichtlinie.')}>
            <Input value={slug ?? s.slug ?? ''} onChange={setSlug} placeholder={t('automatisch aus dem Namen')} />
          </Field>
          <Field label={t('Eigene Domain (optional)')} hint={t('DNS der Domain auf diesen Server zeigen lassen; das Zertifikat kommt automatisch, wenn Caddy mit On-Demand-TLS läuft.')}>
            <Input value={domain ?? s.domain ?? ''} onChange={setDomain} placeholder="app.example.com" />
          </Field>
          <p className="muted small">{t('Veröffentlichen baut das Projekt neu und ersetzt die öffentliche Fassung. Änderungen danach sind erst nach erneutem Veröffentlichen sichtbar.')}</p>
        </>
      )}
    </Modal>
  );
}
