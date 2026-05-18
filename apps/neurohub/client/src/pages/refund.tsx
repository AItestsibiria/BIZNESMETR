// Eugene 2026-05-18 Босс «Robokassa правила сайта — политика возврата».
// Описывает порядок возврата средств — обязательное требование для
// продажи дистанционных услуг через интернет-эквайринг (ст. 32 Закона
// о защите прав потребителей + правила Robokassa).

import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";

interface LegalConfig {
  email: string;
  phone: string;
  brand: string;
  domain: string;
}

export default function RefundPage() {
  const { data: legal } = useQuery<LegalConfig>({
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
          Политика возврата средств
        </h1>
        <p className="text-xs font-mono text-muted-foreground mb-8">
          Последнее обновление: 18 мая 2026 г. · {legal?.brand || "MuzaAi"} ({legal?.domain || "muzaai.ru"})
        </p>

        <div className="prose prose-invert max-w-none text-sm leading-relaxed space-y-5">
          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">1. Автоматический возврат при технических сбоях</h2>
            <p className="text-muted-foreground">
              Если ИИ-провайдер не смог сгенерировать музыкальное произведение (трек), обложку
              или текст по техническим причинам (отказ внешнего сервиса, превышение времени
              ожидания, ошибка генерации) — стоимость услуги <b className="text-white">автоматически
              возвращается на внутренний баланс</b> Заказчика в течение 1–5 минут после фиксации
              сбоя. Никаких заявлений писать не нужно.
            </p>
            <p className="text-muted-foreground mt-2">
              Внутренний баланс может быть использован для повторной попытки генерации или
              для других услуг сервиса.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">2. Возврат на банковскую карту (СБП)</h2>
            <p className="text-muted-foreground">
              Возврат денежных средств на банковскую карту (или счёт СБП), с которой производилась
              оплата, возможен в следующих случаях:
            </p>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1 mt-2">
              <li>
                Сервис фактически не оказал ни одной услуги после оплаты (баланс не был израсходован)
                и Заказчик хочет вернуть всю сумму.
              </li>
              <li>
                Сервис прекращает оказание услуг по техническим/юридическим причинам — возврат
                делается по инициативе Исполнителя на остаток баланса.
              </li>
              <li>
                Иные случаи, предусмотренные ст. 32 Закона РФ «О защите прав потребителей» —
                Заказчик вправе отказаться от исполнения договора в любое время при условии
                оплаты Исполнителю фактически понесённых расходов.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">3. Порядок подачи заявления на возврат</h2>
            <p className="text-muted-foreground">
              Для возврата средств на банковскую карту Заказчик направляет заявление на
              электронную почту:{" "}
              <a href={`mailto:${legal?.email || "hello@muzaai.ru"}`} className="text-purple-300 underline">
                {legal?.email || "hello@muzaai.ru"}
              </a>
              {" "}с указанием:
            </p>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1 mt-2">
              <li>ФИО Заказчика;</li>
              <li>email, использованный при регистрации в сервисе;</li>
              <li>номер счёта/инвойса (виден в личном кабинете → История платежей);</li>
              <li>дата платежа и сумма;</li>
              <li>основание возврата (краткое описание);</li>
              <li>контактный телефон.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">4. Сроки возврата</h2>
            <p className="text-muted-foreground">
              Срок рассмотрения заявления — до 10 рабочих дней с момента получения. Возврат
              на банковскую карту осуществляется через платёжный сервис «Робокасса». Срок
              зачисления денежных средств на карту Заказчика — до 30 дней (зависит от
              банка-эмитента карты).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">5. Случаи, когда возврат не производится</h2>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1">
              <li>
                Услуга была полностью оказана (трек/обложка/текст сгенерированы и доступны в
                личном кабинете Заказчика) — оплаченная сумма возврату не подлежит.
              </li>
              <li>
                Заказчик не доволен творческим результатом, при том что услуга была технически
                оказана — субъективное недовольство не является основанием для возврата.
              </li>
              <li>
                Заказчик нарушил условия публичной оферты или использовал сервис для запрещённого
                контента — Исполнитель вправе расторгнуть договор без возврата средств.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">6. Возврат при сбоях платежной системы</h2>
            <p className="text-muted-foreground">
              Если списание средств с карты произошло, но баланс в личном кабинете не пополнился
              (технический сбой Robokassa или сервиса) — Заказчик направляет письмо на email с
              приложением чека/выписки. Сумма зачисляется на внутренний баланс или возвращается
              на карту по выбору Заказчика в течение 3 рабочих дней.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">7. Контакты для обращений</h2>
            <p className="text-muted-foreground">
              Email: <a href={`mailto:${legal?.email || "hello@muzaai.ru"}`} className="text-purple-300 underline">{legal?.email || "hello@muzaai.ru"}</a>
              <br />
              Телефон: <span className="font-mono">{legal?.phone || "—"}</span>
              <br />
              Дополнительные контакты — на странице{" "}
              <Link href="/contacts" className="text-purple-300 underline">Контакты</Link>.
            </p>
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
