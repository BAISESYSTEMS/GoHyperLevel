# E-Mail-Designer (Drag & Drop)

> 60 fertige deutsche Vorlagen stehen in der **Vorlagengalerie**; A/B-Tests, Segmente und Zustellbarkeit beschreibt [E-Mail-Marketing](email-marketing.md).

Gestalte E-Mails wie in GoHighLevel: Blöcke links auf die Fläche ziehen, rechts einstellen, fertig. Der Designer steckt in

- **Kampagnen** → Kampagne öffnen → *Inhalt* → **Mit E-Mail-Designer gestalten**,
- **Kampagnen → Vorlagen** → Vorlage (E-Mail) → **Mit E-Mail-Designer gestalten**,
- **Automationen** → Schritt **E-Mail senden** → **Mit E-Mail-Designer gestalten**.

Im [Einfach-Modus](theming.md#einfach-modus) liegen Ausrichtung, Abstände, Farben und Schriftgröße eines Blocks (beim Button auch Farben, Ecken und volle Breite, beim Bild die Breite), der Hintergrund und die Abstände eines Abschnitts und das Aussehen der ganzen Mail unter **Darstellung** – offen, sobald etwas vom Standard abweicht.

Einfache Text- oder HTML-Mails funktionieren weiter wie bisher; *Als Text schreiben* schaltet ein Design wieder ab. Es sind keine Zugangsdaten nötig – versendet wird über den Versand, der unter **Einstellungen → E-Mail & SMS** eingerichtet ist (ohne SMTP werden Mails nur gespeichert).

## Bedienung

| Bereich | Was es gibt |
| --- | --- |
| Links: Blöcke | **Layout** (Abschnitt mit 1, 2 oder 3 Spalten), **Inhalt**: Überschrift, Text, Bild, Button, Trennlinie, Abstand, Social Media, Video, HTML, Footer. Ziehen (oder antippen = hinter der Auswahl einfügen). **Meine Abschnitte**: gespeicherte, wiederverwendbare Abschnitte. **Vorlagen**: 6 Startvorlagen (Newsletter, Angebot, Event-Einladung, Bewertungsanfrage, Willkommen, Schlichter Brief). |
| Mitte: Fläche | Blöcke verschieben (auch zwischen Spalten und Abschnitten), Abschnitte am Griff ziehen; Werkzeugleiste an Block/Abschnitt: hoch, runter, duplizieren, löschen. |
| Rechts: Einstellungen | Je Block Inhalt und Darstellung (Abstände, Ausrichtung, Farben, Schriftgröße), je Abschnitt Spaltenaufteilung (50/50, 33/67, 67/33, 33/33/33), Hintergrund und Innenabstand. Ohne Auswahl: Breite (Standard 600 px), Hintergrund, Inhaltsfarbe, Schrift, Text- und Linkfarbe, Vorschautext (Preheader) und die Prüfung (Fehler/Hinweise). **Platzhalter einfügen** setzt `{{contact.first_name}}` & Co. an die Cursor-Stelle. |
| Oben | Betreff, Rückgängig/Wiederholen (Strg+Z / Strg+Y), Desktop/Handy, **Vorschau** (mit Beispieldaten „Max Mustermann“), **Text** (die Text-Version), **Test** (Testmail an eine Adresse, Betreff mit `[TEST]`), Speichern, ✕ bzw. Esc schließt. Entf löscht den gewählten Block. |

Text-Blöcke kennen **fett** (`**fett**`), *kursiv* (`*kursiv*`), Links (`[Text](https://…)`) und Listen (Zeilen mit `- ` oder `1. `) – die Werkzeugleiste fügt das ein. Bilder kommen aus den Uploads (oder per Adresse), Video-Blöcke zeigen ein Vorschaubild (bei YouTube automatisch) mit Link zum Video.

**Footer:** Firmenname, Adresse (Standard `{{location.address}}` aus *Einstellungen → Firma*), Hinweistext, Abmeldelink und optional ein **Einstellungs-Link** (Text frei wählbar; ohne eigenen Eintrag ergänzt der Versand „Einstellungen“ neben „Abmelden“, solange das [Einstellungs-Center](consent.md) verlinkt wird). In **Kampagnen ist der Footer Pflicht** – ohne Footer oder ohne Adresse startet der Versand nicht. Fehlt er in Vorlagen oder Workflow-Mails, wird automatisch ein kleiner Footer mit Firma, Adresse und Abmeldelink angehängt.

## Was beim Speichern passiert

Das Design wird als JSON (`design`) neben dem Text gespeichert. Der **Server** erzeugt daraus

- das fertige HTML (`body`, `is_html = 1`): Tabellen-Layout mit Inline-Styles, Outlook-Buttons (VML), Spalten stehen auf dem Handy untereinander, Dunkelmodus-Hinweise, Alternativtexte, escapter Text, nur `http(s)`-, `mailto:`- und `tel:`-Links, HTML-Blöcke ohne Skripte/Formulare/iframes,
- die Text-Version (`body_text`), aus dem Design gebaut (Links als „Text (Adresse)“, Buttons als „Beschriftung: Adresse“).

Platzhalter bleiben im HTML stehen und werden erst beim Versand je Empfänger ersetzt (Werte HTML-sicher). Der persönliche Abmeldelink steht im gespeicherten HTML als `%%unsubscribe_url%%` und wird beim Versand eingesetzt; im Text kannst du ihn mit `{{unsubscribe_url}}` selbst verlinken. Öffnungs-/Klick-Tracking und Trigger-Links funktionieren wie bei allen anderen Mails.

Weil der Server rendert, verschicken API, MCP und Workflows immer das fertige HTML – sie müssen nichts über Designs wissen.

## API

Felder an `POST /api/templates`, `PATCH /api/templates/:id`, `POST /api/campaigns`, `PATCH /api/campaigns/:id` und an Workflow-Schritten `send_email` (in `steps`):

```json
{
  "name": "Herbst-News",
  "subject": "Neuigkeiten von {{location.name}}",
  "design": {
    "settings": { "width": 600, "background": "#f3f4f6", "contentBackground": "#ffffff", "fontFamily": "Arial, Helvetica, sans-serif",
                  "textColor": "#1f2937", "linkColor": "#2563eb", "fontSize": 16, "preheader": "Kurz vorab …" },
    "sections": [
      { "widths": [50, 50], "style": { "background": "", "paddingY": 0, "paddingX": 0 },
        "columns": [
          { "blocks": [ { "type": "heading", "props": { "text": "Hallo {{contact.first_name|du}}", "level": 1 } } ] },
          { "blocks": [ { "type": "button", "props": { "label": "Ansehen", "href": "https://example.com" }, "style": { "align": "center" } } ] }
        ] },
      { "columns": [ { "blocks": [ { "type": "footer" } ] } ] }
    ]
  }
}
```

- Blocktypen: `heading` (`text`, `level` 1–3), `text` (`text`), `image` (`src`, `alt`, `href`, `width`), `button` (`label`, `href`, `background`, `textColor`, `radius`, `fullWidth`), `divider` (`color`, `thickness`, `width` %), `spacer` (`height`), `social` (`variant: icons|text`, `items: [{network, url}]`, Netzwerke: facebook, instagram, linkedin, x, youtube, tiktok, whatsapp, website, email), `video` (`url`, `thumbnail`, `caption`, `alt`), `html` (`html`), `footer` (`company`, `address`, `text`, `unsubscribeLabel`). `style` je Block: `paddingY`, `paddingX`, `align`, `color`, `background`, `fontSize`.
- Fehlende Werte bekommen Standardwerte, Farben müssen `#rgb`/`#rrggbb` sein, Zahlen werden begrenzt; unbekannte Blocktypen → 400.
- Antwort enthält `design` (bereinigt), `body` (HTML) und `body_text`. `design: null` schaltet zurück auf eine einfache Mail; ein neuer `body` ohne `design` verwirft das Design ebenfalls.
- `GET /api/templates/:id` liefert eine Vorlage samt Design.

Rund um den Designer:

| Endpunkt | Zweck |
| --- | --- |
| `GET /api/email-builder/starters` | Startvorlagen `[{key, name, description, subject, design}]` |
| `POST /api/email-builder/render` `{design, campaign?}` | HTML, Text und Prüfung `issues: [{level: error\|warning, text}]`, ohne zu speichern |
| `POST /api/email-builder/test` `{design, subject, to, contact_id?}` | Testmail (Platzhalter mit Beispiel- oder Kontaktdaten, höchstens 20 je 10 Minuten) |
| `GET/POST /api/email-builder/sections`, `DELETE /api/email-builder/sections/:id` | Gespeicherte Abschnitte `{name, section}` |

MCP: `ghl_list_email_templates` (Vorlagen + Startvorlagen) und `ghl_save_email_template` (`name`, `subject`, `body` oder `design` oder `starter`).

Rechte: alles unter *Kampagnen & Vorlagen*; Startvorlagen und Abschnitte sind für alle Logins des Sub-Accounts lesbar (auch für den Workflow-Editor).
