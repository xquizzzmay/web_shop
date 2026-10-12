// Claude Fergana · фронт (apple-54).
// Один rAF-цикл на всё: скролл читается один раз за кадр, раскладка кэшируется
// на resize, в DOM пишутся только CSS-переменные, и только когда значение изменилось.

import { initCloth } from './cloth.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const smooth = (t) => t * t * (3 - 2 * t);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const fmt = new Intl.NumberFormat('ru-RU');
const money = (n) => `${fmt.format(n)} сум`;
const TG = 'shxawenya';

// Пишет переменную только при заметном изменении — экономит пересчёт стилей
const vars = new WeakMap();
function setVar(el, name, v, eps = 0.001) {
  let m = vars.get(el); if (!m) vars.set(el, (m = {}));
  if (m[name] !== undefined && Math.abs(m[name] - v) < eps) return;
  m[name] = v;
  el.style.setProperty(name, typeof v === 'number' ? v.toFixed(4) : v);
}

/* ── Данные ─────────────────────────────────────────── */
let catalog = { products: [], telegram: TG };
const byId = new Map();

async function loadProducts() {
  // на GitHub Pages и file:// API нет — сразу берём файл, без 404 в консоли
  const api = !/github\.io$/.test(location.hostname) && location.protocol !== 'file:';
  for (const url of api ? ['api/products', 'data/products.json'] : ['data/products.json']) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j.products)) return j;
    } catch { /* статический хостинг без API — пробуем файл */ }
  }
  return { products: [] };
}

