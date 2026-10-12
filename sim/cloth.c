/*
 * cloth.c — Verlet-симуляция шёлкового полотна для Claude Fergana.
 *
 * Полотно COLS x ROWS частиц висит на закреплённой верхней кромке.
 * Ветер — сумма гармоник базовой частоты 1/T, где T = длина петли,
 * поэтому вынуждающая сила строго периодична. Система демпфирована и
 * после прогрева выходит на периодический режим; остаточный шов
 * закрывается кроссфейдом первых кадров с продолжением петли.
 *
 * Симуляция трёхмерная: ветер дует в полотно вдоль z.
 *
 * Выход: web/assets/cloth.bin, формат CONTRACTS.md §3 v2 (little-endian),
 * x,y,z на точку; кадр 0 абсолютный, кадры 1.. — дельты к предыдущему. Все оси нормированы ОДНИМ масштабом (пропорции полотна
 * сохранены) в [-1..1]; x вправо, y вниз, z к зрителю; центр bbox = 0.
 *
 * Сборка: cc -O2 -Wall -Wextra -std=c99 -o cloth cloth.c -lm
 * Запуск: ./cloth [путь_к_cloth.bin]
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define COLS      32
#define ROWS      20
#define FRAMES    120
#define FPS       30
#define SUBSTEPS  16
#define ITERS     12
#define WARMUP_LOOPS 6
#define XFADE     16          /* кадров кроссфейда на шве */
#define QUANT     8           /* шаг квантования int16 */
#ifndef WIND_GAIN
#define WIND_GAIN   1.3       /* сила основного ветра */
#endif
#ifndef CORNER_GAIN
#define CORNER_GAIN 11.0      /* «хлопанье» нижних углов */
#endif
#ifndef BEND
#define BEND        0.06      /* жёсткость на изгиб: меньше — мельче складки */
#endif
#define N         (COLS * ROWS)

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

typedef struct { double x, y, z; } vec3;

typedef struct { int a, b; double rest, k; } link_t;

static vec3 pos[N], prev[N], rest_pos[N];
static int pinned[N];
static link_t links[N * 6];
static int nlinks;

static const double SPACING = 0.05;   /* м: полотно ~1.55 x 0.95 */
static const double GRAVITY = 9.81;
static const double DAMP    = 0.985;  /* на подшаг; шёлк лёгкий, но гасим хаос */
static const double LOOP_T  = (double)FRAMES / FPS;

static int idx(int c, int r) { return r * COLS + c; }

static void add_link(int a, int b, double k)
{
    double dx = rest_pos[a].x - rest_pos[b].x;
    double dy = rest_pos[a].y - rest_pos[b].y;
    links[nlinks].a = a;
    links[nlinks].b = b;
    links[nlinks].rest = sqrt(dx * dx + dy * dy);
    links[nlinks].k = k;
    nlinks++;
}

static void init_cloth(void)
{
    int c, r;
    for (r = 0; r < ROWS; r++)
        for (c = 0; c < COLS; c++) {
            int i = idx(c, r);
            rest_pos[i].x = (c - (COLS - 1) * 0.5) * SPACING;
            rest_pos[i].y = r * SPACING;
            rest_pos[i].z = 0.0;
            pos[i] = prev[i] = rest_pos[i];
            pinned[i] = (r == 0);
        }
    nlinks = 0;
    for (r = 0; r < ROWS; r++)
        for (c = 0; c < COLS; c++) {
            int i = idx(c, r);
            if (c + 1 < COLS) add_link(i, idx(c + 1, r), 1.0);            /* структура */
            if (r + 1 < ROWS) add_link(i, idx(c, r + 1), 1.0);
            if (c + 1 < COLS && r + 1 < ROWS) add_link(i, idx(c + 1, r + 1), 0.6); /* сдвиг */
            if (c > 0 && r + 1 < ROWS) add_link(i, idx(c - 1, r + 1), 0.6);
            if (c + 2 < COLS) add_link(i, idx(c + 2, r), BEND);           /* изгиб: мягкий шёлк */
            if (r + 2 < ROWS) add_link(i, idx(c, r + 2), BEND);
        }
}

/* Ветер: гармоники 1..4 от 1/LOOP_T => период ровно LOOP_T.
 * Пространственная фаза даёт бегущие по полотну волны. */
