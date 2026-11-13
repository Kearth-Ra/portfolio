function kursLms(opts) {
  opts = opts || {};
  if (opts.preview) return null;
  const pad = (n, l) => String(Math.floor(n)).padStart(l, '0');
  const time12 = s => `${pad(s / 3600, 4)}:${pad((s % 3600) / 60, 2)}:${pad(s % 60, 2)}`;
  const iso = s => `PT${Math.floor(s / 3600)}H${Math.floor((s % 3600) / 60)}M${Math.round(s % 60)}S`;
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
  const safeId = id => String(id).replace(/[^\w.\-:]/g, '_');

  function findApi(name) {
    function scan(w) {
      let n = 0;
      try {
        while (w && !w[name] && w.parent && w.parent !== w && n < 10) { w = w.parent; n++; }
        return (w && w[name]) || null;
      } catch (e) { return null; }
    }
    return scan(window) || (window.opener ? scan(window.opener) : null);
  }

  // ---------- SCORM 1.2 ----------
  function scorm12(api) {
    const set = (k, v) => api.LMSSetValue(k, String(v));
    return {
      standard: '1.2', suspendLimit: 4000,
      async start() {
        if (String(api.LMSInitialize('')) !== 'true') return null;
        const g = k => api.LMSGetValue(k);
        return { location: g('cmi.core.lesson_location'), suspend: g('cmi.suspend_data'), name: g('cmi.core.student_name') };
      },
      save(loc, data) { set('cmi.core.lesson_location', loc); set('cmi.suspend_data', clip(data, 4096)); },
      result(r) {
        if (r.pct != null) { set('cmi.core.score.min', 0); set('cmi.core.score.max', 100); set('cmi.core.score.raw', r.pct); }
        let status = 'incomplete';
        if (r.completed) status = r.useSuccess && r.testDone ? (r.passed ? 'passed' : 'failed') : 'completed';
        else if (r.useSuccess && r.testDone && !r.passed) status = 'failed';
        set('cmi.core.lesson_status', status);
        set('cmi.core.exit', r.completed ? '' : 'suspend');
      },
      time(sec) { set('cmi.core.session_time', time12(sec)); },
      interaction(n, d) {
        const p = `cmi.interactions.${n}.`;
        set(p + 'id', safeId(d.id));
        set(p + 'type', d.type);
        if (d.response != null) set(p + 'student_response', clip(d.response, 255));
        if (d.pattern != null) set(p + 'correct_responses.0.pattern', clip(d.pattern, 255));
        set(p + 'result', d.result === 'incorrect' ? 'wrong' : d.result);
        if (d.weighting != null) set(p + 'weighting', d.weighting);
        if (d.latency != null) set(p + 'latency', time12(d.latency));
      },
      objective(n, o) {
        const p = `cmi.objectives.${n}.`;
        set(p + 'id', safeId(o.id));
        if (o.pct != null) { set(p + 'score.min', 0); set(p + 'score.max', 100); set(p + 'score.raw', o.pct); }
        set(p + 'status', o.pct == null ? 'incomplete' : o.passed ? 'passed' : 'failed');
      },
      commit() { api.LMSCommit(''); },
      finish() { api.LMSFinish(''); }
    };
  }

  // ---------- SCORM 2004 ----------
  function scorm2004(api) {
    const set = (k, v) => api.SetValue(k, String(v));
    return {
      standard: '2004', suspendLimit: 60000,
      async start() {
        if (String(api.Initialize('')) !== 'true') return null;
        const g = k => api.GetValue(k);
        return { location: g('cmi.location'), suspend: g('cmi.suspend_data'), name: g('cmi.learner_name') };
      },
      save(loc, data) { set('cmi.location', loc); set('cmi.suspend_data', clip(data, 64000)); },
      result(r) {
        if (r.pct != null) {
          set('cmi.score.min', 0); set('cmi.score.max', 100); set('cmi.score.raw', r.pct);
          set('cmi.score.scaled', (r.pct / 100).toFixed(2));
        }
        set('cmi.completion_status', r.completed ? 'completed' : 'incomplete');
        set('cmi.success_status', r.useSuccess && r.testDone ? (r.passed ? 'passed' : 'failed') : 'unknown');
        set('cmi.exit', r.completed ? 'normal' : 'suspend');
      },
      time(sec) { set('cmi.session_time', iso(sec)); },
      interaction(n, d) {
        const p = `cmi.interactions.${n}.`;
        set(p + 'id', safeId(d.id));
        set(p + 'type', d.type);
        if (d.response != null) set(p + 'learner_response', clip(d.response, 4000));
        if (d.pattern != null) set(p + 'correct_responses.0.pattern', clip(d.pattern, 4000));
        set(p + 'result', d.result === 'wrong' ? 'incorrect' : d.result);
        if (d.weighting != null) set(p + 'weighting', d.weighting);
        if (d.latency != null) set(p + 'latency', iso(d.latency));
      },
      objective(n, o) {
        const p = `cmi.objectives.${n}.`;
        set(p + 'id', safeId(o.id));
        if (o.pct != null) set(p + 'score.scaled', (o.pct / 100).toFixed(2));
        set(p + 'success_status', o.pct == null ? 'unknown' : o.passed ? 'passed' : 'failed');
        set(p + 'completion_status', o.pct == null ? 'incomplete' : 'completed');
      },
      commit() { api.Commit(''); },
      finish() { api.Terminate(''); }
    };
  }

  // ---------- cmi5 (xAPI) ----------
  function cmi5(params) {
    const endpoint = params.get('endpoint').replace(/\/?$/, '/');
    const actor = JSON.parse(params.get('actor'));
    const registration = params.get('registration');
    const activityId = params.get('activityId');
    const started = Date.now();
    let auth = '', launch = {}, saveTimer = null;
    const sent = {}; // completed, passed, failed:<pct>, answered:<id>
    const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
    const headers = () => ({ Authorization: auth, 'X-Experience-API-Version': '1.0.3', 'Content-Type': 'application/json' });
    const stateUrl = id => `${endpoint}activities/state?stateId=${encodeURIComponent(id)}&activityId=${encodeURIComponent(activityId)}&agent=${encodeURIComponent(JSON.stringify(actor))}&registration=${encodeURIComponent(registration)}`;
    const duration = () => iso((Date.now() - started) / 1000);
    const normalMode = () => !launch.launchMode || launch.launchMode === 'Normal';

    function send(verb, display, opt) {
      opt = opt || {};
      const context = JSON.parse(JSON.stringify(launch.contextTemplate || {}));
      context.registration = registration;
      if (opt.cmi5 !== false) {
        context.contextActivities = context.contextActivities || {};
        const cat = (context.contextActivities.category || []).slice();
        cat.push({ id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' });
        if (opt.moveOn) cat.push({ id: 'https://w3id.org/xapi/cmi5/context/categories/moveon' });
        context.contextActivities.category = cat;
      }
      const st = {
        id: uuid(), actor, timestamp: new Date().toISOString(), context,
        verb: { id: 'http://adlnet.gov/expapi/verbs/' + verb, display: { 'de-DE': display } },
        object: opt.object || { id: activityId, objectType: 'Activity' }
      };
      if (opt.result) st.result = opt.result;
      return fetch(endpoint + 'statements', { method: 'POST', headers: headers(), body: JSON.stringify(st), keepalive: true }).catch(() => { });
    }

    return {
      standard: 'cmi5', suspendLimit: 1e7,
      async start() {
        try {
          const tok = await (await fetch(params.get('fetch'), { method: 'POST' })).json();
          auth = 'Basic ' + tok['auth-token'];
          const ld = await fetch(stateUrl('LMS.LaunchData'), { headers: headers() });
          if (ld.ok) launch = await ld.json();
          let saved = {};
          const s = await fetch(stateUrl('kurs-stand'), { headers: headers() });
          if (s.ok) saved = await s.json();
          await send('initialized', 'initialisiert');
          return { location: saved.location, suspend: saved.suspend, name: actor.name || '', masteryScore: launch.masteryScore };
        } catch (e) { return null; }
      },
      save(loc, data) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => fetch(stateUrl('kurs-stand'), { method: 'PUT', headers: headers(), body: JSON.stringify({ location: loc, suspend: data }), keepalive: true }).catch(() => { }), 800);
      },
      result(r) {
        if (!normalMode()) return;
        if (r.pagesDone && !sent.completed) {
          sent.completed = true;
          send('completed', 'abgeschlossen', { moveOn: true, result: { completion: true, duration: duration() } });
        }
        if (r.hasTest && r.testDone && !sent.passed) {
          const result = { success: r.passed, score: { scaled: +(r.pct / 100).toFixed(2), raw: r.pct, min: 0, max: 100 }, duration: duration() };
          if (r.passed) { sent.passed = true; send('passed', 'bestanden', { moveOn: true, result }); }
          else if (sent.failed !== r.pct) { sent.failed = r.pct; send('failed', 'nicht bestanden', { moveOn: true, result }); }
        }
      },
      time() { /* die Dauer steckt in den Statements */ },
      interaction(n, d) {
        const key = d.id + '|' + d.response;
        if (sent['a:' + d.id] === key) return;
        sent['a:' + d.id] = key;
        send('answered', 'beantwortet', {
          cmi5: false,
          object: {
            id: activityId + '/frage/' + encodeURIComponent(d.id), objectType: 'Activity',
            definition: { type: 'http://adlnet.gov/expapi/activities/cmi.interaction', interactionType: d.type, correctResponsesPattern: d.pattern != null ? [String(d.pattern)] : undefined }
          },
          result: { response: String(d.response == null ? '' : d.response), success: d.result === 'neutral' ? undefined : d.result === 'correct' }
        });
      },
      objective() { /* in cmi5 nicht vorgesehen */ },
      commit() { },
      finish() { send('terminated', 'beendet', { result: { duration: duration() } }); }
    };
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('endpoint') && params.get('fetch') && params.get('actor')) return cmi5(params);
  const a2004 = findApi('API_1484_11');
  const a12 = findApi('API');
  if (opts.standard === '1.2' && a12) return scorm12(a12);
  if (opts.standard === '2004' && a2004) return scorm2004(a2004);
  if (a2004) return scorm2004(a2004);
  if (a12) return scorm12(a12);
  return null;
}

function kursZeit(pages) {
  const SKIP = new Set(['id', 'type', 'kind', 'mythOk', 'size', 'src', 'url', 'video', 'videoUrl', 'videoCredit', 'css', 'blockCss', 'customHtml', 'narration', 'narrationVtt', 'captions', 'captionsText', 'poster',
    'design', 'showIf', 'objective', 'castId', 'char', 'look', 'pose', 'shot', 'audio', 'mechanic', 'spiel', 'style', 'layout', 'cardStyle', 'icon', 'decor',
    'focus', 'treat', 'credit', 'alt', 'blockName', 'lang', 'chapter', 'ref', 'target', 'cat', 'color', 'side', 'mode', 'source', 'image', 'bgImage', 'backImage', 'poses', 'film', 'stage', 'assets', 'consequence', 'help', 'stages', 'mood',
    // Rückmeldungen und Begründungen liest man nur zur eigenen Wahl, Hinweise nur bei Bedarf: sie zählen nicht zur Lesezeit (die Zeit je Frage deckt sie ab)
    'feedback', 'feedbackCorrect', 'feedbackWrong', 'feedbackTrue', 'feedbackFalse', 'why', 'reply', 'hint', 'successText', 'placeholder']);
  const plain = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = o => {
    if (Array.isArray(o)) return o.reduce((n, x) => n + words(x), 0);
    if (o && typeof o === 'object') return Object.keys(o).reduce((n, k) => n + (SKIP.has(k) ? 0 : words(o[k])), 0);
    if (typeof o === 'string' && !/^data:|^assets\//.test(o)) { const t = plain(o); return t ? t.split(' ').length : 0; }
    return 0;
  };
  const len = a => (Array.isArray(a) ? a.length : 0);
  // Zeit je Baustein über das Lesen hinaus (Sekunden)
  const extra = b => {
    const n = k => len(b[k]);
    switch (b.type) {
      case 'quiz': return 45;
      case 'pool': return Math.min(Number(b.draw) || 0, n('questions')) * 45;
      case 'pretest': return n('questions') * 40;
      case 'review': return (Number(b.draw) || 0) * 40;
      case 'glossquiz': return (Number(b.draw) || 0) * (b.mode === 'memory' ? 25 : 15);
      case 'reflection': return 120; case 'actionplan': return 180; case 'survey': return 60; case 'branch': return 40; case 'predict': return 45;
      case 'selfcheck': case 'dialog': return 60 + (b.decision ? 40 : 0);
      case 'vscene': return n('steps') * 30 + (b.decision ? 40 : 0);
      case 'simulation': return n('steps') * 25 * Math.max(1, len(b.modes || ['zeigen', 'ueben', 'pruefen']) - 0.5);
      case 'triage': return n('items') * 18; case 'levers': return 30 + n('sliders') * 15; case 'chat': return n('turns') * 30;
      case 'matrix': return 30 + n('items') * 15; case 'promptbuild': return n('steps') * 20; case 'findtext': return 30 + n('spots') * 15;
      case 'mission': return 60;
      case 'game': return Math.max(60, 180 - words(b.level) / 180 * 60);
      case 'casebank': { const c = n('cases') || 1, g = Math.min(c, Number(b.goal) || c); return g * 150 - words(b) * (1 - g / c) / 180 * 60; }
      case 'sequence': return 20 * n('steps'); case 'process': return 15 * n('steps');
      case 'accordion': case 'tabs': case 'flipcards': return 20 * n('items');
      case 'hotspots': return 15 * n('points'); case 'sortcats': return 12 * n('items'); case 'checklist': return 30; case 'takeaways': return b.recall ? 10 * n('items') : 0;
      case 'ivideo': case 'media': return 0;
      default: return 0;
    }
  };
  const chapters = [];
  let graded = 0, practice = 0;
  (pages || []).forEach((pg, i) => {
    if (!pg || pg.result || pg.extra) return;
    const name = pg.chapter || '';
    let ch = chapters.find(c => c.name === name);
    if (!ch) { ch = { name, pages: [], words: 0, seconds: 0, questions: 0 }; chapters.push(ch); }
    ch.pages.push(i);
    ch.seconds += 10;
    (pg.blocks || []).forEach(b => {
      ch.words += words(b);
      ch.seconds += extra(b);
      if (b.type === 'quiz') { ch.questions++; if (b.graded !== false) graded++; else practice++; }
      if (b.type === 'pool') { const k = Math.min(Number(b.draw) || 0, len(b.questions)); ch.questions += k; if (b.graded !== false) graded += k; else practice += k; }
      if (b.type === 'pretest') { ch.questions += len(b.questions); practice += len(b.questions); }
      if (b.type === 'review') { ch.questions += Number(b.draw) || 0; practice += Number(b.draw) || 0; }
      if (b.type === 'glossquiz' && b.mode === 'match') practice += 1;
      if (['triage', 'levers', 'chat', 'matrix', 'promptbuild', 'findtext'].includes(b.type)) practice += 1;
      if (['simulation', 'mission', 'game'].includes(b.type) && b.graded) graded++;
    });
  });
  chapters.forEach(c => { c.minutes = Math.max(1, Math.round((c.words / 180 * 60 + c.seconds) / 60)); });
  const words_ = chapters.reduce((n, c) => n + c.words, 0);
  return { words: words_, minutes: chapters.reduce((n, c) => n + c.minutes, 0), chapters, graded, practice };
}

function kursPlayer(course, opts) {
  opts = opts || {};
  const root = document.getElementById('app');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const set = course.settings || {};
  const theme = course.theme || {};
  let passScore = Number(course.passScore) || 0;

  // ---------- Sprachen ----------
  // Weitere Sprachen liegen als Übersetzungen (Pfad, Original, Text) in course.languages.
  // Beim Umschalten werden die Texte im Kurs ersetzt; das Original bleibt gemerkt.
  const UI_DE = {
    inhalt: 'Inhalt', mlStatus: 'Abschlussstatus', mlInBearbeitung: 'in Bearbeitung', mlAbgeschlossen: 'abgeschlossen', mlMinuten: 'Minuten geschätzte Lernzeit', mlFortschritt: 'Fortschritt', mlErgebnis: 'Ergebnis', mlWeitere: 'Weitere Informationen', mlMedien: 'Mediennachweis', letzterVersuch: 'Letzter Versuch', besserAls: 'besser als beim letzten Mal', gleichWie: 'wie beim letzten Mal', unterLetztem: 'unter dem letzten Versuch', inFolge: 'richtig in Folge', runde: 'Runde', naechsteRunde: 'Nächste Runde', alleRunden: 'Alle Runden geschafft', vollbild: 'Vollbild', vollbildAus: 'Vollbild beenden', folgeLabel: 'Was daraus wird', nochmalEntscheiden: 'Nochmal entscheiden', fragHilfe: 'Frag {n}', hilfe: 'Hilfe holen', arbeitshilfe: 'Arbeitshilfe öffnen', triBewertung: 'Bewertung durch den Kunden', verlauf: 'Bisheriger Gesprächsverlauf', entscheidung: 'Wie reagierst du?', spielGeschafft: 'Geschafft. Du kannst das Spiel gern noch einmal spielen.', erzaehler: 'Erzähler',
    cbBereiche: 'Bereiche', cbAlle: 'Alle Fälle', cbFall: 'Fall', cbBesprochen: 'Besprochen', cbOffen: 'Noch offen', cbOeffnen: 'Öffnen',
    cbStand: '{n} von {z} nötigen Fällen besprochen · {m} stehen zur Auswahl', cbMl: 'Musterlösung', cbAnekdote: 'Beispiel aus der Praxis',
    cbUeberlegungen: 'Unsere Überlegungen', cbNotieren: 'Diskutieren und notieren', cbNotiert: 'notiert', cbVergleichen: 'Antworten vergleichen',
    cbMc: 'Auswahl vorgegeben', cbGewaehlt: 'gewählt', cbNotizHinweis: 'Gedanken, Argumente und offene Fragen aus der Gruppe …',
    cbNotizGespeichert: 'Wird gespeichert und erscheint in der Sammelansicht der Trainerin oder des Trainers.', cbAuswahl: 'Eine Antwort auswählen',
    cbPasst: 'Passt.', cbNichtGanz: 'Noch nicht ganz.', cbReset: 'Auswahl zurücksetzen', cbEinordnung: 'Fachliche Einordnung und Merksatz',
    cbAngesehen: 'angesehen', cbMerksatz: 'Merksatz', cbZurueck: 'Zurück zur Übersicht', cbSzenario: 'Ausgangslage', cbLeitfrage: 'Leitfrage',
    cbFertig: 'Fertig', cbNaechster: 'Nächster offener Fall', cbImKurs: 'Im Kurs besprochen', cbNichtGewaehlt: 'Nicht ausgewählt',
    cbPassend: 'Passende Antwort', cbGewaehltImKurs: 'Im Kurs gewählt', cbNotizAusKurs: 'Notiz aus dem Kurs', cbDrucken: 'Drucken oder als PDF speichern',
    cbFallarbeit: 'Fallarbeit', cbZiel: 'Bitte besprich zuerst mindestens {z} Fälle.', schliessen: 'Schließen',
    trainer: 'Trainer', trTitel: 'Trainer-Modus', trFreieNotizen: 'Freie Notizen zur Diskussion', trPlatzhalter: 'Notizen aus der Runde … (bleiben in diesem Browser)',
    trKopieren: 'Alles kopieren', trSpeichern: 'Als Textdatei speichern', trKopiert: 'In die Zwischenablage kopiert.', trGespeichert: 'Textdatei gespeichert.',
    trAusKurs: 'Aus dem Kurs übernommen', trLeer: 'Sobald die Gruppe einen Fall bespricht oder eine Reflexion speichert, erscheint es hier.',
    trWerkzeuge: 'Werkzeuge', trLoesen: 'Lösungen zeigen', trLoesenHinweis: 'Setzt alle Fallsammlungen und Fragen auf die richtige Antwort, zum Vorführen oder für die Abnahme.',
    trLoesenFrage: 'Alle Fallsammlungen und Fragen auf die richtige Antwort setzen? Bisherige Antworten werden überschrieben.',
    videoFolgt: 'Video folgt', sprechtext: 'Sprechtext', videoFolgtHinweis: 'Platzhalter: Sobald die Videodatei hinterlegt ist, erscheint hier das Video.',
    werteStand: 'So steht es jetzt', simZeigen: 'Ansehen', simUeben: 'Selbst üben', simPruefen: 'Prüfen', simArt: 'Art der Übung', simSchritt: 'Schritt', simZiel: 'Hier klicken',
    simDaneben: 'Nicht ganz. Schau noch einmal genau hin.', simPruefDaneben: 'Das war nicht die richtige Stelle.', simGezeigt: 'Die richtige Stelle ist jetzt markiert.',
    simStelle: 'Stelle zeigen', simFertig: 'Fertig', simNochmal: 'Noch einmal', simKeinBild: 'Für diesen Schritt fehlt der Screenshot.',
    simGeschafft: 'Geschafft: Du hast alle Schritte selbst ausgeführt.', simGesehen: 'Das war der ganze Ablauf. Jetzt selbst üben?',
    simErgebnis: 'Schritten beim ersten Versuch richtig.', simNochmalUeben: 'Diese Schritte lohnen sich noch einmal:',
    uebersicht: 'Übersicht', zurueck: 'Zurück', weiter: 'Weiter', alsNaechstes: 'Als Nächstes',
    wartePunkte: 'Sieh dir zuerst alle Punkte im Bild an. Danach geht es weiter.',
    warteKarten: 'Entscheide zuerst alle Karten. Danach geht es weiter.',
    warteBausteine: 'Setze zuerst alle Bausteine ein. Danach geht es weiter.',
    warteStellen: 'Finde zuerst alle Stellen im Text. Danach geht es weiter.',
    warteKartenDrehen: 'Dreh zuerst alle Karten um. Danach geht es weiter.',
    warteFrage: 'Beantworte zuerst die Frage. Danach geht es weiter.',
    warteEntscheidung: 'Triff zuerst eine Entscheidung. Danach geht es weiter.',
    warteSelbstcheck: 'Beantworte zuerst den Selbstcheck. Danach geht es weiter.',
    warteSchaetzung: 'Gib zuerst deine Schätzung ab. Danach geht es weiter.',
    warteUebung: 'Bearbeite zuerst die Übung auf dieser Seite. Danach geht es weiter.',
    naechstesKapitel: 'Nächstes Kapitel', lernzeit: 'Lernzeit', minuten: 'Minuten', kapitel: 'Kapitel', starten: 'Starten',
    fortsetzen: 'Fortsetzen', nochmal: 'Noch einmal ansehen', erledigt: 'Erledigt', offen: 'Offen', inArbeit: 'In Arbeit', gesperrt: 'Noch gesperrt',
    ftFertig: 'Alle gefunden', ftGefunden: 'Nicht belegt', ftBelegt: 'Das steht so in den Unterlagen', ftLos: 'Lies genau',
    ftHinweis: 'Tippe die Stellen an, die über das Belegte hinausgehen.', ftGefundenZahl: 'gefunden',
    pbStart: 'Ausgangspunkt', pbEntwurf: 'Erster Entwurf der KI', pbGuete: 'Güte der Anfrage', pbLeer: 'Tippe einen Baustein an.',
    triJa: 'Kommt mit', triNein: 'Bleibt draußen', triFrage: 'Was machst du damit?', triGewaehlt: 'Ausgewählt',
    triPasst: 'Passt', triSchauNochmal: 'Schau noch einmal', triFertig: 'Alle durch', triRichtig: 'richtig',
    triRichtigWaere: 'Richtig wäre:', triNachlesen: 'Die richtige Seite steht jetzt an den Karten.',
    triLeer: 'Noch keine Karten.', nochEinmal: 'Noch einmal', von: 'von',
    clStand: '{n} von {z} erledigt', clAlle: 'Alles erledigt: {z} von {z}', nochmalVersuchen: 'Versuch es noch einmal.',
    szene: 'Szene', abspielen: 'Abspielen', pause: 'Pause', naechsteZeile: 'Nächste Zeile', vollbild: 'Vollbild', ende: 'Ende', nochmalAnsehen: 'Noch einmal ansehen',
    antwortPruefen: 'Antwort prüfen', anhoeren: 'Anhören', sprache: 'Sprache', zumInhalt: 'Zum Inhalt springen',
    untertitel: 'Untertitel', toneinstellungen: 'Ton einstellen', lautstaerke: 'Lautstärke', tempo: 'Tempo',
    zuordnenHinweis: 'Zieh die Kärtchen auf den passenden Begriff. Mit der Tastatur: Kärtchen anwählen und die Nummer des Begriffs drücken.',
    begriffeLernen: 'Begriffe lernen', keineBegriffe: 'Noch keine Begriffe hinterlegt.', alleRichtig: 'Alle Begriffe richtig zugeordnet.', nochNichtAlle: 'Noch nicht alle richtig. Die richtigen Zuordnungen stehen jetzt daneben.',
    memoryHinweis: 'Deck zwei Karten auf. Gehört die Bedeutung zum Begriff, bleiben beide offen.', karteVerdeckt: 'Verdeckte Karte', paareGefunden: 'Paaren gefunden', zuege: 'Züge',
    memoryFertig: 'Alle Paare gefunden.', nochmalSpielen: 'Noch einmal',
    willkommenZurueck: 'Willkommen zurück!', zuletztAuf: 'Du warst zuletzt auf Seite', dortWeitermachen: 'Dort weitermachen', vonVorn: 'Von vorn beginnen',
    warumFrage: 'Warum? Schreib deine Begründung in einem Satz, bevor du auflöst.', warumPlatz: 'Weil …', warumFehlt: 'Bitte begründe zuerst kurz deine Wahl.',
    deineBegruendung: 'Deine Begründung', musterBegruendung: 'Begründung im Kurs', begruendungSpeichern: 'Begründung speichern und auflösen',
    aufdecken: 'Aufdecken', aufdeckenHinweis: 'Überleg zuerst, was hinter jeder Aussage steckt. Dann deck sie auf.', aufgedeckt: '{n} von {z} aufgedeckt',
    deinVorsatz: 'Dein Vorsatz', kalenderKnopf: 'Wiederholung in den Kalender', kalenderHinweis: 'Drei kurze Termine: morgen, in einer Woche, in einem Monat. Fünf Minuten genügen.',
    kalenderTitel: 'Wiederholung: {k}', kalenderText: 'Fünf Minuten: Was war der Kern? Was habe ich seitdem davon umgesetzt?', kalenderFragen: 'Drei Fragen zum Abrufen, erst antworten, dann im Kurs nachsehen:',
    kurzWiederholen: 'Kurz wiederholen', kurzWiederholenHinweis: 'Ein paar Fragen aus dem, was du schon gelernt hast. Sie zählen nicht zur Bewertung – Wiederholen mit Abstand hilft dem Behalten.',
    allesZugeordnet: 'Alles zugeordnet', nichtZugeordnet: 'Nichts zugeordnet',
    notizen: 'Notizen', glossar: 'Glossar', ergebnis: 'Ergebnis', abgeschlossen: 'abgeschlossen', ca: 'ca.', min: 'Min',
    zumVergleich: 'Zum Vergleich:', kritTitel: 'Deine Antwort im Vergleich', kritHinweis: 'Lies die Musterantwort und hake ab, was deine Antwort erfüllt.', kritErfuellt: 'Kriterien erfüllt', kritAlle: 'Alle Kriterien erfüllt – gut gemacht.',
    hallo: 'Hallo', willkommenZurueckName: 'Willkommen zurück, {n}!', msAlleKapitel: 'Das war das letzte Kapitel. Jetzt noch der Abschluss.',
    wieWeiter: 'Wie geht es weiter?', kursOeffnen: 'Kurs öffnen',
    deinErgebnis: 'Dein Ergebnis', bestanden: 'Bestanden, herzlichen Glückwunsch!', bestandenName: 'Bestanden, herzlichen Glückwunsch, {n}!', nichtBestanden: 'Leider nicht bestanden.',
    geschafftTitel: 'Das hast du geschafft', seitenGesehen: 'Seiten gesehen', kapitelFertig: 'Kapitel abgeschlossen', fragenRichtig: 'Fragen richtig', uebungenErledigt: 'Übungen erledigt',
    ergebnisJeLernziel: 'Ergebnis je Lernziel', richtig: 'richtig', sitzt: 'Sitzt', zumKapitel: 'Zum Kapitel', nochmalAnsehen: 'Dazu noch einmal ansehen',
    transkript: 'Transkript', szene: 'Szene', schritt: 'Schritt', von: 'von', herunterladen: 'Herunterladen',
    suchen: 'Suchen', suchHinweis: 'Gib mindestens zwei Zeichen ein.', keineTreffer: 'Keine Treffer.',
    abspielen: 'Abspielen', pause: 'Pause', allesZeigen: 'Alles zeigen', deineSchaetzung: 'Deine Schätzung', tatsaechlich: 'Tatsächlich', amAnfang: 'Am Anfang', heute: 'Heute', deineVermutung: 'Deine Vermutung',
    entdeckt: 'entdeckt', fuehrungStarten: 'Führung starten', naechsterPunkt: 'Nächster Punkt',
    oeffnen: 'öffnen', besucht: 'schon besucht', gefunden: 'gefunden', nochOffen: 'noch offen', fundstueck: 'Fundstück',
    stopp: 'Stopp', kiHinweis: 'Hinweis zu künstlicher Intelligenz:', kiMarke: 'KI-unterstützt', kiBild: 'Mit KI erzeugt', kiStimme: 'Vorgelesen von einer synthetischen Stimme',
    levErgebnis: 'Ergebnis', levHinweis: 'Bewege jeden Regler einmal und beobachte, was sich ändert.', warteRegler: 'Bewege zuerst jeden Regler einmal.',
    chatWaehle: 'Was antwortest du?', chatNochmal: 'Wähle eine andere Antwort.', chatEnde: 'Das Gespräch ist beendet.', warteChat: 'Führe zuerst das Gespräch zu Ende.',
    mxHierAblegen: 'Hier ablegen', mxVergleich: 'Deine Einordnung im Vergleich', mxDeine: 'deine Einordnung', mxExperte: 'Einschätzung', mxNah: 'nah dran', mxGleichesFeld: 'gleiches Feld',
    mxAnderesFeld: 'anderes Feld', mxAbgelegt: 'eingeordnet', mxHilfe: 'Wähle einen Begriff und klicke dann in die Fläche, dorthin, wo er für dich hingehört.', mxVergleichen: 'Mit der Einschätzung vergleichen', warteMatrix: 'Ordne zuerst alle Begriffe ein und vergleiche.',
    bereichSicher: 'Mit {p} % Sicherheit liegt der Wert zwischen …', bereichVon: 'von', bereichBis: 'bis', bereichDrin: 'Getroffen. Der wahre Wert liegt in deinem Bereich.', bereichDaneben: 'Daneben. Der wahre Wert liegt außerhalb deines Bereichs.',
    deinBereich: 'Dein Bereich', bereichKalib: 'Bisher lag der wahre Wert bei {h} von {n} Schätzungen in deinem Bereich. Bei {p} % Sicherheit wären es fast alle. Weniger heißt, du schätzt dich sicherer ein, als du bist.',
    rwTitel: 'Umschreiben', rwVorher: 'Vorher', rwDeine: 'Deine Fassung', rwMuster: 'Musterfassung'
  };
  const langs = course.languages || [];
  const langOriginals = {};
  let langUi = {};
  const T = k => langUi[k] || UI_DE[k] || k;
  const getP = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  const setP = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); const t = ks.reduce((x, k) => (x == null ? x : x[k]), o); if (t != null) t[last] = v; };
  function applyLang(code) {
    Object.keys(langOriginals).forEach(k => setP(course, k, langOriginals[k]));
    Object.keys(narrCues).forEach(k => delete narrCues[k]); // Untertitel neu einlesen
    const L = langs.find(l => l.code === code);
    (L ? L.entries || [] : []).forEach(e => {
      const cur = getP(course, e.key);
      if (typeof cur !== 'string' || cur !== e.orig || !e.text) return;
      langOriginals[e.key] = cur;
      setP(course, e.key, e.text);
    });
    langUi = (L && L.ui) || {};
    document.documentElement.lang = L ? code : (course.lang || 'de');
    return L ? code : '';
  }
  const t0 = Date.now();

  // ---------- Design ----------
  // opts.renderer: nur den Baukasten liefern (für die Code-Ansicht im Editor), nichts ins Dokument schreiben
  if (!opts.renderer) {
    const rootStyle = document.documentElement.style;
    if (theme.primary) rootStyle.setProperty('--kp-primary', theme.primary);
    if (theme.accent) rootStyle.setProperty('--kp-accent', theme.accent);
    // Im dunklen Modus kommen Flächen und Schrift aus dem Stylesheet, sonst aus dem Kurs
    if (theme.mode !== 'dunkel') {
      if (theme.bg) rootStyle.setProperty('--kp-bg', theme.bg);
      if (theme.text) rootStyle.setProperty('--kp-text', theme.text);
    }
    if (theme.font) rootStyle.setProperty('--kp-font', theme.font);
    if (theme.radius != null) rootStyle.setProperty('--kp-radius', theme.radius + 'px');
    if (theme.headingFont) rootStyle.setProperty('--kp-font-head', theme.headingFont);
    // Lesebreite, Schriftgröße und Dichte als Stellschrauben des Layouts
    // Breite wie eine Folie: der Inhalt fuellt den Bildschirm, links und rechts bleiben nur 32 px Rand (Grundregel von Kerstin)
    rootStyle.setProperty('--kp-maxw', ({ schmal: 'min(1180px, calc(var(--kp-half, 50vw) * 2))', normal: 'min(1400px, calc(var(--kp-half, 50vw) * 2))', breit: 'min(1600px, calc(var(--kp-half, 50vw) * 2))' })[theme.width || 'normal'] || 'min(1400px, calc(var(--kp-half, 50vw) * 2))');
    rootStyle.setProperty('--kp-fs', ({ klein: '16px', normal: '17px', gross: '19px' })[theme.scale || 'normal'] || '17px');
    // Abstandsskala auf dem 8-px-Raster: --kp-gap zwischen Bausteinen (Seitenmodus) und in Reihen, --kp-gap-scroll in der Scroll-Darstellung, --kp-pad innen in farbigen Abschnitten
    rootStyle.setProperty('--kp-gap', ({ kompakt: '16px', normal: '24px', luftig: '32px' })[theme.density || 'normal'] || '24px');
    rootStyle.setProperty('--kp-gap-scroll', ({ kompakt: '24px', normal: '32px', luftig: '40px' })[theme.density || 'normal'] || '32px');
    rootStyle.setProperty('--kp-pad', ({ kompakt: '24px', normal: '32px', luftig: '40px' })[theme.density || 'normal'] || '32px');
    if (theme.mode === 'dunkel') document.documentElement.classList.add('kp-dark');
    // Kleine Schrift in der Akzentfarbe (Themenzeilen) braucht 4,5 : 1 Kontrast: bei Bedarf automatisch abdunkeln
    const hex = h => { const m = String(h || '').replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i); return m ? m.slice(1).map(x => parseInt(x, 16)) : null; };
    const lum = c => { const v = c.map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    let ink = hex(theme.accent);
    const dark = theme.mode === 'dunkel';
    const ground = dark ? [[15, 20, 27], [23, 30, 39]] : [hex(theme.bg) || [245, 246, 248], [255, 255, 255]];
    if (ink) {
      // Im hellen Design abdunkeln, im dunklen aufhellen, bis 4,5 : 1 erreicht ist
      for (let k = 0; k < 24 && ground.some(g => ratio(ink, g) < 4.5); k++) {
        ink = dark ? ink.map(x => Math.min(255, Math.round(x * 1.12) + 6)) : ink.map(x => Math.round(x * 0.9));
      }
      rootStyle.setProperty('--kp-accent-ink', `rgb(${ink.join(',')})`);
      // Schrift AUF der Akzentfarbe: Weiss auf einem hellen Akzent (#2EE6A8) erreicht nur
      // 1,6 : 1. Ist Dunkel der bessere Partner, kommt Dunkel.
      const acc = hex(theme.accent);
      if (acc) rootStyle.setProperty('--kp-on-accent', ratio(acc, [255, 255, 255]) >= ratio(acc, [4, 17, 31]) ? '#fff' : '#04111f');
    }
    // Stil-Paket und Darstellung als Klassen, damit das CSS darauf reagieren kann
    document.documentElement.classList.add('kp-style-' + (theme.style || 'klar'));
    if (theme.look !== 'klassisch') document.documentElement.classList.add('kp-modern');
    // Effekte „hochwertig“ ist der Standard; „dezent“ lässt nur die Grundbewegungen
    if (theme.effects !== 'dezent') document.documentElement.classList.add('kp-fx-premium');
    if (set.layout === 'scroll') document.documentElement.classList.add('kp-layout-scroll');
  }
  const assetMap = {};
  (course.assets || []).forEach(a => { assetMap['assets/' + a.name] = a.src; });
  // Verweise wie "assets/logo.png" in HTML und CSS auf die hinterlegten Dateien umbiegen
  const res = s => String(s || '').replace(/assets\/[\w.\-]+/g, m => assetMap[m] || m);
  // Eigene Kopf- und Fußzeile (leer = Standard); das globale CSS steht danach und kann alles überschreiben
  const chrome = course.chrome || {};
  // Lage der Leiste: oben (Standard), unten oder links. Farben leer = Farben des Designs.
  const navPos = ['oben', 'unten', 'links'].indexOf(chrome.navPos) >= 0 ? chrome.navPos : 'oben';
  if (!opts.renderer) {
    if (navPos !== 'oben') document.documentElement.classList.add('kp-nav-' + navPos);
    const ns = document.documentElement.style;
    if (chrome.navColor) ns.setProperty('--kp-nav-bg', chrome.navColor);
    // Ohne eigene Schriftfarbe richtet sie sich nach der Helligkeit der Leistenfarbe
    if (chrome.navInk) ns.setProperty('--kp-nav-ink', chrome.navInk);
    else if (chrome.navColor) ns.setProperty('--kp-nav-ink', navInkFor(chrome.navColor));
  }
  const globalStyle = document.createElement('style');
  globalStyle.textContent = res(chrome.css) + '\n' + res(course.css);
  const pageStyle = document.createElement('style');
  if (!opts.renderer) {
    document.head.appendChild(globalStyle);
    document.head.appendChild(pageStyle);
  }
  // Blöcke mit eigenem HTML (vom Formular gelöst)
  const isCustom = b => b.type !== 'html' && !!(b.customHtml && String(b.customHtml).trim());
  const htmlOf = b => (isCustom(b) ? b.customHtml : b.type === 'html' ? b.html : '');

  // Dunkle Schrift auf heller Leiste, helle auf dunkler (relative Helligkeit nach WCAG)
  function navInkFor(color) {
    const m = String(color).replace('#', '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return '#ffffff';
    const h = m[1].length === 3 ? m[1].split('').map(x => x + x).join('') : m[1];
    const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
      .map(x => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.32 ? '#1d2530' : '#ffffff';
  }

  // CSS eines Blocks gilt nur innerhalb dieses Blocks
  function scopeCss(css, scope) {
    return String(css || '').replace(/([^{}]+)\{([^{}]*)\}/g, (m, sel, body) => {
      const s = sel.trim();
      if (!s || s.startsWith('@') || /^(from|to|\d+%)/.test(s)) return m;
      return s.split(',').map(x => `${scope} ${x.trim()}`).join(', ') + ' {' + body + '}';
    });
  }

  // ---------- Zustand ----------
  const pages = course.pages.slice();
  const state = {
    current: 0, visited: new Set(), answers: {}, tries: {}, pools: {}, branch: {},
    conf: {}, texts: {}, survey: {}, history: [], name: '', seen: {}, took: {}, cross: {},
    watched: {}, dlg: {}, seq: {}, self: {}
  };
  const lms = kursLms(opts);
  let finished = false;

  // ---------- Hilfen ----------
  function shuffleIds(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function allQuestionsBefore(pageIndex, chapter) {
    const list = [];
    pages.forEach((p, pi) => {
      if (chapter ? p.chapter !== chapter : pi >= pageIndex) return;
      (p.blocks || []).forEach(b => {
        if (b.type === 'quiz') list.push(b);
        if (b.type === 'pool') list.push(...(b.questions || []));
      });
    });
    return list;
  }

  // Fragenpools und Wiederholungen: Auswahl einmal ziehen und merken
  function drawPools(force) {
    pages.forEach((p, pi) => (p.blocks || []).forEach(b => {
      if (!force && state.pools[b.id]) return;
      if (b.type === 'pool') {
        const all = (b.questions || []);
        const n = Math.max(1, Math.min(Number(b.draw) || all.length, all.length));
        // Pflichtfragen kommen immer dran, der Rest wird aus den übrigen gezogen
        const fixed = all.map((q, i) => i).filter(i => all[i].fixed).slice(0, n);
        const rest = shuffleIds(all.map((q, i) => i).filter(i => !all[i].fixed));
        state.pools[b.id] = fixed.concat(rest.slice(0, Math.max(0, n - fixed.length))).sort((x, y) => x - y);
      }
      if (b.type === 'sortcats' && !state.pools['sort-' + b.id]) state.pools['sort-' + b.id] = shuffleIds((b.items || []).map((x, i) => i));
      if (b.type === 'glossquiz') {
        const all = termPairs(b);
        const n = Math.max(1, Math.min(Number(b.draw) || all.length, all.length));
        state.pools[b.id] = shuffleIds(all.map((x, i) => i)).slice(0, n);
      }
      // Wiederholungen werden erst gezogen, wenn die Seite erreicht wird (drawReviews): dann liegen die Antworten
      // vor, und zuletzt falsch beantwortete Fragen kommen zuerst dran
    }));
  }
  // Fragen nach Nutzen für die Wiederholung sortieren: zuletzt falsch beantwortete zuerst, dann die noch offenen,
  // zuletzt die richtig beantworteten – innerhalb jeder Gruppe gemischt. Für Wiederholung und Wiedereinstieg.
  function wrongFirst(qs, answeredFirst) {
    const rank = q => {
      const a = state.answers[q.id];
      if (a == null) return answeredFirst ? 2 : 1;
      return evaluate(q, a) < 1 ? 0 : answeredFirst ? 1 : 2;
    };
    const groups = [[], [], []];
    qs.forEach(q => groups[rank(q)].push(q));
    return groups.map(g => shuffleIds(g)).flat();
  }
  function drawReviews(pi) {
    let drawn = false;
    (pages[pi].blocks || []).forEach(b => {
      if (b.type !== 'review' || state.pools[b.id]) return;
      const cand = allQuestionsBefore(pi, b.scope === 'chapter' ? b.chapter : '');
      state.pools[b.id] = wrongFirst(cand, false).map(q => q.id).slice(0, Math.max(1, Number(b.draw) || 3));
      drawn = true;
    });
    return drawn;
  }

  // Wiederholungsfragen sind Kopien mit eigener ID, damit sie unabhängig vom Original beantwortet werden
  const reviewCopies = {};
  function reviewQuestions(b) {
    const byId = {};
    pages.forEach(p => (p.blocks || []).forEach(x => {
      if (x.type === 'quiz') byId[x.id] = x;
      if (x.type === 'pool') (x.questions || []).forEach(q => { byId[q.id] = q; });
    }));
    return (state.pools[b.id] || []).map(id => {
      const key = id + '~' + b.id;
      if (!reviewCopies[key] && byId[id]) reviewCopies[key] = Object.assign({}, byId[id], { id: key, attempts: 0 });
      return reviewCopies[key];
    }).filter(Boolean);
  }

  // Alle Fragen und bewerteten Elemente des Kurses einsammeln
  let items = [];
  function buildItems() {
    const list = [];
    const add = (pi, q, graded, extra) => list.push(Object.assign({ id: q.id, pageIndex: pi, q, graded, points: Number(q.points) || 10, objective: q.objective || '' }, extra || {}));
    pages.forEach((p, pi) => (p.blocks || []).forEach(b => {
      if (b.type === 'html' || isCustom(b)) return addHtmlQuiz(list, pi, b);
      if (b.type === 'quiz') add(pi, b, b.graded !== false);
      if (b.type === 'pool') (state.pools[b.id] || []).forEach(i => { if (b.questions[i]) add(pi, b.questions[i], b.graded !== false); });
      if (b.type === 'pretest') (b.questions || []).forEach(q => add(pi, q, false, { pretest: b.id }));
      if (b.type === 'review') reviewQuestions(b).forEach(q => add(pi, q, false));
      if (b.type === 'glossquiz' && b.mode === 'match' && drawnPairs(b).length) add(pi, glossQuiz(b), false);
      if (b.type === 'ivideo') (b.markers || []).forEach(m => { if (m.kind === 'question' && m.q) add(pi, m.q, m.q.graded !== false); });
      // Klickpfad (Stufe „prüfen“), Mini-Mission und Level-Spiel zählen nur mit b.graded
      if (b.graded && (b.type === 'mission' || b.type === 'game' || (b.type === 'simulation' && (b.modes || ['zeigen', 'ueben', 'pruefen']).includes('pruefen'))))
        list.push({ id: b.id, pageIndex: pi, play: b, graded: true, points: Number(b.points) || 10, objective: b.objective || '' });
    }));
    // Entscheidungen (auch am Ende eines Comic-Dialogs) mit Punkten
    pages.forEach((p, pi) => branchesIn(p).forEach(br => {
      if (!br.scored) return;
      const max = Math.max(0, ...(br.options || []).map(o => Number(o.points) || 0));
      if (max > 0) list.push({ id: br.id, pageIndex: pi, branch: br, graded: true, points: max, objective: br.objective || '' });
    }));
    items = list;
  }
  // Fragen, die als HTML vorliegen (HTML-Block oder Block mit eigenem HTML)
  function addHtmlQuiz(list, pi, b) {
    const src = htmlOf(b);
    if (!/data-kurs-quiz/.test(src)) return;
    const doc = new DOMParser().parseFromString('<div>' + src + '</div>', 'text/html');
    doc.querySelectorAll('[data-kurs-quiz]').forEach((el, qi) => {
      const answers = Array.from(el.querySelectorAll('[data-kurs-antwort]'));
      list.push({
        id: b.id + ':' + qi, pageIndex: pi,
        graded: !/^(nein|false|0)$/i.test(el.getAttribute('data-kurs-bewertet') || ''),
        points: Number(el.getAttribute('data-kurs-punkte')) || 10, objective: el.getAttribute('data-kurs-lernziel') || '',
        html: {
          kind: el.getAttribute('data-kurs-quiz') === 'multiple' ? 'multiple' : 'single',
          right: answers.map((a, i) => /^(richtig|true|1|ja)$/i.test(a.getAttribute('data-kurs-antwort')) ? i : -1).filter(i => i >= 0)
        }
      });
    });
  }
  const graded = () => items.filter(it => it.graded);
  const pageIndexById = id => pages.findIndex(p => p.id === id);

  // ---------- Auswertung ----------
  function normAnswers(q) {
    if (q.kind === 'truefalse') {
      const yes = q.correctBool !== false;
      return [{ text: q.labelTrue || 'Wahr', correct: yes, feedback: q.feedbackTrue }, { text: q.labelFalse || 'Falsch', correct: !yes, feedback: q.feedbackFalse }];
    }
    return q.answers || [];
  }
  function fillSolutions(q) {
    return (String(q.text || '').match(/\[\[(.+?)\]\]/g) || []).map(m => m.slice(2, -2).split('|').map(s => s.trim()));
  }
  const normStr = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  function shuffled(n, seed) {
    const arr = Array.from({ length: n }, (v, i) => i);
    let s = String(seed).split('').reduce((a, c) => a + c.charCodeAt(0) * 31, 7);
    for (let i = arr.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const j = s % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    if (n > 1 && arr.every((v, i) => v === i)) arr.push(arr.shift());
    return arr;
  }

  function evaluate(q, a) {
    if (!a) return 0;
    if (q.kind === 'fill') {
      const sol = fillSolutions(q);
      return sol.length ? sol.filter((alts, i) => alts.some(s => normStr(s) === normStr(a[i]))).length / sol.length : 0;
    }
    if (q.kind === 'order') { const n = (q.items || []).length; return n ? a.filter((v, i) => v === i).length / n : 0; }
    if (q.kind === 'match') { const n = (q.pairs || []).length; return n ? a.filter((v, i) => v === i).length / n : 0; }
    if (q.kind === 'hotspot') return (q.spots || []).some(s => s.correct && Math.hypot(s.x - a[0], s.y - a[1]) <= (Number(s.r) || 8)) ? 1 : 0;
    const right = normAnswers(q).map((x, i) => x.correct ? i : -1).filter(i => i >= 0);
    return right.length === a.length && right.every(i => a.indexOf(i) >= 0) ? 1 : 0;
  }

  // Übungen mit Spielcharakter: Klickpfad = Anteil richtiger Schritte im besten Prüfdurchgang;
  // Mission und Level-Spiel = volle Punkte bei höchstens einem Fehler, halbe bei mehr, keine bei „Lösung zeigen“ oder Überspringen
  function playFraction(b) {
    if (b.type === 'simulation') { const st = state.self[b.id]; return st && st.exam != null ? st.exam : null; }
    const r = (state.self.mm || {})[b.id];
    if (!r) return null;
    if (!r.ok || r.r || r.k) return 0;
    return r.e <= 1 ? 1 : 0.5;
  }
  function itemFraction(it) {
    if (it.play) return playFraction(it.play);
    if (it.branch) {
      const c = state.branch[it.id];
      if (c == null) return null;
      return (Number((it.branch.options[c] || {}).points) || 0) / it.points;
    }
    const a = state.answers[it.id];
    if (!a) return null;
    if (it.q) return evaluate(it.q, a);
    const r = it.html.right;
    return r.length === a.length && r.every(i => a.indexOf(i) >= 0) ? 1 : 0;
  }

  function scoreOf(list) {
    let got = 0, max = 0, open = 0;
    list.forEach(it => {
      max += it.points;
      const f = itemFraction(it);
      if (f == null) open++; else got += f * it.points;
    });
    return { got: Math.round(got * 10) / 10, max, open, pct: max ? Math.round(got / max * 100) : 0 };
  }
  const score = () => scoreOf(graded());

  function objectiveStats() {
    return (course.objectives || []).map(o => {
      const list = graded().filter(it => it.objective === o.id);
      if (!list.length) return null;
      const s = scoreOf(list);
      const right = list.filter(it => itemFraction(it) >= 1).length;
      return { o, pct: s.open ? null : s.pct, open: s.open, passed: !s.open && s.pct >= passScore, firstPage: Math.min(...list.map(it => it.pageIndex)), right, total: list.length };
    }).filter(Boolean);
  }

  // Status für das LMS: abgeschlossen (Inhalt) und bestanden (Test) getrennt ermitteln
  function progressResult() {
    const contentIdx = pages.map((p, i) => p.result || p.extra ? -1 : i).filter(i => i >= 0);
    const seen = contentIdx.filter(i => state.visited.has(i)).length;
    const pagesPct = contentIdx.length ? seen / contentIdx.length * 100 : 100;
    const visitedLast = state.visited.has(contentIdx[contentIdx.length - 1]) || state.visited.has(pages.length - 1);
    const mode = set.completion || 'auto';
    const hasTest = graded().length > 0;
    const s = score();
    const testDone = hasTest && !s.open;
    const passed = testDone && s.pct >= passScore;
    const pagesDone = /percent/.test(mode) ? pagesPct >= (Number(set.completionPercent) || 100) : visitedLast;
    let completed;
    if (mode === 'test') completed = passed;
    else if (mode === 'percent+test') completed = pagesDone && passed;
    else if (mode === 'auto') completed = hasTest ? testDone : pagesDone;
    else completed = pagesDone;
    const useSuccess = hasTest && (mode === 'auto' || mode === 'test' || mode === 'percent+test');
    return { completed, pagesDone, hasTest, testDone, passed, pct: testDone ? s.pct : null, useSuccess };
  }

  // Ist auf der Seite noch etwas offen?
  function openReason(i) {
    const p = pages[i];
    const hid = condHiddenIds(p); // durch eine Bedingung verborgen: hält nicht auf
    if (items.some(it => it.pageIndex === i && !it.branch && !it.play && !hid.has(it.id) && state.answers[it.id] == null)) return 'Bitte beantworte zuerst die Fragen auf dieser Seite.';
    if (items.some(it => it.pageIndex === i && it.play && !hid.has(it.id) && playFraction(it.play) == null)) return 'Bitte schließe zuerst die Übung auf dieser Seite ab.';
    for (const br of branchesIn(p)) {
      if (!hid.has(br.id) && ((br.options || []).some(o => o.target) || br.scored) && state.branch[br.id] == null) return 'Bitte triff zuerst eine Entscheidung.';
    }
    // Ein Abschnitt, der erst nach einer Übung erscheint, hält auf, bis diese Übung gemacht ist –
    // sonst käme man an dem verborgenen Teil vorbei, ohne ihn je gesehen zu haben.
    for (const b of (p.blocks || [])) {
      const c = b.showIf;
      if (!c || c.kind !== 'done') continue;
      const ref = (p.blocks || []).find(x => x.id === c.ref);
      if (ref && !hid.has(ref.id) && !blockDone(ref)) return waitReason(ref);
    }
    for (const b of (p.blocks || []).filter(x => !hid.has(x.id))) {
      // „Weiter erst, wenn bearbeitet“ – gilt für jeden Baustein mit etwas zu tun
      if (b.required && !['reflection', 'actionplan', 'mission', 'game', 'casebank'].includes(b.type) && !blockDone(b)) return waitReason(b);
      if ((b.type === 'reflection' || b.type === 'actionplan') && b.required && state.texts[b.id] == null) return 'Bitte bearbeite zuerst die Aufgabe auf dieser Seite.';
      if (b.type === 'ivideo' && b.requireWatch && !state.watched[b.id]) return 'Bitte sieh dir zuerst das Video bis zum Ende an.';
      if (b.type === 'mission' && b.skippable === false && !(state.self.mm || {})[b.id]) return 'Bitte schließe zuerst die Mini-Mission auf dieser Seite ab.';
      if (b.type === 'game' && b.required && !(state.self.mm || {})[b.id]) return 'Bitte spiele zuerst das Level-Spiel auf dieser Seite zu Ende.';
      if (b.type === 'casebank' && b.required && cbDoneCount(b) < cbGoal(b)) return T('cbZiel').replace('{z}', cbGoal(b));
    }
    return '';
  }
  // Was genau noch fehlt – je Übung ein eigener Satz, damit niemand raten muss
  function waitReason(b) {
    const t = b.type;
    if (t === 'hotspots') return T('wartePunkte');
    if (t === 'triage') return T('warteKarten');
    if (t === 'promptbuild') return T('warteBausteine');
    if (t === 'findtext') return T('warteStellen');
    if (t === 'flipcards' || (t === 'glossquiz' && b.mode !== 'match')) return T('warteKartenDrehen');
    if (t === 'quiz' || t === 'pool' || t === 'pretest') return T('warteFrage');
    if (t === 'branch' || t === 'dialog') return T('warteEntscheidung');
    if (t === 'selfcheck') return T('warteSelbstcheck');
    if (t === 'predict') return T('warteSchaetzung');
    if (t === 'levers') return T('warteRegler');
    if (t === 'chat') return T('warteChat');
    if (t === 'matrix') return T('warteMatrix');
    return T('warteUebung');
  }
  function blockedHere() {
    if (state.current >= pages.length - 1) return '';
    const reason = openReason(state.current);
    if (!reason) return '';
    const p = pages[state.current];
    const hardStop = branchesIn(p).some(br => (br.options || []).some(o => o.target)) ||
      (p.blocks || []).some(b => ((b.type === 'reflection' || b.type === 'actionplan') && b.required) || (b.type === 'ivideo' && b.requireWatch) || (b.type === 'mission' && b.skippable === false) || (b.type === 'game' && b.required) || (b.type === 'casebank' && b.required) ||
        b.required || (b.showIf && b.showIf.kind === 'done'));
    return set.gating || hardStop ? reason : '';
  }
  // Entscheidungen einer Seite: Entscheidungs-Blöcke und Entscheidungen am Ende eines Comic-Dialogs
  function branchesIn(p) {
    const list = [];
    (p.blocks || []).forEach(b => {
      if (b.type === 'branch') list.push(b);
      if (b.type === 'dialog' && b.decision && (b.decision.options || []).length) list.push(b.decision);
    });
    return list;
  }
  function unlockedUpTo() {
    if (!set.gating) return pages.length - 1;
    let i = 0;
    while (i < pages.length - 1 && state.visited.has(i) && !openReason(i)) i++;
    return i;
  }
  function nextIndex() {
    const p = pages[state.current];
    for (const br of branchesIn(p)) {
      if (state.branch[br.id] != null) {
        const t = pageIndexById((br.options[state.branch[br.id]] || {}).target);
        if (t >= 0) return t;
      }
    }
    const t = pageIndexById(p.next);
    return t >= 0 ? t : state.current + 1;
  }

  // ---------- Meldung an das LMS ----------
  function suspendString() {
    const data = { v: Array.from(state.visited), a: state.answers, t: state.tries, p: state.pools, b: state.branch, c: state.conf, s: state.survey, x: state.texts, w: state.watched, k: state.self, l: state.lang || '' };
    let json = JSON.stringify(data);
    const limit = lms ? lms.suspendLimit : 4000;
    // Bei SCORM 1.2 wird es eng: freie Texte liegen dann nur im Browser, Umfrage und Sicherheit zuletzt
    if (json.length > limit) { delete data.x; json = JSON.stringify(data); }
    if (json.length > limit) { delete data.s; delete data.c; json = JSON.stringify(data); }
    return json;
  }

  function responseOf(it, std) {
    const L = i => String.fromCharCode(97 + i);
    const sep = std === '2004' ? '[,]' : ',';
    const dot = std === '2004' ? '[.]' : '.';
    // Klickpfad, Mission, Level-Spiel: Ergebnis in Prozent als Zahl
    if (it.play) return { type: 'numeric', response: String(Math.round((playFraction(it.play) || 0) * 100)), pattern: '100' };
    const a = it.branch ? [state.branch[it.id]] : state.answers[it.id];
    if (it.branch) {
      const best = it.branch.options.reduce((bi, o, i, arr) => (Number(o.points) || 0) > (Number(arr[bi].points) || 0) ? i : bi, 0);
      return { type: 'choice', response: L(a[0]), pattern: L(best) };
    }
    if (it.html) return { type: 'choice', response: a.map(L).join(sep), pattern: it.html.right.map(L).join(sep) };
    const q = it.q;
    switch (q.kind) {
      case 'truefalse': {
        const tf = v => std === '2004' ? (v ? 'true' : 'false') : (v ? 't' : 'f');
        return { type: 'true-false', response: tf(a[0] === 0), pattern: tf(q.correctBool !== false) };
      }
      case 'fill': return { type: 'fill-in', response: a.join(' | '), pattern: fillSolutions(q).map(s => s[0]).join(' | ') };
      case 'order': return { type: 'sequencing', response: a.map(L).join(sep), pattern: (q.items || []).map((x, i) => L(i)).join(sep) };
      case 'match': return { type: 'matching', response: a.map((r, i) => (i + 1) + dot + (r >= 0 ? L(r) : '-')).join(sep), pattern: (q.pairs || []).map((x, i) => (i + 1) + dot + L(i)).join(sep) };
      case 'hotspot': return { type: 'performance', response: a.join(std === '2004' ? '[.]' : ','), pattern: null };
      default: return { type: 'choice', response: a.map(L).join(sep), pattern: normAnswers(q).map((x, i) => x.correct ? L(i) : null).filter(Boolean).join(sep) };
    }
  }

  function report() {
    if (!lms || finished) return;
    try {
      lms.save(state.current, suspendString());
      lms.result(progressResult());
      lms.time((Date.now() - t0) / 1000);
      let n = 0;
      graded().forEach(it => {
        const f = itemFraction(it);
        if (f == null) return;
        const d = responseOf(it, lms.standard);
        lms.interaction(n++, Object.assign(d, { id: it.id, result: f >= 1 ? 'correct' : 'wrong', weighting: it.points, latency: state.took[it.id] }));
      });
      pages.forEach(p => (p.blocks || []).forEach(b => {
        if (b.type !== 'survey' || !state.survey[b.id]) return;
        (b.statements || []).forEach((st, i) => {
          const v = state.survey[b.id].r[i];
          if (v) lms.interaction(n++, { id: b.id + '-' + (i + 1), type: 'likert', response: String(v), pattern: null, result: 'neutral' });
        });
      }));
      objectiveStats().forEach((s, i) => lms.objective(i, { id: s.o.id, pct: s.pct, passed: s.passed }));
      lms.commit();
    } catch (e) { /* ein Fehler im LMS darf den Kurs nicht stoppen */ }
  }

  // ---------- Blöcke ----------
  function figure(img, cls) {
    if (!img || !img.src) return '';
    const cap = [img.caption, img.credit ? (/^(©|foto|bild|quelle)/i.test(img.credit) ? img.credit : 'Bild: ' + img.credit) : ''].filter(Boolean);
    return `<figure class="kp-fig ${cls || ''} ${img.treat ? 'kp-treat-' + esc(img.treat) : ''} ${img.ai ? 'kp-ai' : ''}"><div class="kp-fig-frame"><img loading="lazy" decoding="async" src="${esc(res(img.src))}" alt="${esc(img.alt)}"${img.focus ? ` style="object-position:${esc(img.focus)}"` : ''}>${img.ai ? `<span class="kp-ai-badge">${T('kiBild')}</span>` : ''}
      <button type="button" class="kp-zoom" data-zoom aria-label="Bild vergrößern"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M11 8.5v5M8.5 11h5"/></svg></button></div>
      ${cap.length ? `<figcaption>${img.caption ? esc(img.caption) : ''}${img.credit ? `<span class="kp-credit">${esc(cap[cap.length - 1])}</span>` : ''}</figcaption>` : ''}</figure>`;
  }

  function embedUrl(url) {
    const yt = String(url).match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{6,})/);
    if (/youtu/.test(url) && yt) return 'https://www.youtube-nocookie.com/embed/' + yt[1];
    const vi = String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vi) return 'https://player.vimeo.com/video/' + vi[1];
    return url;
  }

  function renderMedia(m) {
    m = m || {};
    if (m.kind === 'video' && m.src) return `<video controls playsinline ${m.poster ? `poster="${esc(res(m.poster))}"` : ''} src="${esc(res(m.src))}">${trackHtml(m.captions, m.captionsText)}</video>`;
    if (m.kind === 'video' && plainText(m.transcript)) return videoDummy(m.transcript, m.poster);
    if (m.kind === 'audio' && m.src) return `<audio controls src="${esc(res(m.src))}"></audio>${m.transcript ? `<details class="kp-acc"><summary>Transkript</summary><div class="kp-text">${res(m.transcript)}</div></details>` : ''}`;
    if (m.kind === 'embed' && m.url) return `<div class="kp-embed"><iframe src="${esc(embedUrl(m.url))}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen title="Video"></iframe></div>`;
    if (m.kind === 'gallery' && (m.images || []).length) return `<div class="kp-gallery">${m.images.map(im => `<img loading="lazy" decoding="async" src="${esc(res(im.src))}" alt="${esc(im.alt)}" data-lightbox tabindex="0">`).join('')}</div>`;
    if (m.kind === 'compare' && m.before && m.after) {
      return `<div class="kp-compare" data-compare><img loading="lazy" decoding="async" src="${esc(res(m.before))}" alt="vorher"><div class="kp-after" style="width:50%"><img loading="lazy" decoding="async" src="${esc(res(m.after))}" alt="nachher"></div><input type="range" min="0" max="100" value="50" aria-label="Vergleich verschieben"></div>`;
    }
    return '<p class="kp-label">Für diesen Block ist noch kein Medium hinterlegt.</p>';
  }

  const itemsHtml = (list, fn) => (list || []).map(fn).join('');

  function renderBlock(b) {
    if (isCustom(b)) return `<div class="kp-text kp-custom">${res(b.customHtml)}</div>`;
    switch (b.type) {
      case 'text': return `<div class="kp-text">${res(b.html)}</div>`;
      case 'image': return figure(b.image, 'kp-' + (b.size || 'full'));
      case 'textimage': return `<div class="kp-textimage ${b.side === 'left' ? 'kp-left' : ''} ${b.size === 'medium' || b.size === 'small' ? 'kp-ti-' + b.size : ''}"><div class="kp-text">${res(b.html)}</div>${figure(b.image)}</div>`;
      case 'media': return `<div class="kp-media">${renderMedia(b.media)}</div>${b.caption ? `<p class="kp-caption">${esc(b.caption)}</p>` : ''}`;
      case 'html': return `<div class="kp-text kp-custom">${res(b.html)}</div>`;
      case 'note': return b.style === 'quote'
        ? `<blockquote class="kp-quote">${res(b.html)}${b.author ? `<footer class="kp-author">${esc(b.author)}${b.authorRole ? `<span>${esc(b.authorRole)}</span>` : ''}</footer>` : ''}</blockquote>`
        : `<div class="kp-note kp-text">${res(b.html)}</div>`;
      case 'divider': return '<hr class="kp-divider">';
      case 'accordion': return itemsHtml(b.items, it => `<details class="kp-acc"><summary>${esc(it.title)}</summary><div class="kp-text">${res(it.html)}</div></details>`);
      case 'tabs': return `<div data-kurs-tabs>${itemsHtml(b.items, it => `<section data-titel="${esc(it.title)}" class="kp-text">${res(it.html)}</section>`)}</div>`;
      case 'flipcards': {
        const tall = (b.items || []).some(it => (it.image && it.image.src) || (it.backImage && it.backImage.src));
        const pic = im => im && im.src ? `<img class="kp-flip-img" src="${esc(res(im.src))}" alt="${esc(im.alt || '')}" loading="lazy">` : '';
        return `<div class="kp-flipgrid">${itemsHtml(b.items, it => `<div class="kp-flip${tall ? ' kp-flip-tall' : ''}" tabindex="0" role="button" aria-label="${esc(it.title)}: Karte umdrehen"><div class="kp-flip-inner"><div class="kp-flip-front">${pic(it.image)}${esc(it.title)}</div><div class="kp-flip-back">${pic(it.backImage)}${res(it.html)}</div></div></div>`)}</div>`;
      }
      case 'timeline': return `<div class="${b.style === 'steps' ? 'kp-steps' : 'kp-timeline'}">${itemsHtml(b.items, it => `<div class="fx-reveal"><div><h3>${esc(it.title)}</h3><div class="kp-text">${res(it.html)}</div></div></div>`)}</div>`;
      case 'cards': return `<div class="kp-cards">${itemsHtml(b.items, it => `<div class="kp-card fx-reveal fx-hover-lift"><h3>${esc(it.title)}</h3><div class="kp-text">${res(it.html)}</div></div>`)}</div>`;
      case 'quiz': return renderQuiz(b, b.graded !== false);
      case 'pool': return `<div class="kp-pool">${(state.pools[b.id] || []).map(i => b.questions[i]).filter(Boolean).map(q => renderQuiz(q, b.graded !== false)).join('')}</div>`;
      case 'review': return renderReview(b);
      case 'glossquiz': return renderGlossquiz(b);
      case 'pretest': return renderPretest(b);
      case 'branch': return renderBranch(b);
      case 'debrief': return renderDebrief(b);
      case 'reflection': return renderReflection(b);
      case 'actionplan': return renderPlan(b);
      case 'survey': return renderSurvey(b);
      case 'certificate': return renderCertificate(b);
      case 'ivideo': return renderIVideo(b);
      case 'dialog': return renderDialog(b);
      case 'sequence': return renderSequence(b);
      case 'lottie': return `<div class="kp-lottie kp-${b.size || 'medium'}" data-lottie="${b.id}" role="img" aria-label="${esc(b.alt || 'Animation')}"></div>`;
      case 'hero': return renderHero(b);
      case 'guide': return renderGuide(b);
      case 'agenda': return renderAgenda(b);
      case 'selfcheck': return renderSelfcheck(b);
      case 'chapters': return renderChapters(b);
      case 'statement': return renderStatement(b);
      case 'predict': return renderPredict(b);
      case 'takeaways': return renderTakeaways(b);
      case 'sources': return renderSources(b);
      case 'team': return renderTeam(b);
      case 'vstatements': return renderStatements(b);
      case 'vscene': return renderVscene(b);
      case 'bignumber': return renderBignumber(b);
      case 'hotspots': return renderHotspots(b);
      case 'layers': return renderLayers(b);
      case 'comicstrip': return renderStrip(b);
      case 'sortcats': return renderSort(b);
      case 'triage': return renderTriage(b);
      case 'levers': return renderLevers(b);
      case 'chat': return renderChat(b);
      case 'matrix': return renderMatrix(b);
      case 'promptbuild': return renderPromptBuild(b);
      case 'findtext': return renderFindText(b);
      case 'simulation': return renderSimulation(b);
      case 'casebank': return renderCasebank(b);
      case 'mission': return `<div class="kp-mission" data-mission="${b.id}"><p class="kp-mission-wait">${esc(b.title || b.intro || 'Mini-Mission')}</p></div>`;
      case 'game': {
        // Vorschau und Review-Version: Spiel als srcdoc (window.KURS_SPIELE), im Paket als eigene Datei spiel-<id>.html
        const inline = window.KURS_SPIELE && window.KURS_SPIELE[b.id];
        const done = (state.self.mm || {})[b.id];
        if (opts.renderer && !inline) return `<p class="kp-mission-wait">${esc(String(b.title || 'Level-Spiel').replace(/\*/g, ''))}</p>`;
        return `<div class="kp-game${b.cover ? ' kp-game-cover' : ''}">${done ? `<p class="kp-game-done">✓ ${T('spielGeschafft')}</p>` : ''}<iframe data-game="${b.id}" title="${esc(String(b.title || 'Level-Spiel').replace(/\*/g, ''))}" allow="fullscreen" ${inline ? `srcdoc="${esc(inline)}"` : `src="spiel-${esc(b.id)}.html"`}></iframe></div>`;
      }
      case 'process': return renderProcess(b);
      case 'gate': return renderGate(b);
      case 'compare': return renderCompare(b);
      case 'album': return renderAlbum(b);
      case 'checklist': return renderChecklist(b);
      case 'attachments': return renderAttachments(b);
      case 'dial': return renderDial(b);
      case 'anim': return renderAnim(b);
      case 'motion': return renderMotion(b);
      default: return '';
    }
  }

  function quizHint(q) {
    return {
      multiple: 'Mehrere Antworten sind richtig', single: 'Eine Antwort ist richtig', truefalse: 'Wahr oder falsch?',
      fill: 'Lücken ausfüllen', order: 'In die richtige Reihenfolge bringen', match: 'Passendes zuordnen', hotspot: 'Die richtige Stelle im Bild anklicken'
    }[q.kind] || 'Eine Antwort ist richtig';
  }

  const CONF = ['Geraten', 'Eher sicher', 'Sicher'];

  // Serie: wie viele Fragen in Kursreihenfolge bis zu dieser am Stück richtig sind (settings.streak, kein Vergleich mit anderen)
  function streakOf(q) {
    const qs = items.filter(it => it.q).map(it => it.q);
    let at = qs.indexOf(q);
    if (at < 0) at = qs.findIndex(x => x.id === q.id);
    let n = 0;
    for (let i = at; i >= 0; i--) {
      const x = qs[i];
      if (state.answers[x.id] == null || evaluate(x, state.answers[x.id]) < 1) break;
      n++;
    }
    return n;
  }
  function renderQuiz(q, isGraded) {
    const given = state.answers[q.id];
    const done = given != null;
    const tries = state.tries[q.id] || 0;
    if (!state.seen[q.id]) state.seen[q.id] = Date.now();
    let body = '';

    if (q.kind === 'fill') {
      let i = -1;
      const sol = fillSolutions(q);
      body = '<p class="kp-fill">' + esc(q.text || '').replace(/\[\[(.+?)\]\]/g, () => {
        i++;
        if (!done) return `<input type="text" data-blank="${i}" autocomplete="off" aria-label="Lücke ${i + 1}">`;
        const ok = sol[i].some(s => normStr(s) === normStr(given[i]));
        return `<input type="text" value="${esc(given[i] || '')}" disabled class="${ok ? 'kp-right' : 'kp-wrong'}" aria-label="Lücke ${i + 1}: ${ok ? 'richtig' : 'falsch'}">` + (ok ? '' : ` <span class="kp-solution">(${esc(sol[i][0])})</span>`);
      }) + '</p>';
    } else if (q.kind === 'order') {
      const order = done ? given : shuffled((q.items || []).length, q.id + tries);
      body = `<div class="kp-order" data-order>${order.map((idx, pos) => `
        <div class="kp-order-item ${done ? (idx === pos ? 'kp-right' : 'kp-wrong') : ''}" draggable="${!done}" data-item="${idx}">
          <span class="kp-grip" aria-hidden="true">≡</span><span>${esc(q.items[idx])}</span>
          ${done ? '' : '<span class="kp-move"><button data-up aria-label="nach oben">▲</button><button data-down aria-label="nach unten">▼</button></span>'}
        </div>`).join('')}</div>`;
    } else if (q.kind === 'match' && q.dragdrop) {
      // Bild neben dem Begriff, falls hinterlegt (etwa ein Bauteil und seine Bezeichnung)
      const pairImg = pair => pair.image && pair.image.src ? `<img class="kp-match-img" loading="lazy" decoding="async" src="${esc(res(pair.image.src))}" alt="${esc(pair.image.alt || '')}">` : '';
      // Zuordnen per Ziehen; die Nummerntasten am Kärtchen sind der Weg ohne Maus (WCAG 2.5.7)
      const pairs = q.pairs || [];
      const rights = shuffled(pairs.length, q.id);
      const placed = done ? given : [];
      const card = r => {
        const row = placed.indexOf(r);
        const right = done && row === r;
        return `<li class="kp-mdd-card ${done ? (row < 0 ? '' : (right ? 'kp-right' : 'kp-wrong')) : ''}" draggable="${!done}" data-mdd-card="${r}" data-quiz="${q.id}" tabindex="0">
          <span>${esc(pairs[r].right)}</span>
          ${done ? '' : `<span class="kp-mdd-move">${pairs.map((x, n) => `<button data-mdd-to="${n}" data-card="${r}" data-quiz="${q.id}" title="Zu „${esc(x.left)}“">${n + 1}</button>`).join('')}</span>`}
        </li>`;
      };
      const open = rights.filter(r => placed.indexOf(r) < 0);
      body = `<div class="kp-mdd" data-mdd="${q.id}">
        <p class="kp-sort-hint">${esc(T('zuordnenHinweis'))}</p>
        <ul class="kp-mdd-pool" data-mdd-pool="${q.id}">${open.map(card).join('') || `<li class="kp-sort-empty">${T('allesZugeordnet')}</li>`}</ul>
        <div class="kp-mdd-rows">${pairs.map((pair, i) => `
          <div class="kp-mdd-row ${done ? (given[i] === i ? 'kp-right' : 'kp-wrong') : ''}">
            <span class="kp-mdd-left"><span class="kp-num" aria-hidden="true">${i + 1}</span>${pairImg(pair)}${esc(pair.left)}</span>
            <ul class="kp-mdd-drop" data-mdd-drop="${i}" data-quiz="${q.id}" aria-label="${esc(pair.left)}">
              ${placed[i] >= 0 ? card(placed[i]) : (done ? `<li class="kp-sort-empty">${T('nichtZugeordnet')}</li>` : '')}
            </ul>
            ${done && given[i] !== i ? `<span class="kp-solution">(${esc(pair.right)})</span>` : ''}
          </div>`).join('')}</div>
      </div>`;
    } else if (q.kind === 'match') {
      const rights = shuffled((q.pairs || []).length, q.id);
      const pairImg = pair => pair.image && pair.image.src ? `<img class="kp-match-img" loading="lazy" decoding="async" src="${esc(res(pair.image.src))}" alt="${esc(pair.image.alt || '')}">` : '';
      body = `<div class="kp-match">${q.pairs.map((pair, i) => `
        <div class="kp-match-row ${done ? (given[i] === i ? 'kp-right' : 'kp-wrong') : ''}">
          <span id="m-${q.id}-${i}" class="kp-match-left">${pairImg(pair)}${esc(pair.left)}</span>
          <select data-match="${i}" ${done ? 'disabled' : ''} aria-labelledby="m-${q.id}-${i}">
            <option value="-1">Bitte wählen …</option>
            ${rights.map(r => `<option value="${r}" ${done && given[i] === r ? 'selected' : ''}>${esc(q.pairs[r].right)}</option>`).join('')}
          </select>
        </div>`).join('')}</div>`;
    } else if (q.kind === 'hotspot') {
      const img = q.image && q.image.src ? res(q.image.src) : '';
      const mark = done ? `<span class="kp-marker ${evaluate(q, given) ? 'kp-right' : 'kp-wrong'}" style="left:${given[0]}%;top:${given[1]}%;width:34px;height:34px"></span>` : '';
      const sol = done ? (q.spots || []).filter(s => s.correct).map(s => `<span class="kp-marker kp-right" style="left:${s.x}%;top:${s.y}%;width:${(Number(s.r) || 8) * 2}%;aspect-ratio:1"></span>`).join('') : '';
      const cross = state.cross[q.id] || [50, 50];
      body = img ? `<div class="kp-hotspot" data-hotspot="${q.id}" ${done ? '' : 'tabindex="0" role="application" aria-label="Bild. Mit den Pfeiltasten das Fadenkreuz bewegen, mit der Eingabetaste die Stelle wählen."'}>
          <img src="${esc(img)}" alt="${esc(q.image.alt)}">${sol}${mark}${done ? '' : `<span class="kp-cross" style="left:${cross[0]}%;top:${cross[1]}%"></span>`}</div>` : '<p class="kp-label">Kein Bild hinterlegt.</p>';
    } else {
      const ans = normAnswers(q);
      const type = q.kind === 'multiple' ? 'checkbox' : 'radio';
      const order = q.shuffle && q.kind !== 'truefalse' ? shuffled(ans.length, q.id + tries) : ans.map((a, i) => i);
      const perAnswer = q.answerFeedback || q.kind === 'truefalse';
      body = `<div class="kp-answers" role="${type === 'radio' ? 'radiogroup' : 'group'}" aria-label="Antworten">${order.map(i => {
        const a = ans[i];
        const checked = done && given.indexOf(i) >= 0;
        const cls = done ? (a.correct ? 'kp-right' : (checked ? 'kp-wrong' : '')) : '';
        const showFb = done && perAnswer && a.feedback && (checked || (a.correct && q.kind === 'multiple'));
        return `<label class="kp-answer ${cls}"><input type="${type}" name="q-${q.id}" value="${i}" ${checked ? 'checked' : ''} ${done ? 'disabled' : ''}>
          <span class="kp-answer-text"><span>${esc(a.text)}</span>${showFb ? `<span class="kp-answer-fb">${esc(a.feedback)}</span>` : ''}</span></label>`;
      }).join('')}</div>`;
    }

    const askConf = (q.confidence || set.confidence) && !done;
    const confHtml = askConf ? `<div class="kp-conf" role="radiogroup" aria-label="Wie sicher bist du?"><span>Wie sicher bist du?</span>
      ${[2, 1, 0].map(v => `<label><input type="radio" name="c-${q.id}" value="${v}" ${state.conf[q.id] === v ? 'checked' : ''}>${CONF[v]}</label>`).join('')}
      <span class="kp-conf-msg" data-conf-msg></span></div>` : '';

    // Selbsterklärung: vor der Auflösung ein Satz „Warum?“ (Bisra u. a. 2018); die Begründung steht danach neben der des Kurses
    const why = q.explain && q.kind !== 'hotspot';
    const whyHtml = why && !done ? `<div class="kp-why" data-why-box><label><span class="kp-label">${T('warumFrage')}</span><textarea class="kp-notes kp-why-text" rows="1" data-why="${q.id}" placeholder="${esc(T('warumPlatz'))}"></textarea></label><span class="kp-why-missing" role="alert" hidden>${T('warumFehlt')}</span></div>` : '';
    let bottom = q.kind === 'hotspot' ? confHtml : `${whyHtml}${confHtml}<div class="kp-quiz-actions"><button class="kp-btn" data-check="${q.id}">${T('antwortPruefen')}</button></div>`;
    if (done) {
      const f = evaluate(q, given);
      const ok = f >= 1;
      const partial = f > 0 && f < 1 ? ` (${Math.round(f * 100)} % richtig)` : '';
      const streak = ok && set.streak ? streakOf(q) : 0;
      bottom = `<div class="kp-feedback ${ok ? 'ok' : 'no'}" role="status">${esc(ok ? (q.feedbackCorrect || 'Richtig!') : (q.feedbackWrong || 'Leider nicht richtig.'))}${partial}${streak >= 2 ? `<span class="kp-streak">${streak} ${T('inFolge')}</span>` : ''}</div>`;
      const c = state.conf[q.id];
      if (c === 2 && !ok) bottom += '<div class="kp-note" style="margin-top:10px">Du warst dir sicher, aber die Antwort stimmt nicht. Genau hier lohnt sich ein zweiter Blick.</div>';
      if (c === 0 && ok) bottom += '<div class="kp-note" style="margin-top:10px">Richtig geraten. Präg dir die Lösung gut ein, damit sie beim nächsten Mal sitzt.</div>';
      const mine = why ? loadText(q.id + '~why') : null;
      if (mine) bottom += `<div class="kp-why-cmp"><div class="kp-why-mine"><span class="kp-label">${T('deineBegruendung')}</span><p>${esc(mine)}</p></div>${q.explanation ? `<div class="kp-note kp-text"><span class="kp-label">${T('musterBegruendung')}</span>${res(q.explanation)}</div>` : ''}</div>`;
      else if (q.explanation) bottom += `<div class="kp-note kp-text" style="margin-top:10px">${res(q.explanation)}</div>`;
      const max = Number(q.attempts) || 0; // 0 = unbegrenzt
      if (!ok && (max === 0 || tries < max)) bottom += `<div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-retry-one="${q.id}">Nochmal versuchen${max ? ` (${max - tries} übrig)` : ''}</button></div>`;
    }
    const badge = isGraded ? '' : '<span class="kp-badge">Übung</span>';
    return `<div class="kp-quiz" data-quiz="${q.id}">
      <p class="kp-label">${esc(quizHint(q))}${badge}</p>
      <h2 class="kp-q">${esc(q.question)}</h2>
      ${q.kind === 'hotspot' ? '' : figure(q.image)}
      ${body}${bottom}</div>`;
  }

  // Begriffe lernen: Paare aus dem Glossar oder aus dem Block selbst
  function termPairs(b) {
    if (b.source === 'own') return (b.pairs || []).filter(x => x.left && x.right);
    return (course.glossary || []).filter(g => g.term && g.definition).map(g => ({ left: g.term, right: g.definition }));
  }
  function drawnPairs(b) {
    const all = termPairs(b);
    return (state.pools[b.id] || []).map(i => all[i]).filter(Boolean);
  }
  // Die Zuordnungs-Variante läuft als gewöhnliche Übungsfrage mit der ID des Blocks
  const glossCopies = {};
  function glossQuiz(b) {
    if (!glossCopies[b.id]) {
      glossCopies[b.id] = Object.assign(newQuizLike(), {
        id: b.id, kind: 'match', question: b.title || T('begriffeLernen'), pairs: drawnPairs(b),
        graded: false, attempts: 0, dragdrop: !!b.dragdrop, points: 0
      });
    }
    return glossCopies[b.id];
  }
  function newQuizLike() {
    return { type: 'quiz', feedbackCorrect: T('alleRichtig'), feedbackWrong: T('nochNichtAlle'), explanation: '', answers: [], image: null, confidence: false, objective: '' };
  }
  function renderGlossquiz(b) {
    const pairs = drawnPairs(b);
    const head = `<p class="kp-label">${T('begriffeLernen')}</p>${b.title ? `<h2 class="kp-q" style="margin:0 0 10px">${accent(b.title)}</h2>` : ''}`;
    if (!pairs.length) return `<div class="kp-gq" data-gq="${b.id}">${head}<p class="kp-label">${T('keineBegriffe')}</p></div>`;
    if (b.mode === 'match') return `<div class="kp-gq" data-gq="${b.id}">${head}${renderQuiz(glossQuiz(b), false)}</div>`;
    if (b.mode === 'memory') return renderMemory(b, pairs);
    // Standard: Flipcards, Begriff vorn, Bedeutung hinten
    return `<div class="kp-gq" data-gq="${b.id}">${head}<div class="kp-flipgrid">${pairs.map(x => `<div class="kp-flip" tabindex="0" role="button" aria-label="${esc(x.left)}: Karte umdrehen"><div class="kp-flip-inner"><div class="kp-flip-front">${esc(x.left)}</div><div class="kp-flip-back">${esc(x.right)}</div></div></div>`).join('')}</div></div>`;
  }
  // Memory: Begriff und Bedeutung liegen verdeckt, zwei Karten aufdecken, Paare bleiben offen
  function renderMemory(b, pairs) {
    const st = state.self[b.id] || (state.self[b.id] = { open: [], found: [], moves: 0, order: null });
    const n = pairs.length;
    if (!st.order || st.order.length !== 2 * n) { st.order = shuffleIds(Array.from({ length: 2 * n }, (x, i) => i)); st.open = []; st.found = []; st.moves = 0; }
    const done = st.found.length >= n && n > 0;
    const card = k => {
      const pair = pairs[k % n];
      const isTerm = k < n;
      const up = st.open.includes(k) || st.found.includes(k % n);
      const cls = ['kp-mem-card', up ? 'up' : '', st.found.includes(k % n) ? 'kp-right' : '', isTerm ? 'kp-mem-term' : 'kp-mem-def'].filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-mem="${k}" data-gq-of="${b.id}" ${up ? 'disabled' : ''} aria-label="${up ? esc(isTerm ? pair.left : pair.right) : T('karteVerdeckt')}"><span class="kp-mem-face">${up ? esc(isTerm ? pair.left : pair.right) : '?'}</span></button>`;
    };
    return `<div class="kp-gq" data-gq="${b.id}">
      <p class="kp-label">${T('begriffeLernen')}</p>${b.title ? `<h2 class="kp-q" style="margin:0 0 6px">${accent(b.title)}</h2>` : ''}
      <p class="kp-sort-hint">${T('memoryHinweis')}</p>
      <div class="kp-mem-grid">${st.order.map(card).join('')}</div>
      <p class="kp-mem-status" role="status">${st.found.length} ${T('von')} ${n} ${T('paareGefunden')} · ${st.moves} ${T('zuege')}</p>
      ${done ? `<div class="kp-feedback ok">${T('memoryFertig')}</div><div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-mem-reset="${b.id}">${T('nochmalSpielen')}</button></div>` : ''}
    </div>`;
  }

  function renderReview(b) {
    const qs = reviewQuestions(b);
    return `<div class="kp-review-head"><p class="kp-label">Wiederholung</p><h2 class="kp-q" style="margin:0">${esc(b.title || 'Weißt du es noch?')}</h2>
      <p style="margin:6px 0 0">${qs.length ? 'Fragen aus früheren Abschnitten. Was zuletzt nicht saß, kommt zuerst. Sie zählen nicht zur Bewertung.' : 'Es gibt noch keine früheren Fragen zum Wiederholen.'}</p></div>
      <div class="kp-review-list">${qs.map(q => renderQuiz(q, false)).join('')}</div>`;
  }

  function renderPretest(b) {
    const qs = b.questions || [];
    const s = scoreOf(qs.map(q => ({ id: q.id, q, points: Number(q.points) || 10 })));
    const target = pageIndexById(b.skipTo);
    let box = '';
    if (!s.open) {
      const passed = s.pct >= (Number(b.passPct) || 80);
      box = `<div class="kp-pretest-box" data-pretest="${b.id}"><p class="kp-label">Einstiegstest</p><div class="kp-score" style="font-size:44px">${s.pct} %</div>
        ${passed && target >= 0 ? `<p>Du kennst dich schon gut aus. Du kannst direkt zu „${plainTitle(pages[target].title)}“ springen oder trotzdem alles durcharbeiten.</p>
          <div class="kp-quiz-actions" style="justify-content:center"><button class="kp-btn" data-skip="${b.id}">Überspringen</button><button class="kp-btn kp-sec" data-next>Trotzdem durcharbeiten</button></div>`
          : `<p>${passed ? 'Gut gemacht.' : 'Kein Problem: Der folgende Abschnitt erklärt alles Schritt für Schritt.'}</p>`}</div>`;
    }
    return `${b.intro ? `<div class="kp-text" style="margin-bottom:16px">${res(b.intro)}</div>` : ''}
      <div class="kp-pretest-list">${qs.map(q => renderQuiz(q, false)).join('')}</div>${box}`;
  }

  // Folgekarte: die Wahl lag daneben, der Kurs zeigt, was daraus wird (Zeitsprung, Figur, Text), dann geht es zurück zur Frage
  const hasConseq = o => !!(o && o.consequence && typeof o.consequence === 'object' && (o.consequence.html || (o.consequence.image && o.consequence.image.src) || o.consequence.later));
  function conseqOf(b) {
    const tried = state.branch[b.id] == null ? (state.self[b.id] || {}).tried : null;
    const o = tried != null ? (b.options || [])[tried] : null;
    return hasConseq(o) ? o : null;
  }
  function conseqCard(b, o) {
    const c = o.consequence, who = c.castId ? castOf({ castId: c.castId }) : null;
    const pic = c.image && c.image.src ? `<div class="kp-conseq-pic">${photo(c.image)}</div>`
      : who ? `<div class="kp-conseq-pic kp-conseq-avatar">${who.image && who.image.src ? photo(who.image, who.name) : avatarSvg(who.look || 'a3', 'sad')}</div>` : '';
    return `<div class="kp-conseq" role="status" tabindex="-1" data-retry-fb data-conseq="${esc(b.id)}">
      <p class="kp-conseq-later">${esc(c.later || T('folgeLabel'))}</p>
      <div class="kp-conseq-body">${pic}<div>${c.html ? `<div class="kp-text">${res(c.html)}</div>` : ''}${o.feedback ? `<p class="kp-conseq-fb">${esc(o.feedback)}</p>` : ''}</div></div>
      <div class="kp-quiz-actions"><button type="button" class="kp-btn" data-conseq-back="${esc(b.id)}">${T('nochmalEntscheiden')}</button></div></div>`;
  }
  function retryFeedback(b) {
    const tried = state.branch[b.id] == null ? (state.self[b.id] || {}).tried : null;
    const o = tried != null ? (b.options || [])[tried] : null;
    if (!o) return '';
    if (hasConseq(o)) return conseqCard(b, o);
    return `<div class="kp-feedback no" role="status" tabindex="-1" data-retry-fb style="margin-top:14px">${esc([o.feedback, T('nochmalVersuchen')].filter(Boolean).join(' '))}</div>`;
  }
  // Hilfe zum Holen: Mentorfigur oder Arbeitshilfe an der Entscheidung; wer sie geöffnet hat, steht in state.self[id].helped
  const helpOpen = new Set();
  const helpOf = b => (b && b.help && typeof b.help === 'object' && (b.help.html || b.help.attachment || b.help.castId) ? b.help : null);
  function helpWho(h) { const who = h.castId ? castOf({ castId: h.castId }) : null; return { who, name: (who && who.name) || h.name || '' }; }
  function helpButton(b) {
    const h = helpOf(b); if (!h) return '';
    const { name } = helpWho(h), open = helpOpen.has(b.id);
    return `<button type="button" class="kp-help-btn${open ? ' open' : ''}" data-help-open="${esc(b.id)}" aria-expanded="${open}">${icon('question')}<span>${name ? T('fragHilfe').replace('{n}', esc(name)) : T('hilfe')}</span></button>`;
  }
  function helpPanel(b) {
    const h = helpOf(b); if (!h || !helpOpen.has(b.id)) return '';
    const { who, name } = helpWho(h);
    const pic = who ? `<div class="kp-help-avatar">${who.image && who.image.src ? photo(who.image, who.name) : avatarSvg(who.look || 'a3', 'explain')}</div>` : '';
    return `<div class="kp-help" role="region" aria-label="${esc(T('hilfe'))}" data-help="${esc(b.id)}">${pic}<div class="kp-help-body">
      ${name ? `<p class="kp-help-name">${esc(name)}${who && who.role ? ` <em>${esc(who.role)}</em>` : ''}</p>` : ''}
      ${h.html ? `<div class="kp-text">${res(h.html)}</div>` : ''}
      ${h.attachment ? `<p><a class="kp-btn kp-sec" href="${esc(res(h.attachment))}" download>${T('arbeitshilfe')}</a></p>` : ''}</div></div>`;
  }
  // Begründung zu einer Entscheidung (explain): gespeichert unter der Block-id mit ~why; ohne sie bleibt die Rückmeldung zu
  const branchWhy = b => (b.explain ? loadText(b.id + '~why') : null);
  const branchWhyOpen = b => !!b.explain && state.branch[b.id] != null && !branchWhy(b);
  function renderBranch(b) {
    const chosen = state.branch[b.id];
    const opt = chosen != null ? b.options[chosen] : null;
    const tried = chosen == null ? (state.self[b.id] || {}).tried : null;
    const tries = chosen == null ? (state.self[b.id] || {}).tries || [] : []; // frühere Fehlversuche bleiben markiert, auch nach der Folgekarte
    const whyOpen = branchWhyOpen(b);
    const mine = branchWhy(b);
    return `<div class="kp-branch" data-branch="${b.id}">
      ${b.prompt || helpOf(b) ? `<div class="kp-branch-head">${b.prompt ? `<h2 class="kp-q">${esc(b.prompt)}</h2>` : ''}${chosen == null ? helpButton(b) : ''}</div>` : ''}${chosen == null ? helpPanel(b) : ''}
      <div class="kp-branch-options"${conseqOf(b) ? ' hidden' : ''}>${(b.options || []).map((o, i) => `
        <button class="kp-branch-option ${chosen === i ? 'chosen' : ''}${tried === i || tries.includes(i) ? ' tried' : ''}" data-choose="${i}" ${chosen != null && !b.changeable ? 'disabled' : ''} aria-pressed="${chosen === i}">${esc(o.text)}</button>`).join('')}</div>
      ${retryFeedback(b)}
      ${whyOpen ? `<div class="kp-why" data-why-box><label><span class="kp-label">${T('warumFrage')}</span><textarea class="kp-notes kp-why-text" rows="2" data-why="${b.id}" placeholder="${esc(T('warumPlatz'))}"></textarea></label><span class="kp-why-missing" role="alert" hidden>${T('warumFehlt')}</span>
        <div class="kp-quiz-actions"><button class="kp-btn" data-why-save="${b.id}">${T('begruendungSpeichern')}</button></div></div>` : ''}
      ${mine ? `<div class="kp-why-mine"><span class="kp-label">${T('deineBegruendung')}</span><p>${esc(mine)}</p></div>` : ''}
      ${opt && !whyOpen ? `${opt.feedback ? `<div class="kp-feedback neutral" role="status" style="margin-top:14px">${esc(opt.feedback)}</div>` : ''}
        ${opt.effects ? meterPanel(opt.effects) : ''}
        ${opt.target ? '<div class="kp-quiz-actions"><button class="kp-btn" data-follow>Weiter</button></div>' : ''}` : ''}
    </div>`;
  }

  function renderDebrief(b) {
    const list = [];
    let got = 0, max = 0;
    pages.forEach(p => branchesIn(p).forEach(x => {
      const c = state.branch[x.id];
      if (x.scored) { max += Math.max(0, ...(x.options || []).map(o => Number(o.points) || 0)); }
      if (c == null) return;
      const o = x.options[c] || {};
      if (x.scored) got += Number(o.points) || 0;
      list.push(`<div class="kp-debrief-item"><small>${esc(x.prompt || p.title)}</small><strong>${esc(o.text)}</strong>${o.feedback ? `<span>${esc(o.feedback)}</span>` : ''}</div>`);
    }));
    return `<div class="kp-debrief"><p class="kp-label">Nachbesprechung</p><h2 class="kp-q">${esc(b.title || 'Deine Entscheidungen im Überblick')}</h2>
      ${list.length ? list.join('') : '<p>Du hast noch keine Entscheidungen getroffen.</p>'}
      ${(course.meters || []).length ? `<p class="kp-label" style="margin-top:16px">${T('werteStand')}</p>${meterPanel(null)}` : ''}
      ${max ? `<div class="kp-feedback neutral" style="margin-top:14px">Punkte im Szenario: ${got} von ${max}</div>` : ''}
      ${b.html ? `<div class="kp-text" style="margin-top:14px">${res(b.html)}</div>` : ''}</div>`;
  }

  // ---------- Ton: Aufnahmen und Browser-Stimme ----------
  let sound = null; // gerade laufender Ton
  const plainText = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  function stopSound() {
    if (!sound) return;
    const s = sound;
    sound = null;
    s.stop();
  }
  // Lautstärke und Tempo gelten für alle Aufnahmen und für die Browser-Stimme.
  // Sie liegen im localStorage, nicht im Lernstand: der Platz dort ist knapp und je Gerät ist das sinnvoller.
  const audioPrefs = { vol: 1, rate: 1 };
  const audioKey = 'kurs-ton-' + (course.id || '');
  try {
    const raw = localStorage.getItem(audioKey);
    if (raw) {
      const saved = JSON.parse(raw);
      if (Number(saved.vol) >= 0) audioPrefs.vol = Math.min(1, Number(saved.vol));
      if (Number(saved.rate) > 0) audioPrefs.rate = Math.min(2, Math.max(0.5, Number(saved.rate)));
    }
  } catch (e) { /* ohne Speicher laufen die Standardwerte */ }
  function saveAudioPrefs() {
    try { localStorage.setItem(audioKey, JSON.stringify(audioPrefs)); } catch (e) { /* privates Fenster */ }
  }
  // Wirkt sofort auf das, was gerade läuft (die Browser-Stimme erst beim nächsten Satz)
  function applyAudioPrefs() {
    if (sound && sound.media) { sound.media.volume = audioPrefs.vol; sound.media.playbackRate = audioPrefs.rate; }
    root.querySelectorAll('audio, video').forEach(m => { m.volume = audioPrefs.vol; });
  }

  // Spielt eine Aufnahme oder liest einen Text vor; onEnd wird nach dem Ende aufgerufen
  function playSound(src, text, onEnd, voiceIndex) {
    stopSound();
    const done = () => { if (sound === ctl) { sound = null; } if (onEnd) onEnd(); };
    let ctl;
    if (src) {
      const a = new Audio(res(src));
      a.volume = audioPrefs.vol;
      a.playbackRate = audioPrefs.rate;
      ctl = { stop: () => { a.pause(); a.onended = null; }, media: a };
      a.onended = done;
      a.play().catch(() => { sound = null; });
    } else if (text && window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(plainText(text));
      u.lang = 'de-DE';
      u.volume = audioPrefs.vol;
      u.rate = audioPrefs.rate;
      const voices = speechSynthesis.getVoices().filter(v => /^de/i.test(v.lang));
      if (voices.length) u.voice = voices[(voiceIndex || 0) % voices.length];
      if (voices.length < 2 && voiceIndex) u.pitch = voiceIndex % 2 ? 0.8 : 1.2;
      u.onend = done;
      ctl = { stop: () => { u.onend = null; speechSynthesis.cancel(); } };
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } else {
      if (onEnd) setTimeout(onEnd, 0);
      return null;
    }
    sound = ctl;
    return ctl;
  }
  // WebVTT als Liste von Einblendungen; Zeiten wie 00:01:02.500 oder 1:02.5
  function vttSeconds(stamp) {
    return String(stamp).trim().split(':').reverse()
      .reduce((sum, part, i) => sum + (parseFloat(part.replace(',', '.')) || 0) * Math.pow(60, i), 0);
  }
  function parseVtt(text) {
    const cues = [];
    String(text || '').replace(/\r/g, '').split(/\n\s*\n/).forEach(part => {
      const lines = part.split('\n').filter(l => l.trim());
      const i = lines.findIndex(l => l.indexOf('-->') > 0);
      if (i < 0) return;
      const [from, to] = lines[i].split('-->').map(x => x.trim().split(/\s+/)[0]);
      const txt = lines.slice(i + 1).join(' ').replace(/<[^>]*>/g, '').trim();
      if (txt) cues.push({ from: vttSeconds(from), to: vttSeconds(to), text: txt });
    });
    return cues;
  }
  const narrCues = {};
  function narrationCues(b) {
    if (!narrCues[b.id]) narrCues[b.id] = b.narrationVtt ? parseVtt(b.narrationVtt) : [];
    return narrCues[b.id];
  }
  // Sprechertext: Knopf, Untertitel und die Regler für Lautstärke und Tempo
  function narrationButton(b) {
    if (!b.narration && !plainText(b.tts)) return '';
    const hasCc = !!(b.narrationVtt || plainText(b.tts));
    return `<div class="kp-narr" data-narr-box="${b.id}">
      <button data-narr="${b.id}" aria-label="${T('anhoeren')}">▶ ${T('anhoeren')}</button>
      ${hasCc ? `<button class="kp-narr-opt" data-narr-cc="${b.id}" aria-pressed="false" title="${T('untertitel')}">${T('untertitel')}</button>` : ''}
      <button class="kp-narr-opt" data-narr-set="${b.id}" aria-expanded="false" aria-label="${T('toneinstellungen')}">⚙</button>
      <div class="kp-narr-panel" hidden>
        <label>${T('lautstaerke')} <input type="range" data-narr-vol min="0" max="1" step="0.05" value="${audioPrefs.vol}"></label>
        <label>${T('tempo')} <input type="range" data-narr-rate min="0.5" max="2" step="0.25" value="${audioPrefs.rate}"><output>${audioPrefs.rate}×</output></label>
      </div>
      ${hasCc ? `<p class="kp-narr-cc" data-narr-cc-text="${b.id}" role="status" hidden></p>` : ''}
    </div>`;
  }

  // ---------- Figuren für Comic-Dialoge ----------
  const AVATARS = {
    a1: { skin: '#f1c7a5', hair: '#3b2a20', shirt: '#1f3a5f', style: 'short' },
    a2: { skin: '#e8b48f', hair: '#2a1a12', shirt: '#c8781a', style: 'long' },
    a3: { skin: '#8d5a3b', hair: '#151515', shirt: '#1f7a4d', style: 'short' },
    a4: { skin: '#f5d6c0', hair: '#b8862b', shirt: '#6a3fb0', style: 'bun' },
    a5: { skin: '#c68e65', hair: '#6b6b6b', shirt: '#b3261e', style: 'bald' },
    a6: { skin: '#6b4430', hair: '#231510', shirt: '#0f6b78', style: 'long' },
    a7: { skin: '#f1c7a5', hair: '#4a3328', shirt: '#2f4858', style: 'short', beard: true },
    a8: { skin: '#e8b48f', hair: '#1c1c1c', shirt: '#7a3b6a', style: 'curly' },
    a9: { skin: '#8d5a3b', hair: '#2b1b12', shirt: '#b87333', style: 'pony' },
    a10: { skin: '#f5d6c0', hair: '#2b3440', shirt: '#345c8a', style: 'short', glasses: true },
    a11: { skin: '#c68e65', hair: '#1f2933', shirt: '#4b6b3c', style: 'cap' },
    a12: { skin: '#6b4430', hair: '#5a5a5a', shirt: '#8a2f3b', style: 'bald', beard: true, glasses: true }
  };
  // Haltung und Gesichtsausdruck: machen Comic-Szenen lebendig
  function avatarSvg(key, pose, bare) {
    // Gezeichnete Figur (viewBox 100 × 100): Augen mit Iris und Lid, Brauen in jeder Haltung, Nase, Ohren, Hals mit Schatten,
    // Schultern mit Kragen. Klassen kp-eyes (Blinzeln) und kp-mouth (Sprechen) bleiben, die Haltungen auch.
    const a = AVATARS[key] || AVATARS.a1;
    const p = pose || 'neutral';
    const shirt = `var(--kp-shirt, ${a.shirt})`;
    const back = /long|pony|curly/.test(a.style) ? `<path d="M24 74c-5-32 5-58 26-58s31 26 26 58z" fill="${a.hair}"/>` : '';
    const front = {
      short: `<path d="M27 40c0-15 10-25 23-25s23 10 23 25c-5-7-13-10-23-10s-18 3-23 10z" fill="${a.hair}"/>`,
      long: `<path d="M28 42c0-16 10-26 22-26s22 10 22 26c-4-9-12-13-22-13s-18 4-22 13z" fill="${a.hair}"/>`,
      bun: `<circle cx="50" cy="13" r="9" fill="${a.hair}"/><path d="M28 39c0-14 10-23 22-23s22 9 22 23c-5-7-13-10-22-10s-17 3-22 10z" fill="${a.hair}"/>`,
      curly: `<g fill="${a.hair}"><circle cx="33" cy="30" r="10"/><circle cx="50" cy="24" r="11"/><circle cx="67" cy="30" r="10"/><circle cx="28" cy="42" r="7"/><circle cx="72" cy="42" r="7"/></g>`,
      pony: `<path d="M28 41c0-15 10-25 22-25s22 10 22 25c-5-8-13-11-22-11s-17 3-22 11z" fill="${a.hair}"/><path d="M70 36c9 4 12 14 10 26-6-4-9-12-12-18z" fill="${a.hair}"/>`,
      cap: `<path d="M27 38c0-14 10-23 23-23s23 9 23 23H27z" fill="${a.hair}"/><path d="M27 38h34c8 0 14 2 16 5H27z" fill="${a.hair}" opacity=".75"/>`,
      bald: ''
    }[a.style] || '';
    const beard = a.beard ? `<path d="M31 44c0 16 8 25 19 25s19-9 19-25c-3 9-10 12-19 12s-16-3-19-12z" fill="${a.hair}" opacity=".9"/>` : '';
    const glasses = a.glasses ? `<g fill="none" stroke="#2c3440" stroke-width="1.8"><circle cx="42" cy="44" r="7"/><circle cx="58" cy="44" r="7"/><path d="M49 44h2M29 42l6 1M71 42l-6 1"/></g>` : '';
    const browCol = a.style === 'bald' ? '#3b3b3b' : a.hair;
    const brow = d => `<path class="kp-brow" d="${d}" stroke="${browCol}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    // Brauen, Mund und Augenöffnung je Ausdruck
    const faces = {
      neutral: { brow: brow('M36 37q6-2 11 0M53 37q5-2 11 0'), mouth: 'M43 52q7 3 14 0', eye: 1 },
      happy: { brow: brow('M36 36q6-3 11 0M53 36q5-3 11 0'), mouth: 'M41 50q9 8 18 0', eye: .9 },
      think: { brow: brow('M36 38q6-2 11-1M53 37q6-2 11 1'), mouth: 'M44 54q6 1 12-2', eye: .85 },
      skeptic: { brow: brow('M36 35q6 2 11 3M53 38q6-4 11-2'), mouth: 'M43 54q7-3 14 1', eye: .8 },
      sad: { brow: brow('M36 36q6 2 11 4M53 40q5-2 11-4'), mouth: 'M43 55q7-6 14 0', eye: .9 },
      surprised: { brow: brow('M36 33q6-3 11 0M53 33q5-3 11 0'), mouth: 'M46 52a4 4 0 1 0 8 0a4 4 0 1 0-8 0', eye: 1.25 }
    };
    const f = faces[{ wave: 'happy', explain: 'neutral', point: 'neutral' }[p] || p] || faces.neutral;
    const eye = cx => `<ellipse cx="${cx}" cy="44" rx="4.2" ry="${(2.9 * f.eye).toFixed(2)}" fill="#fff"/><circle class="kp-iris" cx="${cx}" cy="44.3" r="${(2.3 * Math.min(1, f.eye + .1)).toFixed(2)}" fill="#3a2f2a"/><circle cx="${cx}" cy="44.3" r="1.1" fill="#111"/><circle cx="${cx + .9}" cy="43.3" r=".6" fill="#fff"/><path d="M${cx - 4.2} 43.6q4.2-${(3.4 * f.eye).toFixed(2)} 8.4 0" stroke="#3a2f2a" stroke-width="1.1" fill="none" stroke-linecap="round"/>`;
    // Arme je Haltung
    const arms = {
      wave: `<path d="M74 84c6-10 9-22 6-30" stroke="${shirt}" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="79" cy="50" r="6" fill="${a.skin}"/>`,
      explain: `<path d="M72 88c8-4 12-10 13-16" stroke="${shirt}" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="86" cy="70" r="6" fill="${a.skin}"/><path d="M28 88c-8-4-12-10-13-16" stroke="${shirt}" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="14" cy="70" r="6" fill="${a.skin}"/>`,
      think: `<path d="M70 92c4-8 2-16-4-21" stroke="${shirt}" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="63" cy="62" r="6" fill="${a.skin}"/>`,
      point: `<path d="M74 86c7-6 10-14 9-21" stroke="${shirt}" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="84" cy="62" r="6" fill="${a.skin}"/><path d="M84 58v-8" stroke="${a.skin}" stroke-width="5" stroke-linecap="round"/>`,
      cross: `<path d="M26 84q24 12 48 0" stroke="${shirt}" stroke-width="9" fill="none" stroke-linecap="round"/><path d="M30 80q20 14 40 2" stroke="${shirt}" stroke-width="7" fill="none" stroke-linecap="round"/>`
    }[p] || '';
    return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${bare ? '' : '<rect width="100" height="100" fill="#eef2f6"/>'}${back}
      <path d="M11 100c1-16 13-26 29-30l10-2 10 2c16 4 28 14 29 30z" fill="${shirt}"/><path d="M42 70l8 10 8-10" fill="#000" opacity=".16"/>${arms}
      <rect x="44" y="55" width="12" height="17" rx="3" fill="${a.skin}"/><ellipse cx="50" cy="60" rx="9" ry="4" fill="#000" opacity=".12"/>
      <circle cx="29.5" cy="45" r="4.5" fill="${a.skin}"/><circle cx="70.5" cy="45" r="4.5" fill="${a.skin}"/>
      <circle cx="50" cy="42" r="21" fill="${a.skin}"/>${beard}${front}
      <g class="kp-eyes">${eye(42)}${eye(58)}</g>${f.brow}
      <path class="kp-nose" d="M50 45v5.5q0 1.8-2 2" stroke="#000" opacity=".3" stroke-width="1.2" fill="none" stroke-linecap="round"/>${glasses}
      <path class="kp-mouth" d="${f.mouth}" stroke="#7a3f36" stroke-width="2.2" fill="${f.mouth.includes('a4 4') ? '#5a2c27' : 'none'}" stroke-linecap="round"/></svg>`;
  }
  // Foto je Haltung: cast[].poses[haltung], sonst das Hauptfoto
  function poseImage(c, pose) {
    const p = c.poses && pose && c.poses[pose];
    return p && p.src ? p.src : (c.image && c.image.src ? c.image.src : '');
  }
  function avatarHtml(c, pose) {
    if (c.look === 'image' && poseImage(c, pose || c.pose)) return `<img src="${esc(res(poseImage(c, pose || c.pose)))}" alt="">`;
    return avatarSvg(c.look, pose || c.pose);
  }
  // Figuren aus der Kurs-Besetzung übernehmen (Name, Rolle, Aussehen, Farbe)
  function castOf(c) {
    const m = c && c.castId && (course.cast || []).find(x => x.id === c.castId);
    return m ? Object.assign({}, c, { name: m.name, role: m.role, look: m.look, image: m.image, poses: m.poses, color: m.color }) : c;
  }

  // ---------- Symbole (eigene, schlichte Linien-Symbole) ----------
  const ICONS = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    'arrow-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12h8M13 9l3 3-3 3"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    chats: '<path d="M3 4h12v8H7l-4 3z"/><path d="M9 15v2h7l4 3V9h-3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 19c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.5 0 4 1.3 4.8 3.8"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
    heart: '<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-2.8A4.8 4.8 0 0 1 21 11c-2 4.6-9 9-9 9z"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    book: '<path d="M4 5c3-1.5 6-1.5 8 .5 2-2 5-2 8-.5v14c-3-1.5-6-1.5-8 .5-2-2-5-2-8-.5z"/><path d="M12 5.5v14"/>',
    pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    rocket: '<path d="M12 15l-3-3c1-5 4.5-8.5 11-9-.5 6.5-4 10-9 11z"/><path d="M9 12l-4 1-2 3 4 1M12 15l-1 4 3 2 1-4"/><circle cx="15" cy="9" r="1.5"/>',
    puzzle: '<path d="M4 8h4a2 2 0 1 1 4 0h4v4a2 2 0 1 1 0 4v4h-4a2 2 0 1 0-4 0H4v-4a2 2 0 1 0 0-4z"/>',
    hand: '<path d="M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6 7-2.5 0-4-1.3-5.5-3.5L3.8 13a1.5 1.5 0 0 1 2.5-1.6L8 13"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    ear: '<path d="M7 9a5 5 0 0 1 10 0c0 3-2.5 4-3 6.5S12.5 21 10 20.5"/><path d="M10 9.5a2 2 0 0 1 4 0"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    alert: '<path d="M12 3l10 17H2z"/><path d="M12 10v4M12 17v.5"/>',
    question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.5"/>',
    thumb: '<path d="M7 11v9H4v-9zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9h5a2 2 0 0 1 2 2.3l-1.2 6.5A2.5 2.5 0 0 1 16.8 20H7"/>',
    leaf: '<path d="M5 19c0-9 5-14 15-14 0 10-5 15-14 15"/><path d="M5 19l8-8"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5"/>',
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>',
    trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v3M8 21h8M9 17h6v4H9z"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    scale: '<path d="M12 4v16M6 20h12M4 8h16"/><path d="M6 8l-3 6a3 3 0 0 0 6 0zM18 8l-3 6a3 3 0 0 0 6 0z"/>',
    seedling: '<path d="M12 21v-9"/><path d="M12 12c0-4-3-6-7-6 0 4 3 6 7 6zM12 10c0-3.5 2.5-6 7-6 0 4-2.5 6-7 6z"/>'
  };
  function icon(name, cls) {
    const p = ICONS[name];
    return p ? `<svg class="kp-ico ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>` : '';
  }
  // *Wort* in Überschriften wird zum kursiven Akzent
  const accent = s => esc(s).replace(/\*(.+?)\*/g, '<em class="kp-accent">$1</em>');
  // Derselbe Titel als schlichter Text: die Sternchen des Akzentworts gehören nicht in
  // Listen, Kopfzeilen und Ausdrucke, sonst stehen sie dort sichtbar herum.
  const plainTitle = s => esc(String(s == null ? '' : s).replace(/\*(.+?)\*/g, '$1'));
  const eyebrow = s => (s ? `<p class="kp-eyebrow">${esc(s)}</p>` : '');

  // Geschätzte Lernzeit des Kurses (für den Titelbereich)
  function estimateMinutes() {
    return Math.max(1, kursZeit(pages).minutes);
  }

  // ---------- Titelbereich, Begleitfigur, Agenda, Selbstcheck ----------
  const focusStyle = img => (img && img.focus ? ` style="object-position:${esc(img.focus)}"` : '');
  const photo = (img, fallbackLabel) => img && img.src
    ? `<img src="${esc(res(img.src))}" alt="${esc(img.alt || '')}"${focusStyle(img)}>${img.credit ? `<span class="kp-credit-over">${esc(img.credit)}</span>` : ''}`
    : `<div class="kp-photo-empty">${icon('user')}<span>${esc(fallbackLabel || 'Foto')}</span></div>`;

  // Hervorgehobener Einschub in einer Karte, z. B. eine Frage zum Nachdenken
  const calloutHtml = b => (plainText(b.callout) ? `<div class="kp-callout">${b.calloutIcon ? icon(b.calloutIcon) : ''}<div class="kp-text">${res(b.callout)}</div></div>` : '');

  // Bewegtes Titelbild: stummer Clip in Schleife (Pexels oder eigene Datei) über dem Foto, das als Standbild
  // bleibt. Unter „Bewegung reduzieren“ blendet das CSS den Clip aus, dann steht nur das Foto.
  function heroVideo(b) {
    const src = b.video || b.videoUrl;
    if (!src) return '';
    return `<video class="kp-hero-video" autoplay muted loop playsinline preload="metadata" aria-hidden="true" tabindex="-1" src="${esc(res(src))}"${b.image && b.image.src ? ` poster="${esc(res(b.image.src))}"` : ''}></video>${b.videoCredit && !(b.image && b.image.credit) ? `<span class="kp-credit-over">${esc(b.videoCredit)}</span>` : ''}`;
  }
  function renderHero(b) {
    const minutes = b.time ? Number(b.time) : estimateMinutes();
    return `<div class="kp-hero2 kp-hero-${b.layout || 'card-left'} ${b.cover ? 'kp-hero-cover' : ''}">
      <div class="kp-hero-media${heroVideo(b) ? ' kp-has-video' : ''}">${photo(b.image, 'Titelbild')}${heroVideo(b)}</div>
      <div class="kp-hero-card kp-card-${b.cardStyle || 'white'}">
        ${firstName() ? `<p class="kp-hello">${T('hallo')} ${esc(firstName())},</p>` : ''}
        ${eyebrow(b.eyebrow)}
        <h2 class="kp-hero-title">${accent(b.title)}</h2>
        <div class="kp-text">${res(b.html)}</div>
        ${calloutHtml(b)}
        <div class="kp-hero-meta">${b.icon ? icon(b.icon, 'kp-ico-lg') : ''}${b.showTime !== false ? `<span>${icon('clock')} ${T('lernzeit')}: ${T('ca')} ${minutes} ${T('minuten')}</span>` : ''}</div>
        ${b.cover ? `<div class="kp-hero-start"><button class="kp-btn" data-next>${esc(b.startLabel || T('starten'))}</button></div>` : ''}
      </div>
    </div>`;
  }

  function renderGuide(b) {
    const p = castOf(b);
    const media = b.video
      ? `<video controls playsinline preload="metadata" src="${esc(res(b.video))}" ${p.image && p.image.src ? `poster="${esc(res(p.image.src))}"` : ''}></video>`
      : (p.look && p.look !== 'image' && !(p.image && p.image.src) ? `<div class="kp-guide-avatar"${p.color ? ` style="--c:${esc(p.color)}"` : ''}>${avatarSvg(p.look)}</div>` : photo(p.image, p.name));
    return `<div class="kp-guide kp-guide-${b.side || 'left'}">
      <div class="kp-guide-media">${media}</div>
      <div class="kp-guide-card kp-card-${b.cardStyle || 'white'}">
        ${eyebrow(b.eyebrow)}
        <h3 class="kp-guide-name">${esc(p.name || '')}${p.role ? `, <em class="kp-accent">${esc(p.role)}</em>` : ''}</h3>
        <div class="kp-text kp-guide-quote">${res(b.html)}</div>
        ${calloutHtml(b)}
      </div>
    </div>`;
  }

  function renderAgenda(b) {
    return `${b.challenge ? `<p class="kp-agenda-challenge">${accent(b.challenge)}</p>` : ''}<div class="kp-agenda">${(b.columns || []).map(c => `
      <div class="kp-agenda-col fx-reveal">
        ${eyebrow(c.eyebrow)}
        ${c.title ? `<h3 class="kp-agenda-title">${accent(c.title)}</h3>` : ''}
        <ul class="${c.numbered ? 'kp-agenda-num' : ''}">${(c.items || []).filter(Boolean).map((it, k) => `<li>${c.numbered ? `<span class="kp-num" aria-hidden="true">${k + 1}</span>` : icon(c.icon || 'check-circle')}<span>${esc(it)}</span></li>`).join('')}</ul>
      </div>`).join('')}</div>`;
  }

  function renderSelfcheck(b) {
    const st = state.self[b.id] || { a: [] };
    const scale = b.mode === 'scale';
    const rows = (b.statements || []).map((s, i) => {
      const v = st.a[i];
      const ctl = scale
        ? `<span class="kp-scale" role="radiogroup" aria-label="${esc(s)}">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="sc-${b.id}-${i}" value="${n}" ${v === n ? 'checked' : ''} ${st.done ? 'disabled' : ''}>${n}</label>`).join('')}</span>`
        : `<span class="kp-yesno" role="radiogroup" aria-label="${esc(s)}">
            <label><input type="radio" name="sc-${b.id}-${i}" value="1" ${v === 1 ? 'checked' : ''} ${st.done ? 'disabled' : ''}>Ja</label>
            <label><input type="radio" name="sc-${b.id}-${i}" value="0" ${v === 0 ? 'checked' : ''} ${st.done ? 'disabled' : ''}>Nein</label></span>`;
      return `<div class="kp-sc-row"><span>${esc(s)}</span>${ctl}</div>`;
    }).join('');
    let result = '';
    if (st.done) {
      const sum = st.a.reduce((x, y) => x + (Number(y) || 0), 0);
      const r = (b.results || []).find(x => sum >= Number(x.min) && sum <= Number(x.max));
      result = `<div class="kp-sc-result fx-fade-in" role="status">${r ? res(r.html) : ''}</div>
        <div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-self-reset="${b.id}">Antworten ändern</button></div>`;
    }
    return `<div class="kp-selfcheck" data-self="${b.id}">
      ${eyebrow(b.eyebrow)}
      ${b.title ? `<h2 class="kp-q">${accent(b.title)}</h2>` : ''}
      ${b.intro ? `<div class="kp-text" style="margin-bottom:12px">${res(b.intro)}</div>` : ''}
      <div class="kp-sc-rows">${rows}</div>
      ${st.done ? result : `<div class="kp-quiz-actions"><button class="kp-btn" data-self-eval="${b.id}">Auswerten</button></div>`}
    </div>`;
  }

  // ---------- Comic-Dialog ----------
  // ---------- Szenen-Bühne: Raum, Figuren, Kamera ----------
  // Räume als SVG in den Farben des Stil-Pakets; back liegt hinter, front vor den Figuren
  const SP = 'var(--kp-primary)', SA = 'var(--kp-accent)', SS = 'var(--kp-surface)', SW = 'var(--kp-bg)';
  const STAGE_SETS = {
    buero: {
      back: `<rect width="800" height="360" fill="${SW}"/><rect width="800" height="276" fill="${SP}" fill-opacity=".05"/>
        <rect x="56" y="46" width="176" height="150" rx="4" fill="${SA}" fill-opacity=".14" stroke="currentColor" stroke-opacity=".22" stroke-width="3"/>
        <g stroke="currentColor" stroke-opacity=".12" stroke-width="2">${[70, 92, 114, 136, 158, 180].map(y => `<line x1="60" y1="${y}" x2="228" y2="${y}"/>`).join('')}</g>
        <rect x="578" y="96" width="170" height="7" fill="currentColor" fill-opacity=".18"/><rect x="578" y="176" width="170" height="7" fill="currentColor" fill-opacity=".18"/>
        ${[0, 1, 2, 3, 4, 5].map(i => `<rect x="${590 + i * 22}" y="${i % 2 ? 58 : 52}" width="16" height="${i % 2 ? 38 : 44}" rx="2" fill="${i === 2 ? SA : SP}" fill-opacity="${i === 2 ? 0.7 : 0.35 + (i % 3) * 0.12}"/>`).join('')}
        ${[0, 1, 2].map(i => `<rect x="${596 + i * 30}" y="138" width="24" height="38" rx="2" fill="${SP}" fill-opacity=".25"/>`).join('')}
        <rect x="0" y="276" width="800" height="84" fill="${SP}" fill-opacity=".09"/>`,
      front: `<rect x="-10" y="300" width="820" height="70" rx="6" fill="${SP}" fill-opacity=".2"/><rect x="-10" y="300" width="820" height="6" fill="${SP}" fill-opacity=".35"/>
        <rect x="352" y="226" width="96" height="64" rx="6" fill="currentColor" fill-opacity=".7"/><rect x="358" y="232" width="84" height="50" rx="3" fill="${SA}" fill-opacity=".25"/><rect x="392" y="290" width="16" height="12" fill="currentColor" fill-opacity=".6"/>
        <rect x="490" y="278" width="20" height="24" rx="4" fill="${SA}" fill-opacity=".8"/>`
    },
    besprechung: {
      back: `<rect width="800" height="360" fill="${SW}"/><rect width="800" height="270" fill="${SP}" fill-opacity=".04"/>
        <rect x="296" y="36" width="208" height="126" rx="8" fill="${SS}" stroke="currentColor" stroke-opacity=".2" stroke-width="3"/>
        ${[30, 52, 40, 70].map((h, i) => `<rect x="${326 + i * 40}" y="${140 - h}" width="24" height="${h}" rx="3" fill="${i === 3 ? SA : SP}" fill-opacity="${i === 3 ? 0.8 : 0.35}"/>`).join('')}
        <rect x="632" y="30" width="130" height="190" rx="4" fill="${SA}" fill-opacity=".12" stroke="currentColor" stroke-opacity=".18" stroke-width="3"/><line x1="697" y1="30" x2="697" y2="220" stroke="currentColor" stroke-opacity=".18" stroke-width="3"/>
        <rect x="58" y="206" width="34" height="46" rx="5" fill="${SP}" fill-opacity=".5"/><ellipse cx="66" cy="192" rx="16" ry="26" fill="${SP}" fill-opacity=".35"/><ellipse cx="86" cy="186" rx="14" ry="30" fill="${SA}" fill-opacity=".45"/>
        <rect x="0" y="270" width="800" height="90" fill="${SP}" fill-opacity=".08"/>`,
      front: `<ellipse cx="400" cy="352" rx="440" ry="64" fill="${SP}" fill-opacity=".22"/><ellipse cx="400" cy="342" rx="440" ry="58" fill="none" stroke="${SP}" stroke-opacity=".3" stroke-width="4"/>
        <path d="M366 312h68l8-26h-84z" fill="currentColor" fill-opacity=".55"/><rect x="310" y="306" width="22" height="16" rx="4" fill="${SA}" fill-opacity=".8"/><rect x="470" y="302" width="40" height="26" rx="2" fill="${SS}" stroke="currentColor" stroke-opacity=".3"/>`
    },
    videocall: {
      back: `<rect width="800" height="360" fill="${SP}"/><rect width="800" height="360" fill="#000" fill-opacity=".25"/>
        <rect x="28" y="22" width="360" height="262" rx="16" fill="${SS}"/><rect x="412" y="22" width="360" height="262" rx="16" fill="${SS}"/>
        <rect x="28" y="22" width="360" height="262" rx="16" fill="${SA}" fill-opacity=".1"/><rect x="600" y="40" width="140" height="90" rx="4" fill="${SP}" fill-opacity=".12"/>
        <rect x="324" y="300" width="152" height="46" rx="23" fill="#000" fill-opacity=".35"/>
        <circle cx="352" cy="323" r="14" fill="#fff" fill-opacity=".85"/><circle cx="400" cy="323" r="14" fill="#fff" fill-opacity=".85"/><circle cx="448" cy="323" r="14" fill="#d93025"/>`,
      front: ''
    },
    flur: {
      back: `<rect width="800" height="360" fill="${SW}"/><rect width="800" height="250" fill="${SP}" fill-opacity=".05"/>
        ${[120, 400, 680].map(x => `<rect x="${x - 50}" y="0" width="100" height="10" rx="3" fill="${SA}" fill-opacity=".35"/>`).join('')}
        <rect x="70" y="72" width="104" height="178" rx="3" fill="${SP}" fill-opacity=".16" stroke="currentColor" stroke-opacity=".15" stroke-width="3"/><circle cx="160" cy="166" r="5" fill="currentColor" fill-opacity=".45"/>
        <rect x="626" y="72" width="104" height="178" rx="3" fill="${SP}" fill-opacity=".16" stroke="currentColor" stroke-opacity=".15" stroke-width="3"/><circle cx="640" cy="166" r="5" fill="currentColor" fill-opacity=".45"/>
        <rect x="324" y="62" width="152" height="100" rx="4" fill="${SA}" fill-opacity=".14" stroke="currentColor" stroke-opacity=".18" stroke-width="3"/>
        <rect x="340" y="78" width="38" height="30" fill="${SS}" transform="rotate(-4 359 93)"/><rect x="392" y="80" width="34" height="42" fill="${SS}" transform="rotate(3 409 101)"/><rect x="436" y="84" width="26" height="26" fill="${SA}" fill-opacity=".6"/>
        <path d="M0 250H800V360H0z" fill="${SP}" fill-opacity=".1"/><g stroke="currentColor" stroke-opacity=".08" stroke-width="2">${[-300, -100, 100, 300, 500, 700, 900, 1100].map(x => `<line x1="400" y1="250" x2="${x}" y2="360"/>`).join('')}</g>`,
      front: ''
    },
    anlage: {
      back: `<rect width="800" height="360" fill="${SA}" fill-opacity=".1"/><rect width="800" height="360" fill="${SW}" fill-opacity=".55"/><circle cx="690" cy="68" r="30" fill="${SA}" fill-opacity=".45"/>
        <g fill="none" stroke="currentColor" stroke-opacity=".42" stroke-width="3" stroke-linejoin="round">
          <path d="M400 24L372 236M400 24L428 236M378 190h44M384 146h32M390 100h20M360 64h80M352 110h96M378 190L416 146M422 190L384 146M384 146L410 100M416 146L390 100"/>
          <path d="M744 110L730 236M744 110L758 236M722 136h44M726 176h36"/>
        </g>
        <g fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="2"><path d="M-10 90Q180 130 360 64M440 64Q600 110 722 136M-10 132Q180 170 352 110M448 110Q600 150 766 136"/></g>
        <rect x="0" y="236" width="800" height="124" fill="${SP}" fill-opacity=".14"/>
        <g stroke="currentColor" stroke-opacity=".22" stroke-width="2">${Array.from({ length: 41 }, (x, i) => `<line x1="${i * 20}" y1="226" x2="${i * 20}" y2="252"/>`).join('')}<line x1="0" y1="232" x2="800" y2="232"/></g>
        <rect x="560" y="196" width="70" height="44" rx="3" fill="${SP}" fill-opacity=".35"/><rect x="570" y="186" width="12" height="12" fill="${SP}" fill-opacity=".35"/><rect x="608" y="186" width="12" height="12" fill="${SP}" fill-opacity=".35"/>`,
      front: ''
    }
  };
  const STAGE_MOODS = ['neutral', 'angespannt', 'positiv'];
  const STAGE_SHOTS = ['totale', 'schulter', 'nah'];
  const NARRATOR = 'erzaehler'; // line.char für das Zwischenbild des Erzählers
  // Entscheidung direkt im Bild, solange sie offen ist und die Möglichkeiten kurz genug sind
  function stageChoices(b, lines, n) {
    const d = b.decision, opts = d && d.options || [];
    if (n < lines.length || !opts.length) return false;
    if (state.branch[d.id] != null) return branchWhyOpen(d); // nach der Wahl bleibt das Feld „Warum?“ im Bild, bis die Begründung steht
    return opts.length <= 4 && opts.reduce((s, o) => s + String(o.text || '').length, 0) <= 360;
  }
  function renderStage(b, chars, lines, n, choices) {
    const st = b.stage || {};
    const set = STAGE_SETS[st.setting];
    const cast = b.characters || [];
    const cur = n > 0 ? lines[n - 1] : null;
    const speaker = cur ? chars[cur.char] : null;
    // Haltung je Figur: die ihrer letzten Zeile
    const pose = {};
    lines.slice(0, n).forEach(l => { pose[l.char] = l.pose || 'neutral'; });
    const sides = { left: [], right: [] };
    cast.forEach(c => sides[chars[c.id].side === 'right' ? 'right' : 'left'].push(c.id));
    const actors = cast.map(c => {
      const ch = chars[c.id], side = ch.side === 'right' ? 'right' : 'left', slot = sides[side].indexOf(c.id);
      const talking = !!(speaker && cur.char === c.id);
      const img = ch.look === 'image' && poseImage(ch, pose[c.id]) ? `<img src="${esc(res(poseImage(ch, pose[c.id])))}" alt="">` : avatarSvg(ch.look, pose[c.id], true);
      return `<div class="kp-actor kp-actor-${side}${talking ? ' kp-speaking' : ''}" style="--slot:${slot};--c:${esc(ch.color || '#1f3a5f')};--kp-shirt:${esc(ch.color || '#1f3a5f')}">
        <div class="kp-avatar${talking ? ' kp-talking' : ''}">${img}</div>${st.setting === 'videocall' ? `<span class="kp-actor-tag">${esc(ch.name || '')}</span>` : ''}</div>`;
    }).join('');
    const photo = b.background && b.background.src ? `<img class="kp-stage-photo" src="${esc(res(b.background.src))}" alt="">` : '';
    const narr = !!(cur && cur.char === NARRATOR);
    const focus = speaker ? (speaker.side === 'right' ? 'right' : 'left') : '';
    const film = !!st.film;
    const sub = !!st.subtitles || film;
    const bubble = cur && speaker ? `<div class="${sub ? 'kp-stage-sub' : `kp-stage-bubble kp-sb-${focus}`}" data-line="${n - 1}" style="--c:${esc(speaker.color || '#1f3a5f')}"><b>${esc(speaker.name || '')}</b>${esc(cur.text)}</div>` : '';
    // Bauchbinde im Filmlook: Name und Rolle, nur wenn die sprechende Person wechselt
    const prevSpeaker = n >= 2 ? lines[n - 2].char : null;
    const lowerThird = film && speaker && cur.char !== prevSpeaker ? `<div class="kp-lower-third" style="--c:${esc(speaker.color || '#1f3a5f')}"><b>${esc(speaker.name || '')}</b>${speaker.role ? `<span>${esc(speaker.role)}</span>` : ''}</div>` : '';
    const mood = STAGE_MOODS.includes(st.mood) ? st.mood : 'neutral';
    const shot = cur && focus && st.setting !== 'videocall' && STAGE_SHOTS.includes(cur.shot) ? cur.shot : '';
    // Statisten: kleine, unscharfe Figuren im Hintergrund, Aussehen aus den nicht besetzten Figuren
    const used = new Set(cast.map(c => chars[c.id].look));
    const free = Object.keys(AVATARS).filter(k => !used.has(k));
    const extras = st.setting === 'videocall' ? '' : Array.from({ length: Math.max(0, Math.min(3, Number(st.extras) || 0)) }, (x, i) =>
      `<div class="kp-extra kp-extra-${i}"><div class="kp-avatar">${avatarSvg(free[(i * 3 + 1) % free.length] || 'a3', i === 1 ? 'think' : 'neutral', true)}</div></div>`).join('');
    // Zwischenbild des Erzählers: Abblende, Text auf dunklem Grund; die Zeile danach blendet wieder auf
    const prevNarr = !narr && n >= 2 && lines[n - 2].char === NARRATOR;
    const narrCard = narr ? `<div class="kp-stage-narr" aria-live="polite" data-line="${n - 1}"><p class="kp-narr-label">${T('erzaehler')}</p><p class="kp-narr-text">${esc(cur.text)}</p></div>` : '';
    const d = b.decision;
    const whyOnStage = choices && branchWhyOpen(d);
    const pick = whyOnStage ? `<div class="kp-stage-choices kp-stage-why kp-sc-${focus === 'right' ? 'left' : 'right'}" data-branch="${esc(d.id)}" role="group" aria-label="${esc(T('warumFrage'))}">
        <p class="kp-stage-prompt">${esc((d.options[state.branch[d.id]] || {}).text || '')}</p>
        <div class="kp-why" data-why-box><label><span class="kp-label">${T('warumFrage')}</span><textarea class="kp-notes kp-why-text" rows="2" data-why="${esc(d.id)}" placeholder="${esc(T('warumPlatz'))}"></textarea></label><span class="kp-why-missing" role="alert" hidden>${T('warumFehlt')}</span>
        <div class="kp-quiz-actions"><button class="kp-btn" data-why-save="${esc(d.id)}">${T('begruendungSpeichern')}</button></div></div></div>`
      : choices ? `<div class="kp-stage-choices kp-sc-${focus === 'right' ? 'left' : 'right'}" data-branch="${esc(d.id)}" role="group" aria-label="${esc(d.prompt || T('entscheidung'))}">
        ${d.prompt ? `<p class="kp-stage-prompt">${esc(d.prompt)}</p>` : ''}
        ${helpButton(d)}${helpPanel(d)}<div class="kp-stage-choice-list"${conseqOf(d) ? ' hidden' : ''}>${d.options.map((o, i) => `<button class="kp-stage-choice${(state.self[d.id] || {}).tried === i || ((state.self[d.id] || {}).tries || []).includes(i) ? ' tried' : ''}" data-choose="${i}">${esc(o.text)}</button>`).join('')}</div>${retryFeedback(d)}</div>` : '';
    const filmCard = film && n === 0 ? `<div class="kp-film-card"><span class="kp-film-eyebrow">${esc(T('szene'))}</span><h3>${esc(b.title || T('szene'))}</h3><p>${esc(cast.map(c => chars[c.id].name).filter(Boolean).join(' · '))}</p><button class="kp-film-play" data-dlg-next="${b.id}" aria-label="${esc(T('abspielen'))}">▶</button></div>`
      : film && n >= lines.length && !(b.decision && (b.decision.options || []).length) ? `<div class="kp-film-card kp-film-end"><span class="kp-film-eyebrow">${esc(T('ende'))}</span><h3>${esc(b.title || '')}</h3><button class="kp-film-play" data-dlg-restart="${b.id}" aria-label="${esc(T('nochmalAnsehen'))}">↺</button></div>` : '';
    const filmState = film ? (n === 0 ? ' kp-film-idle' : n >= lines.length ? ' kp-film-done' : '') : '';
    return `<div class="kp-stage-wrap${film ? ' kp-film' + filmState : ''}${filmCc.has(b.id) ? ' kp-cc-off' : ''} kp-set-${esc(st.setting)} kp-mood-${mood}${shot ? ' kp-shot-' + shot : ''}${choices ? ' kp-choosing' : ''}${sub ? ' kp-subtitled' : ''}${narr ? ' kp-narrating' : ''}" data-focus="${focus}" data-shot="${shot}"${film ? ` data-film-stage="${b.id}"` : ''}><div class="kp-stage">
      <div class="kp-stage-back${photo ? ' kp-has-photo' : ''}" aria-hidden="true">
        ${photo || `<svg class="kp-stage-art" viewBox="0 0 800 360" preserveAspectRatio="xMidYMax slice">${set.back}</svg>`}
        ${extras ? `<div class="kp-stage-extras">${extras}</div>` : ''}
      </div>
      <div class="kp-stage-cam" aria-hidden="true">
        <div class="kp-stage-cast">${actors}</div>
        ${!photo && set.front ? `<svg class="kp-stage-art kp-stage-front" viewBox="0 0 800 360" preserveAspectRatio="xMidYMax slice">${set.front}</svg>` : ''}
      </div>
      ${narrCard}${prevNarr ? '<div class="kp-stage-fade" aria-hidden="true"></div>' : ''}
      ${b.title ? `<p class="kp-stage-caption">${esc(b.title)}</p>` : ''}${lowerThird}${filmCard}</div>
      <div class="kp-stage-say" aria-live="polite">${bubble}</div>${pick}
    </div>`;
  }

  function renderDialog(b) {
    const chars = {};
    (b.characters || []).forEach((c, i) => { chars[c.id] = Object.assign({ index: i }, castOf(c)); });
    const lines = b.lines || [];
    const n = Math.min(state.dlg[b.id] || 0, lines.length);
    const shownList = lines.slice(0, n).map((l, i) => {
      if (l.char === NARRATOR) return `<p class="kp-dlg-narr" data-line="${i}"><b>${T('erzaehler')}:</b> ${esc(l.text)}</p>`;
      const c = chars[l.char] || { name: '', side: 'left', color: '#1f3a5f', look: 'a1' };
      return `<div class="kp-line ${c.side === 'right' ? 'right' : ''}" style="--c:${esc(c.color || '#1f3a5f')}">
        <div class="kp-avatar ${i === n - 1 ? 'kp-talking' : ''}">${avatarHtml(c, l.pose)}</div>
        <div class="kp-bubble" data-line="${i}"><b>${esc(c.name)}</b>${esc(l.text)}</div></div>`;
    });
    const shown = shownList.join('');
    let actions;
    if (n < lines.length) {
      actions = `<button class="kp-btn" data-dlg-next="${b.id}">${n === 0 ? '▶ Szene starten' : 'Weiter ▸'}</button>
        ${n > 0 ? `<button class="kp-btn kp-sec" data-dlg-all="${b.id}">Alles anzeigen</button>` : ''}`;
    } else if (b.decision && (b.decision.options || []).length) {
      actions = '';
    } else {
      actions = `<button class="kp-btn kp-sec" data-dlg-restart="${b.id}">↺ Szene noch einmal</button>`;
    }
    const decision = n >= lines.length && b.decision && (b.decision.options || []).length ? `<div class="kp-dlg-decision">${renderBranch(b.decision)}</div>` : '';
    // Szenen-Bühne: aktuelle Zeile auf der Bühne, frühere Zeilen im Verlauf
    if (b.stage && STAGE_SETS[b.stage.setting]) {
      const earlier = shownList.slice(0, Math.max(0, n - 1)).join('');
      const choices = stageChoices(b, lines, n);
      const film = !!b.stage.film;
      // Steuerleiste wie im Videoplayer: Abspielen/Pause, Fortschritt je Zeile, Untertitel, Vollbild
      const playing = filmAuto.has(b.id) || b.mode === 'auto';
      const bar = film ? `<div class="kp-film-bar" role="group" aria-label="${esc(T('szene'))}">
          <button data-film-play="${b.id}" aria-pressed="${playing}" title="${esc(playing ? T('pause') : T('abspielen'))}">${playing && n < lines.length ? '❚❚' : '▶'}</button>
          <button data-dlg-next="${b.id}" title="${esc(T('naechsteZeile'))}" ${n >= lines.length ? 'disabled' : ''}>▸</button>
          <div class="kp-film-progress" aria-hidden="true">${lines.map((l, i) => `<i class="${i < n - 1 ? 'done' : i === n - 1 ? 'now' : ''}"></i>`).join('')}</div>
          <span class="kp-film-time">${n} / ${lines.length}</span>
          <button data-film-cc="${b.id}" aria-pressed="${!filmCc.has(b.id)}" title="${esc(T('untertitel'))}">CC</button>
          <button data-film-full="${b.id}" title="${esc(T('vollbild'))}">⛶</button>
        </div>` : '';
      return `<div class="kp-dialog kp-staged${film ? ' kp-film-wrap' : ''}" data-dialog="${b.id}">${renderStage(b, chars, lines, n, choices)}${bar}
        ${earlier ? `<details class="kp-dlg-history"><summary>${T('verlauf')} (${n - 1})</summary><div class="kp-dlg-lines">${earlier}</div></details>` : ''}
        ${actions && !film ? `<div class="kp-dlg-actions">${actions}</div>` : ''}${choices ? '' : decision}</div>`;
    }
    const bg = b.background && b.background.src ? ` style="background-image:linear-gradient(rgba(255,255,255,.55),rgba(255,255,255,.55)),url('${esc(res(b.background.src))}')"` : '';
    return `<div class="kp-dialog" data-dialog="${b.id}"${bg}>
      ${b.title ? `<p class="kp-label">${esc(b.title)}</p>` : ''}
      <div class="kp-dlg-lines" aria-live="polite">${shown}</div>
      ${actions ? `<div class="kp-dlg-actions">${actions}</div>` : ''}${decision}</div>`;
  }
  let dlgTimer = null;
  const filmAuto = new Set(); // Szenen, die gerade wie ein Video abgespielt werden
  const filmCc = new Set();   // Szenen mit ausgeschalteten Untertiteln
  function dialogStep(b, all) {
    clearTimeout(dlgTimer);
    const lines = b.lines || [];
    state.dlg[b.id] = all ? lines.length : Math.min((state.dlg[b.id] || 0) + 1, lines.length);
    const box = root.querySelector(`[data-dialog="${b.id}"]`);
    if (!box) return;
    const had = box.contains(document.activeElement);
    const old = box.querySelector('.kp-stage-wrap');
    const before = old && { focus: old.dataset.focus, shot: old.dataset.shot };
    refreshBlock(box, renderDialog(b));
    const wrap = root.querySelector(`[data-dialog="${b.id}"] .kp-stage-wrap`);
    // Gleiche Einstellung: die Kamera fährt zur sprechenden Person. Neue Einstellung: harter Schnitt wie im Film.
    if (wrap && before && !before.shot && !wrap.dataset.shot && before.focus !== wrap.dataset.focus) {
      const now = wrap.dataset.focus;
      wrap.dataset.focus = before.focus;
      void wrap.offsetWidth;
      wrap.dataset.focus = now;
    }
    // Wer mit der Tastatur weiterklickt, landet auf der Entscheidung im Bild oder wieder auf „Weiter“
    const target = had && root.querySelector(`[data-dialog="${b.id}"] .kp-stage-choice, [data-dialog="${b.id}"] [data-dlg-next]`);
    if (target) target.focus({ preventScroll: true });
    if (all) return stopSound();
    const i = state.dlg[b.id] - 1;
    const line = lines[i];
    const bubble = root.querySelector(`[data-dialog="${b.id}"] [data-line="${i}"]`);
    if (bubble) { bubble.classList.add('speaking'); bubble.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    // Der Erzähler bekommt eine eigene Stimme hinter den Figuren
    const charIndex = line.char === NARRATOR ? (b.characters || []).length : (b.characters || []).findIndex(c => c.id === line.char);
    const auto = b.mode === 'auto' || filmAuto.has(b.id);
    const finished = () => {
      // Ende der Szene beim Abspielen: Abspann, und die Aufnahme im Editor erfährt davon
      filmAuto.delete(b.id);
      const box2 = root.querySelector(`[data-dialog="${b.id}"]`);
      if (box2) refreshBlock(box2, renderDialog(b));
      if (window.parent !== window) { try { window.parent.postMessage({ type: 'kurs-film-end', id: b.id }, '*'); } catch (e) { /* ohne Elternfenster */ } }
    };
    const next = () => {
      if (bubble) bubble.classList.remove('speaking');
      if (auto && state.dlg[b.id] < lines.length) dlgTimer = setTimeout(() => dialogStep(b), 500);
      else if (auto && filmAuto.has(b.id)) dlgTimer = setTimeout(finished, 1200);
    };
    const ctl = playSound(line.audio, b.tts ? line.text : '', next, charIndex);
    if (ctl && ctl.media) lipSync(ctl, root.querySelector(`[data-dialog="${b.id}"]`));
    if (!ctl) {
      // ohne Ton: Lesezeit abwarten
      if (bubble) setTimeout(() => bubble.classList.remove('speaking'), 1200);
      const wait = Math.max(1800, plainText(line.text).split(' ').length * 380);
      if (auto && state.dlg[b.id] < lines.length) dlgTimer = setTimeout(() => dialogStep(b), wait);
      else if (auto && filmAuto.has(b.id)) dlgTimer = setTimeout(finished, wait);
    }
  }
  // Lippen am Ton: Lautstärke der Aufnahme steuert die Mundöffnung (--kp-mouth). Ohne Web Audio bleibt die feste Animation.
  let audioCtx = null;
  function lipSync(ctl, box) {
    if (!box || reducedMotion() || !(window.AudioContext || window.webkitAudioContext)) return;
    const src = ctl.media.currentSrc || ctl.media.src || '';
    // Fremde Adressen würden über den Analyser stumm, deshalb nur eigene Dateien
    if (!/^(data:|blob:)/.test(src) && !src.startsWith(location.origin) && !src.startsWith('file:')) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const node = audioCtx.createMediaElementSource(ctl.media);
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      node.connect(an); an.connect(audioCtx.destination);
      const buf = new Uint8Array(an.fftSize);
      const wrap = box.closest('[data-block]') || box;
      wrap.classList.add('kp-lips');
      let level = 0;
      const tick = () => {
        const w = root.querySelector(`[data-block="${wrap.dataset.block}"]`) || wrap;
        if (ctl.media.paused || ctl.media.ended || !w.isConnected) { w.classList.remove('kp-lips'); w.style.removeProperty('--kp-mouth'); return; }
        w.classList.add('kp-lips');
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        level = level * .5 + Math.min(1, rms * 6) * .5;
        w.style.setProperty('--kp-mouth', level.toFixed(3));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e) { /* Rückfall: feste Mundanimation */ }
  }

  // ---------- Vertonte Erklärsequenz ----------
  function seqStage(b, idx) {
    const steps = b.steps || [];
    const visible = b.mode === 'slides' ? [idx] : steps.map((s, i) => i).filter(i => i <= idx);
    return visible.filter(i => steps[i]).map(i => {
      const s = steps[i];
      const img = s.image && s.image.src ? `<img src="${esc(res(s.image.src))}" alt="${esc(s.image.alt || '')}">` : '';
      return `<div class="kp-seq-step ${img ? 'has-img' : ''} ${i === idx ? 'fx-' + (b.animation || 'slide-up') : ''}"><div class="kp-text">${res(s.html)}</div>${img}</div>`;
    }).join('');
  }
  function renderSequence(b) {
    const steps = b.steps || [];
    const idx = Math.min(state.seq[b.id] == null ? 0 : state.seq[b.id], Math.max(0, steps.length - 1));
    return `<div class="kp-seq" data-seq="${b.id}">
      <div class="kp-seq-stage" aria-live="polite">${seqStage(b, idx)}</div>
      <div class="kp-seq-ctrl">
        <button data-seq-prev aria-label="Zurück">◀</button>
        <button data-seq-play aria-label="Abspielen">▶</button>
        <button data-seq-next aria-label="Weiter">▶▏</button>
        <div class="kp-seq-prog"><b style="width:${steps.length ? (idx + 1) / steps.length * 100 : 0}%"></b></div>
        <span class="kp-seq-count">${idx + 1} / ${steps.length}</span>
      </div>
      ${b.audio ? `<audio data-seq-audio src="${esc(res(b.audio))}" preload="auto"></audio>` : ''}
    </div>`;
  }

  // ---------- Interaktives Video ----------
  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function renderIVideo(b) {
    const yt = b.source === 'youtube';
    const ytId = (String(b.url || '').match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{6,})/) || [])[1];
    const track = !yt ? trackHtml(b.captions, b.captionsText) : '';
    const player = yt
      ? (ytId ? `<div class="kp-iv-yt"><div id="yt-${b.id}"></div></div>` : '<p class="kp-label" style="color:#fff;padding:20px">Keine gültige YouTube-Adresse.</p>')
      : (b.src ? `<video playsinline controls preload="metadata" src="${esc(res(b.src))}">${track}</video>` : '<p class="kp-label" style="color:#fff;padding:20px">Kein Video hinterlegt.</p>');
    const chapters = (b.chapters || []).slice().sort((x, y) => x.t - y.t);
    return `<div class="kp-ivwrap" data-ivideo="${b.id}" ${yt ? `data-yt="${esc(ytId || '')}"` : ''}>
      <div class="kp-iv">${player}<div class="kp-iv-overlay" hidden role="dialog" aria-label="Frage im Video"></div></div>
      <div class="kp-iv-bar" aria-hidden="true"><b></b></div>
      ${chapters.length ? `<div class="kp-iv-chapters">${chapters.map(c => `<button data-vseek="${Number(c.t) || 0}">${fmtTime(Number(c.t) || 0)} ${esc(c.title)}</button>`).join('')}</div>` : ''}
      ${b.requireWatch ? `<p class="kp-iv-note">${state.watched[b.id] ? '✔ Video vollständig angesehen' + (b.freeAfterWatch ? ' · Vorspulen ist jetzt frei' : '') : 'Bitte sieh dir das Video bis zum Ende an.'}</p>` : ''}
    </div>`;
  }
  function markerHtml(b, m) {
    const cont = (attrs, label) => `<div class="kp-quiz-actions"><button class="kp-btn" data-vcontinue="${b.id}" ${attrs || ''}>${label || 'Weiter ansehen ▶'}</button></div>`;
    if (m.kind === 'question' && m.q) {
      const done = state.answers[m.q.id] != null;
      return renderQuiz(m.q, m.q.graded !== false) + cont(`data-q="${m.q.id}" ${done ? '' : 'disabled'}`);
    }
    if (m.kind === 'jump') {
      return `<h2 class="kp-q">${esc(m.prompt || 'Wie geht es weiter?')}</h2>
        <div class="kp-branch-options">${(m.options || []).map(o => `<button class="kp-branch-option" data-vjump="${b.id}" data-t="${Number(o.t) || 0}">${esc(o.text)}</button>`).join('')}</div>`;
    }
    return `${m.title ? `<h2 class="kp-q">${esc(m.title)}</h2>` : ''}<div class="kp-text">${res(m.html)}</div>${cont()}`;
  }
  const videoCtl = {};
  let mediaTimers = [];
  function loadScript(src) {
    return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
  }
  let ytReady = null;
  function loadYouTube() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (!ytReady) ytReady = new Promise(ok => { window.onYouTubeIframeAPIReady = ok; loadScript('https://www.youtube.com/iframe_api'); });
    return ytReady;
  }
  function setupVideo(wrap) {
    const b = findBlock(wrap.dataset.ivideo);
    if (!b || wrap.dataset.ready) return;
    wrap.dataset.ready = '1';
    const overlay = wrap.querySelector('.kp-iv-overlay');
    const bar = wrap.querySelector('.kp-iv-bar');
    const markers = (b.markers || []).slice().sort((x, y) => x.t - y.t);
    const shown = new Set();
    let maxT = 0, api = null, lastT = 0;
    const ctl = videoCtl[b.id] = {
      showMarker(m) {
        api.pause();
        shown.add(m.id);
        overlay.innerHTML = markerHtml(b, m);
        overlay.hidden = false;
        activateComponents(overlay);
        (overlay.querySelector('.kp-q') || overlay).setAttribute('tabindex', '-1');
        (overlay.querySelector('.kp-q') || overlay).focus({ preventScroll: true });
      },
      resume() { overlay.hidden = true; overlay.innerHTML = ''; api.play(); },
      jump(t) { overlay.hidden = true; overlay.innerHTML = ''; maxT = Math.max(maxT, t); api.seek(t); api.play(); },
      seek(t) {
        if (locked() && t > maxT + 1) return;
        api.seek(t); api.play();
      }
    };
    // Vorspul-Sperre: beim ersten Durchlauf gesperrt, danach frei, wenn der Kurs das erlaubt
    const locked = () => b.requireWatch && !(b.freeAfterWatch && state.watched[b.id]);
    const drawTicks = dur => {
      if (!dur || bar.dataset.ticks) return;
      bar.dataset.ticks = '1';
      markers.forEach(m => bar.insertAdjacentHTML('beforeend', `<i style="left:${Math.min(100, m.t / dur * 100)}%" title="${esc(m.kind === 'question' ? 'Frage' : m.kind === 'jump' ? 'Entscheidung' : 'Hinweis')}"></i>`));
    };
    const finish = () => {
      if (!state.watched[b.id]) {
        state.watched[b.id] = true;
        const note = wrap.querySelector('.kp-iv-note');
        if (note) note.textContent = '✔ Video vollständig angesehen' + (b.freeAfterWatch ? ' · Vorspulen ist jetzt frei' : '');
        renderFooter();
        report();
      }
    };
    const tick = () => {
      if (!api) return;
      const t = api.time();
      const rawDur = api.duration();
      const dur = isFinite(rawDur) && rawDur > 0 ? rawDur : 0; // manche Videos melden ihre Länge erst spät
      drawTicks(dur);
      // Vorspulen über noch nicht gesehene Stellen verhindern, wenn das Video Pflicht ist
      if (locked() && t > maxT + 2) { api.seek(maxT); return; }
      if (t <= maxT + 2) maxT = Math.max(maxT, t);
      if (dur) bar.querySelector('b').style.width = Math.min(100, t / dur * 100) + '%';
      if (overlay.hidden) {
        const m = markers.find(x => !shown.has(x.id) && x.t <= t && x.t > lastT - 1.5 && !(x.kind === 'question' && x.q && state.answers[x.q.id] != null));
        if (m) ctl.showMarker(m);
      }
      lastT = t;
      if (dur && t >= dur - 0.6) finish();
    };
    if (wrap.dataset.yt !== undefined) {
      const id = wrap.dataset.yt;
      if (!id) return;
      loadYouTube().then(() => {
        const yp = new YT.Player('yt-' + b.id, {
          videoId: id, host: 'https://www.youtube-nocookie.com',
          playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
          events: { onStateChange: e => { if (e.data === 0) finish(); } }
        });
        api = {
          time: () => (yp.getCurrentTime ? yp.getCurrentTime() : 0), duration: () => (yp.getDuration ? yp.getDuration() : 0),
          play: () => yp.playVideo && yp.playVideo(), pause: () => yp.pauseVideo && yp.pauseVideo(), seek: t => yp.seekTo && yp.seekTo(t, true)
        };
        mediaTimers.push(setInterval(tick, 250));
      });
    } else {
      const v = wrap.querySelector('video');
      if (!v) return;
      api = { time: () => v.currentTime, duration: () => v.duration || 0, play: () => v.play().catch(() => { }), pause: () => v.pause(), seek: t => { v.currentTime = t; } };
      v.addEventListener('timeupdate', tick);
      v.addEventListener('seeking', () => { if (locked() && v.currentTime > maxT + 2) v.currentTime = maxT; });
      v.addEventListener('loadedmetadata', () => drawTicks(v.duration));
      v.addEventListener('ended', finish);
      mediaTimers.push(setInterval(() => { if (!v.paused) tick(); }, 250));
    }
  }

  // ---------- Fallsammlung (moderierte Fallarbeit) ----------
  // Zustand: state.self[b.id] = { f: Bereichsfilter, c: { Fall-id: { p: gewählte Antwort, r: 1 = Einordnung angesehen } } }
  // Notizen je Fall als Freitext unter „Block-id~Fall-id“ (fallen bei Platzmangel aus suspend_data, bleiben im Browser)
  const cbNoteId = (b, c) => b.id + '~' + c.id;
  function cbState(b) { const s = state.self[b.id] || (state.self[b.id] = { f: '', c: {} }); if (!s.c) s.c = {}; return s; }
  function cbCase(b, c) { const s = cbState(b); return s.c[c.id] || (s.c[c.id] = {}); }
  const cbNotes = (b, c) => String(loadText(cbNoteId(b, c)) || '');
  function cbDone(b, c) { const x = ((state.self[b.id] || {}).c || {})[c.id] || {}; return x.p != null || !!x.r || !!cbNotes(b, c).trim(); }
  const cbDoneCount = b => (b.cases || []).filter(c => cbDone(b, c)).length;
  const cbGoal = b => { const n = (b.cases || []).length || 1; return Math.max(1, Math.min(n, Number(b.goal) || n)); };
  let cbOpen = null; // geöffneter Fall: { bid, cid, panel: null | 'notes' | 'mc', rev, anek }

  function renderCasebank(b) {
    const s = state.self[b.id] || {}, cases = b.cases || [], goal = cbGoal(b), done = cbDoneCount(b);
    const cats = (b.categories || []).map(x => String(x).trim()).filter(Boolean);
    const f = cats.includes(s.f) ? s.f : '';
    const dots = Array.from({ length: goal }, (x, i) => `<span class="kp-cb-dot${i < done ? ' on' : ''}"></span>`).join('') + (done >= goal ? '<span class="kp-cb-ok">✓</span>' : '');
    const tabs = cats.length > 1 ? `<div class="kp-cb-tabs" role="group" aria-label="${esc(T('cbBereiche'))}">${[''].concat(cats).map(cat => {
      const n = cat ? cases.filter(c => c.cat === cat).length : cases.length;
      return `<button data-cb-filter="${esc(cat)}" aria-pressed="${f === cat}">${esc(cat || T('cbAlle'))} <span>${n}</span></button>`;
    }).join('')}</div>` : '';
    const cards = cases.map((c, i) => ({ c, i })).filter(x => !f || x.c.cat === f).map(({ c, i }) => {
      const d = cbDone(b, c);
      return `<button class="kp-cb-card${d ? ' done' : ''}" data-cb-open="${esc(c.id)}">
        <span class="kp-cb-top">${c.cat ? `<span class="kp-cb-badge">${esc(c.cat)}</span>` : ''}<span class="kp-cb-no">${T('cbFall')} ${i + 1}</span>${d ? '<span class="kp-cb-check" aria-hidden="true">✓</span>' : ''}</span>
        <span class="kp-cb-t">${esc(c.title || '')}</span>${c.card ? `<span class="kp-cb-s">${esc(c.card)}</span>` : ''}
        <span class="kp-cb-cfoot"><span class="kp-cb-status">${d ? T('cbBesprochen') : T('cbOffen')}</span><span class="kp-cb-go">${T('cbOeffnen')} ▸</span></span></button>`;
    }).join('');
    return `<div class="kp-casebank" data-casebank="${b.id}">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}</div>` : ''}
      ${plainText(b.intro) ? `<div class="kp-text">${res(b.intro)}</div>` : ''}
      <div class="kp-cb-progress"><span class="kp-cb-dots" aria-hidden="true">${dots}</span><span role="status">${esc(T('cbStand').replace('{n}', Math.min(done, goal)).replace('{z}', goal).replace('{m}', cases.length))}</span></div>
      ${tabs}<div class="kp-cb-grid">${cards}</div>
      <div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-cb-ml="${b.id}">${icon('book')} ${T('cbMl')}</button></div></div>`;
  }

  function cbModalHtml(b, c) {
    const x = cbCase(b, c), o = cbOpen, cases = b.cases || [], i = cases.indexOf(c), opts = c.options || [];
    const notes = cbNotes(b, c);
    const person = c.anecdote && plainText(c.anecdote.text) ? personOf(c.anecdote) : null;
    const anek = person ? `<div class="kp-cb-anek${o.anek ? ' open' : ''}">
        <button class="kp-cb-anek-head" data-cb-anek aria-expanded="${!!o.anek}" aria-label="${esc(T('cbAnekdote') + (person.name ? ': ' + person.name : ''))}">${avatarHtml(person, 'happy')}<span class="kp-cb-anek-badge" aria-hidden="true">${icon('chat')}</span></button>
        ${o.anek ? `<div class="kp-cb-anek-tip" role="note"><b>${esc(person.name || '')}${person.role ? ' · ' + esc(person.role) : ''}</b><p>„${esc(c.anecdote.text)}“</p></div>` : ''}</div>` : '';
    const sw = (key, ic, t, sub, tag) => `<button class="kp-cb-sw${o.panel === key ? ' on' : ''}" data-cb-panel="${key}" aria-expanded="${o.panel === key}"><span class="kp-cb-sw-ic" aria-hidden="true">${ic}</span><span><b>${t}</b><small>${sub}</small></span>${tag ? `<span class="kp-cb-tag">${tag}</span>` : ''}</button>`;
    let panel = '';
    if (o.panel === 'notes') panel = `<div class="kp-cb-panel"><textarea class="kp-notes" data-cb-notes rows="4" aria-label="${esc(T('cbUeberlegungen'))}" placeholder="${esc(c.notePrompt || T('cbNotizHinweis'))}">${esc(notes)}</textarea><p class="kp-label">${esc(T('cbNotizGespeichert'))}</p></div>`;
    if (o.panel === 'mc' && opts.length) {
      const picked = x.p != null ? opts[x.p] : null;
      panel = `<div class="kp-cb-panel"><p class="kp-label">${esc(T('cbAuswahl'))}</p><div class="kp-cb-opts">${opts.map((op, k) => {
        const cls = !picked ? '' : k === x.p ? (op.correct ? ' ok' : ' no') : op.correct ? ' reveal' : ' dim';
        return `<button class="kp-cb-opt${cls}" ${picked ? 'aria-disabled="true"' : `data-cb-pick="${k}"`}><span class="kp-cb-k" aria-hidden="true">${String.fromCharCode(65 + k)}</span><span>${esc(op.text)}</span></button>`;
      }).join('')}</div>
        ${picked ? `<div class="kp-feedback ${picked.correct ? 'ok' : 'no'}" role="status"><strong>${picked.correct ? T('cbPasst') : T('cbNichtGanz')}</strong> ${esc(picked.feedback || '')}</div>
          <div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-cb-reset>↺ ${T('cbReset')}</button></div>` : ''}</div>`;
    }
    const reveal = plainText(c.reveal) || c.takeaway ? `<div class="kp-cb-acc${o.rev ? ' open' : ''}"><button class="kp-cb-acc-btn" data-cb-reveal aria-expanded="${!!o.rev}"><span aria-hidden="true">${icon('bulb')}</span> <b>${T('cbEinordnung')}</b>${x.r ? `<span class="kp-cb-tag">${T('cbAngesehen')}</span>` : ''}<span class="kp-cb-chev" aria-hidden="true">▾</span></button>
      ${o.rev ? `<div class="kp-cb-acc-body"><div class="kp-text">${res(c.reveal || '')}</div>${c.takeaway ? `<div class="kp-cb-merk"><span>${T('cbMerksatz')}</span><strong>${esc(c.takeaway)}</strong></div>` : ''}</div>` : ''}</div>` : '';
    const allDone = cases.every(y => cbDone(b, y));
    return `<div class="kp-cb-panelwrap">
      <div class="kp-cb-head"><div><span class="kp-cb-eyebrow">${c.cat ? esc(c.cat) + ' · ' : ''}${T('cbFall')} ${i + 1} ${T('von')} ${cases.length}</span><h2 id="cb-t-${b.id}">${esc(c.title || '')}</h2></div><button class="kp-cb-x" data-cb-close aria-label="${esc(T('cbZurueck'))}">✕</button></div>
      <div class="kp-cb-body">
        ${plainText(c.scenario) ? `<div class="kp-cb-sit"><div><span class="kp-cb-lb">${T('cbSzenario')}</span><div class="kp-text">${res(c.scenario)}</div></div>${anek}</div>` : anek}
        ${c.question ? `<div class="kp-cb-lead"><span class="kp-cb-lb">${T('cbLeitfrage')}</span><p>${esc(c.question)}</p></div>` : ''}
        <div class="kp-cb-sws">${sw('notes', '✎', T('cbUeberlegungen'), T('cbNotieren'), notes.trim() ? T('cbNotiert') : '')}${opts.length ? sw('mc', '☰', T('cbVergleichen'), T('cbMc'), x.p != null ? T('cbGewaehlt') : '') : ''}</div>
        ${panel}${reveal}
      </div>
      <div class="kp-cb-foot"><button class="kp-btn kp-sec" data-cb-close>◀ ${T('cbZurueck')}</button>${allDone ? `<button class="kp-btn" data-cb-close>${T('cbFertig')}</button>` : `<button class="kp-btn" data-cb-next>${T('cbNaechster')} ▶</button>`}</div></div>`;
  }
  function cbModal(cls) {
    let m = root.querySelector('.kp-cb-modal');
    if (!m) {
      m = document.createElement('div');
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      m.addEventListener('keydown', e => { if (e.key === 'Escape') cbClose(); });
      m.addEventListener('mousedown', e => { if (e.target === m) cbClose(); });
      root.appendChild(m);
    }
    m.className = 'kp-cb-modal ' + cls;
    return m;
  }
  function cbShow(b, cid) {
    const c = (b.cases || []).find(x => x.id === cid);
    if (!c) return;
    const again = cbOpen && cbOpen.bid === b.id && cbOpen.cid === cid && root.querySelector('.kp-cb-modal.kp-cb-case');
    if (!cbOpen || cbOpen.bid !== b.id || cbOpen.cid !== cid) cbOpen = { bid: b.id, cid, panel: null, rev: false, anek: false };
    const m = cbModal('kp-cb-case');
    const old = m.querySelector('.kp-cb-body'), top = old ? old.scrollTop : 0;
    m.setAttribute('aria-labelledby', 'cb-t-' + b.id);
    m.innerHTML = cbModalHtml(b, c);
    const body = m.querySelector('.kp-cb-body');
    if (again) body.scrollTop = top; else body.scrollTop = 0;
    const ta = m.querySelector('[data-cb-notes]');
    if (ta) ta.oninput = () => {
      saveText(cbNoteId(b, c), ta.value);
      const tag = m.querySelector('[data-cb-panel="notes"]');
      if (tag && !tag.querySelector('.kp-cb-tag') && ta.value.trim()) tag.insertAdjacentHTML('beforeend', `<span class="kp-cb-tag">${T('cbNotiert')}</span>`);
    };
    if (!again) m.querySelector('.kp-cb-x').focus();
  }
  function cbClose() {
    const m = root.querySelector('.kp-cb-modal');
    if (m) m.remove();
    if (!cbOpen) return;
    const { bid, cid } = cbOpen;
    cbOpen = null;
    const b = findBlock(bid), box = root.querySelector(`[data-casebank="${bid}"]`);
    if (b && box) refreshBlock(box, renderCasebank(b)); else report();
    const card = root.querySelector(`[data-casebank="${bid}"] [data-cb-open="${cid}"]`);
    if (card) card.focus({ preventScroll: true });
  }
  // Musterlösung: alle Fälle, auch nicht besprochene, mit Wahl und Notizen der Gruppe
  function cbMlBody(list) {
    return list.map(b => `<section class="kp-cb-ml-sec">${list.length > 1 || b.title ? `<h3>${esc(String(b.title || '').replace(/\*/g, ''))}</h3>` : ''}
      ${(b.cases || []).map((c, i) => {
        const x = ((state.self[b.id] || {}).c || {})[c.id] || {}, right = (c.options || []).filter(o => o.correct), notes = cbNotes(b, c).trim();
        const chosen = x.p != null ? (c.options || [])[x.p] : null;
        return `<article class="kp-cb-ml-item"><header><span class="kp-cb-ml-no">${i + 1}</span><div><span class="kp-cb-eyebrow">${esc(c.cat || '')}</span><h4>${esc(c.title || '')}</h4></div><span class="kp-cb-ml-state${cbDone(b, c) ? ' on' : ''}">${cbDone(b, c) ? '✓ ' + T('cbImKurs') : T('cbNichtGewaehlt')}</span></header>
          ${c.question ? `<p class="kp-cb-ml-q">${esc(c.question)}</p>` : ''}
          ${right.length ? `<p><strong>${T('cbPassend')}:</strong> ${right.map(o => esc(o.text)).join(' · ')}</p>` : ''}
          ${plainText(c.reveal) ? `<div class="kp-text">${res(c.reveal)}</div>` : ''}
          ${c.takeaway ? `<p class="kp-cb-ml-merk">${esc(c.takeaway)}</p>` : ''}
          ${c.anecdote && plainText(c.anecdote.text) ? `<p class="kp-cb-ml-sub"><strong>${esc(personOf(c.anecdote).name || T('cbAnekdote'))}:</strong> „${esc(c.anecdote.text)}“</p>` : ''}
          ${chosen ? `<p class="kp-cb-ml-sub">${chosen.correct ? '✓' : '!'} ${T('cbGewaehltImKurs')}: „${esc(chosen.text)}“</p>` : ''}
          ${notes ? `<p class="kp-cb-ml-sub">${T('cbNotizAusKurs')}: „${esc(notes)}“</p>` : ''}</article>`;
      }).join('')}</section>`).join('');
  }
  function cbShowMl(bid) {
    const list = bid ? [findBlock(bid)].filter(Boolean) : pages.flatMap(p => (p.blocks || []).filter(x => x.type === 'casebank'));
    if (!list.length) return;
    closeDrawer();
    cbOpen = null;
    const m = cbModal('kp-cb-mlmodal');
    m.setAttribute('aria-labelledby', 'cb-ml-title');
    m.innerHTML = `<div class="kp-cb-panelwrap"><div class="kp-cb-head"><div><span class="kp-cb-eyebrow">${esc(course.title || '')}</span><h2 id="cb-ml-title">${T('cbMl')}</h2></div><button class="kp-cb-x" data-cb-close aria-label="${esc(T('schliessen'))}">✕</button></div>
      <div class="kp-cb-body">${cbMlBody(list)}</div>
      <div class="kp-cb-foot"><button class="kp-btn kp-sec" data-cb-print="${bid || ''}">${icon('book')} ${T('cbDrucken')}</button><button class="kp-btn" data-cb-close>${T('schliessen')}</button></div></div>`;
    m.querySelector('.kp-cb-x').focus();
  }
  function cbPrint(bid) {
    const list = bid ? [findBlock(bid)].filter(Boolean) : pages.flatMap(p => (p.blocks || []).filter(x => x.type === 'casebank'));
    printWindow(T('cbMl'), `body { font-family: ${theme.font || 'Segoe UI, sans-serif'}; color: #1d2530; max-width: 760px; margin: 30px auto; padding: 0 20px; line-height: 1.5; }
      h1 { color: ${theme.primary || '#1f3a5f'}; font-size: 24px; } h3 { margin: 26px 0 8px; color: ${theme.primary || '#1f3a5f'}; }
      article { border-bottom: 1px solid #e4e9ef; padding: 12px 0; } header { display: flex; gap: 10px; align-items: baseline; } h4 { margin: 0; font-size: 16px; }
      .kp-cb-ml-no { font-weight: 700; } .kp-cb-eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #5d6877; display: block; } .kp-cb-ml-state { margin-left: auto; font-size: 12px; color: #5d6877; }
      .kp-cb-ml-q { font-weight: 700; } .kp-cb-ml-sub { color: #444; font-size: 14px; }`,
      `<h1>${esc(T('cbMl'))}</h1><p>${esc(course.title || '')} · ${new Date().toLocaleDateString('de-DE')}</p>${cbMlBody(list)}`);
  }
  function cbStep(dir) {
    if (!cbOpen) return;
    const b = findBlock(cbOpen.bid), cases = b.cases || [];
    const i = cases.findIndex(c => c.id === cbOpen.cid);
    for (let n = 1; n <= cases.length; n++) {
      const c = cases[(i + n * dir + cases.length * n) % cases.length];
      if (!cbDone(b, c)) { cbOpen = null; return cbShow(b, c.id); }
    }
    cbClose();
  }

  // ---------- Trainer-Modus (settings.trainerMode) ----------
  // Schublade mit freien Notizen, Sammelansicht aus der Fallarbeit und Reflexionen, Export und „Lösungen zeigen“
  const trainerKey = 'kurs-trainer-' + (course.id || 'kurs');
  function trainerEntries() {
    const out = [];
    pages.forEach(p => (p.blocks || []).forEach(b => {
      if (b.type === 'casebank') (b.cases || []).forEach(c => {
        if (!cbDone(b, c)) return;
        const x = ((state.self[b.id] || {}).c || {})[c.id] || {}, chosen = x.p != null ? (c.options || [])[x.p] : null;
        out.push({ src: String(b.title || T('cbFallarbeit')).replace(/\*/g, ''), title: c.title || '', rows: [[T('cbLeitfrage'), c.question], [T('cbUeberlegungen'), cbNotes(b, c)], [T('cbGewaehltImKurs'), chosen ? chosen.text + (chosen.correct ? ' (passend)' : ' (greift zu kurz)') : ''], [T('cbMerksatz'), x.r ? c.takeaway : '']].filter(r => String(r[1] || '').trim()) });
      });
      if ((b.type === 'reflection' || b.type === 'actionplan') && state.texts[b.id] != null) {
        const v = state.texts[b.id];
        out.push({ src: String(p.title || '').replace(/\*/g, ''), title: plainText(b.prompt || b.title || ''), rows: Array.isArray(v) ? (b.fields || []).map((f, i) => [f.label, v[i]]).filter(r => String(r[1] || '').trim()) : [['', v]] });
      }
    }));
    return out;
  }
  function trainerExport() {
    let notes = '';
    try { notes = localStorage.getItem(trainerKey) || ''; } catch (e) { /* kein Speicher */ }
    const line = '-'.repeat(56);
    return `${T('trTitel')}: ${course.title || ''}\n${new Date().toLocaleString('de-DE')}\n${line}\n\n${T('trFreieNotizen').toUpperCase()}\n${notes.trim() || '–'}\n\n${line}\n${T('trAusKurs').toUpperCase()}\n` +
      (trainerEntries().map(e => `\n[${e.src}] ${e.title}\n` + e.rows.map(r => `  ${r[0] ? r[0] + ': ' : ''}${String(r[1]).trim()}`).join('\n')).join('\n') || '–') + '\n';
  }
  function trainerDrawerBody() {
    let saved = '';
    try { saved = localStorage.getItem(trainerKey) || ''; } catch (e) { /* kein Speicher */ }
    const banks = pages.flatMap(p => (p.blocks || []).filter(x => x.type === 'casebank'));
    const entries = trainerEntries();
    return `<p class="kp-label">${T('trFreieNotizen')}</p>
      <textarea class="kp-notes" data-tr-notes aria-label="${esc(T('trFreieNotizen'))}" placeholder="${esc(T('trPlatzhalter'))}">${esc(saved)}</textarea>
      <div class="kp-tr-actions"><button class="kp-btn kp-sec" data-tr-copy>${T('trKopieren')}</button><button class="kp-btn kp-sec" data-tr-save>${T('trSpeichern')}</button></div>
      <p class="kp-label" data-tr-status role="status"></p>
      <h3 class="kp-tr-h">${T('trAusKurs')}</h3>
      ${entries.length ? entries.map(e => `<div class="kp-tr-entry"><span class="kp-cb-eyebrow">${esc(e.src)}</span><b>${esc(e.title)}</b>${e.rows.map(r => `<p>${r[0] ? `<em>${esc(r[0])}:</em> ` : ''}${esc(String(r[1]).trim())}</p>`).join('')}</div>`).join('') : `<p class="kp-label">${T('trLeer')}</p>`}
      <h3 class="kp-tr-h">${T('trWerkzeuge')}</h3>
      ${banks.length ? `<p><button class="kp-btn kp-sec" data-cb-ml="">${icon('book')} ${T('cbMl')}</button></p>` : ''}
      <p><button class="kp-btn kp-sec" data-tr-solve>✓ ${T('trLoesen')}</button></p><p class="kp-label">${T('trLoesenHinweis')}</p>`;
  }
  // „Lösungen zeigen“: setzt Fallsammlungen und Fragen auf die richtige Antwort (für Vorführung und Abnahme)
  function solveAll() {
    pages.forEach(p => (p.blocks || []).forEach(b => {
      if (b.type !== 'casebank') return;
      (b.cases || []).forEach(c => { const x = cbCase(b, c), k = (c.options || []).findIndex(o => o.correct); if (k >= 0) x.p = k; x.r = 1; });
    }));
    items.forEach(it => {
      if (!it.q || it.branch) return;
      const q = it.q;
      let a = null;
      if (q.kind === 'truefalse') a = [q.correctBool !== false ? 0 : 1];
      else if (q.kind === 'order') a = (q.items || []).map((x, i) => i);
      else if (q.kind === 'match') a = (q.pairs || []).map((x, i) => i);
      else if (q.kind === 'fill') a = fillSolutions(q).map(s => s[0]);
      else if (q.kind === 'hotspot') { const s = (q.spots || []).find(x => x.correct); if (s) a = [s.x, s.y]; }
      else { const r = normAnswers(q).map((x, i) => x.correct ? i : -1).filter(i => i >= 0); if (r.length) a = r; }
      if (a) { state.answers[it.id] = a; state.tries[it.id] = (state.tries[it.id] || 0) + 1; }
    });
    closeDrawer();
    report();
    render();
  }
  function saveTextFile(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ---------- Mini-Missionen (Runtime js/vendor/mini-missionen.js) ----------
  // Ergebnisse je Mission unter state.self.mm[id] = { ok, e, r, k } (gelöst, Fehler, Lösung gezeigt, übersprungen)
  const missionRank = r => !r ? -1 : r.ok ? (r.r ? 1 : 2) : 0;
  function setupMission(el) {
    const b = findBlock(el.dataset.mission);
    const MM = window.MiniMissionen;
    if (!b || !MM || el.dataset.ready) return;
    el.dataset.ready = '1';
    let theme = course.missionTheme || '';
    if (!theme) theme = MM.suggestTheme(course.title || '').preset;
    const cfg = { id: b.id, type: b.mechanic, theme, title: b.title || '', intro: b.intro || '', hint: b.hint || '', successText: b.successText || '',
      skippable: b.skippable !== false, sound: !!b.sound, headingLevel: 'h2', data: b.data || {} };
    let m;
    try {
      m = MM.mount(el, cfg, {
        loadResults: () => state.self.mm || {},
        saveResults: all => {
          // Das beste Ergebnis bleibt stehen: wer eine gelöste Mission noch einmal überspringt, verliert es nicht
          const keep = state.self.mm || {};
          Object.keys(all).forEach(k => { if (missionRank(all[k]) >= missionRank(keep[k])) keep[k] = all[k]; });
          state.self.mm = keep;
        },
        onComplete: () => { renderFooter(); report(); },
        onNavigate: page => {
          const i = pageIndexById(page) >= 0 ? pageIndexById(page) : Number(page) - 1;
          if (i >= 0 && i < pages.length) go(i);
        }
      });
    } catch (e) { el.textContent = 'Die Mini-Mission konnte nicht aufgebaut werden.'; return; }
    // Farben und Schrift aus dem Stil-Paket statt der festen Farben der Runtime
    const r = m.root;
    // Die Runtime schreibt weisse Schrift auf --mm-panel und benutzt --mm-panel als Schrift
    // auf --mm-accent. Beides setzt eine dunkle Flaeche voraus. Eine helle Hauptfarbe
    // (etwa #2B7FFF: Weiss darauf nur 3,8 : 1) wird deshalb abgedunkelt, bis 4,5 : 1 steht.
    // panel traegt weisse Schrift und ist zugleich die Schrift auf --mm-accent, deshalb 7 : 1;
    // panel2 (Kacheln, Blasen) traegt nur weisse Schrift, dort reichen 4,5 : 1.
    const panel = darkEnough(cssColor('--kp-primary') || [31, 58, 95], 7);
    const panel2 = darkEnough((cssColor('--kp-primary') || [31, 58, 95]).map(x => Math.min(255, Math.round(x * 1.3) + 12)), 4.5);
    // Die Akzentfarbe traegt panel als Schrift (Knoepfe, Nummern): eine dunkle Akzentfarbe wird
    // dafuer aufgehellt, bis 4,5 : 1 gegen panel stehen (Sichtpruefung: „Fertig“ auf #b44c2c nur 3,4 : 1).
    const accent = lightEnough(cssColor('--kp-accent') || [200, 120, 26], panel2, 4.5); // panel2 ist die hellere Flaeche, damit passt es auch auf panel
    [['panel', `rgb(${panel.join(',')})`], ['panel2', `rgb(${panel2.join(',')})`],
      ['accent', `rgb(${accent.join(',')})`], ['text', '#fff'],
      ['muted', 'color-mix(in srgb, #fff 70%, var(--kp-primary))'], ['font', 'var(--kp-font)'], ['wire-0', 'var(--kp-accent)']].forEach(([k, v]) => r.style.setProperty('--mm-' + k, v));
    mediaTimers.push({ stop: () => m.destroy() });
  }

  // Eine Farbe aus dem Stylesheet als [r,g,b] lesen (Hex oder rgb)
  function cssColor(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const h = v.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (h) return h.slice(1).map(x => parseInt(x, 16));
    const n = v.match(/\d+(\.\d+)?/g);
    return n && n.length >= 3 ? n.slice(0, 3).map(Number) : null;
  }
  // So weit abdunkeln, bis weisse Schrift darauf das verlangte Verhaeltnis erreicht
  function darkEnough(c, ziel) {
    const lum = x => { const v = x.map(y => { y /= 255; return y <= 0.03928 ? y / 12.92 : Math.pow((y + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    let out = c.slice();
    for (let k = 0; k < 30 && 1.05 / (lum(out) + 0.05) < (ziel || 4.5); k++) out = out.map(x => Math.round(x * 0.88));
    return out;
  }
  // Farbe schrittweise Richtung Weiss mischen, bis sie gegen die dunkle Flaeche das Ziel erreicht
  function lightEnough(c, dark, ziel) {
    const lum = x => { const v = x.map(y => { y /= 255; return y <= 0.03928 ? y / 12.92 : Math.pow((y + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const ld = lum(dark);
    let out = c.slice();
    for (let k = 0; k < 30 && (lum(out) + 0.05) / (ld + 0.05) < (ziel || 4.5); k++) out = out.map(x => Math.min(255, Math.round(x + (255 - x) * 0.12)));
    return out;
  }

  // ---------- Lottie ----------
  const LOTTIE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js';
  function setupLottie(el) {
    const b = findBlock(el.dataset.lottie);
    if (!b || el.dataset.ready) return;
    el.dataset.ready = '1';
    const src = b.src ? res(b.src) : b.url;
    if (!src) { el.innerHTML = '<p class="kp-label">Keine Animation hinterlegt.</p>'; return; }
    // In der Vorschau des Tools liegt Lottie schon im Elternfenster (offline); im LMS ist das Elternfenster fremd
    if (!window.lottie) { try { if (window.parent !== window && window.parent.lottie) window.lottie = window.parent.lottie; } catch (e) { /* fremdes Fenster */ } }
    const lib = window.lottie ? Promise.resolve() : loadScript(LOTTIE_CDN);
    Promise.all([lib, fetch(src).then(r => r.json())]).then(([, data]) => {
      const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      const anim = window.lottie.loadAnimation({ container: el, renderer: 'svg', loop: b.loop !== false, autoplay: false, animationData: data });
      anim.setSpeed(Number(b.speed) || 1);
      if (reduce) return anim.goToAndStop(0, true);
      if (b.play === 'click') {
        el.style.cursor = 'pointer';
        el.tabIndex = 0;
        const toggle = () => (anim.isPaused ? anim.play() : anim.pause());
        el.onclick = toggle;
        el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
        anim.goToAndStop(0, true);
      } else if (b.play === 'scroll' && window.IntersectionObserver) {
        new IntersectionObserver(es => es.forEach(e => (e.isIntersecting ? anim.play() : anim.pause())), { threshold: .3 }).observe(el);
      } else {
        anim.play();
      }
    }).catch(() => { el.innerHTML = '<p class="kp-label">Die Animation konnte nicht geladen werden.</p>'; });
  }

  // Erklärsequenz steuern
  function setupSequence(box) {
    const b = findBlock(box.dataset.seq);
    if (!b || box.dataset.ready) return;
    box.dataset.ready = '1';
    const steps = b.steps || [];
    const audio = box.querySelector('[data-seq-audio]');
    const stage = box.querySelector('.kp-seq-stage');
    const playBtn = box.querySelector('[data-seq-play]');
    let timer = null;
    const show = idx => {
      idx = Math.max(0, Math.min(steps.length - 1, idx));
      if (idx === state.seq[b.id]) return;
      state.seq[b.id] = idx;
      stage.innerHTML = seqStage(b, idx);
      box.querySelector('.kp-seq-prog b').style.width = (idx + 1) / steps.length * 100 + '%';
      box.querySelector('.kp-seq-count').textContent = `${idx + 1} / ${steps.length}`;
    };
    if (state.seq[b.id] == null) state.seq[b.id] = 0;
    const setPlaying = on => { playBtn.textContent = on ? '❚❚' : '▶'; playBtn.setAttribute('aria-label', on ? 'Pause' : 'Abspielen'); };
    const stepAt = t => { let i = 0; steps.forEach((s, k) => { if ((Number(s.start) || 0) <= t) i = k; }); return i; };
    if (audio) {
      audio.addEventListener('timeupdate', () => show(stepAt(audio.currentTime)));
      audio.addEventListener('play', () => setPlaying(true));
      audio.addEventListener('pause', () => setPlaying(false));
      audio.addEventListener('ended', () => setPlaying(false));
    }
    const autoNext = () => {
      const cur = state.seq[b.id];
      if (cur >= steps.length - 1) { timer = null; setPlaying(false); return; }
      timer = setTimeout(() => { show(cur + 1); autoNext(); }, Math.max(2500, plainText(steps[cur + 1] && steps[cur + 1].html).split(' ').length * 350));
    };
    playBtn.onclick = () => {
      if (audio) {
        if (audio.paused) { stopSound(); audio.currentTime = Number(steps[state.seq[b.id]].start) || 0; audio.play(); } else audio.pause();
        return;
      }
      if (timer) { clearTimeout(timer); timer = null; setPlaying(false); } else { setPlaying(true); autoNext(); }
    };
    const jump = d => {
      const idx = Math.max(0, Math.min(steps.length - 1, state.seq[b.id] + d));
      if (audio) { audio.currentTime = Number(steps[idx].start) || 0; if (audio.paused) show(idx); }
      else show(idx);
    };
    box.querySelector('[data-seq-prev]').onclick = () => jump(-1);
    box.querySelector('[data-seq-next]').onclick = () => jump(1);
    mediaTimers.push({ stop: () => { clearTimeout(timer); if (audio) audio.pause(); } });
  }

  // Freitexte bleiben zusätzlich im Browser, weil SCORM 1.2 wenig Platz hat
  const textKey = id => 'kurs-text-' + (course.id || 'kurs') + '-' + id;
  function loadText(id) {
    if (state.texts[id] != null) return state.texts[id];
    try { const v = localStorage.getItem(textKey(id)); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function saveText(id, v) {
    state.texts[id] = v;
    try { localStorage.setItem(textKey(id), JSON.stringify(v)); } catch (e) { /* kein Speicher */ }
  }

  function renderReflection(b) {
    const saved = loadText(b.id);
    const done = state.texts[b.id] != null;
    const before = plainText(b.before) ? b.before : '';
    const rw = done && before && b.sample
      ? `<div class="kp-rw" role="status"><div class="kp-rw-col kp-rw-old"><p class="kp-label">${T('rwVorher')}</p><div class="kp-text">${res(before)}</div></div>
          <div class="kp-rw-col kp-rw-mine"><p class="kp-label">${T('rwDeine')}</p><p>${esc(saved || '').replace(/\n/g, '<br>')}</p></div>
          <div class="kp-rw-col kp-rw-model"><p class="kp-label">${T('rwMuster')}</p><div class="kp-text">${res(b.sample)}</div></div></div>` : '';
    return `<div class="kp-reflect" data-reflect="${b.id}">
      <p class="kp-label">${before ? T('rwTitel') : 'Reflexion'}</p>
      <h2 class="kp-q">${esc(b.prompt)}</h2>
      ${before && !done ? `<div class="kp-rw-before"><p class="kp-label">${T('rwVorher')}</p><div class="kp-text">${res(before)}</div></div>` : ''}
      <textarea data-reflect-text aria-label="${esc(b.prompt)}" placeholder="${esc(b.placeholder || 'Deine Gedanken …')}">${esc(saved || '')}</textarea>
      <div class="kp-quiz-actions"><button class="kp-btn" data-reflect-save="${b.id}">${done ? 'Aktualisieren' : (b.sample ? 'Speichern und Musterantwort ansehen' : 'Speichern')}</button>${done ? '<span class="kp-saved" role="status">✔ gespeichert</span>' : ''}</div>
      ${rw || (done && b.sample ? `<div class="kp-note kp-text kp-sample"><strong>${T('zumVergleich')}</strong>${res(b.sample)}</div>` : '')}
      ${done ? reflectCriteria(b) : ''}
    </div>`;
  }
  // Kriterien zum Selbst-Abhaken nach dem Speichern: Stand in state.self[id].crit (Indizes)
  function reflectCriteria(b) {
    const list = (b.criteria || []).filter(t => String(t || '').trim());
    if (!list.length) return '';
    const c = (state.self[b.id] || {}).crit || [];
    return `<div class="kp-crit" data-crit="${b.id}"><p class="kp-label">${T('kritTitel')}</p><p class="kp-crit-hint">${T('kritHinweis')}</p>
      <ul class="kp-cl-list">${list.map((t, i) => `<li><label class="${c.includes(i) ? 'done' : ''}"><input type="checkbox" data-crit-item="${i}" ${c.includes(i) ? 'checked' : ''}><span>${esc(t)}</span></label></li>`).join('')}</ul>
      ${critStatus(b)}</div>`;
  }
  function critStatus(b) {
    const n = (b.criteria || []).filter(t => String(t || '').trim()).length;
    const c = (state.self[b.id] || {}).crit || [];
    const all = c.length >= n;
    return `<p class="kp-cl-status ${all ? 'all' : ''}" data-crit-status role="status">${all ? T('kritAlle') : `${c.length} ${T('von')} ${n} ${T('kritErfuellt')}`}</p>`;
  }

  function renderPlan(b) {
    const saved = loadText(b.id) || [];
    const done = state.texts[b.id] != null;
    return `<div class="kp-plan" data-plan="${b.id}">
      <p class="kp-label">Umsetzungsplan</p>
      <h2 class="kp-q">${esc(b.title || 'Mein Umsetzungsplan')}</h2>
      ${b.intro ? `<div class="kp-text" style="margin-bottom:14px">${res(b.intro)}</div>` : ''}
      ${(b.fields || []).map((f, i) => `<div class="kp-plan-row"><label for="pl-${b.id}-${i}">${esc(f.label)}</label>
        <textarea id="pl-${b.id}-${i}" data-plan-field="${i}" placeholder="${esc(f.placeholder || '')}">${esc(saved[i] || '')}</textarea></div>`).join('')}
      <div class="kp-quiz-actions">
        <button class="kp-btn" data-plan-save="${b.id}">${done ? 'Aktualisieren' : 'Plan speichern'}</button>
        <button class="kp-btn kp-sec" data-plan-print="${b.id}">Drucken oder als PDF sichern</button>
        ${done ? '<span class="kp-saved" role="status">✔ gespeichert</span>' : ''}
      </div></div>`;
  }

  function renderSurvey(b) {
    const s = state.survey[b.id];
    const scale = Number(b.scale) || 5;
    if (s) return `<div class="kp-survey"><p class="kp-label">Rückmeldung</p><h2 class="kp-q">${esc(b.thanks || 'Danke für deine Rückmeldung!')}</h2></div>`;
    return `<div class="kp-survey" data-survey="${b.id}">
      <p class="kp-label">Rückmeldung</p><h2 class="kp-q">${esc(b.title || 'Wie hat dir der Kurs gefallen?')}</h2>
      ${(b.statements || []).map((st, i) => `<div class="kp-survey-row"><span id="sv-${b.id}-${i}">${esc(st)}</span>
        <div class="kp-scale" role="radiogroup" aria-labelledby="sv-${b.id}-${i}">${Array.from({ length: scale }, (v, k) => `<label title="${k + 1}"><input type="radio" name="s-${b.id}-${i}" value="${k + 1}">${k + 1}</label>`).join('')}</div></div>`).join('')}
      <p class="kp-scale-legend"><span>1 = ${esc(b.low || 'trifft nicht zu')}</span><span>${scale} = ${esc(b.high || 'trifft voll zu')}</span></p>
      ${b.comment !== false ? `<div class="kp-plan-row" style="margin-top:14px"><label for="svc-${b.id}">${esc(b.commentLabel || 'Was möchtest du uns noch mitgeben? (optional)')}</label><textarea id="svc-${b.id}" data-survey-comment></textarea></div>` : ''}
      <div class="kp-quiz-actions"><button class="kp-btn" data-survey-send="${b.id}">Absenden</button></div></div>`;
  }

  // ---------- Zertifikat ----------
  let lmsName = '';
  function learnerName() {
    if (state.name) return state.name;
    const raw = String(lmsName || '').trim();
    return raw.indexOf(',') > 0 ? raw.split(',').map(s => s.trim()).reverse().join(' ') : raw;
  }
  // Vorname für die Anrede; leer ohne LMS, ohne Namen oder wenn die Anrede abgeschaltet ist
  function firstName() {
    if (set.greet === false) return '';
    const n = learnerName().replace(/\s+/g, ' ').trim();
    if (!n || /^(unknown|undefined|null|student|learner)$/i.test(n)) return '';
    return n.split(' ')[0];
  }
  function certReady(b) {
    if (!graded().length) return { ok: true };
    const s = score();
    if (s.open) return { ok: false, why: 'Das Zertifikat steht bereit, sobald alle Testfragen beantwortet sind.' };
    if (b.requirePass !== false && s.pct < passScore) return { ok: false, why: `Das Zertifikat gibt es ab ${passScore} % im Test. Du hast ${s.pct} % erreicht.` };
    return { ok: true, s };
  }
  // Kursmotiv für das Zertifikat: eigenes Bild am Block, sonst das Foto des Titelbereichs
  function certMotif(b) {
    if (b.image && b.image.src) return res(b.image.src);
    for (const p of pages) for (const x of (p.blocks || [])) if (x.type === 'hero' && x.image && x.image.src) return res(x.image.src);
    return '';
  }
  // Der eigene Vorsatz (Wenn-Dann-Plan aus einer Reflexion, b.planRef) steht auf dem Zertifikat und auf der Ergebnisseite:
  // das Ende trägt die Erinnerung (Peak-End), und der selbst geschriebene Satz wirkt stärker als jede Zusammenfassung (Gollwitzer & Sheeran 2006)
  function certPlan(b) {
    if (!b || !b.planRef) return '';
    const v = loadText(b.planRef);
    return typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.filter(Boolean).join(' · ') : '';
  }
  const certBlock = () => { for (const p of pages) for (const x of (p.blocks || [])) if (x.type === 'certificate') return x; return null; };
  function planCard(b) {
    const v = certPlan(b);
    if (!v) return '';
    return `<div class="kp-plan-card"><span class="kp-label">${T('deinVorsatz')}</span><p>${esc(v)}</p></div>`;
  }
  // Drei Wiederholungstermine als Kalenderdatei (iCalendar): morgen, in einer Woche, in einem Monat (Cepeda u. a. 2006). Läuft offline, ohne Dienst.
  function calendarIcs(b, now) {
    const start = now || new Date();
    const pad = n => String(n).padStart(2, '0');
    const day = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const stamp = `${day(start)}T${pad(start.getHours())}${pad(start.getMinutes())}00`;
    const clean = t => String(t || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');
    const title = T('kalenderTitel').replace('{k}', plainTitle(course.title));
    const plan = certPlan(b);
    // Drei Fragen aus dem Kurs (bewertete zuerst), damit der Termin eine Abrufübung ist und kein leerer Platzhalter
    const fragen = items.filter(it => it.q && it.q.question).sort((a, c) => (c.graded ? 1 : 0) - (a.graded ? 1 : 0)).slice(0, 3).map((it, i) => `${i + 1}. ${plainText(it.q.question)}`);
    const desc = [T('kalenderText'), plan ? `${T('deinVorsatz')}: ${plan}` : '', fragen.length ? `${T('kalenderFragen')}\n${fragen.join('\n')}` : ''].filter(Boolean).join('\n');
    const events = [1, 7, 30].map((add, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + add);
      const uid = `${course.id || 'kurs'}-${b.id}-${i}-${day(d)}@kurs`;
      return `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${stamp}\r\nDTSTART;VALUE=DATE:${day(d)}\r\nDTEND;VALUE=DATE:${day(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))}\r\nSUMMARY:${clean(title)} (${i + 1}/3)\r\nDESCRIPTION:${clean(desc)}\r\nEND:VEVENT`;
    });
    return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Kurs//DE\r\nCALSCALE:GREGORIAN\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`;
  }
  function renderCertificate(b) {
    const st = certReady(b);
    const motif = certMotif(b);
    return `<div class="kp-cert ${motif ? 'kp-cert-motif' : ''}" data-cert="${b.id}">
      ${motif ? `<div class="kp-cert-pic" aria-hidden="true"><img src="${esc(motif)}" alt="" loading="lazy"></div>` : ''}
      <div class="kp-cert-body">
      <div class="kp-cert-icon" aria-hidden="true">${icon('trophy', 'kp-ico-lg')}</div>
      <h2 class="kp-q">${esc(b.title || 'Teilnahmezertifikat')}</h2>
      ${st.ok ? `${learnerName() ? `<p class="kp-cert-name">${esc(learnerName())}</p>` : '<div><input type="text" data-cert-name placeholder="Dein Name für das Zertifikat" aria-label="Dein Name für das Zertifikat"></div>'}
        ${planCard(b)}
        <div class="kp-quiz-actions kp-cert-actions"><button class="kp-btn" data-cert-open="${b.id}">Zertifikat anzeigen und drucken</button>
        ${b.calendar !== false ? `<button class="kp-btn kp-sec" data-cert-ics="${b.id}">${icon('calendar')} ${T('kalenderKnopf')}</button>` : ''}</div>
        ${b.calendar !== false ? `<p class="kp-cert-hint">${esc(T('kalenderHinweis'))}</p>` : ''}` : `<p>${esc(st.why)}</p>`}
      </div>
    </div>`;
  }
  function printWindow(title, css, body) {
    const w = window.open('', '_blank');
    if (!w) { alert('Bitte erlaube Pop-up-Fenster, um drucken zu können.'); return; }
    w.document.write(`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
  }
  function openCertificate(b) {
    const s = graded().length ? score() : null;
    const name = learnerName() || (opts.preview ? 'Max Mustermann' : '');
    const date = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
    const primary = theme.primary || '#1f3a5f', accent = theme.accent || '#c8781a';
    const motif = certMotif(b);
    const logo = chrome.logo && chrome.logo.src ? `<img class="logo" src="${esc(res(chrome.logo.src))}" alt="${esc(chrome.logo.alt || '')}">` : '';
    const a = achievements();
    const facts = [a.pagesTotal ? `${a.pagesTotal} Seiten` : '', a.chaptersTotal ? `${a.chaptersTotal} Kapitel` : '', a.questions ? `${a.questions} Testfragen` : '', `${estimateMinutes()} Minuten Lernzeit`].filter(Boolean).join(' · ');
    printWindow('Zertifikat', `
      @page { size: A4 landscape; margin: 0; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { margin: 0; font-family: ${theme.font || 'Georgia, serif'}; color: #1d2530; background: #eee; }
      .page { width: 297mm; height: 210mm; margin: 0 auto; background: #fff; box-sizing: border-box; display: flex; overflow: hidden; }
      .band { width: 92mm; flex: none; position: relative; background: linear-gradient(160deg, ${primary}, color-mix(in srgb, ${primary} 55%, ${accent})); color: #fff; overflow: hidden; }
      .band img.motif { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .band .veil { position: absolute; inset: 0; background: linear-gradient(180deg, color-mix(in srgb, ${primary} 35%, transparent), color-mix(in srgb, ${primary} 92%, #000) 100%); }
      .band .deco { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); width: 46mm; height: 46mm; opacity: .28; }
      .band .course { position: absolute; left: 12mm; right: 10mm; bottom: 14mm; font-size: 17px; font-weight: 600; line-height: 1.35; text-shadow: 0 1px 4px rgba(0,0,0,.35); }
      .band .course small { display: block; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; opacity: .85; margin-bottom: 4mm; }
      .main { flex: 1; position: relative; padding: 18mm 20mm 16mm 18mm; display: flex; flex-direction: column; justify-content: center; }
      .main::before { content: ""; position: absolute; inset: 8mm 8mm 8mm 0; border: 1px solid ${accent}; border-left: 0; opacity: .5; }
      .logo { position: absolute; top: 12mm; right: 14mm; max-height: 16mm; max-width: 50mm; }
      h1 { font-size: 34px; letter-spacing: .12em; text-transform: uppercase; color: ${primary}; margin: 0 0 10mm; }
      .name { font-size: 34px; font-weight: 700; margin: 5mm 0; border-bottom: 2px solid ${accent}; display: inline-block; padding: 0 8mm 3mm 0; }
      .course-t { font-size: 22px; font-weight: 600; color: ${primary}; margin: 4mm 0; }
      .muted { color: #5d6877; font-size: 15px; }
      .facts { color: #5d6877; font-size: 13px; margin-top: 3mm; }
      .text { max-width: 150mm; margin: 6mm 0 0; font-size: 15px; line-height: 1.5; }
      .plan { border-left: 3px solid ${accent}; padding-left: 5mm; font-style: italic; } .plan small { display: block; font-style: normal; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #5d6877; margin-bottom: 1mm; }
      .foot { display: flex; justify-content: space-between; margin-top: 14mm; font-size: 14px; gap: 10mm; }
      .foot div { min-width: 55mm; border-top: 1px solid #999; padding-top: 2mm; }
      @media print { body { background: #fff; } .page { margin: 0; } }`,
      `<div class="page">
        <div class="band">${motif ? `<img class="motif" src="${esc(motif)}" alt="">` : ''}<div class="veil"></div>
          ${motif ? '' : `<svg class="deco" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${ICONS.trophy}</svg>`}
          <div class="course"><small>Zertifikat</small>${esc(plainTitle(course.title))}</div>
        </div>
        <div class="main">${logo}
          <h1>${esc(b.title || 'Teilnahmezertifikat')}</h1>
          <div class="muted">Hiermit wird bestätigt, dass</div>
          <div><span class="name">${esc(name || ' ')}</span></div>
          <div class="muted">den Kurs</div>
          <div class="course-t">${esc(plainTitle(course.title))}</div>
          <div class="muted">erfolgreich abgeschlossen hat${s && b.showScore !== false ? ` (Ergebnis: ${s.pct} %)` : ''}.</div>
          <div class="facts">${esc(facts)}</div>
          ${b.text ? `<div class="text">${esc(b.text)}</div>` : ''}
          ${certPlan(b) ? `<div class="text plan"><small>${esc(T('deinVorsatz'))}</small>${esc(certPlan(b))}</div>` : ''}
          <div class="foot"><div>${esc(date)}</div><div>${esc(b.signer || '')}</div></div>
        </div>
      </div>`);
  }
  function printPlan(b) {
    const v = loadText(b.id) || [];
    printWindow(b.title || 'Umsetzungsplan', `body { font-family: ${theme.font || 'Segoe UI, sans-serif'}; color: #1d2530; max-width: 720px; margin: 30px auto; padding: 0 20px; }
      h1 { color: ${theme.primary || '#1f3a5f'}; } h2 { font-size: 15px; margin: 22px 0 6px; color: #5d6877; text-transform: uppercase; letter-spacing: .05em; }
      p { white-space: pre-wrap; border-left: 3px solid ${theme.accent || '#c8781a'}; padding: 6px 0 6px 12px; margin: 0; min-height: 1.4em; }`,
      `<h1>${esc(b.title || 'Mein Umsetzungsplan')}</h1><p style="border:0;padding:0;color:#5d6877">${esc(course.title)} · ${new Date().toLocaleDateString('de-DE')}</p>
      ${(b.fields || []).map((f, i) => `<h2>${esc(f.label)}</h2><p>${esc(v[i] || '')}</p>`).join('')}`);
  }

  // ---------- Kapitelübersicht, Kernbotschaft, Denkpause, Kernaussagen, Quellen ----------
  // Kapitel in Reihenfolge der Seiten, mit Seiten und geschätzter Dauer
  function chapterList(all) {
    // Eine Schätzung für alles: kursZeit() rechnet je Kapitel (Titelbereich und Ergebnis nehmen die Summe)
    const list = kursZeit(pages).chapters;
    return all ? list : list.filter(c => c.name);
  }

  function renderChapters(b) {
    const maxOk = unlockedUpTo();
    const own = pages.findIndex(p => (p.blocks || []).some(x => x.id === b.id));
    const liste = chapterList().filter(c => !c.pages.includes(own) || c.pages.length > 1);
    // Zwei Darstellungen: Karten (Standard) oder eine ruhige Liste mit Trennlinien
    const zeilen = () => liste.map((c, n) => {
      const cfg = (b.cards || []).find(x => x.chapter === c.name) || {};
      const seen = c.pages.filter(i => state.visited.has(i)).length;
      const done = seen === c.pages.length;
      const target = c.pages.find(i => !state.visited.has(i) && i !== own);
      const goTo = done || target == null ? c.pages[0] : target;
      const locked = set.gating && c.pages[0] > maxOk;
      const anteil = c.pages.length ? seen / c.pages.length : 0;
      const stand = done ? T('erledigt') : seen ? `${T('inArbeit')} · ${seen}/${c.pages.length}` : T('offen');
      return `<button type="button" class="kp-chl-item fx-reveal ${done ? 'is-done' : ''}" data-goto="${goTo}" ${locked ? 'disabled' : ''}>
        <span class="kp-chl-num" aria-hidden="true">${String(n + 1).padStart(2, '0')}</span>
        <span class="kp-chl-main">
          <span class="kp-chl-title">${accent(String(c.name).replace(/^\d+[\s.:·)-]+(?=\S)/, ''))}</span>
          ${cfg.text ? `<span class="kp-chl-text">${esc(cfg.text)}</span>` : ''}
        </span>
        <span class="kp-chl-meta">${locked ? T('gesperrt') : `${T('ca')} ${c.minutes} ${T('min')}`}</span>
        <span class="kp-sr">${esc(stand)}</span>
        ${ring(anteil, done)}
      </button>`;
    }).join('');
    const cards = liste.map((c, n) => {
      const cfg = (b.cards || []).find(x => x.chapter === c.name) || {};
      const seen = c.pages.filter(i => state.visited.has(i)).length;
      const done = seen === c.pages.length;
      const target = c.pages.find(i => !state.visited.has(i) && i !== own);
      const goTo = done || target == null ? c.pages[0] : target;
      const locked = set.gating && c.pages[0] > maxOk;
      const status = done ? `<span class="kp-ch-status done">${icon('check')} ${T('erledigt')}</span>` : seen ? `<span class="kp-ch-status">${T('inArbeit')} · ${seen}/${c.pages.length}</span>` : `<span class="kp-ch-status">${T('offen')}</span>`;
      return `<article class="kp-ch-card fx-reveal ${done ? 'is-done' : ''}">
        <div class="kp-ch-media">${cfg.image && cfg.image.src ? `<img loading="lazy" decoding="async" src="${esc(res(cfg.image.src))}" alt="${esc(cfg.image.alt || '')}">` : `<div class="kp-ch-num" aria-hidden="true">${String(n + 1).padStart(2, '0')}</div>`}</div>
        <div class="kp-ch-body">
          <p class="kp-eyebrow">${T('kapitel')} ${n + 1}</p>
          <h3 class="kp-ch-title">${accent(String(c.name).replace(/^\d+[\s.:·)-]+(?=\S)/, ''))}</h3>
          ${cfg.text ? `<p class="kp-ch-text">${esc(cfg.text)}</p>` : ''}
          <div class="kp-ch-meta"><span>${icon('clock')} ${T('ca')} ${c.minutes} ${T('min')}</span>${status}</div>
          <button class="kp-btn ${done ? 'kp-sec' : ''}" data-goto="${goTo}" ${locked ? 'disabled' : ''}>${locked ? 'Noch gesperrt' : done ? T('nochmal') : seen ? T('fortsetzen') : T('starten')}</button>
        </div>
      </article>`;
    }).join('');
    const leer = '<p class="kp-lock">Noch keine Kapitel. Kapitel vergibst du in den Seiteneinstellungen.</p>';
    const inhalt = b.look === 'liste'
      ? `<div class="kp-chl">${zeilen() || leer}</div>`
      : `<div class="kp-ch-grid">${cards || leer}</div>`;
    return `<div class="kp-chapters ${b.look === 'liste' ? 'kp-ch-quiet' : ''}">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}${b.intro ? `<div class="kp-text">${res(b.intro)}</div>` : ''}</div>` : ''}
      ${inhalt}
    </div>`;
  }

  // Fortschrittsring am Ende einer Kapitelzeile: leer, teilweise gefüllt oder mit Haken
  function ring(anteil, fertig) {
    const u = 2 * Math.PI * 9;
    const an = Math.max(0, Math.min(1, anteil)) * u;
    return `<svg class="kp-chl-ring ${fertig ? 'is-done' : ''}" viewBox="0 0 22 22" aria-hidden="true">
      <circle class="kp-chl-ring-bg" cx="11" cy="11" r="9"></circle>
      ${fertig
        ? '<circle class="kp-chl-ring-fill" cx="11" cy="11" r="9"></circle><path class="kp-chl-ring-check" d="M7.2 11.2l2.6 2.6 5-5.2"></path>'
        : `<circle class="kp-chl-ring-on" cx="11" cy="11" r="9" stroke-dasharray="${an.toFixed(2)} ${(u - an).toFixed(2)}" transform="rotate(-90 11 11)"></circle>`}
    </svg>`;
  }

  function renderStatement(b) {
    return `<div class="kp-statement kp-statement-${b.style || 'center'}">
      ${b.icon ? icon(b.icon, 'kp-ico-lg') : ''}
      ${eyebrow(b.eyebrow)}
      <p class="kp-statement-text">${accent(b.text)}</p>
      ${b.author ? `<p class="kp-author">${esc(b.author)}${b.authorRole ? `<span>${esc(b.authorRole)}</span>` : ''}</p>` : ''}
      ${b.sub ? `<div class="kp-text kp-statement-sub">${res(b.sub)}</div>` : ''}
    </div>`;
  }

  // Auswahlrad: Personen oder Punkte im Kreis, die Auswahl zeigt die Erklärung
  function renderDial(b) {
    const items = b.items || [];
    const cur = Math.min((state.self[b.id] || {}).v || 0, Math.max(0, items.length - 1));
    const it = items[cur] || {};
    const p = personOf(it);
    const r = 42;
    const dots = items.map((x, i) => {
      const a = (i / Math.max(1, items.length)) * 2 * Math.PI - Math.PI / 2;
      const m = personOf(x);
      const label = m.name || x.label || 'Punkt ' + (i + 1);
      return `<button class="kp-dial-dot ${i === cur ? 'current' : ''}" data-dial="${b.id}" data-i="${i}"
        style="left:${50 + r * Math.cos(a)}%;top:${50 + r * Math.sin(a)}%" aria-pressed="${i === cur}" title="${esc(label)}">
        <span class="kp-dial-face">${m.image && m.image.src ? `<img src="${esc(res(m.image.src))}" alt=""${focusStyle(m.image)}>` : avatarSvg(m.look || 'a' + ((i % 12) + 1), m.pose)}</span>
        <span class="kp-dial-label">${esc(label)}</span></button>`;
    }).join('');
    return `<div class="kp-dial" data-dialblock="${b.id}">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}</div>` : ''}
      <div class="kp-dial-stage">
        <div class="kp-dial-ring" role="group" aria-label="${esc(b.hint || 'Auswahl')}">${dots}
          <div class="kp-dial-center">${esc(b.centerLabel || b.hint || 'Wähle aus')}</div></div>
        <div class="kp-dial-info" role="status">
          <p class="kp-eyebrow">${esc(p.name || it.label || '')}${p.role ? ' · ' + esc(p.role) : ''}</p>
          ${it.title ? `<h3>${esc(it.title)}</h3>` : ''}
          <div class="kp-text">${res(it.html)}</div></div>
      </div></div>`;
  }

  // Beschriftung auf höchstens zwei Zeilen umbrechen (SVG kann das nicht von selbst)
  function wrapLines(text, max) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines = [words.shift()];
    words.forEach(w => {
      const cur = lines[lines.length - 1];
      if (lines.length < 2 && (cur + ' ' + w).length > max) lines.push(w);
      else lines[lines.length - 1] = cur + ' ' + w;
    });
    if (lines[1] && lines[1].length > max) lines[1] = lines[1].slice(0, max - 1).trim() + '…';
    return lines;
  }

  // Animationsbibliothek: fertige SVG-Animationen, Beschriftung frei
  function renderAnim(b) {
    const items = (b.items || []).filter(x => String(x || '').trim());
    const col = 'var(--kp-primary)', acc = 'var(--kp-accent)';
    const preset = b.preset || 'arrow';
    let art = '';
    if (preset === 'arrow') {
      art = `<svg viewBox="0 0 ${Math.max(300, items.length * 150)} 120" class="kp-anim-svg" aria-hidden="true">
        ${items.map((t, i) => {
          const x = 30 + i * 150;
          return `<g class="kp-anim-step" style="--d:${i * 0.25}s">
            <circle cx="${x + 30}" cy="46" r="26" fill="none" stroke="${col}" stroke-width="3" class="kp-draw" pathLength="1"/>
            <text x="${x + 30}" y="53" text-anchor="middle" font-size="20" fill="${col}" font-weight="700">${i + 1}</text>
            ${i < items.length - 1 ? `<path d="M${x + 62} 46 H${x + 132}" stroke="${acc}" stroke-width="3" fill="none" class="kp-draw" pathLength="1" marker-end="url(#kp-arrow)"/>` : ''}
            <text x="${x + 30}" y="100" text-anchor="middle" font-size="14" fill="currentColor">${esc(t).slice(0, 22)}</text></g>`;
        }).join('')}
        <defs><marker id="kp-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0l8 4-8 4z" fill="${acc}"/></marker></defs></svg>`;
    } else if (preset === 'bars') {
      const vals = items.map((t, i) => Number(String(t).match(/(\d+)/) ? String(t).match(/(\d+)/)[1] : (i + 1) * 25));
      const max = Math.max(1, ...vals);
      art = `<div class="kp-anim-bars">${items.map((t, i) => `<div class="kp-anim-bar" style="--h:${Math.round(vals[i] / max * 100)}%;--d:${i * 0.15}s"><b>${esc(String(vals[i]))}</b><i></i><span>${esc(String(t).replace(/\s*\d+\s*%?/, '').trim() || 'Wert ' + (i + 1))}</span></div>`).join('')}</div>`;
    } else if (preset === 'pulse') {
      art = `<svg viewBox="0 0 120 120" class="kp-anim-svg kp-anim-pulse" aria-hidden="true">
        <circle cx="60" cy="60" r="26" fill="${acc}" opacity=".9"/>
        <circle cx="60" cy="60" r="26" fill="none" stroke="${acc}" stroke-width="3" class="kp-ring" />
        <circle cx="60" cy="60" r="26" fill="none" stroke="${acc}" stroke-width="3" class="kp-ring kp-ring2" />
        <path d="M60 46v22M60 76v2" stroke="#fff" stroke-width="6" stroke-linecap="round"/></svg>`;
    } else if (preset === 'check') {
      art = `<ul class="kp-anim-check">${items.map((t, i) => `<li style="--d:${i * 0.2}s"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round" class="kp-draw" pathLength="1"/></svg><span>${esc(t)}</span></li>`).join('')}</ul>`;
    } else if (preset === 'compare') {
      art = `<div class="kp-anim-compare"><div class="kp-anim-side"><span>${esc(items[0] || 'Vorher')}</span></div><div class="kp-anim-morph">→</div><div class="kp-anim-side after"><span>${esc(items[1] || 'Nachher')}</span></div></div>`;
    } else if (preset === 'matrix') {
      const q = [0, 1, 2, 3].map(i => items[i] || `Feld ${i + 1}`);
      const pos = [[48, 28], [240, 28], [48, 164], [240, 164]];
      art = `<svg viewBox="0 0 440 340" class="kp-anim-svg" aria-hidden="true">
        <line x1="34" y1="300" x2="424" y2="300" stroke="currentColor" stroke-width="2" opacity=".3"/>
        <line x1="34" y1="300" x2="34" y2="14" stroke="currentColor" stroke-width="2" opacity=".3"/>
        ${q.map((t, i) => {
          const [x, y] = pos[i], ls = wrapLines(t, 20), top = i === 1;
          return `<g class="kp-anim-step" style="--d:${i * 0.18}s">
            <rect x="${x}" y="${y}" width="176" height="124" rx="10" fill="${top ? acc : col}" fill-opacity="${top ? '.18' : '.08'}" stroke="${top ? acc : 'none'}" stroke-width="2"/>
            <text x="${x + 88}" y="${y + 66}" text-anchor="middle" font-size="15" font-weight="600" fill="currentColor">${ls.map((l, k) => `<tspan x="${x + 88}" dy="${k ? 19 : (ls.length > 1 ? -9 : 0)}">${esc(l)}</tspan>`).join('')}</text></g>`;
        }).join('')}
        ${b.axisX ? `<text x="229" y="328" text-anchor="middle" font-size="13" fill="currentColor" opacity=".75">${esc(String(b.axisX).slice(0, 34))}</text>` : ''}
        ${b.axisY ? `<text x="18" y="157" text-anchor="middle" font-size="13" fill="currentColor" opacity=".75" transform="rotate(-90 18 157)">${esc(String(b.axisY).slice(0, 34))}</text>` : ''}</svg>`;
    } else if (preset === 'scale') {
      const pan = (side, x, label) => `<g class="kp-anim-pan kp-pan-${side}">
        <line x1="${x}" y1="104" x2="${x}" y2="142" stroke="${col}" stroke-width="2" opacity=".55"/>
        <path d="M${x - 34} 142h68l-10 20h-48z" fill="${acc}" fill-opacity=".85"/>
        <text x="${x}" y="186" text-anchor="middle" font-size="14" fill="currentColor">${esc(String(label).slice(0, 18))}</text></g>`;
      art = `<svg viewBox="0 0 360 210" class="kp-anim-svg" aria-hidden="true">
        <path d="M144 200h72l-12 -14h-48z" fill="${col}" fill-opacity=".85"/>
        <line x1="180" y1="196" x2="180" y2="104" stroke="${col}" stroke-width="6" stroke-linecap="round"/>
        <g class="kp-anim-beam"><line x1="62" y1="104" x2="298" y2="104" stroke="${col}" stroke-width="6" stroke-linecap="round"/></g>
        ${pan('l', 62, items[0] || 'Links')}${pan('r', 298, items[1] || 'Rechts')}</svg>`;
    } else if (preset === 'cycle') {
      const list = items.slice(0, 6);
      const n = Math.max(2, list.length);
      const cx = 240, cy = 190, R = 100, gap = 0.36;
      const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
      const pt = (a, r) => [Math.round((cx + r * Math.cos(a)) * 10) / 10, Math.round((cy + r * Math.sin(a)) * 10) / 10];
      art = `<svg viewBox="0 0 480 400" class="kp-anim-svg" aria-hidden="true">
        ${list.map((t, i) => {
          const e = ang(i + 1) - gap, [ax, ay] = pt(ang(i) + gap, R), [bx, by] = pt(e, R);
          const rot = Math.round(Math.atan2(Math.cos(e), -Math.sin(e)) * 180 / Math.PI), d = 0.2 + i * 0.28;
          return `<path d="M${ax} ${ay} A${R} ${R} 0 0 1 ${bx} ${by}" fill="none" stroke="${acc}" stroke-width="3" class="kp-draw" pathLength="1" style="--d:${d}s"/>
            <g class="kp-anim-step" style="--d:${d + 0.7}s"><path d="M-7 -6 L4 0 L-7 6z" fill="${acc}" transform="translate(${bx} ${by}) rotate(${rot})"/></g>`;
        }).join('')}
        ${list.map((t, i) => {
          const c = Math.cos(ang(i)), side = Math.abs(c) > 0.3, anchor = side ? (c > 0 ? 'start' : 'end') : 'middle';
          const [x, y] = pt(ang(i), R), [lx, ly] = pt(ang(i), side ? 134 : 146), ls = wrapLines(t, side ? 12 : 18);
          return `<g class="kp-anim-step" style="--d:${i * 0.28}s">
            <circle cx="${x}" cy="${y}" r="26" fill="${col}" fill-opacity=".12" stroke="${col}" stroke-width="2"/>
            <text x="${x}" y="${y + 6}" text-anchor="middle" font-size="17" font-weight="700" fill="currentColor">${i + 1}</text>
            <text x="${lx}" y="${ly + 5}" text-anchor="${anchor}" font-size="13" fill="currentColor">${ls.map((l, k) => `<tspan x="${lx}" dy="${k ? 16 : (ls.length > 1 ? -8 : 0)}">${esc(l)}</tspan>`).join('')}</text></g>`;
        }).join('')}</svg>`;
    } else if (preset === 'stairs') {
      const list = items.slice(0, 5);
      const n = Math.max(2, list.length), w = 400 / n;
      art = `<svg viewBox="0 0 440 280" class="kp-anim-svg" aria-hidden="true">
        <line x1="20" y1="248" x2="420" y2="248" stroke="currentColor" stroke-width="2" opacity=".3"/>
        ${list.map((t, i) => {
          const h = Math.round((i + 1) / n * 190), x = 20 + i * w, last = i === n - 1;
          return `<rect class="kp-anim-riser" style="--d:${i * 0.22}s" x="${x + 4}" y="${248 - h}" width="${w - 8}" height="${h}" rx="6" fill="${last ? acc : col}" fill-opacity="${last ? '.8' : '.14'}"/>
            <text class="kp-anim-step" style="--d:${0.15 + i * 0.22}s" x="${x + w / 2}" y="${238 - h}" text-anchor="middle" font-size="13" fill="currentColor">${esc(String(t).slice(0, 18))}</text>`;
        }).join('')}</svg>`;
    } else if (preset === 'curve') {
      const zones = items.slice(0, 3), zx = [110, 223, 350];
      art = `<svg viewBox="0 0 440 280" class="kp-anim-svg" aria-hidden="true">
        <line x1="44" y1="232" x2="420" y2="232" stroke="currentColor" stroke-width="2" opacity=".3"/>
        <line x1="44" y1="232" x2="44" y2="24" stroke="currentColor" stroke-width="2" opacity=".3"/>
        <path d="M70 216 C150 40 290 40 396 216" fill="none" stroke="${acc}" stroke-width="4" stroke-linecap="round" class="kp-draw" pathLength="1" style="--d:.1s"/>
        <g class="kp-anim-step" style="--d:1.1s">
          <line x1="223" y1="92" x2="223" y2="232" stroke="${col}" stroke-width="2" stroke-dasharray="5 5" opacity=".5"/>
          <circle cx="223" cy="84" r="9" fill="${col}"/></g>
        ${zones.map((t, i) => `<text class="kp-anim-step" style="--d:${1.3 + i * 0.18}s" x="${zx[i]}" y="${256}" text-anchor="middle" font-size="13" fill="currentColor">${esc(String(t).slice(0, 20))}</text>`).join('')}</svg>`;
    } else if (preset === 'clock') {
      const ticks = Array.from({ length: 12 }, (x, i) => { const a = i * Math.PI / 6, r1 = i % 3 ? 88 : 80; return `<line x1="${Math.round(120 + r1 * Math.sin(a))}" y1="${Math.round(120 - r1 * Math.cos(a))}" x2="${Math.round(120 + 96 * Math.sin(a))}" y2="${Math.round(120 - 96 * Math.cos(a))}" stroke="currentColor" stroke-width="${i % 3 ? 2 : 4}" opacity=".45" stroke-linecap="round"/>`; }).join('');
      art = `<svg viewBox="0 0 240 240" class="kp-anim-svg kp-anim-clockface" aria-hidden="true">
        <circle cx="120" cy="120" r="104" fill="${col}" fill-opacity=".06" stroke="${col}" stroke-width="4"/>${ticks}
        <line class="kp-clock-h" x1="120" y1="120" x2="120" y2="72" stroke="${col}" stroke-width="8" stroke-linecap="round"/>
        <line class="kp-clock-m" x1="120" y1="120" x2="120" y2="38" stroke="${acc}" stroke-width="4" stroke-linecap="round"/>
        <circle cx="120" cy="120" r="8" fill="${col}"/></svg>
        ${items[0] ? `<p class="kp-anim-scene-label kp-anim-step" style="--d:2.3s">${esc(items[0])}</p>` : ''}`;
    } else if (preset === 'calendar') {
      const list = (items.length ? items : ['Januar', 'April', 'Dezember']).slice(0, 6);
      art = `<div class="kp-anim-cal">${list.map((t, i) => `<div class="kp-cal-sheet" style="--d:${0.4 + i * 0.75}s;z-index:${list.length - i}"><span class="kp-cal-rings" aria-hidden="true"><i></i><i></i></span><b>${esc(String(t).slice(0, 24))}</b></div>`).join('')}</div>`;
    } else if (preset === 'message') {
      const list = (items.length ? items : ['Lea: Hast Du kurz Zeit?']).slice(0, 5);
      let first = null;
      art = `<div class="kp-anim-msg"><div class="kp-msg-phone">${list.map((t, i) => {
        const m = String(t).match(/^([^:]{1,24}):\s*([\s\S]+)$/), who = m ? m[1].trim() : '', txt = m ? m[2] : String(t);
        if (who && first == null) first = who;
        const mine = who && who !== first;
        return `<div class="kp-msg${mine ? ' kp-msg-me' : ''}" style="--d:${i * 1.2}s">${who ? `<small>${esc(who)}</small>` : ''}<div class="kp-msg-bubble"><span class="kp-msg-typing" aria-hidden="true"><i></i><i></i><i></i></span><p>${esc(txt)}</p></div></div>`;
      }).join('')}</div></div>`;
    } else {
      art = `<div class="kp-anim-count" data-count-to="${esc(String(items[0] || '100').replace(/\D/g, '') || '100')}"><b>0</b><span>${esc(b.unit || '')}</span></div>`;
    }
    return `<figure class="kp-anim kp-anim-${preset}" data-anim>
      ${b.title ? `<figcaption class="kp-anim-title">${accent(b.title)}</figcaption>` : ''}
      ${art}
      ${b.caption ? `<p class="kp-caption">${esc(b.caption)}</p>` : ''}</figure>`;
  }

  // Motion-Zeitleiste: zeitgesteuerte Einblendungen mit Abspielen und Pause
  function renderMotion(b) {
    const steps = b.steps || [];
    const total = steps.reduce((n, s) => n + (Number(s.dur) || 3), 0);
    return `<div class="kp-motion" data-motion="${b.id}" data-total="${total}">
      ${b.title ? `<h2 class="kp-q">${accent(b.title)}</h2>` : ''}
      <div class="kp-motion-stage">${steps.map((s, i) => `
        <div class="kp-motion-step" data-step="${i}" data-at="${steps.slice(0, i).reduce((n, x) => n + (Number(x.dur) || 3), 0)}">
          <span class="kp-motion-year">${esc(s.label || '')}</span>
          <div><h4>${esc(s.title || '')}</h4><div class="kp-text">${res(s.html)}</div></div>
        </div>`).join('')}</div>
      <div class="kp-motion-bar"><i></i></div>
      <div class="kp-quiz-actions">
        <button class="kp-btn" data-motion-play="${b.id}">▶ ${T('abspielen')}</button>
        <button class="kp-btn kp-sec" data-motion-all="${b.id}">${T('allesZeigen')}</button>
      </div></div>`;
  }

  function renderPredict(b) {
    const st = state.self[b.id] || {};
    let input = '';
    if (b.mode === 'choice') {
      input = `<div class="kp-answers">${(b.options || []).map((o, i) => `<label class="kp-answer ${st.done && st.v === i ? 'kp-chosen' : ''}"><input type="radio" name="pr-${b.id}" value="${i}" ${st.v === i ? 'checked' : ''} ${st.done ? 'disabled' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`;
    } else if (b.mode === 'range') {
      // Sicherheits-Schätzung: ein Bereich, in dem der Wert mit der genannten Sicherheit liegt
      const min = Number(b.min) || 0, max = Number(b.max) || 100, step = Number(b.step) || 1;
      const lo = Array.isArray(st.v) ? st.v[0] : min + Math.round((max - min) * 0.3 / step) * step;
      const hi = Array.isArray(st.v) ? st.v[1] : min + Math.round((max - min) * 0.7 / step) * step;
      const u = b.unit ? ' ' + esc(b.unit) : '';
      input = `<p class="kp-range-lead">${T('bereichSicher').replace('{p}', esc(b.confidence || 90))}</p>
        <div class="kp-estimate"><span class="kp-range-end">${T('bereichVon')}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${lo}" data-pr-range data-end="lo" ${st.done ? 'disabled' : ''} aria-label="${T('bereichVon')}"><output class="kp-estimate-val">${lo}${u}</output></div>
        <div class="kp-estimate"><span class="kp-range-end">${T('bereichBis')}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${hi}" data-pr-range data-end="hi" ${st.done ? 'disabled' : ''} aria-label="${T('bereichBis')}"><output class="kp-estimate-val">${hi}${u}</output></div>`;
    } else if (b.mode === 'slider') {
      const min = Number(b.min) || 0, max = Number(b.max) || 100;
      const v = st.v != null ? st.v : Math.round((min + max) / 2);
      input = `<div class="kp-estimate"><input type="range" min="${min}" max="${max}" step="${Number(b.step) || 1}" value="${v}" data-pr-range ${st.done ? 'disabled' : ''} aria-label="Deine Schätzung"><output class="kp-estimate-val">${v}${b.unit ? ' ' + esc(b.unit) : ''}</output></div>`;
    } else {
      input = `<textarea class="kp-notes kp-predict-text" rows="3" placeholder="${esc(b.placeholder || 'Deine Vermutung …')}" ${st.done ? 'disabled' : ''}>${esc(st.v || '')}</textarea>`;
    }
    // Bereichsschätzung: lag der wahre Wert drin? Dazu die Trefferquote über alle Bereichsschätzungen des Kurses (Kalibrierung)
    if (st.done && b.mode === 'range' && Array.isArray(st.v) && b.actual !== '' && b.actual != null) {
      const min = Number(b.min) || 0, max = Number(b.max) || 100, span = max - min || 1;
      const a = Number(b.actual), hit = a >= st.v[0] && a <= st.v[1];
      const pos = v => Math.max(0, Math.min(100, (v - min) / span * 100));
      const all = pages.flatMap(pg => pg.blocks || []).filter(x => x.type === 'predict' && x.mode === 'range' && x.actual !== '' && x.actual != null && (state.self[x.id] || {}).done && Array.isArray(state.self[x.id].v));
      const hits = all.filter(x => Number(x.actual) >= state.self[x.id].v[0] && Number(x.actual) <= state.self[x.id].v[1]).length;
      const u = b.unit ? ' ' + esc(b.unit) : '';
      return `<div class="kp-predict" data-predict="${b.id}">
        <p class="kp-eyebrow">${icon('bulb')} ${esc(b.eyebrow || 'Denkpause')}</p>
        <p class="kp-q">${accent(b.prompt)}</p>
        <div class="kp-predict-reveal" role="status">
          <p class="kp-range-verdict ${hit ? 'ok' : 'no'}">${hit ? T('bereichDrin') : T('bereichDaneben')}</p>
          <div class="kp-range-scale" aria-hidden="true"><span class="kp-range-band" style="left:${pos(st.v[0])}%;width:${Math.max(1, pos(st.v[1]) - pos(st.v[0]))}%"></span><span class="kp-range-true" style="left:${pos(a)}%"></span></div>
          <p class="kp-range-nums"><span>${T('deinBereich')}: <b>${esc(st.v[0])}–${esc(st.v[1])}${u}</b></span><span>${esc(b.actualLabel || T('tatsaechlich'))}: <b>${esc(b.actual)}${u}</b></span></p>
          ${all.length >= 2 ? `<p class="kp-range-calib">${T('bereichKalib').replace('{h}', hits).replace('{n}', all.length).replace('{p}', esc(b.confidence || 90))}</p>` : ''}
          <div class="kp-text">${res(b.reveal)}</div></div>
      </div>`;
    }
    const mine = st.done ? (b.mode === 'choice' ? esc((b.options || [])[st.v] || '') : b.mode === 'slider' ? esc(st.v + (b.unit ? ' ' + b.unit : '')) : esc(st.v || '')) : '';
    // Schätzung und Wirklichkeit nebeneinander: die Lücke ist der eigentliche Haken
    let gap = '';
    // Vorher-nachher: dieselbe Einschätzung weiter vorn im Kurs (compareRef) neben der heutigen, ohne richtig oder falsch
    const first = b.compareRef && b.mode === 'slider' ? (state.self[b.compareRef] || {}) : {};
    if (st.done && first.done && first.v != null) {
      const max = Math.max(Number(b.max) || 100, Number(first.v) || 0, Number(st.v) || 0);
      const w = v => Math.max(2, Math.round((Number(v) || 0) / max * 100));
      const u = b.unit ? ' ' + esc(b.unit) : '';
      gap = `<div class="kp-gap kp-gap-then">
        <div class="kp-gap-row"><span>${T('amAnfang')}</span><i style="--w:${w(first.v)}%"><b>${esc(first.v)}${u}</b></i></div>
        <div class="kp-gap-row real"><span>${T('heute')}</span><i style="--w:${w(st.v)}%"><b>${esc(st.v)}${u}</b></i></div>
      </div>`;
    } else if (st.done && b.mode === 'slider' && b.actual !== '' && b.actual != null) {
      const max = Math.max(Number(b.max) || 100, Number(b.actual) || 0, Number(st.v) || 0);
      const w = v => Math.max(2, Math.round((Number(v) || 0) / max * 100));
      gap = `<div class="kp-gap">
        <div class="kp-gap-row"><span>${T('deineSchaetzung')}</span><i style="--w:${w(st.v)}%"><b>${esc(st.v)}${b.unit ? ' ' + esc(b.unit) : ''}</b></i></div>
        <div class="kp-gap-row real"><span>${esc(b.actualLabel || T('tatsaechlich'))}</span><i style="--w:${w(b.actual)}%"><b>${esc(b.actual)}${b.unit ? ' ' + esc(b.unit) : ''}</b></i></div>
      </div>`;
    }
    return `<div class="kp-predict" data-predict="${b.id}">
      <p class="kp-eyebrow">${icon('bulb')} ${esc(b.eyebrow || 'Denkpause')}</p>
      <p class="kp-q">${accent(b.prompt)}</p>
      ${input}
      ${st.done ? `<div class="kp-predict-reveal" role="status">
          ${gap || (mine ? `<p class="kp-predict-mine"><span>${T('deineVermutung')}</span>${mine}</p>` : '')}
          <div class="kp-text">${res(b.reveal)}</div></div>`
        : `<div class="kp-quiz-actions"><button class="kp-btn" data-predict-go="${b.id}">${esc(b.revealLabel || 'Auflösung zeigen')}</button></div>`}
    </div>`;
  }

  function renderTakeaways(b) {
    // recall: erst überlegen, dann aufdecken (Abrufen statt Lesen, Roediger & Karpicke 2006); Stand in state.self[id].open
    const open = b.recall ? ((state.self[b.id] || {}).open || []) : null;
    const items = b.items || [];
    const body = it => (plainText(it.html) ? `<div class="kp-text">${res(it.html)}</div>` : '');
    return `<div class="kp-takeaways ${b.recall ? 'kp-tk-recall' : ''}" data-takeaways="${b.id}">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}</div>` : ''}
      ${b.recall ? `<p class="kp-tk-hint" data-tk-status>${esc(T('aufdeckenHinweis'))} <b>${esc(T('aufgedeckt').replace('{n}', open.length).replace('{z}', items.length))}</b></p>` : ''}
      <ol class="kp-tk-list">${items.map((it, i) => `<li class="fx-reveal ${open && !open.includes(i) ? 'kp-tk-closed' : ''}"><span class="kp-tk-num" aria-hidden="true">${i + 1}</span><div><h3>${esc(it.title)}</h3>${open && !open.includes(i) ? (plainText(it.html) ? `<button class="kp-btn kp-sec kp-tk-open" data-tk-open="${i}" aria-expanded="false">${T('aufdecken')}</button>` : '') : body(it)}</div></li>`).join('')}</ol>
      ${b.print !== false ? `<div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-tk-print="${b.id}">${icon('book')} Als Merkkarte drucken oder speichern</button></div>` : ''}
    </div>`;
  }

  function printTakeaways(b) {
    printWindow(plainText(b.title).replace(/\*/g, '') || 'Kernaussagen', `body { font-family: ${theme.font || 'Segoe UI, sans-serif'}; color: #1d2530; max-width: 720px; margin: 30px auto; padding: 0 20px; }
      h1 { color: ${theme.primary || '#1f3a5f'}; font-size: 24px; margin-bottom: 4px; } .sub { color: #5d6877; margin: 0 0 22px; }
      ol { padding: 0; list-style: none; counter-reset: n; } li { counter-increment: n; display: grid; grid-template-columns: 36px 1fr; gap: 12px; padding: 12px 0; border-bottom: 1px solid #e4e9ef; }
      li::before { content: counter(n); width: 30px; height: 30px; border-radius: 50%; background: ${theme.primary || '#1f3a5f'}; color: #fff; display: grid; place-items: center; font-weight: 700; }
      h2 { font-size: 16px; margin: 4px 0; } p { margin: 4px 0; line-height: 1.5; }`,
      `<h1>${esc(plainText(b.title).replace(/\*/g, '') || 'Kernaussagen')}</h1><p class="sub">${esc(course.title)} · ${new Date().toLocaleDateString('de-DE')}</p>
      <ol>${(b.items || []).map(it => `<li><div><h2>${esc(it.title)}</h2>${res(it.html)}</div></li>`).join('')}</ol>`);
  }

  function renderSources(b) {
    // Eingeklappt: Quellen werden selten gelesen und machen sonst jede Seite laenger; eine Fussnote klappt sie auf
    const list = (b.items || []).filter(s => String(s).trim());
    return `<details class="kp-sources">
      <summary class="kp-sources-title">${esc(b.title || 'Quellen')} (${list.length})</summary>
      <ol>${list.map((s, i) => `<li id="kp-src-${i + 1}" tabindex="-1">${esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</li>`).join('')}</ol>
    </details>`;
  }

  // Fußnoten [^1] im Text verweisen auf den Quellen-Block der Seite
  // Fußnoten nur im Text ersetzen, nie in Attributen (ein [^1] im Prompt einer Reflexion steht auch im aria-label des Textfelds)
  const footnotes = html => String(html).split(/(<[^>]*>)/).map((part, i) => i % 2 ? part : part.replace(/\[\^(\d{1,2})\]/g, (m, n) => `<sup class="kp-fn"><button type="button" data-fn="${n}" aria-label="Quelle ${n}">${n}</button></sup>`)).join('');

  // Bild mit Nachweis und Vergrößerung
  function openLightbox(src, alt, caption) {
    const box = document.createElement('div');
    box.className = 'kp-lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Bild vergrößert');
    box.innerHTML = `<button class="kp-lightbox-close" aria-label="Schließen">✕</button><figure><img src="${esc(src)}" alt="${esc(alt)}">${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`;
    const back = document.activeElement;
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); if (back && back.focus) back.focus(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    box.addEventListener('click', e => { if (e.target === box || e.target.closest('.kp-lightbox-close')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
    box.querySelector('.kp-lightbox-close').focus();
  }

  // Rückmeldung, wenn ein Kapitel vollständig bearbeitet ist
  function chapterToast(prevIndex) {
    const prev = pages[prevIndex], cur = pages[state.current];
    if (!prev || !prev.chapter || !cur || cur.chapter === prev.chapter) return;
    const all = pages.map((p, i) => i).filter(i => pages[i].chapter === prev.chapter);
    if (!all.every(i => state.visited.has(i))) return;
    state.toasted = state.toasted || {};
    if (state.toasted[prev.chapter]) return;
    state.toasted[prev.chapter] = true;
    if (set.milestone !== 'kurz') return milestoneCard(prev.chapter);
    const t = document.createElement('div');
    t.className = 'kp-toast';
    t.setAttribute('role', 'status');
    t.innerHTML = `${icon('check-circle')}<span>${T('kapitel')} „${esc(prev.chapter)}“ ${T('abgeschlossen')}</span>`;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 3800);
  }

  // Meilenstein-Moment am Kapitelende: Karte mit Fortschrittsring, Kapitelstand und dem nächsten Kapitel.
  // Erscheint einmal je Kapitel (state.toasted), schließt per Knopf, Escape oder Klick daneben.
  function milestoneCard(chapter) {
    const chapters = chapterList(true).filter(c => c.name);
    const idx = chapters.findIndex(c => c.name === chapter);
    const m = chapters.length, done = chapters.filter(c => c.pages.every(i => state.visited.has(i))).length;
    const next = chapters[idx + 1];
    const r = 34, u = 2 * Math.PI * r, share = m ? done / m : 1;
    const box = document.createElement('div');
    box.className = 'kp-milestone';
    box.innerHTML = `<div class="kp-ms-box" role="dialog" aria-modal="true" aria-labelledby="kp-ms-title">
      <div class="kp-ms-ring" aria-hidden="true"><svg viewBox="0 0 80 80"><circle class="kp-ring-bg" cx="40" cy="40" r="${r}"></circle>
        <circle class="kp-ring-on" cx="40" cy="40" r="${r}" stroke-dasharray="${u.toFixed(2)}" stroke-dashoffset="${(u * (1 - share)).toFixed(2)}" style="--kp-ring-u:${u.toFixed(2)}" transform="rotate(-90 40 40)"></circle></svg>
        <span>${icon('check-circle', 'kp-ico-lg')}</span></div>
      <p class="kp-label">${T('kapitel')} ${idx + 1} ${T('von')} ${m} ${T('abgeschlossen')}</p>
      <h2 id="kp-ms-title">${esc(chapter)}</h2>
      <p class="kp-ms-next">${next ? `${T('alsNaechstes')}: <strong>${esc(next.name)}</strong>` : T('msAlleKapitel')}</p>
      <button class="kp-btn" data-ms-close>${T('weiter')}</button></div>`;
    const close = () => { box.classList.add('out'); document.removeEventListener('keydown', onKey); setTimeout(() => box.remove(), reducedMotion() ? 0 : 250); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    box.addEventListener('click', e => { if (e.target === box || e.target.closest('[data-ms-close]')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
    box.querySelector('[data-ms-close]').focus({ preventScroll: true });
  }

  // ---------- Foto- und Video-Bausteine ----------
  // Ein Video kommt entweder als Datei im Paket oder als Adresse (YouTube, Vimeo, eigener Server)
  function videoHtml(o, cls) {
    const url = o.source === 'url' ? o.url : '';
    if (url && /youtu|vimeo/.test(url)) return `<div class="kp-embed ${cls || ''}"><iframe src="${esc(embedUrl(url))}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen title="${esc(o.alt || 'Video')}"></iframe></div>`;
    const src = url || res(o.src || '');
    if (!src) return videoDummy(o.text || o.transcript, o.poster && o.poster.src, cls);
    return `<video class="${cls || ''}" controls playsinline preload="metadata" ${o.poster && o.poster.src ? `poster="${esc(res(o.poster.src))}"` : ''} src="${esc(src)}">${trackHtml(o.captions, o.captionsText)}</video>`;
  }
  // Untertitel als Datei (captions) oder direkt als Text im Kurs (captionsText, SRT oder WebVTT)
  function vttOf(text) {
    let t = String(text || '').replace(/\r/g, '').trim();
    if (!t) return '';
    if (!/^WEBVTT/.test(t)) t = 'WEBVTT\n\n' + t.replace(/^\d+\s*\n(?=\d{1,2}:\d{2})/gm, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return 'data:text/vtt;charset=utf-8,' + encodeURIComponent(t);
  }
  function trackHtml(file, text) {
    const src = file ? res(file) : vttOf(text);
    return src ? `<track kind="captions" srclang="${esc(course.lang || 'de')}" label="Untertitel" src="${esc(src)}" default>` : '';
  }
  // Fehlt die Videodatei, steht der Sprechtext da; in der Vorschau mit dem Hinweis „Video folgt“
  function videoDummy(say, poster, cls) {
    if (!plainText(say)) return `<div class="kp-photo-empty ${cls || ''}">${icon('play')}<span>Noch kein Video</span></div>`;
    return `<div class="kp-video-dummy ${cls || ''}">${poster ? `<img src="${esc(res(poster))}" alt="">` : ''}<div class="kp-vd-in"><span class="kp-vd-lb">${icon('play')} ${T(opts.preview ? 'videoFolgt' : 'sprechtext')}</span>
      <blockquote>„${esc(plainText(say))}“</blockquote>${opts.preview ? `<small>${T('videoFolgtHinweis')}</small>` : ''}</div></div>`;
  }
  const transcriptHtml = t => (plainText(t) ? `<details class="kp-acc kp-transcript"><summary>${T('transkript')}</summary><div class="kp-text">${res(t)}</div></details>` : '');
  const personOf = x => Object.assign({}, x, castOf(x));

  // Team: Fotokarten mit Name und Rolle, Rückseite mit Hintergrund
  function renderTeam(b) {
    const cards = (b.members || []).map((m, i) => {
      const p = personOf(m);
      const back = plainText(p.html);
      const media = p.image && p.image.src ? `<img loading="lazy" decoding="async" src="${esc(res(p.image.src))}" alt="${esc(p.image.alt || p.name || '')}"${focusStyle(p.image)}>` : avatarSvg(p.look || 'a1', p.pose);
      return `<div class="kp-person ${back ? 'kp-person-flip' : ''}" ${back ? `tabindex="0" role="button" aria-label="${esc(p.name)}: mehr erfahren"` : ''}>
        <div class="kp-person-inner">
          <div class="kp-person-front"><div class="kp-person-media">${media}</div>
            <div class="kp-person-name"><span>${esc(p.name || '')}${p.role ? ', ' + esc(p.role) : ''}</span>${back ? '<span class="kp-person-flipicon" aria-hidden="true">⇄</span>' : ''}</div></div>
          ${back ? `<div class="kp-person-back"><div class="kp-text">${res(p.html)}</div><span class="kp-person-flipicon" aria-hidden="true">⇄</span></div>` : ''}
        </div></div>`;
    }).join('');
    return `<div class="kp-team">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}${b.intro ? `<div class="kp-text">${res(b.intro)}</div>` : ''}</div>` : ''}
      <div class="kp-person-grid">${cards}</div></div>`;
  }

  // Video-Statements: mehrere Sprechervideos nebeneinander
  function renderStatements(b) {
    const cards = (b.items || []).map(it => {
      const p = personOf(it);
      return `<figure class="kp-vcard">
        <figcaption class="kp-vcard-head"><strong>${esc(p.name || '')}</strong>${p.role ? `<span>${esc(p.role)}</span>` : ''}</figcaption>
        ${videoHtml(it)}
        ${it.text ? `<div class="kp-text kp-vcard-text">${res(it.text)}</div>` : ''}
        ${transcriptHtml(it.transcript)}</figure>`;
    }).join('');
    return `<div class="kp-statements">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}</div>` : ''}
      <div class="kp-vgrid kp-vgrid-${Math.min(3, Math.max(1, (b.items || []).length))}">${cards}</div></div>`;
  }

  // Videoszene: Clips nacheinander, am Ende auf Wunsch eine Entscheidung
  function renderVscene(b) {
    const steps = b.steps || [];
    const n = Math.min(state.dlg[b.id] || 0, Math.max(0, steps.length - 1));
    const cur = steps[n] || {};
    const p = personOf(cur);
    const last = n >= steps.length - 1;
    const decisionReady = last && b.decision && (b.decision.options || []).length;
    return `<div class="kp-vscene" data-vscene="${b.id}">
      ${b.title ? `<p class="kp-label">${esc(b.title)}</p>` : ''}
      <div class="kp-vscene-stage">${videoHtml(cur, 'kp-vscene-video')}</div>
      <div class="kp-vscene-meta">
        <span class="kp-vscene-step">${T('szene')} ${n + 1} / ${steps.length}</span>
        ${p.name ? `<strong>${esc(p.name)}${p.role ? ', ' + esc(p.role) : ''}</strong>` : ''}
      </div>
      ${cur.text ? `<div class="kp-text kp-vscene-text">${res(cur.text)}</div>` : ''}
      ${transcriptHtml(cur.transcript)}
      ${decisionReady ? `<div class="kp-dlg-decision">${renderBranch(b.decision)}</div>` : `<div class="kp-quiz-actions">
        ${n > 0 ? `<button class="kp-btn kp-sec" data-vscene-back="${b.id}">← ${T('zurueck')}</button>` : ''}
        ${last ? '' : `<button class="kp-btn" data-vscene-next="${b.id}">${T('weiter')} →</button>`}</div>`}
    </div>`;
  }

  // Große Zahl: eine Kennzahl, die hängen bleibt
  function renderBignumber(b) {
    const style = b.image && b.image.src ? ` style="background-image:linear-gradient(rgba(12,18,28,.72),rgba(12,18,28,.72)),url('${esc(res(b.image.src))}')"` : '';
    return `<div class="kp-bignum ${b.image && b.image.src ? 'kp-bignum-photo' : ''}"${style}>
      ${eyebrow(b.eyebrow)}
      <p class="kp-bignum-value"><span>${esc(b.value || '')}</span>${b.unit ? `<em>${esc(b.unit)}</em>` : ''}</p>
      ${b.html ? `<div class="kp-text kp-bignum-text">${res(b.html)}</div>` : ''}
      ${b.source ? `<p class="kp-bignum-source">${esc(b.source)}</p>` : ''}</div>`;
  }

  // Punkte im Bild: Stellen zum Erkunden (ohne Bewertung)
  // Suchbild-Runden: gleiches Format, je Runde ein neues Bild mit neuen Stellen (Kernschleife). Stand je Runde in st.rs[r], die Runde in st.r.
  function hsRound(b, st) {
    const rounds = (b.rounds || []).filter(x => x && x.image && x.image.src);
    if (!rounds.length) return { R: 0, r: -1, list: b.points || [], img: b.image && b.image.src, seen: st.seen || {}, hint: b.hint };
    const r = Math.min(Math.max(0, Number(st.r) || 0), rounds.length - 1);
    return { R: rounds.length, r, list: rounds[r].points || [], img: rounds[r].image.src, seen: ((st.rs || {})[r]) || {}, hint: rounds[r].hint || b.hint };
  }
  function hsMarkSeen(b, st, i, v) {
    const rd = hsRound(b, st);
    if (!rd.R) return { v, seen: Object.assign({}, st.seen, { [i]: true }), r: st.r, rs: st.rs };
    const rs = Object.assign({}, st.rs); rs[rd.r] = Object.assign({}, rs[rd.r], { [i]: true });
    return { v, r: rd.r, rs };
  }
  function renderHotspots(b) {
    const st = state.self[b.id] || {};
    const rd = hsRound(b, st);
    const img = rd.img;
    const open = st.v;
    const seen = rd.seen;
    const list = rd.list;
    const mode = b.mode || 'karte';
    const marker = b.marker || 'punkt';
    const cur = open != null ? list[open] : null;
    const pos = pt => ({ x: Number(pt.x) || 50, y: Number(pt.y) || 50, w: Number(pt.w) || 24, h: Number(pt.h) || 24 });
    // Ein Punkt mit `target` ist eine Tür: Der Klick führt auf die Seite, statt eine Erklärung zu öffnen.
    // „Besucht“ steht dann nicht in `seen`, sondern ergibt sich daraus, ob die Seite schon gesehen wurde.
    const doorTo = pt => (pt.target ? pageIndexById(pt.target) : -1);
    const doneAt = (pt, i) => { const d = doorTo(pt); return d >= 0 ? state.visited.has(d) : !!seen[i]; };
    // Vor und zurück zwischen den Punkten, wie beim Durchblättern: ‹ 2 von 6 ›.
    // doorTo() liefert einen Seitenindex oder -1, deshalb der Vergleich mit < 0 statt einer Wahrheitsprüfung.
    const stops = list.map((pt, i) => i).filter(i => doorTo(list[i]) < 0);
    const navBar = () => {
      if (open == null || stops.length < 2) return '';
      const at = stops.indexOf(open);
      return `<div class="kp-hs-nav">
        <button class="kp-hs-step" data-hs-step="${b.id}" data-dir="-1" aria-label="${T('zurueck')}">‹</button>
        <span>${at + 1} ${T('von')} ${stops.length}</span>
        <button class="kp-hs-step" data-hs-step="${b.id}" data-dir="1" aria-label="${T('naechsterPunkt')}">›</button>
      </div>`;
    };
    const points = list.map((pt, i) => {
      const p = pos(pt);
      const door = doorTo(pt) >= 0;
      const isOpen = !door && open === i;
      const done = doneAt(pt, i);
      // Zeichen im Punkt: Tür zeigt Pfeil oder Haken, sonst Nummer oder Plus
      const sign = door ? (done ? '✓' : '→') : marker === 'nummer' ? String(i + 1) : (isOpen ? '×' : '+');
      const flag = marker === 'fahne' && pt.title
        ? `<span class="kp-hs-label ${p.x > 60 ? 'left' : ''}" style="left:${p.x}%;top:${p.y}%" aria-hidden="true">${esc(pt.title)}</span>` : '';
      return `<button class="kp-hs-dot kp-hs-m-${marker} ${isOpen ? 'open' : ''} ${done ? 'seen' : ''} ${door ? 'kp-hs-door' : ''}" data-hs="${b.id}" data-i="${i}"
        style="left:${p.x}%;top:${p.y}%" ${door ? '' : `aria-expanded="${isOpen}"`} aria-label="${esc(pt.title || 'Punkt ' + (i + 1))}${door ? ' – ' + T('oeffnen') + (done ? ', ' + T('besucht') : '') : ''}">${sign}</button>${flag}
        ${isOpen && mode === 'popover' ? `<div class="kp-hs-pop ${p.x > 60 ? 'left' : ''} ${p.y > 60 ? 'up' : ''}" style="left:${p.x}%;top:${p.y}%" role="status">
          ${pt.image && pt.image.src ? `<img loading="lazy" decoding="async" src="${esc(res(pt.image.src))}" alt="${esc(pt.image.alt || '')}">` : ''}
          ${pt.title ? `<h3>${esc(pt.title)}</h3>` : ''}<div class="kp-text">${res(pt.html)}</div>${navBar()}</div>` : ''}`;
    }).join('');
    // Spotlight legt einen Schleier über das Bild und lässt nur die gewählte Stelle frei
    const p = cur ? pos(cur) : null;
    const spot = cur && mode === 'spotlight'
      ? `<div class="kp-hs-veil" style="--x:${p.x}%;--y:${p.y}%;--w:${p.w}%;--h:${p.h}%"></div><div class="kp-hs-frame" style="left:${p.x}%;top:${p.y}%;width:${p.w}%;height:${p.h}%"></div>` : '';
    // Zoom fährt auf die gewählte Stelle
    const zoomStyle = cur && mode === 'zoom'
      ? ` style="transform:scale(${(b.zoom || 2)});transform-origin:${p.x}% ${p.y}%"` : '';
    const count = list.length ? `<span class="kp-hs-count">${list.filter(doneAt).length} ${T('von')} ${list.length} ${T('entdeckt')}</span>` : '';
    return `<div class="kp-hotspots kp-hs-${mode} kp-hs-mk-${marker} ${b.cover ? 'kp-hs-cover' : ''}" data-hotspots="${b.id}">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}</div>` : ''}
      <div class="kp-hs-stage">
        <div class="kp-hs-zoom"${zoomStyle}>${img ? `<img src="${esc(res(img))}" alt="${esc((rd.R ? (b.rounds.filter(x => x && x.image && x.image.src)[rd.r].image.alt) : b.image.alt) || '')}">` : `<div class="kp-photo-empty">${icon('eye')}<span>Noch kein Bild</span></div>`}</div>
        ${spot}${points}</div>
      <div class="kp-hs-bar">
        ${rd.R ? `<span class="kp-hs-rounds" data-hs-round>${T('runde')} ${rd.r + 1} ${T('von')} ${rd.R}</span>` : ''}
        <p class="kp-hs-hint">${esc(rd.hint || 'Klick auf die Punkte im Bild.')}</p>
        ${count}${rd.R && list.length && list.every(doneAt) ? (rd.r < rd.R - 1 ? `<button class="kp-btn" data-hs-next-round="${b.id}">${T('naechsteRunde')} →</button>` : `<span class="kp-feedback ok" role="status">${T('alleRunden')}</span>`) : list.length > 1 ? `<button class="kp-btn kp-sec kp-hs-tour" data-hs-tour="${b.id}">${open == null ? T('fuehrungStarten') : T('naechsterPunkt')}</button>` : ''}
      </div>
      ${cur && mode !== 'popover' ? `<div class="kp-hs-info" role="status">
        ${cur.image && cur.image.src ? `<img class="kp-hs-detail" src="${esc(res(cur.image.src))}" alt="${esc(cur.image.alt || '')}">` : ''}
        ${cur.title ? `<h3>${esc(cur.title)}</h3>` : ''}<div class="kp-text">${res(cur.html)}</div>${navBar()}</div>` : ''}</div>`;
  }

  // Schichten: Ebenen über einem Bild ein- und ausblenden
  function renderLayers(b) {
    const st = state.self[b.id] || { on: {} };
    const on = st.on || {};
    const layers = (b.layers || []);
    return `<div class="kp-layers" data-layers="${b.id}">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}</div>` : ''}
      <div class="kp-ly-stage">
        ${b.image && b.image.src ? `<img src="${esc(res(b.image.src))}" alt="${esc(b.image.alt || '')}">` : `<div class="kp-photo-empty">${icon('layers')}<span>Noch kein Bild</span></div>`}
        ${layers.map((l, i) => l.image && l.image.src
          ? `<img class="kp-ly-over ${on[i] ? 'on' : ''}" src="${esc(res(l.image.src))}" alt="${on[i] ? esc(l.image.alt || l.title || '') : ''}">`
          : `<div class="kp-ly-tint ${on[i] ? 'on' : ''}" style="--c:${esc(l.color || 'var(--kp-accent)')}"></div>`).join('')}
      </div>
      <div class="kp-ly-buttons">${layers.map((l, i) => `<button class="kp-btn ${on[i] ? '' : 'kp-sec'}" data-layer="${b.id}" data-i="${i}" aria-pressed="${!!on[i]}">${esc(l.title || 'Ebene ' + (i + 1))}</button>`).join('')}</div>
      ${layers.some((l, i) => on[i] && plainText(l.html)) ? `<div class="kp-hs-info" role="status">${layers.map((l, i) => (on[i] && plainText(l.html) ? `<div class="kp-text">${res(l.html)}</div>` : '')).join('')}</div>` : ''}
    </div>`;
  }

  // Comic-Strip: mehrere Panels nebeneinander
  function renderStrip(b) {
    const panels = (b.panels || []).map(pa => {
      const p = personOf(pa);
      const media = p.image && p.image.src ? `<img loading="lazy" decoding="async" src="${esc(res(p.image.src))}" alt="${esc(p.image.alt || '')}">` : avatarSvg(p.look || 'a1', pa.pose);
      const lead = pa.castId && ((course.cast || [])[0] || {}).id === pa.castId;
      return `<figure class="kp-panel fx-reveal${lead ? ' kp-panel-lead' : ''}">
        <div class="kp-panel-art"${p.color ? ` style="--c:${esc(p.color)}"` : ''}>${media}${pa.text ? `<div class="kp-panel-bubble ${pa.think ? 'think' : ''}">${esc(pa.text)}</div>` : ''}</div>
        ${pa.caption || p.name ? `<figcaption>${p.name ? `<b>${esc(p.name)}</b> ` : ''}${esc(pa.caption || '')}</figcaption>` : ''}</figure>`;
    }).join('');
    return `<div class="kp-strip">
      ${b.title ? `<p class="kp-label">${esc(b.title)}</p>` : ''}
      <div class="kp-strip-grid" style="--cols:${Math.min(4, Math.max(1, Number(b.columns) || 3))}">${panels}</div></div>`;
  }

  // ---------- Klickpfad: Software-Simulation in drei Stufen ----------
  // zeigen: Mauszeiger fährt zur Stelle; ueben: selbst klicken mit Hilfe; pruefen: ohne Hilfe, Ergebnis am Ende
  const SIM_MODES = ['zeigen', 'ueben', 'pruefen'];
  function simState(b) {
    const modes = (b.modes || []).filter(m => SIM_MODES.includes(m));
    const list = modes.length ? modes : SIM_MODES;
    if (!state.self[b.id]) state.self[b.id] = { mode: list.includes(b.start) ? b.start : list[0], step: 0, wrong: 0, miss: [], done: false, msg: '' };
    return { st: state.self[b.id], modes: list };
  }
  function renderSimulation(b) {
    const steps = b.steps || [];
    const { st, modes } = simState(b);
    const n = steps.length;
    const label = { zeigen: T('simZeigen'), ueben: T('simUeben'), pruefen: T('simPruefen') };
    const bar = modes.length > 1 ? `<div class="kp-sim-modes" role="group" aria-label="${esc(T('simArt'))}">${modes.map(m => `<button data-sim-mode="${m}" data-block="${b.id}" aria-pressed="${st.mode === m}">${label[m]}</button>`).join('')}</div>` : '';
    const head = `${b.title ? `<h2 class="kp-q">${accent(b.title)}</h2>` : ''}${b.intro ? `<div class="kp-text" style="margin-bottom:12px">${res(b.intro)}</div>` : ''}${bar}`;
    if (!n) return `<div class="kp-sim" data-sim="${b.id}">${head}<p class="kp-label">Noch keine Schritte.</p></div>`;
    if (st.done) {
      const right = n - st.miss.length;
      const body = st.mode === 'pruefen'
        ? `<div class="kp-feedback ${st.miss.length ? 'neutral' : 'ok'}" role="status">${right} ${T('von')} ${n} ${T('simErgebnis')}</div>${st.miss.length ? `<p class="kp-label" style="margin-top:12px">${esc(T('simNochmalUeben'))}</p><ul class="kp-sim-miss">${st.miss.map(i => `<li>${T('simSchritt')} ${i + 1}: ${esc((steps[i] || {}).text || '')}</li>`).join('')}</ul>` : ''}`
        : `<div class="kp-feedback ok" role="status">${esc(st.mode === 'zeigen' ? T('simGesehen') : T('simGeschafft'))}</div>`;
      return `<div class="kp-sim" data-sim="${b.id}">${head}${body}<div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-sim-reset="${b.id}">↺ ${T('simNochmal')}</button></div></div>`;
    }
    const i = Math.min(st.step, n - 1), s = steps[i] || {};
    const show = st.mode === 'zeigen' || (st.mode === 'ueben' && st.wrong >= 2) || (st.mode === 'pruefen' && st.wrong >= 3);
    const box = `left:${+s.x || 0}%;top:${+s.y || 0}%;width:${+s.w || 10}%;height:${+s.h || 8}%`;
    const cursor = st.mode === 'zeigen' ? `<span class="kp-sim-cursor" aria-hidden="true" style="--tx:${(+s.x || 0) + (+s.w || 10) / 2}%;--ty:${(+s.y || 0) + (+s.h || 8) / 2}%"><svg viewBox="0 0 24 24"><path d="M4 2l15 11-7 1 4 8-3 1-4-8-5 5z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg></span>` : '';
    const img = s.image && s.image.src ? `<img src="${esc(res(s.image.src))}" alt="${esc(s.image.alt || '')}" draggable="false">` : `<div class="kp-sim-noimg">${T('simKeinBild')}</div>`;
    const controls = st.mode === 'zeigen'
      ? `${i > 0 ? `<button class="kp-btn kp-sec" data-sim-go="${b.id}" data-i="${i - 1}">← ${T('zurueck')}</button>` : ''}<button class="kp-btn" data-sim-hit="${b.id}">${i < n - 1 ? T('weiter') + ' →' : T('simFertig')}</button>`
      : (st.mode === 'ueben' && !show ? `<button class="kp-btn kp-sec" data-sim-show="${b.id}">${T('simStelle')}</button>` : '');
    return `<div class="kp-sim kp-sim-${st.mode}" data-sim="${b.id}">${head}
      <p class="kp-sim-task"><span>${T('simSchritt')} ${i + 1} ${T('von')} ${n}</span>${esc(s.text || '')}</p>
      <div class="kp-sim-stage" data-sim-stage="${b.id}">${img}
        <button class="kp-sim-target${show ? ' show' : ''}" data-sim-hit="${b.id}" style="${box}" aria-label="${esc(s.text || T('simZiel'))}"${st.mode === 'zeigen' ? ' tabindex="-1"' : ''}></button>${cursor}</div>
      <div class="kp-sim-msg" role="status" aria-live="polite">${st.msg ? `<div class="kp-feedback ${st.msgOk ? 'ok' : 'neutral'}">${esc(st.msg)}</div>` : ''}</div>
      ${controls ? `<div class="kp-quiz-actions">${controls}</div>` : ''}
      <div class="kp-sim-prog" aria-hidden="true"><b style="width:${Math.round(i / n * 100)}%"></b></div>
    </div>`;
  }
  function simAct(b, act, arg) {
    const steps = b.steps || [];
    const { st } = simState(b);
    if (act === 'mode') Object.assign(st, { mode: arg, step: 0, wrong: 0, miss: [], done: false, msg: '' });
    else if (act === 'reset') Object.assign(st, { step: 0, wrong: 0, miss: [], done: false, msg: '' });
    else if (act === 'go') Object.assign(st, { step: Math.max(0, Math.min(steps.length - 1, arg)), wrong: 0, msg: '' });
    else if (act === 'show') st.wrong = Math.max(st.wrong, 2);
    else if (act === 'hit') {
      const s = steps[st.step] || {};
      st.msg = st.mode === 'zeigen' ? '' : (s.done || '');
      st.msgOk = true;
      st.wrong = 0;
      if (st.step >= steps.length - 1) {
        st.done = true;
        st.fin = true; // einmal ganz durchlaufen, bleibt auch nach „Nochmal“ oder Stufenwechsel
        // Bestes Prüfergebnis bleibt, auch wenn danach wieder geübt wird (zählt bei b.graded fürs LMS)
        if (st.mode === 'pruefen' && steps.length) st.exam = Math.max(st.exam || 0, (steps.length - st.miss.length) / steps.length);
      } else st.step++;
    } else if (act === 'miss') {
      if (st.mode === 'zeigen') return false;
      const s = steps[st.step] || {};
      st.wrong++;
      st.msgOk = false;
      if (st.mode === 'pruefen') {
        if (!st.miss.includes(st.step)) st.miss.push(st.step);
        st.msg = st.wrong >= 3 ? T('simGezeigt') : T('simPruefDaneben');
      } else st.msg = st.wrong >= 2 ? (s.hint ? s.hint + ' ' : '') + T('simGezeigt') : (s.hint || T('simDaneben'));
    }
    return true;
  }

  // ---------- Sortieren, Prozess, Weiter-Sperre, Anhang ----------
  // Sortieren in Kategorien: mit Maus ziehen oder mit der Tastatur zuordnen
  function renderSort(b) {
    const st = state.self[b.id] || { place: {}, done: false };
    const cats = b.categories || [];
    const items = (b.items || []);
    const order = state.pools['sort-' + b.id] || items.map((x, i) => i);
    // Spalten sind { title }; die Karte nennt ihre Spalte per Titel
    const catAt = n => { const c = cats[n]; return c && typeof c === 'object' ? c.title : c; };
    const open = order.filter(i => st.place[i] == null);
    const chip = (i, inCat) => {
      const it = items[i];
      const right = st.done && st.place[i] != null && it.cat === catAt(st.place[i]);
      return `<li class="kp-sort-item ${st.done ? (right ? 'kp-right' : 'kp-wrong') : ''}" draggable="${st.done ? 'false' : 'true'}" data-sort-item="${i}" data-block="${b.id}" tabindex="0">
        <span>${esc(it.text)}</span>
        ${st.done ? (right ? '<b aria-label="richtig">✔</b>' : `<b aria-label="falsch">✘ <span class="kp-sort-fix">${esc(it.cat)}</span></b>`) : `<span class="kp-sort-move">${cats.map((c, ci) => `<button data-sort-to="${ci}" data-item="${i}" data-block="${b.id}" title="Nach „${esc(c.title)}“" ${inCat === ci ? 'disabled' : ''}>${ci + 1}</button>`).join('')}</span>`}
      </li>`;
    };
    const boxes = cats.map((c, ci) => `<div class="kp-sort-cat" data-sort-cat="${ci}" data-block="${b.id}">
      <p class="kp-sort-cat-title"><span class="kp-num" aria-hidden="true">${ci + 1}</span>${esc(c.title)}</p>
      <ul>${order.filter(i => st.place[i] === ci).map(i => chip(i, ci)).join('') || '<li class="kp-sort-empty">Noch nichts zugeordnet</li>'}</ul></div>`).join('');
    const score = st.done ? items.filter((it, i) => st.place[i] != null && it.cat === catAt(st.place[i])).length : 0;
    return `<div class="kp-sortcats" data-sortcats="${b.id}">
      ${b.title ? `<h2 class="kp-q">${accent(b.title)}</h2>` : ''}
      ${b.intro ? `<div class="kp-text" style="margin-bottom:12px">${res(b.intro)}</div>` : ''}
      <p class="kp-sort-hint">${esc(b.hint || 'Zieh die Karten in die passende Spalte. Mit der Tastatur: Karte anwählen und die Nummer der Spalte drücken.')}</p>
      <div class="kp-sort-pool"><ul>${open.map(i => chip(i, null)).join('') || '<li class="kp-sort-empty">Alles zugeordnet</li>'}</ul></div>
      <div class="kp-sort-cats">${boxes}</div>
      ${st.done
        ? `<div class="kp-feedback ${score === items.length ? 'ok' : 'neutral'}" role="status">${score} von ${items.length} richtig zugeordnet.${score === items.length ? '' : ' Die richtige Spalte steht jetzt hinter den falschen Karten.'}</div>
           <div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-sort-reset="${b.id}">Noch einmal</button></div>`
        : `<div class="kp-quiz-actions"><button class="kp-btn" data-sort-check="${b.id}" ${open.length ? 'disabled' : ''}>Zuordnung prüfen</button></div>`}
    </div>`;
  }

  // Stellen im Text finden: die gesuchten Textstellen werden im Fließtext anklickbar gemacht
  function renderFindText(b) {
    const spots = b.spots || [];
    const st = state.self[b.id] || { hit: [] };
    const hit = st.hit || [];
    const gesucht = spots.map((x, i) => i).filter(i => spots[i].wrong !== false);
    const gefunden = gesucht.filter(i => hit.includes(i));
    const fertig = gesucht.length > 0 && gefunden.length === gesucht.length;
    // Jede gesuchte Stelle einmal im Text durch einen Knopf ersetzen
    let body = res(b.body || '');
    spots.forEach((sp, i) => {
      const t = String(sp.text || '');
      if (!t) return;
      const at = body.indexOf(t);
      if (at < 0) return;
      const offen = hit.includes(i);
      const kl = ['kp-ft-spot', offen ? (sp.wrong === false ? 'is-ok' : 'is-found') : ''].filter(Boolean).join(' ');
      const mark = `<button type="button" class="${kl}" data-ft-spot="${i}" data-block="${b.id}" ${offen ? 'disabled' : ''}>${esc(t)}</button>`;
      body = body.slice(0, at) + mark + body.slice(at + t.length);
    });
    const zuletzt = hit.length ? spots[hit[hit.length - 1]] : null;
    const panel = fertig
      ? `<p class="kp-ft-ptitle">${esc(b.revealTitle || T('ftFertig'))}</p><div class="kp-text">${res(b.reveal || '')}</div>`
      : zuletzt
        ? `<p class="kp-ft-ptitle ${zuletzt.wrong === false ? 'is-ok' : ''}">${zuletzt.wrong === false ? T('ftBelegt') : T('ftGefunden')}</p><div class="kp-text"><p>${esc(zuletzt.why || '')}</p></div>`
        : `<p class="kp-ft-ptitle is-quiet">${T('ftLos')}</p><div class="kp-text"><p>${esc(b.hint || T('ftHinweis'))}</p></div>`;
    return `<div class="kp-ft" data-findtext="${b.id}">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}${b.intro ? `<div class="kp-text">${res(b.intro)}</div>` : ''}</div>` : ''}
      <div class="kp-ft-split">
        <div class="kp-ft-doc">
          ${(b.meta || []).length ? `<dl class="kp-ft-meta">${(b.meta || []).map(m => `<dt>${esc(m.label || '')}</dt><dd>${esc(m.value || '')}</dd>`).join('')}</dl>` : ''}
          <div class="kp-text kp-ft-body">${body}</div>
        </div>
        <aside class="kp-ft-panel ${fertig ? 'is-done' : ''}" role="status">
          ${panel}
          <p class="kp-ft-count">${gefunden.length} ${T('von')} ${gesucht.length} ${T('ftGefundenZahl')}</p>
          ${fertig ? `<div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-ft-reset="${b.id}">${T('nochEinmal')}</button></div>` : ''}
        </aside>
      </div>
    </div>`;
  }

  // Anfrage aufbauen: links die Bausteine, rechts der Entwurf, der sich mit jedem Klick ändert
  function renderPromptBuild(b) {
    const steps = b.steps || [];
    const st = state.self[b.id] || { taken: [] };
    const taken = (st.taken || []).filter(i => steps[i]);
    const last = taken.length ? steps[taken[taken.length - 1]] : null;
    const quality = last ? last.quality : b.quality0;
    const draft = last ? last.draft : b.draft0;
    const note = last ? last.note : b.note0;
    const anteil = steps.length ? taken.length / steps.length : 0;
    const knoepfe = steps.map((x, i) => `<button type="button" class="kp-pb-btn ${taken.includes(i) ? 'is-on' : ''}" data-pb-add="${i}" data-block="${b.id}" ${taken.includes(i) ? 'disabled' : ''}>${esc(x.button || '+')}</button>`).join('');
    const zeilen = taken.map((i, n) => `<p class="kp-pb-line ${n === taken.length - 1 ? 'is-new' : ''}">${esc(steps[i].line || '')}</p>`).join('');
    return `<div class="kp-pb" data-promptbuild="${b.id}">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}${b.intro ? `<div class="kp-text">${res(b.intro)}</div>` : ''}</div>` : ''}
      <div class="kp-pb-split">
        <div class="kp-pb-card">
          <p class="kp-pb-label">${esc(b.startLabel || T('pbStart'))}</p>
          <p class="kp-pb-ask">„${esc(b.ask || '')}“</p>
          <div class="kp-pb-btns">${knoepfe}</div>
          ${taken.length ? `<div class="kp-pb-lines">${zeilen}</div>` : `<p class="kp-pb-empty">${esc(b.emptyHint || T('pbLeer'))}</p>`}
          ${taken.length === steps.length && steps.length ? `<div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-pb-reset="${b.id}">${T('nochEinmal')}</button></div>` : ''}
        </div>
        <div class="kp-pb-card kp-pb-draft" role="status">
          <p class="kp-pb-label">${esc(b.draftLabel || T('pbEntwurf'))}<span class="kp-pb-quality">${esc(b.qualityLabel || T('pbGuete'))} · <b>${esc(quality || '')}</b></span></p>
          <div class="kp-text kp-pb-body">${res(draft || '')}</div>
          <div class="kp-pb-bar" role="img" aria-label="${esc((b.qualityLabel || T('pbGuete')) + ': ' + (quality || ''))}"><i style="width:${Math.round(Math.max(anteil, 0.12) * 100)}%"></i></div>
          ${note ? `<p class="kp-pb-note">${esc(note)}</p>` : ''}
        </div>
      </div>
    </div>`;
  }

  // Stück für Stück entscheiden: links die Karten, rechts die offene Frage zur aktiven Karte
  function renderTriage(b) {
    const items = b.items || [];
    const st = state.self[b.id] || { d: {}, cur: 0 };
    const ja = b.labelTrue || T('triJa');
    const nein = b.labelFalse || T('triNein');
    const offen = items.map((x, i) => i).filter(i => st.d[i] == null);
    const fertig = !offen.length && items.length > 0;
    // Aktiv ist die zuletzt angetippte Karte, sonst die erste offene
    const aktiv = st.cur != null && items[st.cur] ? st.cur : (offen.length ? offen[0] : null);
    // Mehr als zwei Möglichkeiten (choices[], items[].answer als Index), z. B. im Postfach: selbst, delegieren, eskalieren, später
    const wahl = (b.choices || []).filter(x => String(x || '').trim());
    const multi = wahl.length >= 2;
    const ticket = b.look === 'ticket';
    const mail = b.look === 'postfach' || ticket;
    const nameOf = w => (multi ? wahl[Number(w)] || '' : w === 'j' ? ja : nein);
    const richtig = i => multi ? Number(st.d[i]) === (Number(items[i].answer) || 0) : (st.d[i] === 'j') === (items[i].keep !== false);
    const karten = items.map((it, i) => {
      const w = st.d[i];
      const falsch = fertig && w != null && !richtig(i);
      const cls = ['kp-tri-card', multi ? (w != null ? 'kp-tri-set' : '') : w === 'j' ? 'kp-tri-in' : w === 'n' ? 'kp-tri-out' : '', i === aktiv && w == null ? 'is-active' : '', falsch ? 'kp-tri-wrong' : ''].filter(Boolean).join(' ');
      const soll = multi ? wahl[Number(it.answer) || 0] : (it.keep !== false ? ja : nein);
      const icon2 = ticket
        ? '<svg class="kp-tri-doc" viewBox="0 0 28 20" aria-hidden="true"><path d="M2 6a2 2 0 0 1 2-2h20a2 2 0 0 1 2 2v2a2.5 2.5 0 0 0 0 5v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2a2.5 2.5 0 0 0 0-5z"/><path d="M11 4v13" stroke-dasharray="2 2"/></svg>'
        : mail
        ? '<svg class="kp-tri-doc" viewBox="0 0 28 20" aria-hidden="true"><rect x="1.5" y="1.5" width="25" height="17" rx="2"/><path d="M2 3l12 9 12-9"/></svg>'
        : '<svg class="kp-tri-doc" viewBox="0 0 24 28" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="25" rx="2"/><path d="M6 9h12M6 14h12M6 19h8"/></svg>';
      return `<button type="button" class="${cls}" data-tri-pick="${i}" data-block="${b.id}" ${w != null ? 'disabled' : ''} aria-pressed="${i === aktiv}">
        ${w != null ? `<span class="kp-tri-badge">${esc(nameOf(w))}</span>` : ''}
        ${icon2}
        ${mail && it.sub ? `<span class="kp-tri-from">${esc(it.sub)}</span>` : ''}
        <span class="kp-tri-name">${esc(it.title || '')}</span>
        ${!mail && it.sub ? `<span class="kp-tri-sub">${esc(it.sub)}</span>` : ''}
        ${mail && it.preview ? `<span class="kp-tri-prev">${esc(it.preview)}</span>` : ''}
        ${falsch ? `<span class="kp-tri-fix">${T('triRichtigWaere')} ${esc(soll)}</span>` : ''}
      </button>`;
    }).join('');
    let panel;
    if (!items.length) {
      panel = `<p class="kp-lock">${T('triLeer')}</p>`;
    } else if (fertig) {
      const score = items.filter((x, i) => richtig(i)).length;
      panel = `<p class="kp-tri-eyebrow">${T('triFertig')}</p>
        <p class="kp-tri-title">${score} ${T('von')} ${items.length} ${T('triRichtig')}</p>
        ${score < items.length ? `<p class="kp-tri-sub2">${T('triNachlesen')}</p>` : ''}
        <div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-tri-reset="${b.id}">${T('nochEinmal')}</button></div>`;
    } else if (st.d[aktiv] != null) {
      const it = items[aktiv];
      panel = `<p class="kp-tri-eyebrow">${richtig(aktiv) ? T('triPasst') : T('triSchauNochmal')}</p>
        <p class="kp-tri-title">${esc(it.title || '')}</p>
        ${it.feedback ? `<div class="kp-text kp-tri-fb">${res(it.feedback)}</div>` : ''}
        ${ticket && Number(it.stars) >= 1 ? `<p class="kp-tri-stars" role="img" aria-label="${esc(T('triBewertung'))}: ${Math.min(5, Number(it.stars))} ${T('von')} 5"><small>${T('triBewertung')}</small>${'★'.repeat(Math.min(5, Number(it.stars)))}${'☆'.repeat(5 - Math.min(5, Number(it.stars)))}</p>` : ''}
        <div class="kp-quiz-actions"><button class="kp-btn" data-tri-next="${b.id}">${T('weiter')} →</button></div>`;
    } else {
      const it = items[aktiv];
      panel = `<p class="kp-tri-eyebrow">${T('triGewaehlt')}</p>
        <p class="kp-tri-title">${esc(it.title || '')}</p>
        ${it.sub ? `<p class="kp-tri-sub2">${esc(it.sub)}</p>` : ''}
        ${mail && it.preview ? `<p class="kp-tri-fb">${esc(it.preview)}</p>` : ''}
        <p class="kp-tri-frage">${esc(b.question || T('triFrage'))}</p>
        <div class="kp-tri-buttons${multi ? ' kp-tri-multi' : ''}">
          ${multi ? wahl.map((c, k) => `<button type="button" data-tri-go="${k}" data-i="${aktiv}" data-block="${b.id}">${esc(c)}</button>`).join('') : `
          <button type="button" class="kp-tri-yes" data-tri-go="j" data-i="${aktiv}" data-block="${b.id}">${esc(ja)}</button>
          <button type="button" class="kp-tri-no" data-tri-go="n" data-i="${aktiv}" data-block="${b.id}">${esc(nein)}</button>`}
        </div>`;
    }
    return `<div class="kp-tri${mail ? ' kp-tri-mail' : ''}${ticket ? ' kp-tri-ticket' : ''}" data-triage="${b.id}">
      ${b.eyebrow || b.title ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}${b.intro ? `<div class="kp-text">${res(b.intro)}</div>` : ''}</div>` : ''}
      <div class="kp-tri-split">
        <div class="kp-tri-board">${karten}</div>
        <div class="kp-tri-panel" role="status">${panel}</div>
      </div>
      <p class="kp-sr" role="status">${items.length - offen.length} ${T('von')} ${items.length}</p>
    </div>`;
  }

  // ---------- Folgen-Regler: mehrere Regler, das Ergebnis ändert sich sofort ----------
  // Ergebnis = base + Summe(weight * Reglerwert), begrenzt auf min..max; das Band (bands[].max aufsteigend) liefert Einordnung und Text
  function leverVal(b, st, i) {
    const s = (b.sliders || [])[i] || {};
    const v = (st.v || {})[i];
    return v != null ? Number(v) : (s.value !== '' && s.value != null ? Number(s.value) : Number(s.min) || 0);
  }
  function leversResult(b, st) {
    let v = Number(b.base) || 0;
    (b.sliders || []).forEach((s, i) => { v += (Number(s.weight) || 0) * leverVal(b, st, i); });
    const lo = b.min !== '' && b.min != null ? Number(b.min) : 0;
    const hi = b.max !== '' && b.max != null ? Number(b.max) : 100;
    v = Math.max(lo, Math.min(hi, v));
    const bands = (b.bands || []).filter(x => x && x.max !== '' && x.max != null).slice().sort((a, c) => Number(a.max) - Number(c.max));
    const band = bands.find(x => v <= Number(x.max)) || bands[bands.length - 1] || null;
    const bi = band ? bands.indexOf(band) : -1;
    return { v: Math.round(v * 10) / 10, pct: hi > lo ? (v - lo) / (hi - lo) * 100 : 0, band, tone: bands.length < 2 ? 1 : bi / (bands.length - 1) };
  }
  function leversResultHtml(b, st) {
    const r = leversResult(b, st);
    return `<p class="kp-lev-label">${esc(b.resultLabel || T('levErgebnis'))}</p>
      <p class="kp-lev-num"><b>${esc(String(r.v).replace('.', ','))}</b>${b.unit ? ` <span>${esc(b.unit)}</span>` : ''}</p>
      <div class="kp-lev-bar" role="meter" aria-valuenow="${r.v}" aria-valuemin="${esc(b.min || 0)}" aria-valuemax="${esc(b.max || 100)}" aria-label="${esc(b.resultLabel || T('levErgebnis'))}"><i style="width:${Math.max(2, r.pct)}%;--kp-lev-t:${r.tone}"></i></div>
      ${r.band ? `<p class="kp-lev-band">${esc(r.band.label || '')}</p>${r.band.html ? `<div class="kp-text kp-lev-text">${res(r.band.html)}</div>` : ''}` : ''}`;
  }
  function renderLevers(b) {
    const st = state.self[b.id] || {};
    const sl = b.sliders || [];
    const offen = sl.length - (st.t || []).length;
    return `<div class="kp-lev" data-levers="${b.id}">
      ${b.eyebrow || b.title || b.intro ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}${b.intro ? `<div class="kp-text">${res(b.intro)}</div>` : ''}</div>` : ''}
      <div class="kp-lev-split">
        <div class="kp-lev-ctrl">${sl.map((s, i) => {
          const v = leverVal(b, st, i);
          return `<label class="kp-lev-row"><span class="kp-lev-name">${esc(s.label || '')}</span>
            <span class="kp-estimate"><input type="range" min="${Number(s.min) || 0}" max="${s.max !== '' && s.max != null ? Number(s.max) : 10}" step="${Number(s.step) || 1}" value="${v}" data-lev="${i}" aria-label="${esc(s.label || '')}">
            <output class="kp-estimate-val" data-lev-out="${i}">${esc(v)}${s.unit ? ' ' + esc(s.unit) : ''}</output></span></label>`;
        }).join('')}</div>
        <div class="kp-lev-out" role="status" aria-live="polite" data-lev-result>${leversResultHtml(b, st)}</div>
      </div>
      ${offen > 0 ? `<p class="kp-lev-hint" data-lev-hint>${T('levHinweis')}</p>` : ''}
    </div>`;
  }

  // ---------- Chat: Nachrichtenverlauf, Antwort wählen, das Gegenüber reagiert ----------
  // Zustand state.self[id] = { n: aktuelle Runde, pick: { Runde: Möglichkeit }, tried: { Runde: [Fehlversuche] } }
  function renderChat(b) {
    const st = state.self[b.id] || {};
    const turns = b.turns || [];
    const n = Math.min(Number(st.n) || 0, turns.length);
    const who = b.persona || {};
    const initials = String(who.name || '?').split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
    const them = t => `<div class="kp-chat-msg kp-chat-them">${esc(t)}</div>`;
    const lines = txt => String(txt || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
    const log = [];
    turns.forEach((turn, k) => {
      if (k > n) return;
      lines(turn.them).forEach(t => log.push(them(t)));
      if (k < n) {
        const o = (turn.options || [])[(st.pick || {})[k]] || {};
        log.push(`<div class="kp-chat-msg kp-chat-me">${esc(o.text || '')}</div>`);
        lines(o.reply).forEach(t => log.push(them(t)));
        if (o.feedback) log.push(`<div class="kp-chat-note">${res(o.feedback)}</div>`);
      }
    });
    const cur = n < turns.length ? turns[n] : null;
    const tried = ((st.tried || {})[n]) || [];
    // Laune in der Handlung: die Figur oben zeigt die Haltung zur letzten Antwort (Fehlversuch dieser Runde, sonst die gewählte der vorigen)
    const face = who.castId ? castOf({ castId: who.castId }) : who;
    const lastOpt = tried.length ? ((cur.options || [])[tried[tried.length - 1]] || {}) : n > 0 ? (((turns[n - 1] || {}).options || [])[(st.pick || {})[n - 1]] || {}) : {};
    const mood = lastOpt.mood || 'neutral';
    const avatar = face.look && face.look !== 'image' ? `<span class="kp-chat-av kp-chat-face" data-mood="${esc(mood)}" aria-hidden="true">${avatarSvg(face.look, mood, true)}</span>`
      : face.image && face.image.src ? `<span class="kp-chat-av kp-chat-face" data-mood="${esc(mood)}" aria-hidden="true"><img src="${esc(res(face.image.src))}" alt=""></span>`
      : `<span class="kp-chat-av" aria-hidden="true">${esc(initials)}</span>`;
    if (cur && tried.length) {
      const last = (cur.options || [])[tried[tried.length - 1]] || {};
      log.push(`<div class="kp-chat-msg kp-chat-me kp-chat-undo">${esc(last.text || '')}</div>`);
      lines(last.reply).forEach(t => log.push(them(t)));
      log.push(`<div class="kp-chat-note kp-chat-retry" role="status">${last.feedback ? res(last.feedback) : ''}<p>${T('chatNochmal')}</p></div>`);
    }
    const choices = cur ? `<div class="kp-chat-choices" role="group" aria-label="${T('chatWaehle')}">
        <p class="kp-chat-ask">${T('chatWaehle')}</p>
        ${(cur.options || []).map((o, i) => `<button type="button" class="kp-chat-opt" data-chat-pick="${i}" data-block="${b.id}" ${tried.includes(i) ? 'disabled' : ''}>${esc(o.text || '')}</button>`).join('')}
      </div>`
      : `<div class="kp-chat-end" role="status">${b.end ? `<div class="kp-text">${res(b.end)}</div>` : `<p>${T('chatEnde')}</p>`}
          <div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-chat-reset="${b.id}">${T('nochEinmal')}</button></div></div>`;
    return `<div class="kp-chat" data-chat="${b.id}">
      ${b.title ? `<h2 class="kp-q">${accent(b.title)}</h2>` : ''}
      ${b.intro ? `<div class="kp-text kp-chat-intro">${res(b.intro)}</div>` : ''}
      <div class="kp-chat-phone">
        <div class="kp-chat-head">${avatar}<span><b>${esc(face.name || who.name || '')}</b>${face.role || who.role ? `<small>${esc(face.role || who.role)}</small>` : ''}</span></div>
        <div class="kp-chat-log" aria-live="polite">${log.join('')}</div>
        ${choices}
      </div>
    </div>`;
  }

  // ---------- Matrix: Begriffe frei in eine Vier-Felder-Fläche legen, dann mit der Einschätzung vergleichen ----------
  // Positionen x/y in Prozent (y = 100 oben). Zustand state.self[id] = { p: { i: [x, y] }, sel, cmp }
  const MX_Q = [[25, 75], [75, 75], [25, 25], [75, 25]]; // links oben, rechts oben, links unten, rechts unten
  function mxQuad(x, y) { return (y >= 50 ? 0 : 2) + (x >= 50 ? 1 : 0); }
  function renderMatrix(b) {
    const st = state.self[b.id] || {};
    const items = b.items || [];
    const p = st.p || {};
    const placed = items.filter((x, i) => p[i]).length;
    const sel = st.cmp ? null : (st.sel != null && items[st.sel] ? st.sel : items.findIndex((x, i) => !p[i]));
    const q = b.quadrants || [];
    const dot = (i, xy, cls) => `<span class="kp-mx-dot ${cls}" style="left:${xy[0]}%;top:${100 - xy[1]}%">${i + 1}</span>`;
    const expert = i => [Number(items[i].x) || 0, Number(items[i].y) || 0];
    const lines = st.cmp ? `<svg class="kp-mx-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${items.map((x, i) => p[i] ? `<line x1="${p[i][0]}" y1="${100 - p[i][1]}" x2="${expert(i)[0]}" y2="${100 - expert(i)[1]}"/>` : '').join('')}</svg>` : '';
    const drop = sel >= 0 && sel != null && !st.cmp ? MX_Q.map((c, k) => `<button type="button" class="kp-mx-drop kp-mx-drop-${k}" data-mx-q="${k}" data-block="${b.id}">${T('mxHierAblegen')}${q[k] ? ': ' + esc(q[k]) : ''}</button>`).join('') : '';
    const field = `<div class="kp-mx-wrap">
        ${b.yHigh ? `<span class="kp-mx-ax kp-mx-yh">${esc(b.yHigh)}</span>` : ''}${b.yLow ? `<span class="kp-mx-ax kp-mx-yl">${esc(b.yLow)}</span>` : ''}
        <div class="kp-mx-field${sel >= 0 && sel != null && !st.cmp ? ' is-armed' : ''}" data-mx-field="${b.id}">
          ${MX_Q.map((c, k) => `<span class="kp-mx-quad kp-mx-quad-${k}">${esc(q[k] || '')}</span>`).join('')}
          ${lines}
          ${items.map((x, i) => p[i] ? dot(i, p[i], 'kp-mx-mine') : '').join('')}
          ${st.cmp ? items.map((x, i) => dot(i, expert(i), 'kp-mx-exp')).join('') : ''}
          ${drop}
        </div>
        <span class="kp-mx-ax kp-mx-xl">${esc(b.xLow || '')}</span><span class="kp-mx-ax kp-mx-xh">${esc(b.xHigh || '')}</span>
      </div>`;
    let side;
    if (st.cmp) {
      side = `<p class="kp-mx-eyebrow">${T('mxVergleich')}</p>
        <p class="kp-mx-legend"><span class="kp-mx-dot kp-mx-mine">1</span> ${T('mxDeine')} <span class="kp-mx-dot kp-mx-exp">1</span> ${esc(b.expertLabel || T('mxExperte'))}</p>
        <ol class="kp-mx-list">${items.map((x, i) => {
          const same = p[i] && mxQuad(p[i][0], p[i][1]) === mxQuad(...expert(i));
          const near = p[i] && Math.hypot(p[i][0] - expert(i)[0], p[i][1] - expert(i)[1]) <= 18;
          return `<li><b>${esc(x.text || '')}</b> <span class="kp-mx-tag ${same ? 'ok' : 'no'}">${same ? (near ? T('mxNah') : T('mxGleichesFeld')) : T('mxAnderesFeld')}</span>${x.why ? `<div class="kp-text">${res(x.why)}</div>` : ''}</li>`;
        }).join('')}</ol>
        <div class="kp-quiz-actions"><button class="kp-btn kp-sec" data-mx-reset="${b.id}">${T('nochEinmal')}</button></div>`;
    } else {
      side = `<p class="kp-mx-eyebrow">${placed} ${T('von')} ${items.length} ${T('mxAbgelegt')}</p>
        <p class="kp-mx-help">${T('mxHilfe')}</p>
        <div class="kp-mx-chips">${items.map((x, i) => `<button type="button" class="kp-mx-chip${i === sel ? ' is-sel' : ''}${p[i] ? ' is-placed' : ''}" data-mx-sel="${i}" data-block="${b.id}" aria-pressed="${i === sel}"><span>${i + 1}</span>${esc(x.text || '')}</button>`).join('')}</div>
        ${placed === items.length && items.length ? `<div class="kp-quiz-actions"><button class="kp-btn" data-mx-cmp="${b.id}">${esc(b.compareLabel || T('mxVergleichen'))}</button></div>` : ''}`;
    }
    return `<div class="kp-mx" data-matrix="${b.id}">
      ${b.eyebrow || b.title || b.intro ? `<div class="kp-sec-head">${eyebrow(b.eyebrow)}${b.title ? `<h2 class="kp-sec-title">${accent(b.title)}</h2>` : ''}${b.intro ? `<div class="kp-text">${res(b.intro)}</div>` : ''}</div>` : ''}
      <div class="kp-mx-split">${field}<div class="kp-mx-side" role="status">${side}</div></div>
    </div>`;
  }

  // Prozess: Schritte einzeln durchklicken
  function renderProcess(b) {
    const steps = b.steps || [];
    const n = Math.min(state.dlg[b.id] || 0, Math.max(0, steps.length - 1));
    const s = steps[n] || {};
    // Stapel: Schritte stehen untereinander und kommen nacheinander dazu
    if (b.look === 'stapel') return `<div class="kp-process kp-proc-stack" data-process="${b.id}">
      ${b.title ? `<h2 class="kp-q">${accent(b.title)}</h2>` : ''}
      <ol class="kp-proc-list">${steps.slice(0, n + 1).map((x, i) => `<li class="kp-proc-item${i === n ? ' kp-proc-new' : ''}">
        <span class="kp-proc-num" aria-hidden="true">${i + 1}</span>
        <div>${x.title ? `<h4 class="kp-proc-title">${esc(x.title)}</h4>` : ''}<div class="kp-text">${res(x.html)}</div></div>
        ${x.image && x.image.src ? `<div class="kp-proc-media"><img loading="lazy" decoding="async" src="${esc(res(x.image.src))}" alt="${esc(x.image.alt || '')}"${focusStyle(x.image)}></div>` : ''}</li>`).join('')}</ol>
      ${n < steps.length - 1 ? `<div class="kp-quiz-actions"><button class="kp-btn" data-proc-go="${b.id}" data-i="${n + 1}">${T('weiter')} → <span class="kp-proc-count">${n + 2} ${T('von')} ${steps.length}</span></button></div>` : ''}</div>`;
    return `<div class="kp-process" data-process="${b.id}">
      ${b.title ? `<h2 class="kp-q">${accent(b.title)}</h2>` : ''}
      <ol class="kp-proc-nav">${steps.map((x, i) => `<li><button class="${i === n ? 'current' : ''} ${i < n ? 'done' : ''}" data-proc-go="${b.id}" data-i="${i}" aria-current="${i === n}"><span>${i + 1}</span>${esc(x.title || '')}</button></li>`).join('')}</ol>
      <div class="kp-proc-body">
        ${s.image && s.image.src ? `<div class="kp-proc-media"><img loading="lazy" decoding="async" src="${esc(res(s.image.src))}" alt="${esc(s.image.alt || '')}"${focusStyle(s.image)}></div>` : ''}
        <div><p class="kp-eyebrow">${T('schritt')} ${n + 1} ${T('von')} ${steps.length}</p>
          ${s.title ? `<h4 class="kp-proc-title">${esc(s.title)}</h4>` : ''}
          <div class="kp-text">${res(s.html)}</div></div>
      </div>
      <div class="kp-quiz-actions">
        ${n > 0 ? `<button class="kp-btn kp-sec" data-proc-go="${b.id}" data-i="${n - 1}">← ${T('zurueck')}</button>` : ''}
        ${n < steps.length - 1 ? `<button class="kp-btn" data-proc-go="${b.id}" data-i="${n + 1}">${T('weiter')} →</button>` : ''}
      </div></div>`;
  }

  // Weiter-Sperre: Der Rest der Seite erscheint erst auf Klick
  function renderGate(b) {
    const done = (state.self[b.id] || {}).done;
    return done ? '<div class="kp-gate-open" aria-hidden="true"></div>'
      : `<div class="kp-gate"><div class="kp-text">${res(b.html)}</div>
        <button class="kp-btn" data-gate="${b.id}">${esc(b.label || 'Weiter')}</button></div>`;
  }

  // Checkliste: die Lernenden haken selbst ab, der Stand steht in state.self[id].c (Indizes)
  function clStatus(b) {
    const done = ((state.self[b.id] || {}).c || []).length, n = (b.items || []).length;
    return `<p class="kp-cl-status${done >= n && n ? ' all' : ''}" role="status" data-cl-status>${esc(T(done >= n && n ? 'clAlle' : 'clStand').replace('{n}', done).replace('{z}', n))}</p>`;
  }
  // Gegenüberstellung: Schritte an einer senkrechten Achse, je Schritt zwei beschriftete Seiten.
  // Die Analogie zum Bekannten trägt das Neue – deshalb steht links immer das Vertraute.
  function renderCompare(b) {
    const steps = b.steps || [];
    const l = b.leftLabel || 'Bekannt', r = b.rightLabel || 'Neu';
    return `<div class="kp-cmp" data-cmp="${b.id}">
      ${b.title ? `<h2 class="kp-q">${accent(b.title)}</h2>` : ''}
      ${plainText(b.intro) ? `<div class="kp-text">${res(b.intro)}</div>` : ''}
      <ol class="kp-cmp-list">${steps.map((s, i) => `<li class="kp-cmp-step">
        <span class="kp-cmp-dot" aria-hidden="true">${i + 1}</span>
        <div class="kp-cmp-card">
          <p class="kp-cmp-eyebrow">${esc(s.eyebrow || `${T('schritt')} ${i + 1}`)}</p>
          ${s.title ? `<h3>${esc(s.title)}</h3>` : ''}
          <div class="kp-cmp-sides">
            <div class="kp-cmp-side"><p class="kp-cmp-label">${esc(l)}</p><div class="kp-text">${res(s.left)}</div></div>
            <div class="kp-cmp-side"><p class="kp-cmp-label kp-cmp-new">${esc(r)}</p><div class="kp-text">${res(s.right)}</div></div>
          </div>
          ${s.image && s.image.src ? `<img class="kp-cmp-img" loading="lazy" decoding="async" src="${esc(res(s.image.src))}" alt="${esc(s.image.alt || '')}">` : ''}
        </div>
      </li>`).join('')}</ol>
    </div>`;
  }

  // Sammelalbum: Für jede besuchte Seite kommt ein Fundstück dazu. Der Stand kommt aus `state.visited`,
  // das Album speichert also nichts Eigenes und bleibt beim Wiedereinstieg richtig.
  function renderAlbum(b) {
    const items = b.items || [];
    const found = it => { const i = pageIndexById(it.page); return i >= 0 && state.visited.has(i); };
    const n = items.filter(found).length;
    const geheim = b.reveal === 'geheim';
    const cards = items.map((it, i) => {
      const ok = found(it);
      const name = ok || !geheim ? esc(it.title || `${T('fundstueck')} ${i + 1}`) : '?';
      return `<li class="kp-alb-item ${ok ? 'kp-alb-found' : ''}">
        <div class="kp-alb-pic">${ok && it.image && it.image.src
          ? `<img loading="lazy" decoding="async" src="${esc(res(it.image.src))}" alt="${esc(it.image.alt || it.title || '')}">`
          : `<span aria-hidden="true">${ok ? '✓' : '?'}</span>`}</div>
        <h3>${name}</h3>
        ${ok && plainText(it.html) ? `<div class="kp-text">${res(it.html)}</div>` : `<p class="kp-alb-open">${T(ok ? 'gefunden' : 'nochOffen')}</p>`}
      </li>`;
    }).join('');
    const alle = items.length && n === items.length;
    return `<div class="kp-album" data-album="${b.id}">
      ${b.title ? `<h2 class="kp-q">${accent(b.title)}</h2>` : ''}
      ${plainText(b.intro) ? `<div class="kp-text">${res(b.intro)}</div>` : ''}
      <p class="kp-alb-count"><b>${n}</b> ${T('von')} ${items.length} ${T('gefunden')}</p>
      <div class="kp-alb-bar"><i style="width:${items.length ? Math.round(n / items.length * 100) : 0}%"></i></div>
      <ul class="kp-alb-list">${cards}</ul>
      ${alle && plainText(b.doneHtml) ? `<div class="kp-alb-done kp-text" role="status">${res(b.doneHtml)}</div>` : ''}
    </div>`;
  }

  function renderChecklist(b) {
    const c = (state.self[b.id] || {}).c || [];
    return `<div class="kp-checklist" data-checklist="${b.id}">
      ${b.title ? `<h2 class="kp-q">${accent(b.title)}</h2>` : ''}
      ${b.intro ? `<div class="kp-text">${res(b.intro)}</div>` : ''}
      <ul class="kp-cl-list">${(b.items || []).map((t, i) => `<li><label class="${c.includes(i) ? 'done' : ''}"><input type="checkbox" data-check-item="${i}" ${c.includes(i) ? 'checked' : ''}><span>${esc(t)}</span></label></li>`).join('')}</ul>
      ${clStatus(b)}</div>`;
  }

  // Anhang: Dateien zum Herunterladen
  function renderAttachments(b) {
    const items = (b.files || []).filter(f => f.src);
    return `<div class="kp-files">
      ${b.title ? `<p class="kp-label">${esc(b.title)}</p>` : ''}
      ${items.length ? `<ul>${items.map(f => `<li><a href="${esc(res(f.src))}" download="${esc(f.name || 'datei')}">${icon('book')}<span><strong>${esc(f.name || 'Datei')}</strong>${f.note ? `<em>${esc(f.note)}</em>` : ''}</span><span class="kp-file-dl">${T('herunterladen')}</span></a></li>`).join('')}</ul>`
        : '<p class="kp-lock">Noch keine Datei hinterlegt.</p>'}</div>`;
  }

  // ---------- Seite und Ergebnis ----------
  function renderPage(p) {
    if (p.result) return renderResult();
    // Titelzeile buendig mit einem breiten ersten Baustein (Klasse kp-head-wide)
    const firstWide = (((p.blocks || [])[0] || {}).design || {}).width === 'wide';
    // Microlearning: die erste Seite eines Kapitels bekommt das dunkle Band mit Kapitelnummer „05 / 06“
    const chs = theme.style === 'micro' ? microChapters() : null;
    const chAt = chs ? chs.findIndex(ch => ch.pages[0] === pages.indexOf(p)) : -1;
    const num = chAt >= 0 ? `<span class="kp-ml-num">${String(chAt + 1).padStart(2, '0')}<small>/ ${String(chs.length).padStart(2, '0')}</small></span>` : '';
    const head = p.hideTitle ? '' : `<header class="kp-page-head${firstWide ? ' kp-head-wide' : ''}${chAt >= 0 ? ' kp-ml-chapstart' : ''}">${num}${eyebrow(p.eyebrow)}<h1>${accent(p.title)}</h1>${chAt >= 0 && p.chapter && plainTitle(p.title) !== p.chapter ? `<p class="kp-ml-chap">${esc(p.chapter)}</p>` : ''}</header>`;
    let blocked = false; // hinter einer Weiter-Sperre bleibt der Rest der Seite verborgen
    const parts = (p.blocks || []).map(b => {
      if (blocked) return `<section class="kp-block kp-b-${b.type} kp-hidden" data-block="${b.id}" hidden></section>`;
      if (b.type === 'gate' && !(state.self[b.id] || {}).done) blocked = true;
      const look = b.design || {};
      const cls = ['kp-block', 'kp-b-' + b.type];
      if (isCustom(b) || b.type === 'html') cls.push('kp-b-custom');
      if (look.bg) cls.push('kp-bg-' + look.bg);
      if (look.width && look.width !== 'normal') cls.push('kp-w-' + look.width);
      if (look.space === 'large') cls.push('kp-sp-large');
      if (set.layout === 'scroll' || theme.effects !== 'dezent') cls.push('fx-reveal');
      // Foto-Hintergrund: Der Schleier bestimmt Stimmung und Lesbarkeit
      if (look.bg === 'image') cls.push('kp-ov-' + (look.overlay || 'light'));
      const bgMove = look.bg === 'image' && look.bgImage && look.bgImage.src && ['zoom', 'pan'].includes(look.bgMotion);
      if (bgMove) cls.push('kp-bgm', 'kp-bgm-' + look.bgMotion);
      if (look.bg === 'dark' || (look.bg === 'image' && ['dark', 'primary'].includes(look.overlay))) cls.push('kp-on-dark');
      const styles = [];
      if (look.bg === 'image' && look.bgImage && look.bgImage.src) {
        styles.push(`--kp-bgimg:url('${esc(res(look.bgImage.src))}')`);
        if (look.bgImage.focus) styles.push(`--kp-bgpos:${esc(look.bgImage.focus)}`);
      }
      const style = styles.length ? ` style="${styles.join(';')}"` : '';
      const decor = look.decor ? `<span class="kp-decor" aria-hidden="true">${icon(look.decor)}</span>` : '';
      const lang = look.lang ? ` lang="${esc(look.lang)}"` : '';
      const band = look.band ? `<span class="kp-band">${esc(look.band)}</span>` : '';
      // Abschnittsform: weicher Übergang zwischen zwei farbigen Abschnitten
      const shape = look.bg && look.shape && look.shape !== 'kante'
        ? `<span class="kp-shape kp-shape-${esc(look.shape)}" aria-hidden="true"></span>` : '';
      const inner = b.type === 'sources' ? renderBlock(b) : footnotes(renderBlock(b));
      return `<section class="${cls.join(' ')}" data-block="${b.id}"${hasCond(b) ? ' data-cond="1"' + (conditionMet(b.showIf) ? '' : ' hidden') : ''}${style}${lang}>${bgMove ? '<span class="kp-bgmove" aria-hidden="true"></span>' : ''}${decor}<div class="kp-block-inner">${band}${narrationButton(b)}${inner}</div>${shape}</section>`;
    });
    // Zwei halbbreite Blöcke nebeneinander: aufeinanderfolgende werden zu einer Reihe gebündelt
    const out = [];
    (p.blocks || []).forEach((b, i) => {
      const half = ((b.design || {}).width === 'half') && !(blocked && i > 0);
      const prev = out[out.length - 1];
      if (half && prev && prev.row && prev.n < 2) { prev.html += parts[i]; prev.n++; }
      else out.push(half ? { row: true, n: 1, html: parts[i] } : { row: false, html: parts[i] });
    });
    // Ohne Test gibt es keine Ergebnisseite: die Empfehlung steht dann auf der letzten Seite
    const isLast = !pages.some(x => x.result) && pages.indexOf(p) === pages.length - 1;
    return head + out.map(x => (x.row ? `<div class="kp-row">${x.html}</div>` : x.html)).join('') + (isLast ? nextCourseCard() : '');
  }

  // Was im Kurs erledigt wurde: Seiten, Kapitel, richtige Fragen, Übungen – für „Das hast du geschafft“
  function achievements() {
    const content = pages.map((p, i) => i).filter(i => !pages[i].result && !pages[i].extra);
    const seen = content.filter(i => state.visited.has(i)).length;
    const chapters = chapterList(true);
    const chaptersDone = chapters.filter(c => c.pages.every(i => state.visited.has(i))).length;
    const qs = items.filter(it => it.q || it.html);
    const right = qs.filter(it => itemFraction(it) >= 1).length;
    let ex = 0, exDone = 0;
    pages.forEach(p => (p.blocks || []).forEach(b => {
      if (b.type === 'quiz' || b.type === 'pool' || b.type === 'pretest' || b.type === 'review' || !INTERACTIVE_DONE.includes(b.type) || (b.type === 'takeaways' && !b.recall)) return;
      ex++; if (blockDone(b)) exDone++;
    }));
    return { seen, pagesTotal: content.length, chaptersDone, chaptersTotal: chapters.filter(c => c.name).length, right, questions: qs.length, exDone, ex };
  }
  const INTERACTIVE_DONE = ['branch', 'dialog', 'selfcheck', 'reflection', 'actionplan', 'ivideo', 'mission', 'game', 'simulation', 'casebank', 'triage', 'promptbuild', 'findtext', 'hotspots', 'checklist', 'sortcats', 'flipcards', 'glossquiz', 'predict', 'process', 'album', 'levers', 'chat', 'matrix', 'takeaways'];

  // Ergebnisring: Kreis füllt sich bis zum Prozentwert (Animation über stroke-dashoffset, unter „Bewegung reduzieren“ steht er sofort)
  function scoreRing(pct, passed) {
    const r = 54, u = 2 * Math.PI * r;
    const off = u * (1 - Math.max(0, Math.min(100, pct)) / 100);
    return `<div class="kp-score-ring ${passed ? 'is-ok' : 'is-no'}" role="img" aria-label="${pct} %">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="kp-ring-bg" cx="60" cy="60" r="${r}"></circle>
        <circle class="kp-ring-on" cx="60" cy="60" r="${r}" stroke-dasharray="${u.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" style="--kp-ring-u:${u.toFixed(2)}" transform="rotate(-90 60 60)"></circle>
      </svg>
      <div class="kp-score" data-count data-count-to="${pct} %">${pct} %</div>
    </div>`;
  }

  // Empfehlung „Wie geht es weiter?“ am Kursende (settings.nextCourse): auf der Ergebnisseite, ohne Test auf der letzten Seite
  function nextCourseCard() {
    const n = set.nextCourse || {};
    if (!String(n.title || '').trim()) return '';
    const url = String(n.url || '').trim();
    return `<div class="kp-nextcourse"><p class="kp-label">${T('wieWeiter')}</p>
      ${n.image && n.image.src ? `<img class="kp-nc-img" src="${esc(res(n.image.src))}" alt="${esc(n.image.alt || '')}" loading="lazy">` : ''}
      <div class="kp-nc-body"><h2 class="kp-q">${accent(n.title)}</h2>${plainText(n.text) ? `<div class="kp-text">${res(n.text)}</div>` : ''}
      ${url ? `<a class="kp-btn kp-nc-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(n.label || T('kursOeffnen'))} ↗</a>` : ''}</div></div>`;
  }
  function renderResult() {
    const s = score();
    if (s.open) {
      return `<div class="kp-result"><h1>Fast geschafft</h1><p>Es ${s.open === 1 ? 'ist noch 1 Testfrage' : 'sind noch ' + s.open + ' Testfragen'} offen. Über das Inhaltsverzeichnis kommst du zu den Fragen zurück.</p></div>`;
    }
    const passed = s.pct >= passScore;
    // Je Lernziel: Balken, Anzahl richtiger Fragen und Sprung ins Kapitel, in dem das Ziel behandelt wird
    const objs = objectiveStats();
    const objHtml = objs.length ? `<div class="kp-objectives"><p class="kp-label">${T('ergebnisJeLernziel')}</p>${objs.map((x, i) => {
      const chap = pages[x.firstPage] && pages[x.firstPage].chapter || '';
      const chapStart = chap ? pages.findIndex(p => p.chapter === chap) : x.firstPage;
      return `<div class="kp-obj ${x.passed ? 'ok' : 'weak'}" style="--kp-i:${i}">
        <span class="kp-obj-text">${esc(x.o.text)}${chap ? `<em class="kp-obj-chap">${esc(chap)}</em>` : ''}</span>
        <strong>${x.pct} %</strong>
        <div class="kp-obj-bar" role="progressbar" aria-valuenow="${x.pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${x.pct}%"></div></div>
        <span class="kp-obj-count">${x.right} ${T('von')} ${x.total} ${T('richtig')}</span>
        ${x.passed ? `<span class="kp-obj-ok">${icon('check-circle')} ${T('sitzt')}</span>` : `<button class="kp-btn kp-sec kp-obj-go" data-goto="${chapStart}">${chap ? `${T('zumKapitel')} „${esc(chap)}“` : T('nochmalAnsehen')}</button>`}</div>`;
    }).join('')}</div>` : '';
    const sureWrong = graded().filter(it => it.q && state.conf[it.id] === 2 && itemFraction(it) < 1).length;
    const calib = sureWrong ? `<div class="kp-note kp-calib">Bei ${sureWrong === 1 ? 'einer Frage' : sureWrong + ' Fragen'} warst du dir sicher, lagst aber falsch. Diese Themen lohnen einen zweiten Blick.</div>` : '';
    const review = graded().map(it => {
      const f = itemFraction(it);
      const playName = { simulation: 'Klickpfad', mission: 'Mini-Mission', game: 'Level-Spiel' };
      const label = it.q ? it.q.question : it.branch ? (it.branch.prompt || 'Entscheidung') : it.play ? `${playName[it.play.type]}: ${String(it.play.title || pages[it.pageIndex].title).replace(/\*/g, '')}` : 'Frage auf der Seite „' + pages[it.pageIndex].title + '“';
      return `<div><span aria-label="${f >= 1 ? 'richtig' : f > 0 ? 'teilweise richtig' : 'falsch'}">${f >= 1 ? '✔' : f > 0 ? '◐' : '✘'}</span><span>${esc(label)}</span></div>`;
    }).join('');
    // „Das hast du geschafft“: Zahlen aus dem Lernstand
    const a = achievements();
    const stat = (n, label, ico) => `<div class="kp-done-item">${icon(ico)}<b>${n}</b><span>${label}</span></div>`;
    const doneHtml = `<div class="kp-done"><p class="kp-label">${T('geschafftTitel')}</p><div class="kp-done-grid">
      ${stat(`${a.seen} ${T('von')} ${a.pagesTotal}`, T('seitenGesehen'), 'book')}
      ${a.chaptersTotal ? stat(`${a.chaptersDone} ${T('von')} ${a.chaptersTotal}`, T('kapitelFertig'), 'layers') : ''}
      ${a.questions ? stat(`${a.right} ${T('von')} ${a.questions}`, T('fragenRichtig'), 'check-circle') : ''}
      ${a.ex ? stat(`${a.exDone} ${T('von')} ${a.ex}`, T('uebungenErledigt'), 'target') : ''}
    </div></div>`;
    const certPage = pages.findIndex(p => (p.blocks || []).some(b => b.type === 'certificate'));
    const name = firstName();
    const prev = state.self.prev && state.self.prev.max ? state.self.prev : null;
    const prevHtml = prev ? `<p class="kp-prev ${s.pct > prev.pct ? 'up' : s.pct < prev.pct ? 'down' : 'same'}" data-prev="${prev.pct}">${T('letzterVersuch')}: ${prev.pct} % · ${T('heute')}: <b>${s.pct} %</b> · ${s.pct > prev.pct ? T('besserAls') : s.pct < prev.pct ? T('unterLetztem') : T('gleichWie')}</p>` : '';
    return `<div class="kp-result"><p class="kp-label">${T('deinErgebnis')}</p>${scoreRing(s.pct, passed)}
      <p>${s.got} von ${s.max} Punkten · Bestehensgrenze ${passScore} %</p>${prevHtml}
      <div class="kp-feedback ${passed ? 'ok' : 'no'}" role="status">${passed ? (name ? `${T('bestandenName').replace('{n}', esc(name))}` : T('bestanden')) : T('nichtBestanden')}</div>
      <div class="kp-quiz-actions" style="justify-content:center">
        ${passed ? '' : '<button class="kp-btn" data-retry-all>Test wiederholen</button>'}
        ${passed && certPage >= 0 ? `<button class="kp-btn" data-goto="${certPage}">Zum Zertifikat</button>` : ''}
      </div>${doneHtml}${objHtml}${calib}
      ${planCard(certBlock())}<div class="kp-review">${review}</div>${nextCourseCard()}</div>`;
  }

  // Kursart Microlearning: Seitenleiste mit Status, Lernzeit, zwei Balken und Kapitelliste (Vorbild: Lernplattformen mit fester linker Leiste)
  function microChapters() {
    const out = [];
    pages.forEach((p, i) => {
      if (p.result) return;
      const name = p.chapter || '';
      const last = out[out.length - 1];
      if (last && last.name === name) last.pages.push(i); else out.push({ name, pages: [i] });
    });
    return out;
  }
  function microSide() {
    const pr = progressResult();
    const content = pages.map((p, i) => p.result || p.extra ? -1 : i).filter(i => i >= 0);
    const pagesPct = content.length ? Math.round(content.filter(i => state.visited.has(i)).length / content.length * 100) : 0;
    const sc = score();
    const resultPct = graded().length ? Math.round(sc.max ? sc.got / sc.max * 100 : 0) : null;
    const maxOk = unlockedUpTo();
    const chapters = microChapters();
    const testPages = new Set(graded().map(it => it.pageIndex));
    const info = pages.map((p, i) => i).filter(i => (pages[i].blocks || []).some(b => b.type === 'sources' || b.type === 'attachments')).pop();
    // Ein eigenes Kapitel nur für den Mediennachweis steht als Eintrag „Weitere Informationen“ unter der Liste, nicht doppelt darin
    const infoCh = info != null ? chapters.find(ch => ch.pages.length === 1 && ch.pages[0] === info) : null;
    const list = chapters.filter(ch => ch !== infoCh).map((ch, k) => {
      const seen = ch.pages.filter(i => state.visited.has(i)).length;
      const cur = ch.pages.includes(state.current);
      const done = seen === ch.pages.length;
      const test = ch.pages.some(i => testPages.has(i));
      const locked = set.gating && ch.pages[0] > maxOk;
      return `<li class="kp-ml-ch${cur ? ' current' : ''}${done ? ' done' : ''}"><button type="button" data-goto="${ch.pages[0]}" ${locked ? 'disabled' : ''} ${cur ? 'aria-current="true"' : ''}><span>${esc(ch.name || pages[ch.pages[0]].title || (k + 1))}</span>${done ? '<b class="kp-ml-mark" aria-label="erledigt">✓</b>' : test ? '<b class="kp-ml-mark kp-ml-q" aria-hidden="true">?</b>' : ''}</button><i class="kp-ml-chbar" style="--w:${Math.round(seen / ch.pages.length * 100)}%"></i></li>`;
    }).join('');
    const bar = (pct, label) => `<div class="kp-ml-bar"><b>${pct == null ? '–' : pct + ' %'}</b><span>${label}</span><i role="progressbar" aria-label="${esc(label)}" aria-valuenow="${pct || 0}" aria-valuemin="0" aria-valuemax="100" style="--w:${pct || 0}%"></i></div>`;
    return `<nav class="kp-ml-side" aria-label="${esc(T('inhalt'))}">
      <div class="kp-ml-top">
        <p class="kp-ml-status">${icon('check-circle')} ${T('mlStatus')}: ${pr.completed ? T('mlAbgeschlossen') : T('mlInBearbeitung')}</p>
        <h2 class="kp-ml-title">${esc(course.title)}</h2>
        ${course.subtitle ? `<p class="kp-ml-sub">${esc(course.subtitle)}</p>` : ''}
        <p class="kp-ml-time">${icon('clock')} ${estimateMinutes()} ${T('mlMinuten')}</p>
        <div class="kp-ml-bars">${bar(pagesPct, T('mlFortschritt'))}${bar(resultPct, T('mlErgebnis'))}</div>
      </div>
      <ol class="kp-ml-chapters">${list}</ol>
      ${info != null ? `<button type="button" class="kp-ml-info" data-goto="${info}"><b>${T('mlWeitere')}</b><span>${T('mlMedien')}</span></button>` : ''}
    </nav>`;
  }
  function render(moveFocus) {
    // Laufende Videos, Töne und Zeitgeber der vorigen Seite beenden
    mediaTimers.forEach(t => (typeof t === 'object' ? t.stop() : clearInterval(t)));
    mediaTimers = [];
    clearTimeout(dlgTimer);
    stopSound();
    cbOpen = null; // ein offener Fall gehört zur Seite, die gerade verlassen wird
    const p = pages[state.current];
    if (!p) { root.innerHTML = '<main class="kp-main"><h1>Dieser Kurs hat noch keine Seiten.</h1></main>'; return; }
    state.visited.add(state.current);
    if (drawReviews(state.current)) buildItems();
    pageStyle.textContent = res(p.css) + '\n' + (p.blocks || []).map(b => b.blockCss ? scopeCss(res(b.blockCss), `[data-block="${b.id}"]`) : '').join('\n');
    let header = '';
    let prog = '';
    if (!chrome.hideHeader) {
      if (chrome.header) {
        header = `<header class="kp-custom-head">${fill(res(chrome.header))}</header>`;
      } else {
        const tools = [];
        if (set.toc !== false) tools.push(`<button class="kp-iconbtn" data-drawer="toc">${T('inhalt')}</button>`);
        const hub = pages.findIndex(x => (x.blocks || []).some(b => b.type === 'chapters'));
        if (hub >= 0 && hub !== state.current) tools.push(`<button class="kp-iconbtn" data-goto="${hub}">${T('uebersicht')}</button>`);
        if (set.search !== false && pages.length > 3) tools.push(`<button class="kp-iconbtn" data-drawer="search">${T('suchen')}</button>`);
        if (set.notes) tools.push(`<button class="kp-iconbtn" data-drawer="notes">${T('notizen')}</button>`);
        if (set.trainerMode) tools.push(`<button class="kp-iconbtn" data-drawer="trainer" title="${esc(T('trTitel'))}">${T('trainer')}</button>`);
        if ((course.glossary || []).length) tools.push(`<button class="kp-iconbtn" data-drawer="glossary">${T('glossar')}</button>`);
        // Sprachwahl, wenn der Kurs Übersetzungen hat
        const langSel = langs.length ? `<label class="kp-lang"><span class="kp-sr">${T('sprache')}</span><select data-lang aria-label="${T('sprache')}">
          <option value="">${esc((course.lang || 'de').toUpperCase())}</option>${langs.map(l => `<option value="${esc(l.code)}" ${state.lang === l.code ? 'selected' : ''}>${esc(l.code.toUpperCase())}</option>`).join('')}</select></label>` : '';
        const logo = chrome.logo && chrome.logo.src ? `<img class="kp-logo" src="${esc(res(chrome.logo.src))}" alt="${esc(chrome.logo.alt || '')}">` : '';
        // Das KI-Kennzeichen sitzt in der Kopfzeile: auf jeder Seite bei der ersten Begegnung sichtbar und nie über dem Inhalt
        header = `<header class="kp-head">${tools.join('')}${logo}<span class="kp-course">${esc(course.title)}${p.chapter ? `<span class="kp-head-chapter">${esc(p.chapter)}</span>` : ''}</span>${aiMarkHtml()}${langSel}<span class="kp-head-count">${state.current + 1} / ${pages.length}</span></header>`;
        prog = set.progress === false ? '' : `<div class="kp-progress" role="progressbar" aria-label="Fortschritt" aria-valuenow="${Math.round((state.current + 1) / pages.length * 100)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${(state.current + 1) / pages.length * 100}%"></div></div>`;
      }
    }
    // Kopfleiste unten oder links: Kopfzeile und Navigation stehen zusammen in einer Leiste
    const footHtml = `<footer class="${chrome.footer ? 'kp-custom-foot' : 'kp-foot'}" data-footer ${chrome.hideFooter ? 'hidden' : ''}></footer>`;
    const bar = navPos === 'oben' ? `${header}${prog}` : '';
    const sideBar = navPos === 'oben' ? footHtml
      : `<div class="kp-navbar">${prog}<div class="kp-navrow">${header}${theme.style === 'micro' && navPos === 'links' ? microSide() : ''}${footHtml}</div></div>`;
    root.innerHTML = `
      <a class="kp-skip" href="#kp-main">${T('zumInhalt')}</a>
      ${bar}
      ${set.layout === 'scroll' ? '<div class="kp-readbar" aria-hidden="true"><b></b></div>' : ''}
      <main class="kp-main ${p.animation ? 'fx-' + p.animation : ''}" id="kp-main" tabindex="-1">${renderPage(p)}</main>
      ${sideBar}
      ${chrome.hideHeader || chrome.header ? aiMarkHtml('kp-ai-fixed') : ''}
      <div class="kp-backdrop" data-close-drawer></div>
      <aside class="kp-drawer" id="kp-drawer" aria-label="Seitenleiste"></aside>
      ${opts.review ? reviewPanelHtml() : ''}`;
    renderFooter();
    activateComponents(root);
    measureNav();
    if (opts.focusBlock && state.current === opts.startPage) {
      const el = root.querySelector(`[data-block="${opts.focusBlock}"]`);
      opts.focusBlock = null;
      if (el) setTimeout(() => el.scrollIntoView({ block: 'center' }), 60);
    } else {
      window.scrollTo(0, 0);
    }
    // Nach dem Seitenwechsel springt der Fokus auf den Inhalt (wichtig für Screenreader)
    if (moveFocus) root.querySelector('#kp-main').focus({ preventScroll: true });
    // Lesefortschritt innerhalb der Seite (Scroll-Darstellung)
    const readbar = root.querySelector('.kp-readbar b');
    if (readbar && !window.__kpReadbar) {
      window.__kpReadbar = true;
      window.addEventListener('scroll', () => {
        const bar = root.querySelector('.kp-readbar b');
        const max = document.documentElement.scrollHeight - window.innerHeight;
        if (bar) bar.style.width = (max > 0 ? Math.min(100, window.scrollY / max * 100) : 100) + '%';
      }, { passive: true });
    }
    // Sprechertext automatisch starten (nur nach einem Klick der Lernenden, sonst blockiert der Browser den Ton)
    if (moveFocus && set.autoNarration) {
      const first = root.querySelector('[data-narr]');
      if (first) first.click();
    }
    report();
  }

  function renderFooter() {
    const foot = root.querySelector('[data-footer]');
    if (!foot) return;
    const hint = blockedHere();
    // Eine Seite mit eigenem Weiter-Ziel ist nie eine Sackgasse, auch wenn sie am Ende der Liste steht
    // (Räume einer Lernwelt liegen hinter der Übersicht und führen auf sie zurück)
    const ownNext = pageIndexById((pages[state.current] || {}).next);
    const last = state.current >= pages.length - 1 && ownNext < 0;
    // In der Scroll-Darstellung kündigt der Fuß die nächste Seite an (gibt Orientierung)
    const nx = last ? null : pages[nextIndex()];
    const preview = set.layout === 'scroll' && nx && !hint
      ? `<div class="kp-next-preview"><span>${nx.chapter && nx.chapter !== pages[state.current].chapter ? T('naechstesKapitel') + ' · ' + esc(nx.chapter) : T('alsNaechstes')}</span><strong>${accent(nx.title)}</strong></div>` : '';
    foot.innerHTML = chrome.footer ? fill(res(chrome.footer), { hinweis: esc(hint) }) : `${preview}
      <button class="kp-btn kp-sec" data-back>← ${T('zurueck')}</button>
      ${hint ? `<span class="kp-lock" role="status">${hint}</span>` : ''}
      <button class="kp-btn" data-next>${T('weiter')} →</button>`;
    // Zustand aller Navigationsknöpfe setzen, auch in eigenen Kopfzeilen und im Seiteninhalt
    root.querySelectorAll('[data-back]').forEach(b => { b.disabled = state.current === 0 && !state.history.length; });
    root.querySelectorAll('[data-next]').forEach(b => { b.disabled = last || !!hint; });
  }

  // KI-Kennzeichen: kleines Zeichen in der Kopfzeile, auf jeder Seite sichtbar (bei eigener oder ausgeblendeter Kopfzeile fest unten links).
  // Artikel 50 Absatz 5 EU-KI-Verordnung verlangt klar, unterscheidbar und zugänglich –
  // der ganze Text steht eine Taste entfernt, statt einmalig auf Seite 1 zu stehen. In der Leiste verdeckt es nie eine Antwort.
  function aiMarkHtml(cls) {
    const txt = String(set.aiNotice || '').trim();
    if (!txt) return '';
    return `<div class="kp-ai-mark ${cls || ''}">
      <button type="button" class="kp-ai-btn" data-ai-toggle aria-expanded="false" aria-controls="kp-ai-text">
        <span class="kp-ai-tag" aria-hidden="true">KI</span><span class="kp-ai-word">${T('kiMarke')}</span>
      </button>
      <div class="kp-ai-text" id="kp-ai-text" role="note" hidden><b>${T('kiHinweis')}</b> ${esc(txt)}</div>
    </div>`;
  }

  // Die Leiste unten verdeckt sonst das Kennzeichen: ihre Höhe als Variable weitergeben
  function measureNav() {
    const st = document.documentElement.style;
    // Randlose Bloecke rechnen mit der sichtbaren Breite: 50vw enthaelt die Scrollleiste und ragte sonst rechts hinaus
    const half = () => st.setProperty('--kp-half', (document.documentElement.clientWidth / 2) + 'px');
    half();
    if (!measureNav.ro && typeof ResizeObserver === 'function') { measureNav.ro = new ResizeObserver(half); measureNav.ro.observe(document.documentElement); }
    const bar = navPos === 'unten' ? root.querySelector('.kp-navbar') : null;
    st.setProperty('--kp-navh', bar ? Math.round(bar.getBoundingClientRect().height) + 'px' : '0px');
    // Die Kopfzeile oben zählt für eine bildschirmfüllende Titelseite genauso mit
    const kopf = navPos === 'oben' ? root.querySelector('.kp-head') : null;
    const prog = navPos === 'oben' ? root.querySelector('.kp-progress') : null;
    const h = (kopf ? kopf.getBoundingClientRect().height : 0) + (prog ? prog.getBoundingClientRect().height : 0);
    st.setProperty('--kp-headh', Math.round(h) + 'px');
  }

  // Platzhalter in eigenen Kopf- und Fußzeilen
  function fill(template, extra) {
    const p = pages[state.current];
    const vars = Object.assign({
      kurs: plainTitle(course.title), titel: plainTitle(p.title), kapitel: esc(p.chapter || ''),
      seite: state.current + 1, seiten: pages.length,
      fortschritt: Math.round((state.current + 1) / pages.length * 100), hinweis: ''
    }, extra || {});
    return String(template).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  }

  // Weiche Überblendung zwischen Seiten, wo der Browser sie kann; sonst direkter Wechsel
  function pageTransition(swap, back) {
    const html = document.documentElement;
    if (document.startViewTransition && html.classList.contains('kp-modern') && !reducedMotion() && !document.hidden) {
      html.classList.toggle('kp-back', !!back);
      try {
        const vt = document.startViewTransition(swap);
        if (vt && vt.ready) vt.ready.catch(() => { /* übersprungen, z. B. bei schnellem Doppelklick */ });
        if (vt && vt.finished) vt.finished.then(() => html.classList.remove('kp-back'), () => html.classList.remove('kp-back'));
        return;
      } catch (e) { html.classList.remove('kp-back'); }
    }
    swap();
  }
  function go(index) {
    if (index < 0 || index >= pages.length || index === state.current) return;
    const prev = state.current;
    state.history.push(state.current);
    state.current = index;
    pageTransition(() => { render(true); chapterToast(prev); });
  }

  // Einen einzelnen Block neu zeichnen, ohne die Seite neu aufzubauen
  function refreshBlock(el, html) {
    const sec = el.closest('[data-block]');
    const owner = sec && findBlock(sec.dataset.block);
    const tmp = document.createElement('div');
    tmp.innerHTML = footnotes(html);
    const fresh = tmp.firstElementChild;
    el.replaceWith(fresh);
    activateComponents(fresh.parentElement || root);
    if (owner && owner.type === 'pretest') {
      // Beim Einstiegstest hängt der Ergebniskasten von allen Fragen ab: nur ihn erneuern
      const t2 = document.createElement('div');
      t2.innerHTML = renderPretest(owner);
      const oldBox = sec.querySelector('.kp-pretest-box');
      const newBox = t2.querySelector('.kp-pretest-box');
      if (oldBox) oldBox.remove();
      if (newBox) sec.appendChild(newBox);
    }
    // „Weiter ansehen“ im Video erst nach der Antwort
    root.querySelectorAll('[data-vcontinue][data-q]').forEach(btn => { btn.disabled = state.answers[btn.dataset.q] == null; });
    // Zertifikat und Nachbesprechung auf derselben Seite hängen von Antworten ab
    root.querySelectorAll('.kp-b-certificate, .kp-b-debrief').forEach(s => {
      if (s.querySelector('[data-cert-name]') && s.contains(document.activeElement)) return;
      const b = findBlock(s.dataset.block);
      if (b) s.innerHTML = renderBlock(b);
    });
    // Fokus auf die Rückmeldung, damit Screenreader sie vorlesen
    const fb = fresh.querySelector && fresh.querySelector('.kp-feedback, .kp-saved, .kp-q');
    if (fb) { fb.tabIndex = -1; fb.focus({ preventScroll: true }); }
    updateConditions();
    renderFooter();
    report();
  }

  // ---------- Bedingungen und Szenario-Werte ----------
  // b.showIf: { kind: 'choice', ref: Entscheidungs-id, value: Index | [Indizes] }
  //           { kind: 'selfcheck', ref: Selbstcheck-id, value: Index des Ergebnisbereichs }
  //           { kind: 'meter', ref: Szenario-Wert-id, op: 'gte' | 'lt', value: Zahl }
  function selfcheckResultIndex(b) {
    const st = state.self[b.id];
    if (!b || !st || !st.done) return -1;
    const sum = (st.a || []).reduce((x, y) => x + (Number(y) || 0), 0);
    return (b.results || []).findIndex(x => sum >= Number(x.min) && sum <= Number(x.max));
  }
  // Szenario-Werte: Startwert plus die Wirkung aller getroffenen Entscheidungen, begrenzt auf 0 bis 100
  function meterValues() {
    const vals = {};
    (course.meters || []).forEach(m => { vals[m.id] = Number(m.start) || 0; });
    pages.forEach(p => branchesIn(p).forEach(br => {
      const c = state.branch[br.id];
      if (c == null) return;
      const eff = ((br.options || [])[c] || {}).effects || {};
      Object.keys(eff).forEach(k => { if (k in vals) vals[k] += Number(eff[k]) || 0; });
    }));
    Object.keys(vals).forEach(k => { vals[k] = Math.max(0, Math.min(100, vals[k])); });
    return vals;
  }
  // Ist die Übung in einem Block erledigt? Grundlage für „erst zeigen, wenn …“ und für die Weiter-Sperre
  function blockDone(b) {
    if (!b) return true;
    const st = state.self[b.id] || {};
    const alle = (n, ok) => n > 0 && !!ok;
    const umgedreht = () => {
      const karten = root.querySelectorAll(`[data-block="${b.id}"] .kp-flip`);
      return alle(karten.length, [...karten].every(f => f.classList.contains('kp-seen')));
    };
    switch (b.type) {
      case 'quiz': return state.answers[b.id] != null;
      case 'branch': return state.branch[b.id] != null && !branchWhyOpen(b);
      case 'dialog': return b.decision ? state.branch[b.decision.id] != null && !branchWhyOpen(b.decision) : (state.dlg[b.id] || 0) >= (b.lines || []).length - 1;
      case 'takeaways': return b.recall ? alle((b.items || []).length, (b.items || []).every((x, i) => (st.open || []).includes(i))) : Object.keys(st).length > 0;
      case 'gate': case 'selfcheck': return !!st.done;
      case 'reflection': case 'actionplan': return state.texts[b.id] != null;
      case 'ivideo': return !!state.watched[b.id];
      case 'mission': case 'game': return !!(state.self.mm || {})[b.id];
      case 'simulation': {
        // Mit Stufe „Prüfen“ zählt erst ein Prüfdurchlauf, ohne sie ein kompletter Durchlauf in einer der angebotenen Stufen
        const m = (b.modes || []).filter(x => SIM_MODES.includes(x));
        return (m.length ? m : SIM_MODES).includes('pruefen') ? playFraction(b) != null : !!st.fin;
      }
      case 'casebank': return cbDoneCount(b) >= cbGoal(b);
      case 'triage': return alle((b.items || []).length, (b.items || []).every((x, i) => (st.d || {})[i] != null));
      case 'levers': return alle((b.sliders || []).length, (st.t || []).length >= (b.sliders || []).length);
      case 'chat': return alle((b.turns || []).length, (Number(st.n) || 0) >= (b.turns || []).length);
      case 'matrix': return !!st.cmp;
      case 'promptbuild': return alle((b.steps || []).length, (st.taken || []).length >= (b.steps || []).length);
      case 'findtext': {
        const gesucht = (b.spots || []).map((x, i) => i).filter(i => (b.spots[i] || {}).wrong !== false);
        return alle(gesucht.length, gesucht.every(i => (st.hit || []).includes(i)));
      }
      case 'hotspots': {
        const rounds = (b.rounds || []).filter(x => x && x.image && x.image.src);
        if (rounds.length) return alle(rounds.length, rounds.every((rd, r) => (rd.points || []).length && (rd.points || []).every((pt, i) => pt.target || ((st.rs || {})[r] || {})[i])));
        const list = b.points || [];
        const stops = list.map((x, i) => i).filter(i => !list[i].target);
        return alle(stops.length, stops.every(i => (st.seen || {})[i]));
      }
      case 'layers': return Object.keys(st.on || {}).some(k => st.on[k]);
      case 'checklist': return alle((b.items || []).length, (st.c || []).length >= (b.items || []).length);
      case 'flipcards': return umgedreht();
      case 'glossquiz': return b.mode === 'memory' ? alle(drawnPairs(b).length, (st.found || []).length >= drawnPairs(b).length)
        : b.mode === 'match' ? state.answers[b.id] != null : umgedreht();
      case 'process': return alle((b.steps || []).length, (state.dlg[b.id] || 0) >= (b.steps || []).length - 1);
      case 'pool': case 'pretest': return (b.questions || []).every(q => state.answers[q.id] != null);
      case 'review': { const qs = reviewQuestions(b); return alle(qs.length, qs.every(q => state.answers[q.id] != null)); }
      default: return Object.keys(st).length > 0;
    }
  }
  function conditionMet(cond) {
    if (!cond || !cond.kind) return true;
    if (cond.kind === 'done') return blockDone(findBlock(cond.ref));
    if (cond.kind === 'choice') {
      const c = state.branch[cond.ref];
      const want = Array.isArray(cond.value) ? cond.value.map(Number) : [Number(cond.value)];
      return c != null && want.includes(c);
    }
    if (cond.kind === 'selfcheck') { const b = findBlock(cond.ref); return !!b && selfcheckResultIndex(b) === Number(cond.value); }
    if (cond.kind === 'meter') {
      const v = meterValues()[cond.ref];
      if (v == null) return false;
      return cond.op === 'lt' ? v < Number(cond.value) : v >= Number(cond.value);
    }
    return true;
  }
  const hasCond = b => !!(b && b.showIf && b.showIf.kind);
  // Blöcke, die auf einer Seite gerade durch eine Bedingung verborgen sind (zählen nicht für die Sperre)
  function condHiddenIds(p) {
    const ids = new Set();
    (p.blocks || []).forEach(b => {
      if (!hasCond(b) || conditionMet(b.showIf)) return;
      ids.add(b.id);
      (b.questions || []).forEach(q => ids.add(q.id));
      // Wiederholungen ziehen ihre Fragen erst zur Laufzeit – auch diese Kopien zählen nicht
      if (b.type === 'review') reviewQuestions(b).forEach(q => ids.add(q.id));
      if (b.decision) ids.add(b.decision.id);
    });
    return ids;
  }
  // Ein Abschnitt, der gerade freigeschaltet wurde, fährt herein und holt den Blick sanft nach
  function revealSection(sec) {
    if (reducedMotion()) return;
    sec.classList.remove('kp-reveal-in');
    void sec.offsetWidth; // Reflow, damit die Animation auch beim zweiten Mal startet
    sec.classList.add('kp-reveal-in');
    sec.addEventListener('animationend', () => sec.classList.remove('kp-reveal-in'), { once: true });
    const r = sec.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.92) sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  // Nach einer Entscheidung oder einem Selbstcheck: bedingte Blöcke und Anzeigen der Szenario-Werte nachziehen
  function updateConditions() {
    const p = pages[state.current];
    let neu = false;
    (p.blocks || []).forEach(b => {
      if (!hasCond(b)) return;
      const sec = root.querySelector(`section[data-block="${b.id}"][data-cond]`);
      if (!sec) return;
      const show = conditionMet(b.showIf);
      if (sec.hidden === !show) return;
      sec.hidden = !show;
      neu = true;
      if (show) {
        sec.classList.add('fx-in');
        activateComponents(sec);
        revealSection(sec);
      }
    });
    // Taucht ein Abschnitt auf oder ab, stimmt auch der Grund in der Fußzeile nicht mehr
    if (neu) renderFooter();
    root.querySelectorAll('[data-meters-live]').forEach(el => { el.outerHTML = meterPanel(null, true); });
  }
  // Anzeige der Szenario-Werte; mit Wirkung einer Entscheidung (eff) zeigt sie die Veränderung
  function meterPanel(eff, live) {
    const meters = course.meters || [];
    if (!meters.length) return '';
    const vals = meterValues();
    const list = eff ? meters.filter(m => Number(eff[m.id])) : meters;
    if (!list.length) return '';
    return `<div class="kp-meters"${live ? ' data-meters-live' : ''} role="status">${list.map(m => {
      const d = eff ? Number(eff[m.id]) || 0 : 0;
      // Bildstufen: die höchste Stufe, deren min der Wert erreicht
      const stage = (m.stages || []).filter(s => s && s.image && s.image.src && (Number(s.min) || 0) <= vals[m.id]).sort((a, z) => (Number(a.min) || 0) - (Number(z.min) || 0)).pop();
      return `<div class="kp-meter${stage ? ' kp-meter-staged' : ''}" style="--c:${esc(m.color || 'var(--kp-primary)')}">${stage ? `<div class="kp-meter-pic"><img src="${esc(res(stage.image.src))}" alt="${esc(stage.image.alt || '')}"></div>` : ''}<span class="kp-meter-label">${esc(m.label || m.id)}${d ? ` <b class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</b>` : ''}</span>
        <span class="kp-meter-bar" role="img" aria-label="${esc(m.label || m.id)}: ${vals[m.id]} von 100"><i style="width:${vals[m.id]}%"></i></span></div>`;
    }).join('')}</div>`;
  }

  function findBlock(id) {
    for (const p of pages) for (const b of p.blocks || []) {
      if (b.id === id) return b;
      if (b.decision && b.decision.id === id) return b.decision;
    }
    return null;
  }
  function findQuestion(id) {
    const it = items.find(x => x.id === id && x.q);
    return it ? { q: it.q, graded: it.graded } : null;
  }

  // ---------- Animationen ----------
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fxShown = new Set(); // Blöcke, deren Listen schon einmal hereingefahren sind
  function stopMotion(box) {
    clearInterval(box.__timer);
    box.dataset.playing = '';
    const btn = box.querySelector('[data-motion-play]');
    if (btn) btn.textContent = '▶ ' + T('abspielen');
  }
  // Zahlen zählen hoch und Balken wachsen, sobald sie sichtbar werden
  function setupCounters(scope) {
    const targets = [...scope.querySelectorAll('[data-count], .kp-bignum-value span, .kp-anim-count')].filter(el => !el.dataset.counted);
    if (!targets.length) return;
    const run = el => {
      el.dataset.counted = '1';
      const box = el.classList.contains('kp-anim-count') ? el.querySelector('b') : el;
      const raw = el.dataset.countTo || box.textContent;
      const num = parseFloat(String(raw).replace(/[^\d.,-]/g, '').replace(',', '.'));
      if (!isFinite(num) || Math.abs(num) > 1e9) return;
      const dec = (String(raw).split(/[.,]/)[1] || '').length;
      const rest = String(raw).replace(/[\d.,\s-]/g, '');
      if (reducedMotion()) return;
      const final = String(raw);
      if (num === 0) return;
      const t0 = Date.now(), dur = 900;
      const timer = setInterval(() => {
        const p = Math.min(1, (Date.now() - t0) / dur);
        box.textContent = (num * (1 - Math.pow(1 - p, 3))).toFixed(dec).replace('.', ',') + rest;
        if (p >= 1) { clearInterval(timer); box.textContent = final; }
      }, 40);
      // Sicherheitsnetz: Wenn der Zeitgeber gebremst wird (Fenster im Hintergrund), steht am Ende trotzdem die Zahl
      setTimeout(() => { clearInterval(timer); box.textContent = final; }, dur + 400);
      mediaTimers.push(timer);
    };
    if (!window.IntersectionObserver) return targets.forEach(run);
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { run(e.target); io.unobserve(e.target); } }), { threshold: .4 });
    targets.forEach(el => io.observe(el));
  }
  // Gestaffeltes Erscheinen und Zeichnen von Linien
  function setupAnimations(scope) {
    const items = [...scope.querySelectorAll('.kp-anim, .kp-stagger')].filter(el => !el.dataset.animOn);
    if (!items.length) return;
    const on = el => { el.dataset.animOn = '1'; el.classList.add('run'); };
    if (!window.IntersectionObserver || reducedMotion()) return items.forEach(on);
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { on(e.target); io.unobserve(e.target); } }), { threshold: .25 });
    items.forEach(el => io.observe(el));
  }

  // ---------- Bausteine und Effekte aktivieren ----------
  function activateComponents(scope) {
    scope.querySelectorAll('.kp-chat-log').forEach(l => { l.scrollTop = l.scrollHeight; });
    setupCounters(scope);
    setupAnimations(scope);
    scope.querySelectorAll('[data-ivideo]').forEach(setupVideo);
    scope.querySelectorAll('[data-lottie]').forEach(setupLottie);
    scope.querySelectorAll('[data-mission]').forEach(setupMission);
    scope.querySelectorAll('[data-seq]').forEach(setupSequence);
    scope.querySelectorAll('[data-kurs-tabs]:not([data-ready])').forEach(box => {
      box.dataset.ready = '1';
      box.classList.add('kp-tabs');
      const secs = Array.from(box.querySelectorAll(':scope > section'));
      if (!secs.length) return;
      const bar = document.createElement('div');
      bar.className = 'kp-tabbar';
      bar.setAttribute('role', 'tablist');
      secs.forEach((s, i) => {
        const btn = document.createElement('button');
        btn.textContent = s.getAttribute('data-titel') || 'Reiter ' + (i + 1);
        btn.setAttribute('role', 'tab');
        btn.onclick = () => {
          secs.forEach((x, j) => { x.hidden = j !== i; });
          Array.from(bar.children).forEach((x, j) => { x.classList.toggle('active', j === i); x.setAttribute('aria-selected', j === i); });
        };
        bar.appendChild(btn);
        s.hidden = i > 0;
      });
      bar.firstChild.classList.add('active');
      bar.firstChild.setAttribute('aria-selected', 'true');
      box.insertBefore(bar, box.firstChild);
    });
    scope.querySelectorAll('.kp-flip').forEach(f => {
      const turn = () => { f.classList.toggle('flipped'); f.classList.add('kp-seen'); updateConditions(); };
      f.onclick = turn;
      f.onmouseenter = () => { f.classList.add('kp-seen'); updateConditions(); };
      f.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); turn(); } };
    });
    scope.querySelectorAll('[data-lightbox]').forEach(img => {
      const open = () => {
        const lb = document.createElement('div');
        lb.className = 'kp-lightbox';
        lb.innerHTML = `<img src="${img.src}" alt="${esc(img.alt)}">`;
        lb.onclick = () => lb.remove();
        document.body.appendChild(lb);
      };
      img.onclick = open;
      img.onkeydown = e => { if (e.key === 'Enter') open(); };
    });
    scope.querySelectorAll('[data-compare]').forEach(box => {
      const slider = box.querySelector('input');
      const after = box.querySelector('.kp-after');
      const img = after.querySelector('img');
      const apply = () => { after.style.width = slider.value + '%'; img.style.width = box.clientWidth + 'px'; };
      slider.oninput = apply;
      const base = box.querySelector(':scope > img');
      if (base.complete) apply(); else base.onload = apply;
      window.addEventListener('resize', apply);
    });
    (course.glossary || []).forEach(g => {
      scope.querySelectorAll('[data-kurs-glossar]').forEach(el => {
        if (el.getAttribute('data-kurs-glossar').toLowerCase() !== String(g.term).toLowerCase()) return;
        el.classList.add('kp-gloss');
        el.title = g.definition;
        el.tabIndex = 0;
      });
    });
    // Effekte „hochwertig“: Listenelemente fahren gestaffelt herein, beim Neuzeichnen eines Blocks (Antwort geprüft) nicht noch einmal
    if (document.documentElement.classList.contains('kp-fx-premium')) {
      scope.querySelectorAll('.kp-cards, .kp-agenda, .kp-ch-grid, .kp-tk-list, .kp-timeline, .kp-steps, .kp-flipgrid, .kp-cl-list, .kp-team, .kp-branch-options, .kp-answers').forEach(list => {
        const sec = list.closest('[data-block]'), id = sec && sec.dataset.block;
        const again = !!id && fxShown.has(id);
        Array.from(list.children).forEach((el, i) => {
          el.style.setProperty('--kp-i', Math.min(i, 8));
          el.classList.add('fx-reveal');
          if (again) el.classList.add('fx-in', 'fx-now');
        });
        if (id) fxShown.add(id);
      });
    }
    const reveal = scope.querySelectorAll('.fx-reveal:not(.fx-in)');
    if (reveal.length && window.IntersectionObserver) {
      const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('fx-in'); io.unobserve(e.target); } }), { threshold: .12 });
      reveal.forEach(el => io.observe(el));
    } else {
      reveal.forEach(el => el.classList.add('fx-in'));
    }
    // Fragen, die direkt im HTML gebaut wurden
    scope.querySelectorAll('.kp-b-custom').forEach(sec => {
      const blockId = sec.dataset.block;
      sec.querySelectorAll('[data-kurs-quiz]').forEach((box, qi) => {
        const id = blockId + ':' + qi;
        const it = items.find(x => x.id === id);
        if (!it || box.dataset.ready) return;
        box.dataset.ready = '1';
        box.classList.add('kp-hquiz');
        const btns = Array.from(box.querySelectorAll('[data-kurs-antwort]'));
        const show = () => {
          const a = state.answers[id] || [];
          const right = it.html.right;
          btns.forEach((btn, i) => {
            btn.classList.toggle('kp-right', right.indexOf(i) >= 0);
            btn.classList.toggle('kp-wrong', a.indexOf(i) >= 0 && right.indexOf(i) < 0);
            btn.disabled = true;
          });
          const ok = right.length === a.length && right.every(i => a.indexOf(i) >= 0);
          let fb = box.querySelector('.kp-feedback');
          if (!fb) { fb = document.createElement('div'); fb.setAttribute('role', 'status'); box.appendChild(fb); }
          fb.className = 'kp-feedback ' + (ok ? 'ok' : 'no');
          fb.textContent = ok ? (box.getAttribute('data-kurs-feedback-richtig') || 'Richtig!') : (box.getAttribute('data-kurs-feedback-falsch') || 'Leider nicht richtig.');
          // Rückmeldung je Antwort und Erklärung, falls im HTML hinterlegt
          btns.forEach((btn, i) => {
            const msg = btn.getAttribute('data-kurs-rueckmeldung');
            const visible = msg && (a.indexOf(i) >= 0 || (it.html.kind === 'multiple' && right.indexOf(i) >= 0));
            if (visible && !btn.querySelector('.kp-answer-fb')) btn.insertAdjacentHTML('beforeend', `<span class="kp-answer-fb" style="display:block">${esc(msg)}</span>`);
          });
          box.querySelectorAll('[data-kurs-erklaerung]').forEach(x => { x.hidden = false; box.appendChild(x); });
          const check = box.querySelector('[data-kurs-pruefen]');
          if (check) check.remove();
        };
        if (state.answers[id]) return show();
        const chosen = [];
        const submit = a => { state.answers[id] = a; show(); renderFooter(); report(); };
        btns.forEach((btn, i) => {
          if (it.html.kind === 'multiple') btn.setAttribute('aria-pressed', 'false');
          btn.onclick = () => {
            if (it.html.kind !== 'multiple') return submit([i]);
            const at = chosen.indexOf(i);
            if (at >= 0) chosen.splice(at, 1); else chosen.push(i);
            btn.classList.toggle('kp-chosen', at < 0);
            btn.setAttribute('aria-pressed', String(at < 0));
          };
        });
        if (it.html.kind === 'multiple') {
          let check = box.querySelector('[data-kurs-pruefen]');
          if (!check) { check = document.createElement('button'); check.className = 'kp-btn'; check.textContent = 'Antwort prüfen'; box.appendChild(check); }
          check.onclick = () => { if (chosen.length) submit(chosen.slice().sort((x, y) => x - y)); };
        }
      });
    });
  }

  // ---------- Schubladen ----------
  const notesKey = 'kurs-notizen-' + (course.id || 'kurs');
  function openDrawer(which) {
    const d = root.querySelector('#kp-drawer');
    const titles = { toc: 'Kursinhalt', notes: 'Meine Notizen', glossary: 'Glossar', search: T('suchen'), trainer: T('trTitel') };
    let body = '';
    if (which === 'trainer') {
      body = trainerDrawerBody();
    } else if (which === 'search') {
      body = `<label class="kp-search-box"><span class="kp-sr">${T('suchen')}</span>
        <input type="search" data-search-input placeholder="${T('suchen')} …" aria-label="${T('suchen')}"></label>
        <div class="kp-search-res" data-search-res><p class="kp-lock">${esc(T('suchHinweis'))}</p></div>`;
    } else if (which === 'toc') {
      const maxOk = unlockedUpTo();
      let lastChapter = null;
      body = pages.map((p, i) => {
        let out = '';
        const ch = p.chapter || '';
        if (ch !== lastChapter) { lastChapter = ch; if (ch) out += `<div class="kp-toc-chapter">${esc(ch)}</div>`; }
        const locked = set.gating && i > maxOk;
        const mark = state.visited.has(i) ? '✓' : '·';
        return out + `<button class="kp-toc-item ${i === state.current ? 'current' : ''}" data-goto="${i}" ${locked ? 'disabled' : ''} ${i === state.current ? 'aria-current="page"' : ''}><span class="kp-toc-state" aria-hidden="true">${mark}</span><span>${plainTitle(p.title)}</span></button>`;
      }).join('');
      body += '<p style="margin-top:18px"><button class="kp-btn kp-sec" data-print>Zusammenfassung drucken</button></p>';
      // Am Handy sind die weiteren Knöpfe der Kopfzeile hier erreichbar (die Kopfzeile bleibt einzeilig)
      const extra = [];
      const hub = pages.findIndex(x => (x.blocks || []).some(b => b.type === 'chapters'));
      if (hub >= 0 && hub !== state.current) extra.push(`<button class="kp-iconbtn" data-goto="${hub}">${T('uebersicht')}</button>`);
      if (set.search !== false && pages.length > 3) extra.push(`<button class="kp-iconbtn" data-drawer="search">${T('suchen')}</button>`);
      if (set.notes) extra.push(`<button class="kp-iconbtn" data-drawer="notes">${T('notizen')}</button>`);
      if (set.trainerMode) extra.push(`<button class="kp-iconbtn" data-drawer="trainer">${T('trainer')}</button>`);
      if ((course.glossary || []).length) extra.push(`<button class="kp-iconbtn" data-drawer="glossary">${T('glossar')}</button>`);
      if (extra.length) body = `<div class="kp-drawer-tools">${extra.join('')}</div>` + body;
      if (fsEnabled()) body = `<div class="kp-toc-fs">${fsButton()}</div>` + body;
    } else if (which === 'notes') {
      let saved = '';
      try { saved = localStorage.getItem(notesKey) || ''; } catch (e) { /* kein Speicher */ }
      body = `<textarea class="kp-notes" data-notes aria-label="Notizen" placeholder="Notizen zu diesem Kurs …">${esc(saved)}</textarea><p class="kp-label">Die Notizen bleiben in diesem Browser gespeichert.</p>`;
    } else {
      body = (course.glossary || []).map(g => `<div class="kp-glossar-term">${esc(g.term)}</div><div class="kp-glossar-def">${esc(g.definition)}</div>`).join('');
    }
    d.innerHTML = `<div class="kp-drawer-head"><span>${titles[which]}</span><button data-close-drawer aria-label="Schließen">×</button></div><div class="kp-drawer-body">${body}</div>`;
    d.classList.add('open');
    root.querySelector('.kp-backdrop').classList.add('open');
    const ta = d.querySelector('[data-notes]');
    if (ta) ta.oninput = () => { try { localStorage.setItem(notesKey, ta.value); } catch (e) { /* kein Speicher */ } };
    const tn = d.querySelector('[data-tr-notes]');
    if (tn) tn.oninput = () => { try { localStorage.setItem(trainerKey, tn.value); } catch (e) { /* kein Speicher */ } };
    const si = d.querySelector('[data-search-input]');
    if (si) si.oninput = () => showSearch(si.value, d.querySelector('[data-search-res]'));
    (d.querySelector('[data-search-input]') || d.querySelector('.kp-toc-item.current') || d.querySelector('button, textarea')).focus();
  }
  // Volltextsuche im Kurs: Seiten und Blöcke mit Fundstelle
  function searchIndex() {
    const out = [];
    pages.forEach((p, i) => {
      if (p.result) return;
      (p.blocks || []).forEach(b => {
        const walk = o => {
          let s = '';
          if (Array.isArray(o)) return o.map(walk).join(' ');
          if (!o || typeof o !== 'object') return '';
          ['html', 'text', 'title', 'question', 'prompt', 'intro', 'caption', 'name', 'role', 'transcript', 'reveal', 'sub'].forEach(k => { if (typeof o[k] === 'string') s += ' ' + plainText(o[k]); });
          Object.keys(o).forEach(k => { if (o[k] && typeof o[k] === 'object') s += ' ' + walk(o[k]); });
          return s;
        };
        const text = walk(b).replace(/\s+/g, ' ').trim();
        if (text) out.push({ page: i, block: b.id, title: String(p.title || '').replace(/\*/g, ''), chapter: p.chapter || '', text });
      });
    });
    return out;
  }
  let searchData = null;
  function showSearch(q, box) {
    q = String(q || '').trim();
    if (!box) return;
    if (q.length < 2) { box.innerHTML = `<p class="kp-lock">${esc(T('suchHinweis'))}</p>`; return; }
    searchData = searchData || searchIndex();
    const needle = q.toLowerCase();
    const hits = searchData.filter(x => x.text.toLowerCase().includes(needle)).slice(0, 30);
    if (!hits.length) { box.innerHTML = `<p class="kp-lock">${esc(T('keineTreffer'))}</p>`; return; }
    box.innerHTML = hits.map(h => {
      const at = h.text.toLowerCase().indexOf(needle);
      const from = Math.max(0, at - 40);
      const snip = `${from > 0 ? '… ' : ''}${esc(h.text.slice(from, at))}<mark>${esc(h.text.substr(at, q.length))}</mark>${esc(h.text.slice(at + q.length, at + q.length + 60))} …`;
      return `<button class="kp-search-hit" data-goto="${h.page}" data-focus-block="${h.block}">
        <b>${esc(h.title)}</b>${h.chapter ? `<em>${esc(h.chapter)}</em>` : ''}<span>${snip}</span></button>`;
    }).join('');
  }

  // Vollbild für Lernende: nur, wo der Browser es erlaubt (im LMS-Rahmen hängt es an allowfullscreen, das iPhone kann kein Seiten-Vollbild)
  function fsEnabled() { return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled); }
  function fsActive() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  const fsLabel = () => `${fsActive() ? T('vollbildAus') : T('vollbild')}<kbd aria-hidden="true">F</kbd>`;
  const fsButton = () => `<button class="kp-btn kp-sec kp-fs-btn" data-fullscreen aria-pressed="${fsActive()}" aria-keyshortcuts="F">${fsLabel()}</button>`;
  function toggleFullscreen() {
    if (!fsEnabled()) return;
    const el = document.documentElement;
    try {
      const p = fsActive() ? (document.exitFullscreen || document.webkitExitFullscreen).call(document) : (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      if (p && p.catch) p.catch(() => { /* abgelehnt, z. B. ohne Klick */ });
    } catch (e) { /* Browser ohne Vollbild */ }
  }
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => document.addEventListener(ev, () => {
    root.querySelectorAll('[data-fullscreen]').forEach(b => { b.innerHTML = fsLabel(); b.setAttribute('aria-pressed', String(fsActive())); });
  }));

  function closeDrawer() {
    const d = root.querySelector('#kp-drawer');
    if (!d || !d.classList.contains('open')) return;
    d.classList.remove('open');
    root.querySelector('.kp-backdrop').classList.remove('open');
  }

  function printSummary() {
    const css = Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\n');
    const parts = course.pages.map(p => `<div class="kp-print-page">${p.hideTitle ? `<h1>${plainTitle(p.title)}</h1>` : ''}${renderPage(p)}</div>`).join('');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>${esc(course.title)}</title><style>${css}</style></head><body><main class="kp-main"><p class="kp-label">${esc(course.title)}</p>${parts}</main></body></html>`);
    w.document.close();
    w.document.querySelectorAll('.fx-reveal').forEach(el => el.classList.add('fx-in'));
    w.document.querySelectorAll('details').forEach(el => { el.open = true; });
    setTimeout(() => w.print(), 400);
  }

  // ---------- Kommentarmodus für Fachexperten (Review-Version) ----------
  const reviewKey = 'kurs-review-' + (course.id || 'kurs');
  function reviewList() { try { return JSON.parse(localStorage.getItem(reviewKey) || '[]'); } catch (e) { return []; } }
  function reviewPanelHtml() {
    const p = pages[state.current];
    const mine = reviewList().filter(c => c.pageId === p.id);
    let name = '';
    try { name = localStorage.getItem('kurs-review-name') || ''; } catch (e) { /* kein Speicher */ }
    return `<div class="kp-review-mode">
      <div class="kp-review-panel" data-review-panel hidden>
        <strong>Kommentar zu „${plainTitle(p.title)}“</strong>
        ${mine.map(c => `<div class="kp-rc"><b>${esc(c.name)}:</b> ${esc(c.text)}</div>`).join('')}
        <input type="text" data-review-name placeholder="Dein Name" value="${esc(name)}">
        <textarea data-review-text rows="3" placeholder="Was soll geändert werden?"></textarea>
        <button class="kp-btn" data-review-save>Kommentar speichern</button>
        <button class="kp-btn kp-sec" data-review-export>Alle Kommentare als Datei speichern (${reviewList().length})</button>
      </div>
      <button class="kp-btn" data-review-toggle>Kommentar${mine.length ? ` (${mine.length})` : ''}</button>
    </div>`;
  }

  // Für die Code-Ansicht im Editor: nur den Baukasten zurückgeben
  if (opts.renderer) {
    drawPools(false);
    buildItems();
    return { renderBlock, avatarSvg, icon, ICONS, UI_DE };
  }

  // ---------- Bedienung ----------
  function collectAnswer(q, box) {
    if (q.kind === 'fill') {
      const vals = Array.from(box.querySelectorAll('[data-blank]')).map(i => i.value);
      return vals.some(v => v.trim()) ? vals : null;
    }
    if (q.kind === 'order') return Array.from(box.querySelectorAll('.kp-order-item')).map(el => Number(el.dataset.item));
    if (q.kind === 'match' && q.dragdrop) {
      const drops = Array.from(box.querySelectorAll('[data-mdd-drop]'));
      const sel = drops.map(d => {
        const c = d.querySelector('[data-mdd-card]');
        return c ? Number(c.dataset.mddCard) : -1;
      });
      return sel.some(v => v >= 0) ? sel : null;
    }
    if (q.kind === 'match') {
      const sel = Array.from(box.querySelectorAll('[data-match]')).map(s => Number(s.value));
      return sel.some(v => v >= 0) ? sel : null;
    }
    const given = Array.from(box.querySelectorAll(`input[name="q-${q.id}"]:checked`)).map(i => Number(i.value));
    return given.length ? given.sort((x, y) => x - y) : null;
  }

  function needsConf(q, box) {
    if (!(q.confidence || set.confidence)) return false;
    const c = box.querySelector(`input[name="c-${q.id}"]:checked`);
    if (c) { state.conf[q.id] = Number(c.value); return false; }
    const msg = box.querySelector('[data-conf-msg]');
    if (msg) msg.textContent = 'Bitte schätze kurz ein, wie sicher du bist.';
    return true;
  }

  function answer(q, a, box) {
    state.answers[q.id] = a;
    state.tries[q.id] = (state.tries[q.id] || 0) + 1;
    state.took[q.id] = (Date.now() - (state.seen[q.id] || Date.now())) / 1000;
    const found = findQuestion(q.id);
    refreshBlock(box, renderQuiz(q, found ? found.graded : true));
  }

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 500);
  }

  // Level-Spiele melden ihr Ergebnis per postMessage; nur Nachrichten aus den eigenen Spielrahmen zählen
  window.addEventListener('message', e => {
    const d = e.data;
    // Aufnahme im Editor: Szene von vorn wie ein Video abspielen
    if (d && d.type === 'kurs-film-start' && d.id) {
      const b = findBlock(d.id);
      if (!b || b.type !== 'dialog') return;
      state.dlg[b.id] = 0; filmAuto.add(b.id);
      const el = root.querySelector(`[data-block="${b.id}"]`);
      if (el) el.scrollIntoView({ block: 'center' });
      setTimeout(() => dialogStep(b), 400);
      return;
    }
    if (!d || d.type !== 'minimission:complete' || !d.detail) return;
    const frame = Array.from(root.querySelectorAll('iframe[data-game]')).find(f => f.contentWindow === e.source);
    if (!frame || d.detail.id !== frame.dataset.game) return;
    const r = { ok: d.detail.skipped ? 0 : 1, e: Number(d.detail.errors) || 0, r: d.detail.revealed ? 1 : 0, k: d.detail.skipped ? 1 : 0 };
    const all = state.self.mm || {};
    if (missionRank(r) >= missionRank(all[frame.dataset.game])) all[frame.dataset.game] = r;
    state.self.mm = all;
    renderFooter();
    report();
  });

  root.addEventListener('click', e => {
    const t = e.target;
    // Stellen im Text finden
    const ftSpot = t.closest('[data-ft-spot]');
    if (ftSpot) {
      const b = findBlock(ftSpot.dataset.block);
      const st = state.self[b.id] || (state.self[b.id] = { hit: [] });
      const i = Number(ftSpot.dataset.ftSpot);
      if (!st.hit.includes(i)) st.hit.push(i);
      report();
      return refreshBlock(ftSpot.closest('[data-findtext]'), renderFindText(b));
    }
    const ftReset = t.closest('[data-ft-reset]');
    if (ftReset) {
      const b = findBlock(ftReset.dataset.ftReset);
      state.self[b.id] = { hit: [] };
      report();
      return refreshBlock(ftReset.closest('[data-findtext]'), renderFindText(b));
    }
    // Anfrage aufbauen
    const pbAdd = t.closest('[data-pb-add]');
    if (pbAdd) {
      const b = findBlock(pbAdd.dataset.block);
      const st = state.self[b.id] || (state.self[b.id] = { taken: [] });
      const i = Number(pbAdd.dataset.pbAdd);
      if (!st.taken.includes(i)) st.taken.push(i);
      report();
      return refreshBlock(pbAdd.closest('[data-promptbuild]'), renderPromptBuild(b));
    }
    const pbReset = t.closest('[data-pb-reset]');
    if (pbReset) {
      const b = findBlock(pbReset.dataset.pbReset);
      state.self[b.id] = { taken: [] };
      report();
      return refreshBlock(pbReset.closest('[data-promptbuild]'), renderPromptBuild(b));
    }
    // Chat: Antwort wählen; ein Fehlversuch (retry) zeigt die Reaktion und lässt neu wählen
    const chatPick = t.closest('[data-chat-pick]');
    if (chatPick) {
      const b = findBlock(chatPick.dataset.block);
      const st = state.self[b.id] || (state.self[b.id] = { n: 0, pick: {}, tried: {} });
      st.pick = st.pick || {}; st.tried = st.tried || {};
      const n = Number(st.n) || 0, i = Number(chatPick.dataset.chatPick);
      const o = (((b.turns || [])[n] || {}).options || [])[i] || {};
      if (o.retry) (st.tried[n] = st.tried[n] || []).push(i);
      else { st.pick[n] = i; st.n = n + 1; }
      refreshBlock(chatPick.closest('[data-chat]'), renderChat(b));
      const log = root.querySelector(`[data-chat="${b.id}"] .kp-chat-log`);
      if (log) log.scrollTop = log.scrollHeight;
      return;
    }
    const chatReset = t.closest('[data-chat-reset]');
    if (chatReset) {
      const b = findBlock(chatReset.dataset.chatReset);
      state.self[b.id] = { n: 0, pick: {}, tried: {} };
      return refreshBlock(chatReset.closest('[data-chat]'), renderChat(b));
    }
    // Matrix: Begriff wählen, dann in die Fläche klicken oder ein Feld per Knopf wählen (Weg ohne Maus)
    const mxBox = t.closest('[data-matrix]');
    if (mxBox) {
      const b = findBlock(mxBox.dataset.matrix);
      const st = state.self[b.id] || (state.self[b.id] = { p: {} });
      st.p = st.p || {};
      const items = b.items || [];
      const next = () => { const k = items.findIndex((x, i) => !st.p[i]); st.sel = k >= 0 ? k : null; };
      const redraw = () => refreshBlock(mxBox, renderMatrix(b));
      const selBtn = t.closest('[data-mx-sel]');
      if (selBtn) { st.sel = Number(selBtn.dataset.mxSel); return redraw(); }
      if (t.closest('[data-mx-cmp]')) { st.cmp = true; return redraw(); }
      if (t.closest('[data-mx-reset]')) { state.self[b.id] = { p: {}, sel: 0 }; return redraw(); }
      const cur = st.sel != null && items[st.sel] ? st.sel : items.findIndex((x, i) => !st.p[i]);
      const qBtn = t.closest('[data-mx-q]');
      if (qBtn && cur >= 0 && !st.cmp) {
        const c = MX_Q[Number(qBtn.dataset.mxQ)], j = ((cur % 3) - 1) * 7;
        st.p[cur] = [c[0] + j, c[1] - j];
        next(); return redraw();
      }
      const field = t.closest('[data-mx-field]');
      if (field && cur >= 0 && !st.cmp) {
        const r = field.getBoundingClientRect();
        const x = Math.round(Math.max(2, Math.min(98, (e.clientX - r.left) / r.width * 100)));
        const y = Math.round(Math.max(2, Math.min(98, 100 - (e.clientY - r.top) / r.height * 100)));
        st.p[cur] = [x, y];
        next(); return redraw();
      }
    }
    // Stück für Stück entscheiden
    const triPick = t.closest('[data-tri-pick]');
    if (triPick) {
      const b = findBlock(triPick.dataset.block);
      const st = state.self[b.id] || (state.self[b.id] = { d: {}, cur: 0 });
      st.cur = Number(triPick.dataset.triPick);
      report();
      return refreshBlock(triPick.closest('[data-triage]'), renderTriage(b));
    }
    const triGo = t.closest('[data-tri-go]');
    if (triGo) {
      const b = findBlock(triGo.dataset.block);
      const st = state.self[b.id] || (state.self[b.id] = { d: {}, cur: 0 });
      const val = triGo.dataset.triGo;
      st.d[Number(triGo.dataset.i)] = /^\d+$/.test(val) ? Number(val) : val; // Index bei mehreren Möglichkeiten, sonst j/n
      st.cur = Number(triGo.dataset.i);
      report();
      return refreshBlock(triGo.closest('[data-triage]'), renderTriage(b));
    }
    const triNext = t.closest('[data-tri-next]');
    if (triNext) {
      const b = findBlock(triNext.dataset.triNext);
      const st = state.self[b.id] || (state.self[b.id] = { d: {}, cur: 0 });
      const offen = (b.items || []).map((x, i) => i).filter(i => st.d[i] == null);
      st.cur = offen.length ? offen[0] : null;
      report();
      return refreshBlock(triNext.closest('[data-triage]'), renderTriage(b));
    }
    const triReset = t.closest('[data-tri-reset]');
    if (triReset) {
      const b = findBlock(triReset.dataset.triReset);
      state.self[b.id] = { d: {}, cur: 0 };
      report();
      return refreshBlock(triReset.closest('[data-triage]'), renderTriage(b));
    }
    const aiBtn = t.closest('[data-ai-toggle]');
    if (aiBtn) {
      const box = root.querySelector('#kp-ai-text');
      const auf = aiBtn.getAttribute('aria-expanded') === 'true';
      aiBtn.setAttribute('aria-expanded', auf ? 'false' : 'true');
      if (box) box.hidden = auf;
      return;
    }
    const nextBtn = t.closest('[data-next]');
    if (nextBtn) return nextBtn.disabled || blockedHere() ? undefined : go(nextIndex());
    if (t.closest('[data-back]')) {
      const prev = state.history.length ? state.history.pop() : state.current - 1;
      if (prev >= 0) { state.current = prev; pageTransition(() => render(true), true); }
      return;
    }
    const goto = t.closest('[data-goto]');
    if (goto) {
      closeDrawer();
      if (goto.dataset.focusBlock) opts.focusBlock = goto.dataset.focusBlock;
      const target = Number(goto.dataset.goto);
      if (goto.dataset.focusBlock && target === state.current) {
        const el = root.querySelector(`[data-block="${goto.dataset.focusBlock}"]`);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      opts.startPage = target;
      return go(target);
    }
    // Fallsammlung und Trainer-Modus
    const cbo = t.closest('[data-cb-open]');
    if (cbo) return cbShow(findBlock(cbo.closest('[data-casebank]').dataset.casebank), cbo.dataset.cbOpen);
    const cbf = t.closest('[data-cb-filter]');
    if (cbf) {
      const box = cbf.closest('[data-casebank]'), b = findBlock(box.dataset.casebank);
      cbState(b).f = cbf.dataset.cbFilter;
      return refreshBlock(box, renderCasebank(b));
    }
    const cbm = t.closest('[data-cb-ml]');
    if (cbm) return cbShowMl(cbm.dataset.cbMl);
    const cbp = t.closest('[data-cb-print]');
    if (cbp) return cbPrint(cbp.dataset.cbPrint);
    if (t.closest('[data-cb-close]')) return cbClose();
    if (cbOpen && t.closest('.kp-cb-case')) {
      const b = findBlock(cbOpen.bid), c = (b.cases || []).find(x => x.id === cbOpen.cid);
      const pn = t.closest('[data-cb-panel]');
      if (pn) { cbOpen.panel = cbOpen.panel === pn.dataset.cbPanel ? null : pn.dataset.cbPanel; return cbShow(b, c.id); }
      const pk = t.closest('[data-cb-pick]');
      if (pk) { const x = cbCase(b, c); x.p = Number(pk.dataset.cbPick); x.r = 1; cbOpen.rev = true; report(); return cbShow(b, c.id); }
      if (t.closest('[data-cb-reset]')) { const x = cbCase(b, c); delete x.p; delete x.r; cbOpen.rev = false; cbOpen.panel = 'mc'; report(); return cbShow(b, c.id); }
      if (t.closest('[data-cb-reveal]')) { cbOpen.rev = !cbOpen.rev; if (cbOpen.rev) { cbCase(b, c).r = 1; report(); } return cbShow(b, c.id); }
      if (t.closest('[data-cb-anek]')) { cbOpen.anek = !cbOpen.anek; return cbShow(b, c.id); }
      if (t.closest('[data-cb-next]')) return cbStep(1);
      return;
    }
    if (t.closest('[data-tr-copy]')) {
      const txt = trainerExport(), st = root.querySelector('[data-tr-status]');
      const ok = () => { if (st) st.textContent = T('trKopiert'); };
      const fallback = () => { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); ok(); } catch (e) { /* ohne Zwischenablage */ } ta.remove(); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok, fallback); else fallback();
      return;
    }
    if (t.closest('[data-tr-save]')) {
      saveTextFile('Notizen-' + String(course.title || 'Kurs').replace(/[^\wäöüÄÖÜß-]+/g, '-').slice(0, 50) + '.txt', trainerExport());
      const st = root.querySelector('[data-tr-status]');
      if (st) st.textContent = T('trGespeichert');
      return;
    }
    if (t.closest('[data-tr-solve]')) { if (confirm(T('trLoesenFrage'))) solveAll(); return; }

    const drawer = t.closest('[data-drawer]');
    if (drawer) return openDrawer(drawer.dataset.drawer);
    if (t.closest('[data-fullscreen]')) return toggleFullscreen();
    if (t.closest('[data-close-drawer]')) return closeDrawer();
    if (t.closest('[data-print]')) return printSummary();

    const check = t.closest('[data-check]');
    if (check) {
      const found = findQuestion(check.dataset.check);
      const box = check.closest('[data-quiz]');
      if (!found) return;
      const a = collectAnswer(found.q, box);
      if (a == null || needsConf(found.q, box)) return;
      const whyEl = box.querySelector(`[data-why="${found.q.id}"]`);
      if (whyEl) {
        const v = whyEl.value.trim();
        if (v.split(/\s+/).filter(Boolean).length < 3) { const m = box.querySelector('.kp-why-missing'); if (m) m.hidden = false; whyEl.focus(); return; }
        saveText(found.q.id + '~why', v);
      }
      return answer(found.q, a, box);
    }
    const retry = t.closest('[data-retry-one]');
    if (retry) {
      const found = findQuestion(retry.dataset.retryOne);
      delete state.answers[found.q.id];
      delete state.conf[found.q.id];
      state.seen[found.q.id] = Date.now();
      return refreshBlock(retry.closest('[data-quiz]'), renderQuiz(found.q, found.graded));
    }
    if (t.closest('[data-retry-all]')) {
      const last = score();
      state.self.prev = { pct: last.pct, got: last.got, max: last.max, n: ((state.self.prev || {}).n || 0) + 1 };
      graded().forEach(it => {
        delete state.answers[it.id]; delete state.tries[it.id]; delete state.conf[it.id]; if (it.branch) delete state.branch[it.id];
        if (it.play && it.play.type === 'simulation') delete state.self[it.id];
        else if (it.play && state.self.mm) delete state.self.mm[it.id];
      });
      pages.forEach(p => (p.blocks || []).forEach(b => { if (b.type === 'pool' || b.type === 'review') delete state.pools[b.id]; }));
      drawPools(false);
      buildItems();
      const first = graded()[0];
      state.history = [];
      state.current = first ? first.pageIndex : 0;
      return render(true);
    }
    const skip = t.closest('[data-skip]');
    if (skip) {
      const b = findBlock(skip.dataset.skip);
      const target = pageIndexById(b.skipTo);
      for (let i = state.current + 1; i < target; i++) state.visited.add(i);
      return go(target);
    }
    // Sprechertext
    // Selbstcheck
    const se = t.closest('[data-self-eval]');
    if (se) {
      const box = se.closest('[data-self]');
      const b = findBlock(se.dataset.selfEval);
      const a = (b.statements || []).map((s, i) => { const c = box.querySelector(`input[name="sc-${b.id}-${i}"]:checked`); return c ? Number(c.value) : null; });
      if (a.some(v => v === null)) { box.querySelector('.kp-sc-rows').classList.add('kp-sc-missing'); return; }
      state.self[b.id] = { a, done: true };
      refreshBlock(box, renderSelfcheck(b));
      updateConditions();
      return;
    }
    // Denkpause: erst selbst überlegen, dann auflösen
    const pg = t.closest('[data-predict-go]');
    if (pg) {
      const box = pg.closest('[data-predict]');
      const b = findBlock(pg.dataset.predictGo);
      let v;
      if (b.mode === 'choice') { const c = box.querySelector('input:checked'); if (!c) { box.querySelector('.kp-answers').classList.add('kp-sc-missing'); return; } v = Number(c.value); }
      else if (b.mode === 'range') { const r = [...box.querySelectorAll('[data-pr-range]')].map(x => Number(x.value)); v = [Math.min(...r), Math.max(...r)]; }
      else if (b.mode === 'slider') v = Number(box.querySelector('[data-pr-range]').value);
      else v = box.querySelector('textarea').value.trim();
      state.self[b.id] = { v, done: true };
      return refreshBlock(box, renderPredict(b));
    }
    // Klickpfad: Stufe wählen, Zielstelle treffen oder daneben klicken
    const simEl = t.closest('[data-sim]');
    if (simEl) {
      const b = findBlock(simEl.dataset.sim);
      // Neu zeichnen; der Fokus springt auf die Rückmeldung oder die neue Anweisung (Screenreader lesen sie vor)
      const redraw = () => {
        refreshBlock(simEl, renderSimulation(b));
        const fresh = root.querySelector(`[data-sim="${b.id}"]`);
        const target = fresh && (fresh.querySelector('.kp-sim-msg .kp-feedback, .kp-sim > .kp-feedback') || fresh.querySelector('.kp-sim-task'));
        if (target) { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
      };
      const mode = t.closest('[data-sim-mode]');
      if (mode) { simAct(b, 'mode', mode.dataset.simMode); return redraw(); }
      if (t.closest('[data-sim-reset]')) { simAct(b, 'reset'); return redraw(); }
      const goBtn = t.closest('[data-sim-go]');
      if (goBtn) { simAct(b, 'go', Number(goBtn.dataset.i)); return redraw(); }
      if (t.closest('[data-sim-show]')) { simAct(b, 'show'); return redraw(); }
      if (t.closest('[data-sim-hit]')) { simAct(b, 'hit'); return redraw(); }
      if (t.closest('[data-sim-stage]')) { if (simAct(b, 'miss')) redraw(); return; }
    }
    // Sortieren: Karte einer Spalte zuordnen
    // Memory: zwei Karten aufdecken, Paar bleibt offen, sonst nach kurzer Zeit wieder zu
    const mem = t.closest('[data-mem]');
    if (mem) {
      const b = findBlock(mem.dataset.gqOf);
      const st = state.self[b.id];
      const pairs = drawnPairs(b);
      const k = Number(mem.dataset.mem);
      if (!st || st.open.length >= 2 || st.open.includes(k)) return;
      st.open.push(k);
      if (st.open.length === 2) {
        st.moves++;
        const [a, c] = st.open;
        const pairOf = x => x % pairs.length;
        const match = pairOf(a) === pairOf(c) && (a < pairs.length) !== (c < pairs.length);
        if (match) { st.found.push(pairOf(a)); st.open = []; }
        else {
          refreshBlock(mem.closest('.kp-gq'), renderMemory(b, pairs));
          setTimeout(() => {
            st.open = [];
            const now = root.querySelector(`[data-gq="${b.id}"]`);
            if (now) refreshBlock(now, renderMemory(b, pairs));
          }, 900);
          return;
        }
      }
      return refreshBlock(mem.closest('.kp-gq'), renderMemory(b, pairs));
    }
    const memReset = t.closest('[data-mem-reset]');
    if (memReset) {
      const b = findBlock(memReset.dataset.memReset);
      delete state.self[b.id];
      return refreshBlock(memReset.closest('.kp-gq'), renderMemory(b, drawnPairs(b)));
    }
    // Zuordnen per Ziehen: Kärtchen über die Nummerntasten setzen
    const mddTo = t.closest('[data-mdd-to]');
    if (mddTo) {
      mddPlace(mddTo.dataset.quiz, mddTo.dataset.card, mddTo.dataset.mddTo);
      return;
    }
    const sortTo = t.closest('[data-sort-to]');
    if (sortTo) {
      const b = findBlock(sortTo.dataset.block);
      const st = state.self[b.id] || { place: {}, done: false };
      st.place[Number(sortTo.dataset.item)] = Number(sortTo.dataset.sortTo);
      state.self[b.id] = st;
      return refreshBlock(sortTo.closest('[data-sortcats]'), renderSort(b));
    }
    const sortCheck = t.closest('[data-sort-check]');
    if (sortCheck) {
      const b = findBlock(sortCheck.dataset.sortCheck);
      state.self[b.id] = Object.assign({ place: {} }, state.self[b.id], { done: true });
      return refreshBlock(sortCheck.closest('[data-sortcats]'), renderSort(b));
    }
    const sortReset = t.closest('[data-sort-reset]');
    if (sortReset) {
      const b = findBlock(sortReset.dataset.sortReset);
      state.self[b.id] = { place: {}, done: false };
      state.pools['sort-' + b.id] = shuffleIds((b.items || []).map((x, i) => i));
      return refreshBlock(sortReset.closest('[data-sortcats]'), renderSort(b));
    }
    // Auswahlrad drehen
    const dial = t.closest('[data-dial]');
    if (dial) {
      const b = findBlock(dial.dataset.dial);
      state.self[b.id] = { v: Number(dial.dataset.i) };
      return refreshBlock(dial.closest('[data-dialblock]'), renderDial(b));
    }
    // Motion-Zeitleiste abspielen oder alles zeigen
    const mp = t.closest('[data-motion-play]') || t.closest('[data-motion-all]');
    if (mp) {
      const box = mp.closest('[data-motion]');
      const all = !!mp.dataset.motionAll;
      const steps = [...box.querySelectorAll('.kp-motion-step')];
      const bar = box.querySelector('.kp-motion-bar i');
      if (box.dataset.playing === '1' && !all) { stopMotion(box); return; }
      steps.forEach(s => s.classList.remove('on'));
      if (all || reducedMotion()) {
        steps.forEach(s => s.classList.add('on'));
        if (bar) bar.style.width = '100%';
        return;
      }
      box.dataset.playing = '1';
      mp.textContent = '⏸ ' + T('pause');
      const total = Number(box.dataset.total) || steps.length * 3;
      let t0 = Date.now();
      const timer = setInterval(() => {
        const sec = (Date.now() - t0) / 1000;
        steps.forEach(s => { if (sec >= Number(s.dataset.at)) s.classList.add('on'); });
        if (bar) bar.style.width = Math.min(100, sec / total * 100) + '%';
        if (sec >= total) { stopMotion(box); }
      }, 100);
      mediaTimers.push(timer);
      box.__timer = timer;
      return;
    }
    // Prozess: Schritt wählen
    const proc = t.closest('[data-proc-go]');
    if (proc) {
      const b = findBlock(proc.dataset.procGo);
      state.dlg[b.id] = Number(proc.dataset.i);
      return refreshBlock(proc.closest('[data-process]'), renderProcess(b));
    }
    // Weiter-Sperre öffnen
    const gateBtn = t.closest('[data-gate]');
    if (gateBtn) {
      const b = findBlock(gateBtn.dataset.gate);
      state.self[b.id] = { done: true };
      render();
      const el = root.querySelector(`[data-block="${b.id}"]`);
      if (el && el.nextElementSibling) el.nextElementSibling.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    // Videoszene weiterschalten
    const vn = t.closest('[data-vscene-next]') || t.closest('[data-vscene-back]');
    if (vn) {
      const id = vn.dataset.vsceneNext || vn.dataset.vsceneBack;
      const b = findBlock(id);
      const dir = vn.dataset.vsceneNext ? 1 : -1;
      state.dlg[id] = Math.max(0, Math.min((state.dlg[id] || 0) + dir, (b.steps || []).length - 1));
      return refreshBlock(vn.closest('[data-vscene]'), renderVscene(b));
    }
    // Punkt im Bild öffnen oder schließen
    const hsDot = t.closest('[data-hs]');
    if (hsDot) {
      const b = findBlock(hsDot.dataset.hs);
      const i = Number(hsDot.dataset.i);
      const st0 = state.self[b.id] || {};
      const door = (hsRound(b, st0).list[i] || {}).target;
      if (door) { const d = pageIndexById(door); if (d >= 0) return go(d); }
      state.self[b.id] = hsMarkSeen(b, st0, i, st0.v === i ? undefined : i);
      updateConditions(); renderFooter(); report();
      return refreshBlock(hsDot.closest('[data-hotspots]'), renderHotspots(b));
    }
    // Suchbild-Runden: nächste Runde
    const nextRound = t.closest('[data-hs-next-round]');
    if (nextRound) {
      const b = findBlock(nextRound.dataset.hsNextRound);
      const st = state.self[b.id] || {};
      state.self[b.id] = { r: hsRound(b, st).r + 1, rs: st.rs, v: undefined };
      return refreshBlock(nextRound.closest('[data-hotspots]'), renderHotspots(b));
    }
    // Vor und zurück in der geöffneten Karte
    const step = t.closest('[data-hs-step]');
    if (step) {
      const b = findBlock(step.dataset.hsStep);
      const st = state.self[b.id] || {};
      const list = hsRound(b, st).list;
      const stops = list.map((pt, i) => i).filter(i => !list[i].target);
      const at = stops.indexOf(st.v);
      const next = stops[(at + Number(step.dataset.dir) + stops.length) % stops.length];
      state.self[b.id] = hsMarkSeen(b, st, next, next);
      return refreshBlock(step.closest('[data-hotspots]'), renderHotspots(b));
    }
    // Führung: der Reihe nach durch alle Punkte
    const tour = t.closest('[data-hs-tour]');
    if (tour) {
      const b = findBlock(tour.dataset.hsTour);
      const st = state.self[b.id] || {};
      const list = hsRound(b, st).list;
      // Türen (Punkte mit Zielseite) lässt die Führung aus, sonst verlässt sie mitten in der Tour die Seite
      let next = st.v == null ? 0 : (st.v + 1) % list.length;
      for (let n = 0; n < list.length && list[next] && list[next].target; n++) next = (next + 1) % list.length;
      state.self[b.id] = hsMarkSeen(b, st, next, next);
      return refreshBlock(tour.closest('[data-hotspots]'), renderHotspots(b));
    }
    // Schichten ein- und ausblenden
    const layer = t.closest('[data-layer]');
    if (layer) {
      const b = findBlock(layer.dataset.layer);
      const i = Number(layer.dataset.i);
      const st = state.self[b.id] || { on: {} };
      const on = Object.assign({}, st.on);
      if (on[i]) delete on[i]; else on[i] = true;
      state.self[b.id] = { on };
      return refreshBlock(layer.closest('[data-layers]'), renderLayers(b));
    }
    // Personenkarte umdrehen
    const person = t.closest('.kp-person-flip');
    if (person) { person.classList.toggle('flipped'); return; }
    const tk = t.closest('[data-tk-print]');
    if (tk) return printTakeaways(findBlock(tk.dataset.tkPrint));
    const fn = t.closest('[data-fn]');
    if (fn) {
      const src = root.querySelector('#kp-src-' + fn.dataset.fn);
      if (src) { const det = src.closest('details'); if (det) det.open = true; src.scrollIntoView({ behavior: 'smooth', block: 'center' }); src.classList.add('kp-flash'); setTimeout(() => src.classList.remove('kp-flash'), 1600); src.focus({ preventScroll: true }); }
      return;
    }
    const zoom = t.closest('[data-zoom]') || (t.matches('.kp-fig-frame img') ? t : null);
    if (zoom) {
      const fig = zoom.closest('figure');
      const img = fig.querySelector('img');
      const cap = fig.querySelector('figcaption');
      return openLightbox(img.src, img.alt, cap ? cap.textContent : '');
    }
    const sr = t.closest('[data-self-reset]');
    if (sr) {
      const b = findBlock(sr.dataset.selfReset);
      state.self[b.id] = { a: (state.self[b.id] || {}).a || [], done: false };
      refreshBlock(sr.closest('[data-self]'), renderSelfcheck(b));
      updateConditions();
      return;
    }
    // Untertitel zum Sprechertext ein- und ausschalten
    const ccBtn = t.closest('[data-narr-cc]');
    if (ccBtn) {
      const on = ccBtn.getAttribute('aria-pressed') !== 'true';
      ccBtn.setAttribute('aria-pressed', String(on));
      ccBtn.classList.toggle('on', on);
      const out = root.querySelector(`[data-narr-cc-text="${ccBtn.dataset.narrCc}"]`);
      if (out) { out.hidden = !on; if (!on) out.textContent = ''; }
      return;
    }
    // Regler für Lautstärke und Tempo
    const setBtn = t.closest('[data-narr-set]');
    if (setBtn) {
      const panel = setBtn.parentElement.querySelector('.kp-narr-panel');
      const open = panel.hidden;
      panel.hidden = !open;
      setBtn.setAttribute('aria-expanded', String(open));
      return;
    }
    const narr = t.closest('[data-narr]');
    if (narr) {
      if (narr.classList.contains('playing')) { stopSound(); narr.classList.remove('playing'); narr.textContent = '▶ ' + T('anhoeren'); return; }
      const b = findBlock(narr.dataset.narr);
      root.querySelectorAll('[data-narr].playing').forEach(x => { x.classList.remove('playing'); x.textContent = '▶ ' + T('anhoeren'); });
      narr.classList.add('playing');
      narr.textContent = '■ ' + T('stopp');
      const out = root.querySelector(`[data-narr-cc-text="${b.id}"]`);
      const reset = () => {
        narr.classList.remove('playing');
        narr.textContent = '▶ ' + T('anhoeren');
        if (out) out.textContent = '';
      };
      const ctl = playSound(b.narration, b.tts, reset);
      if (!ctl) return reset();
      // Untertitel mitlaufen lassen: aus der VTT-Datei zeitgenau, sonst der vorgelesene Text am Stück
      if (out && !out.hidden) {
        const cues = narrationCues(b);
        if (cues.length && ctl.media) {
          const show = () => {
            const at = ctl.media.currentTime;
            const cue = cues.find(c => at >= c.from && at < c.to);
            out.textContent = cue ? cue.text : '';
          };
          ctl.media.addEventListener('timeupdate', show);
          show();
        } else {
          out.textContent = plainText(b.tts) || '';
        }
      }
      return;
    }
    // Comic-Dialog
    const dn = t.closest('[data-dlg-next]');
    if (dn) return dialogStep(findBlock(dn.dataset.dlgNext));
    const da = t.closest('[data-dlg-all]');
    if (da) return dialogStep(findBlock(da.dataset.dlgAll), true);
    const dr = t.closest('[data-dlg-restart]');
    if (dr) {
      const b = findBlock(dr.dataset.dlgRestart);
      state.dlg[b.id] = 0;
      if (b.stage && b.stage.film) filmAuto.add(b.id);
      return dialogStep(b);
    }
    const fp = t.closest('[data-film-play]');
    if (fp) {
      const b = findBlock(fp.dataset.filmPlay);
      if (filmAuto.has(b.id)) { filmAuto.delete(b.id); clearTimeout(dlgTimer); refreshBlock(root.querySelector(`[data-dialog="${b.id}"]`), renderDialog(b)); return; }
      filmAuto.add(b.id);
      if ((state.dlg[b.id] || 0) >= (b.lines || []).length) state.dlg[b.id] = 0;
      return dialogStep(b);
    }
    const fc = t.closest('[data-film-cc]');
    if (fc) {
      const b = findBlock(fc.dataset.filmCc);
      if (filmCc.has(b.id)) filmCc.delete(b.id); else filmCc.add(b.id);
      const w = root.querySelector(`[data-dialog="${b.id}"] .kp-stage-wrap`);
      if (w) w.classList.toggle('kp-cc-off', filmCc.has(b.id));
      fc.setAttribute('aria-pressed', String(!filmCc.has(b.id)));
      return;
    }
    const ff = t.closest('[data-film-full]');
    if (ff) {
      const w = root.querySelector(`[data-dialog="${ff.dataset.filmFull}"]`);
      if (!w) return;
      if (document.fullscreenElement) document.exitFullscreen(); else if (w.requestFullscreen) w.requestFullscreen();
      return;
    }
    // Klick ins Bild: nächste Zeile, wie ein Tipp aufs Video (nicht auf Knöpfen, nicht bei offener Entscheidung, nicht vor dem Start)
    const fs = t.closest('[data-film-stage]');
    if (fs && !t.closest('button, a, [data-branch]') && !fs.classList.contains('kp-choosing') && !fs.classList.contains('kp-film-idle')) {
      const b = findBlock(fs.dataset.filmStage);
      if ((state.dlg[b.id] || 0) < (b.lines || []).length) return dialogStep(b);
      return;
    }
    // Interaktives Video
    const vc = t.closest('[data-vcontinue]');
    if (vc && !vc.disabled) return videoCtl[vc.dataset.vcontinue] && videoCtl[vc.dataset.vcontinue].resume();
    const vj = t.closest('[data-vjump]');
    if (vj) return videoCtl[vj.dataset.vjump] && videoCtl[vj.dataset.vjump].jump(Number(vj.dataset.t) || 0);
    const vs = t.closest('[data-vseek]');
    if (vs) {
      const wrap = vs.closest('[data-ivideo]');
      const ctl = wrap && videoCtl[wrap.dataset.ivideo];
      if (ctl) ctl.seek(Number(vs.dataset.vseek) || 0);
      return;
    }
    const cr = t.closest('input[data-crit-item]');
    if (cr) {
      const box = cr.closest('[data-crit]');
      const b = findBlock(box.dataset.crit);
      const st = state.self[b.id] = state.self[b.id] || {};
      const i = Number(cr.dataset.critItem);
      st.crit = (st.crit || []).filter(x => x !== i);
      if (cr.checked) st.crit.push(i);
      cr.closest('label').classList.toggle('done', cr.checked);
      const s = box.querySelector('[data-crit-status]'); if (s) s.outerHTML = critStatus(b);
      report();
      return;
    }
    const ci = t.closest('input[data-check-item]');
    if (ci) {
      const box = ci.closest('[data-checklist]');
      const b = findBlock(box.dataset.checklist);
      const st = state.self[b.id] || (state.self[b.id] = { c: [] });
      const i = Number(ci.dataset.checkItem);
      st.c = (st.c || []).filter(x => x !== i).concat(ci.checked ? [i] : []).sort((a, z) => a - z);
      ci.closest('label').classList.toggle('done', ci.checked);
      const s = box.querySelector('[data-cl-status]'); if (s) s.outerHTML = clStatus(b);
      report();
      return;
    }
    const choose = t.closest('[data-choose]');
    if (choose) {
      const box = choose.closest('[data-branch]');
      const b = findBlock(box.dataset.branch);
      const pick = Number(choose.dataset.choose), o = (b.options || [])[pick] || {};
      // Nochmal versuchen: Rückmeldung zeigen, die Entscheidung bleibt offen
      if (o.retry) {
        const tries = ((state.self[b.id] || {}).tries || []).concat(pick).filter((x, k, arr) => arr.indexOf(x) === k);
        state.self[b.id] = Object.assign({}, state.self[b.id], { tried: pick, tries });
        const staged = box.closest('.kp-staged');
        if (staged) refreshBlock(staged, renderDialog(findBlock(staged.dataset.dialog)));
        else refreshBlock(box, renderBranch(b));
        const fb = root.querySelector(`[data-branch="${b.id}"] [data-retry-fb]`); if (fb) fb.focus();
        return;
      }
      state.branch[b.id] = pick;
      // Auf der Bühne wandert die Entscheidung nach der Wahl aus dem Bild unter die Szene
      const staged = box.closest('.kp-staged');
      if (staged) refreshBlock(staged, renderDialog(findBlock(staged.dataset.dialog)));
      else refreshBlock(box, renderBranch(b));
      updateConditions();
      return;
    }
    // Folgekarte schließen: zurück zur Frage
    const cb = t.closest('[data-conseq-back]');
    if (cb) {
      const box = cb.closest('[data-branch]');
      const b = findBlock(cb.dataset.conseqBack);
      const st = Object.assign({}, state.self[b.id]); delete st.tried; state.self[b.id] = st;
      const staged = box.closest('.kp-staged');
      if (staged) refreshBlock(staged, renderDialog(findBlock(staged.dataset.dialog)));
      else refreshBlock(box, renderBranch(b));
      const first = root.querySelector(`[data-branch="${b.id}"] [data-choose]`); if (first) first.focus();
      return;
    }
    // Hilfe holen: Figur oder Arbeitshilfe an der Entscheidung
    const ho = t.closest('[data-help-open]');
    if (ho) {
      const box = ho.closest('[data-branch]');
      const b = findBlock(ho.dataset.helpOpen);
      if (helpOpen.has(b.id)) helpOpen.delete(b.id); else { helpOpen.add(b.id); state.self[b.id] = Object.assign({}, state.self[b.id], { helped: true }); report(); }
      const staged = box.closest('.kp-staged');
      if (staged) refreshBlock(staged, renderDialog(findBlock(staged.dataset.dialog)));
      else refreshBlock(box, renderBranch(b));
      const panel = root.querySelector(`[data-help="${b.id}"]`); if (panel) { panel.setAttribute('tabindex', '-1'); panel.focus({ preventScroll: true }); }
      return;
    }
    // Begründung zur Entscheidung speichern, dann erst die Rückmeldung zeigen
    const ws = t.closest('[data-why-save]');
    if (ws) {
      const box = ws.closest('[data-branch]');
      const b = findBlock(box.dataset.branch);
      const ta = box.querySelector(`[data-why="${b.id}"]`);
      const v = ta ? ta.value.trim() : '';
      if (v.split(/\s+/).filter(Boolean).length < 3) { const m = box.querySelector('.kp-why-missing'); if (m) m.hidden = false; if (ta) ta.focus(); return; }
      saveText(b.id + '~why', v);
      const staged = box.closest('.kp-staged');
      if (staged) refreshBlock(staged, renderDialog(findBlock(staged.dataset.dialog)));
      else refreshBlock(box, renderBranch(b));
      const fb = root.querySelector(`[data-branch="${b.id}"] .kp-feedback`); if (fb) { fb.setAttribute('tabindex', '-1'); fb.focus({ preventScroll: true }); }
      updateConditions();
      return;
    }
    // Kernaussage aufdecken
    const tko = t.closest('[data-tk-open]');
    if (tko) {
      const box = tko.closest('[data-takeaways]');
      const b = findBlock(box.dataset.takeaways);
      const st = state.self[b.id] || { open: [] };
      const i = Number(tko.dataset.tkOpen);
      if (!(st.open || []).includes(i)) st.open = [...(st.open || []), i];
      state.self[b.id] = st;
      const li = tko.closest('li');
      li.classList.remove('kp-tk-closed');
      const it = (b.items || [])[i] || {};
      tko.outerHTML = `<div class="kp-text kp-tk-in" tabindex="-1">${res(it.html)}</div>`;
      const shown = li.querySelector('.kp-tk-in'); if (shown) shown.focus({ preventScroll: true });
      const stat = box.querySelector('[data-tk-status] b'); if (stat) stat.textContent = T('aufgedeckt').replace('{n}', st.open.length).replace('{z}', (b.items || []).length);
      updateConditions(); renderFooter(); report();
      return;
    }
    const ics = t.closest('[data-cert-ics]');
    if (ics) { saveTextFile('Wiederholung-' + String(course.title || 'Kurs').replace(/[^\wäöüÄÖÜß-]+/g, '-').slice(0, 50) + '.ics', calendarIcs(findBlock(ics.dataset.certIcs)), 'text/calendar'); return; }
    if (t.closest('[data-follow]')) return go(nextIndex());
    const rs = t.closest('[data-reflect-save]');
    if (rs) {
      const box = rs.closest('[data-reflect]');
      const b = findBlock(rs.dataset.reflectSave);
      const v = box.querySelector('[data-reflect-text]').value.trim();
      if (!v) return box.querySelector('[data-reflect-text]').focus();
      saveText(b.id, v);
      return refreshBlock(box, renderReflection(b));
    }
    const ps = t.closest('[data-plan-save]');
    if (ps) {
      const box = ps.closest('[data-plan]');
      const b = findBlock(ps.dataset.planSave);
      saveText(b.id, Array.from(box.querySelectorAll('[data-plan-field]')).map(x => x.value));
      return refreshBlock(box, renderPlan(b));
    }
    const pp = t.closest('[data-plan-print]');
    if (pp) {
      const box = pp.closest('[data-plan]');
      const b = findBlock(pp.dataset.planPrint);
      saveText(b.id, Array.from(box.querySelectorAll('[data-plan-field]')).map(x => x.value));
      refreshBlock(box, renderPlan(b));
      return printPlan(b);
    }
    const sv = t.closest('[data-survey-send]');
    if (sv) {
      const box = sv.closest('[data-survey]');
      const b = findBlock(sv.dataset.surveySend);
      const r = (b.statements || []).map((st, i) => { const c = box.querySelector(`input[name="s-${b.id}-${i}"]:checked`); return c ? Number(c.value) : 0; });
      if (!r.some(Boolean)) return;
      const cm = box.querySelector('[data-survey-comment]');
      state.survey[b.id] = { r, c: cm ? cm.value.slice(0, 500) : '' };
      return refreshBlock(box, renderSurvey(b));
    }
    const cert = t.closest('[data-cert-open]');
    if (cert) {
      const nameInput = root.querySelector('[data-cert-name]');
      if (nameInput) {
        if (!nameInput.value.trim()) { nameInput.focus(); return; }
        state.name = nameInput.value.trim();
      }
      return openCertificate(findBlock(cert.dataset.certOpen));
    }
    // Kommentarmodus
    if (t.closest('[data-review-toggle]')) { const pnl = root.querySelector('[data-review-panel]'); pnl.hidden = !pnl.hidden; return; }
    if (t.closest('[data-review-save]')) {
      const text = root.querySelector('[data-review-text]').value.trim();
      const name = root.querySelector('[data-review-name]').value.trim() || 'Ohne Namen';
      if (!text) return;
      try { localStorage.setItem('kurs-review-name', name); } catch (e) { /* kein Speicher */ }
      const list = reviewList();
      list.push({ pageId: pages[state.current].id, pageTitle: pages[state.current].title, name, text, date: new Date().toISOString() });
      try { localStorage.setItem(reviewKey, JSON.stringify(list)); } catch (e) { /* kein Speicher */ }
      render();
      root.querySelector('[data-review-panel]').hidden = false;
      return;
    }
    if (t.closest('[data-review-export]')) {
      return download('kommentare-' + String(course.title).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json', JSON.stringify({ courseId: course.id, courseTitle: course.title, comments: reviewList() }, null, 2));
    }
    // Reihenfolge per Knopf
    const up = t.closest('[data-up]'), down = t.closest('[data-down]');
    if (up || down) {
      const item = t.closest('.kp-order-item');
      const list = item.parentElement;
      if (up && item.previousElementSibling) list.insertBefore(item, item.previousElementSibling);
      if (down && item.nextElementSibling) list.insertBefore(item.nextElementSibling, item);
      (up || down).focus();
      return;
    }
    // Stelle im Bild
    const hs = t.closest('[data-hotspot]');
    if (hs) {
      const found = findQuestion(hs.dataset.hotspot);
      if (!found || state.answers[found.q.id] != null) return;
      const box = hs.closest('[data-quiz]');
      if (needsConf(found.q, box)) return;
      const r = hs.querySelector('img').getBoundingClientRect();
      return answer(found.q, [Math.round((e.clientX - r.left) / r.width * 1000) / 10, Math.round((e.clientY - r.top) / r.height * 1000) / 10], box);
    }
  });

  // Sprache umschalten
  root.addEventListener('change', e => {
    const sel = e.target.closest && e.target.closest('[data-lang]');
    if (!sel) return;
    state.lang = applyLang(sel.value);
    try { localStorage.setItem('kurs-sprache-' + (course.id || 'kurs'), state.lang); } catch (err) { /* kein Speicher */ }
    const resPage = pages.find(p => p.result);
    if (resPage) resPage.title = T('ergebnis');
    render();
    root.querySelector('[data-lang]')?.focus();
    report();
  });

  // Lautstärke und Tempo: wirken sofort und gelten für den ganzen Kurs
  root.addEventListener('input', e => {
    const vol = e.target.closest && e.target.closest('[data-narr-vol]');
    const rate = e.target.closest && e.target.closest('[data-narr-rate]');
    if (!vol && !rate) return;
    if (vol) audioPrefs.vol = Number(vol.value);
    if (rate) {
      audioPrefs.rate = Number(rate.value);
      const out = rate.parentElement.querySelector('output');
      if (out) out.textContent = audioPrefs.rate + '×';
    }
    saveAudioPrefs();
    applyAudioPrefs();
    // die übrigen Regler im Kurs nachziehen, damit überall derselbe Wert steht
    root.querySelectorAll('[data-narr-vol]').forEach(x => { x.value = audioPrefs.vol; });
    root.querySelectorAll('[data-narr-rate]').forEach(x => {
      x.value = audioPrefs.rate;
      const o = x.parentElement.querySelector('output');
      if (o) o.textContent = audioPrefs.rate + '×';
    });
  });

  // Folgen-Regler: Wert und Ergebnis live, ohne den Block neu zu zeichnen (sonst verliert der Regler den Fokus)
  root.addEventListener('input', e => {
    const r = e.target.closest && e.target.closest('[data-lev]');
    if (!r) return;
    const box = r.closest('[data-levers]');
    const b = findBlock(box.dataset.levers);
    const st = state.self[b.id] || (state.self[b.id] = { v: {}, t: [] });
    st.v = st.v || {}; st.t = st.t || [];
    const i = Number(r.dataset.lev), s = (b.sliders || [])[i] || {};
    st.v[i] = Number(r.value);
    if (!st.t.includes(i)) st.t.push(i);
    box.querySelector(`[data-lev-out="${i}"]`).textContent = r.value + (s.unit ? ' ' + s.unit : '');
    box.querySelector('[data-lev-result]').innerHTML = leversResultHtml(b, st);
    const hint = box.querySelector('[data-lev-hint]');
    if (hint && st.t.length >= (b.sliders || []).length) hint.remove();
  });
  root.addEventListener('change', e => {
    if (!(e.target.closest && e.target.closest('[data-lev]'))) return;
    updateConditions(); renderFooter(); report();
  });

  // Schätzwert der Denkpause live anzeigen
  root.addEventListener('input', e => {
    const r = e.target.closest && e.target.closest('[data-pr-range]');
    if (!r) return;
    const b = findBlock(r.closest('[data-predict]').dataset.predict);
    r.parentElement.querySelector('output').textContent = r.value + (b && b.unit ? ' ' + b.unit : '');
  });

  // Zuordnen per Ziehen: ein Kärtchen je Begriff; das bisherige wandert zurück in den Vorrat
  function mddPlace(quizId, cardIdx, rowIdx) {
    const wrap = root.querySelector(`[data-mdd="${quizId}"]`);
    if (!wrap) return;
    const card = wrap.querySelector(`[data-mdd-card="${cardIdx}"]`);
    if (!card) return;
    const pool = wrap.querySelector('[data-mdd-pool]');
    const target = rowIdx == null ? pool : wrap.querySelector(`[data-mdd-drop="${rowIdx}"]`);
    if (!target) return;
    if (rowIdx != null) {
      const old = target.querySelector('[data-mdd-card]');
      if (old && old !== card) pool.appendChild(old);
    }
    target.querySelectorAll('.kp-sort-empty').forEach(x => x.remove());
    const from = card.parentElement;
    target.appendChild(card);
    if (from !== pool && from.matches('[data-mdd-drop]') && !from.children.length) from.innerHTML = '';
    if (pool !== target && !pool.querySelector('[data-mdd-card]')) pool.innerHTML = `<li class="kp-sort-empty">${T('allesZugeordnet')}</li>`;
    card.focus({ preventScroll: true });
  }
  root.addEventListener('dragstart', e => {
    const card = e.target.closest && e.target.closest('[data-mdd-card]');
    if (!card) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'mdd:' + card.dataset.quiz + ':' + card.dataset.mddCard);
    card.classList.add('kp-dragging');
  });
  root.addEventListener('dragend', e => {
    const card = e.target.closest && e.target.closest('[data-mdd-card]');
    if (card) card.classList.remove('kp-dragging');
  });
  root.addEventListener('dragover', e => {
    const box = e.target.closest && (e.target.closest('[data-mdd-drop]') || e.target.closest('[data-mdd-pool]'));
    if (!box) return;
    e.preventDefault();
    box.classList.add('kp-over');
  });
  root.addEventListener('dragleave', e => {
    const box = e.target.closest && (e.target.closest('[data-mdd-drop]') || e.target.closest('[data-mdd-pool]'));
    if (box) box.classList.remove('kp-over');
  });
  root.addEventListener('drop', e => {
    const box = e.target.closest && (e.target.closest('[data-mdd-drop]') || e.target.closest('[data-mdd-pool]'));
    if (!box) return;
    const parts = String(e.dataTransfer.getData('text/plain')).split(':');
    if (parts[0] !== 'mdd') return;
    e.preventDefault();
    box.classList.remove('kp-over');
    mddPlace(parts[1], parts[2], box.dataset.mddDrop == null ? null : box.dataset.mddDrop);
  });
  // Ohne Maus: Nummer des Begriffs am Kärtchen drücken
  root.addEventListener('keydown', e => {
    const card = e.target.closest && e.target.closest('[data-mdd-card]');
    if (!card) return;
    const rows = root.querySelectorAll(`[data-mdd="${card.dataset.quiz}"] [data-mdd-drop]`).length;
    if (/^[1-9]$/.test(e.key) && Number(e.key) <= rows) {
      e.preventDefault();
      mddPlace(card.dataset.quiz, card.dataset.mddCard, String(Number(e.key) - 1));
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      mddPlace(card.dataset.quiz, card.dataset.mddCard, null);
    }
  });

  // Sortieren mit der Maus: ziehen und ablegen
  root.addEventListener('dragstart', e => {
    const item = e.target.closest && e.target.closest('[data-sort-item]');
    if (!item) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.dataset.block + ':' + item.dataset.sortItem);
    item.classList.add('kp-dragging');
  });
  root.addEventListener('dragend', e => {
    const item = e.target.closest && e.target.closest('[data-sort-item]');
    if (item) item.classList.remove('kp-dragging');
  });
  root.addEventListener('dragover', e => {
    const box = e.target.closest && (e.target.closest('[data-sort-cat]') || e.target.closest('.kp-sort-pool'));
    if (!box) return;
    e.preventDefault();
    box.classList.add('kp-over');
  });
  root.addEventListener('dragleave', e => {
    const box = e.target.closest && (e.target.closest('[data-sort-cat]') || e.target.closest('.kp-sort-pool'));
    if (box) box.classList.remove('kp-over');
  });
  root.addEventListener('drop', e => {
    const box = e.target.closest && (e.target.closest('[data-sort-cat]') || e.target.closest('.kp-sort-pool'));
    if (!box) return;
    e.preventDefault();
    box.classList.remove('kp-over');
    const [id, idx] = String(e.dataTransfer.getData('text/plain')).split(':');
    const b = findBlock(id);
    if (!b) return;
    const st = state.self[b.id] || { place: {}, done: false };
    if (st.done) return;
    if (box.dataset.sortCat != null) st.place[Number(idx)] = Number(box.dataset.sortCat);
    else delete st.place[Number(idx)];
    state.self[b.id] = st;
    refreshBlock(box.closest('[data-sortcats]'), renderSort(b));
  });

  // Tastatur: Sortierkarte mit Zifferntasten zuordnen (Alternative zum Ziehen, WCAG 2.5.7)
  root.addEventListener('keydown', e => {
    const item = e.target.closest && e.target.closest('[data-sort-item]');
    if (!item) return;
    const b = findBlock(item.dataset.block);
    const st = state.self[b.id] || { place: {}, done: false };
    if (!b || st.done) return;
    if (/^[1-9]$/.test(e.key) && Number(e.key) <= (b.categories || []).length) {
      e.preventDefault();
      st.place[Number(item.dataset.sortItem)] = Number(e.key) - 1;
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      delete st.place[Number(item.dataset.sortItem)];
    } else return;
    state.self[b.id] = st;
    refreshBlock(item.closest('[data-sortcats]'), renderSort(b));
  });

  // Tastatur: Stelle im Bild mit Pfeiltasten wählen
  root.addEventListener('keydown', e => {
    const hs = e.target.closest && e.target.closest('[data-hotspot]');
    if (!hs || e.target !== hs) return;
    const found = findQuestion(hs.dataset.hotspot);
    if (!found || state.answers[found.q.id] != null) return;
    const c = state.cross[found.q.id] || [50, 50];
    const step = e.shiftKey ? 1 : 4;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      c[0] = Math.max(0, Math.min(100, c[0] + moves[e.key][0]));
      c[1] = Math.max(0, Math.min(100, c[1] + moves[e.key][1]));
      state.cross[found.q.id] = c;
      const cross = hs.querySelector('.kp-cross');
      cross.style.left = c[0] + '%';
      cross.style.top = c[1] + '%';
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const box = hs.closest('[data-quiz]');
      if (needsConf(found.q, box)) return;
      answer(found.q, [c[0], c[1]], box);
    }
  });

  // Ziehen in Reihenfolge-Fragen
  root.addEventListener('dragstart', e => {
    const item = e.target.closest && e.target.closest('.kp-order-item');
    if (!item) return;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  root.addEventListener('dragend', e => { const it = e.target.closest && e.target.closest('.kp-order-item'); if (it) it.classList.remove('dragging'); });
  root.addEventListener('dragover', e => {
    const list = e.target.closest && e.target.closest('[data-order]');
    const dragging = list && list.querySelector('.dragging');
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest('.kp-order-item');
    if (!over || over === dragging) return;
    const rect = over.getBoundingClientRect();
    list.insertBefore(dragging, e.clientY < rect.top + rect.height / 2 ? over : over.nextSibling);
  });

  document.addEventListener('keydown', e => {
    if (!e.target.matches || e.target.matches('input, textarea, select, [data-hotspot]')) return;
    if (document.querySelector('.kp-lightbox')) return;
    if (e.key === 'ArrowRight') root.querySelector('[data-footer] [data-next]:not(:disabled)')?.click();
    if (e.key === 'ArrowLeft') root.querySelector('[data-footer] [data-back]:not(:disabled)')?.click();
    if (e.key === 'Escape') closeDrawer();
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.isContentEditable && fsEnabled()) { e.preventDefault(); toggleFullscreen(); }
  });

  function close() {
    if (!lms || finished) return;
    report();
    finished = true;
    try { lms.finish(); } catch (e) { /* Fenster wird geschlossen */ }
  }
  window.addEventListener('pagehide', close);
  window.addEventListener('beforeunload', close);

  // ---------- Start ----------
  // Wiederholung beim Wiedereinstieg: ein paar Fragen aus dem, was schon gelernt wurde (Abstand hilft dem Behalten).
  // Kopien mit eigener ID, damit die Antwort im Kurs selbst unberührt bleibt; sie zählen nie zur Bewertung.
  const resumeCopies = {};
  function resumeReviewQuestions(loc) {
    const n = Number(set.resumeReview) || 0;
    if (n <= 0) return [];
    const before = allQuestionsBefore(loc, '');
    // Zuerst, was zuletzt falsch war, dann das schon Beantwortete, zuletzt Unbekanntes
    const pick = wrongFirst(before, true).map(q => q.id).slice(0, n);
    const byId = {};
    before.forEach(q => { byId[q.id] = q; });
    return pick.map(id => {
      const key = id + '~resume';
      if (!resumeCopies[key]) resumeCopies[key] = Object.assign({}, byId[id], { id: key, attempts: 0, confidence: false });
      return resumeCopies[key];
    });
  }
  function showResume(loc) {
    const rq = resumeReviewQuestions(loc);
    rq.forEach(q => { if (!items.some(x => x.id === q.id)) items.push({ id: q.id, pageIndex: loc, q, graded: false, points: 0, objective: '' }); });
    const box = document.createElement('div');
    box.className = 'kp-resume' + (rq.length ? ' kp-resume-wide' : '');
    box.innerHTML = `<div class="kp-resume-box" role="dialog" aria-modal="true" aria-label="${T('willkommenZurueck')}">
      <h2 style="margin-top:0">${firstName() ? T('willkommenZurueckName').replace('{n}', esc(firstName())) : T('willkommenZurueck')}</h2>
      <p>${T('zuletztAuf')} ${loc + 1}: „${esc(pages[loc].title)}“.</p>
      ${rq.length ? `<div class="kp-resume-review"><p class="kp-label">${T('kurzWiederholen')}</p><p class="kp-resume-hint">${T('kurzWiederholenHinweis')}</p>${rq.map(q => renderQuiz(q, false)).join('')}</div>` : ''}
      <div class="kp-quiz-actions"><button class="kp-btn" data-resume="yes">${T('dortWeitermachen')}</button><button class="kp-btn kp-sec" data-resume="no">${T('vonVorn')}</button></div></div>`;
    // Im Player-Wurzelelement, damit die Fragen darin über die normalen Klick-Handler laufen
    root.appendChild(box);
    box.querySelector(rq.length ? '.kp-resume-box' : '[data-resume="yes"]').focus({ preventScroll: true });
    if (rq.length) activateComponents(box);
    box.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-resume]');
      if (!btn) return;
      box.remove();
      if (btn.dataset.resume === 'yes') { state.current = loc; render(true); }
    });
  }

  (async function start() {
    let saved = null;
    let lmsActive = lms;
    if (lms) {
      saved = await lms.start();
      if (!saved) lmsActive = null;
    }
    if (!lmsActive && lms) { /* Start im LMS fehlgeschlagen: Kurs läuft ohne Meldung weiter */ }
    const useLms = !!lmsActive;
    let resumeAt = 0;
    if (useLms && saved) {
      lmsName = saved.name || '';
      if (saved.masteryScore != null && saved.masteryScore !== '') passScore = Math.round(Number(saved.masteryScore) * 100);
      try {
        const d = JSON.parse(saved.suspend || '{}');
        (d.v || []).forEach(i => state.visited.add(i));
        Object.assign(state.answers, d.a || {});
        Object.assign(state.tries, d.t || {});
        Object.assign(state.pools, d.p || {});
        Object.assign(state.branch, d.b || {});
        Object.assign(state.conf, d.c || {});
        Object.assign(state.survey, d.s || {});
        Object.assign(state.texts, d.x || {});
        Object.assign(state.watched, d.w || {});
        Object.assign(state.self, d.k || {});
        if (d.l) state.lang = d.l;
      } catch (e) { /* kein gespeicherter Stand */ }
      resumeAt = parseInt(saved.location, 10) || 0;
    }
    // Sprache: gespeicherte Wahl, sonst Adresse (?sprache=en) oder die letzte Wahl in diesem Browser
    if (langs.length) {
      let want = state.lang || '';
      try { want = want || new URLSearchParams(location.search).get('sprache') || localStorage.getItem('kurs-sprache-' + (course.id || 'kurs')) || ''; } catch (e) { /* kein Speicher */ }
      state.lang = applyLang(want);
    }
    drawPools(false);
    buildItems();
    if (graded().length) pages.push({ id: '_result', title: T('ergebnis'), blocks: [], result: true });
    if (!useLms) { finished = true; }
    if (opts.startPage != null && opts.startPage >= 0 && opts.startPage < pages.length) state.current = opts.startPage;
    render();
    if (resumeAt > 0 && resumeAt < pages.length) {
      // Mit Wiederholungsrunde erscheint das Fenster auch bei „automatisch weitermachen“
      if (set.resume === 'auto' && !(Number(set.resumeReview) > 0)) { state.current = resumeAt; render(); }
      else showResume(resumeAt);
    }
  })();
}
