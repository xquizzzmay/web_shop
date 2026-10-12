import { boot, $, esc, money, href, art, cart, toast } from './core.js';

const db = await boot();
const lines = $('[data-lines]');
const form = $('[data-form]');

// убираем то, чего больше нет в каталоге
const known = cart.get().filter((x) => db.byId.has(x.id));
if (known.length !== cart.get().length) cart.set(known);

function paint() {
  const items = cart.get();
  $('[data-empty]').hidden = items.length > 0;
  form.hidden = items.length === 0;
  lines.innerHTML = items.map((x, i) => {
    const p = db.byId.get(x.id);
    return `<li class="line" data-i="${i}">
      <a href="${href(p)}">${art(p)}</a>
      <div><div class="line__brand">${esc(p.brand)}</div><a class="line__title" href="${href(p)}">${esc(p.title)}</a><div class="line__size">Размер ${esc(x.size)}</div></div>
      <div class="line__right">
        <span class="line__price">${money(p.price * x.qty)}</span>
        <div class="qty"><button type="button" data-d="-1" aria-label="Меньше" ${x.qty <= 1 ? 'disabled' : ''}>−</button><output aria-live="polite">${x.qty}</output><button type="button" data-d="1" aria-label="Больше" ${x.qty >= 10 ? 'disabled' : ''}>+</button></div>
        <button type="button" class="rm" data-rm>Убрать</button>
      </div>
    </li>`;
  }).join('');
  $('[data-total]').textContent = money(items.reduce((s, x) => s + db.byId.get(x.id).price * x.qty, 0));
}

lines.addEventListener('click', (e) => {
  const li = e.target.closest('.line');
  if (!li) return;
  const items = cart.get();
  const i = +li.dataset.i;
  const d = e.target.closest('[data-d]');
  if (d) {
    items[i].qty = Math.max(1, Math.min(10, items[i].qty + +d.dataset.d));
    cart.set(items);
    paint();
  } else if (e.target.closest('[data-rm]')) {
    const [gone] = items.splice(i, 1);
    li.classList.add('is-gone');
    setTimeout(() => {
      cart.set(items);
      paint();
      toast(`Убрали из корзины <a href="#" data-undo>Вернуть</a>`);
      $('[data-undo]')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        const now = cart.get();
        now.splice(i, 0, gone);
        cart.set(now);
        paint();
        $('.toast').classList.remove('is-on');
      }, { once: true });
    }, 260);
  }
});

const tgLink = (items, f, id) => {
  const rows = items.map((x) => { const p = db.byId.get(x.id); return `• ${p.name}, размер ${x.size} × ${x.qty} — ${money(p.price * x.qty)}`; });
  const total = items.reduce((s, x) => s + db.byId.get(x.id).price * x.qty, 0);
  const text = [`Заказ${id ? ' ' + id : ''}`, ...rows, `Итого: ${money(total)}`, `Имя: ${f.name}`, `Телефон: ${f.phone}`, f.note && `Комментарий: ${f.note}`].filter(Boolean).join('\n');
  return `https://t.me/${db.telegram}?text=${encodeURIComponent(text)}`;
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = { name: form.name.value.trim(), phone: form.phone.value.trim(), note: form.note.value.trim() };
  let bad = false;
  for (const [k, msg] of [['name', 'Как к тебе обращаться?'], ['phone', 'Нужен номер, чтобы связаться']]) {
    const ok = f[k].length > 0;
    form[k].closest('.fld').classList.toggle('is-error', !ok);
    $(`[data-err-${k}]`).textContent = ok ? '' : msg;
    if (!ok && !bad) { form[k].focus(); bad = true; }
  }
  if (bad) return;
  const items = cart.get();
  const btn = $('[data-submit]');
  const err = $('[data-err]');
  err.textContent = '';
  btn.dataset.state = 'loading';
  btn.textContent = 'Отправляем…';
  // окно открываем сразу (иначе браузер заблокирует), адрес подставим после ответа сервера
  const win = window.open('', '_blank');
  let url = tgLink(items, f);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, ...f }), signal: ctl.signal });
    clearTimeout(timer);
    const j = await r.json().catch(() => null);
    if (j && j.ok) url = j.telegram_url;
    else if (j && j.error && r.status === 400) throw new Error(j.error);
  } catch (ex) {
    if (ex.name !== 'AbortError' && !(ex instanceof TypeError)) {
      win?.close();
      err.textContent = ex.message;
      delete btn.dataset.state;
      btn.textContent = 'Оформить в Telegram';
      return;
    }
  }
  // сервера нет (GitHub Pages) — ссылка собрана на клиенте
  if (win) win.location = url; else location.href = url;
  cart.set([]);
  paint();
  btn.dataset.state = 'success';
  btn.textContent = 'Готово ✓';
  toast(`Заказ открыт в Telegram — нажми «Отправить» <a href="${url}" target="_blank" rel="noopener">Открыть ещё раз</a>`);
});

paint();