static vec3 wind_at(const vec3 *p, double t)
{
    const double w = 2.0 * M_PI / LOOP_T;
    const double H = (ROWS - 1) * SPACING, W2 = (COLS - 1) * SPACING * 0.5;
    double u = p->x, v = p->y;
    double down = v / H;                          /* 0 у кромки .. 1 внизу */
    double side = fabs(u) / W2;                   /* 0 в центре .. 1 у края */
    double corner = down * down * side * side;    /* только нижние углы */
    double fall = 0.3 + 0.7 * down;               /* верх спокоен, низ «дышит» */
    vec3 f;
    /* основной порыв: бегущие волны по z, отсюда складки */
    f.z = WIND_GAIN * fall * (2.2 * sin(1.0 * w * t - 2.4 * u - 1.1 * v)
                            + 1.5 * sin(2.0 * w * t + 3.1 * u - 2.6 * v + 0.7)
                            + 0.9 * sin(3.0 * w * t - 4.7 * u + 3.3 * v + 1.9)
                            + 0.5 * sin(5.0 * w * t + 6.1 * u - 4.0 * v + 0.3)
                            + 0.8);              /* постоянная составляющая — полотно выгнуто */
    f.x = WIND_GAIN * fall * (1.1 * sin(1.0 * w * t + 0.9 * v + 0.4)
                            + 0.5 * sin(4.0 * w * t - 2.7 * u + 2.2));
    f.y = WIND_GAIN * fall * 0.25 * sin(2.0 * w * t + 1.7 * u + 1.3);
    /* нижние углы «хлопают»: короткие резкие порывы, левый и правый не в фазе;
     * max(0, sin)^3 — импульс вверх и к зрителю, обратно возвращает гравитация */
    {
        double ph = u < 0 ? 0.0 : 2.3;
        double s2 = sin(2.0 * w * t + ph), s3 = sin(3.0 * w * t + ph + 1.1);
        double kick = (s2 > 0 ? s2 * s2 * s2 : 0.0) + 0.6 * (s3 > 0 ? s3 * s3 * s3 : 0.0);
        f.z += CORNER_GAIN * corner * (kick * 1.6 - 0.3 + 0.6 * sin(4.0 * w * t + ph));
        f.y -= CORNER_GAIN * corner * kick * 1.2;
        f.x += CORNER_GAIN * corner * (u < 0 ? -1.0 : 1.0) * 0.4 * kick;
    }
    return f;
}

static void step(double t, double dt)
{
    int i, it, l;
    for (i = 0; i < N; i++) {
        vec3 a, cur;
        if (pinned[i]) continue;
        a = wind_at(&pos[i], t);
        a.y += GRAVITY;
        cur = pos[i];
        pos[i].x += (pos[i].x - prev[i].x) * DAMP + a.x * dt * dt;
        pos[i].y += (pos[i].y - prev[i].y) * DAMP + a.y * dt * dt;
        pos[i].z += (pos[i].z - prev[i].z) * DAMP + a.z * dt * dt;
        prev[i] = cur;
    }
    for (it = 0; it < ITERS; it++)
        for (l = 0; l < nlinks; l++) {
            const link_t *k = &links[l];
            vec3 *pa = &pos[k->a], *pb = &pos[k->b];
            double dx = pb->x - pa->x, dy = pb->y - pa->y, dz = pb->z - pa->z;
            double d = sqrt(dx * dx + dy * dy + dz * dz);
            double wa = pinned[k->a] ? 0.0 : 1.0;
            double wb = pinned[k->b] ? 0.0 : 1.0;
            double diff, s;
            if (d < 1e-9 || wa + wb == 0.0) continue;
            diff = (d - k->rest) / d * k->k;
            s = diff / (wa + wb);
            pa->x += dx * s * wa; pa->y += dy * s * wa; pa->z += dz * s * wa;
            pb->x -= dx * s * wb; pb->y -= dy * s * wb; pb->z -= dz * s * wb;
        }
}

/* В систему контракта: y вниз уже, z симуляции — от зрителя, переворачиваем. */
static void to_out(const vec3 *p, double *o)
{
    o[0] = p->x;
    o[1] = p->y;
    o[2] = -p->z;
}

static void put_u16(unsigned char *b, unsigned v) { b[0] = v & 0xff; b[1] = (v >> 8) & 0xff; }

