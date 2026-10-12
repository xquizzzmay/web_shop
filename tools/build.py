#!/usr/bin/env python3
"""Предсжатие статики Claude Fergana: рядом с файлом кладёт файл.gz (gzip -9).

.gz пишется, только если он меньше оригинала; иначе старый .gz удаляется.
Сервер отдаёт .gz, если он не старее оригинала, поэтому mtime .gz
выставляется равным mtime оригинала (детерминированный вывод, mtime=0 в заголовке).

  python3 tools/build.py [--root web] [--clean]
"""
import argparse
import gzip
import io
import os
import sys

EXTS = {".html", ".css", ".js", ".json", ".svg", ".bin"}


def human(n):
    return f"{n / 1024:.1f} KB" if n >= 1024 else f"{n} B"


def gzip_bytes(data):
    buf = io.BytesIO()
    # mtime=0 и пустое имя: одинаковый вход -> одинаковый .gz -> стабильный ETag-контент
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, compresslevel=9, mtime=0) as gz:
        gz.write(data)
    return buf.getvalue()


def walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if not name.startswith("."):
                yield os.path.join(dirpath, name)


def clean(root):
    n = 0
    for path in walk(root):
        if path.endswith(".gz") and os.path.splitext(path[:-3])[1] in EXTS:
            os.remove(path)
            n += 1
    print(f"build: удалено {n} .gz")


def build(root):
    rows, tot_raw, tot_out = [], 0, 0
    for path in walk(root):
        if os.path.splitext(path)[1] not in EXTS:
            continue
        with open(path, "rb") as f:
            data = f.read()
        gz_path = path + ".gz"
        packed = gzip_bytes(data)
        st = os.stat(path)
        if len(packed) < len(data):
            old = None
            if os.path.exists(gz_path):
                with open(gz_path, "rb") as f:
                    old = f.read()
            if old != packed:
                tmp = gz_path + ".tmp"
                with open(tmp, "wb") as f:
                    f.write(packed)
                os.replace(tmp, gz_path)
            os.utime(gz_path, ns=(st.st_atime_ns, st.st_mtime_ns))
            out = len(packed)
        else:
            if os.path.exists(gz_path):
                os.remove(gz_path)
            out = len(data)
        rows.append((os.path.relpath(path, root), len(data), out))
        tot_raw += len(data)
        tot_out += out

    w = max([len(r[0]) for r in rows] + [4])
    print(f"{'файл':<{w}}  {'исходник':>10}  {'gzip':>10}  {'%':>5}")
    for name, raw, out in rows:
        pct = 100 * out / raw if raw else 100
        mark = "" if out < raw else "  (без .gz)"
        print(f"{name:<{w}}  {human(raw):>10}  {human(out):>10}  {pct:5.1f}{mark}")
    if rows:
        print(f"{'ИТОГО':<{w}}  {human(tot_raw):>10}  {human(tot_out):>10}  {100 * tot_out / max(tot_raw, 1):5.1f}")
    else:
        print("build: нечего сжимать")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web"))
    ap.add_argument("--clean", action="store_true", help="удалить .gz и выйти")
    args = ap.parse_args()
    root = os.path.normpath(args.root)
    if not os.path.isdir(root):
        sys.exit(f"build: нет каталога {root}")
    clean(root) if args.clean else build(root)


if __name__ == "__main__":
    main()