const svgCache = new Map();
async function garmentSVG(p) {
  if (svgCache.has(p.id)) return svgCache.get(p.id);
  const job = fetch(p.svg).then((r) => (r.ok ? r.text() : Promise.reject(r.status))).then((txt) => {
    const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.nodeName !== 'svg') throw new Error('bad svg');
    svg.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
    svg.querySelectorAll('*').forEach((n) => [...n.attributes].forEach((a) => { if (/^on/i.test(a.name)) n.removeAttribute(a.name); }));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.removeAttribute('width'); svg.removeAttribute('height');
    return svg.outerHTML;
  }).catch(() => placeholderSVG());
  svgCache.set(p.id, job);
  return job;
}
function placeholderSVG() {
  return `<svg viewBox="0 0 400 560" aria-hidden="true"><g id="body"><path d="M140 40h120l60 60-30 40-30-20v420H140V120l-30 20-30-40z" fill="currentColor"/></g></svg>`;
}
// Уникализируем id внутри инлайн-SVG (иначе <pattern id> разных вещей конфликтуют).
// Группы для анимации остаются с исходными id, CSS ищет их внутри .slide__garment.
function scopeIds(html, prefix) {
  return html
    .replace(/id="(?!body"|sleeve-l"|sleeve-r"|leg-l"|leg-r"|hem"|tail")([^"]+)"/g, `id="${prefix}-$1"`)
    .replace(/url\(#(?!body\)|sleeve-l\)|sleeve-r\)|leg-l\)|leg-r\)|hem\)|tail\))([^)]+)\)/g, `url(#${prefix}-$1)`)
    .replace(/href="#(?!body"|sleeve-l"|sleeve-r"|leg-l"|leg-r"|hem"|tail")([^"]+)"/g, `href="#${prefix}-$1"`);
}

/* ── Корзина ────────────────────────────────────────── */
const cart = {
  lines: [],
  load() {
    try { this.lines = JSON.parse(localStorage.getItem('cf-cart') || '[]').filter((l) => byId.has(l.id)); } catch { this.lines = []; }
  },
  save() { try { localStorage.setItem('cf-cart', JSON.stringify(this.lines)); } catch { /* приватный режим */ } },
  add(id, size) {
    const l = this.lines.find((x) => x.id === id && x.size === size);
    if (l) l.qty = Math.min(10, l.qty + 1); else this.lines.push({ id, size, qty: 1 });
    this.save(); renderCart();
  },
  remove(i) { this.lines.splice(i, 1); this.save(); renderCart(); },
  clear() { this.lines = []; this.save(); renderCart(); },
  total() { return this.lines.reduce((s, l) => s + (byId.get(l.id)?.price || 0) * l.qty, 0); },
  count() { return this.lines.reduce((s, l) => s + l.qty, 0); },
};

async function renderCart() {
  const n = cart.count();
  $('[data-cart-count]').textContent = n;
  $('[data-cart-open]').setAttribute('aria-label', `Корзина, ${n} ${plural(n, 'вещь', 'вещи', 'вещей')}`);
  $('[data-cart-total]').textContent = money(cart.total());

  const box = $('[data-cart-lines]');
  if (!cart.lines.length) {
    box.innerHTML = '<p class="order__empty">Пока пусто.</p>';
  } else {
    const rows = await Promise.all(cart.lines.map(async (l, i) => {
      const p = byId.get(l.id);
      const svg = scopeIds(await garmentSVG(p), `c${i}`);
      return `<div class="line-item">
        <div class="line-item__thumb" style="color: var(${p.silk})">${svg}</div>
        <div class="line-item__meta"><p>${esc(p.name)}</p><p>Размер ${esc(l.size)} · ${l.qty} шт.</p></div>
        <div><p class="price">${money(p.price * l.qty)}</p><button class="line-item__remove" type="button" data-remove="${i}">Убрать</button></div>
      </div>`;
    }));
    box.innerHTML = rows.join('');
  }

  const sum = $('[data-order-summary]');
  sum.innerHTML = cart.lines.length
    ? cart.lines.map((l) => { const p = byId.get(l.id); return `<p class="order__row"><span>${esc(p.name)}, ${esc(l.size)} × ${l.qty}</span><span class="price">${money(p.price * l.qty)}</span></p>`; }).join('')
      + `<p class="order__row order__row--total"><span>Итого</span><span class="price">${money(cart.total())}</span></p>`
    : '<p class="order__empty">Корзина пуста — выберите размер в коллекции.</p>';
}
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function setupDrawer() {
  const drawer = $('[data-cart]'), back = $('[data-cart-backdrop]'), opener = $('[data-cart-open]');
  const open = () => {
    drawer.classList.add('is-open'); back.classList.add('is-open');
    drawer.removeAttribute('inert'); drawer.setAttribute('aria-hidden', 'false');
    $('[data-cart-close]').focus();
  };
  const close = (focusBack = true) => {
    drawer.classList.remove('is-open'); back.classList.remove('is-open');
    drawer.setAttribute('inert', ''); drawer.setAttribute('aria-hidden', 'true');
    if (focusBack) opener.focus();
  };
  opener.addEventListener('click', open);
  $('[data-cart-close]').addEventListener('click', () => close());
  back.addEventListener('click', () => close());
  $('[data-cart-checkout]').addEventListener('click', () => close(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('is-open')) close(); });
  $('[data-cart-lines]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) { cart.remove(+b.dataset.remove); toast('Убрано из корзины'); }
  });
}

let toastTimer;
function toast(msg) {
  const t = $('[data-toast]');
  t.textContent = msg; t.classList.add('is-visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('is-visible'), 2200);
}

/* ── Слайды коллекции ───────────────────────────────── */
async function buildSlides() {
  const rail = $('[data-track-rail]');
  const tpl = $('#tpl-slide');
  const ps = catalog.products;
  $('[data-track-total]').textContent = String(ps.length).padStart(2, '0');
  $('[data-track]').style.setProperty('--slides', ps.length);

  const svgs = await Promise.all(ps.map(garmentSVG));
  ps.forEach((p, i) => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.style.setProperty('--slide-silk', `var(${p.silk})`);
    li.dataset.id = p.id;
    $('[data-garment]', li).innerHTML = scopeIds(svgs[i], `g${i}`);
    $('.slide__plate', li).textContent = `Вещь ${String(i + 1).padStart(2, '0')} · ${categoryRu(p.category)}`;
    $('.slide__name', li).textContent = p.name;
    $('.slide__fabric', li).textContent = p.fabric;
    $('.slide__note', li).textContent = p.note || '';
    $('.slide__price', li).textContent = money(p.price);
    const chips = $('.chips', li);
    const add = $('.slide__add', li);
    let size = null;
    for (const s of p.sizes) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = s;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        size = s;
        chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
        add.disabled = false; add.textContent = `В корзину · ${s}`;
      });
      chips.append(b);
    }
    if (p.sizes.length === 1) { // платок — один размер, выбираем сразу
      const only = chips.firstElementChild;
      only.textContent = p.sizes[0] === 'ONE' ? 'Один размер' : p.sizes[0];
      only.click();
    }
    add.addEventListener('click', () => {
      if (!size) return;
      cart.add(p.id, size);
      add.dataset.state = 'success';
      add.textContent = 'Добавлено';
      kick(1.4); // одежда «вздрагивает»
      setTimeout(() => { delete add.dataset.state; add.textContent = `В корзину · ${size}`; }, 1400);
    });
    rail.append(li);
  });
}
const categoryRu = (c) => ({ outerwear: 'верхнее', shirts: 'рубашки', dresses: 'платья', trousers: 'брюки', accessories: 'аксессуары' }[c] || c);

