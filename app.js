'use strict';

const STORE_KEY = 'wikicastro:v1';
const SUGGESTIONS = [
  'نباتات السعودية',
  'الدولة العثمانية',
  'الحرب الأهلية اليمنية',
  'الأندلس',
  'الدولة العباسية',
  'المجموعة الشمسية',
];
// Sections that are mostly citations or outbound links; dropped for a cleaner read.
const SKIP_SECTIONS = new Set([
  'المراجع', 'مراجع', 'المصادر', 'مصادر', 'وصلات خارجية', 'روابط خارجية', 'ملاحظات', 'هوامش',
  'الهوامش', 'قراءات إضافية', 'مراجع إضافية', 'المراجع والمصادر', 'معلومات المراجع',
  'References', 'External links', 'Notes', 'Further reading', 'Sources', 'Bibliography',
  'Citations', 'Footnotes', 'Works cited',
]);
const STRIP_SELECTORS = [
  'style', 'link', 'script', 'noscript', '.mw-editsection', '.navbox', '.navbox-styles',
  '.vertical-navbox', '.metadata', '.ambox', '.ombox', '.tmbox', '.noprint', '.mw-empty-elt',
  'sup.reference', '.mw-references-wrap', 'ol.references', '.reflist', '.refbegin',
  '.sistersitebox', '.portal', '.portalbox', '.authority-control', '#coordinates',
  '.shortdescription', '.navigation-not-searchable', '.mw-kartographer-maplink',
].join(',');

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

/* ---------------- state ---------------- */

function defaultState() {
  return { streams: [], log: {}, settings: { fontSize: 19, theme: 'auto' } };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed, settings: { ...defaultState().settings, ...parsed.settings } };
  } catch {
    return defaultState();
  }
}

let state = loadState();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('تعذّر حفظ التقدم في هذا المتصفح');
  }
}

const dayKey = (d = new Date()) => d.toLocaleDateString('en-CA');
const findStream = (id) => state.streams.find((s) => s.id === id);
const readCount = (s) => s.articles.filter((a) => a.readAt).length;
const nextUnread = (s, after) => {
  const i = after ? s.articles.findIndex((a) => a.title === after) : -1;
  return s.articles.slice(i + 1).find((a) => !a.readAt) || s.articles.find((a) => !a.readAt && a.title !== after);
};

function setRead(stream, title, read) {
  const a = stream.articles.find((x) => x.title === title);
  if (!a || Boolean(a.readAt) === read) return;
  a.readAt = read ? Date.now() : null;
  const k = dayKey();
  state.log[k] = Math.max(0, (state.log[k] || 0) + (read ? 1 : -1));
  save();
}

function streak() {
  let n = 0;
  const d = new Date();
  if (!state.log[dayKey(d)]) d.setDate(d.getDate() - 1); // today not started yet doesn't break the streak
  while (state.log[dayKey(d)]) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/* ---------------- wikipedia api ---------------- */

async function api(lang, params) {
  const qs = new URLSearchParams({ ...params, format: 'json', formatversion: '2', origin: '*' });
  const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.info || data.error.code);
  return data;
}

async function searchArticles(lang, query, offset = 0, limit = 20) {
  const data = await api(lang, {
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '0',
    gsrlimit: String(limit),
    gsroffset: String(offset),
    prop: 'pageimages|extracts',
    exintro: '1',
    explaintext: '1',
    exsentences: '2',
    exlimit: 'max',
    piprop: 'thumbnail',
    pithumbsize: '160',
  });
  const pages = (data.query?.pages || []).slice().sort((a, b) => a.index - b.index);
  return {
    items: pages.map((p) => ({ title: p.title, extract: p.extract || '', thumb: p.thumbnail?.source || '' })),
    nextOffset: data.continue?.gsroffset ?? null,
  };
}

