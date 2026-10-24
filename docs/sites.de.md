[English](sites.md) · **Deutsch**

# Website-Baukasten: Editor, Vorlagen, Inhalte, Barrierefreiheit & Statistik

Funnels und Websites (*Funnels & Websites* im Menü) bestehen aus Seiten, die aus **Abschnitten, Spalten und Blöcken** zusammengesetzt werden. Dieses Kapitel beschreibt den Editor, die Design-Einstellungen, die 23 Vorlagen, Sammlungen (CMS), Weiterleitungen, Suche und Sprachen, Bildoptimierung, die Barrierefreiheitsprüfung (BFSG) und die Statistik je Funnel-Schritt. Domains, Blog, A/B-Tests, Order-Bumps und Kauf-Links stehen in der [README](../README.de.md#ab-tests-order-bumps--upsells) und in [docs/stripe.de.md](stripe.de.md); die Rechtstexte in [docs/consent.md](consent.md).

Alles hier gehört zum Bereich *Funnels & Websites*; ein Login darf nur die Seiten seiner Sub-Accounts bearbeiten, Schlüssel mit Leserechten dürfen nichts ändern.

## Der Editor

Eine Seite öffnest du unter *Funnels & Websites → Website → Seiten*. Links steht der Editor, rechts die **Live-Vorschau** mit Umschalter für **Desktop, Tablet (820 px) und Handy (390 px)** – die Vorschau ist die echte Seite in dieser Breite, die Spalten brechen also genau so um wie bei Besuchern.

- **Hinzufügen:** Reiter *Abschnitte* (Spaltenaufteilung: 1, 2, ⅓ + ⅔, ⅔ + ⅓, 3, 4 Spalten), *Blöcke* (Hero, Aufruf, Vorteile, Ablauf, Zahlen, Logos, Galerie, Kundenstimme, FAQ, Preise, Formular, Kalender, Produkt / Kasse, Shop: Produktliste, Shop: Produktdetail, Countdown, Sammlung, Suche, Eigener Code …) und *Komponenten*. Anklicken fügt dort ein, wo die Auswahl es nahelegt (in die gewählte Spalte, hinter den gewählten Block, hinter den gewählten Abschnitt); **Ziehen** legt gezielt ab.
- **Struktur:** die Seite als Baum **Abschnitt → Zeile → Spalten (1–4) → Blöcke**. Alles lässt sich **per Drag & Drop** umsortieren und verschieben (auch Zeilen in andere Abschnitte und Spalten innerhalb einer Zeile); die Pfeile ↑ ↓ und die Knöpfe zum Duplizieren und Entfernen tun dasselbe **ohne Maus und auf Touch-Geräten**. Zuklappen hält lange Seiten übersichtlich. **Strg/⌘ + Z** nimmt Schritte zurück, **Strg/⌘ + Y** (oder Umschalt + Strg/⌘ + Z) stellt sie wieder her. Eine Seite darf bis zu 400 Blöcke und Abschnitte haben.
- **Inspektor** für das gewählte Element, in drei Reitern:
  - *Inhalt* – die Felder des Blocks (Texte, Links, Bilder, Formular, Kalender, Produkt, Sammlung …); Links zeigen auf eine **Seite dieser Website** (sie folgen Umbenennungen), eine Adresse, einen Anker (`#preise`), `mailto:` oder `tel:`.
  - *Stil* – Hintergrund und Textfarbe (aus den Design-Farben oder eigene), Hintergrundbild mit Abdunkeln, **Abstände oben/unten und links/rechts**, **Rahmen**, **Ecken**, Schatten, Ausrichtung. Setzt du eine Textfarbe mit zu wenig Kontrast, warnt der Inspektor sofort.
  - *Geräte* – **Ausblenden auf Desktop, Tablet oder Handy**, **Spalten untereinander** ab Tablet, Handy oder nie, **Spaltenbreite je Gerät**, Abstand je Gerät und **Schriftgröße je Gerät** (in Prozent).
- **Speichern** macht die Änderungen live. Wer die Seite mit ungespeicherten Änderungen verlassen will, wird gefragt.
- **SEO, Seiten-Layout, Prüfen** (unter dem Inspektor): Titel, Beschreibung, Vorschaubild, noindex; Kopf- oder Fußzeile auf dieser Seite ausblenden (z. B. Landingpages), Sprache und **Übersetzung anlegen**; die **Barrierefreiheitsprüfung des Entwurfs** mit Sprung zum betroffenen Block.

Seiten aus der Zeit vor dem Layout-Editor sind eine flache Liste von Blöcken. Sie funktionieren unverändert; *In Abschnitte umwandeln* packt jeden Block in einen Abschnitt ohne zusätzlichen Abstand, damit das Aussehen gleich bleibt und Spalten möglich werden.

### Komponenten (Symbole)

Ein Abschnitt oder Block, den du auf mehreren Seiten brauchst (Kontaktbereich, Vertrauens-Logos, Preisliste), wird mit **Als Komponente speichern** zum Baustein. An der Stelle auf der Seite steht danach die Komponente; unter *Komponenten* setzt du sie auf weitere Seiten, bearbeitest sie (die Änderung wirkt **überall nach dem Speichern**) oder **löst sie von der Komponente** (dann bleibt eine Kopie als normale Blöcke). Wird eine Komponente gelöscht, bleiben die Seiten, wie sie aussehen: die Stellen werden zu normalen Blöcken. Eine Komponente kann sich nicht selbst enthalten (auch nicht über eine andere). Komponenten gehören zum Sub-Account; beim Kopieren einer Website in ein anderes Konto werden die benutzten mit kopiert.

### Bilder

Beim Hochladen im Editor skaliert der Browser das Bild in **mehrere Breiten (640, 1280, 1920 px)**, schreibt **WebP**, wo der Browser es kann (per Canvas geprüft), und speichert Breite und Höhe. Die Seite bekommt `srcset` (Handys laden das kleine Bild), `width`/`height` (kein Springen beim Laden), **`loading="lazy"`** unterhalb des ersten Bildes und `fetchpriority="high"` für das erste. Kleine Dateien (unter 250 KB) und animierte GIFs gehen unverändert hoch.

Zusätzlich liest der Server die **Größe jedes hochgeladenen Bildes aus dem Dateikopf** (PNG, JPEG inkl. EXIF-Drehung, GIF, WebP) – auch Bilder aus der Mediathek, die ohne Größe eingefügt wurden, bekommen `width` und `height`. Ist ein **Bild-Motor** vorhanden, schreibt der Server außerdem selbst `srcset`-Kopien unter `/uploads-opt/<Breite>/<Datei>` (320, 640, 960, 1280, 1920 px), als **AVIF** oder **WebP**, wenn der Browser sie annimmt (`Accept`), mit Cache auf der Platte (höchstens zwei gleichzeitig). Als Motor wird **`sharp`** genutzt, falls installiert (`npm install sharp` – optional, wird beim Start erkannt, nie vorausgesetzt; `PGHL_IMAGE_ENGINE=off` schaltet ihn ab). Ohne Motor leitet `/uploads-opt` auf das Original um. Die skalierten Kopien enthalten keine Metadaten (GPS-Position, Kamera).

## Design: Farben, Schrift, Kopfzeile, Menüs

*Funnels & Websites → Website → Design* gilt für die **ganze Website**; Blöcke verweisen auf die Farben („Marke“, „Akzent“ …) statt auf feste Werte, eine Änderung wirkt also überall. Rechts zeigt die Vorschau jede Änderung sofort.

- **Farben** (Marke, Akzent, Text, Gedämpft, Hintergrund, Fläche, Linie, Erfolg, Fehler) mit **Kontrastprüfung** (WCAG-Verhältnisse für Text auf Hintergrund, grauen Text, Marke, weißen Text auf Marke).
- **Schrift & Größen:** neun **Systemschriften** (nichts wird nachgeladen – das hält die Seite schnell und DSGVO-sauber), Grundgröße, Größenverhältnis der Überschriften (die Handy-Skala ist enger), Abstandseinheit. Eigene Schriftdateien: siehe [Eigene Schriften](#eigene-schriften).
- **Ecken & Schatten** (klein/mittel/groß).
- **Kopfzeile:** Name oder Logo, Menü, Button, **Sticky**, Suchfeld, Sprachwechsler; mit Sprunglink „Zum Inhalt springen“ und einem Menü, das auf dem Handy zum Hamburger wird.
- **Menüs:** beliebig viele benannte Menüs (`main`, `footer` …) mit Einträgen, einer Ebene Untermenü und Reihenfolge; ein Eintrag zeigt auf eine Seite (folgt Umbenennungen) oder eine Adresse.
- **Fußzeile:** bis zu vier Spalten (Menü oder eigene Links), Text; Links zu **Impressum, Datenschutz, Widerruf, AGB und Barrierefreiheit** erscheinen automatisch, sobald es die Seiten gibt, dazu *Cookie-Einstellungen*, wenn der Cookie-Banner an ist.
- **Sprachen, Suche, 404-Seite, Statistik:** siehe unten.

Die älteren Einstellungen (*Einstellungen & Domain*: Markenfarbe, Schrift, Code im `<head>`, Fußzeilentext) funktionieren weiter. Code im `<head>` wird, wie bisher, erst nach der Einwilligung im Cookie-Banner geladen.

## Mit KI erstellen

*Funnels & Websites → Mit KI erstellen* baut aus einem kurzen Briefing (Unternehmen, Angebot, Zielgruppe, Ton, Du/Sie, Sprache, Landingpage / Funnel / Website) erst einen Seitenplan, dann die Blöcke jeder Seite – geprüft gegen die Blöcke dieses Baukastens und die Formulare, Kalender und Produkte des Sub-Accounts – und legt sie als **unveröffentlichten Entwurf** an (Design einer Galerie-Vorlage, Formular, Rechtsseiten). Im Editor öffnet **KI-Assistent** eine Seitenleiste für Befehle zum gewählten Abschnitt oder zur ganzen Seite („kürzer“, „FAQ hinzufügen“, „in Du-Form“) mit Vorschau, Änderungsliste und Wiederherstellungspunkt. Alles dazu: [docs/site-ai.md](site-ai.md) (Englisch).

## Vorlagen

*Funnels & Websites → Vorlagen ansehen* zeigt **23 deutsche Vorlagen** mit Vorschau je Seite, Desktop und Handy:

| Websites | Funnels |
| --- | --- |
| Coach & Beratung, Handwerksbetrieb, Agentur, SaaS & Software, Restaurant & Café, Praxis & Therapie, Immobilienmakler, Kanzlei & Steuerberatung, Fitness & Studio, Fotograf, Friseur & Beauty, Verein & Initiative, Karriere & Stellen | Lead-Magnet, Webinar-Funnel, Kurs-Verkauf, Event, Link-in-Bio, Newsletter, Podcast, Produkt-Launch, Video-Sales-Letter, Termin-Funnel (Bewerbung) |

Beim Anlegen entsteht die ganze Website: Seiten mit Beispieltexten (Platzhalter – bitte ersetzen), Design (Farben, Schrift, Kopf- und Fußzeile, Menü), die benötigten **Sammlungen mit Beispieleinträgen**, ein **Formular** (neu angelegt mit Einwilligungsfeld, oder ein vorhandenes, das du wählst; nach dem Absenden geht es zur Danke-Seite), dein **Kalender** und dein **Produkt** an den passenden Stellen und – wo es etwas zu verkaufen gibt – die **Rechtsseiten Impressum, Datenschutz und Widerruf aus den Firmendaten** (*Einwilligung & Recht*, derselbe Generator wie dort; fehlen Firmendaten, bleiben Platzhalter stehen und das Ergebnis sagt es). Schlägt ein Schritt fehl, wird alles zurückgenommen. Danach steht in der Antwort, **was noch fehlt** (Kalender anlegen, Produkt wählen, Stripe verbinden, Firmendaten eintragen).

Alle Vorlagen sind so gebaut, dass die automatische Barrierefreiheitsprüfung keine Fehler findet (Kontraste, Überschriftenfolge, Alt-Texte, Formularbeschriftungen).

## Inhalte (CMS)

*Funnels & Websites → Website → Inhalte (CMS)* (nur Websites). Eine **Sammlung** ist eine Liste gleichartiger Einträge mit eigenen **Feldern**: Text, langer Text (Markdown), Zahl, Bild, Link, E-Mail, Telefon, Datum, Ja/Nein, Auswahl, Schlagwörter, **Produkt** (zeigt einen Kauf-Button) und Bewertung. Vorlagen für **Team, Projekte & Referenzen, Produkte, Kundenstimmen, FAQ und Stellen** bringen Felder und Beispieleinträge mit.

- **Einträge** pflegst du in einer Tabelle (Entwurf/veröffentlicht, Reihenfolge, Duplizieren, Suche) und in einem Formular, das sich aus den Feldern ergibt.
- **Liste:** der Block *Sammlung* zeigt die veröffentlichten Einträge als Raster oder Liste (1–4 Spalten) mit **Filtern** (Felder „als Filter anbieten“) und Suche, Sortierung, Seitenumbruch, einem festen Filter (nur Einträge mit Feld = Wert) und einer Höchstzahl. Optional gibt es eine eigene **Listenseite** `/<pfad>`.
- **Detailseiten** `/<sammlung>/<eintrag>` mit **eigener Vorlage**, die du im selben Editor baust. In Texten stehen **Platzhalter** `{{feld}}` (bei Produkt-Feldern auch `{{feld.name}}`, `.price`, `.url`, `.id`). Detailseiten haben eigene SEO-Angaben (Titel, Beschreibung, Bild), kommen in die **`sitemap.xml`** und in die **Websuche**; Einträge im Entwurf sind nirgends sichtbar.
- Beim Veröffentlichen eines Eintrags läuft das Ereignis `site.item_published` (Workflow-Auslöser möglich).
- Beim Kopieren einer Website (Agentur-Snapshots, *In anderen Kunden kopieren*) gehen Sammlungen mit ihren Einträgen mit; Verweise auf Seiten, Komponenten, Formulare und Produkte zeigen danach auf die Kopien.

## Weiterleitungen, 404-Seite, Suche und Sprachen

- **Weiterleitungen** (*Weiterleitungen*, nur Websites): genaue Pfade und **Muster mit Stern** (`/blog/*` → `/magazin/$1`, auch `:splat`), Code **301 / 302 / 307 / 308**, Parameter der Adresse wahlweise mitnehmen, Notiz, Zähler. Genaue Pfade gelten vor Mustern; Schleifen werden abgelehnt; ein Pfad, den schon eine Seite hat, wird markiert (die Seite hat Vorrang). **Testen** zeigt, wohin ein Pfad führt; **Import** nimmt eine Liste (`/alt /neu 301`, auch aus einer Tabelle). Höchstens 500 Regeln je Website. Ziele sind Pfade der Website oder https-Adressen – Pfade der App (`/api`, `/f`, `/book`, `/uploads` …) sind reserviert.
- **Nicht gefundene Adressen:** besuchte Pfade, die es nicht gibt (ohne Bots und ohne Suchroboter-Rauschen), stehen mit Zähler in der Liste – ein Klick auf *Weiterleiten …* legt die Regel an.
- **404-Seite:** unter *Design → Suche & Fehlerseite* wählst du eine **eigene Seite** der Website (oder eine Seite mit dem Pfad `404`); sonst erscheint ein schlichter Hinweis im Design der Seite. Die 404-Seite geht mit Statuscode 404 raus und ist `noindex`.
- **Websuche** (*Design → Suche & Fehlerseite*): Suchfeld in der Kopfzeile und Seite `/search` über Seiten, Blog und Sammlungen; Umlaute werden gefaltet, Treffer im Titel zählen mehr, jede Anfrage ist je Adresse begrenzt. Seiten mit *noindex* und Seiten mit eigenem **Passwortschutz** sind nicht dabei; ist die ganze Website geschützt, ist auch `/search` gesperrt.
- **Sprachen:** unter *Design → Sprachen* legst du Standardsprache und weitere Sprachen an; im Editor *Seiten-Layout → Übersetzung anlegen* kopiert eine Seite in eine andere Sprache (eigener Pfad `<pfad>-en`, gleiche Gruppe). Zusammengehörige Seiten bekommen **`hreflang`**-Verweise und `<html lang>`, der Sprachwechsler der Kopfzeile verlinkt sie. Die Übersetzung der Texte machst du selbst (oder mit dem KI-Assistenten) – das ist ein einfacher Mechanismus, kein automatischer Übersetzer.

## Produkt / Kasse

Für den Warenkorb des Online-Shops gibt es zwei weitere Blöcke: **Shop: Produktliste** (veröffentlichte Produkte, optional eine Kollektion, mit Varianten und „In den Warenkorb“) und **Shop: Produktdetail** (ein Produkt mit Bildern, Varianten und Menge – ohne gewähltes Produkt das, auf das die Produktliste mit `?product=…` verlinkt). Ihre Buttons führen zur Kasse des Shops – Details in [store.md](store.md#on-your-website-the-blocks).

Der Block *Produkt / Kasse* zeigt ein Produkt des Sub-Accounts (Name, Text, **Preis inkl. USt**, Intervall bei Abos, Hinweis auf USt oder **§ 19 UStG**, Order-Bump und Rabattcode-Hinweis) mit einem Button zur **Kaufseite** `/buy/<kurzname>` (Stripe Checkout). Bestellt wird dort – mit **„zahlungspflichtig bestellen“**-Button, AGB-Feld und Verzicht beim Widerruf für digitale Inhalte aus [Einwilligung & Recht](consent.md#checkout-rules-germany). Der Block selbst bestellt nichts: sein Button heißt „Zur Bestellung“ und darunter steht, wie der Bestell-Button auf der nächsten Seite heißt; die Links zu Widerrufsinformationen und AGB kommen aus den Rechtstexten. Besucher sehen nichts, solange Stripe nicht verbunden ist oder das Produkt nicht gekauft werden kann; der Editor sagt, was fehlt. Die Seite, von der der Klick kam, läuft als `fp` bis in die Stripe-Metadaten, damit der Kauf in der Statistik dem Schritt zugerechnet wird.

## Barrierefreiheit (BFSG)

*Funnels & Websites → Barrierefreiheit* prüft alle Seiten der Website (und im Editor den ungespeicherten Entwurf) nach dem Standard **BFSG · EN 301 549 · WCAG 2.1 AA** auf: fehlende oder leere **Alternativtexte**, **Kontraste** (Farbpaare der Design-Farben, Texte auf farbigen Abschnitten), **Überschriftenfolge** (eine H1, keine Sprünge), **Formularbeschriftungen**, nichtssagende oder fehlende **Linktexte**, Buttons ohne Namen, **Seitensprache** und Seitentitel, Zoom-Sperre, Hauptbereich und Sprunglink, eingebettete Inhalte ohne Titel, Videos (Untertitel-Hinweis), Fokus, Tab-Reihenfolge, Bewegung, Tabellenköpfe und doppelte IDs. Jede Meldung hat Schwere (Fehler, Warnung, Hinweis), das WCAG-Kriterium, einen **Hinweis, wie du es behebst**, und springt im Editor zum Block. Der Wert 0–100 zieht je Fehler 10 und je Warnung 3 Punkte ab. Darunter steht die Liste **Von Hand prüfen** (Tastaturbedienung, 200 % Zoom, Screenreader, Untertitel …) – automatische Tests finden nur einen Teil der Probleme.

**Erklärung zur Barrierefreiheit:** *Entwurf ansehen* erzeugt aus den Firmendaten (*Einwilligung & Recht → Firmendaten*) und den Prüfergebnissen einen Entwurf (Stand, Konformität, bekannte Mängel, Kontakt, Schlichtungsstelle-Hinweis) und legt ihn auf Wunsch als Seite **„Barrierefreiheit“** an, die automatisch in der Fußzeile verlinkt wird. Das ist ein Entwurf und keine Rechtsberatung.

**Wer ist betroffen?** Das BFSG gilt seit dem 28. Juni 2025 für Verbraucher-Dienstleistungen im elektronischen Geschäftsverkehr (Online-Shops, Buchungs- und Bezahlstrecken), nicht für reine Informationsseiten. **Kleinstunternehmen** (weniger als 10 Beschäftigte und höchstens 2 Mio. € Jahresumsatz oder -bilanz) sind für **Dienstleistungen** ausgenommen. Ob das für dich gilt, entscheidest du bzw. deine Rechtsberatung; die Prüfung hilft in jedem Fall, weil dieselben Dinge Menschen mit Einschränkungen und Google helfen.

## Statistik je Funnel-Schritt

*Funnels & Websites → Website oder Funnel → Statistik* (7 Tage, 30 Tage, 90 Tage, 12 Monate; CSV-Export):

- **Besucher, Aufrufe, Conversions und Rate, Umsatz.** Jede Seite ist ein **Schritt**: Besucher, Aufrufe, wie viele davon zu einem **späteren Schritt weiterklicken** (am selben Tag) und der **Absprung** in Prozent, Ø **Zeit auf der Seite** und Ø Scrolltiefe.
- **Conversions je Schritt:** Formular abgeschickt (über die Adresse der Seite, auf der das Formular stand), **Termin gebucht** (wenn genau eine Seite den Kalender einbettet) und **Kauf** (über `fp` aus dem Produkt-Block bzw. dem Kauf-Link mit `?fp=<Seiten-ID>`) – mit Umsatz.
- **A/B-Test je Schritt:** läuft für die Seite ein Test (*A/B-Test*-Reiter der Seite), stehen Varianten, Besucher, Conversions, Rate und Uplift direkt am Schritt.
- **Umsatz laut Attribution** (*Attribution*): bezahlte Rechnungen inkl. Stripe, deren Kontakte über diesen Funnel kamen, nach erstem und letztem Kontakt.
- Verteilung auf **Geräte** und **Quellen**, Besucher pro Tag. Dashboard-Baustein **„Funnel-Auswertung“** für die Living Boards und MCP-Werkzeug `ghl_funnel_analytics`.

### Datenschutz der Zählung

Es werden **keine Cookies gesetzt und keine IP-Adressen gespeichert**: Ein Besucher ist ein **täglich wechselnder Hash** aus Adresse und Browser (mit einem geheimen Salz des Servers) – am nächsten Tag ist derselbe Besucher ein anderer; es gibt keine tagesübergreifende Wiedererkennung. Bots werden nicht gezählt, **„Do Not Track“ und Global Privacy Control** werden standardmäßig respektiert. Gespeichert werden Seite, Tag, Gerät (Desktop/Tablet/Handy), Quelle (als ein Wort), Verweildauer und Scrolltiefe; die Daten werden nach **180 Tagen** gelöscht (einstellbar 30–730 Tage unter *Design → Statistik*; dort lässt sich die Zählung auch ausschalten). Trotzdem gehört die Reichweitenmessung in die Datenschutzerklärung; der Generator unter *Einwilligung & Recht* nennt sie.

## SEO & Zugang

*Funnels & Websites → Website oder Funnel → SEO & Zugang* bündelt, was Suchmaschinen und Besucher betrifft:

- **SEO-Check** (*Seiten prüfen*): rendert jede Seite so, wie Besucher sie bekommen, und listet je Seite Befunde mit Hinweis und eine Punktzahl (0–100): fehlender oder zu kurzer/langer **Seitentitel**, **Meta-Beschreibung**, keine oder mehrere **H1**, Bilder ohne **Alternativtext**, **wenig Text** (unter 300 Wörtern), keine **internen Links**, kein **Vorschaubild**, keine **strukturierten Daten**, langer Pfad, `noindex`. Über alle Seiten hinweg: **doppelte Titel und Beschreibungen**. MCP: `ghl_site_seo_check`.
- **Beliebige Website prüfen** (unter *Weitere Felder*): dieselbe Prüfung für jede öffentliche Seite im Netz – die Website eines Interessenten (Aufhänger fürs Angebot) oder die alte Seite vor dem Umzug –, zusätzlich **HTTPS**, **Handy-Ansicht** (`viewport`), Sprache, Status und Ladezeit. Abgerufen über den abgesicherten Abruf (keine internen Adressen, höchstens 3 MB, 12 s). API `POST /api/seo-audit` `{url}`, MCP `ghl_seo_audit_url`.
- **Strukturierte Daten (Schema.org)** je Seite: Typ wählen – *Lokales Unternehmen*, *Organisation*, *FAQ*, *Dienstleistung*, *Produkt*, *Veranstaltung*, *Artikel* – und wenige Felder ausfüllen (vorbelegt aus den Firmendaten; *FAQ* liest die FAQ-Blöcke der Seite). Das JSON-LD steht beim Ausliefern im `<head>` der Seite. MCP: `ghl_site_schema_set`.
- **Passwortschutz** für eine Seite oder die ganze Website (Mitglieder-Preislisten, Kunden-Vorschau, Testseite): Besucher sehen ein Passwortfeld, das richtige Passwort öffnet die Seite für 7 Tage (Cookie nur für diese Sperre). Ein **neues Passwort beendet alle offenen Zugänge**; geschützte Seiten werden nie zwischengespeichert und tragen `noindex`. Ein Passwort für die **ganze Website** sperrt alles, was sie ausliefert – Seiten, Blog (Beiträge, Übersicht, RSS), Sammlungen, Suche, `sitemap.xml` und 404-Seite; offen bleiben nur `robots.txt` und das **Hilfe-Center** unter `/help` (ein eigenes Produkt des Sub-Accounts mit eigener öffentlicher Adresse, nicht Teil der Website). Das Passwort einer Seite geht vor dem der Website und öffnet nur diese Seite; Seiten mit eigenem Passwort erscheinen nie in der Websuche. Höchstens 10 Versuche je Adresse und Sperre in 10 Minuten (gezählt vor der Prüfung, auch bei gleichzeitigen Anfragen; das richtige Passwort setzt den Zähler zurück). MCP: `ghl_site_lock_set`, `ghl_site_lock_list`.
- **Seiten: Reihenfolge & online:** Seiten mit ↑/↓ sortieren (die erste ist die Startseite) und einzelne Seiten **offline nehmen** – Besucher bekommen die 404-Seite der Website, Domain und alle anderen Seiten bleiben online; solange sie offline ist, steht die Seite auf `noindex` (die frühere Einstellung kommt danach zurück). API `GET /api/funnels/:id/pages-state`, `PUT /api/funnel-pages/:id/offline` `{offline}`, `POST /api/funnels/:id/reorder` `{page_ids}`; MCP `ghl_site_page_offline`.
- **Text aus dem Link (URL-Parameter):** `{{url.name|Freund}}` in einem beliebigen Text – wer `…/angebot?name=Anna` öffnet, liest „Anna“, alle anderen „Freund“. Ganze Abschnitte je nach Link: `{{#if url.quelle == "facebook"}}…{{else}}…{{/if}}` (Operatoren wie bei E-Mails, siehe [email-marketing.de.md](email-marketing.de.md#bedingte-inhalte)). Werte aus dem Link werden nur zwischen Tags eingesetzt, HTML-maskiert und gekürzt (nie in Attributen oder Skripten) – ein präparierter Link kann kein Markup einschleusen.

### Eigene Schriften

*Design → Eigene Schriften*: Schriftdateien (**WOFF2, WOFF, TTF, OTF**, je bis 3 MB, bis 40 je Sub-Account) hochladen und als Schrift für **Fließtext** und **Überschriften** der Website wählen – je Stärke/Stil eine Datei. Die Dateien liegen auf deinem Server (`/site-fonts/…`, lange zwischengespeichert), es wird nichts von Dritten geladen; die Systemschrift des Designs bleibt Ersatz.

## Geschwindigkeit

Seiten sind klein und schnell gebaut: nur das **CSS der Blöcke, die auf der Seite vorkommen** (minimiert, **inline** im `<head>` – kein blockierendes Stylesheet), **Systemschriften** statt Web-Fonts, kein JavaScript-Framework (kleine Skripte für Menü, Suche, Countdown und die Statistik), `width`/`height` an jedem Bild und ein reservierter Rahmen für Videos (**kein Layout-Sprung**), `loading="lazy"` für Bilder und Videos unterhalb des ersten Bildschirms, `<main>` und `lang`. Die Testsuite prüft Budgets für alle Vorlagen (HTML ≤ 32 kB, gzip ≤ 8 kB, CSS ≤ 16 kB, höchstens 1 200 Elemente; gemessen: größte Vorlagenseite ≈ 19 kB).

## Für Entwickler

- **Dateien:** `server/modules/funnels.ts` (Seiten, öffentliche Auslieferung, Vorschau), `blog.ts`, und je Thema ein eigenes Modul: `site-routing.ts` (Weiterleitungen, Suche, Übersetzungen, tiefe Pfade), `site-design.ts` (Komponenten, Design-Daten), `site-cms.ts` (Sammlungen), `site-product.ts` (Produkt-Block), `site-a11y.ts` (Prüfung, Erklärung), `site-analytics.ts` (Statistik, Board-Baustein, MCP), `site-templates.ts` (Galerie), `site-media.ts` (Bildgrößen, `/uploads-opt`), `site-snapshot.ts` (Kopieren). Die Logik liegt rein in `server/services/site-*.ts` (`site-blocks.ts` Blöcke, `site-layout.ts` Abschnitte/Zeilen/Spalten, `site-render.ts` Seite, Kopf- und Fußzeile, `site-style.ts` Design-Token und responsives CSS, `site-url.ts`, `site-settings.ts`, `site-redirects.ts`, `site-search.ts`, `site-a11y.ts`, `site-cms.ts`, `site-analytics.ts`, `site-images.ts`, `site-templates*.ts`). Die Oberfläche: `web/src/pages/site/*` (`Editor`, `Tree`, `Inspector`, `Design`, `Cms`, `Redirects`, `A11y`, `Analytics`, `Templates`, `model.ts` als reine Baum-Operationen).
- **Eigene Blöcke:** `siteBlocks(app).set(type, { type, css, render(env, block, opts) })` (`server/services/site-blocks.ts`). Das CSS kommt nur auf Seiten, die den Block benutzen; `env` bringt Design-Token, Funnel, Seite, `preview` und `render` für verschachtelte Blöcke. Danach den Block im Editor-Katalog (`web/src/pages/site/blocks.ts`) eintragen – ein Test prüft, dass jeder Katalog-Block einen Server-Renderer hat.
- **Haken in `app.services`:** `siteBlocks` (Block-Register), `siteRedirect(ctx, funnel, segments)` (Weiterleitung vor der Seite), `siteResolve` (dynamische Pfade, z. B. Sammlungen), `siteSearchDocs` (Dokumente der Suche), `siteSearchHide` (Seiten-IDs, die nicht in die Suche dürfen, z. B. passwortgeschützte), `siteSitemap` (Adressen der Sitemap), `siteServe` (die Auslieferung für andere Module), `siteNotFound`/`siteMissed` (404-Seite und Zähler), `siteImages` (`dims`, `srcset`) und `imageEngine` (`{name, formats, resize}` – ein anderer Motor als `sharp`), dazu die bestehenden `pageServe`, `pageVisit`, `htmlTransforms`, `buyPageHtml`, `buyCheckout`, `boardWidgets`, `mcpTools`, `snapshotParts`.
- **Tabellen:** `funnel_pages.layout`, `site_components`, `site_collections`, `site_items`, `site_redirects`, `site_misses`, `site_hits`, `site_conversions`; alle hängen am Sub-Account (`location_id`) und an der Website (`ON DELETE CASCADE`). Die Isolationstests (`tests/tenant-isolation.test.ts`, `tests/security.test.ts`) säen sie über `tests/site-fixtures.ts`.
- **SEO & Zugang, Schriften:** `site-seo.ts` (Check über `services/site-seo.ts` – `checkSeo`, `siteSeoIssues`, `buildSchema`, `schemaScript` –, Tabelle `site_schema`), `site-protect.ts` (Tabelle `site_locks`, Formular-Ziel `POST /api/site-unlock`, signiertes Cookie je Sperre und Version), `site-dyntext.ts` (`{{url.…}}` und `{{#if url.…}}`), `site-fonts.ts` (Tabellen `site_fonts`, `site_font_use`, Dateien unter `data/site-fonts/`); alle hängen sich über `app.services.pageServe` an die Auslieferung, registriert mit einer Zeile `...gapsSitesModules` (`modules/gaps-sites.ts`). Tests: `tests/gaps-sites.test.ts`.
- **API:** alle Wege stehen in [docs/api.md](api.md#website-builder-funnels--websites); dazu `GET /api/funnels/:id/seo`, `GET|PUT /api/funnel-pages/:id/schema`, `GET|PUT /api/funnels/:id/locks`, `DELETE /api/funnels/:id/locks/:lock`, `GET|POST /api/site-fonts`, `DELETE /api/site-fonts/:id`, `GET|PUT /api/site-fonts/use/:funnel`.