/* ── Движок скролла ─────────────────────────────────── */
const S = {
  y: 0, lastY: 0, vh: 0, vw: 0,
  track: null, trackTop: 0, trackLen: 1, rail: null, railW: 0, slides: [], slideX: [], slideW: 0,
  craft: null, craftTop: 0, craftLen: 1, panels: [], steps: [], activeStep: -1,
  footer: null, footTop: 0, foot: null,
  x: 0, prevX: 0,
  flap: 0, flapV: 0, kick: 0,
  idx: -1, navHidden: false, navAcc: 0,
  heroVisible: true, trackVisible: false,
  cloth: null,
};

function measure() {
  S.vh = innerHeight; S.vw = document.documentElement.clientWidth;
  const top = (el) => el.getBoundingClientRect().top + scrollY;
  S.trackTop = top(S.track); S.trackLen = Math.max(1, S.track.offsetHeight - S.vh);
  S.railW = S.rail.scrollWidth;
  S.slides = $$('.slide', S.rail);
  S.slideX = S.slides.map((s) => s.offsetLeft + s.offsetWidth / 2);
  S.slideW = S.slides[0]?.offsetWidth || S.vw;
  S.craftTop = top(S.craft); S.craftLen = Math.max(1, S.craft.offsetHeight - S.vh);
  S.footTop = top(S.footer);
}

function kick(v) { S.kick = v; wake(); }

let raf = 0, last = 0;
function wake() { if (!raf) raf = requestAnimationFrame(frame); }

