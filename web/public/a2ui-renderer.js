/*
 * HyperLevel A2UI renderer (A2UI 1.0, basic catalog subset) – draws an agent's interface description with plain DOM elements.
 * Used by the website chat (server/modules/livechat.ts) and the assistant panel (web/src/a2ui/A2uiView.tsx).
 *
 *   var h = HLA2UI.mount(element, messages, { send: function (clientMsg) { return Promise<serverMsgs[]> }, callAgent: function (clientMsg) { return Promise<serverMsg> } });
 *   h.apply(moreServerMessages);
 *
 * Components: Text, Column, Row, List, Card, Divider, Button, TextField, CheckBox, ChoicePicker, DateTimeInput, Image.
 * Unknown components render as nothing. No HTML from the agent is ever inserted: text is set as text, only **bold** is styled.
 * Docs: docs/a2ui.md
 */
(function () {
  'use strict';
  if (window.HLA2UI) return;

  var CSS =
    '.a2ui{display:flex;flex-direction:column;gap:8px;font:inherit;color:inherit}' +
    '.a2ui-col{display:flex;flex-direction:column;gap:8px}.a2ui-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
    '.a2ui-card{border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:10px;background:var(--panel,#fff)}' +
    '.a2ui-caption{font-size:12px;opacity:.8;min-height:1em}.a2ui-label{font-size:12px;font-weight:600;margin-bottom:4px}' +
    '.a2ui-chips{display:flex;flex-wrap:wrap;gap:6px}' +
    '.a2ui-chip{border:1px solid var(--line,#d1d5db);background:var(--panel,#fff);color:inherit;border-radius:999px;padding:6px 11px;font-size:13px;cursor:pointer;min-height:34px}' +
    '.a2ui-chip[aria-checked="true"]{background:var(--brand,#2563eb);border-color:var(--brand,#2563eb);color:#fff}' +
    '.a2ui-btn{border:1px solid var(--line,#d1d5db);background:var(--panel,#fff);color:inherit;border-radius:10px;padding:9px 14px;font-weight:600;cursor:pointer;min-height:40px}' +
    '.a2ui-btn.primary{background:var(--brand,#2563eb);border-color:var(--brand,#2563eb);color:#fff}.a2ui-btn:disabled{opacity:.55;cursor:default}' +
    '.a2ui-input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line,#d1d5db);border-radius:8px;font:inherit;background:var(--panel,#fff);color:inherit}' +
    '.a2ui-divider{border:0;border-top:1px solid var(--line,#e5e7eb);margin:2px 0}.a2ui-img{max-width:100%;border-radius:8px}';

  function injectCss(doc) {
    if (doc.getElementById('a2ui-css')) return;
    var s = doc.createElement('style');
    s.id = 'a2ui-css';
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  // --- data model (JSON Pointer paths) ---
  function parts(p) {
    return String(p || '/')
      .split('/')
      .slice(1)
      .filter(function (x) { return x !== ''; })
      .map(function (x) { return x.replace(/~1/g, '/').replace(/~0/g, '~'); });
  }
  function getPath(data, p) {
    var cur = data;
    var ps = parts(p);
    for (var i = 0; i < ps.length; i++) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[ps[i]];
    }
    return cur;
  }
  function setPath(data, p, value) {
    var ps = parts(p);
    if (!ps.length) return value && typeof value === 'object' ? value : {};
    var cur = data;
    for (var i = 0; i < ps.length - 1; i++) {
      if (cur[ps[i]] == null || typeof cur[ps[i]] !== 'object') cur[ps[i]] = {};
      cur = cur[ps[i]];
    }
    if (value === null) delete cur[ps[ps.length - 1]];
    else cur[ps[ps.length - 1]] = value;
    return data;
  }

  var uid = 0;

  function mount(root, messages, opts) {
    opts = opts || {};
    var doc = root.ownerDocument || document;
    injectCss(doc);
    var surfaces = {};
    var order = [];

    function resolve(s, v) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (typeof v['@path'] === 'string') return getPath(s.data, v['@path']);
        if (v['@call'] === 'formatString') {
          var tpl = String((v.args && v.args.value) || '');
          return tpl.replace(/\$\{([^}]+)\}/g, function (_, p) {
            var x = getPath(s.data, p.trim());
            return x == null ? '' : String(x);
          });
        }
        var out = {};
        for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = resolve(s, v[k]);
        return out;
      }
      return v;
    }

    function textNodes(el, txt) {
      // only **bold** and line breaks; everything else stays plain text
      String(txt == null ? '' : txt)
        .split(/(\*\*[^*]+\*\*|\n)/)
        .forEach(function (part) {
          if (!part) return;
          if (part === '\n') el.appendChild(doc.createElement('br'));
          else if (/^\*\*[^*]+\*\*$/.test(part)) {
            var b = doc.createElement('strong');
            b.textContent = part.slice(2, -2);
            el.appendChild(b);
          } else el.appendChild(doc.createTextNode(part));
        });
    }

    function labelled(s, c, input, isGroup) {
      var wrap = doc.createElement(isGroup ? 'div' : 'label');
      wrap.style.display = 'block';
      var label = resolve(s, c.label);
      var acc = c['@accessibility'] || {};
      if (label) {
        var l = doc.createElement('div');
        l.className = 'a2ui-label';
        l.textContent = String(label);
        if (isGroup) l.setAttribute('aria-hidden', 'true');
        wrap.appendChild(l);
      }
      var name = acc.label || label;
      if (name && !input.getAttribute('aria-label')) input.setAttribute('aria-label', String(name));
      wrap.appendChild(input);
      return wrap;
    }

    function render(s, id, depth, inline) {
      var c = s.components[id];
      if (!c || depth > 30) return null;
      var el;
      var acc = c['@accessibility'] || {};
      switch (c.component) {
        case 'Text':
          el = doc.createElement(inline ? 'span' : 'div');
          if (c.variant === 'caption') el.className = 'a2ui-caption';
          textNodes(el, resolve(s, c.text));
          if (acc.live) el.setAttribute('aria-live', acc.live);
          break;
        case 'Column':
        case 'Row':
        case 'List':
        case 'Card': {
          el = doc.createElement('div');
          el.className = c.component === 'Row' || (c.component === 'List' && c.direction === 'horizontal') ? 'a2ui-row' : c.component === 'Card' ? 'a2ui-card a2ui-col' : 'a2ui-col';
          var kids = c.component === 'Card' ? [c.child] : Array.isArray(c.children) ? c.children : [];
          kids.forEach(function (k) {
            var x = render(s, k, depth + 1);
            if (x) el.appendChild(x);
          });
          break;
        }
        case 'Divider':
          el = doc.createElement('hr');
          el.className = 'a2ui-divider';
          break;
        case 'Image': {
          var url = String(resolve(s, c.url) || '');
          if (!/^https?:\/\//i.test(url)) return null;
          el = doc.createElement('img');
          el.className = 'a2ui-img';
          el.src = url;
          el.alt = String(resolve(s, c.description) || '');
          break;
        }
        case 'Button': {
          el = doc.createElement('button');
          el.type = 'button';
          el.className = 'a2ui-btn' + (c.variant === 'primary' ? ' primary' : '');
          var inner = c.child ? render(s, c.child, depth + 1, true) : null;
          if (inner) el.appendChild(inner);
          if (acc.label) el.setAttribute('aria-label', acc.label);
          el.disabled = !!s.busy;
          el.onclick = function () { fire(s, c); };
          break;
        }
        case 'TextField': {
          var multi = c.variant === 'longText';
          var input = doc.createElement(multi ? 'textarea' : 'input');
          input.className = 'a2ui-input';
          if (!multi) input.type = c.variant === 'number' ? 'number' : c.variant === 'obscured' ? 'password' : 'text';
          input.value = String(resolve(s, c.value) == null ? '' : resolve(s, c.value));
          if (c.placeholder) input.placeholder = String(resolve(s, c.placeholder));
          input.setAttribute('data-a2ui-id', id);
          input.oninput = function () {
            if (c.value && c.value['@path']) s.data = setPath(s.data, c.value['@path'], input.value);
          };
          el = labelled(s, c, input);
          break;
        }
        case 'CheckBox': {
          var cb = doc.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!resolve(s, c.value);
          cb.onchange = function () {
            if (c.value && c.value['@path']) s.data = setPath(s.data, c.value['@path'], cb.checked);
          };
          el = doc.createElement('label');
          el.className = 'a2ui-row';
          el.appendChild(cb);
          el.appendChild(doc.createTextNode(String(resolve(s, c.label) || '')));
          break;
        }
        case 'DateTimeInput': {
          var dt = doc.createElement('input');
          dt.className = 'a2ui-input';
          dt.type = c.enableDate === false ? 'time' : c.enableTime ? 'datetime-local' : 'date';
          dt.value = String(resolve(s, c.value) || '');
          dt.onchange = function () {
            if (c.value && c.value['@path']) s.data = setPath(s.data, c.value['@path'], dt.value);
          };
          el = labelled(s, c, dt);
          break;
        }
        case 'ChoicePicker': {
          var multiSel = c.variant === 'multipleSelection';
          var chosen = resolve(s, c.value);
          chosen = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
          var group = doc.createElement('div');
          group.className = 'a2ui-chips';
          group.setAttribute('role', multiSel ? 'group' : 'radiogroup');
          var lbl = resolve(s, c.label);
          if (lbl) group.setAttribute('aria-label', String(lbl));
          (Array.isArray(c.options) ? c.options : []).forEach(function (o) {
            var b = doc.createElement('button');
            b.type = 'button';
            b.className = 'a2ui-chip';
            b.setAttribute('role', multiSel ? 'checkbox' : 'radio');
            b.setAttribute('aria-checked', String(chosen.indexOf(o.value) >= 0));
            b.textContent = String(resolve(s, o.label));
            b.disabled = !!s.busy;
            b.onclick = function () {
              var next = multiSel ? (chosen.indexOf(o.value) >= 0 ? chosen.filter(function (x) { return x !== o.value; }) : chosen.concat([o.value])) : [o.value];
              if (c.value && c.value['@path']) s.data = setPath(s.data, c.value['@path'], next);
              var meta = c['@metadata'] || {};
              if (meta.onChangeCall && opts.callAgent) callAgent(s, meta.onChangeCall, meta.resultPath);
              draw();
            };
            group.appendChild(b);
          });
          el = lbl ? labelled(s, { label: lbl }, group, true) : group;
          break;
        }
        default:
          return null;
      }
      return el;
    }

    function callAgent(s, call, resultPath) {
      var id = 'call_' + ++uid;
      var msg = { version: '1.0', callAgentFunction: { surfaceId: s.id, functionCallId: id, callFunction: { '@call': call['@call'], catalogId: call.catalogId, args: resolve(s, call.args || {}) } } };
      Promise.resolve(opts.callAgent(msg))
        .then(function (res) {
          var r = res && res.agentFunctionResponse;
          if (!r || r.functionCallId !== id) return;
          if (resultPath) s.data = setPath(s.data, resultPath, r.error ? r.error.message : r.value && r.value.message != null ? r.value.message : r.value);
          draw();
        })
        .catch(function () {});
    }

    function fire(s, c) {
      var ev = (c.action && c.action.event) || null;
      if (!ev || !opts.send) return;
      var msg = { version: '1.0', action: { name: ev.name, surfaceId: s.id, sourceComponentId: c.id, timestamp: new Date().toISOString(), context: resolve(s, ev.context || {}) } };
      s.busy = true;
      draw();
      Promise.resolve(opts.send(msg))
        .then(function (more) {
          s.busy = false;
          if (Array.isArray(more)) apply(more);
          else draw();
        })
        .catch(function (e) {
          s.busy = false;
          s.data = setPath(s.data, '/status', (e && e.message) || 'Das ging gerade nicht.');
          draw();
        });
    }

    function apply(list) {
      (list || []).forEach(function (m) {
        if (!m || m.version !== '1.0') return;
        if (m.createSurface) {
          var cs = m.createSurface;
          surfaces[cs.surfaceId] = { id: cs.surfaceId, components: {}, data: JSON.parse(JSON.stringify(cs.dataModel || {})), busy: false };
          if (order.indexOf(cs.surfaceId) < 0) order.push(cs.surfaceId);
          (cs.components || []).forEach(function (c) { surfaces[cs.surfaceId].components[c.id] = c; });
        } else if (m.updateComponents && surfaces[m.updateComponents.surfaceId]) {
          var s = surfaces[m.updateComponents.surfaceId];
          (m.updateComponents.components || []).forEach(function (c) { s.components[c.id] = c; });
        } else if (m.updateDataModel && surfaces[m.updateDataModel.surfaceId]) {
          var u = m.updateDataModel;
          var sd = surfaces[u.surfaceId];
          sd.data = setPath(sd.data, u.path || '/', u.value === undefined ? null : JSON.parse(JSON.stringify(u.value)));
        } else if (m.deleteSurface) {
          delete surfaces[m.deleteSurface.surfaceId];
          order = order.filter(function (x) { return x !== m.deleteSurface.surfaceId; });
        }
      });
      draw();
    }

    function draw() {
      var active = doc.activeElement;
      var focusId = active && root.contains(active) ? active.getAttribute('data-a2ui-id') : null;
      var sel = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
      while (root.firstChild) root.removeChild(root.firstChild);
      order.forEach(function (sid) {
        var s = surfaces[sid];
        if (!s || !s.components.root) return;
        var box = doc.createElement('div');
        box.className = 'a2ui';
        box.setAttribute('data-surface', sid);
        var el = render(s, 'root', 0);
        if (el) box.appendChild(el);
        root.appendChild(box);
      });
      if (focusId) {
        var again = root.querySelector('[data-a2ui-id="' + focusId + '"]');
        if (again) {
          again.focus();
          if (sel) try { again.setSelectionRange(sel[0], sel[1]); } catch (e) {}
        }
      }
    }

    apply(messages);
    return { apply: apply, data: function (sid) { return surfaces[sid] && surfaces[sid].data; } };
  }

  window.HLA2UI = { version: '1.0', mount: mount };
})();
