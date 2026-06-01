// Eugene 2026-05-18 Босс «Robokassa правила сайта — контакты, ИНН/ОГРН,
// юр.адрес». Все данные подгружаются из /api/legal/config (server/lib/
// legalConfig.ts), который читает их из ENV на VPS — это позволяет
// Боссу обновить реквизиты без релиза кода.
//
// Источник требования: справка Robokassa
// «Электронная почта и телефон для связи есть на сайте, не скрыты
//  и доступны. ИНН/ОГРН компании, данные самозанятого размещены
//  в подвале сайта.»

import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";

interface LegalConfig {
  entityName: string;
  entityFullName: string;
  inn: string;
  ogrn: string;
  legalAddress: string;
  phone: string;
  email: string;
  domain: string;
  brand: string;
  complete: boolean;
}

export default function ContactsPage() {
  const { data: legal, isLoading } = useQuery<LegalConfig>({
    queryKey: ["/api/legal/config"],
    queryFn: async () => {
      const r = await fetch("/api/legal/config");
      return r.json();
    },
    staleTime: 60_000,
  });

  return (
    <div className="min-h-screen pt-20 px-4 pb-12 hero-gradient">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-display font-bold gradient-text mb-6">
          Контакты
        </h1>
        <p className="text-xs font-mono text-muted-foreground mb-8">
          {legal?.brand || "MuzaAi"} · {legal?.domain || "muzaai.ru"}
        </p>

        {legal && !legal.complete && (
          <div className="glass-card rounded-2xl p-4 border border-amber-500/30 mb-6">
            <p className="text-xs text-amber-300">
              ⚠️ Реквизиты Исполнителя заполняются. До завершения настройки приём платежей может
              работать в тестовом режиме. По всем вопросам — email ниже.
            </p>
          </div>
        )}

        <div className="space-y-6">
          <section className="glass-card rounded-2xl p-6 border border-purple-500/20">
            <h2 className="text-lg font-sans font-bold text-white mb-3">Юридические реквизиты</h2>
            <dl className="text-sm font-mono space-y-2">
              <div className="flex flex-col sm:flex-row sm:gap-3">
                <dt className="text-muted-foreground sm:w-40">Наименование:</dt>
                <dd className="text-white">{isLoading ? "…" : (legal?.entityFullName || "—")}</dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:gap-3">
                <dt className="text-muted-foreground sm:w-40">ИНН:</dt>
                <dd className="text-white">{isLoading ? "…" : (legal?.inn || "—")}</dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:gap-3">
                <dt className="text-muted-foreground sm:w-40">ОГРН / ОГРНИП:</dt>
                <dd className="text-white">{isLoading ? "…" : (legal?.ogrn || "—")}</dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:gap-3">
                <dt className="text-muted-foreground sm:w-40">Юр. адрес:</dt>
                <dd className="text-white">{isLoading ? "…" : (legal?.legalAddress || "—")}</dd>
              </div>
            </dl>
          </section>

          <section className="glass-card rounded-2xl p-6 border border-cyan-500/20">
            <h2 className="text-lg font-sans font-bold text-white mb-3">Связаться с нами</h2>
            <dl className="text-sm space-y-2">
              <div className="flex flex-col sm:flex-row sm:gap-3">
                <dt className="text-muted-foreground sm:w-40">Email поддержки:</dt>
                <dd>
                  <a
                    href={`mailto:${legal?.email || "hello@muzaai.ru"}`}
                    className="text-cyan-300 underline font-mono"
                  >
                    {legal?.email || "hello@muzaai.ru"}
                  </a>
                </dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:gap-3">
                <dt className="text-muted-foreground sm:w-40">Телефон:</dt>
                <dd className="text-white font-mono">{isLoading ? "…" : (legal?.phone || "—")}</dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:gap-3">
                <dt className="text-muted-foreground sm:w-40">Сайт:</dt>
                <dd>
                  <a
                    href={`https://${legal?.domain || "muzaai.ru"}`}
                    className="text-cyan-300 underline font-mono"
                  >
                    {legal?.domain || "muzaai.ru"}
                  </a>
                </dd>
              </div>
            </dl>
          </section>

          <section className="glass-card rounded-2xl p-6 border border-amber-500/20">
            <h2 className="text-lg font-sans font-bold text-white mb-3">Описание услуг</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {legal?.brand || "MuzaAi"} — сервис создания музыкальных произведений с помощью
              искусственного интеллекта. Пользователи могут:
            </p>
            <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1 mt-3">
              <li>Генерировать оригинальные музыкальные композиции (вокальные и инструментальные)</li>
              <li>Создавать обложки для треков с помощью AI image generation</li>
              <li>Генерировать тексты песен в различных жанрах</li>
              <li>Сохранять и делиться созданными произведениями</li>
            </ul>
            <p className="text-sm text-muted-foreground mt-3">
              Тарифы и стоимость услуг — на странице{" "}
              <Link href="/templates" className="text-purple-300 underline">Шаблоны</Link>{" "}
              и в личном кабинете при пополнении баланса. Условия предоставления услуг —
              в{" "}
              <Link href="/oferta" className="text-purple-300 underline">Публичной оферте</Link>.
            </p>
          </section>

          <section className="glass-card rounded-2xl p-6 border border-purple-500/20">
            <h2 className="text-lg font-sans font-bold text-white mb-3">Юридические документы</h2>
            <ul className="text-sm space-y-2">
              <li>
                <Link href="/oferta" className="text-purple-300 underline">
                  Публичная оферта (договор оказания услуг)
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="text-purple-300 underline">
                  Политика конфиденциальности (152-ФЗ)
                </Link>
              </li>
              <li>
                <Link href="/consent" className="text-purple-300 underline">
                  Согласие на обработку персональных данных (152-ФЗ)
                </Link>
              </li>
              <li>
                <Link href="/refund" className="text-purple-300 underline">
                  Политика возврата средств
                </Link>
              </li>
            </ul>
          </section>
        </div>

        <div className="mt-10 text-center">
          <Link href="/" className="text-sm text-purple-300 hover:text-purple-200 underline">
            ← Вернуться на главную
          </Link>
        </div>
      </div>
    </div>
  );
}
