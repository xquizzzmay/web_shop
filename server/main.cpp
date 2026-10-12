// fergana-server — HTTP/1.1 сервер магазина Claude Fergana (CONTRACTS.md §4).
//
// Только POSIX-сокеты и стандартная библиотека C++17.
//  * статика из --root (по умолчанию web/), готовые .gz при Accept-Encoding: gzip,
//    ETag/304, Cache-Control по контракту, keep-alive, защита от path traversal;
//  * GET /api/health, GET /api/products, POST /api/order;
//  * пул потоков фиксированного размера + ограниченная очередь соединений;
//  * файлы кешируются в памяти и перечитываются при изменении mtime/size.
//
// Сборка: clang++ -std=c++17 -O2 -Wall -Wextra -pthread -o bin/fergana-server server/main.cpp
// Запуск: bin/fergana-server [--port 8090] [--root web] [--host 127.0.0.1]
//                            [--orders server/orders.jsonl] [--threads 64] [--quiet]

#include "json.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <climits>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <deque>
#include <fstream>
#include <mutex>
#include <sstream>
#include <thread>
#include <unordered_map>

namespace {

// ---------------------------------------------------------------- настройки

constexpr size_t kMaxHeader = 16 * 1024;
constexpr size_t kMaxBody = 16 * 1024;
constexpr int kIdleTimeoutSec = 5;
constexpr int kMaxRequestsPerConn = 1000;
constexpr size_t kMaxQueue = 4096;
constexpr size_t kMaxCachedFile = 8 * 1024 * 1024;
constexpr size_t kMaxItems = 50;
constexpr size_t kMaxNameLen = 100;
constexpr size_t kMaxNoteLen = 500;

struct Config {
    int port = 8090;
    std::string host = "127.0.0.1";
    std::string root = "web";
    std::string orders = "server/orders.jsonl";
    int threads = 64;
    bool quiet = false;
} g_cfg;

std::string g_root_real;  // realpath(root), без завершающего '/'
std::mutex g_log_mu;

// ---------------------------------------------------------------- утилиты

std::string lower(std::string s) {
    for (auto &c : s) c = (char)std::tolower((unsigned char)c);
    return s;
}

std::string trim(const std::string &s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\n' || s[a] == '\r')) ++a;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\n' || s[b - 1] == '\r')) --b;
    return s.substr(a, b - a);
}

// число кодовых точек (вход уже проверен парсером JSON на корректность UTF-8)
size_t utf8_len(const std::string &s) {
    size_t n = 0;
    for (unsigned char c : s)
        if ((c & 0xC0) != 0x80) ++n;
    return n;
}

bool has_control(const std::string &s, bool allow_newline) {
    for (unsigned char c : s) {
        if (allow_newline && c == '\n') continue;
        if (c < 0x20 || c == 0x7F) return true;
    }
    return false;
}

std::string url_encode(const std::string &s) {
    static const char *hexd = "0123456789ABCDEF";
    std::string o;
    o.reserve(s.size() * 3);
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o += (char)c;
        else { o += '%'; o += hexd[c >> 4]; o += hexd[c & 15]; }
    }
    return o;
}

// %XX -> байт; false при битой последовательности или %00
bool pct_decode(const std::string &in, std::string &out) {
    out.clear();
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] != '%') { out += in[i]; continue; }
        if (i + 2 >= in.size() || !std::isxdigit((unsigned char)in[i + 1]) || !std::isxdigit((unsigned char)in[i + 2]))
            return false;
        int v = std::stoi(in.substr(i + 1, 2), nullptr, 16);
        if (v == 0) return false;
        out += (char)v;
        i += 2;
    }
    return true;
}

// 2450000 -> "2 450 000"
std::string group_digits(int64_t v) {
    std::string d = std::to_string(v < 0 ? -v : v), o;
    for (size_t i = 0; i < d.size(); ++i) {
        if (i && (d.size() - i) % 3 == 0) o += ' ';
        o += d[i];
    }
    return v < 0 ? "-" + o : o;
}

std::string http_date(time_t t) {
    char buf[64];
    struct tm g;
    gmtime_r(&t, &g);
    strftime(buf, sizeof buf, "%a, %d %b %Y %H:%M:%S GMT", &g);
    return buf;
}

