#!/usr/bin/env python3
"""Интеграционные тесты fergana-server (только stdlib).

Поднимает bin/fergana-server на свободном порту с временной копией web/,
где data/products.json заменён фикстурой server/fixtures/products.json
(детерминированные цены), и временным orders.jsonl.

  python3 server/test.py           # функциональные тесты
  python3 server/test.py --bench   # + нагрузка через ab (если есть) или свой клиент
"""
import gzip
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BIN = os.path.join(ROOT, "bin", "fergana-server")
FIXTURE = os.path.join(HERE, "fixtures", "products.json")

passed, failed = 0, []


def check(name, cond, info=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed.append(name)
        print(f"  FAIL {name} {info}")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Server:
    def __init__(self, root, orders, port):
        self.args = [BIN, "--port", str(port), "--root", root, "--orders", orders, "--quiet"]
        self.port = port
        self.proc = None

    def __enter__(self):
        self.proc = subprocess.Popen(self.args, stderr=subprocess.PIPE)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                return self
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("сервер не поднялся: " + self.proc.stderr.read().decode())

    def __exit__(self, *a):
        self.proc.terminate()
        self.proc.wait()


def req(port, method, path, body=None, headers=None, conn=None):
    c = conn or http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = dict(headers or {})
    if isinstance(body, (dict, list)):
        body = json.dumps(body, ensure_ascii=False).encode()
        h.setdefault("Content-Type", "application/json")
    elif isinstance(body, str):
        body = body.encode()
    c.request(method, path, body=body, headers=h)
    r = c.getresponse()
    data = r.read()
    if conn is None:
        c.close()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, data


def raw(port, data, read_all=True):
    """Сырой запрос (клиенты нормализуют ../, а нам нужно проверить сервер)."""
    s = socket.create_connection(("127.0.0.1", port), timeout=3)
    s.sendall(data)
    out = b""
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            out += chunk
            if not read_all:
                break
    except socket.timeout:
        pass
    s.close()
    return out


def status_of(resp):
    m = re.match(rb"HTTP/1\.1 (\d{3})", resp)
    return int(m.group(1)) if m else None


def order(port, **kw):
    body = {"items": [{"id": "atlas-chapan", "size": "M", "qty": 1}], "name": "Азиз", "phone": "+998 90 123 45 67",
            "note": ""}
    body.update(kw)
    st, h, data = req(port, "POST", "/api/order", body)
    try:
        return st, json.loads(data)
    except ValueError:
        return st, {"raw": data}


def run_tests(port, root, orders):
    web = os.path.join(ROOT, "web")
    fixture = json.load(open(FIXTURE, encoding="utf-8"))

    print("health / api")
    st, h, d = req(port, "GET", "/api/health")
    check("GET /api/health 200", st == 200 and json.loads(d) == {"ok": True}, (st, d))
    check("health Content-Type json", h.get("content-type", "").startswith("application/json"))
    st, h, d = req(port, "GET", "/api/products")
    check("GET /api/products 200 = products.json", st == 200 and json.loads(d) == fixture, st)
    check("products no-cache + ETag", h.get("cache-control") == "no-cache" and "etag" in h, h)
    st, _, d = req(port, "GET", "/api/nope")
    check("GET /api/nope 404 json", st == 404 and json.loads(d)["ok"] is False)
    st, h, _ = req(port, "GET", "/api/order")
    check("GET /api/order 405 + Allow", st == 405 and h.get("allow") == "POST")

    print("статика, MIME, кеш")
    st, h, d = req(port, "GET", "/")
    index = open(os.path.join(root, "index.html"), "rb").read()
    check("GET / -> index.html", st == 200 and d == index, st)
    check("html MIME", h.get("content-type") == "text/html; charset=utf-8", h.get("content-type"))
    check("html Cache-Control no-cache", h.get("cache-control") == "no-cache")
    check("Vary: Accept-Encoding", h.get("vary") == "Accept-Encoding")
    etag = h.get("etag")
    st, h, d = req(port, "GET", "/", headers={"If-None-Match": etag})
    check("If-None-Match -> 304 без тела", st == 304 and d == b"", (st, len(d)))
    st, _, _ = req(port, "GET", "/", headers={"If-None-Match": 'W/"nope", ' + etag})
    check("If-None-Match список + W/ -> 304", st == 304)
    st, _, _ = req(port, "GET", "/", headers={"If-None-Match": '"other"'})
    check("чужой ETag -> 200", st == 200)

    mimes = {".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
             ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
             ".bin": "application/octet-stream", ".woff2": "font/woff2"}
    seen = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            ext = os.path.splitext(f)[1]
            if ext in mimes and ext not in seen:
                seen[ext] = "/" + os.path.relpath(os.path.join(dp, f), root)
    with open(os.path.join(root, "assets", "probe.woff2"), "wb") as f:
        f.write(b"wOF2" + b"\0" * 60)
    seen[".woff2"] = "/assets/probe.woff2"
    for ext, path in sorted(seen.items()):
        st, h, _ = req(port, "GET", path)
        check(f"MIME {ext} ({path})", st == 200 and h.get("content-type") == mimes[ext], (st, h.get("content-type")))
    st, h, d = req(port, "GET", "/assets/cloth.bin")
    check("assets/ immutable", h.get("cache-control") == "public, max-age=31536000, immutable", h.get("cache-control"))
    check("cloth.bin заголовок CFCL", d[:4] == b"CFCL")
    st, h, _ = req(port, "GET", "/css/app.css")
    check("css вне assets/ -> no-cache", h.get("cache-control") == "no-cache")

    st, h, d = req(port, "HEAD", "/")
    check("HEAD: длина есть, тела нет", st == 200 and d == b"" and int(h["content-length"]) == len(index))
    st, h, _ = req(port, "GET", "/css")
    check("/css -> 301 /css/", st == 301 and h.get("location") == "/css/", (st, h.get("location")))
    st, _, _ = req(port, "GET", "/nope.html")
    check("404 на несуществующий", st == 404)
    st, _, _ = req(port, "POST", "/index.html", b"x")
    check("POST на статику -> 405", st == 405)
    st, _, _ = req(port, "GET", "/index.html?v=1#x")
    check("query-строка игнорируется", st == 200)

    print("gzip")
    gz_path = os.path.join(root, "js", "app.js.gz")
    target = "/js/app.js" if os.path.exists(gz_path) else "/index.html"
    plain = open(os.path.join(root, target.lstrip("/")), "rb").read()
    st, h, d = req(port, "GET", target, headers={"Accept-Encoding": "gzip, deflate, br"})
    check(f"{target} gzip отдан", st == 200 and h.get("content-encoding") == "gzip", h.get("content-encoding"))
    check("gzip распаковывается в оригинал", st == 200 and gzip.decompress(d) == plain)
    gz_etag = h.get("etag")
    st, h, d = req(port, "GET", target)
    check("без Accept-Encoding — без сжатия", st == 200 and "content-encoding" not in h and d == plain)
    check("ETag gzip ≠ ETag identity", gz_etag != h.get("etag"))
    st, _, _ = req(port, "GET", target, headers={"Accept-Encoding": "gzip", "If-None-Match": gz_etag})
    check("304 для gzip-варианта", st == 304)
    st, h, _ = req(port, "GET", target, headers={"Accept-Encoding": "gzip;q=0, identity"})
    check("gzip;q=0 уважается", "content-encoding" not in h)
    # устаревший .gz (оригинал новее) не отдаём
    src = os.path.join(root, "css", "app.css")
    if os.path.exists(src + ".gz"):
        os.utime(src, (time.time() + 5, time.time() + 5))
        st, h, _ = req(port, "GET", "/css/app.css", headers={"Accept-Encoding": "gzip"})
        check("устаревший .gz игнорируется", "content-encoding" not in h)

    print("path traversal")
    for path, ok in [("/../CONTRACTS.md", (403, 404)), ("/%2e%2e/CONTRACTS.md", (403, 404)),
                     ("/css/..%2f..%2fCONTRACTS.md", (403, 404)), ("/css/%2e%2e/%2e%2e/Makefile", (403, 404)),
                     ("/..%5c..%5cMakefile", (400, 403, 404)), ("/.secret", (404,)), ("/index.html%00.js", (400,)),
                     ("/%zz", (400,)), ("/escape/passwd", (403,))]:
        r = raw(port, f"GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".encode())
        st = status_of(r)
        check(f"{path} -> {st}", st in ok and b"root:" not in r and b"## " not in r, r[:80])

    print("заказы")
    st, j = order(port)
    check("валидный заказ 200", st == 200 and j.get("ok") is True, j)
    today = time.strftime("%Y%m%d")
    check("order_id CF-YYYYMMDD-NNNN", re.fullmatch(rf"CF-{today}-\d{{4}}", j.get("order_id", "")), j.get("order_id"))
    first_id = j.get("order_id", "")
    check("total = цена из каталога", j.get("total") == 2450000, j.get("total"))
    tg = j.get("telegram_url", "")
    check("telegram_url на @shxawenya", tg.startswith("https://t.me/shxawenya?text="), tg[:40])
    text = urllib.parse.unquote(tg.split("text=", 1)[-1])
    check("текст заказа по-русски", first_id in text and "Чапан «Атлас»" in text and "Итого: 2 450 000 сум" in text,
          text)
    check("в URL нет сырых пробелов/кириллицы", re.fullmatch(r"[A-Za-z0-9%._~\-]*", tg.split("text=", 1)[-1]) is not None)

    st, j = order(port, items=[{"id": "atlas-chapan", "size": "L", "qty": 2, "price": 1},
                               {"id": "adras-shirt", "size": "S", "qty": 3}], note="позвоните\nвечером")
    check("сумма считается сервером, price клиента игнор", st == 200 and j.get("total") == 2 * 2450000 + 3 * 890000, j)
    second = j.get("order_id", "")
    check("номер заказа растёт", second[-4:] == f"{int(first_id[-4:] or 0) + 1:04d}", (first_id, second))
    lines = open(orders, encoding="utf-8").read().splitlines()
    rec = json.loads(lines[-1]) if lines else {}
    check("orders.jsonl дописан", len(lines) == 2 and rec.get("order_id") == second and rec.get("total") == j.get("total"))
    check("orders.jsonl хранит позиции", [i["qty"] for i in rec.get("items", [])] == [2, 3])

    long_name = "Ж" * 100
    st, _ = order(port, name=long_name)
    check("имя 100 кириллических символов — ок", st == 200)
    bad = [
        ("битый JSON", None, b"{items:"),
        ("не объект", None, b"[1,2]"),
        ("пустая корзина", {"items": []}, None),
        ("нет items", {"items": None}, None),
        ("неизвестный товар", {"items": [{"id": "nope", "size": "M", "qty": 1}]}, None),
        ("неверный размер", {"items": [{"id": "atlas-chapan", "size": "XXL", "qty": 1}]}, None),
        ("qty 0", {"items": [{"id": "atlas-chapan", "size": "M", "qty": 0}]}, None),
        ("qty 11", {"items": [{"id": "atlas-chapan", "size": "M", "qty": 11}]}, None),
        ("qty 1.5", {"items": [{"id": "atlas-chapan", "size": "M", "qty": 1.5}]}, None),
        ("qty строкой", {"items": [{"id": "atlas-chapan", "size": "M", "qty": "2"}]}, None),
        ("qty -1", {"items": [{"id": "atlas-chapan", "size": "M", "qty": -1}]}, None),
        ("пустое имя", {"name": "   "}, None),
        ("имя 101 символ", {"name": "Ж" * 101}, None),
        ("нет телефона", {"phone": None}, None),
        ("телефон 101 символ", {"phone": "1" * 101}, None),
        ("телефон числом", {"phone": 998901234567}, None),
        ("управляющий символ в имени", {"name": "A\u0007"}, None),
        ("51 позиция", {"items": [{"id": "atlas-chapan", "size": "M", "qty": 1}] * 51}, None),
        ("одинокий суррогат", None, b'{"items":[{"id":"atlas-chapan","size":"M","qty":1}],"name":"\\ud800","phone":"1"}'),
        ("битый UTF-8", None, b'{"items":[{"id":"atlas-chapan","size":"M","qty":1}],"name":"\xff","phone":"1"}'),
        ("лишнее после JSON", None, b'{"items":[]} x'),
    ]
    for name, patch, rawbody in bad:
        if rawbody is not None:
            st, h, d = req(port, "POST", "/api/order", rawbody, {"Content-Type": "application/json"})
            try:
                j = json.loads(d)
            except ValueError:
                j = {}
        else:
            st, j = order(port, **patch)
        check(f"400: {name} — «{j.get('error')}»", st == 400 and j.get("ok") is False and j.get("error"), (st, j))
    deep = b'{"a":' * 100 + b"1" + b"}" * 100
    st, _, _ = req(port, "POST", "/api/order", deep, {"Content-Type": "application/json"})
    check("глубина JSON ограничена -> 400", st == 400)
    big = json.dumps({"items": [], "name": "x" * 17000}).encode()
    st, _, d = req(port, "POST", "/api/order", big, {"Content-Type": "application/json"})
    check("тело > 16 КБ -> 413", st == 413, st)
    st, _, _ = req(port, "POST", "/api/order", b"{}", {"Content-Type": "application/x-www-form-urlencoded"})
    check("form-urlencoded -> 415", st == 415)
    r = raw(port, b"POST /api/order HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n")
    check("chunked -> 501", status_of(r) == 501)
    r = raw(port, b"POST /api/order HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}")
    check("двойной Content-Length -> 400", status_of(r) == 400)
    r = raw(port, b"GET / HTTP/1.1\r\nX: " + b"a" * 20000 + b"\r\n\r\n")
    check("огромные заголовки -> 431", status_of(r) == 431)
    r = raw(port, b"garbage\r\n\r\n")
    check("мусор вместо запроса -> 400", status_of(r) == 400)
    st, _, _ = req(port, "POST", "/api/order", json.dumps({"items": [{"id": "atlas-chapan", "size": "M", "qty": 1}],
                                                            "name": "Тест", "phone": "1", "note": "п" * 400}),
                   {"Content-Type": "application/json", "Expect": "100-continue"})
    check("Expect: 100-continue", st == 200)

    print("соединения")
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    sts = [req(port, "GET", "/api/health", conn=c)[0] for _ in range(20)]
    sock_reused = c.sock is not None
    c.close()
    check("keep-alive: 20 запросов в одном соединении", sts == [200] * 20 and sock_reused)
    r = raw(port, b"GET /api/health HTTP/1.1\r\nHost: x\r\n\r\nGET /api/health HTTP/1.1\r\nHost: x\r\n"
                  b"Connection: close\r\n\r\n")
    check("pipelining: 2 ответа", r.count(b"HTTP/1.1 200") == 2)
    r = raw(port, b"GET /api/health HTTP/1.0\r\n\r\n")
    check("HTTP/1.0 без keep-alive закрывается", b"Connection: close" in r)

    # параллельные заказы — уникальные номера без дыр
    ids, lock = [], threading.Lock()

    def worker():
        for _ in range(10):
            st, j = order(port)
            with lock:
                ids.append(j.get("order_id"))

    ts = [threading.Thread(target=worker) for _ in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    nums = sorted(int(i[-4:]) for i in ids if i)
    check("80 параллельных заказов: номера уникальны и подряд",
          len(set(ids)) == 80 and nums == list(range(nums[0], nums[0] + 80)), nums[:3])
    lines = open(orders, encoding="utf-8").read().splitlines()
    check("orders.jsonl: каждая строка — валидный JSON", all(json.loads(l) for l in lines))
    return ids


def bench(port):
    print("нагрузка")
    out = []
    ab = shutil.which("ab")
    body = os.path.join(tempfile.gettempdir(), "fergana-order.json")
    with open(body, "w") as f:
        json.dump({"items": [{"id": "atlas-chapan", "size": "M", "qty": 1}], "name": "Bench", "phone": "1"}, f)
    if ab:
        cases = [
            ("GET /api/health keep-alive", ["-k", "-n", "50000", "-c", "50"], "/api/health"),
            ("GET / keep-alive", ["-k", "-n", "50000", "-c", "50"], "/"),
            ("GET /assets/cloth.bin gzip keep-alive", ["-k", "-n", "5000", "-c", "20", "-H", "Accept-Encoding: gzip"],
             "/assets/cloth.bin"),
            ("GET /js/app.js gzip, без keep-alive", ["-n", "10000", "-c", "50", "-H", "Accept-Encoding: gzip"],
             "/js/app.js"),
            ("POST /api/order keep-alive", ["-k", "-n", "5000", "-c", "20", "-p", body, "-T", "application/json"],
             "/api/order"),
        ]
        for name, args, path in cases:
            r = subprocess.run(["ab", "-q"] + args + [f"http://127.0.0.1:{port}{path}"], capture_output=True, text=True)
            rps = re.search(r"Requests per second:\s+([\d.]+)", r.stdout)
            fail = re.search(r"Failed requests:\s+(\d+)", r.stdout)
            non2xx = re.search(r"Non-2xx responses:\s+(\d+)", r.stdout)
            p99 = re.search(r"\s99%\s+(\d+)", r.stdout)
            line = (f"{name}: {rps.group(1) if rps else '?'} req/s, failed {fail.group(1) if fail else '?'}, "
                    f"non-2xx {non2xx.group(1) if non2xx else 0}, p99 {p99.group(1) if p99 else '?'} ms")
            print("  " + line)
            out.append(line)
    else:
        n, conc = 20000, 32
        done = [0]
        lock = threading.Lock()

        def w():
            c = http.client.HTTPConnection("127.0.0.1", port)
            for _ in range(n // conc):
                c.request("GET", "/api/health")
                c.getresponse().read()
                with lock:
                    done[0] += 1

        t0 = time.time()
        ts = [threading.Thread(target=w) for _ in range(conc)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        line = f"GET /api/health (python, {conc} потоков): {done[0] / (time.time() - t0):.0f} req/s"
        print("  " + line)
        out.append(line)
    return out


def main():
    if not os.path.exists(BIN):
        sys.exit("нет bin/fergana-server — сначала make")
    tmp = tempfile.mkdtemp(prefix="fergana-test-")
    try:
        root = os.path.join(tmp, "web")
        shutil.copytree(os.path.join(ROOT, "web"), root, ignore=shutil.ignore_patterns(".*"))
        os.makedirs(os.path.join(root, "data"), exist_ok=True)
        shutil.copy(FIXTURE, os.path.join(root, "data", "products.json"))
        for stale in (os.path.join(root, "data", "products.json.gz"),):
            if os.path.exists(stale):
                os.remove(stale)
        os.makedirs(os.path.join(root, "assets"), exist_ok=True)
        os.makedirs(os.path.join(root, "escape"), exist_ok=True)
        os.symlink("/etc/passwd", os.path.join(root, "escape", "passwd"))
        with open(os.path.join(root, ".secret"), "w") as f:
            f.write("secret")
        if not os.path.exists(os.path.join(root, "index.html")):
            with open(os.path.join(root, "index.html"), "w") as f:
                f.write("<!doctype html><title>test</title>" + "x" * 2000)
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build.py"), "--root", root],
                       check=True, capture_output=True)
        orders = os.path.join(tmp, "orders.jsonl")
        port = free_port()
        with Server(root, orders, port):
            run_tests(port, root, orders)
        # рестарт: нумерация продолжается с последнего номера за сегодня
        last = json.loads(open(orders, encoding="utf-8").read().splitlines()[-1])["order_id"]
        port = free_port()
        with Server(root, orders, port):
            st, j = order(port)
            check("после рестарта номер продолжается", j.get("order_id", "")[-4:] == f"{int(last[-4:]) + 1:04d}",
                  (last, j.get("order_id")))
            if "--bench" in sys.argv:
                lines = bench(port)
                with open(os.path.join(HERE, "BENCH.md"), "w", encoding="utf-8") as f:
                    f.write(f"# fergana-server — нагрузка ({time.strftime('%Y-%m-%d %H:%M')})\n\n")
                    f.write("macOS, localhost, `make bench` (ab, пул 64 потока)\n\n")
                    f.writelines(f"- {l}\n" for l in lines)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{passed} ok, {len(failed)} fail")
    if failed:
        print("провалены:", *failed, sep="\n  ")
        sys.exit(1)


if __name__ == "__main__":
    main()
