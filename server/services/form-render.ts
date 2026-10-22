import { escapeHtml } from '../core/template.js';
import type { FormField } from './form-fields.js';
import { buildScreens, clientSpec, leanSpec, type FormMode } from './form-logic.js';
import { formScript, formStyle, planRuntime } from './form-runtime.js';
import { luminance, themeOf, themeVars } from './form-themes.js';

/**
 * The public form as HTML: the classic layout (all questions of a page together) and one question at a time (keyboard, progress bar,
 * transitions), both themed. The browser script and the stylesheet are assembled from parts (form-runtime.ts): the base for a classic
 * form plus only what this form uses. The rules the script runs (show_if, logic jumps, calculators) are the ones in form-logic.ts,
 * handed over as data (clientSpec) so server and browser cannot disagree about where an answer leads.
 */

export interface FormRuntime {
  /** Turnstile site key, when the form is protected by a captcha and the sub-account has keys. */
  captcha?: { site_key: string } | null;
  /** A workflow listens for abandoned entries of this form: the page reports e-mail and phone as they are typed. */
  partial?: boolean;
  /** Payment field: product name and price as shown. */
  products?: Record<string, { name: string; price: string }>;
}

export const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** The letter before an option (keyboard shortcut): only the one-at-a-time layout shows and uses it. */
const KEY = (i: number, tf: boolean) => (tf ? `<span class="pf-key" aria-hidden="true">${i < 26 ? String.fromCharCode(65 + i) : ''}</span>` : '');

