import { Icon } from '../icons';
import { useT } from '../i18n';

/** What "maschinell" means – shown as a tooltip wherever opens and clicks are listed (German; translated with the core catalog). */
export const MACHINE_HINT =
  'Automatische Aufrufe, keine Person: Apple Mail lädt Bilder vorab, der Gmail-Bildproxy lädt sie beim Zustellen, Sicherheits-Scanner prüfen Links Sekunden nach dem Versand. Sie zählen nicht als Öffnung oder Klick und starten keine Automationen.';

/**
 * "· geöffnet · geklickt · +N maschinell" for the meta line of an e-mail. geöffnet / geklickt are people (the server only
 * sets opened_at / clicked_at for those); the muted note counts what proxies and scanners did, with an explanation.
 */
export function MailEngagement({ m }: { m: { opened_at?: string | null; clicked_at?: string | null; open_count?: number; machine_open_count?: number; machine_click_count?: number } }) {
  const t = useT('core');
  const machine = Number(m.machine_open_count ?? 0) + Number(m.machine_click_count ?? 0);
  const opens = Number(m.open_count ?? 0);
  return (
    <>
      {m.opened_at ? (
        <>
          {' '}· <Icon name="opened" size={12} /> {t('geöffnet')}{opens > 1 ? ` (${opens}×)` : ''}
        </>
      ) : null}
      {m.clicked_at ? (
        <>
          {' '}· <Icon name="clicked" size={12} /> {t('geklickt')}
        </>
      ) : null}
      {machine > 0 ? (
        <>
          {' '}·{' '}
          <span className="muted mail-machine" title={t(MACHINE_HINT)}>
            {t('+{n} maschinell', { n: machine })}
          </span>
        </>
      ) : null}
    </>
  );
}
