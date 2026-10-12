import { boot, $, $$, card, CATS, TYPES, things, search, reveal } from './core.js';

const db = await boot();
const all = db.products;
const order = new Map(all.map((p, i) => [p.id, (p.new ? 0 : 1000) + i]));
const ui = { seg: $('[data-seg]'), ind: $('.seg__ind'), q: $('[data-q]'), brand: $('[data-brand]'), sort: $('[data-sort]'), types: $('[data-types]'), grid: $('[data-grid]') };

const params = new URLSearchParams(location.search);
const st = { cat: params.get('cat') || '', type: params.get('type') || '', brand: params.get('brand') || '', q: params.get('q') || '', sort: params.get('sort') || '' };
if (!CATS[st.cat]) st.cat = '';
if (TYPES[st.type]) st.type = TYPES[st.type];

ui.brand.innerHTML += [...new Set(all.map((p) => p.brand))].sort((a, b) => a.localeCompare(b)).map((b) => `<option>${b}</option>`).join('');
ui.brand.value = st.brand;
ui.q.value = st.q;
ui.sort.value = st.sort;

// тип хранится по подписи: «Кроссовки» объединяет низкие, высокие и массивные
const typeKey = (t) => TYPES[t];

function moveInd(animate) {
  const b = $(`button[data-cat="${st.cat}"]`, ui.seg);
  for (const x of $$('button', ui.seg)) x.setAttribute('aria-selected', x === b);
  if (!animate) ui.ind.style.transition = 'none';
  ui.ind.style.transform = `translateX(${b.offsetLeft}px) scaleX(${b.offsetWidth / 100})`;
  if (!animate) { void ui.ind.offsetWidth; ui.ind.style.transition = ''; }
}

function list() {
  let r = all.filter((p) => (!st.cat || p.category === st.cat) && (!st.brand || p.brand === st.brand));
  const inCat = r;
  if (st.type) r = r.filter((p) => typeKey(p.type) === st.type);
  if (st.q) r = search(st.q, r);
  r = [...r].sort(st.sort === 'asc' ? (a, b) => a.price - b.price : st.sort === 'desc' ? (a, b) => b.price - a.price : (a, b) => order.get(a.id) - order.get(b.id));
  return { r, inCat };
}

function paint() {
  const { r, inCat } = list();
  const counts = new Map();
  for (const p of inCat) counts.set(typeKey(p.type), (counts.get(typeKey(p.type)) || 0) + 1);
  ui.types.innerHTML = counts.size > 1
    ? [`<button class="chip" type="button" data-type="" aria-pressed="${!st.type}">Все</button>`, ...[...counts].map(([t, n]) => `<button class="chip" type="button" data-type="${t}" aria-pressed="${st.type === t}">${t}<sup>${n}</sup></button>`)].join('')
    : '';
  ui.grid.innerHTML = r.map(card).join('');
  $('[data-empty]').hidden = r.length > 0;
  $('[data-title]').textContent = st.type || CATS[st.cat] || (st.brand ? st.brand : 'Каталог');
  $('[data-found]').textContent = things(r.length);
  document.title = `${$('[data-title]').textContent} — Claude Fergana`;
  for (const c of $$('.card', ui.grid)) c.classList.add('in');
}

let first = true;
function update({ push = true } = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(st)) if (v) u.set(k, v);
  if (push) history.replaceState(null, '', u.size ? '?' + u : location.pathname);
  moveInd(!first);
  // плавная перестановка карточек (View Transitions), без неё — просто перерисовка
  if (!first && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const before = $$('.card', ui.grid);
    before.forEach((c) => (c.style.viewTransitionName = 'c-' + c.dataset.id));
    const vt = document.startViewTransition(() => {
      paint();
      $$('.card', ui.grid).forEach((c) => (c.style.viewTransitionName = 'c-' + c.dataset.id));
    });
    vt.finished.finally(() => $$('.card', ui.grid).forEach((c) => (c.style.viewTransitionName = '')));
  } else {
    paint();
    if (first) {
      for (const c of $$('.card', ui.grid)) c.classList.remove('in');
      reveal(ui.grid);
    }
  }
  first = false;
}

ui.seg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cat]');
  if (!b || b.dataset.cat === st.cat) return;
  st.cat = b.dataset.cat; st.type = '';
  b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  update();
});
ui.seg.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const bs = $$('button', ui.seg);
  const i = bs.findIndex((b) => b.dataset.cat === st.cat) + (e.key === 'ArrowRight' ? 1 : -1);
  const b = bs[(i + bs.length) % bs.length];
  b.focus(); b.click();
});
ui.types.addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  st.type = b.dataset.type;
  update();
});
ui.brand.addEventListener('change', () => { st.brand = ui.brand.value; st.type = ''; update(); });
ui.sort.addEventListener('change', () => { st.sort = ui.sort.value; update(); });
let qt;
ui.q.addEventListener('input', () => {
  clearTimeout(qt);
  qt = setTimeout(() => { st.q = ui.q.value.trim(); update(); }, 160);
});
$('[data-reset]').addEventListener('click', () => {
  Object.assign(st, { cat: '', type: '', brand: '', q: '', sort: '' });
  ui.q.value = ''; ui.brand.value = ''; ui.sort.value = '';
  update();
});
addEventListener('resize', () => moveInd(false));
document.fonts?.ready.then(() => moveInd(false));

update({ push: false });
