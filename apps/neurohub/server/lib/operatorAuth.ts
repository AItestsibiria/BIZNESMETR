// Eugene 2026-05-18 Босс «Operator-команды через Музу — Ярс».
//
// Hashed env-auth: реальный sender_identifier (telegram-id, phone, email)
// никогда не лежит в коде — только sha256(identifier + salt). Сравниваем с
// COMMAND_OPERATOR_HASH из .env.
//
// Зачем hash, а не plaintext: даже если кто-то посмотрит .env (бэкап,
// случайный скриншот) — он увидит хэш, не сам identifier. Брутфорс
// бесполезен потому что identifier тоже не плейн (телеграм-id +
// случайная соль из .env).
//
// Использование:
//   import { isAuthorizedOperator, classifyOperatorCommand } from "@/server/lib/operatorAuth";
//   if (!isAuthorizedOperator(senderId)) return res.status(403)...
//   const cls = classifyOperatorCommand(text);

import crypto from "crypto";

export function isAuthorizedOperator(senderIdentifier: string): boolean {
  const salt = (process.env.COMMAND_OPERATOR_SALT || "").trim();
  const expectedHash = (process.env.COMMAND_OPERATOR_HASH || "").trim().toLowerCase();
  if (!expectedHash || !senderIdentifier) return false;
  const computed = crypto
    .createHash("sha256")
    .update(String(senderIdentifier) + salt)
    .digest("hex");
  return computed === expectedHash;
}

// Хеш sender'а для записи в БД (НЕ plaintext) — для аудита, без раскрытия.
export function hashSenderIdentifier(senderIdentifier: string): string {
  const salt = (process.env.COMMAND_OPERATOR_SALT || "").trim();
  return crypto
    .createHash("sha256")
    .update(String(senderIdentifier) + salt)
    .digest("hex");
}

export type OperatorCommandCategory =
  | "ui_text"
  | "kb_update"
  | "persona_tweak"
  | "news_post"
  | "delete"
  | "secret"
  | "deploy"
  | "unknown";

export interface ClassifiedCommand {
  category: OperatorCommandCategory;
  safe: boolean;
  parsedIntent?: string;
}

// Эвристика классификации команды.
// safe: изменения UI / KB / persona / новости / тарифы (в рамках известных полей)
// dangerous: DROP/DELETE/TRUNCATE, .env, force-push, удаление пользователей, payment endpoints
export function classifyOperatorCommand(text: string): ClassifiedCommand {
  const t = (text || "").toLowerCase();

  // Опасные (safe=false) — проверяются ПЕРВЫМИ.
  if (/(drop|delete|truncate|удали).*table|пользовател[яеьи]|акк[аоу]/i.test(t)) {
    return { category: "delete", safe: false, parsedIntent: "data_deletion" };
  }
  if (/\.env|secret|api[_\s]key|пароль|token/i.test(t)) {
    return { category: "secret", safe: false, parsedIntent: "secret_change" };
  }
  if (/(force[_\s-]?push|rebase|reset[_\s-]?hard)/i.test(t)) {
    return { category: "deploy", safe: false, parsedIntent: "destructive_deploy" };
  }

  // Безопасные (safe=true) — UI / контент / persona / новости.
  if (/(новост|акци|промокод|publish|объявлен)/i.test(t)) {
    return { category: "news_post", safe: true, parsedIntent: "post_news" };
  }
  if (/(persona|муза говорит|стиль ответа|тон)/i.test(t)) {
    return { category: "persona_tweak", safe: true, parsedIntent: "tweak_persona" };
  }
  if (/(текст на|надпись|подпись|заголов|footer|button)/i.test(t)) {
    return { category: "ui_text", safe: true, parsedIntent: "edit_ui_text" };
  }
  if (/(база знани|kb|knowledge|инструкци)/i.test(t)) {
    return { category: "kb_update", safe: true, parsedIntent: "update_kb" };
  }

  return { category: "unknown", safe: false, parsedIntent: undefined };
}
