// Единый конверт ответа API для НОВЫХ endpoint'ов (Eugene 2026-05-29, #12 аудита).
// Канон проекта — `{ data, error }`. В кодовой базе исторически сосуществуют ещё
// две формы (`{ ok, ... }` ~295 мест и `{ message }` ~178) — РАБОЧИЕ endpoint'ы
// НЕ переписываем (риск регрессии на 1456 точках). Любой НОВЫЙ endpoint отдаёт
// ответ через ok()/fail() ниже — так дрейф конвенций больше не растёт.
import type { Response } from "express";

// Успех: { data, error: null }. status по умолчанию 200.
export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ data, error: null });
}

// Ошибка: { data: null, error }. status по умолчанию 400. Никаких stack-trace /
// внутренних деталей в error — только человекочитаемое сообщение (Security §).
export function fail(res: Response, error: string, status = 400): Response {
  return res.status(status).json({ data: null, error });
}
