// Общее для всех страниц: каталог, корзина, поиск, шапка, анимации появления.
document.documentElement.classList.add('js');

export const CATS = { top: 'Верх', bottom: 'Низ', shoes: 'Обувь', acc: 'Аксессуары' };
export const TYPES = {
  puffer: 'Пуховики', sheepskin: 'Дублёнки', jacket: 'Куртки', bomber: 'Бомберы', shirt: 'Рубашки', tee: 'Футболки', hoodie: 'Худи',
  jeans: 'Джинсы', pants: 'Брюки', joggers: 'Джоггеры', shorts: 'Шорты',
  sneakers: 'Кроссовки', hightop: 'Кроссовки', chunky: 'Кроссовки', loafers: 'Туфли', boots: 'Ботинки',
  cap: 'Кепки', bag: 'Сумки', belt: 'Ремни',
};
export const COLORS = {
  black: 'чёрный', white: 'белый', cream: 'кремовый', sand: 'песочный', beige: 'бежевый', camel: 'кэмел', brown: 'коричневый',
  olive: 'оливковый', navy: 'тёмно-синий', denim: 'деним', sky: 'голубой', grey: 'серый', pink: 'розовый', red: 'красный',
  green: 'зелёный', yellow: 'жёлтый', orange: 'оранжевый', gold: 'золото',
};
// как бренды пишут по-русски — чтобы поиск находил «найк», «гуччи»
const ALIASES = {
  'Gucci': 'гуччи гучи', 'Nike': 'найк найки', 'Stüssy': 'стусси стуси stussy', 'Moncler': 'монклер монклэр',
  'Balenciaga': 'баленсиага баленсияга', 'Prada': 'прада', 'Jordan': 'джордан жордан', 'Stone Island': 'стон айленд стоник',
  'Carhartt WIP': 'кархарт кархартт', 'Off-White': 'офф вайт офвайт', 'Burberry': 'барберри бёрберри', 'Ralph Lauren': 'ральф лорен',
  'Acne Studios': 'акне', 'Fear of God Essentials': 'эссеншиалс эсеншиалс essentials', 'New Balance': 'нью беланс нью баланс nb',
  'The North Face': 'норт фейс tnf', 'Timberland': 'тимберленд тимбы',
};
const TYPE_ALIASES = {
  sneakers: 'кроссы кеды обувь', hightop: 'кроссы кроссовки высокие', chunky: 'кроссы кроссовки', loafers: 'туфли лоферы',
  boots: 'ботинки', puffer: 'пуховик куртка', sheepskin: 'дубленка дублёнка', bomber: 'бомбер куртка', jacket: 'куртка жакет жикетка',
  tee: 'футболка майка', hoodie: 'худи толстовка кофта', shirt: 'рубашка', jeans: 'джинсы', pants: 'брюки штаны', joggers: 'штаны спортивки',
  shorts: 'шорты', cap: 'кепка', bag: 'сумка', belt: 'ремень',
};

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const nf = new Intl.NumberFormat('ru-RU');
export const money = (n) => nf.format(n) + ' сум';
export const plural = (n, [one, few, many]) => {
  const a = n % 10, b = n % 100;
  return `${n} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`;
};
export const things = (n) => plural(n, ['вещь', 'вещи', 'вещей']);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/ü/g, 'u').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ── данные ──
let db = null;
export async function load() {
  if (db) return db;
  const [data] = await Promise.all([
    fetch('data/products.json').then((r) => r.json()),
    fetch('assets/items.svg').then((r) => r.text()).then((svg) => {
      const box = document.createElement('div');
      box.hidden = true;
      box.innerHTML = svg;
      document.body.prepend(box);
    }),
  ]);
  for (const p of data.products) {
    p.hay = norm([p.brand, p.title, ALIASES[p.brand] || '', TYPES[p.type], TYPE_ALIASES[p.type] || '', CATS[p.category], COLORS[p.color] || ''].join(' '));
  }
  data.byId = new Map(data.products.map((p) => [p.id, p]));
  db = data;
  return db;
}

export function search(q, list = db.products) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return list;
  return list.filter((p) => words.every((w) => p.hay.includes(w)));
}

export const href = (p) => 'product.html?id=' + encodeURIComponent(p.id);

// фото (поле photo в products.json) или нарисованный силуэт
export const tint = (p) => `color:var(--g-${p.color});--c2:var(--g-${p.color2})`;
export const pic = (p, { model = true, eager = false } = {}) => p.photo
  ? `<img class="art__p" src="${esc(p.photo)}" alt="${esc(p.brand + ' ' + p.title)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">` +
    (model && p.model ? `<img class="art__m" src="${esc(p.model)}" alt="" loading="lazy" decoding="async">` : '')
  : `<svg viewBox="0 0 200 200" aria-hidden="true"><use href="#${p.type}"/></svg>`;
export const art = (p, cls = 'art') => `<div class="${cls}" style="${tint(p)}">${pic(p, { model: false })}</div>`;

export function card(p, i = 0) {
  return `<a class="card" href="${href(p)}" data-id="${esc(p.id)}" data-reveal style="--i:${i % 10}">
    <div class="art" style="${tint(p)}">
      ${pic(p)}
      ${p.new ? '<span class="art__tag">Новое</span>' : ''}
      <span class="art__go" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg></span>
    </div>
    <div class="card__meta">
      <span class="card__brand">${esc(p.brand)}</span>
      <span class="card__title">${esc(p.title)}</span>
      <span class="card__price">${money(p.price)}</span>
    </div>
  </a>`;
}

