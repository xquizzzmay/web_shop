import { boot, $, $$, esc, money, href, card, CATS, things, bindSearch, reveal } from './core.js';

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const db = await boot();
const all = db.products;
const brands = [...new Set(all.map((p) => p.brand))];

// бренд в заголовке меняется
const rot = $('[data-rot]');
const rotNames = ['Moncler', 'Gucci', 'Nike', 'Balenciaga', 'Stüssy', 'Prada', 'Jordan'];
rot.innerHTML = rotNames.map((n, i) => `<span class="${i ? '' : 'is-on'}">${n}</span>`).join('');
$('[data-brand-more]').textContent = brands.length - 5;
if (!still) {
  let i = 0;
  const words = $$('span', rot);
  setInterval(() => {
    if (document.hidden) return;
    const cur = words[i];
    i = (i + 1) % words.length;
    cur.classList.replace('is-on', 'is-off');
    words[i].classList.remove('is-off');
    void words[i].offsetWidth;
    words[i].classList.add('is-on');
    setTimeout(() => cur.classList.remove('is-off'), 750);
  }, 2400);
}

// поиск на главной
bindSearch($('[data-home-q]'), $('[data-home-res]'));

// колода новинок
const deck = $('[data-deck]');
const DECK = ['jordan-air-jordan-1-high-chicago', 'gucci-dublenka-s-mehom', 'stussy-futbolka-8-ball', 'moncler-puhovik-maya', 'nike-dunk-low-panda', 'balenciaga-dzhinsy-baggy'];
const picks = DECK.map((id) => db.byId.get(id)).filter(Boolean);
deck.innerHTML = picks.map((p, i) => `<a href="${href(p)}" data-pos="${i < 3 ? i : 2}" ${i > 2 ? 'style="opacity:0"' : ''} ${i ? 'tabindex="-1" aria-hidden="true"' : ''}>
  <img class="deck__img" src="${esc(p.model || p.photo)}" alt="" ${i ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async">
  <div class="deck__top"><span class="deck__brand">${esc(p.brand)}</span></div>
  <div class="deck__bottom"><span class="deck__title">${esc(p.title)}</span><span class="mono">${money(p.price)}</span></div>
</a>`).join('') + `<div class="deck__dots" aria-hidden="true">${picks.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>`;
if (!still) {
  const cards = $$('a', deck);
  const dots = $$('.deck__dots i', deck);
  let top = 0;
  let paused = false;
  deck.addEventListener('pointerenter', () => (paused = true));
  deck.addEventListener('pointerleave', () => (paused = false));
  setInterval(() => {
    if (paused || document.hidden) return;
    const out = cards[top];
    out.dataset.pos = 'out';
    top = (top + 1) % cards.length;
    cards.forEach((c, k) => {
      if (c === out) return;
      const pos = (k - top + cards.length) % cards.length;
      c.dataset.pos = Math.min(pos, 2);
      c.style.opacity = pos > 2 ? 0 : '';
      c.tabIndex = pos ? -1 : 0;
      c.toggleAttribute('aria-hidden', pos !== 0);
    });
    dots.forEach((d, k) => d.classList.toggle('on', k === top));
    setTimeout(() => { out.style.transition = 'none'; out.dataset.pos = 2; out.style.opacity = 0; void out.offsetWidth; out.style.transition = ''; }, 700);
  }, 3200);
}

// бегущая строка брендов
const row = brands.map((b) => `<a href="catalog.html?brand=${encodeURIComponent(b)}">${esc(b)}</a>`).join('');
$('[data-marquee]').innerHTML = row + row.replace(/<a /g, '<a aria-hidden="true" tabindex="-1" ');

// разделы
const CAT_COVER = { top: 'gucci-dublenka-s-mehom', bottom: 'gucci-dzhinsy-s-vyshivkoy', shoes: 'jordan-air-jordan-1-high-chicago', acc: 'gucci-sumka-gg-marmont' };
const arrow = '<svg class="ico cat__arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
$('[data-cats]').innerHTML = Object.entries(CATS).map(([k, label], i) => {
  const items = all.filter((p) => p.category === k);
  const cover = db.byId.get(CAT_COVER[k]);
  return `<a class="cat" href="catalog.html?cat=${k}" data-reveal style="--i:${i}">
    ${cover ? `<img class="cat__img" src="${esc(k === 'acc' || k === 'shoes' ? cover.photo : cover.model || cover.photo)}" alt="" loading="lazy" decoding="async">` : ''}
    <div><h3>${label}</h3><p>${things(items.length)}</p></div>${arrow}
  </a>`;
}).join('');

// новое
$('[data-new]').innerHTML = all.filter((p) => p.new).slice(0, 10).map(card).join('');
reveal();
