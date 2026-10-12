// json.hpp — минимальный строгий JSON (RFC 8259) для fergana-server.
// Парсер рекурсивного спуска с лимитом глубины, \uXXXX с суррогатными
// парами -> UTF-8, проверка UTF-8 во входных строках. Только то, что нужно
// серверу: products.json и тело заказа.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace json {

struct Value {
    enum Type { Null, Bool, Number, String, Array, Object } type = Null;
    bool b = false;
    double num = 0;
    std::string str;
    std::vector<Value> arr;
    std::map<std::string, Value> obj;

    bool is_null() const { return type == Null; }
    bool is_string() const { return type == String; }
    bool is_number() const { return type == Number; }
    bool is_array() const { return type == Array; }
    bool is_object() const { return type == Object; }

    // nullptr, если ключа нет или это не объект
    const Value *get(const std::string &key) const {
        if (type != Object) return nullptr;
        auto it = obj.find(key);
        return it == obj.end() ? nullptr : &it->second;
    }
    // целое без дробной части в диапазоне [lo, hi]
    bool as_int(int64_t lo, int64_t hi, int64_t &out) const {
        if (type != Number || !std::isfinite(num) || num != std::floor(num)) return false;
        if (num < (double)lo || num > (double)hi) return false;
        out = (int64_t)num;
        return true;
    }
};

class Parser {
public:
    explicit Parser(const std::string &s) : p_(s.data()), end_(s.data() + s.size()) {}

    bool parse(Value &out) {
        ws();
        if (!value(out, 0)) return false;
        ws();
        return p_ == end_;
    }

private:
    static constexpr int kMaxDepth = 32;
    const char *p_, *end_;

    void ws() {
        while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\n' || *p_ == '\r')) ++p_;
    }
    bool lit(const char *w) {
        const char *q = p_;
        for (; *w; ++w, ++q)
            if (q >= end_ || *q != *w) return false;
        p_ = q;
        return true;
    }

    bool value(Value &v, int depth) {
        if (p_ >= end_ || depth > kMaxDepth) return false;
        switch (*p_) {
        case '{': return object(v, depth);
        case '[': return array(v, depth);
        case '"': v.type = Value::String; return string(v.str);
        case 't': v.type = Value::Bool; v.b = true; return lit("true");
        case 'f': v.type = Value::Bool; v.b = false; return lit("false");
        case 'n': v.type = Value::Null; return lit("null");
        default: return number(v);
        }
    }

    bool object(Value &v, int depth) {
        v.type = Value::Object;
        ++p_;
        ws();
        if (p_ < end_ && *p_ == '}') { ++p_; return true; }
        for (;;) {
            std::string key;
            ws();
            if (p_ >= end_ || *p_ != '"' || !string(key)) return false;
            ws();
            if (p_ >= end_ || *p_ != ':') return false;
            ++p_;
            ws();
            Value item;
            if (!value(item, depth + 1)) return false;
            v.obj[key] = std::move(item);  // дубликат ключа: побеждает последний
            ws();
            if (p_ >= end_) return false;
            if (*p_ == ',') { ++p_; continue; }
            if (*p_ == '}') { ++p_; return true; }
            return false;
        }
    }

    bool array(Value &v, int depth) {
        v.type = Value::Array;
        ++p_;
        ws();
        if (p_ < end_ && *p_ == ']') { ++p_; return true; }
        for (;;) {
            Value item;
            ws();
            if (!value(item, depth + 1)) return false;
            v.arr.push_back(std::move(item));
            ws();
            if (p_ >= end_) return false;
            if (*p_ == ',') { ++p_; continue; }
            if (*p_ == ']') { ++p_; return true; }
            return false;
        }
    }

