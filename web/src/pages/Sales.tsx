import { PageHead, Tabs, navigate } from '../ui';
import { SalesAccess } from './SalesAccess';
import { SalesDupes } from './SalesDupes';
import { SalesQuotas } from './SalesQuotas';
import { SalesQuotes } from './SalesQuotes';
import { SalesSequences } from './SalesSequences';
import './sales.css';

/**
 * Vertrieb (docs/sales.md): Sequenzen aus dem eigenen Postfach, Angebote aus dem Deal, Quoten und Rangliste, der Dubletten-Assistent
 * und der Datensatz-Zugriff mit Teams. Positionen am Deal und die Gesprächsnotizen stehen im Deal selbst (Opportunities).
 */

const TABS: [string, string][] = [
  ['sequenzen', 'Sequenzen'],
  ['angebote', 'Angebote'],
  ['quoten', 'Quoten & Rangliste'],
  ['dubletten', 'Dubletten'],
  ['zugriff', 'Zugriff & Teams'],
];

export function Sales({ tab }: { tab?: string }) {
  const cur = TABS.some(([k]) => k === tab) ? tab! : 'sequenzen';
  return (
    <div className="sales" data-tour="sales-page">
      <PageHead title="Vertrieb" sub="Sequenzen, Angebote, Quoten, Dubletten und wer welche Datensätze sieht" />
      <Tabs tabs={TABS} value={cur} onChange={(v) => navigate(`sales/${v}`)} />
      <div style={{ marginTop: 14 }}>
        {cur === 'sequenzen' && <SalesSequences />}
        {cur === 'angebote' && <SalesQuotes />}
        {cur === 'quoten' && <SalesQuotas />}
        {cur === 'dubletten' && <SalesDupes />}
        {cur === 'zugriff' && <SalesAccess />}
      </div>
    </div>
  );
}