function frame(now) {
  raf = 0;
  const dt = Math.min(48, now - (last || now)) / 16.667; last = now;
  S.y = scrollY;
  let busy = false;

  // nav: прячется при прокрутке вниз
  const dy = S.y - S.lastY; S.lastY = S.y;
  S.navAcc = Math.sign(dy) === Math.sign(S.navAcc) ? S.navAcc + dy : dy;
  const wantHidden = S.y > S.vh * 0.6 && S.navAcc > 40 && !document.querySelector('.drawer.is-open');
  if (S.navAcc < -20 || S.y < S.vh * 0.6) S.navHidden = false; else if (wantHidden) S.navHidden = true;
  if (S.nav.dataset.hidden !== String(S.navHidden)) S.nav.dataset.hidden = String(S.navHidden);

  // горизонтальный трек: при прокрутке вниз ряд едет слева направо
  // каждая вещь «задерживается» в центре, переход между ними — плавный рывок
  const p = clamp((S.y - S.trackTop) / S.trackLen);
  const n0 = S.slides.length;
  if (n0) {
    const k = p * (n0 - 1), seg = Math.min(n0 - 2, Math.floor(k));
    const fr = n0 > 1 ? smooth(clamp((k - Math.max(0, seg) - 0.18) / 0.64)) : 0;
    const xa = S.vw / 2 - S.slideX[Math.max(0, seg)], xb = S.vw / 2 - S.slideX[Math.min(n0 - 1, seg + 1)];
    S.x = n0 > 1 ? xa + (xb - xa) * fr : xa;
  }
  if (S.trackVisible || Math.abs(S.flap) > 0.002 || Math.abs(S.flapV) > 0.002) {
    setVar(S.rail, '--track-x', `${S.x.toFixed(1)}px`, 0);
    setVar(S.track, '--track-p', p);
    const vx = (S.x - S.prevX) / dt; S.prevX = S.x;
    // пружина: скорость ряда «раздувает» рукава и подол, затем они успокаиваются
    const target = clamp(vx / 40, -1, 1) + S.kick * Math.sin(now / 60);
    S.kick *= 0.9;
    S.flapV += (target - S.flap) * 0.08 * dt;
    S.flapV *= Math.pow(0.82, dt);
    S.flap += S.flapV * dt;
    setVar(S.rail, '--flap', S.flap);
    const breath = Math.sin(now / 900);
    let best = 0, bestI = 0;
    S.slides.forEach((el, i) => {
      const cx = S.slideX[i] + S.x;
      const d = (cx - S.vw / 2) / S.slideW;
      const f = easeOut(clamp(1 - Math.abs(d)));
      if (f > best) { best = f; bestI = i; }
      setVar(el, '--focus', f);
      setVar(el, '--parallax', `${(d * -40).toFixed(1)}px`, 0);
      setVar(el, '--sway', S.flap * 2.5);
      setVar(el, '--breath', f > 0.5 ? breath : 0, 0.01);
    });
    if (bestI !== S.idx) { S.idx = bestI; $('[data-track-index]').textContent = String(bestI + 1).padStart(2, '0'); }
    busy = S.trackVisible || Math.abs(S.flap) > 0.002 || Math.abs(S.flapV) > 0.002 || S.kick > 0.01;
  }

  // ткань: панели падают сверху одна на другую
  const q = clamp((S.y - S.craftTop) / S.craftLen);
  const n = S.panels.length;
  const s = q * (n - 1) * 1.08;
  S.panels.forEach((el, i) => {
    const drop = i === 0 ? 1 : easeOut(clamp(s - (i - 1)));
    const under = i < n - 1 ? easeOut(clamp(s - i)) : 0;
    setVar(el, '--drop', drop);
    setVar(el, '--under', under);
  });
  let step = 0;
  for (let i = 1; i < n; i++) if (easeOut(clamp(s - (i - 1))) >= 0.5) step = i;
  if (step !== S.activeStep) { S.activeStep = step; S.steps.forEach((li, i) => li.classList.toggle('is-active', i === step)); }

  // футер: буквы поднимаются
  setVar(S.footer, '--foot', easeOut(clamp((S.y + S.vh - S.footTop) / (S.vh * 0.6))));

  // шёлк
  if (S.cloth && S.heroVisible && !document.hidden && !reduced.matches) { S.cloth.draw(now); busy = true; }

  if (busy) wake();
}

function splitWords(root, i0 = 0) {
  let i = i0;
  for (const node of [...root.childNodes]) {
    if (node.nodeType === 3) {
      const frag = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.append(part); return; }
        const w = document.createElement('span');
        w.className = 'word'; w.style.setProperty('--i', i++); w.textContent = part;
        frag.append(w);
      });
      node.replaceWith(frag);
    } else if (node.nodeType === 1) {
      const w = document.createElement('span');
      w.className = 'word'; w.style.setProperty('--i', i++);
      node.replaceWith(w); w.append(node);
    }
  }
  return i;
}

function splitChars(el) {
  const txt = el.textContent; el.textContent = ''; el.setAttribute('aria-label', txt);
  [...txt].forEach((ch, i) => {
    const s = document.createElement('span');
    s.className = 'ch'; s.setAttribute('aria-hidden', 'true');
    s.textContent = ch === ' ' ? ' ' : ch;
    s.style.setProperty('--k', (1 + Math.sin(i * 1.7) * 0.6).toFixed(2));
    el.append(s);
  });
}

/* ── Заказ ──────────────────────────────────────────── */
function telegramText(lines, form, orderId) {
  const rows = lines.map((l) => { const p = byId.get(l.id); return `— ${p.name}, ${l.size} × ${l.qty} — ${money(p.price * l.qty)}`; });
  return [`Заказ Claude Fergana${orderId ? ` ${orderId}` : ''}`, ...rows, `Итого: ${money(cart.total())}`,
    `Имя: ${form.name}`, `Телефон: ${form.phone}`, form.note ? `Комментарий: ${form.note}` : ''].filter(Boolean).join('\n');
}

