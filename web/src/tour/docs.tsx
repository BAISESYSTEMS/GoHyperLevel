import { useEffect } from 'react';
import { api } from '../api';
import { useLocale, useT } from '../i18n';
import { Icon } from '../icons';
import { useSession } from '../session';
import { Empty, Link, PageHead, Spinner, useLoad } from '../ui';
import { handbookMarkdown } from './handbook';
import { Markdown } from './markdown';

/** Scrolls to `#anchor` once the document is on screen. */
function useAnchor(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return window.scrollTo(0, 0);
    const t = setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 60);
    return () => clearTimeout(t);
  }, [ready]);
}

/** A page from docs/ (or the README), read inside the app – in English the English twin of a German page (`growth.de` → `growth`). */
export function DocViewer({ name }: { name: string }) {
  const t = useT('academy');
  const locale = useLocale();
  const page = locale === 'en' ? name.replace(/\.de$/, '') : name;
  const doc = useLoad(() => api.get<{ name: string; title: string; markdown: string }>(`/api/academy/docs/${encodeURIComponent(page)}`), [page]);
  useAnchor(!!doc.data);
  return (
    <div className="doc-view">
      <PageHead title={doc.data?.title ?? t('Anleitung')} sub={<Link to="academy">{t('← Akademie')}</Link>}>
        <button className="btn secondary" onClick={() => window.print()}>
          <Icon name="printer" size={15} /> {t('Drucken / PDF')}
        </button>
      </PageHead>
      {doc.error ? <Empty>{doc.error}</Empty> : !doc.data ? <Spinner /> : <div className="card doc-card"><Markdown text={doc.data.markdown} /></div>}
    </div>
  );
}

/** The whole journey as a printable handbook (Drucken → „Als PDF speichern“) – in English when the app is in English. */
export function Handbook() {
  const t = useT('academy');
  const session = useSession();
  const locale = useLocale();
  useAnchor(true);
  return (
    <div className="doc-view handbook" data-tour="handbook">
      <PageHead title={t('Handbuch')} sub={<Link to="academy">{t('← Akademie')}</Link>}>
        <button className="btn" data-tour="handbook-print" onClick={() => window.print()}>
          <Icon name="printer" size={15} /> {t('Drucken / als PDF speichern')}
        </button>
      </PageHead>
      <p className="muted no-print">{t('Tipp: Im Druckdialog „Als PDF speichern“ wählen – dann hast du das Handbuch als Datei. Die Markdown-Fassung liegt im Code unter docs/handbook.de.md (Englisch: docs/handbook.md).')}</p>
      <div className="card doc-card">
        <Markdown text={handbookMarkdown(session.branding.name || 'HyperLevel', locale)} />
      </div>
    </div>
  );
}