function control(f: FormField, rt: FormRuntime, tf: boolean): string {
  const nm = escapeHtml(f.name);
  const id = escapeHtml(f.id);
  const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
  const req = f.required ? ' aria-required="true"' : '';
  const opts = f.options ?? [];
  switch (f.type) {
    case 'hidden':
      return `<input type="hidden" name="${nm}" value="${escapeHtml(f.value ?? '')}">`;
    case 'textarea':
      return `<textarea id="${id}" name="${nm}"${req}${ph}></textarea>`;
    case 'select':
      return `<select id="${id}" name="${nm}"${req}><option value="">Bitte wählen…</option>${opts.map((o) => `<option>${escapeHtml(o)}</option>`).join('')}</select>`;
    case 'radio':
      return `<div class="pf-opts" role="radiogroup" aria-labelledby="L_${id}">${opts.map((o, i) => `<label class="pf-opt"><input type="radio" name="${nm}" value="${escapeHtml(o)}">${KEY(i, tf)}<span>${escapeHtml(o)}</span></label>`).join('')}</div>`;
    case 'checkbox':
      return opts.length
        ? `<div class="pf-opts" role="group" aria-labelledby="L_${id}">${opts.map((o, i) => `<label class="pf-opt"><input type="checkbox" name="${nm}" value="${escapeHtml(o)}">${KEY(i, tf)}<span>${escapeHtml(o)}</span></label>`).join('')}</div>`
        : `<label class="pf-opt"><input type="checkbox" name="${nm}" value="ja"><span>${escapeHtml(f.label)}</span></label>`;
    case 'consent':
      return `<label class="pf-opt"><input type="checkbox" name="${nm}" value="ja"><span>${escapeHtml(f.label)}</span></label>`;
    case 'file':
      return `<input id="${id}" type="file" name="${nm}" accept="${escapeHtml(f.placeholder || 'image/*,application/pdf,.doc,.docx,.xls,.xlsx,.zip,.txt,.csv')}"><small class="pf-muted">max. 5 MB</small>`;
    case 'rating': {
      const max = f.max ?? 5;
      return `<div class="pf-stars" role="radiogroup" aria-labelledby="L_${id}">${Array.from({ length: max }, (_v, i) => `<button type="button" role="radio" aria-checked="false" data-v="${i + 1}" aria-label="${i + 1} von ${max} Sternen">★</button>`).join('')}</div><input type="hidden" name="${nm}" value="">`;
    }
    case 'nps':
    case 'scale': {
      const lo = f.min ?? (f.type === 'nps' ? 0 : 1);
      const hi = f.max ?? 10;
      const ends = f.labels ? `<div class="pf-ends"><span>${escapeHtml(f.labels[0])}</span><span>${escapeHtml(f.labels[1])}</span></div>` : f.type === 'nps' ? '<div class="pf-ends"><span>Sehr unwahrscheinlich</span><span>Sehr wahrscheinlich</span></div>' : '';
      if (f.type === 'scale' && f.style === 'slider')
        return `<div class="pf-slider"><input type="range" min="${lo}" max="${hi}" step="${f.step ?? 1}" value="${Math.round((lo + hi) / 2)}" aria-labelledby="L_${id}" data-slider><output class="pf-out" aria-hidden="true">–</output></div>${ends}<input type="hidden" name="${nm}" value="">`;
      const step = f.type === 'scale' ? f.step ?? 1 : 1;
      const vals: number[] = [];
      for (let v = lo; v <= hi && vals.length < 101; v += step) vals.push(v);
      return `<div class="pf-scale" role="radiogroup" aria-labelledby="L_${id}">${vals.map((v) => `<button type="button" role="radio" aria-checked="false" data-v="${v}">${v}</button>`).join('')}</div>${ends}<input type="hidden" name="${nm}" value="">`;
    }
    case 'signature':
      return `<div class="pf-sig"><canvas aria-label="Unterschrift – mit Finger oder Maus zeichnen" role="img"></canvas><button type="button" class="pf-clear">Löschen</button></div><input type="hidden" name="${nm}" value="">`;
    case 'date_range':
      return `<div class="pf-range"><label>Von<input type="date" data-from aria-label="Von"></label><label>Bis<input type="date" data-to aria-label="Bis"></label></div><input type="hidden" name="${nm}" value="">`;
    case 'ranking':
      return `<p class="pf-muted pf-small">Bringe die Punkte mit den Pfeilen in deine Reihenfolge (oben = am wichtigsten).</p><ol class="pf-rank" aria-labelledby="L_${id}">${opts.map((o) => `<li data-v="${escapeHtml(o)}"><span class="pf-rk">${escapeHtml(o)}</span><button type="button" data-up aria-label="${escapeHtml(o)} nach oben">↑</button><button type="button" data-down aria-label="${escapeHtml(o)} nach unten">↓</button></li>`).join('')}</ol><div class="pf-rank-in"></div>`;
    case 'picture_choice':
      return `<div class="pf-pics" role="${f.multiple ? 'group' : 'radiogroup'}" aria-labelledby="L_${id}">${opts
        .map((o, i) => {
          const img = f.images?.[i];
          return `<label class="pf-pic"><input type="${f.multiple ? 'checkbox' : 'radio'}" name="${nm}" value="${escapeHtml(o)}">${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">` : '<span class="pf-noimg"></span>'}<span class="pf-cap">${KEY(i, tf)}${escapeHtml(o)}</span></label>`;
        })
        .join('')}</div>`;
    case 'payment': {
      const p = f.product_id ? rt.products?.[f.product_id] : undefined;
      return p
        ? `<div class="pf-pay"><strong>${escapeHtml(p.name)}</strong><span class="pf-price">${escapeHtml(p.price)}</span><small class="pf-muted">Nach dem Absenden geht es weiter zur sicheren Zahlung über Stripe.</small></div>`
        : '<div class="pf-pay"><small class="pf-muted">Die Zahlung ist gerade nicht eingerichtet.</small></div>';
    }
    case 'calculator':
      return `<output class="pf-calc" aria-live="polite"><span class="pf-calc-v">0</span></output><input type="hidden" name="${nm}" value="">`;
    default: {
      const type = f.type === 'phone' ? 'tel' : f.type === 'number' ? 'text' : f.type;
      const ac = f.name === 'email' ? ' autocomplete="email"' : f.name === 'phone' ? ' autocomplete="tel"' : f.name === 'first_name' ? ' autocomplete="given-name"' : f.name === 'last_name' ? ' autocomplete="family-name"' : '';
      const mode = f.type === 'number' ? ' inputmode="decimal"' : '';
      return `<input id="${id}" type="${type}" name="${nm}"${req}${ph}${ac}${mode}>`;
    }
  }
}

function question(f: FormField, rt: FormRuntime, tf: boolean): string {
  const id = escapeHtml(f.id);
  if (f.type === 'heading') return `<div class="pf-q pf-heading" data-id="${id}" data-name="${escapeHtml(f.name)}" data-type="heading"><h2>${escapeHtml(f.label)}</h2></div>`;
  if (f.type === 'hidden') return `<div class="pf-q" data-id="${id}" data-name="${escapeHtml(f.name)}" data-type="hidden">${control(f, rt, tf)}</div>`;
  const needsLabel = !(f.type === 'consent' || (f.type === 'checkbox' && !(f.options ?? []).length));
  // Fields with their own input get a real <label for>; groups of buttons are labelled by a heading-like element.
  const tag = ['select', 'textarea', 'file', 'text', 'email', 'phone', 'date', 'number'].includes(f.type) ? 'label' : 'div';
  const label = needsLabel ? `<${tag}${tag === 'label' ? ` for="${id}"` : ''} class="pf-label" id="L_${id}">${escapeHtml(f.label)}${f.required ? ' <span aria-hidden="true">*</span>' : ''}</${tag}>` : '';
  const attrs = [`data-id="${id}"`, `data-name="${escapeHtml(f.name)}"`, `data-type="${f.type}"`, f.required ? 'data-req="1"' : '', f.min !== undefined && f.type === 'number' ? `data-min="${f.min}"` : '', f.max !== undefined && f.type === 'number' ? `data-max="${f.max}"` : '', f.type === 'calculator' ? `data-fmt="${f.format ?? 'number'}"` : '', f.show_if ? `data-show="${escapeHtml(JSON.stringify(f.show_if))}"` : '']
    .filter(Boolean)
    .join(' ');
  return `<div class="pf-q" ${attrs}>${label}${f.hint ? `<div class="pf-hint-text">${escapeHtml(f.hint)}</div>` : ''}${control(f, rt, tf)}<div class="pf-err" role="alert"></div></div>`;
}

export interface RenderOptions {
  /** The form is the whole page (/f/<id>): the first question takes the focus, the screen is full height. */
  standalone?: boolean;
}

/** The form as an HTML fragment (used on its own page and inside funnel pages). */
export function renderForm(form: any, opts: RenderOptions = {}): string {
  const s = form.settings ?? {};
  const mode: FormMode = s.mode === 'typeform' ? 'typeform' : 'classic';
  const tf = mode === 'typeform';
  const rt: FormRuntime = form.runtime ?? {};
  const theme = themeOf(s);
  const fields: FormField[] = form.fields;
  const screens = buildScreens(fields, mode);
  const rid = `pfr_${form.id}`;
  const fid = `pf_${form.id}`;
  const showProgress = s.show_progress !== false && (tf || screens.length > 1);
  const danger = luminance(theme.card) < 0.4 ? '#fca5a5' : '#b91c1c';
  const submitText = String(s.submit_text || 'Absenden');
  const welcome = s.welcome && (s.welcome.title || s.welcome.text) ? s.welcome : null;
  const plan = planRuntime({ fields, settings: s, mode, screens: screens.length, welcome: !!welcome, progress: showProgress, standalone: !!opts.standalone, captcha: !!rt.captcha?.site_key, partial: !!rt.partial });
  const multi = plan.js.includes('nav');
  // only what the parts read: defaults are left out
  const cfg = {
    id: form.id,
    ...(tf ? { tf: true, ...(s.auto_advance !== false ? { auto: true } : {}), ...(opts.standalone ? { standalone: true } : {}) } : {}),
    ...(s.redirect_url ? { redirect: s.redirect_url } : {}),
    ...(multi && submitText !== 'Absenden' ? { submit: submitText } : {}),
    ...(rt.captcha?.site_key ? { ts: rt.captcha.site_key } : {}),
  };
  const spec = plan.rules ? leanSpec(clientSpec(fields, s, mode), plan.formulas) : null;
  // a form with one screen needs no "back" and says what the button does from the start
  const next = multi ? (tf ? 'OK' : 'Weiter') : submitText;
  return `