function setupOrder() {
  const formEl = $('[data-order-form]'), btn = $('[data-order-submit]'), status = $('[data-order-status]');
  const fields = { name: $('#f-name'), phone: $('#f-phone') };
  const check = () => {
    let ok = true;
    for (const [k, el] of Object.entries(fields)) {
      const v = el.value.trim();
      const bad = k === 'phone' ? v.replace(/\D/g, '').length < 7 : v.length < 2;
      el.closest('.field').classList.toggle('is-error', bad);
      el.setAttribute('aria-invalid', String(bad));
      el.setAttribute('aria-describedby', `f-${k}-err`);
      $(`#f-${k}-err`).hidden = !bad;
      if (bad && ok) { el.focus(); ok = false; }
    }
    return ok;
  };
  Object.values(fields).forEach((el) => el.addEventListener('input', () => {
    if (el.closest('.field').classList.contains('is-error')) check();
  }));

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!cart.lines.length) { status.textContent = 'Сначала выберите вещь и размер в коллекции.'; return; }
    if (!check()) return;
    const form = { name: fields.name.value.trim(), phone: fields.phone.value.trim(), note: $('#f-note').value.trim() };
    btn.dataset.state = 'loading'; btn.disabled = true; btn.textContent = 'Отправляем…';
    status.textContent = '';
    let url = null, orderId = null;
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch('api/order', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: cart.lines, ...form }),
      });
      clearTimeout(to);
      const j = await r.json().catch(() => null);
      if (r.status === 400 && j && j.error) {
        btn.dataset.state = 'error'; btn.textContent = 'Проверьте заказ';
        status.textContent = j.error;
        setTimeout(() => { delete btn.dataset.state; btn.disabled = false; btn.textContent = 'Оформить в Telegram'; }, 2000);
        return;
      }
      if (r.ok && j && j.ok) { url = j.telegram_url; orderId = j.order_id; }
    } catch { /* нет сервера — статический хостинг */ }
    if (!url) url = `https://t.me/${catalog.telegram || TG}?text=${encodeURIComponent(telegramText(cart.lines, form, orderId))}`;
    btn.dataset.state = 'success'; btn.textContent = 'Открываем Telegram';
    status.textContent = orderId ? `Заказ ${orderId} сохранён. Если Telegram не открылся — ` : 'Если Telegram не открылся — ';
    const a = document.createElement('a'); a.href = url; a.rel = 'noopener'; a.textContent = 'нажмите сюда';
    status.append(a, '.');
    cart.clear();
    setTimeout(() => { delete btn.dataset.state; btn.disabled = false; btn.textContent = 'Оформить в Telegram'; }, 2500);
    location.href = url;
  });
}

/* ── Старт ──────────────────────────────────────────── */
async function main() {
  S.nav = $('[data-nav]');
  S.track = $('[data-track]'); S.rail = $('[data-track-rail]');
  S.craft = $('[data-craft]'); S.panels = $$('[data-panel]'); S.steps = $$('[data-craft-steps] li');
  S.footer = $('.footer');

  let i = 0;
  $$('[data-split]').forEach((el) => { i = splitWords(el, i); });
  splitChars($('[data-split-footer]'));
  requestAnimationFrame(() => document.body.classList.add('is-loaded'));

  setupDrawer();
  setupOrder();

  catalog = await loadProducts();
  catalog.products.forEach((p) => byId.set(p.id, p));
  cart.load();
  await buildSlides();
  renderCart();

  measure();
  addEventListener('resize', () => { measure(); wake(); }, { passive: true });
  addEventListener('scroll', wake, { passive: true });
  document.fonts?.ready.then(() => { measure(); wake(); });

  // Tab по скрытому за краем слайду: прокручиваем страницу так, чтобы он встал в центр
  S.rail.addEventListener('focusin', (e) => {
    const i = S.slides.indexOf(e.target.closest('.slide'));
    if (i < 0 || i === S.idx || S.slides.length < 2) return;
    scrollTo({ top: S.trackTop + S.trackLen * (i / (S.slides.length - 1)), behavior: reduced.matches ? 'auto' : 'smooth' });
  });

  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (e.target.classList.contains('hero')) S.heroVisible = e.isIntersecting;
      if (e.target === S.track) S.trackVisible = e.isIntersecting;
    }
    wake();
  });
  io.observe($('.hero')); io.observe(S.track);
  document.addEventListener('visibilitychange', wake);

  try {
    S.cloth = await initCloth($('[data-cloth]'), { reducedMotion: reduced.matches });
  } catch (err) {
    console.warn('cloth:', err);
  }
  wake();
}

main();