bool read_file(const std::string &path, std::string &out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

// ---------------------------------------------------------------- HTTP

struct Request {
    std::string method, target, path, version;
    std::unordered_map<std::string, std::string> headers;  // имена в нижнем регистре
    std::string body;
    bool keep_alive = true;

    const std::string &header(const std::string &name) const {
        static const std::string empty;
        auto it = headers.find(name);
        return it == headers.end() ? empty : it->second;
    }
};

struct Response {
    int status = 200;
    std::vector<std::pair<std::string, std::string>> headers;
    std::shared_ptr<const std::string> body_ref;  // тело из кеша без копирования
    std::string body;
    bool close = false;
    bool no_body = false;  // 304

    void set(const std::string &k, const std::string &v) { headers.emplace_back(k, v); }
    const std::string &payload() const { return body_ref ? *body_ref : body; }
};

const char *reason(int s) {
    switch (s) {
    case 100: return "Continue";
    case 200: return "OK";
    case 301: return "Moved Permanently";
    case 304: return "Not Modified";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 408: return "Request Timeout";
    case 411: return "Length Required";
    case 413: return "Payload Too Large";
    case 415: return "Unsupported Media Type";
    case 431: return "Request Header Fields Too Large";
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    case 503: return "Service Unavailable";
    case 505: return "HTTP Version Not Supported";
    default: return "Unknown";
    }
}

void json_response(Response &r, int status, const std::string &body) {
    r.status = status;
    r.body = body;
    r.set("Content-Type", "application/json; charset=utf-8");
    r.set("Cache-Control", "no-store");
}

void json_error(Response &r, int status, const std::string &msg) {
    json_response(r, status, "{\"ok\":false,\"error\":" + json::quote(msg) + "}");
}

bool send_all(int fd, const char *p, size_t n) {
    while (n) {
        ssize_t w = ::send(fd, p, n, 0);
        if (w < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        p += w;
        n -= (size_t)w;
    }
    return true;
}

bool send_response(int fd, const Request &req, Response &res, bool keep) {
    const std::string &body = res.payload();
    std::string h;
    h.reserve(512);
    h += "HTTP/1.1 ";
    h += std::to_string(res.status);
    h += ' ';
    h += reason(res.status);
    h += "\r\nServer: fergana\r\nDate: ";
    h += http_date(time(nullptr));
    h += "\r\nX-Content-Type-Options: nosniff\r\n";
    for (auto &kv : res.headers) {
        h += kv.first;
        h += ": ";
        h += kv.second;
        h += "\r\n";
    }
    if (!res.no_body) {
        h += "Content-Length: ";
        h += std::to_string(body.size());
        h += "\r\n";
    }
    h += keep ? "Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\n" : "Connection: close\r\n\r\n";

    bool with_body = !res.no_body && req.method != "HEAD" && !body.empty();
    if (!with_body) return send_all(fd, h.data(), h.size());
    struct iovec iov[2] = {{(void *)h.data(), h.size()}, {(void *)body.data(), body.size()}};
    size_t total = h.size() + body.size(), sent = 0;
    while (sent < total) {
        // writev до первого частичного — дальше досылаем send_all
        ssize_t w = ::writev(fd, iov, 2);
        if (w < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        sent += (size_t)w;
        if (sent >= total) break;
        if (sent < h.size()) {
            return send_all(fd, h.data() + sent, h.size() - sent) && send_all(fd, body.data(), body.size());
        }
        return send_all(fd, body.data() + (sent - h.size()), total - sent);
    }
    return true;
}

// 0 — запрос прочитан; -1 — соединение закрыто/таймаут без данных;
// >0 — HTTP-код ошибки (после неё соединение закрываем).
int read_request(int fd, std::string &buf, Request &req) {
    size_t hdr_end;
    for (;;) {
        hdr_end = buf.find("\r\n\r\n");
        if (hdr_end != std::string::npos) break;
        if (buf.size() > kMaxHeader) return 431;
        char tmp[8192];
        ssize_t r = ::recv(fd, tmp, sizeof tmp, 0);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) return buf.empty() ? -1 : (r == 0 ? -1 : 408);
        buf.append(tmp, (size_t)r);
    }
    if (hdr_end > kMaxHeader) return 431;

    // стартовая строка
    size_t eol = buf.find("\r\n");
    std::string line = buf.substr(0, eol);
    size_t s1 = line.find(' '), s2 = line.rfind(' ');
    if (s1 == std::string::npos || s2 == s1) return 400;
    req.method = line.substr(0, s1);
    req.target = line.substr(s1 + 1, s2 - s1 - 1);
    req.version = line.substr(s2 + 1);
    if (req.version != "HTTP/1.1" && req.version != "HTTP/1.0") return req.version.rfind("HTTP/", 0) == 0 ? 505 : 400;
    if (req.target.empty() || req.target.find(' ') != std::string::npos) return 400;

    // заголовки
    size_t pos = eol + 2;
    while (pos < hdr_end) {
        size_t e = buf.find("\r\n", pos);
        std::string h = buf.substr(pos, e - pos);
        pos = e + 2;
        size_t colon = h.find(':');
        if (colon == std::string::npos || colon == 0 || h[0] == ' ' || h[0] == '\t') return 400;
        std::string name = lower(h.substr(0, colon));
        std::string val = trim(h.substr(colon + 1));
        auto it = req.headers.find(name);
        if (it == req.headers.end()) req.headers.emplace(name, val);
        else if (name == "content-length") return 400;  // дубликаты Content-Length = smuggling
        else it->second += ", " + val;
    }
    buf.erase(0, hdr_end + 4);

    std::string conn = lower(req.header("connection"));
    req.keep_alive = req.version == "HTTP/1.1" ? conn.find("close") == std::string::npos
                                               : conn.find("keep-alive") != std::string::npos;

    if (!req.header("transfer-encoding").empty()) return 501;  // chunked не поддерживаем
    const std::string &cl = req.header("content-length");
    size_t len = 0;
    if (!cl.empty()) {
        if (cl.size() > 9 || cl.find_first_not_of("0123456789") != std::string::npos) return 400;
        len = (size_t)std::stoul(cl);
    }
    if (len > kMaxBody) return 413;
    if (len && lower(req.header("expect")) == "100-continue" && buf.size() < len) {
        static const char cont[] = "HTTP/1.1 100 Continue\r\n\r\n";
        if (!send_all(fd, cont, sizeof cont - 1)) return -1;
    }
    while (buf.size() < len) {
        char tmp[8192];
        ssize_t r = ::recv(fd, tmp, sizeof tmp, 0);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) return r == 0 ? -1 : 408;
        buf.append(tmp, (size_t)r);
    }
    req.body = buf.substr(0, len);
    buf.erase(0, len);
    return 0;
}

// ---------------------------------------------------------------- статика

struct CachedFile {
    std::shared_ptr<const std::string> data;
    off_t size = 0;
    time_t mtime = 0;
    ino_t ino = 0;
    std::string etag;
};

std::mutex g_cache_mu;
std::unordered_map<std::string, CachedFile> g_cache;

// Файл из кеша; перечитывается, если на диске изменился. false — не читается.
bool load_cached(const std::string &path, const struct stat &st, CachedFile &out, const char *etag_suffix) {
    {
        std::lock_guard<std::mutex> lk(g_cache_mu);
        auto it = g_cache.find(path);
        if (it != g_cache.end() && it->second.size == st.st_size && it->second.mtime == st.st_mtime &&
            it->second.ino == st.st_ino) {
            out = it->second;
            return true;
        }
    }
    auto data = std::make_shared<std::string>();
    if (!read_file(path, *data) || (off_t)data->size() != st.st_size) return false;
    char tag[96];
    snprintf(tag, sizeof tag, "\"%llx-%llx-%llx%s\"", (unsigned long long)st.st_ino, (unsigned long long)st.st_size,
             (unsigned long long)st.st_mtime, etag_suffix);
    CachedFile cf;
    cf.data = data;
    cf.size = st.st_size;
    cf.mtime = st.st_mtime;
    cf.ino = st.st_ino;
    cf.etag = tag;
    if ((size_t)st.st_size <= kMaxCachedFile) {
        std::lock_guard<std::mutex> lk(g_cache_mu);
        g_cache[path] = cf;
    }
    out = cf;
    return true;
}

std::string mime_for(const std::string &path) {
    size_t dot = path.rfind('.');
    std::string ext = dot == std::string::npos ? "" : lower(path.substr(dot + 1));
    static const std::unordered_map<std::string, std::string> m = {
        {"html", "text/html; charset=utf-8"},
        {"css", "text/css; charset=utf-8"},
        {"js", "text/javascript; charset=utf-8"},
        {"mjs", "text/javascript; charset=utf-8"},
        {"json", "application/json; charset=utf-8"},
        {"svg", "image/svg+xml"},
        {"bin", "application/octet-stream"},
        {"woff2", "font/woff2"},
        {"woff", "font/woff"},
        {"png", "image/png"},
        {"jpg", "image/jpeg"},
        {"jpeg", "image/jpeg"},
        {"webp", "image/webp"},
        {"avif", "image/avif"},
        {"ico", "image/x-icon"},
        {"txt", "text/plain; charset=utf-8"},
        {"xml", "application/xml; charset=utf-8"},
        {"webmanifest", "application/manifest+json"},
        {"gz", "application/gzip"},
    };
    auto it = m.find(ext);
    return it == m.end() ? "application/octet-stream" : it->second;
}

bool accepts_gzip(const std::string &ae) {
    // "gzip", "gzip;q=0.5", но не "gzip;q=0"
    std::string s = lower(ae);
    size_t pos = 0;
    while (pos <= s.size()) {
        size_t comma = s.find(',', pos);
        std::string tok = trim(s.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos));
        size_t semi = tok.find(';');
        std::string coding = trim(tok.substr(0, semi));
        if (coding == "gzip" || coding == "*") {
            if (semi == std::string::npos) return true;
            std::string params = tok.substr(semi + 1);
            size_t q = params.find("q=");
            if (q == std::string::npos) return true;
            return std::strtod(params.c_str() + q + 2, nullptr) > 0;
        }
        if (comma == std::string::npos) break;
        pos = comma + 1;
    }
    return false;
}

