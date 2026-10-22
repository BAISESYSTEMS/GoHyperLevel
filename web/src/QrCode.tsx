import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CodeBox, Field, Input, Modal, Select } from './ui';
import { QR_SIZES, qrColorOk, qrDownloadName, qrLinkOk, qrUrl } from './qr';
import { useT } from './i18n';
import './pages/quickwins.css';

/** Link of a printed sheet: the sheet is a hidden block of the page that only shows when printing (body.qr-printing). */
function PrintSheet({ link, heading, text, fg }: { link: string; heading: string; text: string; fg: string }) {
  return createPortal(
    <div className="qr-sheet" aria-hidden="true">
      <h1>{heading}</h1>
      <img src={qrUrl(link, { format: 'svg', size: 1024, fg, ec: 'Q' })} alt="" />
      <p className="qr-sheet-text">{text}</p>
      <p className="qr-sheet-url">{link}</p>
    </div>,
    document.body,
  );
}

/** Download as PNG/SVG, preview and a printable sheet for one link. ✕ and Esc close it (shared Modal). */
export function QrModal({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const t = useT('core');
  const [size, setSize] = useState('1024');
  const [fg, setFg] = useState('#111827');
  const [strong, setStrong] = useState(false);
  const [heading, setHeading] = useState(title);
  const [text, setText] = useState(() => t('Mit der Handykamera scannen'));
  const name = qrDownloadName(title);
  const ok = qrColorOk(fg);
  const ec = strong ? 'H' : 'M';
  // The sheet only exists while this dialog is open; printing hides everything else.
  useEffect(() => () => document.body.classList.remove('qr-printing'), []);
  const print = () => {
    const done = () => {
      document.body.classList.remove('qr-printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    document.body.classList.add('qr-printing');
    // One frame so the sheet is laid out before the print dialog freezes the page.
    requestAnimationFrame(() => window.print());
  };
  return (
    <Modal title={t('QR-Code: {title}', { title })} onClose={onClose} wide>
      <div className="qr-modal" data-tour="qr-modal">
        <div className="qr-preview">
          <img src={qrUrl(url, { format: 'svg', size: 320, fg, ec })} alt={t('QR-Code für {title}', { title })} width={240} height={240} />
          <div className="muted small qr-link">{url}</div>
        </div>
        <div className="qr-form">
          <Field label={t('Größe der Datei')}>
            <Select value={size} onChange={setSize} options={QR_SIZES.map(([v, l]) => [v, t(l)] as [string, string])} />
          </Field>
          <Field label={t('Farbe')} hint={ok ? t('Dunkle Farben lassen sich am besten scannen.') : t('Zu hell – so scannt der Code schlecht. Bitte dunkler wählen.')}>
            <input type="color" value={fg} onChange={(e) => setFg(e.target.value)} aria-label={t('Farbe des QR-Codes')} className={ok ? '' : 'bad'} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={strong} onChange={(e) => setStrong(e.target.checked)} /> {t('Robust (für Aufkleber, Flyer und kleine Drucke)')}
          </label>
          <div className="row qr-actions">
            <a className="btn" data-tour="qr-png" href={qrUrl(url, { format: 'png', size: Number(size), fg, ec, download: name })} download={`${name}.png`} aria-disabled={!ok} onClick={(e) => !ok && e.preventDefault()}>
              {t('PNG herunterladen')}
            </a>
            <a className="btn secondary" data-tour="qr-svg" href={qrUrl(url, { format: 'svg', size: Number(size), fg, ec, download: name })} download={`${name}.svg`} aria-disabled={!ok} onClick={(e) => !ok && e.preventDefault()}>
              {t('SVG herunterladen')}
            </a>
          </div>
        </div>
      </div>
      <hr />
      <h3 style={{ marginBottom: 8 }}>{t('Druckblatt')}</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Eine Seite mit Überschrift, großem Code und dem Link darunter – zum Aufhängen oder Auslegen.')}
      </p>
      <div className="grid2">
        <Field label={t('Überschrift')}>
          <Input value={heading} onChange={setHeading} maxLength={80} />
        </Field>
        <Field label={t('Text unter dem Code')}>
          <Input value={text} onChange={setText} maxLength={120} />
        </Field>
      </div>
      <button className="btn secondary" data-tour="qr-print" onClick={print} disabled={!ok}>
        {t('Druckblatt drucken')}
      </button>
      <PrintSheet link={url} heading={heading} text={text} fg={fg} />
    </Modal>
  );
}

/** Small "QR-Code" button; opens the dialog. Hidden when there is no usable link. */
export function QrButton({ url, title, label }: { url?: string | null; title: string; label?: string }) {
  const t = useT('core');
  const [open, setOpen] = useState(false);
  if (!url || !qrLinkOk(url)) return null;
  return (
    <>
      <button type="button" className="btn small secondary qr-btn" onClick={() => setOpen(true)} title={t('QR-Code für {title}', { title })} aria-label={t('QR-Code für {title}', { title })}>
        {label ?? t('QR-Code')}
      </button>
      {open && <QrModal url={url} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A share link in a code box with its "Kopieren" and "QR-Code" buttons. */
export function ShareLink({ url, title }: { url: string; title: string }) {
  return (
    <div className="share-link">
      <CodeBox text={url} />
      <QrButton url={url} title={title} />
    </div>
  );
}
