(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Frühere Sprungadressen der einen langen Seite (…/#kurse) führen auf die eigene Seite der Rubrik
  var OLD = { '#angebot': 'angebot.html', '#kurse': 'beispielkurse.html', '#unterstuetzung': 'unterstuetzung.html', '#videos': 'beispielkurse.html#videos', '#ueber-mich': 'ueber-mich.html', '#ablauf': 'unterstuetzung.html#ablauf', '#kontakt': 'ueber-mich.html#kontakt' };
  if (OLD[location.hash] && !document.getElementById(location.hash.slice(1))) { location.replace(OLD[location.hash]); return; }

  // Kopfleiste bekommt beim Scrollen einen Grund, Foto bewegt sich leicht
  var top = $('[data-top]'), pic = $('[data-parallax]');
  var mb = $('[data-menu]'), ml = $('[data-menu-label]');
  function menu(open) { top.classList.toggle('open', open); mb.setAttribute('aria-expanded', open ? 'true' : 'false'); ml.textContent = open ? 'Schließen' : 'Menü'; }
  mb.addEventListener('click', function () { menu(!top.classList.contains('open')); });
  $$('#hauptnav a').forEach(function (a) { a.addEventListener('click', function () { menu(false); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && top.classList.contains('open')) { menu(false); mb.focus(); } });
  window.matchMedia('(min-width: 901px)').addEventListener('change', function (m) { if (m.matches) menu(false); });
  function onScroll() {
    var y = window.scrollY;
    top.classList.toggle('solid', y > 40 || document.body.classList.contains('sub'));
    if (pic && !reduce && y < 1200) pic.style.setProperty('--py', (-y * 0.06) + 'px');
  }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // Einblenden und kurze Clips nur im sichtbaren Bereich
  var clips = $$('video[data-auto]');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: .12 });
    $$('.rv').forEach(function (el) { io.observe(el); });
    if (!reduce) {
      var vo = new IntersectionObserver(function (es) { es.forEach(function (e) { var v = e.target; if (e.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } else v.pause(); }); }, { threshold: .35 });
      clips.forEach(function (v) { vo.observe(v); });
    } else clips.forEach(function (v) { v.controls = true; });
  } else { $$('.rv').forEach(function (el) { el.classList.add('in'); }); }

  // Showreel
  var reel = $('[data-reel]'), rp = $('[data-reel-play]');
  if (reel && rp) rp.addEventListener('click', function () { rp.hidden = true; reel.controls = true; var p = reel.play(); if (p && p.catch) p.catch(function () {}); reel.focus(); });

  // Beispielkurse
  (function () {
  var stage = $('[data-stage]'), frame = $('[data-frame]'), poster = $('[data-poster]'), view = $('[data-view]');
  if (!stage) return;
  var cur = $('.case[aria-pressed="true"]');
  function pick(card, scroll) {
    cur = card;
    $$('.case').forEach(function (c) { c.setAttribute('aria-pressed', c === card); });
    var k = card.dataset.kurs;
    $('[data-stage-title]').textContent = card.dataset.titel;
    $('[data-stage-new]').href = 'kurse/' + k + '/index.html';
    poster.hidden = true; frame.src = 'kurse/' + k + '/index.html'; frame.title = 'Kursvorschau: ' + card.dataset.titel; frame.removeAttribute('tabindex');
    if (scroll) stage.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
  $$('.case').forEach(function (c) { c.addEventListener('click', function () { pick(c, true); }); });
  $('[data-start]').addEventListener('click', function () { pick(cur, false); });
  $$('[data-live]').forEach(function (a) { a.addEventListener('click', function (e) { var c = $('.case[data-kurs="' + a.dataset.live + '"]'); if (c) { e.preventDefault(); pick(c, true); } }); });
  $$('[data-dev]').forEach(function (b) { b.addEventListener('click', function () {
    $$('[data-dev]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
    view.classList.toggle('phone', b.dataset.dev === 'phone');
  }); });
  })();

  // Assistent: Kurz gefragt
  var kf = $('[data-kf]'), kfo = $('[data-kf-open]');
  var REPLY = [
    'Das kenne ich. Dagegen helfen Entscheidungen mit Folgen statt Folien. <a href="beispielkurse.html">Probieren Sie es in einem Beispielkurs aus</a>.',
    'Dann übernehme ich so viel, wie Sie brauchen, vom Storyboard bis zum fertigen Kurs. <a href="unterstuetzung.html">So unterstütze ich Sie</a>.',
    'Dafür gibt es mein Programm „Führen mit KI“. <a href="media/fuehren-mit-ki-programmuebersicht.pdf" target="_blank" rel="noopener">Programmübersicht als PDF</a>.',
    'Damit starte ich am liebsten. Aus Ihren Folien und Unterlagen wird ein Kurs mit Fällen und Übungen. <a href="unterstuetzung.html">So unterstütze ich Sie</a>.'
  ];
  function openKf() { kf.hidden = false; kfo.hidden = true; }
  function closeKf() { kf.hidden = true; kfo.hidden = false; kfo.focus(); }
  kfo.addEventListener('click', function () { openKf(); var b = $('[data-kf-opts] button', kf); if (b && !$('[data-kf-opts]', kf).hidden) b.focus(); });
  $('[data-kf-close]', kf).addEventListener('click', closeKf);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !kf.hidden) closeKf(); });
  $('[data-kf-opts]', kf).addEventListener('click', function (e) {
    var b = e.target.closest('[data-kf]'); if (!b) return;
    var rp = $('[data-kf-reply]', kf); rp.innerHTML = REPLY[+b.dataset.kf]; rp.hidden = false; $('[data-kf-opts]', kf).hidden = true; rp.focus();
  });
  $('[data-kf-reply]', kf).addEventListener('click', function (e) { if (e.target.closest('a')) { kf.hidden = true; kfo.hidden = false; } });
  var prog = $('[data-progress]');
  if (prog) {
    if (reduce || !('IntersectionObserver' in window)) prog.classList.add('go');
    else { var po = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { prog.classList.add('go'); po.disconnect(); } }, { threshold: .4 }); po.observe(prog); }
  }
  if ('IntersectionObserver' in window && $('#kontakt')) new IntersectionObserver(function (es) { document.body.classList.toggle('kf-away', es[0].isIntersecting); }, { threshold: .15 }).observe($('#kontakt'));
  var seen = false; try { seen = sessionStorage.getItem('kr-kf') === '1'; } catch (e) {}
  if (!seen) setTimeout(function () { if (kf.hidden) openKf(); try { sessionStorage.setItem('kr-kf', '1'); } catch (e) {} }, 9000);

  // Anfrage als Mail
  var form = $('[data-ask]');
  if (!form) return;
  $$('.choice button', form).forEach(function (b) { b.addEventListener('click', function () { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); }); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var was = $$('.choice [aria-pressed=true]', form).map(function (b) { return b.textContent; }).join(', ') || 'noch offen';
    var body = 'Guten Tag Frau Rafai,\n\nich interessiere mich für: ' + was + '\nThema: ' + (form.thema.value || 'noch offen') + '\nZielgruppe und Umfang: ' + (form.gruppe.value || 'noch offen') + '\n\nBitte melden Sie sich für ein Erstgespräch.\n';
    location.href = window.__lastMail = 'mailto:kerstinrafai@gmail.com?subject=' + encodeURIComponent('Anfrage: ' + (form.thema.value || was)) + '&body=' + encodeURIComponent(body);
  });
})();