bool etag_matches(const std::string &inm, const std::string &etag) {
    if (inm.empty()) return false;
    size_t pos = 0;
    while (pos <= inm.size()) {
        size_t comma = inm.find(',', pos);
        std::string tok = trim(inm.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos));
        if (tok == "*") return true;
        if (tok.rfind("W/", 0) == 0) tok = tok.substr(2);
        if (tok == etag) return true;
        if (comma == std::string::npos) break;
        pos = comma + 1;
    }
    return false;
}

// Раскладывает URL-путь в относительный путь внутри root.
// 0 — ок; иначе HTTP-код.
int resolve_path(const std::string &url_path, std::string &rel) {
    std::string dec;
    if (!pct_decode(url_path, dec)) return 400;
    if (dec.empty() || dec[0] != '/' || dec.find('\\') != std::string::npos) return 400;
    rel.clear();
    size_t pos = 1;
    while (pos <= dec.size()) {
        size_t slash = dec.find('/', pos);
        std::string seg = dec.substr(pos, slash == std::string::npos ? std::string::npos : slash - pos);
        if (seg == "..") return 403;
        if (!seg.empty() && seg != ".") {
            if (seg[0] == '.') return 404;  // скрытые файлы не отдаём
            if (!rel.empty()) rel += '/';
            rel += seg;
        }
        if (slash == std::string::npos) break;
        pos = slash + 1;
    }
    return 0;
}

