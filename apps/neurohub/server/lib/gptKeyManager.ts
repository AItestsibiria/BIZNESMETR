// GPTunnel API key manager — Eugene 2026-05-08:
// «Найди решение по которому отточенные решения с api Key проект сам
// сможет устранить».
//
// Поддерживает множественные ключи в env (CSV) с health-based rotation:
//   GPTUNNEL_API_KEYS=key1,key2,key3
// Если не задан — fallback на одиночный GPTUNNEL_API_KEY (backward compat).
//
// Стратегия:
//   - На каждый /v1/balance или /v1/media/* зов берём active() — самый здоровый
//   - При 401/403 на ключе → deactivate на 1 час (зачёт scope/invalid)
//   - При persistent network/5xx → deactivate на 5 мин (transient)
//   - При success после fail → reset failure count
//   - Если все ключи deactivated → берём наименее «протухший» как best-effort
//
// Self-healing flow:
//   T0  ключ А упал HTTP 401 → deactivate(1h), переключение на B
//   T0+ юзеры генерируют через B
//   T+1h ключ A пробуется снова (deactivatedUntil expired)
//        - если опять fail → ещё 1h
//        - если ok → возвращается в pool
// Админу в Watchdog показываем все ключи + их health.

interface KeyHealth {
  key: string;
  prefix: string; // shds…lzlO для логов без leak
  ok: number;
  fail: number;
  lastFailAt: number;
  lastFailReason: string | null;
  lastSuccessAt: number;
  deactivatedUntil: number; // 0 = active
}

class GptKeyManager {
  private keys: KeyHealth[] = [];
  private currentIndex = 0;

  init(): void {
    const csv = process.env.GPTUNNEL_API_KEYS || process.env.GPTUNNEL_API_KEY || "";
    const rawKeys = csv.split(",").map((k) => k.trim()).filter(Boolean);
    // dedupe
    const seen = new Set<string>();
    const unique = rawKeys.filter((k) => seen.has(k) ? false : (seen.add(k), true));
    this.keys = unique.map((k) => ({
      key: k,
      prefix: k.length >= 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "***",
      ok: 0, fail: 0,
      lastFailAt: 0,
      lastFailReason: null,
      lastSuccessAt: 0,
      deactivatedUntil: 0,
    }));
    console.log(`[gpt-keys] loaded ${this.keys.length} key(s): ${this.keys.map((k) => k.prefix).join(", ")}`);
  }

  /** Возвращает самый здоровый активный ключ. null если ни одного. */
  getActiveKey(): string | null {
    if (this.keys.length === 0) return null;
    const now = Date.now();
    const active = this.keys.filter((k) => !k.deactivatedUntil || k.deactivatedUntil < now);
    if (active.length > 0) {
      // Сортируем: больше success → меньше fail → новее success
      active.sort((a, b) => {
        if (a.fail !== b.fail) return a.fail - b.fail;
        if (a.lastSuccessAt !== b.lastSuccessAt) return b.lastSuccessAt - a.lastSuccessAt;
        return b.ok - a.ok;
      });
      return active[0].key;
    }
    // Все ключи deactivated — best-effort: тот что раньше всех освободится
    const sorted = [...this.keys].sort((a, b) => a.deactivatedUntil - b.deactivatedUntil);
    return sorted[0]?.key ?? null;
  }

  reportSuccess(key: string): void {
    const k = this.keys.find((x) => x.key === key);
    if (!k) return;
    k.ok += 1;
    k.lastSuccessAt = Date.now();
    // Сброс fail-счётчика после уверенного успеха (не каждого, чтобы не
    // забыть что ключ нестабильный)
    if (k.ok >= 3 && k.fail > 0) k.fail = Math.max(0, k.fail - 1);
    // Auto-reactivate если был deactivated и это уже после deadline
    if (k.deactivatedUntil && k.deactivatedUntil < Date.now()) {
      k.deactivatedUntil = 0;
      console.log(`\x1b[32m[gpt-keys]\x1b[0m ${k.prefix} reactivated after success`);
    }
  }

  reportFailure(key: string, reason: string, httpStatus?: number): void {
    const k = this.keys.find((x) => x.key === key);
    if (!k) return;
    k.fail += 1;
    k.lastFailAt = Date.now();
    k.lastFailReason = reason.slice(0, 200);

    if (httpStatus === 401 || httpStatus === 403) {
      // Невалидный ключ или scope — деактивируем на 1 час
      k.deactivatedUntil = Date.now() + 60 * 60 * 1000;
      console.log(`\x1b[33m[gpt-keys]\x1b[0m ${k.prefix} deactivated 1h: HTTP ${httpStatus}`);
    } else if (k.fail >= 5 && k.fail > k.ok) {
      // 5+ fail при низком успехе — деактивируем на 5 мин
      k.deactivatedUntil = Date.now() + 5 * 60 * 1000;
      console.log(`\x1b[33m[gpt-keys]\x1b[0m ${k.prefix} deactivated 5min: ${k.fail} fails`);
    }
  }

  /** Сбросить deactivation на конкретный ключ (admin force-rotate). */
  forceReactivate(prefix: string): boolean {
    const k = this.keys.find((x) => x.prefix === prefix);
    if (!k) return false;
    k.deactivatedUntil = 0;
    k.fail = 0;
    console.log(`[gpt-keys] ${k.prefix} force-reactivated by admin`);
    return true;
  }

  status(): Array<{ prefix: string; ok: number; fail: number; lastFailAt: number; lastFailReason: string | null; lastSuccessAt: number; deactivatedUntil: number; isActive: boolean }> {
    const now = Date.now();
    return this.keys.map((k) => ({
      prefix: k.prefix,
      ok: k.ok,
      fail: k.fail,
      lastFailAt: k.lastFailAt,
      lastFailReason: k.lastFailReason,
      lastSuccessAt: k.lastSuccessAt,
      deactivatedUntil: k.deactivatedUntil,
      isActive: !k.deactivatedUntil || k.deactivatedUntil < now,
    }));
  }
}

export const gptKeyManager = new GptKeyManager();
