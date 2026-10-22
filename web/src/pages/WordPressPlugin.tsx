import { api } from '../api';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { toast, useLoad } from '../ui';

/** Formulare → WordPress-Plugin (modules/wordpress-plugin.ts, docs/forms.md#wordpress-plugin): download and ready shortcodes. */
export function WordPressPluginCard() {
  const t = useT('gaps');
  const d = useLoad(() => api.get<any>('/api/wordpress-plugin').catch(() => null), []);
  if (!d.data) return null;
  const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => toast(t('Kopiert')));
  const codes: { name: string; shortcode: string }[] = [...d.data.forms, ...d.data.calendars];
  return (
    <div className="card" data-tour="wordpress-plugin">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{t('WordPress-Plugin')}</h2>
        <a className="btn small secondary" href={d.data.download_url} download>
          {t('Plugin herunterladen')}
        </a>
      </div>
      <p className="muted small">{t('In WordPress unter Plugins → Installieren → Plugin hochladen. Formulare und Kalender per Shortcode, Live-Chat und Attribution per Häkchen.')}</p>
      {codes.length > 0 && (
        <MoreFields id="wordpress-shortcodes" label={t('Shortcodes')}>
          <table className="t">
            <tbody>
              {codes.map((c) => (
                <tr key={c.shortcode}>
                  <td>{c.name}</td>
                  <td>
                    <code style={{ overflowWrap: 'anywhere' }}>{c.shortcode}</code>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn small secondary" onClick={() => copy(c.shortcode)}>
                      {t('Kopieren')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </MoreFields>
      )}
    </div>
  );
}