void serve_static(const Request &req, Response &res, const std::string &url_path) {
    if (req.method != "GET" && req.method != "HEAD") {
        json_error(res, 405, "Метод не поддерживается");
        res.set("Allow", "GET, HEAD");
        return;
    }
    std::string rel;
    int rc = resolve_path(url_path, rel);
    if (rc) {
        json_error(res, rc, rc == 403 ? "Доступ запрещён" : rc == 404 ? "Не найдено" : "Некорректный путь");
        return;
    }
    std::string full = g_root_real + "/" + rel;
    struct stat st;
    if (::stat(full.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
        if (!url_path.empty() && url_path.back() != '/') {  // /dir -> /dir/
            res.status = 301;
            res.set("Location", url_path + "/");
            return;
        }
        full += rel.empty() ? "index.html" : "/index.html";
        rel += rel.empty() ? "index.html" : "/index.html";
    }
    // realpath ловит выход за root через симлинки
    char real[PATH_MAX];
    if (!::realpath(full.c_str(), real) || ::stat(real, &st) != 0 || !S_ISREG(st.st_mode)) {
        json_error(res, 404, "Не найдено");
        return;
    }
    std::string realp = real;
    if (realp.compare(0, g_root_real.size() + 1, g_root_real + "/") != 0) {
        json_error(res, 403, "Доступ запрещён");
        return;
    }

    std::string mime = mime_for(rel);
    bool immutable = rel.rfind("assets/", 0) == 0;
    std::string cache_control = immutable ? "public, max-age=31536000, immutable" : "no-cache";

    // предсжатая версия, только если не старее оригинала
    CachedFile cf;
    bool gz = false;
    bool is_gz = rel.size() >= 3 && rel.compare(rel.size() - 3, 3, ".gz") == 0;
    if (!is_gz && accepts_gzip(req.header("accept-encoding"))) {
        struct stat gst;
        std::string gzpath = realp + ".gz";
        if (::stat(gzpath.c_str(), &gst) == 0 && S_ISREG(gst.st_mode) && gst.st_mtime >= st.st_mtime &&
            load_cached(gzpath, gst, cf, "-gz"))
            gz = true;
    }
    if (!gz && !load_cached(realp, st, cf, "")) {
        json_error(res, 500, "Не удалось прочитать файл");
        return;
    }

    res.set("Content-Type", mime);
    res.set("Cache-Control", cache_control);
    res.set("ETag", cf.etag);
    res.set("Vary", "Accept-Encoding");
    if (gz) res.set("Content-Encoding", "gzip");
    if (etag_matches(req.header("if-none-match"), cf.etag)) {
        res.status = 304;
        res.no_body = true;
        return;
    }
    res.status = 200;
    res.body_ref = cf.data;
}

// ---------------------------------------------------------------- каталог

struct Product {
    std::string id, name;
    int64_t price = 0;
    std::vector<std::string> sizes;
};

struct Catalog {
    std::unordered_map<std::string, Product> items;
    std::string currency = "UZS";
    std::string telegram = "shxawenya";
};

std::mutex g_catalog_mu;
std::shared_ptr<const Catalog> g_catalog;
time_t g_catalog_mtime = 0;
off_t g_catalog_size = -1;

bool valid_tg_username(const std::string &u) {
    if (u.size() < 5 || u.size() > 32) return false;
    for (unsigned char c : u)
        if (!std::isalnum(c) && c != '_') return false;
    return true;
}

// Текущий каталог из root/data/products.json (перечитывается при изменении).
std::shared_ptr<const Catalog> catalog(std::string &err) {
    std::string path = g_root_real + "/data/products.json";
    struct stat st;
    if (::stat(path.c_str(), &st) != 0) {
        err = "Каталог товаров недоступен";
        return nullptr;
    }
    std::lock_guard<std::mutex> lk(g_catalog_mu);
    if (g_catalog && st.st_mtime == g_catalog_mtime && st.st_size == g_catalog_size) return g_catalog;

    std::string text;
    json::Value root;
    if (!read_file(path, text) || !json::parse(text, root) || !root.is_object()) {
        err = "Каталог товаров повреждён";
        return nullptr;
    }
    auto cat = std::make_shared<Catalog>();
    if (auto c = root.get("currency"); c && c->is_string()) cat->currency = c->str;
    if (auto t = root.get("telegram"); t && t->is_string() && valid_tg_username(t->str)) cat->telegram = t->str;
    const json::Value *list = root.get("products");
    if (!list || !list->is_array()) {
        err = "Каталог товаров повреждён";
        return nullptr;
    }
    for (const auto &p : list->arr) {
        const json::Value *id = p.get("id"), *name = p.get("name"), *price = p.get("price"), *sizes = p.get("sizes");
        Product pr;
        if (!id || !id->is_string() || !price || !price->as_int(0, 1000000000000LL, pr.price)) continue;
        pr.id = id->str;
        pr.name = name && name->is_string() ? name->str : id->str;
        if (sizes && sizes->is_array())
            for (const auto &s : sizes->arr)
                if (s.is_string()) pr.sizes.push_back(s.str);
        cat->items[pr.id] = std::move(pr);
    }
    g_catalog = cat;
    g_catalog_mtime = st.st_mtime;
    g_catalog_size = st.st_size;
    return g_catalog;
}

// ---------------------------------------------------------------- заказы

std::mutex g_order_mu;
std::string g_order_date;  // YYYYMMDD текущего счётчика
int g_order_seq = 0;

// Максимальный номер заказа за дату из orders.jsonl (переживает рестарт).
int scan_max_seq(const std::string &date) {
    std::ifstream f(g_cfg.orders);
    std::string line, needle = "\"CF-" + date + "-";
    int mx = 0;
    while (std::getline(f, line)) {
        size_t p = line.find(needle);
        if (p == std::string::npos) continue;
        mx = std::max(mx, std::atoi(line.c_str() + p + needle.size()));
    }
    return mx;
}

struct Line {
    const Product *p;
    std::string size;
    int64_t qty;
};

void handle_order(const Request &req, Response &res) {
    if (req.method != "POST") {
        json_error(res, 405, "Используйте POST");
        res.set("Allow", "POST");
        return;
    }
    std::string ct = lower(req.header("content-type"));
    if (!ct.empty() && ct.rfind("application/json", 0) != 0 && ct.rfind("text/plain", 0) != 0) {
        json_error(res, 415, "Ожидается JSON");
        return;
    }
    json::Value body;
    if (!json::parse(req.body, body) || !body.is_object()) {
        json_error(res, 400, "Некорректный JSON");
        return;
    }
    std::string err;
    auto cat = catalog(err);
    if (!cat) {
        json_error(res, 503, err);
        return;
    }

    const json::Value *items = body.get("items");
    if (!items || !items->is_array() || items->arr.empty()) {
        json_error(res, 400, "Корзина пуста");
        return;
    }
    if (items->arr.size() > kMaxItems) {
        json_error(res, 400, "Слишком много позиций в заказе");
        return;
    }
    std::vector<Line> lines;
    int64_t total = 0;
    for (const auto &it : items->arr) {
        const json::Value *id = it.get("id"), *size = it.get("size"), *qty = it.get("qty");
        if (!it.is_object() || !id || !id->is_string()) {
            json_error(res, 400, "Не указан товар");
            return;
        }
        auto pit = cat->items.find(id->str);
        if (pit == cat->items.end()) {
            json_error(res, 400, "Товар не найден: " + (utf8_len(id->str) > 64 ? std::string("?") : id->str));
            return;
        }
        const Product &p = pit->second;
        if (!size || !size->is_string() ||
            std::find(p.sizes.begin(), p.sizes.end(), size->str) == p.sizes.end()) {
            json_error(res, 400, "Размер недоступен: " + p.name);
            return;
        }
        int64_t q;
        if (!qty || !qty->as_int(1, 10, q)) {
            json_error(res, 400, "Количество должно быть целым числом от 1 до 10");
            return;
        }
        lines.push_back({&p, size->str, q});
        total += p.price * q;
    }

    auto text_field = [&](const char *key, const char *label, size_t maxlen, bool required, bool multiline,
                          std::string &out) -> bool {
        const json::Value *v = body.get(key);
        if (v && !v->is_null() && !v->is_string()) {
            json_error(res, 400, std::string("Поле «") + label + "» должно быть строкой");
            return false;
        }
        out = v && v->is_string() ? trim(v->str) : "";
        if (required && out.empty()) {
            json_error(res, 400, std::string("Укажите ") + (std::strcmp(key, "name") == 0 ? "имя" : "телефон"));
            return false;
        }
        if (utf8_len(out) > maxlen) {
            json_error(res, 400, std::string("Поле «") + label + "» длиннее " + std::to_string(maxlen) + " символов");
            return false;
        }
        if (has_control(out, multiline)) {
            json_error(res, 400, std::string("Недопустимые символы в поле «") + label + "»");
            return false;
        }
        return true;
    };
    std::string name, phone, note;
    if (!text_field("name", "Имя", kMaxNameLen, true, false, name) ||
        !text_field("phone", "Телефон", kMaxNameLen, true, false, phone) ||
        !text_field("note", "Комментарий", kMaxNoteLen, false, true, note))
        return;

    // номер заказа и запись — под одним мьютексом, чтобы номера шли подряд
    time_t now = time(nullptr);
    struct tm lt;
    localtime_r(&now, &lt);
    char date[16], iso[40];
    strftime(date, sizeof date, "%Y%m%d", &lt);
    strftime(iso, sizeof iso, "%Y-%m-%dT%H:%M:%S%z", &lt);

    std::string cur = cat->currency == "UZS" ? "сум" : cat->currency;
    std::string order_id;
    {
        std::lock_guard<std::mutex> lk(g_order_mu);
        if (g_order_date != date) {
            g_order_date = date;
            g_order_seq = scan_max_seq(date);
        }
        char oid[40];
        snprintf(oid, sizeof oid, "CF-%s-%04d", date, ++g_order_seq);
        order_id = oid;

        std::string rec = "{\"order_id\":" + json::quote(order_id) + ",\"created_at\":" + json::quote(iso) + ",\"items\":[";
        for (size_t i = 0; i < lines.size(); ++i) {
            const Line &l = lines[i];
            if (i) rec += ',';
            rec += "{\"id\":" + json::quote(l.p->id) + ",\"name\":" + json::quote(l.p->name) +
                   ",\"size\":" + json::quote(l.size) + ",\"qty\":" + std::to_string(l.qty) +
                   ",\"price\":" + std::to_string(l.p->price) + "}";
        }
        rec += "],\"total\":" + std::to_string(total) + ",\"currency\":" + json::quote(cat->currency) +
               ",\"name\":" + json::quote(name) + ",\"phone\":" + json::quote(phone) +
               ",\"note\":" + json::quote(note) + "}\n";
        int fd = ::open(g_cfg.orders.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0600);
        bool ok = fd >= 0 && ::write(fd, rec.data(), rec.size()) == (ssize_t)rec.size();
        if (fd >= 0) ::close(fd);
        if (!ok) {
            --g_order_seq;
            json_error(res, 500, "Не удалось сохранить заказ, попробуйте ещё раз");
            return;
        }
    }

    std::string msg = "Здравствуйте! Хочу оформить заказ " + order_id + " в Claude Fergana:\n";
    for (const Line &l : lines)
        msg += "— " + l.p->name + ", размер " + l.size + " × " + std::to_string(l.qty) + " = " +
               group_digits(l.p->price * l.qty) + " " + cur + "\n";
    msg += "Итого: " + group_digits(total) + " " + cur + "\n";
    msg += "Имя: " + name + "\nТелефон: " + phone;
    if (!note.empty()) msg += "\nКомментарий: " + note;
    std::string tg = "https://t.me/" + cat->telegram + "?text=" + url_encode(msg);

    json_response(res, 200,
                  "{\"ok\":true,\"order_id\":" + json::quote(order_id) + ",\"total\":" + std::to_string(total) +
                      ",\"telegram_url\":" + json::quote(tg) + "}");
}

// ---------------------------------------------------------------- маршрутизация

void handle(const Request &req, Response &res) {
    std::string path = req.target;
    if (path.rfind("http://", 0) == 0 || path.rfind("https://", 0) == 0) {  // absolute-form
        size_t s = path.find('/', path.find("//") + 2);
        path = s == std::string::npos ? "/" : path.substr(s);
    }
    size_t q = path.find_first_of("?#");
    if (q != std::string::npos) path.resize(q);

    if (path == "/api/health") {
        if (req.method != "GET" && req.method != "HEAD") {
            json_error(res, 405, "Метод не поддерживается");
            res.set("Allow", "GET, HEAD");
            return;
        }
        json_response(res, 200, "{\"ok\":true}");
        return;
    }
    if (path == "/api/products") {
        serve_static(req, res, "/data/products.json");
        if (res.status == 404) {
            res = Response();
            json_error(res, 503, "Каталог товаров недоступен");
        }
        return;
    }
    if (path == "/api/order") {
        handle_order(req, res);
        return;
    }
    if (path.rfind("/api/", 0) == 0) {
        json_error(res, 404, "Неизвестный метод API");
        return;
    }
    serve_static(req, res, path);
}

void log_line(const std::string &peer, const Request &req, const Response &res) {
    if (g_cfg.quiet) return;
    std::lock_guard<std::mutex> lk(g_log_mu);
    fprintf(stderr, "%s %s %s %d %zu\n", peer.c_str(), req.method.c_str(), req.target.c_str(), res.status,
            res.no_body ? (size_t)0 : res.payload().size());
}

void serve_conn(int fd, const std::string &peer) {
    struct timeval tv = {kIdleTimeoutSec, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
#ifdef SO_NOSIGPIPE
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
    std::string buf;
    for (int served = 0; served < kMaxRequestsPerConn; ++served) {
        Request req;
        Response res;
        int rc = read_request(fd, buf, req);
        if (rc < 0) break;
        if (rc > 0) {
            json_error(res, rc, rc == 413 ? "Слишком большой запрос" : rc == 431 ? "Слишком большие заголовки"
                                                                                  : "Некорректный запрос");
            res.close = true;
            if (req.method.empty()) req.method = "GET";
        } else {
            try {
                handle(req, res);
            } catch (const std::exception &) {
                res = Response();
                json_error(res, 500, "Внутренняя ошибка сервера");
            }
        }
        log_line(peer, req, res);
        bool keep = !res.close && req.keep_alive && served + 1 < kMaxRequestsPerConn;
        if (!send_response(fd, req, res, keep) || !keep) break;
    }
    ::close(fd);
}

// ---------------------------------------------------------------- пул потоков

struct Job {
    int fd;
    std::string peer;
};

std::mutex g_q_mu;
std::condition_variable g_q_cv;
std::deque<Job> g_queue;

void worker() {
    for (;;) {
        Job job;
        {
            std::unique_lock<std::mutex> lk(g_q_mu);
            g_q_cv.wait(lk, [] { return !g_queue.empty(); });
            job = std::move(g_queue.front());
            g_queue.pop_front();
        }
        serve_conn(job.fd, job.peer);
    }
}

void usage(const char *argv0) {
    fprintf(stderr,
            "usage: %s [--port N] [--host ADDR] [--root DIR] [--orders FILE] [--threads N] [--quiet]\n", argv0);
}

}  // namespace

int main(int argc, char **argv) {
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&]() -> const char * {
            if (i + 1 >= argc) { usage(argv[0]); std::exit(2); }
            return argv[++i];
        };
        if (a == "--port") g_cfg.port = std::atoi(next());
        else if (a == "--host") g_cfg.host = next();
        else if (a == "--root") g_cfg.root = next();
        else if (a == "--orders") g_cfg.orders = next();
        else if (a == "--threads") g_cfg.threads = std::atoi(next());
        else if (a == "--quiet") g_cfg.quiet = true;
        else if (a == "-h" || a == "--help") { usage(argv[0]); return 0; }
        else { usage(argv[0]); return 2; }
    }
    if (g_cfg.port <= 0 || g_cfg.port > 65535 || g_cfg.threads <= 0 || g_cfg.threads > 1024) {
        usage(argv[0]);
        return 2;
    }
    char real[PATH_MAX];
    if (!::realpath(g_cfg.root.c_str(), real)) {
        fprintf(stderr, "fergana: корень %s не найден: %s\n", g_cfg.root.c_str(), strerror(errno));
        return 1;
    }
    g_root_real = real;
    signal(SIGPIPE, SIG_IGN);

    int ls = ::socket(AF_INET, SOCK_STREAM, 0);
    if (ls < 0) { perror("socket"); return 1; }
    int one = 1;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)g_cfg.port);
    if (inet_pton(AF_INET, g_cfg.host.c_str(), &addr.sin_addr) != 1) {
        fprintf(stderr, "fergana: неверный --host %s\n", g_cfg.host.c_str());
        return 2;
    }
    if (::bind(ls, (sockaddr *)&addr, sizeof addr) < 0) {
        fprintf(stderr, "fergana: bind %s:%d: %s\n", g_cfg.host.c_str(), g_cfg.port, strerror(errno));
        return 1;
    }
    if (::listen(ls, 1024) < 0) { perror("listen"); return 1; }

    for (int i = 0; i < g_cfg.threads; ++i) std::thread(worker).detach();
    fprintf(stderr, "fergana: http://%s:%d  root=%s  orders=%s  threads=%d\n", g_cfg.host.c_str(), g_cfg.port,
            g_root_real.c_str(), g_cfg.orders.c_str(), g_cfg.threads);

    for (;;) {
        sockaddr_in peer{};
        socklen_t plen = sizeof peer;
        int fd = ::accept(ls, (sockaddr *)&peer, &plen);
        if (fd < 0) {
            if (errno == EINTR || errno == ECONNABORTED) continue;
            if (errno == EMFILE || errno == ENFILE) { usleep(10000); continue; }
            perror("accept");
            continue;
        }
        char ip[INET_ADDRSTRLEN] = "?";
        inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof ip);
        std::unique_lock<std::mutex> lk(g_q_mu);
        if (g_queue.size() >= kMaxQueue) {  // перегрузка: честно отказываем
            lk.unlock();
            static const char busy[] =
                "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 1\r\nConnection: close\r\n\r\n";
            send(fd, busy, sizeof busy - 1, 0);
            ::close(fd);
            continue;
        }
        g_queue.push_back({fd, ip});
        lk.unlock();
        g_q_cv.notify_one();
    }
}
