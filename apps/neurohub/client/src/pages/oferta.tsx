// Eugene 2026-05-18 Босс «Robokassa правила сайта — оферта обязательна».
// Публичная оферта на оказание услуг по созданию музыкальных произведений
// с помощью ИИ. Юр.реквизиты подгружаются из /api/legal/config (источник —
// server/lib/legalConfig.ts, заполняется через ENV на VPS).
//
// Источник требования: справка Robokassa
// «Если описание товаров и услуг, контакты, реквизиты размещены — оферта
//  необязательна. Однако оферта — это гарантия сохранности средств и
//  страховка от непредвиденных штрафов.»
// (robokassa.com/content/connection/, WebSearch 2026-05-18)

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

export default function OfertaPage() {
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
          Публичная оферта на оказание услуг
        </h1>
        <p className="text-xs font-mono text-muted-foreground mb-8">
          Последнее обновление: 18 мая 2026 г. · {legal?.brand || "MuzaAi"} ({legal?.domain || "muzaai.ru"})
        </p>

        <div className="prose prose-invert max-w-none text-sm leading-relaxed space-y-5">
          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">1. Общие положения</h2>
            <p className="text-muted-foreground">
              Настоящий документ является публичной офертой (ст. 437 ГК РФ) — предложением
              {" "}<b className="text-white">{legal?.entityFullName || "ИСПОЛНИТЕЛЯ"}</b>{" "}
              (далее — «Исполнитель») заключить договор возмездного оказания услуг по созданию
              музыкальных произведений с помощью технологий искусственного интеллекта (далее —
              «Услуги») на условиях, изложенных ниже.
            </p>
            <p className="text-muted-foreground mt-2">
              Полным и безоговорочным акцептом настоящей оферты в соответствии со ст. 438 ГК РФ
              является оплата Услуг Пользователем (далее — «Заказчик»).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">2. Реквизиты Исполнителя</h2>
            <ul className="text-muted-foreground space-y-1 font-mono text-xs">
              <li>Наименование: <span className="text-white">{legal?.entityFullName || "—"}</span></li>
              <li>ИНН: <span className="text-white">{legal?.inn || "—"}</span></li>
              <li>ОГРН/ОГРНИП: <span className="text-white">{legal?.ogrn || "—"}</span></li>
              <li>Юр. адрес: <span className="text-white">{legal?.legalAddress || "—"}</span></li>
              <li>Email: <span className="text-white">{legal?.email || "—"}</span></li>
              <li>Телефон: <span className="text-white">{legal?.phone || "—"}</span></li>
              <li>Сайт: <span className="text-white">{legal?.domain || "muzaai.ru"}</span></li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">3. Предмет договора</h2>
            <p className="text-muted-foreground">
              Исполнитель обязуется оказать Заказчику услуги по созданию музыкальных произведений
              (треков), обложек, текстов песен (далее — «Контент») посредством программных
              алгоритмов искусственного интеллекта. Заказчик обязуется оплатить услуги в порядке
              и сроки, установленные настоящей офертой.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">4. Стоимость услуг и порядок оплаты</h2>
            <p className="text-muted-foreground">
              Стоимость услуг определяется на странице сервиса в момент оплаты. Оплата производится
              в безналичном порядке через платёжный сервис ООО «Робокасса» с использованием:
            </p>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1 mt-2">
              <li>банковских карт (Visa, MasterCard, МИР)</li>
              <li>Системы Быстрых Платежей (СБП)</li>
              <li>иных способов оплаты, доступных у платёжного агента</li>
            </ul>
            <p className="text-muted-foreground mt-2">
              Услуги оплачиваются в форме предоплаты (пополнения внутреннего баланса). По факту
              оплаты Заказчик получает кассовый чек на электронную почту в соответствии с
              требованиями Федерального закона № 54-ФЗ «О применении контрольно-кассовой техники».
            </p>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">5. Права и обязанности сторон</h2>
            <p className="text-muted-foreground">
              <b className="text-white">5.1.</b> Исполнитель обязуется обеспечить работу сервиса
              на условиях, описанных на сайте, и предоставить Заказчику возможность создавать
              Контент путём списания средств с внутреннего баланса.
            </p>
            <p className="text-muted-foreground mt-2">
              <b className="text-white">5.2.</b> Заказчик обязуется не использовать сервис для
              создания контента, нарушающего законодательство РФ (экстремизм, разжигание розни,
              призывы к насилию, нарушение авторских прав третьих лиц, и т.п.).
            </p>
            <p className="text-muted-foreground mt-2">
              <b className="text-white">5.3.</b> Исключительные права на сгенерированный Контент
              принадлежат Заказчику с момента генерации (если иное не предусмотрено отдельным
              соглашением).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">6. Возврат средств</h2>
            <p className="text-muted-foreground">
              Порядок возврата средств описан в{" "}
              <Link href="/refund" className="text-purple-300 underline">Политике возврата</Link>.
              В случае технического сбоя при генерации (Suno/ИИ не вернул результат, упал
              провайдер) средства автоматически возвращаются на внутренний баланс Заказчика
              в течение нескольких минут после фиксации сбоя.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">7. Ответственность</h2>
            <p className="text-muted-foreground">
              Исполнитель не несёт ответственности за невозможность оказания услуг по причинам,
              не зависящим от него (сбои интернет-провайдера, отказ внешних ИИ-сервисов,
              форс-мажор, действия третьих лиц). Ответственность Исполнителя ограничена
              суммой, уплаченной Заказчиком за конкретную неоказанную услугу.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">8. Персональные данные</h2>
            <p className="text-muted-foreground">
              Порядок обработки персональных данных определён в{" "}
              <Link href="/privacy" className="text-purple-300 underline">Политике конфиденциальности</Link>.
              Принимая настоящую оферту, Заказчик подтверждает согласие на обработку своих
              персональных данных в целях, предусмотренных указанным документом.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-sans font-bold text-white mb-2">9. Заключительные положения</h2>
            <p className="text-muted-foreground">
              Договор действует с момента акцепта (оплаты) до полного исполнения сторонами своих
              обязательств. Споры разрешаются путём переговоров; при недостижении согласия —
              в суде по месту нахождения Исполнителя в соответствии с законодательством РФ.
              Исполнитель вправе изменять условия оферты в одностороннем порядке с публикацией
              новой редакции на сайте; продолжение использования сервиса означает согласие
              с новой редакцией.
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
