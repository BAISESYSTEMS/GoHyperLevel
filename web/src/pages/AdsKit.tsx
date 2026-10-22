import { useEffect, useRef, type ReactNode } from 'react';
import { Badge, Modal } from '../ui';

/** Shared pieces of the ads manager pages: types, labels and a modal that gives focus back when it closes. */

export type Platform = 'meta' | 'google';
export const PLATFORM_LABEL: Record<Platform, string> = { meta: 'Meta', google: 'Google' };
export const PLATFORM_FULL: Record<Platform, string> = { meta: 'Meta (Facebook & Instagram)', google: 'Google Ads' };

export const GOALS: [string, string, string][] = [
  ['leads', 'Leads gewinnen', 'Kontaktanfragen: Sofortformular bei Meta, Suchanzeigen bei Google'],
  ['traffic', 'Website-Besucher', 'Menschen auf eine Seite bringen (Funnel, Website)'],
  ['conversions', 'Conversions', 'Verkäufe oder Anmeldungen – braucht Pixel bzw. Conversion-Erfassung'],
  ['reach', 'Reichweite', 'Möglichst viele Menschen erreichen (nur Meta)'],
];

export const CTAS: [string, string][] = [
  ['LEARN_MORE', 'Mehr dazu'],
  ['SIGN_UP', 'Registrieren'],
  ['CONTACT_US', 'Kontakt'],
  ['GET_QUOTE', 'Angebot einholen'],
  ['APPLY_NOW', 'Jetzt bewerben'],
  ['DOWNLOAD', 'Herunterladen'],
  ['SUBSCRIBE', 'Abonnieren'],
  ['BOOK_TRAVEL', 'Jetzt buchen'],
  ['SHOP_NOW', 'Jetzt kaufen'],
  ['ORDER_NOW', 'Jetzt bestellen'],
  ['GET_OFFER', 'Angebot sichern'],
];

export const STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'purple']> = {
  draft: ['Entwurf', 'gray'],
  publishing: ['Wird angelegt …', 'blue'],
  paused: ['Pausiert', 'yellow'],
  active: ['Aktiv', 'green'],
  error: ['Fehler', 'red'],
  ended: ['Beendet', 'gray'],
  deleted: ['Gelöscht', 'gray'],
  other: ['Unbekannt', 'gray'],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? STATUS.other;
  return <Badge tone={tone}>{label}</Badge>;
}

export function PlatformBadge({ platform }: { platform: string }) {
  return <Badge tone={platform === 'meta' ? 'blue' : 'purple'}>{PLATFORM_LABEL[platform as Platform] ?? platform}</Badge>;
}

export interface Spec {
  platform: Platform;
  kind: string;
  name: string;
  goal: string;
  budget: { type: 'daily' | 'lifetime'; amount_cents: number };
  schedule: { start?: string; end?: string };
  audience: {
    countries?: string[];
    locations?: { type: string; key: string; name: string; country?: string; radius?: number }[];
    age_min?: number;
    age_max?: number;
    genders?: string[];
    interests?: { id: string; name: string }[];
    audience_ids?: string[];
    exclude_audience_ids?: string[];
    keywords?: { text: string; match: string }[];
    negative_keywords?: string[];
    languages?: string[];
  };
  creative: {
    media?: { upload_id: string; role?: string }[];
    primary_text?: string;
    headline?: string;
    description?: string;
    cta?: string;
    link?: { funnel_id?: string; page_id?: string; url?: string };
    utm?: boolean;
    headlines?: string[];
    long_headlines?: string[];
    descriptions?: string[];
    business_name?: string;
    path1?: string;
    path2?: string;
  };
  lead_form_id?: string;
  conversion_event?: string;
  dsa?: { beneficiary?: string; payor?: string };
}

export const emptySpec = (platform: Platform = 'meta'): Spec => ({
  platform,
  kind: platform === 'meta' ? 'lead_form' : 'search',
  name: '',
  goal: 'leads',
  budget: { type: 'daily', amount_cents: 2000 },
  schedule: {},
  audience: platform === 'meta' ? { countries: ['DE'], age_min: 18, age_max: 65 } : { languages: ['de'] },
  creative: { utm: true, cta: platform === 'meta' ? 'LEARN_MORE' : undefined },
});

export interface Review {
  platform: Platform;
  account: string;
  status_after: 'paused';
  headline: string;
  rows: { label: string; value: string }[];
  preview: { primary_text?: string; headline?: string; description?: string; cta?: string; link?: string; example_link?: string; media: string[]; headlines?: string[]; descriptions?: string[] };
  errors: string[];
  warnings: string[];
  ready: boolean;
  hash: string;
  note: string;
}

/**
 * A modal that gives focus back to what opened it when it closes (✕, Esc or after the action) – keyboard users land
 * where they were. The ✕ in the corner and Esc come from the shared Modal.
 */
export function AdsModal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    const el = opener.current;
    return () => {
      // After the modal is gone, the opener (or the page) gets the focus back.
      setTimeout(() => (el && document.contains(el) ? el.focus?.() : undefined), 0);
    };
  }, []);
  return (
    <Modal title={title} onClose={onClose} wide={wide} footer={footer}>
      {children}
    </Modal>
  );
}

/** €-input: shows euros, hands out cents. */
export const toCents = (v: string) => {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};
export const fromCents = (c: number | undefined | null) => (c ? String(Math.round(c) / 100).replace('.', ',') : '');