int main(int argc, char **argv)
{
    const char *out = argc > 1 ? argv[1] : "web/assets/cloth.bin";
    const int total = FRAMES + XFADE;
    const double dt = 1.0 / FPS / SUBSTEPS;
    static double raw[FRAMES + XFADE][N][3];
    static double fin[FRAMES][N][3];
    static long last[N][3];             /* квантованный предыдущий кадр для дельт */
    double t = 0.0, maxabs = 0.0, seam = 0.0, scale, c[3], mn[3], mx[3];
    long sub = 0;
    int f, s, i, k;
    FILE *fp;
    unsigned char hdr[16];

    init_cloth();

    /* прогрев: много целых периодов, время считаем от целого числа подшагов */
    for (sub = 0; sub < (long)WARMUP_LOOPS * FRAMES * SUBSTEPS; sub++) {
        t = (double)(sub % ((long)FRAMES * SUBSTEPS)) * dt;
        step(t, dt);
    }

    for (f = 0; f < total; f++) {
        for (i = 0; i < N; i++) to_out(&pos[i], raw[f][i]);
        for (s = 0; s < SUBSTEPS; s++, sub++) {
            t = (double)(sub % ((long)FRAMES * SUBSTEPS)) * dt;
            step(t, dt);
        }
    }

    /* шов до сшивки: насколько петля уже периодична */
    for (i = 0; i < N; i++)
        for (k = 0; k < 3; k++) {
            double e = fabs(raw[FRAMES][i][k] - raw[0][i][k]);
            if (e > seam) seam = e;
        }

    /* кроссфейд: начало петли плавно перетекает из продолжения конца.
     * fin[0] = raw[FRAMES] — прямое продолжение raw[FRAMES-1] => шва нет. */
    for (f = 0; f < FRAMES; f++)
        for (i = 0; i < N; i++) {
            double a = f < XFADE ? (double)f / XFADE : 1.0;
            a = a * a * (3.0 - 2.0 * a);           /* smoothstep */
            for (k = 0; k < 3; k++)
                fin[f][i][k] = raw[FRAMES + f < total ? FRAMES + f : f][i][k] * (1.0 - a)
                             + raw[f][i][k] * a;
        }

    /* равномерная нормировка в [-1..1] с запасом 2% */
    for (k = 0; k < 3; k++) { mn[k] = 1e9; mx[k] = -1e9; }
    for (f = 0; f < FRAMES; f++)
        for (i = 0; i < N; i++)
            for (k = 0; k < 3; k++) {
                if (fin[f][i][k] < mn[k]) mn[k] = fin[f][i][k];
                if (fin[f][i][k] > mx[k]) mx[k] = fin[f][i][k];
            }
    for (k = 0; k < 3; k++) {
        c[k] = (mn[k] + mx[k]) * 0.5;
        if (mx[k] - c[k] > maxabs) maxabs = mx[k] - c[k];
    }
    scale = 0.98 / maxabs;

    fp = fopen(out, "wb");
    if (!fp) { perror(out); return 1; }
    memcpy(hdr, "CFCL", 4);
    put_u16(hdr + 4, 2);                      /* v2: кадр 0 абсолютный, дальше дельты */
    put_u16(hdr + 6, COLS);
    put_u16(hdr + 8, ROWS);
    put_u16(hdr + 10, FRAMES);
    put_u16(hdr + 12, FPS);
    put_u16(hdr + 14, 0);
    fwrite(hdr, 1, sizeof hdr, fp);
    for (f = 0; f < FRAMES; f++)
        for (i = 0; i < N; i++) {
            for (k = 0; k < 3; k++) {
                /* шаг QUANT: ошибка ~0.12 px на холсте 1000 px, а gzip жмёт на ~27% лучше */
                long q = lround((fin[f][i][k] - c[k]) * scale * 32767.0 / QUANT) * QUANT;
                unsigned char b[2];
                if (q > 32767) q = 32767;
                if (q < -32767) q = -32767;
                /* дельта к предыдущему кадру по модулю 2^16 (CONTRACTS.md §3 v2) */
                put_u16(b, (unsigned)((unsigned long)(f == 0 ? q : q - last[i][k]) & 0xffffUL));
                last[i][k] = q;
                fwrite(b, 1, 2, fp);
            }
        }
    if (fclose(fp) != 0) { perror(out); return 1; }

    printf("cloth: %dx%d, %d кадров @%dfps -> %s (%ld байт)\n", COLS, ROWS, FRAMES, FPS, out,
           16L + (long)FRAMES * N * 6);
    printf("cloth: шов до сшивки %.5f (норм. ед.), кроссфейд %d кадров\n", seam * scale, XFADE);
    printf("cloth: bbox x[%.3f..%.3f] y[%.3f..%.3f] z[%.3f..%.3f]\n",
           (mn[0] - c[0]) * scale, (mx[0] - c[0]) * scale, (mn[1] - c[1]) * scale,
           (mx[1] - c[1]) * scale, (mn[2] - c[2]) * scale, (mx[2] - c[2]) * scale);
    return 0;
}