// ── корзина ──
const KEY = 'cf-cart-v2';
export const cart = {
  get() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } },
  set(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {}
    paintCount(true);
  },
  add(id, size) {
    const items = cart.get();
    const it = items.find((x) => x.id === id && x.size === size);
    if (it) it.qty = Math.min(10, it.qty + 1); else items.push({ id, size, qty: 1 });
    cart.set(items);
  },
  count() { return cart.get().reduce((n, x) => n + x.qty, 0); },
};
function paintCount(bump) {
  const n = cart.count();
  for (const el of $$('[data-count]')) {
    el.textContent = n;
    el.hidden = n === 0;
    if (bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  }
  for (const b of $$('[data-cart-link]')) b.setAttribute('aria-label', `Корзина, вещей: ${n}`);
}
addEventListener('storage', (e) => { if (e.key === KEY) paintCount(false); });

// ── тост ──
let toastT;
export function toast(html) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.innerHTML = html;
  requestAnimationFrame(() => el.classList.add('is-on'));
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('is-on'), 3200);
}

// ── появление при прокрутке ──
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -6% 0px' })
  : null;
export function reveal(root = document) {
  for (const el of $$('[data-reveal]:not(.in)', root)) io ? io.observe(el) : el.classList.add('in');
}

// ── поиск: выпадающий список (главная) и окно (везде) ──
export function bindSearch(input, list, { limit = 7, onEmptyHide = true } = {}) {
  let sel = -1;
  const paint = () => {
    const q = input.value.trim();
    if (!q && onEmptyHide) { list.hidden = true; return; }
    const found = q ? search(q) : db.products.filter((p) => p.new);
    sel = -1;
    list.hidden = false;
    list.innerHTML = found.length
      ? `<ul class="results" role="listbox">${found.slice(0, limit).map((p) => `<li><a href="${href(p)}" role="option">${art(p)}<span><b>${esc(p.brand)}</b><span class="t">${esc(p.title)}</span></span><span class="mono">${money(p.price)}</span></a></li>`).join('')}</ul>
         ${q ? `<a class="results__all" href="catalog.html?q=${encodeURIComponent(q)}">Все результаты: ${found.length} →</a>` : ''}`
      : `<p class="results__empty">По запросу «${esc(q)}» ничего. Попробуй бренд или тип: «Nike», «пуховик», «туфли».</p>`;
  };
  input.addEventListener('input', paint);
  input.addEventListener('focus', () => input.value.trim() && paint());
  input.addEventListener('keydown', (e) => {
    const opts = $$('[role="option"]', list);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!opts.length) return;
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.setAttribute('aria-selected', i === sel));
      opts[sel].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (sel >= 0 && opts[sel]) location.href = opts[sel].href;
      else if (input.value.trim()) location.href = 'catalog.html?q=' + encodeURIComponent(input.value.trim());
    } else if (e.key === 'Escape' && onEmptyHide) { list.hidden = true; }
  });
  if (onEmptyHide) document.addEventListener('pointerdown', (e) => { if (!input.parentElement.contains(e.target)) list.hidden = true; });
  return paint;
}

function searchDialog() {
  const dlg = document.createElement('dialog');
  dlg.className = 'search';
  dlg.setAttribute('aria-label', 'Поиск');
  dlg.innerHTML = `<div class="field-search"><svg class="ico" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input type="search" placeholder="Бренд или вещь: Moncler, Dunk, дублёнка" aria-label="Поиск по названию" autocomplete="off" enterkeyhint="search"></div>
    <div class="search__hint">${['Nike', 'Moncler', 'Gucci', 'Пуховик', 'Худи', 'Кроссовки'].map((t) => `<button type="button" class="chip">${t}</button>`).join('')}</div>
    <div data-res></div>`;
  document.body.append(dlg);
  const input = $('input', dlg);
  const paint = bindSearch(input, $('[data-res]', dlg), { limit: 8, onEmptyHide: false });
  for (const c of $$('.chip', dlg)) c.addEventListener('click', () => { input.value = c.textContent; paint(); input.focus(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  return { open() { dlg.showModal(); input.select(); paint(); } };
}

// ── переход карточка → товар: картинка «перелетает» ──
function morphCards() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.card');
    if (!a || e.metaKey || e.ctrlKey) return;
    const pic = $('.art', a);
    if (!pic) return;
    const big = $('.pdp__art');
    if (big) big.style.viewTransitionName = 'none';
    pic.style.viewTransitionName = 'pimg';
  });
  addEventListener('pageshow', () => $$('.card .art').forEach((el) => (el.style.viewTransitionName = '')));
  addEventListener('pagereveal', (e) => {
    const from = navigation?.activation?.from?.url;
    if (!e.viewTransition || !from || !from.includes('product.html')) return;
    const id = new URL(from).searchParams.get('id');
    const pic = id && $(`.card[data-id="${CSS.escape(id)}"] .art`);
    if (!pic) return;
    pic.style.viewTransitionName = 'pimg';
    e.viewTransition.finished.finally(() => (pic.style.viewTransitionName = ''));
  });
}

export async function boot() {
  paintCount(false);
  morphCards();
  await load();
  const s = searchDialog();
  for (const b of $$('[data-search]')) b.addEventListener('click', () => s.open());
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); s.open(); }
  });
  return db;
}