async function fetchArticle(lang, title) {
  const data = await api(lang, {
    action: 'parse',
    page: title,
    prop: 'text|displaytitle',
    redirects: '1',
    disableeditsection: '1',
    disabletoc: '1',
  });
  return { title: data.parse.title, html: data.parse.text };
}

function wikiTitleFromHref(href) {
  if (!href.startsWith('/wiki/')) return null;
  try {
    return decodeURIComponent(href.slice(6).split('#')[0]).replace(/_/g, ' ');
  } catch {
    return null;
  }
}

function cleanArticle(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body;
  root.querySelectorAll(STRIP_SELECTORS).forEach((el) => el.remove());

  // drop reference / external-link sections (heading + everything until the next h2)
  root.querySelectorAll('h2').forEach((h) => {
    const label = h.textContent.replace(/\[.*?\]/g, '').trim();
    if (!SKIP_SECTIONS.has(label)) return;
    const start = h.closest('.mw-heading') || h;
    let el = start.nextElementSibling;
    while (el && !(el.matches('h2, .mw-heading2'))) {
      const next = el.nextElementSibling;
      el.remove();
      el = next;
    }
    start.remove();
  });

  root.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
  });

  const unwrap = (el) => el.replaceWith(...el.childNodes);
  root.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const title = wikiTitleFromHref(href);
    if (title && !/^[^:]+:/.test(title)) {
      a.dataset.wiki = title;
      a.removeAttribute('title');
      a.setAttribute('href', '#');
    } else if (href.startsWith('#') && href.length > 1) {
      a.dataset.anchor = href.slice(1);
      a.setAttribute('href', '#');
    } else if (/^(https?:)?\/\//.test(href)) {
      if (href.startsWith('//')) a.setAttribute('href', `https:${href}`);
      a.target = '_blank';
      a.rel = 'noopener';
      a.classList.add('external');
    } else {
      unwrap(a); // file pages, categories, red links
    }
  });

  root.querySelectorAll('img').forEach((img) => {
    const fix = (v) => v && v.replace(/(^|\s|,)\/\//g, '$1https://');
    img.setAttribute('src', fix(img.getAttribute('src')));
    if (img.getAttribute('srcset')) img.setAttribute('srcset', fix(img.getAttribute('srcset')));
    img.loading = 'lazy';
    img.decoding = 'async';
  });

  root.querySelectorAll('table').forEach((t) => {
    if (t.classList.contains('infobox') || t.parentElement?.closest('table')) return;
    const wrap = doc.createElement('div');
    wrap.className = 'table-wrap';
    t.replaceWith(wrap);
    wrap.append(t);
  });

  const words = root.textContent.trim().split(/\s+/).length;
  return { html: root.innerHTML, minutes: Math.max(1, Math.round(words / 200)) };
}

/* ---------------- helpers ---------------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const enc = encodeURIComponent;
const pct = (s) => (s.articles.length ? Math.round((readCount(s) / s.articles.length) * 100) : 0);
const streamHref = (s) => `#/s/${s.id}`;
const readerHref = (s, title) => `#/s/${s.id}/r/${enc(title)}`;

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function setProgress(fraction) {
  const bar = $('#readProgress');
  bar.hidden = fraction == null;
  if (fraction != null) bar.firstElementChild.style.width = `${Math.min(100, fraction * 100)}%`;
}

/* ---------------- views ---------------- */

