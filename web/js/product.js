import { boot, $, esc, money, tint, pic, card, cart, toast, CATS, TYPES, COLORS, reveal } from './core.js';

const db = await boot();
const p = db.byId.get(new URLSearchParams(location.search).get('id'));

if (!p) {
  $('[data-pdp]').innerHTML = `<div class="empty" style="grid-column:1/-1"><h2>Такой вещи нет</h2><p>Возможно, её уже продали.</p><a class="btn" href="catalog.html">В каталог</a></div>`;
} else {
  document.title = `${p.brand} ${p.title} — Claude Fergana`;
  $('[data-crumbs]').innerHTML = `<a href="catalog.html">Каталог</a><span aria-hidden="true">/</span><a href="catalog.html?cat=${p.category}">${CATS[p.category]}</a><span aria-hidden="true">/</span><a href="catalog.html?cat=${p.category}&type=${encodeURIComponent(TYPES[p.type])}">${TYPES[p.type]}</a>`;
  const artEl = $('[data-art]');
  artEl.setAttribute('style', tint(p));
  artEl.innerHTML = pic(p);

  const one = p.sizes.length === 1;
  const tgText = `Здравствуйте! Хочу заказать: ${p.brand} — ${p.title}. Размер: `;
  $('[data-info]').innerHTML = `
    <a class="pdp__brand" href="catalog.html?brand=${encodeURIComponent(p.brand)}">${esc(p.brand)} <span aria-hidden="true">→</span></a>
    <h1>${esc(p.title)}</h1>
    <p class="pdp__price">${money(p.price)}</p>
    <div class="pdp__label"><span id="sz">Размер</span><span class="muted" data-picked></span></div>
    <fieldset class="sizes" aria-labelledby="sz" data-sizes>
      ${p.sizes.map((s) => `<label><input type="radio" name="size" value="${esc(s)}" ${one ? 'checked' : ''}><span>${esc(s)}</span></label>`).join('')}
    </fieldset>
    <p class="err" data-size-err role="alert"></p>
    <div class="pdp__buy">
      <button class="btn" type="button" data-add>В корзину</button>
      <a class="btn btn--ghost" data-tg href="#" target="_blank" rel="noopener">Спросить в Telegram</a>
    </div>
    <p class="pdp__note">Цена и наличие подтверждаются в Telegram — обычно за пару минут.</p>
    <dl class="specs">
      <div><dt>Бренд</dt><dd>${esc(p.brand)}</dd></div>
      <div><dt>Раздел</dt><dd>${CATS[p.category]} · ${TYPES[p.type]}</dd></div>
      <div><dt>Цвет</dt><dd><span class="swatch" style="color:var(--g-${p.color})"></span>${COLORS[p.color] || p.color}</dd></div>
      <div><dt>Артикул</dt><dd class="mono">${esc(p.id)}</dd></div>
    </dl>`;

  const sizes = $('[data-sizes]');
  const err = $('[data-size-err]');
  const tg = $('[data-tg]');
  const picked = () => $('input:checked', sizes)?.value;
  const syncTg = () => { tg.href = `https://t.me/${db.telegram}?text=${encodeURIComponent(tgText + (picked() || '?'))}`; };
  syncTg();
  sizes.addEventListener('change', () => { err.textContent = ''; sizes.classList.remove('is-error'); $('[data-picked]').textContent = picked(); syncTg(); });

  const add = $('[data-add]');
  let t;
  add.addEventListener('click', () => {
    const s = picked();
    if (!s) {
      err.textContent = 'Выбери размер';
      sizes.classList.add('is-error');
      sizes.classList.remove('shake'); void sizes.offsetWidth; sizes.classList.add('shake');
      $('input', sizes).focus();
      return;
    }
    cart.add(p.id, s);
    add.dataset.state = 'success';
    add.textContent = 'Добавлено ✓';
    clearTimeout(t);
    t = setTimeout(() => { delete add.dataset.state; add.textContent = 'В корзину'; }, 1600);
    toast(`${esc(p.brand)}, размер ${esc(s)} — в корзине <a href="cart.html">Оформить</a>`);
  });

  // лёгкий наклон вещи за курсором
  if (!p.photo && matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches) {
    const svg = $('svg', artEl);
    let raf = 0;
    artEl.addEventListener('pointermove', (e) => {
      const r = artEl.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => (svg.style.transform = `rotateY(${x * 14}deg) rotateX(${-y * 10}deg) scale(1.03)`));
    });
    artEl.addEventListener('pointerleave', () => { cancelAnimationFrame(raf); svg.style.transform = ''; });
  }

  // похожее: тот же тип, потом тот же бренд, потом раздел
  const score = (x) => (x.type === p.type ? 4 : 0) + (x.brand === p.brand ? 2 : 0) + (x.category === p.category ? 1 : 0);
  const more = db.products.filter((x) => x.id !== p.id).sort((a, b) => score(b) - score(a)).slice(0, 5);
  $('[data-more]').innerHTML = more.map(card).join('');
  $('[data-more-link]').href = `catalog.html?cat=${p.category}`;
  $('[data-more-wrap]').hidden = false;
  reveal();
}
