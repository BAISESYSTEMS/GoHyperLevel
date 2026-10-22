import { COMPANY_TOURS } from './content/company';
import { placeLabel } from './handbook';
import { slug } from './slug';

/**
 * The printable course „Deine Firma mit … führen“ as Markdown, generated from the same data as the Academy lessons
 * (content/company.ts). docs/kurs-firma-fuehren.md is a copy – tests/company-course.test.ts keeps it current:
 *
 *   node --import tsx -e "import('./web/src/tour/company-course.ts').then((m) => require('node:fs').writeFileSync('docs/kurs-firma-fuehren.md', m.companyCourseMarkdown('HyperLevel')))"
 */

const plain = (s: string, brand: string) => s.replace(/\{brand\}/g, brand).replace(/\s+/g, ' ').trim();

export const lessonHeading = (n: number, title: string) => `Lektion ${n}: ${title}`;

export function companyCourseMarkdown(brand = 'HyperLevel'): string {
  const minutes = COMPANY_TOURS.reduce((s, t) => s + t.minutes, 0);
  const out: string[] = [
    `# Kurs: Deine Firma mit ${brand} führen`,
    '',
    `${COMPANY_TOURS.length} Lektionen für Gründerinnen und Gründer, die ihre eigene Firma mit ${brand} führen – zusammen etwa ${Math.round(minutes / 60)} Stunden. Jede Lektion endet mit einer **10-Minuten-Aufgabe** in der echten App. In ${brand} findest du den Kurs unter *Akademie → Kurs: Deine Firma führen*; dort markiert die Tour jede Stelle und wartet, bis du sie ausprobiert hast.`,
    '',
    `> Am besten arbeitest du in deinem eigenen HQ-Sub-Account mit der Vorlage **„Software- & SaaS-Firma (HQ)“** (*Agentur → Snapshots → Vorlagen*). Das Betriebs-Handbuch für die Zeit danach – Routinen, Kennzahlen, wann einstellen, wann automatisieren – ist das [Company-Playbook](company-playbook.md).`,
    '',
    '> **Hinweis:** Dieser Kurs ersetzt keine Beratung. Steuerfragen gehören zur Steuerberaterin oder zum Steuerberater, Rechtsfragen zur Anwältin oder zum Anwalt.',
    '',
    '**Inhalt**',
    '',
    ...COMPANY_TOURS.map((t) => `${t.chapter}. [${plain(t.title, brand)}](#${slug(lessonHeading(t.chapter!, plain(t.title, brand)))}) – ${plain(t.summary, brand)}`),
    '',
    '---',
    '',
  ];
  for (const t of COMPANY_TOURS) {
    out.push(`## ${lessonHeading(t.chapter!, plain(t.title, brand))}`, '', `${plain(t.summary, brand)} *(ca. ${t.minutes} Minuten${t.admin ? ', nur für die Agentur' : ''})*`, '');
    let place = '';
    t.steps.forEach((s, i) => {
      const here = s.route ? placeLabel(s.route) : '';
      const where = here && here !== place ? ` *(${here})*` : '';
      if (here) place = here;
      const extra = s.do ? ` – *So geht's:* ${plain(s.do, brand)}` : '';
      out.push(`${i + 1}. **${plain(s.title, brand)}**${where} – ${plain(s.text, brand)}${extra}`);
    });
    out.push('', '**Das hast du gelernt:**', '');
    for (const l of t.learned) out.push(`- ${plain(l, brand)}`);
    if (t.docs) out.push('', `Mehr dazu: [${t.docs.label}](${t.docs.file}.md${t.docs.anchor ? `#${t.docs.anchor}` : ''})`);
    out.push('', '---', '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n---\n*$/, '\n').trim() + '\n';
}