function renderHome() {
  const sorted = state.streams.slice().sort((a, b) => (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt));
  const current = sorted.find((s) => readCount(s) < s.articles.length);
  const totalRead = state.streams.reduce((n, s) => n + readCount(s), 0);
  const lang = state.settings.lastLang || 'ar';

  app.innerHTML = `
    <section class="hero">
      <h1>وش بتقرأ اليوم؟</h1>
      <p class="muted">اكتب موضوع، ونجمع لك مقالاته من ويكيبيديا في مسار قراءة تتابع فيه تقدمك.</p>
      <form class="new-stream card" id="newStream">
        <span class="prefix">اليوم بقرأ عن</span>
        <input type="text" name="topic" placeholder="مثلاً: الدولة العثمانية" autocomplete="off" required>
        <div class="lang-toggle" role="group" aria-label="لغة ويكيبيديا">
          <button type="button" data-lang="ar" aria-pressed="${lang === 'ar'}">ع</button>
          <button type="button" data-lang="en" aria-pressed="${lang === 'en'}">EN</button>
        </div>
        <button class="btn primary" type="submit">ابدأ</button>
      </form>
      <div class="chips">${SUGGESTIONS.map((t) => `<button class="chip" type="button" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    </section>

    ${state.streams.length ? `
      <div class="stats">
        <div class="stat card"><b>${state.log[dayKey()] || 0}</b><span>مقالات اليوم</span></div>
        <div class="stat card"><b>${streak()}</b><span>أيام متتالية</span></div>
        <div class="stat card"><b>${totalRead}</b><span>مجموع ما قرأت</span></div>
      </div>` : ''}

    ${current ? renderTodayCard(current) : ''}

    <h2>مساراتي</h2>
    ${sorted.length ? `<div class="stream-list">${sorted.map(renderStreamItem).join('')}</div>`
      : '<div class="empty card">ما عندك مسارات للحين. اختر موضوع من فوق وابدأ.</div>'}
  `;

  const form = $('#newStream');
  form.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    state.settings.lastLang = b.dataset.lang;
    save();
    form.querySelectorAll('[data-lang]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    createStream(form.topic.value.trim(), state.settings.lastLang || 'ar', form.querySelector('[type=submit]'));
  });
  app.querySelectorAll('[data-topic]').forEach((c) => c.addEventListener('click', () => {
    form.topic.value = c.dataset.topic;
    form.requestSubmit();
  }));
}

function renderTodayCard(s) {
  const next = nextUnread(s);
  return `
    <section class="today card">
      <div class="label">تقرأ حالياً عن</div>
      <h2>${esc(s.topic)}</h2>
      <div class="bar"><span style="width:${pct(s)}%"></span></div>
      <div class="muted small">${readCount(s)} من ${s.articles.length} مقالة · ${pct(s)}%</div>
      ${next ? `<a class="btn primary next" href="${readerHref(s, next.title)}">كمّل: ${esc(next.title)}</a>` : ''}
    </section>`;
}

function renderStreamItem(s) {
  const done = readCount(s) === s.articles.length;
  return `
    <a class="stream-item card" href="${streamHref(s)}">
      <div class="head">
        <h3>${esc(s.topic)} <span class="muted small">${s.lang === 'en' ? 'EN' : ''}</span></h3>
        <span class="count">${done ? '<span class="done-badge">خلصته ✓</span>' : `${readCount(s)}/${s.articles.length}`}</span>
      </div>
      <div class="bar"><span style="width:${pct(s)}%"></span></div>
    </a>`;
}

async function createStream(topic, lang, btn) {
  if (!topic) return;
  const existing = state.streams.find((s) => s.topic === topic && s.lang === lang);
  if (existing) {
    location.hash = streamHref(existing);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'نجمع المقالات…';
  try {
    const first = await searchArticles(lang, topic);
    if (!first.items.length) throw new Error('ما لقينا مقالات عن هذا الموضوع، جرّب صياغة ثانية');
    let items = first.items;
    try {
      // articles similar to the top hit widen the stream beyond keyword matches
      const similar = await searchArticles(lang, `morelike:${items[0].title}`, 0, 10);
      const seen = new Set(items.map((a) => a.title));
      items = items.concat(similar.items.filter((a) => !seen.has(a.title)));
    } catch { /* optional */ }
    const now = Date.now();
    const stream = {
      id: now.toString(36),
      topic,
      lang,
      createdAt: now,
      lastOpenedAt: now,
      nextOffset: first.nextOffset,
      articles: items.map((a, i) => ({ ...a, main: i === 0, addedAt: now, readAt: null })),
    };
    state.streams.push(stream);
    save();
    location.hash = streamHref(stream);
  } catch (err) {
    toast(err.message.startsWith('HTTP') || err instanceof TypeError ? 'تعذّر الاتصال بويكيبيديا' : err.message);
    btn.disabled = false;
    btn.textContent = 'ابدأ';
  }
}

let streamFilter = 'all';

function renderStream(s) {
  const next = nextUnread(s);
  const list = s.articles.filter((a) => streamFilter === 'all' || (streamFilter === 'read' ? a.readAt : !a.readAt));
  const created = new Date(s.createdAt).toLocaleDateString('ar', { day: 'numeric', month: 'long', year: 'numeric', numberingSystem: 'latn' });

  app.innerHTML = `
    <div class="crumbs"><a href="#/">مساراتي</a></div>
    <section class="stream-head">
      <h1>${esc(s.topic)}</h1>
      <div class="meta">بدأته ${esc(created)} · ويكيبيديا ${s.lang === 'en' ? 'الإنجليزية' : 'العربية'}</div>
      <div class="bar"><span style="width:${pct(s)}%"></span></div>
      <div><b>${readCount(s)}</b> من ${s.articles.length} مقالة <span class="muted">(${pct(s)}%)</span></div>
      <div class="row actions">
        ${next ? `<a class="btn primary" href="${readerHref(s, next.title)}">${readCount(s) ? 'كمّل القراءة' : 'ابدأ القراءة'}</a>` : '<span class="done-badge">خلصت المسار كامل ✓</span>'}
        <button class="btn ghost danger" id="deleteStream">حذف المسار</button>
      </div>
    </section>

    <div class="filter-tabs" role="group" aria-label="تصفية">
      ${[['all', 'الكل'], ['unread', 'باقي'], ['read', 'مقروءة']].map(([k, label]) =>
        `<button data-filter="${k}" aria-pressed="${streamFilter === k}">${label}</button>`).join('')}
    </div>

    <div class="articles">
      ${list.map((a) => `
        <div class="article card ${a.readAt ? 'read' : ''}" data-title="${esc(a.title)}">
          <button class="check" aria-label="${a.readAt ? 'إلغاء القراءة' : 'تحديد كمقروءة'}" data-toggle>✓</button>
          <a class="body" href="${readerHref(s, a.title)}">
            <h3>${esc(a.title)}${a.main ? '<span class="main-tag">الأساسية</span>' : ''}</h3>
            ${a.extract ? `<p>${esc(a.extract)}</p>` : ''}
          </a>
          <div class="side">
            ${a.thumb ? `<img class="thumb" src="${esc(a.thumb)}" alt="" loading="lazy">` : ''}
            <button class="remove" data-remove aria-label="إزالة من المسار" title="إزالة من المسار">✕</button>
          </div>
        </div>`).join('') || '<div class="empty">ما فيه شي هنا.</div>'}
    </div>

    <div class="load-more">
      <button class="btn" id="loadMore" ${s.nextOffset == null ? 'disabled' : ''}>
        ${s.nextOffset == null ? 'ما فيه مقالات أكثر' : '+ اسحب مقالات مرتبطة أكثر'}
      </button>
    </div>
  `;

  app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    streamFilter = b.dataset.filter;
    renderStream(s);
  }));
  app.querySelectorAll('.article').forEach((row) => {
    const title = row.dataset.title;
    row.querySelector('[data-toggle]').addEventListener('click', () => {
      const a = s.articles.find((x) => x.title === title);
      setRead(s, title, !a.readAt);
      renderStream(s);
    });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      s.articles = s.articles.filter((x) => x.title !== title);
      save();
      renderStream(s);
      toast('انشالت من المسار');
    });
  });
  $('#deleteStream').addEventListener('click', () => {
    if (!confirm(`تحذف مسار «${s.topic}» وتقدمك فيه؟`)) return;
    state.streams = state.streams.filter((x) => x !== s);
    save();
    location.hash = '#/';
  });
  $('#loadMore').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'نجيب مقالات…';
    try {
      const more = await searchArticles(s.lang, s.topic, s.nextOffset);
      const seen = new Set(s.articles.map((a) => a.title));
      const fresh = more.items.filter((a) => !seen.has(a.title));
      s.articles.push(...fresh.map((a) => ({ ...a, addedAt: Date.now(), readAt: null })));
      s.nextOffset = more.nextOffset;
      save();
      toast(fresh.length ? `انضافت ${fresh.length} مقالة` : 'ما لقينا مقالات جديدة');
    } catch {
      toast('تعذّر الاتصال بويكيبيديا');
    }
    renderStream(s);
  });
}

let readerCleanup = null;

async function renderReader(s, title) {
  const article = s.articles.find((a) => a.title === title);
  s.lastOpenedAt = Date.now();
  save();

  app.innerHTML = `
    <div class="crumbs"><a href="#/">مساراتي</a> ‹ <a href="${streamHref(s)}">${esc(s.topic)}</a></div>
    <div class="skeleton title"></div>
    ${'<div class="skeleton line"></div>'.repeat(8)}
  `;
  window.scrollTo(0, 0);

  let data;
  try {
    data = await fetchArticle(s.lang, title);
  } catch (err) {
    if (currentRoute !== location.hash) return;
    app.innerHTML = `
      <div class="crumbs"><a href="#/">مساراتي</a> ‹ <a href="${streamHref(s)}">${esc(s.topic)}</a></div>
      <div class="error card"><p>ما قدرنا نفتح المقالة.</p><p class="muted small">${esc(err.message)}</p>
      <button class="btn" onclick="route()">حاول مرة ثانية</button></div>`;
    return;
  }
  if (currentRoute !== location.hash) return; // user navigated away while loading

  const { html, minutes } = cleanArticle(data.html);
  const index = article ? s.articles.indexOf(article) + 1 : 0;

  app.innerHTML = `
    <div class="crumbs"><a href="#/">مساراتي</a> ‹ <a href="${streamHref(s)}">${esc(s.topic)}</a></div>
    <h1 class="reader-title">${esc(data.title)}</h1>
    <div class="reader-meta">
      ${index ? `المقالة ${index} من ${s.articles.length} · ` : ''}${minutes} دقيقة قراءة ·
      <a href="https://${s.lang}.wikipedia.org/wiki/${enc(data.title.replace(/ /g, '_'))}" target="_blank" rel="noopener">افتحها في ويكيبيديا</a>
    </div>
    ${article ? '' : `
      <div class="not-in-stream card">
        <span>هذي المقالة مو ضمن مسار «${esc(s.topic)}».</span>
        <button class="btn primary" id="addToStream">+ أضفها للمسار</button>
      </div>`}
    <article class="prose" dir="${s.lang === 'ar' ? 'rtl' : 'ltr'}" lang="${s.lang}">${html}</article>
    <section class="finish card" id="finish"></section>
    ${article ? '<div class="fab" id="fab"></div>' : ''}
  `;

  const renderFinish = () => {
    const a = s.articles.find((x) => x.title === title);
    const next = nextUnread(s, title);
    $('#finish').innerHTML = a
      ? `<p>${a.readAt ? 'سجّلناها مقروءة ✓' : 'خلصت المقالة؟'}</p>
         <div class="row">
           ${a.readAt ? '<button class="btn" id="unread">إلغاء</button>' : '<button class="btn primary" id="markRead">خلصتها ✓</button>'}
           ${next ? `<a class="btn ${a.readAt ? 'primary' : ''}" href="${readerHref(s, next.title)}">التالية: ${esc(next.title)} ←</a>`
             : `<a class="btn" href="${streamHref(s)}">رجوع للمسار</a>`}
         </div>`
      : `<div class="row"><a class="btn" href="${streamHref(s)}">رجوع للمسار</a></div>`;
    const fab = $('#fab');
    if (fab) {
      fab.innerHTML = a.readAt
        ? (next ? `<a class="btn primary" href="${readerHref(s, next.title)}">التالية ←</a>` : '')
        : '<button class="btn primary" id="fabRead">خلصتها ✓</button>';
    }
    $('#markRead')?.addEventListener('click', markRead);
    $('#fabRead')?.addEventListener('click', markRead);
    $('#unread')?.addEventListener('click', () => { setRead(s, title, false); renderFinish(); });
  };
  const markRead = () => {
    setRead(s, title, true);
    renderFinish();
    const done = readCount(s) === s.articles.length;
    toast(done ? `خلصت مسار «${s.topic}» كامل 🎉` : `${readCount(s)} من ${s.articles.length} — كفو`);
  };
  renderFinish();

  $('#addToStream')?.addEventListener('click', () => {
    s.articles.push({ title: data.title, extract: '', thumb: '', addedAt: Date.now(), readAt: null });
    save();
    route();
  });

  app.querySelector('.prose').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-wiki], a[data-anchor]');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.wiki) location.hash = readerHref(s, a.dataset.wiki);
    else document.getElementById(a.dataset.anchor)?.scrollIntoView({ behavior: 'smooth' });
  });

  // reading progress + auto-mark when the end is reached after a reasonable time
  const openedAt = Date.now();
  const minMs = Math.max(20, minutes * 15) * 1000;
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    setProgress(max > 0 ? scrollY / max : 1);
  };
  const observer = new IntersectionObserver(([entry]) => {
    const a = s.articles.find((x) => x.title === title);
    if (entry.isIntersecting && a && !a.readAt && Date.now() - openedAt > minMs) markRead();
  });
  observer.observe($('#finish'));
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  readerCleanup = () => {
    removeEventListener('scroll', onScroll);
    observer.disconnect();
    setProgress(null);
  };
}

/* ---------------- router ---------------- */

let currentRoute = '';

function route() {
  readerCleanup?.();
  readerCleanup = null;
  currentRoute = location.hash;
  const parts = location.hash.replace(/^#\/?/, '').split('/');

  if (parts[0] === 's' && parts[1]) {
    const s = findStream(parts[1]);
    if (!s) return void (location.hash = '#/');
    if (parts[2] === 'r' && parts[3]) {
      let title;
      try { title = decodeURIComponent(parts.slice(3).join('/')); } catch { title = parts[3]; }
      renderReader(s, title);
    } else {
      renderStream(s);
      window.scrollTo(0, 0);
    }
  } else {
    renderHome();
    window.scrollTo(0, 0);
  }
}

addEventListener('hashchange', route);

/* ---------------- settings ---------------- */

function applySettings() {
  const { fontSize, theme } = state.settings;
  document.documentElement.style.setProperty('--reader-size', `${fontSize}px`);
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

$('#themeBtn').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
  save();
  applySettings();
  toast({ auto: 'المظهر: تلقائي', light: 'المظهر: فاتح', dark: 'المظهر: داكن' }[state.settings.theme]);
});

$('#settingsBtn').addEventListener('click', () => {
  $('#fontSize').value = state.settings.fontSize;
  $('#settingsDialog').showModal();
});

$('#fontSize').addEventListener('input', (e) => {
  state.settings.fontSize = Number(e.target.value);
  applySettings();
  save();
});

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wikicastro-${dayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.streams)) throw new Error();
    if (!confirm('الاستيراد بيستبدل تقدمك الحالي. تكمل؟')) return;
    state = { ...defaultState(), ...data, settings: { ...defaultState().settings, ...data.settings } };
    save();
    applySettings();
    $('#settingsDialog').close();
    location.hash = '#/';
    route();
    toast('تم الاستيراد');
  } catch {
    toast('الملف غير صالح');
  }
});

/* ---------------- boot ---------------- */

applySettings();
route();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