<div id="${rid}" class="pf pf-${tf ? 'tf' : 'classic'}${opts.standalone ? ' pf-standalone' : ''}" style="${escapeHtml(themeVars(theme))};--pf-danger:${danger}">
<style>${formStyle(plan)}</style>
<div class="pf-inner">
${showProgress ? '<div class="pf-progress" role="progressbar" aria-label="Fortschritt"><div class="pf-bar"><i></i></div><span class="pf-count"></span></div>' : ''}
${welcome ? `<section class="pf-welcome"><h1>${escapeHtml(welcome.title)}</h1>${welcome.text ? `<p>${escapeHtml(welcome.text)}</p>` : ''}<button type="button" class="pf-start">${escapeHtml(welcome.button || 'Los geht’s')}</button></section>` : ''}
<form id="${fid}" class="pghl-form" novalidate>
  <div class="pf-stack">${screens.map((sc, i) => `<section class="pghl-step" data-step="${i}" data-state="${i ? 'after' : 'active'}">${sc.fields.map((f) => question(f, rt, tf)).join('\n')}</section>`).join('\n')}</div>
  <input type="text" name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
  ${rt.captcha?.site_key ? '<div class="pf-captcha" hidden></div>' : ''}
  <div class="pf-nav">${multi ? '<button type="button" class="pf-back" hidden>Zurück</button>' : ''}<button type="button" class="pf-next">${escapeHtml(next)}</button>${tf ? '<span class="pf-hintkey">Drücke <kbd>Enter ↵</kbd></span>' : ''}</div>
  <div class="error" data-err role="alert"></div>
</form>
<div id="${fid}_done" class="pf-done" hidden>${escapeHtml(s.thank_you || 'Danke! Wir melden uns in Kürze.')}</div>
<noscript><p class="error">Bitte JavaScript einschalten, um das Formular abzusenden.</p></noscript>
</div>
</div>
${rt.captcha?.site_key ? `<script src="${TURNSTILE_SRC}" async defer data-category="necessary"></script>` : ''}
<script>${formScript(cfg, spec, plan)}</script>`;
}

/** CSS for the page around a standalone form: the colour or picture behind it. */
export function pageStyle(settings: { theme?: any; color?: string } | undefined): string {
  const t = themeOf(settings);
  const img = t.bg_image ? `background-image:url('${t.bg_image.replace(/['"()\\]/g, '')}');background-size:cover;background-position:center;background-attachment:fixed;` : '';
  return `<style>body{background:${t.background};${img}}${t.bg_image && t.bg_overlay ? `body::before{content:"";position:fixed;inset:0;background:rgba(0,0,0,${t.bg_overlay / 100});pointer-events:none;z-index:0}` : ''}</style>`;
}
