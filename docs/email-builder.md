**English** · [Deutsch](email-builder.de.md)

# Email designer (drag & drop)

> 60 ready-made German templates are in the **Template gallery**; A/B tests, segments and deliverability are described in [E-mail marketing](email-marketing.md).

Design e-mails the way you do in GoHighLevel: drag blocks onto the canvas on the left, adjust them on the right, done. The designer is available in

- **Campaigns** → open a campaign → *Content* → **Design with the email designer**,
- **Campaigns → Templates** → template (e-mail) → **Design with the email designer**,
- **Automations** → step **Send email** → **Design with the email designer**.

In [simple mode](theming.md#einfach-modus), alignment, spacing, colors and font size of a block (for a button also colors, corners and full width, for an image the width), the background and spacing of a section, and the look of the whole e-mail are under **Appearance** – open as soon as something differs from the default.

Plain text or HTML e-mails keep working as before; *Write as text* switches a design off again. No credentials are needed – e-mails go out through the sending method set up under **Settings → Email & SMS** (without SMTP, e-mails are only saved).

## Using the designer

| Area | What you get |
| --- | --- |
| Left: blocks | **Layout** (a section with 1, 2 or 3 columns), **Content**: heading, text, image, button, divider, spacer, social media, video, HTML, footer. Drag them (or tap = insert after the selection). **My sections**: saved, reusable sections. **Templates**: 6 starter templates (Newsletter, Offer, Event invitation, Review request, Welcome, Plain letter). |
| Middle: canvas | Move blocks (also between columns and sections), drag sections by their handle; toolbar on a block/section: up, down, duplicate, delete. |
| Right: settings | For each block its content and appearance (spacing, alignment, colors, font size), for each section the column split (50/50, 33/67, 67/33, 33/33/33), background and inner padding. With nothing selected: width (default 600 px), background, content color, font, text and link color, preview text (preheader) and the check (errors/hints). **Insert placeholder** puts `{{contact.first_name}}` & co. at the cursor. |
| Top | Subject, undo/redo (Ctrl+Z / Ctrl+Y), desktop/phone, **Preview** (with sample data “Max Mustermann”), **Text** (the text version), **Test** (test e-mail to one address, subject with `[TEST]`), Save, ✕ or Esc closes. Del deletes the selected block. |

Text blocks support **bold** (`**bold**`), *italic* (`*italic*`), links (`[text](https://…)`) and lists (lines starting with `- ` or `1. `) – the toolbar inserts them. Images come from the uploads (or by address); video blocks show a thumbnail (automatic for YouTube) that links to the video.

**Footer:** company name, address (default `{{location.address}}` from *Settings → Company*), notice text, unsubscribe link and an optional **preferences link** (the text is up to you; without your own entry, sending adds “Einstellungen” (settings) next to “Abmelden” (unsubscribe) as long as the [preference center](consent.md) is linked). In **campaigns the footer is mandatory** – without a footer or without an address, sending does not start. If it is missing in templates or workflow e-mails, a small footer with company, address and unsubscribe link is appended automatically.

## What happens when you save

The design is saved as JSON (`design`) next to the text. The **server** turns it into

- the finished HTML (`body`, `is_html = 1`): table layout with inline styles, Outlook buttons (VML), columns stacked on phones, dark-mode hints, alt texts, escaped text, only `http(s)`, `mailto:` and `tel:` links, HTML blocks without scripts/forms/iframes,
- the text version (`body_text`), built from the design (links as “text (address)”, buttons as “label: address”).

Placeholders stay in the HTML and are only replaced per recipient when sending (values are HTML-safe). The personal unsubscribe link is stored in the saved HTML as `%%unsubscribe_url%%` and filled in when sending; in the text you can link it yourself with `{{unsubscribe_url}}`. Open/click tracking and trigger links work as with all other e-mails.

Because the server renders, the API, MCP and workflows always send the finished HTML – they don't need to know anything about designs.

## API

Fields on `POST /api/templates`, `PATCH /api/templates/:id`, `POST /api/campaigns`, `PATCH /api/campaigns/:id` and on workflow steps `send_email` (in `steps`):

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

- Block types: `heading` (`text`, `level` 1–3), `text` (`text`), `image` (`src`, `alt`, `href`, `width`), `button` (`label`, `href`, `background`, `textColor`, `radius`, `fullWidth`), `divider` (`color`, `thickness`, `width` %), `spacer` (`height`), `social` (`variant: icons|text`, `items: [{network, url}]`, networks: facebook, instagram, linkedin, x, youtube, tiktok, whatsapp, website, email), `video` (`url`, `thumbnail`, `caption`, `alt`), `html` (`html`), `footer` (`company`, `address`, `text`, `unsubscribeLabel`). `style` per block: `paddingY`, `paddingX`, `align`, `color`, `background`, `fontSize`.
- Missing values get defaults, colors must be `#rgb`/`#rrggbb`, numbers are clamped; unknown block types → 400.
- The response contains `design` (cleaned up), `body` (HTML) and `body_text`. `design: null` switches back to a plain e-mail; a new `body` without `design` also discards the design.
- `GET /api/templates/:id` returns a template including its design.

Around the designer:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/email-builder/starters` | Starter templates `[{key, name, description, subject, design}]` |
| `POST /api/email-builder/render` `{design, campaign?}` | HTML, text and the check `issues: [{level: error\|warning, text}]`, without saving |
| `POST /api/email-builder/test` `{design, subject, to, contact_id?}` | Test e-mail (placeholders filled with sample or contact data, at most 20 per 10 minutes) |
| `GET/POST /api/email-builder/sections`, `DELETE /api/email-builder/sections/:id` | Saved sections `{name, section}` |

MCP: `ghl_list_email_templates` (templates + starter templates) and `ghl_save_email_template` (`name`, `subject`, `body` or `design` or `starter`).

Permissions: everything under *Campaigns & templates*; starter templates and sections can be read by all logins of the sub-account (including the workflow editor).
