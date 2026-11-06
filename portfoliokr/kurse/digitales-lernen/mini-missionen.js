function miniMissionen(global) {
  'use strict';

  const MM = { version: '1.0.0', mechanics: {}, themes: {} };
  const reducedMotion = () => !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ------------------------------------------------------------------ Hilfen */
  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') for (const p in v) { if (p.startsWith('--')) el.style.setProperty(p, v[p]); else el.style[p] = v[p]; }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(c => { if (c != null && c !== false) el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); });
    return el;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) el.setAttribute(k, attrs[k]);
    (kids || []).forEach(c => c && el.appendChild(c));
    return el;
  }
  function icon(d, cls) {
    return sv('svg', { viewBox: '0 0 24 24', class: cls || 'mm-ico', 'aria-hidden': 'true' },
      [sv('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })]);
  }
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function shuffledIdx(n) { let o, g = 0; do { o = shuffle([...Array(n).keys()]); } while (n > 1 && o.every((v, i) => v === i) && g++ < 30); return o; }
  function hit(el, ev) { const r = el.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom; }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function replay(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
  function btn(text, cls, onclick, extra) { return h('button', Object.assign({ type: 'button', class: 'mm-btn ' + (cls || ''), onclick }, extra || {}), [text]); }
  function choices(list, onPick) {
    const wrap = h('div', { class: 'mm-choices' });
    list.forEach((o, i) => { const b = btn(o.text, 'mm-choice', () => onPick(o, b, i, wrap)); wrap.appendChild(b); });
    return wrap;
  }
  const lockAll = wrap => wrap && wrap.querySelectorAll('button').forEach(b => { b.disabled = true; });
  const fmt = n => Number(n).toLocaleString('de-DE');

  function noSelect(on) {
    document.documentElement.classList.toggle('mm-dragging', on);
    try { const s = global.getSelection && global.getSelection(); if (s && s.rangeCount) s.removeAllRanges(); } catch (e) { }
  }
  /* Ziehen per Maus/Touch – Klick bleibt immer als Alternative erhalten */
  function draggable(el, getTargets, onDrop) {
    el.style.touchAction = 'none';
    el.addEventListener('click', e => { if (el._mmDragged) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || el.disabled) return;
      const sx = e.clientX, sy = e.clientY; let moved = false;
      const mv = ev => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        if (!moved) noSelect(true);
        moved = true; el.classList.add('is-dragging'); el.style.transform = `translate(${dx}px, ${dy}px)`;
        getTargets().forEach(t => t.classList.toggle('is-over', !t.disabled && hit(t, ev)));
      };
      const up = ev => {
        global.removeEventListener('pointermove', mv); global.removeEventListener('pointerup', up); global.removeEventListener('pointercancel', up);
        getTargets().forEach(t => t.classList.remove('is-over'));
        el.classList.remove('is-dragging'); el.style.transform = '';
        if (!moved) return;
        noSelect(false);
        el._mmDragged = true; setTimeout(() => { el._mmDragged = false; }, 0);
        onDrop(getTargets().find(t => !t.disabled && hit(t, ev)) || null);
      };
      global.addEventListener('pointermove', mv); global.addEventListener('pointerup', up); global.addEventListener('pointercancel', up);
    });
  }

  /* Kurze Töne (nur wenn sound: true) */
  let actx = null;
  function tone(kind) {
    try {
      actx = actx || new (global.AudioContext || global.webkitAudioContext)();
      const seq = kind === 'ok' ? [[660, .07], [880, .1]] : kind === 'done' ? [[523, .1], [659, .1], [784, .2]] : kind === 'blip' ? [[520, .12]] : [[196, .18]];
      let t = actx.currentTime;
      seq.forEach(([f, d]) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(.07, t); g.gain.exponentialRampToValueAtTime(.001, t + d);
        o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + d); t += d;
      });
    } catch (e) { /* Ton ist optional */ }
  }

  /* ------------------------------------------------------------ Ergebnisse */
  const STORE = 'mm-results';
  function loadResults(opts) {
    if (opts && typeof opts.loadResults === 'function') { try { return opts.loadResults() || {}; } catch (e) { return {}; } }
    try { return JSON.parse(global.sessionStorage.getItem(STORE) || '{}'); } catch (e) { return {}; }
  }
  function saveResult(id, r, opts) {
    const all = loadResults(opts); all[id] = r;
    if (opts && typeof opts.saveResults === 'function') { try { opts.saveResults(all); } catch (e) { console.error(e); } return; }
    try { global.sessionStorage.setItem(STORE, JSON.stringify(all)); } catch (e) { /* ohne Speicher weiter */ }
  }
  MM.getResults = opts => loadResults(opts);
  MM.clearResults = () => { try { global.sessionStorage.removeItem(STORE); } catch (e) { } };

  /* Optional: SCORM 1.2 cmi.interactions schreiben (nur wenn options.scorm12Interactions === true) */
  function findAPI(win) {
    let n = 0;
    try { while (win && !win.API && win.parent && win.parent !== win && n++ < 12) win = win.parent; } catch (e) { return null; }
    if (win && win.API) return win.API;
    try { if (global.opener && global.opener.API) return global.opener.API; } catch (e) { }
    return null;
  }
  const ITYPE = { G01: 'matching', G02: 'sequencing', G06: 'sequencing', G08: 'numeric', G13: 'numeric', G03: 'choice', G10: 'choice' };
  function timespan(ms) {
    const s = ms / 1000, H = Math.floor(s / 3600), M = Math.floor((s % 3600) / 60), S = (s % 60).toFixed(2);
    return String(H).padStart(4, '0') + ':' + String(M).padStart(2, '0') + ':' + S.padStart(5, '0');
  }
  function scormInteraction(type, d) {
    try {
      const API = findAPI(global); if (!API) return;
      const n = parseInt(API.LMSGetValue('cmi.interactions._count'), 10) || 0, p = 'cmi.interactions.' + n + '.';
      API.LMSSetValue(p + 'id', String(d.id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 255));
      API.LMSSetValue(p + 'type', ITYPE[type] || 'performance');
      API.LMSSetValue(p + 'result', d.skipped ? 'neutral' : (d.revealed ? 'wrong' : 'correct'));
      API.LMSSetValue(p + 'latency', timespan(d.durationMs));
    } catch (e) { /* Tracking ist optional */ }
  }

  /* --------------------------------------------------------------- Leitmotive */
  const ICONS = {
    blitz: 'M13 2 4 14h7l-1 8 9-12h-7z',
    berg: 'M2 20 9 8l4 6 3-4 6 10zM7.5 10.5l1.5 1 1.5-1',
    segel: 'M12 3v14M12 4l7 11h-7M11 6 5 15h6M4 18h16l-2 3H6z',
    kolben: 'M9 3h6M10 3v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3M7.5 15h9',
    lupe: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 21 21',
    rakete: 'M12 2c3.5 2.5 5 7 3.2 13H8.8C7 9 8.5 4.5 12 2zM12 8.5a1.5 1.5 0 1 0 0 .01M8.8 15 6 19l3.5-1.2M15.2 15l2.8 4-3.5-1.2M10.5 18.5 12 22l1.5-3.5'
  };
  const DEFAULT_WORDS = {
    mission: 'Mission', done: 'Mission erfüllt', locked: 'Gesperrt', open: 'Freigegeben',
    hint: 'Hinweis', solve: 'Lösung zeigen', skip: 'Überspringen', check: 'Prüfen', next: 'Weiter',
    pause: 'Anhalten', play: 'Weiterlaufen lassen', finish: 'Fertig', replay: 'Nochmal zeigen', start: 'Start', revealed: 'Lösung angezeigt'
  };
  const BASE_COLORS = {
    panel: '#004754', panel2: '#0d5c68', accent: '#BEBD00', text: '#F5F6F4', muted: '#8FB0B5',
    warn: '#E8A33D', err: '#F08A6E',
    font: 'Calibri, Carlito, "Segoe UI", Arial, sans-serif',
    wires: ['#BEBD00', '#7FD3DD', '#F5F6F4', '#E8A33D', '#C7B8F0']
  };
  const N = s => s.split('|');
  const names = list => { const o = {}; N(list).forEach((n, i) => { o['G' + String(i + 1).padStart(2, '0')] = n; }); return o; };

  MM.themes = {
    leitwarte: {
      label: 'Leitwarte', icon: 'blitz', pattern: 'raster',
      words: { mission: 'Schaltauftrag', done: 'Netz stabil', locked: 'Gesperrt', open: 'Freigegeben' },
      names: names('Leitungen schalten|Schaltfolge|Freigabeschein|Last verteilen|Störungen abwehren|Schutzprotokoll|Netzpfad wählen|Frequenz halten|Störfall beherrschen|Meldung übertragen|Messwerte bereinigen|Messstelle prüfen|Speicher laden|Lage einordnen|Last abwerfen|Netzzustand'),
      keywords: N('netz|energie|strom|sicherheit|arbeitsschutz|schalt|anlage|störung|betrieb|krise|notfall|umspann|leitung|elektro')
    },
    bergtour: {
      label: 'Bergtour', icon: 'berg', pattern: 'hoehenlinien',
      words: { mission: 'Etappe', done: 'Etappe geschafft', locked: 'Weg versperrt', open: 'Weg frei' },
      names: names('Seilschaft bilden|Routenabschnitte|Gipfelbuch|Proviant einteilen|Lose Steine räumen|Sicherungsfolge|Route wählen|Höhe schätzen|Wetterumschwung|Wegweiser lesen|Rucksack packen|Ausrüstung checken|Wasser einteilen|Standort bestimmen|Gepäck erleichtern|Kondition checken'),
      keywords: N('ziel|entwicklung|karriere|laufbahn|wachstum|weg|onboarding|einarbeitung|leistung|talent|nachfolge|potenzial|perspektive|fachlaufbahn')
    },
    segeltoern: {
      label: 'Segeltörn', icon: 'segel', pattern: 'wellen',
      words: { mission: 'Manöver', done: 'Manöver geglückt', locked: 'Hafen geschlossen', open: 'Leinen los' },
      names: names('Leinen belegen|Ablegemanöver|Hafenausweis|Crew einteilen|Treibgut bergen|Signalfolge|Kurs abstecken|Tiefe loten|Sturm abwettern|Logbuch lesen|Ladung sortieren|Seekarten prüfen|Wasser bunkern|Position peilen|Ballast über Bord|Lagebericht'),
      keywords: N('team|führung|fuehrung|veränderung|change|zusammenarbeit|kommunikation|konflikt|kultur|leitbild|feedback|gespräch|dialog|delegation|motivation')
    },
    labor: {
      label: 'Labor', icon: 'kolben', pattern: 'waben',
      words: { mission: 'Versuch', done: 'Ergebnis bestätigt', locked: 'Zutritt gesperrt', open: 'Zutritt frei' },
      names: names('Proben zuordnen|Versuchsprotokoll|Laborfreigabe|Messzeit verteilen|Verunreinigungen entfernen|Pipettierfolge|Versuchsreihe planen|Messwert einstellen|Reaktion stabilisieren|Messprotokoll|Probe filtern|Probe untersuchen|Dosieren|Probe klassifizieren|Abfall entsorgen|Befund'),
      keywords: N('qualität|qualitaet|analyse|daten|prozess|methode|messung|kennzahl|kpi|controlling|excel|auswertung|diagnose|kompetenz')
    },
    spurensuche: {
      label: 'Spurensuche', icon: 'lupe', pattern: 'akte',
      words: { mission: 'Fall', done: 'Fall gelöst', locked: 'Akte verschlossen', open: 'Akte geöffnet' },
      names: names('Spuren verknüpfen|Hergang ordnen|Dienstausweis|Kräfte einteilen|Falschaussagen entlarven|Beweiskette|Spur verfolgen|Zeitraum eingrenzen|Gespräch führen|Aktenstudium|Akten sichten|Unstimmigkeit finden|Frist bemessen|Fall einordnen|Falsche Spuren verwerfen|Fallakte'),
      keywords: N('compliance|datenschutz|dsgvo|recht|fehler|risiko|audit|prüfung|informationssicherheit|phishing|betrug|korruption|regel|richtlinie')
    },
    raumstation: {
      label: 'Raumstation', icon: 'rakete', pattern: 'sterne',
      colors: { panel: '#0B2A33', panel2: '#12404b' },
      words: { mission: 'Mission', done: 'Mission erfüllt', locked: 'Gesperrt', open: 'Zugang frei' },
      names: names('Kabel koppeln|Startsequenz|Zugangskarte|Energie umleiten|Störobjekte abwehren|Reaktor-Protokoll|Kurs festlegen|Triebwerk ausrichten|Verteiler kalibrieren|Datenübertragung|Filter reinigen|Probe analysieren|Treibstoff tanken|Steuerung stabilisieren|Müll entleeren|Status-Scan'),
      keywords: N('digital|ki|künstliche|innovation|zukunft|agil|transformation|it|tool|software|sap|successfactors|system|plattform|lms')
    }
  };

  /* Leitmotiv aus dem Titel ableiten (Vorschlag – die Entscheidung trifft der Mensch) */
  MM.suggestTheme = function (title) {
    /* Thema zählt voll, Zielgruppe („… für Führungskräfte“) nur schwach; längere Treffer sind spezifischer */
    const parts = String(title || '').toLowerCase().split(/\s(?:für|fuer)\s/);
    const main = parts[0], rest = parts.slice(1).join(' ');
    /* kurze Schlüsselwörter (KI, IT, SAP …) nur als ganzes Wort, längere auch in Komposita */
    const has = (txt, w) => w.length <= 3 ? new RegExp('(^|[^a-zäöüß])' + w + '($|[^a-zäöüß])').test(txt) : txt.includes(w);
    const scores = {};
    Object.keys(MM.themes).forEach(k => {
      scores[k] = (MM.themes[k].keywords || []).reduce((s, w) => s + (has(main, w) ? w.length : has(rest, w) ? w.length * .3 : 0), 0);
    });
    const ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
    const preset = scores[ranked[0]] > 0 ? ranked[0] : 'leitwarte';
    const alternative = ranked.find(k => k !== preset && scores[k] > 0) || (preset === 'leitwarte' ? 'raumstation' : 'leitwarte');
    return { preset, alternative, scores };
  };

  function resolveTheme(t) {
    let base = MM.themes.leitwarte, custom = {};
    if (typeof t === 'string' && MM.themes[t]) base = MM.themes[t];
    else if (t && typeof t === 'object') { base = MM.themes[t.preset] || base; custom = t; }
    const colors = Object.assign({}, BASE_COLORS, base.colors || {}, custom.colors || {});
    const words = Object.assign({}, DEFAULT_WORDS, base.words || {}, custom.words || {});
    const ic = custom.icon || base.icon;
    return {
      label: custom.label || base.label, colors, words,
      names: Object.assign({}, base.names || {}, custom.names || {}),
      icon: ICONS[ic] || (typeof ic === 'string' && /^[Mm]/.test(ic) ? ic : ICONS.blitz),
      pattern: custom.pattern || base.pattern || 'raster'
    };
  }

  /* ------------------------------------------------------------------ Rahmen */
  MM.mount = function (el, cfg, opts) {
    opts = opts || {}; cfg = cfg || {};
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) throw new Error('MiniMissionen: Zielelement nicht gefunden');
    injectCSS();
    const mech = MM.mechanics[cfg.type];
    const th = resolveTheme(cfg.theme || opts.theme);
    const W = th.words;
    const id = cfg.id || ('mm-' + Math.random().toString(36).slice(2, 8));
    const title = cfg.title || th.names[cfg.type] || W.mission;
    const t0 = Date.now();
    const sound = !!(cfg.sound != null ? cfg.sound : opts.sound);
    let errors = 0, finished = false, api = {};

    el.innerHTML = '';
    const led = h('span', { class: 'mm-led', role: 'img', 'aria-label': 'Status: offen' }, ['○']);
    const barFill = h('span', { class: 'mm-bar-fill' });
    const fb = h('div', { class: 'mm-fb', 'aria-live': 'polite' });
    const hintBox = h('div', { class: 'mm-hint', hidden: true });
    const body = h('div', { class: 'mm-body' });
    const doneBar = h('div', { class: 'mm-done', hidden: true, 'aria-live': 'polite' });
    const hintBtn = cfg.hint ? btn(W.hint, 'mm-ghost', () => showHint()) : null;
    const solveBtn = btn(W.solve, 'mm-ghost', () => reveal(), { hidden: true });
    const skipBtn = cfg.skippable === false ? null : btn(W.skip, 'mm-ghost', () => skip());

    const root = h('section', { class: 'mm mm-pat-' + th.pattern, 'aria-label': W.mission + ': ' + title, 'data-mm-type': cfg.type || '' }, [
      h('header', { class: 'mm-head' }, [
        h('span', { class: 'mm-badge' }, [icon(th.icon)]),
        h('div', { class: 'mm-titles' }, [h('span', { class: 'mm-kicker', text: W.mission }), h(/^h[2-4]$/.test(cfg.headingLevel || '') ? cfg.headingLevel : 'h3', { class: 'mm-title', text: title })]),
        led
      ]),
      h('div', { class: 'mm-bar', 'aria-hidden': 'true' }, [barFill]),
      cfg.intro ? h('p', { class: 'mm-intro', text: cfg.intro }) : null,
      body, fb, hintBox, doneBar,
      h('footer', { class: 'mm-foot' }, [hintBtn, solveBtn, skipBtn])
    ]);
    const C = th.colors;
    [['panel', C.panel], ['panel2', C.panel2], ['accent', C.accent], ['text', C.text], ['muted', C.muted], ['warn', C.warn], ['err', C.err], ['font', C.font]]
      .forEach(([k, v]) => root.style.setProperty('--mm-' + k, v));
    (C.wires || BASE_COLORS.wires).forEach((c, i) => root.style.setProperty('--mm-wire-' + i, c));
    el.appendChild(root);

    function setLed(state) {
      const map = { open: ['○', 'offen'], busy: ['◐', 'in Arbeit'], done: ['✓', 'gelöst'], skip: ['–', 'übersprungen'] };
      led.className = 'mm-led is-' + state; led.textContent = map[state][0]; led.setAttribute('aria-label', 'Status: ' + map[state][1]);
    }
    function showHint() { hintBox.hidden = false; hintBox.replaceChildren(h('strong', { text: W.hint + ': ' }), cfg.hint); replay(hintBox, 'mm-slidein'); }

    const ctx = {
      id, root, body, theme: th, words: W, rm: reducedMotion(), sound,
      get finished() { return finished; },
      get errors() { return errors; },
      say(msg, kind) {
        fb.className = 'mm-fb' + (kind ? ' is-' + kind : '');
        fb.replaceChildren();
        if (!msg || (Array.isArray(msg) && !msg.length)) return;
        fb.appendChild(h('span', { class: 'mm-fb-sym', 'aria-hidden': 'true' }, [kind === 'ok' ? '✓' : kind === 'err' ? '✕' : 'i']));
        fb.appendChild(Array.isArray(msg) ? h('ul', {}, msg.map(m => h('li', { text: m }))) : h('span', { text: msg }));
      },
      progress(f) { barFill.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%'; if (f > 0 && !finished) setLed('busy'); },
      ok(msg, target) { replay(target, 'mm-pulse'); ctx.say(msg, 'ok'); if (sound) tone('ok'); if (!finished) setLed('busy'); },
      fail(msg, target) {
        errors++; replay(target, 'mm-shake'); ctx.say(msg, 'err'); if (sound) tone('err'); setLed('busy');
        if (errors === 2 && cfg.hint) showHint();
        if (errors >= 3 && typeof api.reveal === 'function' && !finished) solveBtn.hidden = false;
      },
      blip() { if (sound) tone('blip'); },
      done() { finish({}); },
      results: () => loadResults(opts),
      navigate(page) {
        root.dispatchEvent(new CustomEvent('minimission:navigate', { bubbles: true, detail: { page } }));
        if (typeof opts.onNavigate === 'function') opts.onNavigate(page);
      }
    };

    function finish(state) {
      if (finished) return; finished = true;
      setLed(state.skipped ? 'skip' : 'done');
      barFill.style.width = '100%';
      solveBtn.hidden = true; if (skipBtn) skipBtn.hidden = true; if (hintBtn) hintBtn.hidden = true;
      root.classList.add('is-finished'); if (state.skipped) root.classList.add('is-skipped');
      if (!state.skipped) {
        const check = sv('svg', { viewBox: '0 0 24 24', class: 'mm-check', 'aria-hidden': 'true' }, [sv('path', { d: 'M4 12.5l5 5L20 6.5' })]);
        doneBar.hidden = false;
        doneBar.replaceChildren(...[check, h('strong', { text: state.revealed ? W.revealed : W.done }), (!state.revealed && cfg.successText) ? h('span', { text: cfg.successText }) : null].filter(Boolean));
        replay(root, 'mm-win');
        if (sound) tone('done');
      }
      saveResult(id, { ok: state.skipped ? 0 : 1, e: errors, r: state.revealed ? 1 : 0, k: state.skipped ? 1 : 0 }, opts);
      const detail = { id, type: cfg.type, solved: !state.skipped, revealed: !!state.revealed, skipped: !!state.skipped, errors, durationMs: Date.now() - t0 };
      if (opts.scorm12Interactions) scormInteraction(cfg.type, detail);
      root.dispatchEvent(new CustomEvent('minimission:complete', { bubbles: true, detail }));
      if (typeof opts.onComplete === 'function') { try { opts.onComplete(detail); } catch (e) { console.error(e); } }
    }
    function reveal() { if (finished || typeof api.reveal !== 'function') return; api.reveal(); finish({ revealed: true }); }
    function skip() { if (finished) return; ctx.say(''); finish({ skipped: true }); }

    if (!mech) { body.appendChild(h('p', { class: 'mm-error', text: 'Unbekannter Missionstyp: ' + cfg.type })); return { id, root, destroy() { el.innerHTML = ''; } }; }
    try { api = mech(ctx, cfg.data || {}) || {}; }
    catch (e) { console.error(e); body.appendChild(h('p', { class: 'mm-error', text: 'Mission konnte nicht aufgebaut werden – bitte die Daten prüfen.' })); }
    if (api.keepInteractive) root.classList.add('mm-keep');

    return {
      id, root, reveal, skip,
      destroy() { try { api.destroy && api.destroy(); } catch (e) { } el.innerHTML = ''; }
    };
  };

  /* =========================================================== Mechaniken */

  /* G01 Verbinden – Zuordnung von Paaren. data: { pairs: [{ left, right, why?, wrong? }] } */
  MM.mechanics.G01 = function (ctx, d) {
    const P = d.pairs || [], n = P.length, L = [], R = [], lines = {}, matched = new Set();
    let sel = -1, count = 0, temp = null;
    const wrap = h('div', { class: 'mm-match' });
    const svg = sv('svg', { class: 'mm-wires', 'aria-hidden': 'true' });
    const colL = h('div', { class: 'mm-col' }), colR = h('div', { class: 'mm-col' });
    wrap.append(colL, colR, svg);
    ctx.body.appendChild(wrap);
    const wire = i => `var(--mm-wire-${i % 5})`;

    P.forEach((p, i) => {
      const b = h('button', { type: 'button', class: 'mm-btn mm-node mm-node-l', 'aria-pressed': 'false' },
        [h('span', { class: 'mm-lbl', text: p.left }), h('span', { class: 'mm-plug', style: { background: wire(i) } })]);
      b.addEventListener('click', () => { if (!b._mmDragged) select(i); });
      b.addEventListener('pointerdown', e => startDrag(e, i));
      L[i] = b; colL.appendChild(b);
    });
    shuffledIdx(n).forEach(j => {
      const b = h('button', { type: 'button', class: 'mm-btn mm-node mm-node-r' }, [h('span', { class: 'mm-plug' }), h('span', { class: 'mm-lbl', text: P[j].right })]);
      b.addEventListener('click', () => { if (sel >= 0) attempt(sel, j); else ctx.say('Wähle zuerst links einen Begriff – dann rechts das Gegenstück.', 'info'); });
      R[j] = b; colR.appendChild(b);
    });

    function anchor(b) { const w = wrap.getBoundingClientRect(), r = b.querySelector('.mm-plug').getBoundingClientRect(); return { x: r.left + r.width / 2 - w.left, y: r.top + r.height / 2 - w.top }; }
    function select(i) {
      if (matched.has(i) || ctx.finished) return; sel = i;
      L.forEach((b, k) => { b.classList.toggle('is-sel', k === i); b.setAttribute('aria-pressed', String(k === i)); });
      ctx.say(`„${P[i].left}“ gewählt – jetzt rechts das passende Gegenstück.`, 'info');
    }
    function drawLine(i, animate) {
      const a = anchor(L[i]), b = anchor(R[i]);
      const l = sv('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'mm-wire' }); l.style.stroke = wire(i);
      svg.appendChild(l);
      if (animate && !ctx.rm) {
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        l.style.strokeDasharray = len; l.style.strokeDashoffset = len; l.getBoundingClientRect();
        l.style.transition = 'stroke-dashoffset .35s ease-out'; l.style.strokeDashoffset = 0;
        setTimeout(() => { l.style.strokeDasharray = ''; l.style.transition = ''; l.classList.add('mm-flow'); }, 380);
      }
      return l;
    }
    function connect(i, animate) {
      matched.add(i); count++;
      [L[i], R[i]].forEach(b => { b.classList.add('is-done'); b.classList.remove('is-sel'); b.disabled = true; });
      R[i].querySelector('.mm-plug').style.background = wire(i);
      lines[i] = drawLine(i, animate);
      ctx.progress(count / n);
    }
    function clearTemp() { if (temp) { temp.remove(); temp = null; } }
    function attempt(i, j) {
      clearTemp(); if (matched.has(i) || ctx.finished) return;
      if (i === j) {
        connect(i, true); sel = -1;
        ctx.ok(P[i].why || `Richtig: „${P[i].left}“ ↔ „${P[i].right}“.`, R[j]);
        if (count === n) ctx.done();
      } else ctx.fail(P[i].wrong || `„${P[i].left}“ und „${P[j].right}“ gehören nicht zusammen.`, R[j]);
    }
    function startDrag(e, i) {
      if (e.button !== 0 || matched.has(i) || ctx.finished) return;
      const a = anchor(L[i]), sx = e.clientX, sy = e.clientY; let moved = false;
      const mv = ev => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        if (!moved) { moved = true; select(i); noSelect(true); }
        if (!temp) { temp = sv('line', { class: 'mm-wire mm-wire-temp' }); temp.style.stroke = wire(i); svg.appendChild(temp); }
        const w = wrap.getBoundingClientRect();
        temp.setAttribute('x1', a.x); temp.setAttribute('y1', a.y); temp.setAttribute('x2', ev.clientX - w.left); temp.setAttribute('y2', ev.clientY - w.top);
        R.forEach(r => r.classList.toggle('is-over', !r.disabled && hit(r, ev)));
      };
      const up = ev => {
        global.removeEventListener('pointermove', mv); global.removeEventListener('pointerup', up); global.removeEventListener('pointercancel', up);
        R.forEach(r => r.classList.remove('is-over'));
        if (!moved) return;
        noSelect(false);
        L[i]._mmDragged = true; setTimeout(() => { L[i]._mmDragged = false; }, 0);
        const j = R.findIndex(r => !r.disabled && hit(r, ev));
        if (j >= 0) attempt(i, j); else clearTemp();
      };
      global.addEventListener('pointermove', mv); global.addEventListener('pointerup', up); global.addEventListener('pointercancel', up);
    }
    const ro = global.ResizeObserver ? new ResizeObserver(() => {
      Object.keys(lines).forEach(i => { const a = anchor(L[i]), b = anchor(R[i]); const l = lines[i]; l.setAttribute('x1', a.x); l.setAttribute('y1', a.y); l.setAttribute('x2', b.x); l.setAttribute('y2', b.y); });
    }) : null;
    if (ro) ro.observe(wrap);
    return {
      reveal() { P.forEach((_, i) => { if (!matched.has(i)) connect(i, false); }); ctx.say('Alle Paare sind jetzt verbunden – lies die Zuordnungen in Ruhe nach.', 'info'); },
      destroy() { if (ro) ro.disconnect(); }
    };
  };

  /* G02 Sequenz-Schloss – Reihenfolge. data: { steps: [...in richtiger Reihenfolge], why?: [...], unlockText? } */
  MM.mechanics.G02 = function (ctx, d) {
    const S = d.steps || [], n = S.length, B = []; let next = 0;
    const door = h('div', { class: 'mm-door' }, [
      h('div', { class: 'mm-door-msg', text: d.unlockText || ctx.words.open }),
      h('div', { class: 'mm-door-l' }), h('div', { class: 'mm-door-r' }),
      h('div', { class: 'mm-door-lock', text: ctx.words.locked })
    ]);
    const pad = h('div', { class: 'mm-pad', style: { '--cols': n <= 4 ? 2 : 3 } });
    shuffledIdx(n).forEach(k => {
      const b = h('button', { type: 'button', class: 'mm-btn mm-key' }, [h('span', { class: 'mm-key-no', 'aria-hidden': 'true' }), h('span', { text: S[k] })]);
      b.addEventListener('click', () => press(k));
      B[k] = b; pad.appendChild(b);
    });
    ctx.body.append(door, pad);
    function light(k) { const b = B[k]; b.classList.add('is-on'); b.disabled = true; b.querySelector('.mm-key-no').textContent = k + 1; b.setAttribute('aria-label', (k + 1) + '. ' + S[k]); }
    function press(k) {
      if (ctx.finished) return;
      if (k === next) {
        light(k); next++; ctx.progress(next / n);
        ctx.ok((d.why && d.why[k]) || `${next}. ${S[k]}`, B[k]);
        if (next === n) { door.classList.add('is-open'); ctx.done(); }
      } else {
        ctx.fail(next === 0 ? `„${S[k]}“ ist nicht der erste Schritt. Womit beginnt es?` : `„${S[k]}“ kommt noch nicht. Was folgt auf „${S[next - 1]}“?`, B[k]);
      }
    }
    return { reveal() { for (let k = next; k < n; k++) light(k); next = n; door.classList.add('is-open'); ctx.say('Richtige Reihenfolge: ' + S.join(' → '), 'info'); } };
  };

  /* G03 Freigabekarte – Kernfrage schaltet Karte frei. data: { question, options: [{ text, correct?, why? }], cardLabel? } */
  MM.mechanics.G03 = function (ctx, d) {
    const W = ctx.words, O = d.options || []; let unlocked = false, swiped = false, rightWhy = '';
    const state = h('span', { class: 'mm-card-state', text: W.locked });
    const card = h('button', { type: 'button', class: 'mm-card is-locked', disabled: true, 'aria-label': (d.cardLabel || 'Karte') + ' – gesperrt' },
      [h('span', { class: 'mm-card-chip' }), h('span', { class: 'mm-card-name', text: d.cardLabel || W.open }), state]);
    const screen = h('div', { class: 'mm-reader-screen', text: W.locked });
    const reader = h('div', { class: 'mm-reader' }, [screen, h('div', { class: 'mm-slot' }), h('span', { class: 'mm-small', text: 'Karte hierher ziehen' })]);
    const ch = choices(shuffle(O), pick);
    ctx.body.append(h('p', { class: 'mm-qtext', text: d.question }), ch, h('div', { class: 'mm-cardzone' }, [card, h('span', { class: 'mm-arrow', 'aria-hidden': 'true', text: '→' }), reader]));
    function pick(o, b) {
      if (unlocked || ctx.finished) return;
      if (o.correct) {
        unlocked = true; rightWhy = o.why || ''; b.classList.add('is-right'); lockAll(ch);
        card.disabled = false; card.classList.remove('is-locked'); state.textContent = W.open;
        card.setAttribute('aria-label', (d.cardLabel || 'Karte') + ' – freigeschaltet, zum Einlesen anklicken');
        ctx.ok((o.why ? o.why + ' ' : '') + 'Ziehe die Karte jetzt durch das Lesegerät – oder klicke sie an.', card);
        ctx.progress(.5);
      } else { b.classList.add('is-wrong'); b.disabled = true; ctx.fail(o.why || 'Das stimmt so nicht.', b); }
    }
    function swipe() {
      if (swiped || !unlocked) return; swiped = true; card.disabled = true;
      const a = card.getBoundingClientRect(), r = reader.getBoundingClientRect();
      card.style.setProperty('--dx', (r.left + r.width / 2 - (a.left + a.width / 2)) + 'px');
      card.classList.add('is-swiping');
      setTimeout(() => { screen.textContent = W.open; reader.classList.add('is-open'); if (!ctx.finished) ctx.say(rightWhy || 'Karte eingelesen.', 'ok'); ctx.done(); }, ctx.rm ? 0 : 650);
    }
    draggable(card, () => [reader], t => { if (t) swipe(); });
    card.addEventListener('click', () => { if (!card.disabled) swipe(); });
    return {
      reveal() {
        const i = O.findIndex(o => o.correct), bs = ch.querySelectorAll('.mm-choice');
        const shown = [...bs].find(b => b.textContent === (O[i] && O[i].text));
        if (!unlocked && shown) pick(O[i], shown);
        swipe();
      }
    };
  };

  /* G04 Energie verteilen – Priorisierung. data: { total, unit?, areas: [{ label, min?, max?, solution?, low?, high? }], why? } */
  MM.mechanics.G04 = function (ctx, d) {
    const A = d.areas || [], total = d.total || 10, unit = d.unit || 'Einheiten', vals = A.map(a => a.start || 0);
    const rest = h('strong', { class: 'mm-rest' });
    const rows = A.map((a, i) => {
      const inp = h('input', { type: 'range', min: 0, max: total, step: 1, value: vals[i], 'aria-label': a.label });
      const out = h('output', { class: 'mm-val' }), fill = h('span', { class: 'mm-meter-fill' });
      inp.addEventListener('input', () => set(i, +inp.value));
      return { row: h('div', { class: 'mm-dist-row' }, [h('span', { class: 'mm-dist-lbl', text: a.label }), inp, h('span', { class: 'mm-meter' }, [fill]), out]), inp, out, fill };
    });
    const check = btn(ctx.words.check, 'mm-primary', evaluate);
    ctx.body.append(h('div', { class: 'mm-dist-head' }, ['Noch zu verteilen: ', rest, ' ' + unit]), ...rows.map(r => r.row), h('div', { class: 'mm-actions' }, [check]));
    const sum = () => vals.reduce((a, b) => a + b, 0);
    function set(i, v) { const others = sum() - vals[i]; vals[i] = Math.max(0, Math.min(v, total - others)); render(); }
    function render() {
      const r = total - sum(); rest.textContent = r; rest.classList.toggle('is-zero', r === 0);
      rows.forEach((x, i) => { x.inp.value = vals[i]; x.out.textContent = vals[i]; x.fill.style.width = (vals[i] / total * 100) + '%'; });
      check.disabled = r !== 0 || ctx.finished; ctx.progress(sum() / total * .9);
    }
    function lock() { rows.forEach(r => { r.inp.disabled = true; }); check.disabled = true; }
    function evaluate() {
      const bad = [];
      A.forEach((a, i) => {
        if (a.min != null && vals[i] < a.min) bad.push(a.low || `${a.label}: zu wenig.`);
        else if (a.max != null && vals[i] > a.max) bad.push(a.high || `${a.label}: zu viel.`);
      });
      if (!bad.length) { lock(); ctx.ok(d.why || 'Stimmige Verteilung.'); ctx.done(); } else ctx.fail(bad, check);
    }
    render();
    return { reveal() { A.forEach((a, i) => { vals[i] = a.solution != null ? a.solution : (a.min || 0); }); render(); lock(); ctx.say(d.why || 'So wäre eine stimmige Verteilung.', 'info'); } };
  };

  /* G05 Aussagen abwehren – nur falsche anklicken. data: { items: [{ text, wrong: true|false, why? }], seconds? } */
  MM.mechanics.G05 = function (ctx, d) {
    const I = d.items || [], targets = I.filter(x => x.wrong).length, dur = d.seconds || 16; let hits = 0;
    const stage = h('div', { class: 'mm-stage', style: { '--lanes': I.length } });
    const E = [];
    shuffle(I.map((_, i) => i)).forEach((i, lane) => {
      const b = h('button', { type: 'button', class: 'mm-btn mm-float' }, [I[i].text]);
      b.style.top = `calc(${lane} * var(--lane-h) + 4px)`;
      b.style.animationDuration = dur + 's';
      b.style.animationDelay = (-((lane * 0.37 + 0.15) % 1) * dur) + 's';
      b.addEventListener('click', () => shoot(i, b));
      E[i] = b; stage.appendChild(b);
    });
    const count = h('span', { class: 'mm-count' });
    const pauseBtn = btn(ctx.words.pause, 'mm-ghost', () => { const p = stage.classList.toggle('is-paused'); pauseBtn.textContent = p ? ctx.words.play : ctx.words.pause; pauseBtn.setAttribute('aria-pressed', String(p)); }, { 'aria-pressed': 'false' });
    if (ctx.rm) pauseBtn.hidden = true;
    const finBtn = btn(ctx.words.finish, 'mm-primary', finish);
    ctx.body.append(h('div', { class: 'mm-actions mm-actions-top' }, [count, pauseBtn]), stage, h('div', { class: 'mm-actions' }, [finBtn]));
    function upd() { count.textContent = `Erkannt: ${hits} von ${targets}`; ctx.progress(hits / Math.max(1, targets)); }
    function shoot(i, b) {
      if (ctx.finished || b.classList.contains('is-hit')) return;
      const it = I[i];
      if (it.wrong) {
        const cs = getComputedStyle(b); b.style.left = cs.left; b.style.translate = cs.translate;
        hits++; b.classList.add('is-hit'); b.disabled = true; upd();
        ctx.ok(it.why || 'Treffer – diese Aussage ist falsch.');
        if (hits === targets) setTimeout(finish, ctx.rm ? 0 : 450);
      } else ctx.fail('Diese Aussage stimmt' + (it.why ? ': ' + it.why : ' – lass sie weiterziehen.'), b);
    }
    function summary() {
      return h('ul', { class: 'mm-summary' }, I.map(it => h('li', { class: it.wrong ? 'is-wrong' : 'is-right' }, [
        h('span', { class: 'mm-sym', 'aria-hidden': 'true', text: it.wrong ? '✕' : '✓' }),
        h('span', {}, [h('strong', { text: (it.wrong ? 'Falsch: ' : 'Stimmt: ') + it.text }), it.why ? h('span', { class: 'mm-why', text: ' – ' + it.why }) : null])
      ])));
    }
    function resolve() { if (!stage.isConnected) return; stage.replaceWith(summary()); pauseBtn.hidden = true; finBtn.hidden = true; }
    function finish() {
      if (ctx.finished) return;
      if (hits < targets) { ctx.fail(`Es sind noch ${targets - hits} falsche Aussage(n) unterwegs.`, finBtn); return; }
      resolve(); ctx.done();
    }
    upd();
    return { reveal() { hits = targets; upd(); resolve(); ctx.say('Hier die Auflösung aller Aussagen.', 'info'); } };
  };

  /* G06 Muster-Protokoll – Abfolge merken & nachdrücken. data: { steps: [...], startRound?, why? } */
  MM.mechanics.G06 = function (ctx, d) {
    const S = d.steps || [], n = S.length, startR = Math.max(1, Math.min(d.startRound || 2, n));
    let round = startR, pos = 0, busy = true;
    const layout = shuffledIdx(n), D = [], K = [];
    const disp = h('div', { class: 'mm-seq-grid mm-seq-disp', 'aria-hidden': 'true' }), pad = h('div', { class: 'mm-seq-grid' });
    layout.forEach(k => {
      D[k] = h('div', { class: 'mm-seq-cell' }, [S[k]]); disp.appendChild(D[k]);
      K[k] = h('button', { type: 'button', class: 'mm-btn mm-key', disabled: true }, [S[k]]);
      K[k].addEventListener('click', () => press(k)); pad.appendChild(K[k]);
    });
    const dots = h('div', { class: 'mm-rounds', 'aria-hidden': 'true' }), R = [];
    for (let r = startR; r <= n; r++) { const dot = h('span', { class: 'mm-round' }); R.push(dot); dots.appendChild(dot); }
    const status = h('div', { class: 'mm-seq-status', 'aria-live': 'polite', text: `${n} Schritte. Klicke auf „${ctx.words.start}“ und merke dir die Abfolge.` });
    const playBtn = btn(ctx.words.start, 'mm-primary', () => play());
    ctx.body.append(
      h('div', { class: 'mm-seq' }, [
        h('div', {}, [h('span', { class: 'mm-cap', text: 'Vorgabe' }), disp]),
        h('div', {}, [h('span', { class: 'mm-cap', text: 'Deine Eingabe' }), pad])
      ]),
      h('div', { class: 'mm-actions mm-actions-split' }, [dots, status, playBtn])
    );
    const setPad = on => { K.forEach(b => { b.disabled = !on; }); playBtn.disabled = !on && busy; };
    async function play() {
      if (ctx.finished) return;
      busy = true; setPad(false); playBtn.disabled = true; pos = 0;
      status.textContent = `Runde ${round - startR + 1} von ${n - startR + 1}: Schau genau hin …`;
      await wait(450);
      for (let k = 0; k < round; k++) {
        if (ctx.finished) return;
        D[k].classList.add('is-lit'); ctx.blip(); await wait(750);
        D[k].classList.remove('is-lit'); await wait(260);
      }
      status.textContent = `Jetzt du: ${round} Felder in derselben Reihenfolge.`;
      busy = false; setPad(true); playBtn.disabled = false; playBtn.textContent = ctx.words.replay;
    }
    function flash(b) { replay(b, 'is-press'); setTimeout(() => b.classList.remove('is-press'), 260); }
    async function press(k) {
      if (busy || ctx.finished) return; flash(K[k]);
      if (k === pos) {
        pos++;
        if (pos === round) {
          R[round - startR].classList.add('is-done');
          ctx.progress((round - startR + 1) / (n - startR + 1));
          if (round === n) { setPad(false); playBtn.hidden = true; status.textContent = ''; ctx.ok(d.why || 'Abfolge vollständig und korrekt: ' + S.join(' → ')); ctx.done(); return; }
          ctx.ok(`Runde geschafft – jetzt ${round + 1} Schritte.`); round++; busy = true; setPad(false);
          await wait(800); play();
        }
      } else {
        busy = true; setPad(false);
        ctx.fail(`„${S[k]}“ war an Stelle ${pos + 1} nicht richtig. Schau dir die Abfolge noch einmal an.`, K[k]);
        await wait(1100); play();
      }
    }
    return {
      reveal() {
        busy = true; setPad(false); playBtn.hidden = true;
        S.forEach((s, k) => { D[k].classList.add('is-shown'); D[k].textContent = (k + 1) + '. ' + s; });
        status.textContent = ''; ctx.say('Richtige Abfolge: ' + S.join(' → '), 'info');
      }
    };
  };

  /* Gemeinsamer Baustein für Entscheidungs-Stationen (G07, G09) */
  function stationPanel(ctx, st, onRight, onWrong) {
    const panel = h('div', { class: 'mm-station mm-slidein' });
    const ch = choices(shuffle(st.options || []), (o, b) => {
      if (ctx.finished) return;
      if (o.correct) { b.classList.add('is-right'); lockAll(ch); onRight(o, b); }
      else { b.classList.add('is-wrong'); b.disabled = true; onWrong(o, b); }
    });
    panel.append(h('p', { class: 'mm-qtext', text: st.situation }), ch);
    return panel;
  }

  /* G07 Kursrouting – Weg mit Entscheidungspunkten. data: { stops: [{ label?, situation, options: [{ text, correct?, why? }] }], goal? } */
  MM.mechanics.G07 = function (ctx, d) {
    const Sx = d.stops || [], n = Sx.length; let at = 0;
    const track = h('div', { class: 'mm-route', 'aria-hidden': 'true' });
    const trail = h('div', { class: 'mm-route-trail' }), marker = h('div', { class: 'mm-route-marker' });
    track.appendChild(trail);
    const dots = [];
    for (let i = 0; i <= n; i++) {
      const pct = (i / n * 100) + '%';
      const dot = h('span', { class: 'mm-route-dot' + (i === n ? ' is-goal' : ''), style: { left: pct } });
      dots.push(dot); track.appendChild(dot);
      track.appendChild(h('span', { class: 'mm-route-lab' + (i === 0 ? ' is-first' : i === n ? ' is-last' : ''), style: { left: pct }, text: i === n ? (d.goal || 'Ziel') : (Sx[i].label || 'Station ' + (i + 1)) }));
    }
    track.appendChild(marker);
    const holder = h('div');
    ctx.body.append(track, holder);
    function move() { const pct = (at / n * 100) + '%'; marker.style.left = pct; trail.style.width = pct; dots.forEach((x, i) => x.classList.toggle('is-past', i <= at)); }
    function show() {
      if (at >= n) { holder.replaceChildren(); return; }
      holder.replaceChildren(stationPanel(ctx, Sx[at],
        o => { ctx.ok(o.why || 'Guter Weg.'); at++; ctx.progress(at / n); move(); if (at === n) { setTimeout(() => holder.replaceChildren(), ctx.rm ? 0 : 500); ctx.done(); } else setTimeout(show, ctx.rm ? 200 : 900); },
        (o, b) => { replay(marker, 'is-detour'); ctx.fail(o.why || 'Dieser Weg führt in eine Sackgasse.', b); }
      ));
    }
    move(); show();
    return {
      reveal() {
        at = n; move();
        holder.replaceChildren(h('ol', { class: 'mm-summary mm-summary-ol' }, Sx.map(st => h('li', {}, [h('span', { class: 'mm-small', text: st.situation }), h('strong', { text: ((st.options || []).find(o => o.correct) || {}).text || '' })]))));
        ctx.say('So führt der Weg ans Ziel.', 'info');
      }
    };
  };

  /* G09 Eskalations-Stufen – Szenario pausiert, passende Reaktion wählen. data: { stages: [{ situation, options: [...] }] } */
  MM.mechanics.G09 = function (ctx, d) {
    const S = d.stages || [], n = S.length; let at = 0, heat = 1;
    const svg = sv('svg', { viewBox: '-8 -8 136 136', class: 'mm-rings', 'aria-hidden': 'true' });
    svg.appendChild(sv('path', { d: 'M60 -6 54 2h12z', class: 'mm-ring-tick' }));
    const rings = S.map((_, i) => {
      const r = 52 - i * 13, c = 2 * Math.PI * r;
      const el = sv('circle', { cx: 60, cy: 60, r, class: 'mm-ring', 'stroke-dasharray': `${c * .8} ${c * .2}` });
      el.style.setProperty('--rot', ((70 + i * 101) % 300 + 30) + 'deg');
      svg.appendChild(el); return el;
    });
    svg.appendChild(sv('circle', { cx: 60, cy: 60, r: Math.max(5, 52 - n * 13 - 2), class: 'mm-ring-core' }));
    const heatSegs = [0, 1, 2].map(() => h('span')), heatLbl = h('span', { class: 'mm-small' });
    const heatBox = h('div', { class: 'mm-heat' }, [h('span', { class: 'mm-small', text: 'Eskalation' }), h('span', { class: 'mm-heat-bar' }, heatSegs), heatLbl]);
    const holder = h('div');
    ctx.body.append(h('div', { class: 'mm-esc' }, [h('div', { class: 'mm-esc-side' }, [svg, heatBox]), holder]));
    function paintHeat() { heatSegs.forEach((s, i) => { s.className = i < heat ? 'is-on is-' + heat : ''; }); heatLbl.textContent = ['ruhig', 'angespannt', 'hoch', 'kritisch'][heat]; }
    function show() {
      if (at >= n) { holder.replaceChildren(); return; }
      holder.replaceChildren(h('span', { class: 'mm-cap', text: `Stufe ${at + 1} von ${n}` }), stationPanel(ctx, S[at],
        o => { rings[at].classList.add('is-locked'); heat = Math.max(0, heat - 1); paintHeat(); ctx.ok(o.why || 'Das beruhigt die Lage.'); at++; ctx.progress(at / n); if (at === n) { ctx.done(); } else setTimeout(show, ctx.rm ? 200 : 900); },
        (o, b) => { heat = Math.min(3, heat + 1); paintHeat(); replay(heatBox, 'mm-shake'); ctx.fail(o.why || 'Damit spitzt sich die Situation zu.', b); }
      ));
    }
    paintHeat(); show();
    return {
      reveal() {
        rings.forEach(r => r.classList.add('is-locked')); at = n; heat = 0; paintHeat();
        holder.replaceChildren(h('ol', { class: 'mm-summary mm-summary-ol' }, S.map(st => h('li', {}, [h('span', { class: 'mm-small', text: st.situation }), h('strong', { text: ((st.options || []).find(o => o.correct) || {}).text || '' })]))));
        ctx.say('So lässt sich die Situation Stufe für Stufe beruhigen.', 'info');
      }
    };
  };

  /* G08 Regler ausrichten – Schätzfrage. data: { question, min, max, step?, unit?, target, tolerance?, start?, why?, low?, high? } */
  MM.mechanics.G08 = function (ctx, d) {
    const min = d.min != null ? d.min : 0, max = d.max != null ? d.max : 100, step = d.step || 1, tol = d.tolerance || 0, unit = d.unit ? ' ' + d.unit : '';
    let v = d.start != null ? d.start : Math.round(((min + max) / 2) / step) * step;
    const pct = x => Math.max(0, Math.min(100, (x - min) / (max - min) * 100));
    const band = h('div', { class: 'mm-gauge-band' }), needle = h('div', { class: 'mm-gauge-needle' });
    band.style.left = pct(d.target - tol) + '%'; band.style.width = Math.max(1.5, pct(d.target + tol) - pct(d.target - tol)) + '%';
    const gauge = h('div', { class: 'mm-gauge' }, [band, needle]);
    const inp = h('input', { type: 'range', min, max, step, value: v, 'aria-label': d.question || 'Wert' });
    const out = h('output', { class: 'mm-big' });
    const check = btn(ctx.words.check, 'mm-primary', evaluate);
    ctx.body.append(h('p', { class: 'mm-qtext', text: d.question }), gauge,
      h('div', { class: 'mm-gauge-scale', 'aria-hidden': 'true' }, [h('span', { text: fmt(min) + unit }), h('span', { text: fmt(max) + unit })]),
      inp, h('div', { class: 'mm-actions mm-actions-split' }, [out, check]));
    function render() { out.textContent = fmt(v) + unit; needle.style.left = pct(v) + '%'; }
    inp.addEventListener('input', () => { v = +inp.value; render(); ctx.progress(.3); });
    function evaluate() {
      if (Math.abs(v - d.target) <= tol + 1e-9) {
        gauge.classList.add('is-shown'); inp.disabled = true; check.disabled = true; replay(needle, 'mm-settle');
        ctx.ok(d.why || `Richtig – ${fmt(d.target)}${unit}.`); ctx.done();
      } else ctx.fail(v < d.target ? (d.low || 'Zu niedrig – schieb den Regler weiter nach rechts.') : (d.high || 'Zu hoch – schieb den Regler weiter nach links.'), needle);
    }
    render();
    return { reveal() { v = d.target; render(); gauge.classList.add('is-shown'); inp.disabled = true; check.disabled = true; ctx.say(d.why || `Richtig wäre ${fmt(d.target)}${unit}.`, 'info'); } };
  };

  /* G10 Datenübertragung – Kernaussagen, dann Kontrollfragen. data: { facts: [...], quiz: [{ question, options: [...] }], doneText? } */
  MM.mechanics.G10 = function (ctx, d) {
    const F = d.facts || [], Q = d.quiz || []; let i = 0, qi = 0;
    const fill = h('span', { class: 'mm-load-fill' }), pctEl = h('span', { class: 'mm-load-pct', text: '0 %' });
    const card = h('div', { class: 'mm-fact', 'aria-live': 'polite' });
    const nextB = btn(ctx.words.next, 'mm-primary', next);
    ctx.body.append(h('div', { class: 'mm-load-row' }, [h('div', { class: 'mm-load' }, [fill]), pctEl]), card, h('div', { class: 'mm-actions' }, [nextB]));
    function setLoad(p) { fill.style.width = p + '%'; pctEl.textContent = Math.round(p) + ' %'; }
    function showFact() {
      card.replaceChildren(h('span', { class: 'mm-cap', text: `Datenpaket ${i + 1} von ${F.length}` }), h('p', { class: 'mm-fact-text', text: F[i] }));
      replay(card, 'mm-slidein'); setLoad(i / F.length * 100); ctx.progress(i / F.length * .5);
    }
    function next() { i++; if (i < F.length) showFact(); else { setLoad(100); nextB.hidden = true; quiz(); } }
    function quiz() {
      if (qi >= Q.length) { card.replaceChildren(h('p', { class: 'mm-fact-text', text: d.doneText || 'Übertragung vollständig.' })); ctx.done(); return; }
      const q = Q[qi];
      const ch = choices(shuffle(q.options || []), (o, b) => {
        if (ctx.finished) return;
        if (o.correct) { b.classList.add('is-right'); lockAll(ch); ctx.ok(o.why || 'Richtig.'); qi++; ctx.progress(.5 + qi / Q.length * .5); setTimeout(quiz, ctx.rm ? 400 : 1100); }
        else { b.classList.add('is-wrong'); b.disabled = true; ctx.fail(o.why || 'Nicht ganz – denk an die Datenpakete von eben.', b); }
      });
      card.replaceChildren(h('span', { class: 'mm-cap', text: `Kontrollfrage ${qi + 1} von ${Q.length}` }), h('p', { class: 'mm-qtext', text: q.question }), ch);
      replay(card, 'mm-slidein');
    }
    if (F.length) showFact(); else { nextB.hidden = true; setLoad(100); quiz(); }
    return {
      reveal() {
        setLoad(100); nextB.hidden = true;
        card.replaceChildren(h('ul', { class: 'mm-summary' }, F.map(f => h('li', {}, [h('span', { class: 'mm-sym', 'aria-hidden': 'true', text: '•' }), h('span', { text: f })]))));
        ctx.say('Hier noch einmal alle Kernaussagen.', 'info');
      }
    };
  };

  /* G11 Filter reinigen – Unzulässiges aussortieren. data: { items: [{ text, remove: true|false, why? }], binLabel? } */
  MM.mechanics.G11 = function (ctx, d) {
    const I = d.items || [], need = I.filter(x => x.remove).length; let removed = 0, sel = null;
    const lid = sv('path', { d: 'M4 7h16M9 7V4h6v3', class: 'mm-lid' });
    const binIco = sv('svg', { viewBox: '0 0 24 24', class: 'mm-bin-ico', 'aria-hidden': 'true' }, [lid, sv('path', { d: 'M6 7l1 13h10l1-13M10 11v6M14 11v6' })]);
    const bin = h('button', { type: 'button', class: 'mm-bin' }, [binIco, h('span', { text: d.binLabel || 'Aussortieren' })]);
    const box = h('div', { class: 'mm-filter' });
    const E = I.map((it, i) => {
      const b = h('button', { type: 'button', class: 'mm-btn mm-bob', style: { animationDelay: (-i * .7) + 's' } }, [it.text]);
      b.addEventListener('click', () => select(i));
      draggable(b, () => [bin], t => { if (t) drop(i); });
      box.appendChild(b); return b;
    });
    ctx.body.append(h('div', { class: 'mm-filter-wrap' }, [box, bin]));
    bin.addEventListener('click', () => { if (sel != null) drop(sel); else ctx.say('Wähle zuerst ein Element – dann den Behälter.', 'info'); });
    function select(i) { if (ctx.finished) return; sel = i; E.forEach((b, k) => b.classList.toggle('is-sel', k === i)); ctx.say(`„${I[i].text}“ gewählt – jetzt auf „${d.binLabel || 'Aussortieren'}“ klicken.`, 'info'); }
    function gone(b) { b.disabled = true; b.classList.remove('is-sel'); if (ctx.rm) b.hidden = true; else { b.addEventListener('animationend', () => { b.hidden = true; }, { once: true }); b.classList.add('is-gone'); } }
    function drop(i) {
      if (ctx.finished) return;
      const it = I[i], b = E[i]; sel = null; b.classList.remove('is-sel');
      if (it.remove) {
        removed++; gone(b); replay(bin, 'mm-gulp');
        ctx.ok(it.why || 'Richtig aussortiert.'); ctx.progress(removed / need);
        if (removed === need) { E.forEach((x, k) => { if (!I[k].remove) { x.classList.add('is-keep'); x.disabled = true; } }); ctx.done(); }
      } else ctx.fail('Das darf bleiben' + (it.why ? ': ' + it.why : '.'), b);
    }
    return {
      reveal() {
        E.forEach((b, k) => { if (I[k].remove && !b.disabled) gone(b); else if (!I[k].remove) { b.classList.add('is-keep'); b.disabled = true; } });
        ctx.say(I.filter(x => x.remove).map(x => `„${x.text}“ muss raus${x.why ? ': ' + x.why : '.'}`), 'info');
      }
    };
  };

  /* G12 Proben prüfen – den auffälligen Fall finden. data: { cases: [{ title?, text, odd: true|false, why? }], pickLabel? } */
  MM.mechanics.G12 = function (ctx, d) {
    const Cs = d.cases || [], opened = new Set(); let over = false;
    const info = h('p', { class: 'mm-small' }), grid = h('div', { class: 'mm-cases' });
    const E = Cs.map((c, i) => {
      const head = h('button', { type: 'button', class: 'mm-case-head', 'aria-expanded': 'false' }, [h('span', { class: 'mm-case-no', text: String(i + 1) }), h('span', { text: c.title || 'Probe ' + (i + 1) })]);
      const pick = btn(d.pickLabel || 'Auffällig', 'mm-case-pick', () => choose(i), { disabled: true });
      const card = h('div', { class: 'mm-case' }, [head, h('div', { class: 'mm-case-body', text: c.text }), pick]);
      head.addEventListener('click', () => open(i));
      grid.appendChild(card); return { card, head, pick };
    });
    ctx.body.append(info, grid);
    function upd() { info.textContent = opened.size < Cs.length ? `Öffne alle ${Cs.length} Proben (${opened.size}/${Cs.length} geprüft) – dann markiere die auffällige.` : 'Alle Proben geprüft – welche ist auffällig?'; ctx.progress(opened.size / Cs.length * .6); }
    function open(i) {
      const e = E[i]; if (e.card.classList.contains('is-open')) return;
      e.card.classList.add('is-open'); e.head.setAttribute('aria-expanded', 'true'); opened.add(i); upd();
      if (opened.size === Cs.length && !over) E.forEach(x => { if (!x.card.classList.contains('is-ok')) x.pick.disabled = false; });
    }
    function choose(i) {
      if (over || ctx.finished) return;
      const c = Cs[i];
      if (c.odd) { over = true; E[i].card.classList.add('is-odd'); E.forEach(x => { x.pick.disabled = true; }); ctx.ok(c.why || 'Richtig erkannt.', E[i].card); ctx.done(); }
      else { E[i].card.classList.add('is-ok'); E[i].pick.disabled = true; ctx.fail(c.why || 'Diese Probe ist in Ordnung.', E[i].card); }
    }
    upd();
    return {
      reveal() {
        E.forEach((e, i) => { e.card.classList.add('is-open'); e.pick.disabled = true; if (Cs[i].odd) e.card.classList.add('is-odd'); });
        over = true; const odd = Cs.find(c => c.odd); ctx.say(odd ? (odd.why || 'Das ist die auffällige Probe.') : '', 'info');
      }
    };
  };

  /* G13 Tank füllen – das richtige Maß. data: { question, levels?, stepValue?, unit?, target, tolerance?, why?, low?, high? } */
  MM.mechanics.G13 = function (ctx, d) {
    const L = d.levels || 10, T = d.target, tol = d.tolerance || 0, sv0 = d.stepValue || 1, unit = d.unit ? ' ' + d.unit : ''; let v = d.start || 0;
    const val = x => fmt(x * sv0) + unit;
    const fill = h('div', { class: 'mm-tank-fill' }), mark = h('div', { class: 'mm-tank-mark', style: { bottom: (T / L * 100) + '%' } });
    const tank = h('div', { class: 'mm-tank' }, [fill, mark]);
    const ticks = h('div', { class: 'mm-tank-ticks', 'aria-hidden': 'true' });
    const every = L > 10 ? Math.ceil(L / 10) : 1;
    for (let i = L; i >= 0; i--) ticks.appendChild(h('span', { text: i % every === 0 ? fmt(i * sv0) : '' }));
    const out = h('output', { class: 'mm-big', 'aria-live': 'polite' });
    const plus = btn('+', 'mm-roundbtn', () => set(v + 1), { 'aria-label': 'mehr' }), minus = btn('−', 'mm-roundbtn', () => set(v - 1), { 'aria-label': 'weniger' });
    const check = btn(ctx.words.check, 'mm-primary', evaluate);
    ctx.body.append(h('p', { class: 'mm-qtext', text: d.question }),
      h('div', { class: 'mm-tank-row' }, [h('div', { class: 'mm-tank-wrap' }, [ticks, tank]), h('div', { class: 'mm-tank-ctrl' }, [plus, out, minus])]),
      h('div', { class: 'mm-actions' }, [check]));
    function set(x) { v = Math.max(0, Math.min(L, x)); fill.style.height = (v / L * 100) + '%'; fill.classList.toggle('is-empty', v === 0); out.textContent = val(v); if (v) ctx.progress(.3); }
    function lock() { plus.disabled = minus.disabled = check.disabled = true; }
    function evaluate() {
      if (Math.abs(v - T) <= tol) { tank.classList.add('is-shown', 'is-ok'); lock(); ctx.ok(d.why || 'Passt.', tank); ctx.done(); }
      else ctx.fail(v < T ? (d.low || 'Das reicht noch nicht.') : (d.high || 'Das ist zu viel.'), tank);
    }
    set(v);
    return { reveal() { set(T); tank.classList.add('is-shown'); lock(); ctx.say(d.why || `Richtig wäre ${val(T)}.`, 'info'); } };
  };

  /* G14 Fadenkreuz – in eine Matrix einordnen. data: { cells: [...zeilenweise], cols?, xLabel?, yLabel?, items: [{ text, cell, why?, wrong? }] } */
  MM.mechanics.G14 = function (ctx, d) {
    const cells = d.cells || [], I = d.items || []; let at = 0;
    const grid = h('div', { class: 'mm-matrix', style: { '--cols': d.cols || 2 } });
    const Cb = cells.map((c, k) => {
      const b = h('button', { type: 'button', class: 'mm-cell' }, [h('span', { class: 'mm-cell-lbl', text: c }), h('span', { class: 'mm-cell-items' })]);
      b.addEventListener('click', () => place(k)); grid.appendChild(b); return b;
    });
    const cross = h('div', { class: 'mm-cross', 'aria-hidden': 'true' });
    const chip = h('div', { class: 'mm-chip', 'aria-live': 'polite' });
    ctx.body.append(
      h('div', { class: 'mm-chip-row' }, [h('span', { class: 'mm-small', text: 'Einordnen:' }), chip, h('span', { class: 'mm-small mm-chip-count' })]),
      h('div', { class: 'mm-matrix-wrap' }, [h('span', { class: 'mm-axis-y', text: d.yLabel || '' }), h('div', { class: 'mm-matrix-inner' }, [grid, cross]), h('span'), h('span', { class: 'mm-axis-x', text: d.xLabel || '' })])
    );
    draggable(chip, () => Cb, t => { if (t) place(Cb.indexOf(t)); });
    const countEl = ctx.body.querySelector('.mm-chip-count');
    function show() {
      countEl.textContent = at < I.length ? `(${at + 1}/${I.length})` : '';
      if (at >= I.length) { chip.textContent = '✓'; chip.classList.add('is-empty'); return; }
      chip.textContent = I[at].text; replay(chip, 'mm-slidein');
    }
    function aim(k) {
      const g = grid.getBoundingClientRect(), r = Cb[k].getBoundingClientRect();
      cross.style.transform = `translate(${r.left - g.left + r.width / 2}px, ${r.top - g.top + r.height / 2}px)`;
      cross.classList.add('is-on'); replay(cross, 'mm-lockon');
    }
    function put(k, text) { Cb[k].querySelector('.mm-cell-items').appendChild(h('span', { class: 'mm-cell-chip', text })); }
    function place(k) {
      if (at >= I.length || k < 0 || ctx.finished) return;
      const it = I[at];
      if (it.cell === k) {
        aim(k); put(k, it.text); ctx.ok(it.why || 'Richtig eingeordnet.'); at++; ctx.progress(at / I.length); show();
        if (at === I.length) { Cb.forEach(c => { c.disabled = true; }); ctx.done(); }
      } else ctx.fail(it.wrong || `„${it.text}“ gehört nicht in „${cells[k]}“.`, Cb[k]);
    }
    show();
    return { reveal() { for (; at < I.length; at++) put(I[at].cell, I[at].text); show(); Cb.forEach(c => { c.disabled = true; }); ctx.say('Alle Fälle sind jetzt richtig eingeordnet.', 'info'); } };
  };

  /* G15 Ballast abwerfen – Überflüssiges markieren, Hebel ziehen. data: { items: [{ text, remove: true|false, why? }], leverLabel?, why? } */
  MM.mechanics.G15 = function (ctx, d) {
    const I = d.items || [], need = I.filter(x => x.remove).length; let out = 0;
    const list = h('ul', { class: 'mm-cargo' });
    const E = I.map((it, i) => {
      const cid = ctx.id + '-c' + i, cb = h('input', { type: 'checkbox', id: cid });
      const li = h('li', { class: 'mm-cargo-item' }, [cb, h('label', { for: cid, text: it.text })]);
      list.appendChild(li); return { li, cb };
    });
    const lever = h('button', { type: 'button', class: 'mm-lever' }, [h('span', { class: 'mm-lever-arm', 'aria-hidden': 'true' }), h('span', { class: 'mm-lever-lbl', text: d.leverLabel || 'Abwerfen' })]);
    lever.addEventListener('click', pull);
    ctx.body.append(h('p', { class: 'mm-small', text: 'Markiere alles, was überflüssig ist – dann den Hebel ziehen.' }), h('div', { class: 'mm-cargo-wrap' }, [list, lever]));
    function drop(i) { const { li, cb } = E[i]; cb.disabled = true; if (ctx.rm) li.hidden = true; else { li.addEventListener('animationend', () => { li.hidden = true; }, { once: true }); li.classList.add('is-gone'); } }
    function pull() {
      if (ctx.finished) return;
      replay(lever, 'is-pulled');
      const marked = E.map((_, i) => i).filter(i => E[i].cb.checked && !E[i].cb.disabled);
      if (!marked.length) { ctx.say('Markiere zuerst, was über Bord soll.', 'info'); return; }
      const wrong = [];
      marked.forEach(i => { if (I[i].remove) { out++; drop(i); } else { E[i].cb.checked = false; replay(E[i].li, 'mm-shake'); wrong.push(`„${I[i].text}“ bleibt: ${I[i].why || 'wird gebraucht.'}`); } });
      ctx.progress(out / need);
      if (wrong.length) ctx.fail(wrong, null);
      if (out === need) {
        lever.disabled = true; E.forEach(e => { e.cb.disabled = true; });
        if (!wrong.length) ctx.ok(d.why || 'Alles Überflüssige ist über Bord.');
        ctx.done();
      } else if (!wrong.length) ctx.ok(`Gut – aber da ist noch Ballast an Bord (${need - out}).`);
    }
    return {
      reveal() { E.forEach((e, i) => { if (I[i].remove && !e.cb.disabled) drop(i); e.cb.disabled = true; }); lever.disabled = true; ctx.say(I.filter(x => x.remove).map(x => `„${x.text}“${x.why ? ': ' + x.why : ''}`), 'info'); }
    };
  };

  /* G16 Status-Scan – echte Ergebnisse der bisherigen Missionen. data: { areas: [{ label, missions: [ids], page?, pageLabel? }], allGood? } */
  MM.mechanics.G16 = function (ctx, d) {
    const A = d.areas || [];
    const list = h('ul', { class: 'mm-status' }, [h('li', { class: 'mm-small', text: 'Bereit zum Scan.' })]);
    const scan = h('div', { class: 'mm-scan' }, [h('div', { class: 'mm-scan-beam' }), list]);
    const start = btn(d.startLabel || 'Scan starten', 'mm-primary', run);
    ctx.body.append(scan, h('div', { class: 'mm-actions' }, [start]));
    function status(a) {
      const res = ctx.results(), ids = a.missions || [], rs = ids.map(id => res[id]);
      if (!ids.length || rs.some(r => !r)) return 'open';
      return rs.every(r => r.ok && !r.r && !r.k && r.e <= 1) ? 'good' : 'repeat';
    }
    async function run() {
      start.hidden = true; list.replaceChildren();
      scan.classList.add('is-scanning'); await wait(ctx.rm ? 0 : 1500); scan.classList.remove('is-scanning');
      let allGood = true;
      for (const a of A) {
        const st = status(a); if (st !== 'good') allGood = false;
        const li = h('li', { class: 'mm-status-' + st + ' mm-slidein' }, [
          h('span', { class: 'mm-sym', 'aria-hidden': 'true', text: st === 'good' ? '✓' : st === 'repeat' ? '◐' : '○' }),
          h('span', { class: 'mm-status-lbl', text: a.label }),
          h('span', { class: 'mm-status-txt', text: st === 'good' ? 'sicher' : st === 'repeat' ? 'wiederholen' : 'noch offen' }),
          (st !== 'good' && a.page != null) ? btn(a.pageLabel || 'Zur Seite', 'mm-ghost mm-mini', () => ctx.navigate(a.page)) : null
        ]);
        list.appendChild(li); await wait(ctx.rm ? 0 : 220);
      }
      ctx.say(allGood ? (d.allGood || 'Alles sitzt – weiter zum nächsten Kapitel.') : 'Die markierten Bereiche lohnen einen zweiten Blick.', allGood ? 'ok' : 'info');
      ctx.done();
    }
    return { keepInteractive: true };
  };

  /* ------------------------------------------------------------------ CSS */
  function injectCSS() {
    if (document.getElementById('mm-css')) return;
    const st = document.createElement('style'); st.id = 'mm-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  const CSS = `
.mm{--mm-lane:48px;position:relative;box-sizing:border-box;color:var(--mm-text);background-color:var(--mm-panel);font-family:var(--mm-font);font-size:16px;line-height:1.4;border-radius:18px;padding:clamp(14px,3vw,24px);max-width:960px;margin:0 auto;box-shadow:0 10px 30px rgba(0,0,0,.25);overflow:hidden;isolation:isolate}
.mm *,.mm *::before,.mm *::after{box-sizing:border-box}
.mm [hidden]{display:none!important}
html.mm-dragging,html.mm-dragging *{-webkit-user-select:none!important;user-select:none!important}
.mm-pat-raster{background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);background-size:28px 28px}
.mm-pat-hoehenlinien{background-image:repeating-radial-gradient(circle at 90% -10%,transparent 0 26px,rgba(255,255,255,.05) 26px 28px)}
.mm-pat-wellen{background-image:repeating-linear-gradient(172deg,transparent 0 20px,rgba(255,255,255,.04) 20px 22px)}
.mm-pat-waben{background-image:radial-gradient(rgba(255,255,255,.08) 1.5px,transparent 2px);background-size:18px 18px}
.mm-pat-akte{background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px);background-size:100% 26px}
.mm-pat-sterne{background-image:radial-gradient(1.5px 1.5px at 20px 30px,rgba(255,255,255,.55),transparent),radial-gradient(1px 1px at 120px 80px,rgba(255,255,255,.4),transparent),radial-gradient(1.5px 1.5px at 60px 150px,rgba(255,255,255,.45),transparent),radial-gradient(1px 1px at 170px 20px,rgba(255,255,255,.4),transparent),radial-gradient(1px 1px at 150px 170px,rgba(255,255,255,.35),transparent);background-size:200px 200px}
.mm-head{display:flex;align-items:center;gap:12px}
.mm-badge{flex:none;width:42px;height:42px;border-radius:12px;display:grid;place-items:center;color:var(--mm-accent);background:rgba(0,0,0,.22);border:1px solid rgba(255,255,255,.12)}
.mm-ico{width:24px;height:24px}
.mm-titles{flex:1;min-width:0}
.mm-kicker{display:block;font-size:.72em;letter-spacing:.12em;text-transform:uppercase;color:var(--mm-muted)}
.mm-title{margin:0;font-size:1.25em;line-height:1.2}
.mm-led{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:.95em;border:2px solid var(--mm-muted);color:var(--mm-muted);transition:background .3s,color .3s,border-color .3s}
.mm-led.is-busy{border-color:var(--mm-warn);color:var(--mm-warn)}
.mm-led.is-done{background:var(--mm-accent);border-color:var(--mm-accent);color:var(--mm-panel)}
.mm-bar{height:6px;border-radius:3px;background:rgba(255,255,255,.12);margin:14px 0 10px;overflow:hidden}
.mm-bar-fill{display:block;height:100%;width:0;background:var(--mm-accent);border-radius:3px;transition:width .45s ease}
.mm-intro{margin:.2em 0 .8em;opacity:.92}
.mm-body{margin:10px 0 6px}
.mm.is-finished:not(.mm-keep) .mm-body{pointer-events:none}
.mm.is-skipped .mm-body{opacity:.45}
.mm-fb{display:flex;gap:10px;align-items:flex-start;min-height:1.6em;margin-top:10px;padding:0;font-size:.97em}
.mm-fb:empty{min-height:0;margin:0}
.mm-fb-sym{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:.8em;font-weight:700;background:rgba(255,255,255,.14)}
.mm-fb.is-ok .mm-fb-sym{background:var(--mm-accent);color:var(--mm-panel)}
.mm-fb.is-err .mm-fb-sym{background:var(--mm-err);color:var(--mm-panel)}
.mm-fb.is-err{color:color-mix(in srgb,var(--mm-err) 55%,var(--mm-text))}
.mm-fb ul{margin:0;padding-left:1.1em}
.mm-hint{margin-top:10px;padding:10px 14px;border-left:3px solid var(--mm-accent);background:rgba(255,255,255,.06);border-radius:0 10px 10px 0;font-size:.95em}
.mm-done{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;padding:10px 14px;border-radius:12px;border:1px solid var(--mm-accent);background:color-mix(in srgb,var(--mm-accent) 16%,transparent)}
.mm-done strong{color:var(--mm-accent)}
.mm-check{width:26px;height:26px;fill:none;stroke:var(--mm-accent);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:24;stroke-dashoffset:24;animation:mm-draw .4s .1s ease-out forwards}
.mm-foot{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px}
.mm-foot:empty{display:none}
.mm-btn,.mm-case-pick{font:inherit;color:var(--mm-text);background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.22);border-radius:10px;padding:.55em 1em;cursor:pointer;transition:background .2s,border-color .2s,box-shadow .2s,opacity .2s;line-height:1.3}
.mm-btn:hover:not(:disabled),.mm-case-pick:hover:not(:disabled){background:rgba(255,255,255,.14)}
.mm button:focus-visible,.mm input:focus-visible,.mm .mm-chip:focus-visible{outline:3px solid var(--mm-accent);outline-offset:2px}
.mm button:disabled{cursor:default;opacity:.45}
.mm-primary{background:var(--mm-accent);color:var(--mm-panel);border-color:transparent;font-weight:700}
.mm-primary:hover:not(:disabled){background:color-mix(in srgb,var(--mm-accent) 85%,white)}
.mm-ghost{background:transparent}
.mm-mini{padding:.3em .7em;font-size:.85em}
.mm-actions{display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap;margin-top:12px}
.mm-actions-top{justify-content:space-between;margin:0 0 8px}
.mm-actions-split{justify-content:space-between}
.mm-small{font-size:.85em;color:var(--mm-muted)}
.mm-cap{display:block;font-size:.75em;letter-spacing:.1em;text-transform:uppercase;color:var(--mm-muted);margin-bottom:6px}
.mm-qtext{font-weight:700;margin:0 0 10px}
.mm-error{color:var(--mm-err)}
.mm-choices{display:grid;gap:8px}
.mm-choice{text-align:left;width:100%}
.mm-choice.is-right,.mm-choice.is-right:disabled{opacity:1;border-color:var(--mm-accent);background:color-mix(in srgb,var(--mm-accent) 22%,transparent)}
.mm-choice.is-wrong{border-color:var(--mm-err);text-decoration:line-through}
.mm-summary{list-style:none;margin:0;padding:0}
.mm-summary li{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.1)}
.mm-summary-ol li{flex-direction:column;gap:2px}
.mm-summary .mm-sym{flex:none;font-weight:700}
.mm-summary .is-wrong .mm-sym{color:var(--mm-err)}
.mm-summary .is-right .mm-sym{color:var(--mm-accent)}
.mm-why{color:var(--mm-muted)}
/* G01 */
.mm-match{position:relative;display:grid;grid-template-columns:1fr 1fr;column-gap:clamp(48px,16%,160px)}
.mm-col{display:flex;flex-direction:column;justify-content:space-around;gap:10px;position:relative;z-index:1}
.mm-wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:2}
.mm-wire{stroke-width:5;stroke-linecap:round;fill:none}
.mm-wire-temp{stroke-dasharray:7 7;opacity:.85}
.mm-flow{animation:mm-glow .7s ease-out 1}
.mm-node{display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;min-height:52px;user-select:none;-webkit-user-select:none;touch-action:none}
.mm-node-r{justify-content:flex-start}
.mm-plug{flex:none;width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,.25);box-shadow:0 0 0 3px var(--mm-panel),0 0 0 5px rgba(255,255,255,.25)}
.mm-node.is-sel{border-color:var(--mm-accent);box-shadow:0 0 0 2px var(--mm-accent)}
.mm-node.is-over{border-color:var(--mm-accent);background:color-mix(in srgb,var(--mm-accent) 18%,transparent)}
.mm-node.is-done,.mm-node.is-done:disabled{opacity:1;background:rgba(0,0,0,.2);border-color:transparent}
/* G02 */
.mm-door{position:relative;height:56px;border-radius:12px;overflow:hidden;margin-bottom:12px;background:color-mix(in srgb,var(--mm-accent) 20%,transparent)}
.mm-door-msg{position:absolute;inset:0;display:grid;place-items:center;font-weight:700;color:var(--mm-accent);opacity:0;transition:opacity .3s .25s}
.mm-door.is-open .mm-door-msg{opacity:1}
.mm-door-l,.mm-door-r{position:absolute;top:0;bottom:0;width:50%;background:repeating-linear-gradient(135deg,var(--mm-panel2) 0 14px,rgba(0,0,0,.28) 14px 28px);transition:translate .7s cubic-bezier(.6,0,.2,1)}
.mm-door-l{left:0;border-right:2px solid rgba(0,0,0,.35)}
.mm-door-r{right:0}
.mm-door-lock{position:absolute;inset:0;display:grid;place-items:center;font-size:.8em;font-weight:700;letter-spacing:.14em;text-transform:uppercase;transition:opacity .25s}
.mm-door.is-open .mm-door-l{translate:-100% 0}
.mm-door.is-open .mm-door-r{translate:100% 0}
.mm-door.is-open .mm-door-lock{opacity:0}
.mm-pad{display:grid;grid-template-columns:repeat(var(--cols,3),1fr);gap:10px}
.mm-key{min-height:62px;display:flex;align-items:center;justify-content:center;gap:8px;text-align:center;font-weight:600;background:var(--mm-panel2);border:2px solid rgba(255,255,255,.18);border-radius:12px}
.mm-key-no{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:.85em;background:var(--mm-panel);color:var(--mm-accent)}
.mm-key-no:empty{display:none}
.mm-key.is-on,.mm-key.is-on:disabled{opacity:1;background:var(--mm-accent);color:var(--mm-panel);border-color:var(--mm-accent)}
.mm-key.is-press{background:var(--mm-accent);color:var(--mm-panel)}
/* G03 */
.mm-cardzone{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:18px;flex-wrap:wrap}
.mm-arrow{font-size:1.6em;color:var(--mm-muted)}
.mm-card{width:210px;height:128px;border-radius:14px;border:none;padding:14px;display:flex;flex-direction:column;justify-content:space-between;align-items:flex-start;font:inherit;font-weight:700;color:var(--mm-panel);background:linear-gradient(135deg,var(--mm-accent),color-mix(in srgb,var(--mm-accent) 55%,white));box-shadow:0 8px 18px rgba(0,0,0,.3);cursor:grab;user-select:none;-webkit-user-select:none;transition:filter .4s}
.mm .mm-card:disabled{opacity:1}
.mm-card.is-locked{filter:grayscale(1) brightness(.65);cursor:not-allowed}
.mm-card.is-dragging{cursor:grabbing;z-index:5;position:relative}
.mm-card-chip{width:36px;height:27px;border-radius:5px;background:linear-gradient(135deg,#efe7b4,#b8a95c)}
.mm-card-state{font-size:.72em;letter-spacing:.1em;text-transform:uppercase}
.mm-card.is-swiping{animation:mm-swipe .65s ease-in forwards}
.mm-reader{width:230px;padding:12px;border-radius:14px;background:rgba(0,0,0,.28);display:flex;flex-direction:column;gap:10px;border:2px solid transparent}
.mm-reader.is-over{border-color:var(--mm-accent);border-style:dashed}
.mm-reader-screen{font-family:Consolas,monospace;font-weight:700;padding:8px 10px;border-radius:6px;text-align:center;letter-spacing:.1em;text-transform:uppercase;background:#3a1410;color:#ff9a86;transition:background .3s,color .3s}
.mm-reader.is-open .mm-reader-screen{background:#1f2a06;color:var(--mm-accent)}
.mm-slot{height:10px;border-radius:5px;background:#000;box-shadow:inset 0 2px 4px rgba(0,0,0,.8)}
/* G04 */
.mm-dist-head{margin-bottom:8px}
.mm-rest{font-size:1.4em;color:var(--mm-warn)}
.mm-rest.is-zero{color:var(--mm-accent)}
.mm-dist-row{display:grid;grid-template-columns:minmax(120px,1.3fr) 1.4fr 1fr 2.2em;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08)}
.mm input[type=range]{width:100%;accent-color:var(--mm-accent);cursor:pointer}
.mm-meter{height:14px;border-radius:7px;background:rgba(255,255,255,.1);overflow:hidden}
.mm-meter-fill{display:block;height:100%;width:0;background:var(--mm-accent);transition:width .25s}
.mm-val{font-weight:700;text-align:right}
/* G05 */
.mm-stage{position:relative;height:calc(var(--lanes) * var(--mm-lane) + 8px);--lane-h:var(--mm-lane);overflow:hidden;border-radius:12px;background:rgba(0,0,0,.22)}
.mm-float{position:absolute;left:100%;height:40px;padding:0 16px;white-space:nowrap;border-radius:20px;background:var(--mm-panel2);animation:mm-drift linear infinite}
.mm-float:hover,.mm-float:focus-visible,.mm-stage.is-paused .mm-float{animation-play-state:paused}
.mm-stage .mm-float.is-hit{animation:mm-burst .45s ease-out forwards;animation-play-state:running;pointer-events:none}
.mm-count{font-weight:700;color:var(--mm-accent)}
/* G06 */
.mm-seq{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.mm-seq-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px}
.mm-seq-cell{min-height:58px;display:grid;place-items:center;text-align:center;padding:6px;border-radius:10px;font-size:.9em;background:rgba(0,0,0,.25);color:var(--mm-muted);transition:background .15s,color .15s,box-shadow .15s}
.mm-seq-cell.is-lit{background:var(--mm-accent);color:var(--mm-panel);box-shadow:0 0 20px var(--mm-accent)}
.mm-seq-cell.is-shown{color:var(--mm-text)}
.mm-seq-grid .mm-key{min-height:58px;font-size:.9em}
.mm-seq-status{flex:1;min-width:180px;font-size:.92em}
.mm-rounds{display:flex;gap:6px}
.mm-round{width:14px;height:14px;border-radius:50%;border:2px solid var(--mm-muted);transition:background .3s}
.mm-round.is-done{background:var(--mm-accent);border-color:var(--mm-accent)}
/* G07 */
.mm-route{position:relative;height:86px;margin:6px 28px 8px}
.mm-route::before{content:"";position:absolute;left:0;right:0;top:30px;border-top:3px dashed rgba(255,255,255,.3)}
.mm-route-trail{position:absolute;left:0;top:29px;height:5px;width:0;border-radius:3px;background:var(--mm-accent);transition:width .8s ease}
.mm-route-dot{position:absolute;top:21px;width:22px;height:22px;margin-left:-11px;border-radius:50%;background:var(--mm-panel);border:3px solid var(--mm-muted);transition:border-color .3s}
.mm-route-dot.is-goal{border-radius:5px;rotate:45deg}
.mm-route-dot.is-past{border-color:var(--mm-accent)}
.mm-route-lab{position:absolute;top:52px;translate:-50% 0;max-width:120px;text-align:center;font-size:.76em;color:var(--mm-muted);line-height:1.2}
.mm-route-lab.is-first{translate:-20% 0}
.mm-route-lab.is-last{translate:-80% 0}
.mm-route-marker{position:absolute;top:15px;left:0;width:34px;height:34px;margin-left:-17px;border-radius:50%;background:var(--mm-accent);box-shadow:0 0 0 6px color-mix(in srgb,var(--mm-accent) 30%,transparent);transition:left .8s cubic-bezier(.5,0,.2,1);z-index:1}
.mm-route-marker.is-detour{animation:mm-detour .8s ease-in-out}
.mm-station{margin-top:4px}
/* G09 */
.mm-esc{display:grid;grid-template-columns:150px 1fr;gap:22px;align-items:start}
.mm-esc-side{display:flex;flex-direction:column;align-items:center;gap:10px}
.mm-rings{width:140px;height:140px}
.mm-ring{fill:none;stroke:rgba(255,255,255,.35);stroke-width:9;stroke-linecap:round;transform-box:fill-box;transform-origin:center;transform:rotate(calc(-54deg + var(--rot)));transition:transform .8s cubic-bezier(.3,1.5,.5,1),stroke .3s}
.mm-ring.is-locked{transform:rotate(-54deg);stroke:var(--mm-accent)}
.mm-ring-core{fill:rgba(255,255,255,.12)}
.mm-ring-tick{fill:var(--mm-accent)}
.mm-heat{display:flex;flex-direction:column;align-items:center;gap:4px}
.mm-heat-bar{display:flex;gap:4px}
.mm-heat-bar span{width:30px;height:10px;border-radius:5px;background:rgba(255,255,255,.14);transition:background .3s}
.mm-heat-bar span.is-on.is-1{background:var(--mm-accent)}
.mm-heat-bar span.is-on.is-2{background:var(--mm-warn)}
.mm-heat-bar span.is-on.is-3{background:var(--mm-err)}
/* G08 */
.mm-gauge{position:relative;height:46px;border-radius:10px;background:linear-gradient(90deg,rgba(255,255,255,.06),rgba(255,255,255,.14));overflow:hidden;margin-top:6px}
.mm-gauge-band{position:absolute;top:0;bottom:0;background:color-mix(in srgb,var(--mm-accent) 45%,transparent);border-left:2px solid var(--mm-accent);border-right:2px solid var(--mm-accent);opacity:0;transition:opacity .4s}
.mm-gauge.is-shown .mm-gauge-band{opacity:1}
.mm-gauge-needle{position:absolute;top:4px;bottom:4px;width:4px;margin-left:-2px;border-radius:2px;background:var(--mm-text);box-shadow:0 0 8px rgba(255,255,255,.6);transition:left .12s}
.mm-gauge-scale{display:flex;justify-content:space-between;font-size:.8em;color:var(--mm-muted);margin:4px 0 6px}
.mm-big{font-size:1.6em;font-weight:700;color:var(--mm-accent)}
/* G10 */
.mm-load-row{display:flex;align-items:center;gap:10px}
.mm-load{flex:1;height:14px;border-radius:7px;background:rgba(0,0,0,.3);overflow:hidden}
.mm-load-fill{display:block;height:100%;width:0;background:repeating-linear-gradient(45deg,var(--mm-accent) 0 10px,color-mix(in srgb,var(--mm-accent) 72%,white) 10px 20px);background-size:28px 28px;transition:width .4s ease;animation:mm-stripes 1.2s linear infinite}
.mm-load-pct{min-width:3.5em;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
.mm-fact{margin-top:12px;padding:16px 18px;border-radius:12px;background:rgba(0,0,0,.22);min-height:96px}
.mm-fact-text{font-size:1.12em;margin:0}
/* G11 */
.mm-filter-wrap{display:grid;grid-template-columns:1fr 140px;gap:16px}
.mm-filter{display:flex;flex-wrap:wrap;gap:12px;align-content:flex-start;padding:16px;min-height:180px;border-radius:14px;background:repeating-linear-gradient(0deg,rgba(255,255,255,.05) 0 2px,transparent 2px 14px),rgba(0,0,0,.22)}
.mm-bob{border-radius:20px;animation:mm-bob 3.2s ease-in-out infinite;user-select:none;-webkit-user-select:none}
.mm-bob.is-sel{border-color:var(--mm-accent);box-shadow:0 0 0 2px var(--mm-accent)}
.mm-bob.is-dragging{animation:none;position:relative;z-index:5;box-shadow:0 8px 18px rgba(0,0,0,.35)}
.mm-bob.is-gone{animation:mm-gone .4s ease-in forwards}
.mm-bob.is-keep,.mm-bob.is-keep:disabled{opacity:1;animation:none;border-color:var(--mm-accent)}
.mm-bob.is-keep::before{content:"✓ ";color:var(--mm-accent);font-weight:700}
.mm-bin{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;font:inherit;color:inherit;cursor:pointer;border-radius:14px;border:2px dashed rgba(255,255,255,.35);background:rgba(0,0,0,.15);transition:border-color .2s,background .2s}
.mm-bin.is-over{border-color:var(--mm-accent);background:color-mix(in srgb,var(--mm-accent) 18%,transparent)}
.mm-bin-ico{width:46px;height:46px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.mm-lid{transform-box:fill-box;transform-origin:0% 100%;transition:rotate .2s}
.mm-bin.is-over .mm-lid{rotate:-28deg}
.mm-bin.mm-gulp .mm-bin-ico{animation:mm-gulp .45s}
/* G12 */
.mm-cases{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.mm-case{display:flex;flex-direction:column;border-radius:12px;background:rgba(0,0,0,.22);border:2px solid transparent;transition:border-color .3s,opacity .3s}
.mm-case-head{display:flex;align-items:center;gap:10px;padding:12px;font:inherit;font-weight:700;color:inherit;background:none;border:none;text-align:left;cursor:pointer;border-radius:12px}
.mm-case-no{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--mm-panel2);color:var(--mm-accent);transition:background .3s}
.mm-case.is-open .mm-case-no{background:var(--mm-accent);color:var(--mm-panel)}
.mm-case-body{max-height:0;opacity:0;overflow:hidden;padding:0 12px;font-size:.95em;transition:max-height .4s ease,opacity .3s,padding .3s}
.mm-case.is-open .mm-case-body{max-height:420px;opacity:1;padding:0 12px 12px}
.mm-case-pick{margin:auto 12px 12px}
.mm-case.is-ok{opacity:.65;border-color:rgba(255,255,255,.2)}
.mm-case.is-odd{border-color:var(--mm-accent)}
.mm-case.is-odd .mm-case-head::after{content:"auffällig ✓";margin-left:auto;font-size:.8em;color:var(--mm-accent)}
/* G13 */
.mm-tank-row{display:flex;align-items:center;justify-content:center;gap:32px;flex-wrap:wrap}
.mm-tank-wrap{display:flex;gap:8px}
.mm-tank-ticks{height:220px;display:flex;flex-direction:column;justify-content:space-between;font-size:.72em;line-height:1;color:var(--mm-muted);text-align:right;padding:0}
.mm-tank{position:relative;width:110px;height:220px;border-radius:14px 14px 22px 22px;border:3px solid rgba(255,255,255,.5);background:rgba(0,0,0,.28);overflow:hidden}
.mm-tank-fill{position:absolute;left:0;right:0;bottom:0;height:0;background:linear-gradient(180deg,color-mix(in srgb,var(--mm-accent) 80%,white),var(--mm-accent));transition:height .4s ease}
.mm-tank-fill::before{content:"";position:absolute;left:0;right:0;top:-6px;height:12px;background:radial-gradient(ellipse 12px 6px at 12px 6px,color-mix(in srgb,var(--mm-accent) 80%,white) 96%,transparent 100%) repeat-x;background-size:24px 12px;animation:mm-wave 2.4s linear infinite}
.mm-tank-fill.is-empty::before{display:none}
.mm-tank-mark{position:absolute;left:0;right:0;height:0;border-top:3px dashed var(--mm-text);display:none}
.mm-tank.is-shown .mm-tank-mark{display:block}
.mm-tank.is-ok{border-color:var(--mm-accent)}
.mm-tank-ctrl{display:flex;flex-direction:column;align-items:center;gap:10px}
.mm-roundbtn{width:54px;height:54px;padding:0;border-radius:50%;font-size:1.6em;font-weight:700}
/* G14 */
.mm-chip-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.mm-chip{padding:10px 16px;border-radius:12px;font-weight:700;background:var(--mm-accent);color:var(--mm-panel);cursor:grab;user-select:none;-webkit-user-select:none;box-shadow:0 6px 14px rgba(0,0,0,.25)}
.mm-chip.is-dragging{cursor:grabbing;position:relative;z-index:5}
.mm-chip.is-empty{background:transparent;color:var(--mm-accent);box-shadow:none;cursor:default}
.mm-matrix-wrap{display:grid;grid-template-columns:auto 1fr;grid-template-rows:1fr auto;gap:6px 8px}
.mm-axis-y{writing-mode:vertical-rl;rotate:180deg;text-align:center;font-size:.82em;color:var(--mm-muted)}
.mm-axis-x{text-align:center;font-size:.82em;color:var(--mm-muted)}
.mm-matrix-inner{position:relative}
.mm-matrix{display:grid;grid-template-columns:repeat(var(--cols,2),1fr);gap:8px}
.mm-cell{min-height:110px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:10px;text-align:left;font:inherit;color:inherit;cursor:pointer;border-radius:12px;background:rgba(0,0,0,.22);border:2px solid rgba(255,255,255,.14);transition:border-color .2s,background .2s}
.mm-cell:hover:not(:disabled),.mm-cell.is-over{border-color:var(--mm-accent)}
.mm .mm-cell:disabled{opacity:1;cursor:default}
.mm-cell-lbl{font-weight:700;font-size:.9em}
.mm-cell-items{display:flex;flex-wrap:wrap;gap:4px}
.mm-cell-chip{font-size:.78em;padding:3px 9px;border-radius:10px;background:var(--mm-accent);color:var(--mm-panel);animation:mm-pop .3s ease-out}
.mm-cross{position:absolute;left:0;top:0;width:56px;height:56px;margin:-28px 0 0 -28px;border:2px solid var(--mm-accent);border-radius:50%;pointer-events:none;opacity:0;transition:transform .5s cubic-bezier(.3,1.3,.5,1),opacity .2s}
.mm-cross::before,.mm-cross::after{content:"";position:absolute;background:var(--mm-accent)}
.mm-cross::before{left:50%;top:-8px;bottom:-8px;width:2px;margin-left:-1px}
.mm-cross::after{top:50%;left:-8px;right:-8px;height:2px;margin-top:-1px}
.mm-cross.is-on{opacity:.9}
.mm-cross.mm-lockon{animation:mm-lockon .5s ease-out}
/* G15 */
.mm-cargo-wrap{display:grid;grid-template-columns:1fr 130px;gap:16px}
.mm-cargo{list-style:none;margin:0;padding:0;display:grid;gap:8px;align-content:start}
.mm-cargo-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,.22)}
.mm-cargo-item input{width:20px;height:20px;flex:none;accent-color:var(--mm-accent)}
.mm-cargo-item label{cursor:pointer;flex:1}
.mm-cargo-item.is-gone{animation:mm-fall .6s ease-in forwards}
.mm-lever{position:relative;min-height:170px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:10px;padding:14px;font:inherit;color:inherit;cursor:pointer;border-radius:14px;background:rgba(0,0,0,.22);border:2px solid rgba(255,255,255,.2)}
.mm-lever:hover:not(:disabled){border-color:var(--mm-accent)}
.mm-lever-arm{position:relative;width:10px;height:92px;border-radius:5px;background:linear-gradient(#cfd8da,#7d9296);transform-origin:50% 100%;rotate:-22deg}
.mm-lever-arm::before{content:"";position:absolute;left:50%;top:-12px;width:26px;height:26px;margin-left:-13px;border-radius:50%;background:var(--mm-accent)}
.mm-lever.is-pulled .mm-lever-arm{animation:mm-pull .6s ease-in-out}
.mm-lever-lbl{font-weight:700}
/* G16 */
.mm-scan{position:relative;min-height:150px;padding:14px;border-radius:12px;background:rgba(0,0,0,.22);overflow:hidden}
.mm-scan-beam{position:absolute;left:0;right:0;top:-24%;height:24%;opacity:0;pointer-events:none;background:linear-gradient(transparent,color-mix(in srgb,var(--mm-accent) 50%,transparent),transparent)}
.mm-scan.is-scanning .mm-scan-beam{opacity:1;animation:mm-beam 1.5s ease-in-out}
.mm-status{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.mm-status li{display:grid;grid-template-columns:28px 1fr auto auto;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.05)}
.mm-status li.mm-small{display:block;background:none}
.mm-status .mm-sym{font-weight:700;font-size:1.15em;text-align:center}
.mm-status-good .mm-sym,.mm-status-good .mm-status-txt{color:var(--mm-accent)}
.mm-status-repeat .mm-sym,.mm-status-repeat .mm-status-txt{color:var(--mm-warn)}
.mm-status-open .mm-sym,.mm-status-open .mm-status-txt{color:var(--mm-muted)}
.mm-status-txt{font-size:.85em}
/* Animationen */
.mm-shake{animation:mm-shake .32s ease-in-out}
.mm-pulse{animation:mm-pulse .5s ease-out}
.mm-win{animation:mm-win .7s ease-out}
.mm-slidein{animation:mm-slidein .3s ease-out}
@keyframes mm-shake{20%,60%{translate:-6px 0}40%,80%{translate:6px 0}}
@keyframes mm-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--mm-accent) 70%,transparent)}100%{box-shadow:0 0 0 12px transparent}}
@keyframes mm-win{0%{box-shadow:0 0 0 0 var(--mm-accent)}100%{box-shadow:0 0 0 14px transparent,0 10px 30px rgba(0,0,0,.25)}}
@keyframes mm-slidein{from{opacity:0;translate:14px 0}to{opacity:1;translate:0 0}}
@keyframes mm-draw{to{stroke-dashoffset:0}}
@keyframes mm-glow{50%{stroke-width:9}}
@keyframes mm-swipe{60%{translate:var(--dx,200px) 0;opacity:1}100%{translate:calc(var(--dx,200px) + 60px) 0;opacity:0}}
@keyframes mm-drift{from{left:100%;translate:0 0}to{left:0;translate:-100% 0}}
@keyframes mm-burst{to{scale:1.4;opacity:0;filter:blur(3px)}}
@keyframes mm-detour{35%,65%{translate:16px 22px}}
@keyframes mm-stripes{to{background-position:28px 0}}
@keyframes mm-bob{50%{translate:0 -6px}}
@keyframes mm-gone{to{scale:.2;opacity:0}}
@keyframes mm-gulp{40%{scale:1.2}}
@keyframes mm-wave{to{background-position-x:24px}}
@keyframes mm-pop{from{scale:.4;opacity:0}}
@keyframes mm-lockon{0%{scale:1.8;opacity:0}100%{scale:1;opacity:.9}}
@keyframes mm-fall{to{translate:30px 60px;rotate:8deg;opacity:0}}
@keyframes mm-pull{45%{rotate:22deg}}
@keyframes mm-beam{to{top:100%}}
@keyframes mm-settle{30%{translate:8px 0}60%{translate:-4px 0}}
.mm-settle{animation:mm-settle .5s ease-out}
@media (max-width:620px){
  .mm-dist-row{grid-template-columns:1fr 2.2em}.mm-dist-row input{grid-column:1/-1}.mm-dist-row .mm-meter{display:none}
  .mm-seq,.mm-esc,.mm-filter-wrap,.mm-cargo-wrap{grid-template-columns:1fr}
  .mm-bin,.mm-lever{min-height:90px;flex-direction:row}
  .mm-lever-arm{height:50px}
  .mm-match{column-gap:36px}
  .mm-cardzone{justify-content:center}.mm-arrow{display:none}
}
@media (prefers-reduced-motion: reduce){
  .mm *,.mm{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
  .mm-stage{height:auto;display:flex;flex-wrap:wrap;gap:8px;padding:8px}
  .mm-float{position:static!important;animation:none!important;white-space:normal;height:auto;min-height:40px}
  .mm-bob,.mm-load-fill,.mm-tank-fill::before{animation:none!important}
}`;

  global.MiniMissionen = MM;
}
miniMissionen(window);
