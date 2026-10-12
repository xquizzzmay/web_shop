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

## Дизайн-система (Hallmark, custom)
- Тон: люкс, тёмный. Макроструктура: Feature Stack + горизонтальный пин-трек. Nav N5 (floating pill), Footer Ft5 (statement).
- Цвета ТОЛЬКО токенами из `tokens.css` (OKLCH):
  `--color-paper` oklch(14% 0.012 40) тёплый чёрный · `--color-paper-2` oklch(18% 0.014 40) · `--color-paper-3` oklch(23% 0.016 40)
  `--color-ink` oklch(94% 0.014 80) кость · `--color-muted` oklch(70% 0.014 70) · `--color-rule` oklch(94% 0.014 80 / 0.12)
  `--color-accent` oklch(62% 0.19 22) гранат · `--color-accent-2` oklch(80% 0.12 80) шафран/золото · `--color-focus` = accent-2
  Ткани: `--silk-1` oklch(58% 0.2 22), `--silk-2` oklch(78% 0.13 80), `--silk-3` oklch(42% 0.12 265), `--silk-4` oklch(55% 0.11 160)
- Шрифты (Google Fonts): `--font-display` "Playfair Display" (кириллица есть; только roman, без italic), `--font-body` "Manrope", `--font-mono` "JetBrains Mono".
- Easing: `--ease-out` cubic-bezier(.16,1,.3,1), `--ease-in` cubic-bezier(.7,0,.84,0), `--ease-in-out` cubic-bezier(.65,0,.35,1).
- Длительности: `--dur-fast` 160ms, `--dur-base` 320ms, `--dur-slow` 900ms. Шаг отступов 4pt: `--space-1..--space-12` (4,8,12,16,24,32,48,64,96,128,160,224 px).
- Анимируем только `transform` и `opacity`. Обязателен `prefers-reduced-motion`.

## 1. Товары — `web/data/products.json` (владелец apple-18)
```json
{ "currency": "UZS", "telegram": "shxawenya",
  "products": [ { "id": "atlas-chapan", "name": "Чапан «Атлас»", "category": "outerwear",
    "price": 2450000, "fabric": "маргиланский атлас, 100% шёлк", "sizes": ["S","M","L","XL"],
    "silk": "--silk-1", "svg": "assets/garments/atlas-chapan.svg", "note": "одна строка о вещи" } ] }
```
- 6 вещей, `id` — латиница-kebab. `price` — целое в сумах (ЗАГЛУШКИ, пользователь заменит).
- `category` ∈ outerwear | shirts | dresses | trousers | accessories.

## 2. SVG одежды — `web/assets/garments/<id>.svg` (владелец apple-18)
- `viewBox="0 0 400 560"`, без width/height, без `<script>`, без внешних ссылок, < 12 КБ каждый.
- Цвет ткани через `fill="currentColor"` (фронт ставит `color: var(--silk-N)`), тени/складки — чёрный/белый с opacity.
- Обязательные группы с id для анимации: `g#body`, `g#sleeve-l`, `g#sleeve-r` (у брюк/шарфа — `g#leg-l`/`g#leg-r` или `g#tail`), `g#hem` (низ, качается).
  Фронт инлайнит SVG и вращает эти группы (`transform-box: fill-box`), так что точка крепления рукава — верх группы.

## 3. Ткань — `web/assets/cloth.bin` (генерирует `sim/` apple-a2)
Little-endian:
```
0  char[4] "CFCL"
4  u16 version = 1
6  u16 cols   (≈ 32)
8  u16 rows   (≈ 20)
10 u16 frames (≈ 120, бесшовная петля)
12 u16 fps    (30; фронт интерполирует до 60+)
14 u16 reserved = 0
16 int16 data[frames][rows][cols][3]   // x,y,z в [-32767..32767] → нормированные координаты [-1..1]; x вправо, y вниз, z к зрителю
```
**v2** (version = 2): тот же заголовок; кадр 0 — абсолютные значения, кадры 1..N-1 — int16-дельты к предыдущему кадру с переполнением по модулю 2^16 (wrap). Фронт понимает v1 и v2.

Полотно висит на верхней кромке (закреплено), ветер периодичный с периодом = длина петли.

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
