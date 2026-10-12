# fergana-server — нагрузка (2026-10-12 09:04)

macOS, localhost, `make bench` (ab, пул 64 потока)

- GET /api/health keep-alive: 26518.16 req/s, failed 0, non-2xx 0, p99 10 ms
- GET / keep-alive: 20464.96 req/s, failed 0, non-2xx 0, p99 12 ms
- GET /assets/cloth.bin gzip keep-alive: 5696.17 req/s, failed 0, non-2xx 0, p99 10 ms
- GET /js/app.js gzip, без keep-alive: 5583.11 req/s, failed 0, non-2xx 0, p99 22 ms
- POST /api/order keep-alive: 4680.61 req/s, failed 0, non-2xx 0, p99 12 ms
