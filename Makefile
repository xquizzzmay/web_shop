# Claude Fergana — сборка бэкенда (apple-a2). См. CONTRACTS.md §5.
CC       ?= cc
CXX      ?= clang++
CFLAGS   := -O2 -Wall -Wextra -std=c99 -pedantic
CXXFLAGS := -O2 -Wall -Wextra -std=c++17 -pthread
PYTHON   ?= python3
PORT     ?= 8090

CLOTH  := web/assets/cloth.bin
SERVER := bin/fergana-server

.PHONY: all gzip run test bench clean distclean

all: $(SERVER) gzip

bin/cloth: sim/cloth.c | bin
	$(CC) $(CFLAGS) -o $@ $< -lm

# cloth.bin лежит в репозитории (нужен и на GitHub Pages), пересчитывается при правке sim/
# зависит от исходника, а не бинарника: make clean не вызывает пересчёт
$(CLOTH): sim/cloth.c
	@$(MAKE) --no-print-directory bin/cloth
	@mkdir -p $(dir $@)
	bin/cloth $@

$(SERVER): server/main.cpp server/json.hpp | bin
	$(CXX) $(CXXFLAGS) -o $@ server/main.cpp

bin:
	mkdir -p bin

gzip:
	$(PYTHON) tools/build.py

run: $(SERVER)
	$(SERVER) --port $(PORT) --root web --orders server/orders.jsonl

test: $(SERVER)
	$(PYTHON) server/test.py

bench: $(SERVER)
	$(PYTHON) server/test.py --bench

clean:
	rm -rf bin
	$(PYTHON) tools/build.py --clean

# + сгенерированная ткань (пересчёт ~13 с)
distclean: clean
	rm -f $(CLOTH)
