# Claude Fergana — контракты между терминалами

Люкс-магазин одежды (тёмный), заказ через Telegram **@shxawenya**.
Идея бренда: Фергана → маргиланский шёлк, атлас/адрас, икат. Одежда не фото, а
нарисованные SVG + шёлковое полотно, которое «дышит» (физика ткани посчитана на C).

Менять этот файл можно только с записью в «Журнал» внизу.

## Кто что делает

| Терминал | Роль | Языки | Папки (только свои!) |
|---|---|---|---|
| **apple-54** | Front + координатор | HTML, CSS, JS | `web/index.html`, `web/css/app.css`, `web/js/*` |
| **apple-a2** | Back + производительность | **C++17, C99**, Python, Make | `server/`, `sim/`, `tools/`, `Makefile`, `web/assets/cloth.bin` |
| **apple-18** | Дизайн | SVG, CSS, JSON | `web/css/tokens.css`, `web/css/design.css`, `web/assets/garments/*.svg`, `web/assets/patterns.svg`, `web/data/products.json` |

Чужие файлы не править — пиши владельцу через SendMessage. Статус — в `.team/<имя>.md`.

## Дизайн-система (с 2026-10-12, редизайн v2)
- Мультибрендовый магазин (Moncler, Gucci, Nike, Balenciaga, Stüssy, Prada…), светлый, стритвир-люкс.
- 4 страницы: `index.html` (hero + поиск + разделы + новое), `catalog.html` (?cat=top|bottom|shoes|acc &type= &brand= &q= &sort=asc|desc), `product.html?id=`, `cart.html`.
- Токены в `web/css/tokens.css` (OKLCH, `--g-*` — цвета вещей), стили в `web/css/site.css`. Шрифты: Unbounded / Manrope / JetBrains Mono.
- JS: `web/js/core.js` (данные, поиск, корзина `cf-cart-v2`, тосты) + по файлу на страницу. Без WebGL и библиотек.
- Анимируем только `transform`/`opacity`, переходы между страницами — View Transitions. Обязателен `prefers-reduced-motion`.

## 1. Товары — `web/data/products.json`
```json
{ "currency": "UZS", "telegram": "shxawenya",
  "products": [ { "id": "moncler-puhovik-maya", "brand": "Moncler", "title": "Пуховик Maya",
    "name": "Moncler — Пуховик Maya", "category": "top", "type": "puffer", "price": 14900000,
    "sizes": ["S","M","L","XL","XXL"], "color": "black", "color2": "black", "new": true,
    "photo": "assets/photos/moncler-puhovik-maya.webp", "model": "assets/photos/moncler-puhovik-maya-m.webp" } ] }
```
- `category` ∈ top | bottom | shoes | acc. `type` = id силуэта в `assets/items.svg`:
  puffer sheepskin jacket bomber shirt tee hoodie · jeans pants joggers shorts · sneakers hightop chunky loafers boots · cap bag belt.
- `color`/`color2` — имя токена `--g-<имя>`. `photo` — фото вещи, `model` — на модели (показывается при наведении и в галерее товара); без `photo` рисуется силуэт. Фото 720×900 WebP с Unsplash (лицензия Unsplash, коммерческое использование разрешено); `src`/`src_m` — id исходника на Unsplash.
- `price` — целое в сумах (ЗАГЛУШКИ). Сервер читает только id, name, price, sizes.

## 2. Силуэты — `web/assets/items.svg`
Спрайт `<symbol id="<type>" viewBox="0 0 200 200">`, основной цвет `currentColor`, второй — CSS-переменная `--c2`. Классы внутри с префиксом `z`. Вставляется в страницу целиком (core.js).

## 3. Ткань (`sim/`, cloth.bin) — больше не используется сайтом, из `make all` убрана.

## 4. HTTP API — сервер на C++ (владелец apple-a2), порт по умолчанию **8090**
- `GET /*` — статика из `web/`. Если есть `файл.gz` и клиент шлёт `Accept-Encoding: gzip` — отдать его. `ETag` + `304`, `Cache-Control: public, max-age=31536000, immutable` для `assets/`, `no-cache` для html/json.
- `GET /api/products` → содержимое `web/data/products.json`.
- `POST /api/order` тело `{ "items":[{"id":"atlas-chapan","size":"M","qty":1}], "name":"", "phone":"", "note":"" }`
  → `200 { "ok":true, "order_id":"CF-20261012-0001", "total":2450000, "telegram_url":"https://t.me/shxawenya?text=..." }`
  → `400 { "ok":false, "error":"текст по-русски" }` при неверных данных. Цены считает сервер по products.json, клиенту не верим.
  Заказы дописываются в `server/orders.jsonl`.
- `GET /api/health` → `{ "ok":true }`.
- Фронт обязан работать и БЕЗ сервера (GitHub Pages): тогда сам читает products.json и строит ссылку t.me.

## 5. Сборка
`make` в корне: собирает `sim` → `cloth.bin`, `server` → `bin/fergana-server`, `python3 tools/build.py` (gzip-предсжатие web/). `make run` — сервер на 8090.

## Журнал
- 2026-10-12 apple-54: создан контракт.
- 2026-10-12 apple-54: шрифт Bodoni Moda → Playfair Display (у Bodoni нет кириллицы); cloth.bin хранит x,y,z (3 int16 на точку) — для честного освещения шёлка в WebGL.
- 2026-10-12 apple-54: добавлен cloth.bin v2 (дельты между кадрами, предложение apple-a2) — меньше в gzip.
- 2026-10-12: редизайн v2 — мультибрендовый магазин на 4 страницы, WebGL-ткань и атлас убраны (лагало). Сайт 118 КБ / 34 КБ gzip.
- 2026-10-12: реальные фото (Unsplash) — вещь + на модели, 99 файлов в web/assets/photos.