    bool number(Value &v) {
        const char *s = p_;
        if (p_ < end_ && *p_ == '-') ++p_;
        if (p_ >= end_) return false;
        if (*p_ == '0') ++p_;
        else if (*p_ >= '1' && *p_ <= '9') while (p_ < end_ && isdigit_(*p_)) ++p_;
        else return false;
        if (p_ < end_ && *p_ == '.') {
            ++p_;
            if (p_ >= end_ || !isdigit_(*p_)) return false;
            while (p_ < end_ && isdigit_(*p_)) ++p_;
        }
        if (p_ < end_ && (*p_ == 'e' || *p_ == 'E')) {
            ++p_;
            if (p_ < end_ && (*p_ == '+' || *p_ == '-')) ++p_;
            if (p_ >= end_ || !isdigit_(*p_)) return false;
            while (p_ < end_ && isdigit_(*p_)) ++p_;
        }
        v.type = Value::Number;
        v.num = std::strtod(std::string(s, p_).c_str(), nullptr);
        return std::isfinite(v.num);
    }
    static bool isdigit_(char c) { return c >= '0' && c <= '9'; }

    static int hex(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }
    bool hex4(unsigned &out) {
        if (end_ - p_ < 4) return false;
        out = 0;
        for (int i = 0; i < 4; ++i) {
            int h = hex(p_[i]);
            if (h < 0) return false;
            out = out * 16 + (unsigned)h;
        }
        p_ += 4;
        return true;
    }
    static void put_utf8(std::string &o, unsigned cp) {
        if (cp < 0x80) o += (char)cp;
        else if (cp < 0x800) { o += (char)(0xC0 | (cp >> 6)); o += (char)(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) {
            o += (char)(0xE0 | (cp >> 12)); o += (char)(0x80 | ((cp >> 6) & 0x3F));
            o += (char)(0x80 | (cp & 0x3F));
        } else {
            o += (char)(0xF0 | (cp >> 18)); o += (char)(0x80 | ((cp >> 12) & 0x3F));
            o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F));
        }
    }
    // Длина корректной UTF-8 последовательности, начинающейся с p_, или 0.
    size_t utf8_seq() const {
        const unsigned char *s = (const unsigned char *)p_;
        size_t left = (size_t)(end_ - p_);
        unsigned c = s[0];
        size_t n;
        unsigned cp;
        if (c < 0x80) return 1;
        if (c >= 0xC2 && c <= 0xDF) { n = 2; cp = c & 0x1F; }
        else if (c >= 0xE0 && c <= 0xEF) { n = 3; cp = c & 0x0F; }
        else if (c >= 0xF0 && c <= 0xF4) { n = 4; cp = c & 0x07; }
        else return 0;
        if (left < n) return 0;
        for (size_t i = 1; i < n; ++i) {
            if ((s[i] & 0xC0) != 0x80) return 0;
            cp = (cp << 6) | (s[i] & 0x3F);
        }
        if ((n == 3 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) || (n == 4 && (cp < 0x10000 || cp > 0x10FFFF)))
            return 0;
        return n;
    }

    bool string(std::string &out) {
        ++p_;  // "
        out.clear();
        while (p_ < end_) {
            unsigned char c = (unsigned char)*p_;
            if (c == '"') { ++p_; return true; }
            if (c < 0x20) return false;
            if (c == '\\') {
                if (++p_ >= end_) return false;
                char e = *p_++;
                switch (e) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    unsigned cp;
                    if (!hex4(cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        unsigned lo;
                        if (end_ - p_ < 2 || p_[0] != '\\' || p_[1] != 'u') return false;
                        p_ += 2;
                        if (!hex4(lo) || lo < 0xDC00 || lo > 0xDFFF) return false;
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        return false;
                    }
                    put_utf8(out, cp);
                    break;
                }
                default: return false;
                }
                continue;
            }
            size_t n = utf8_seq();
            if (!n) return false;
            out.append(p_, n);
            p_ += n;
        }
        return false;
    }
};

inline bool parse(const std::string &s, Value &out) { return Parser(s).parse(out); }

// Экранирование строки для вывода в JSON (вход — корректный UTF-8).
inline std::string quote(const std::string &s) {
    static const char *hexd = "0123456789abcdef";
    std::string o;
    o.reserve(s.size() + 2);
    o += '"';
    for (unsigned char c : s) {
        switch (c) {
        case '"': o += "\\\""; break;
        case '\\': o += "\\\\"; break;
        case '\n': o += "\\n"; break;
        case '\r': o += "\\r"; break;
        case '\t': o += "\\t"; break;
        default:
            if (c < 0x20) { o += "\\u00"; o += hexd[c >> 4]; o += hexd[c & 15]; }
            else o += (char)c;
        }
    }
    o += '"';
    return o;
}

}  // namespace json
