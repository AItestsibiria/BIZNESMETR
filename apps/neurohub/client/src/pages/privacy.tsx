// Eugene 2026-05-15 Босс «согласие 152-ФЗ при регистрации» — страница
// /privacy с политикой обработки персональных данных. Минимальный текст
// для соответствия 152-ФЗ. Доработать с юристом — ниже placeholder
// с правильной структурой.

import { Link } from "wouter";
import { useEffect, useState } from "react";

// Реквизиты оператора подтягиваются из /api/legal/pd-operator
// (server: lib/legalConfig.ts). Fallback — ЗАО «Инфолайн».
const FALLBACK_OPERATOR = {
  entityFullName: "Закрытое акционерное общество «Инфолайн»",
  inn: "7017236261",
  ogrn: "1097017005601",
  address: "634050, г. Томск, пр. Ленина, д. 151/1, корпус 1",
};

export default function PrivacyPage() {
  const [operator, setOperator] = useState(FALLBACK_OPERATOR);
  const [pdRegistered, setPdRegistered] = useState(false);
  const [regNumber, setRegNumber] = useState<string | null>(null);
  const [transborder, setTransborder] = useState<{ enabled: boolean; countries: string[] }>({
    enabled: true,
    countries: ["США"],
  });

  useEffect(() => {
    let alive = true;
    fetch("/api/legal/pd-operator")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j || !j.data) return;
        const d = j.data;
        if (d.operator) setOperator({ ...FALLBACK_OPERATOR, ...d.operator });
        setPdRegistered(Boolean(d.pdRegistered));
        setRegNumber(d.regNumber || null);
        if (d.transborder) setTransborder(d.transborder);
      })
      .catch(() => {
        /* fallback используется */
      });
    return () => {
      alive = false;
    };
  }, []);

  const transborderCountries = transborder.countries.length
    ? transborder.countries.join(", ")
    : "иностранные государства";

  return (
    <div className="min-h-screen pt-20 px-4 pb-12 hero-gradient">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-bold gradient-text mb-6">
          Политика обработки персональных данных
        </h1>
        <p className="text-xs text-muted-foreground mb-8">
          Последнее обновление: 15 мая 2026 г. · MuzaAi (muzaai.ru)
        </p>

        <div className="prose prose-invert max-w-none text-sm leading-relaxed space-y-5">
          <section>
            <h2 className="text-lg font-semibold text-white mb-2">1. Общие положения и оператор</h2>
            <p className="text-muted-foreground">
              Настоящая Политика определяет порядок обработки персональных данных Пользователей
              сервиса MuzaAi (muzaai.ru, далее — «Сервис»). Обработка ведётся в соответствии с
              Федеральным законом № 152-ФЗ «О персональных данных» от 27 июля 2006 г.
            </p>
            <p className="text-muted-foreground mt-2">
              Оператором персональных данных является{" "}
              {operator.entityFullName} (ИНН {operator.inn}, ОГРН {operator.ogrn},
              адрес: {operator.address}).
              {pdRegistered && regNumber
                ? ` Реестровый номер оператора в реестре Роскомнадзора: ${regNumber}.`
                : ""}
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">2. Какие данные обрабатываются</h2>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1">
              <li>Имя (опционально)</li>
              <li>Адрес электронной почты (при регистрации по email)</li>
              <li>Номер мобильного телефона (при регистрации по звонку/SMS)</li>
              <li>IP-адрес, тип браузера, страна, язык (автоматически)</li>
              <li>История генераций (треки, обложки, тексты), создаваемые Пользователем</li>
              <li>Платёжная информация (через Robokassa — мы не храним полные карточные данные)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">3. Цели обработки</h2>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1">
              <li>Идентификация Пользователя и аутентификация в Сервисе</li>
              <li>Предоставление функционала Сервиса (генерация музыки, обложек, текстов)</li>
              <li>Обработка платежей</li>
              <li>Информирование о статусе генерации, новостях Сервиса</li>
              <li>Улучшение качества Сервиса, анализ статистики</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">4. Правовое основание</h2>
            <p className="text-muted-foreground">
              Обработка персональных данных осуществляется на основании согласия субъекта
              персональных данных (ст. 6 ФЗ № 152-ФЗ), выраженного посредством отметки чек-бокса
              при регистрации.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">5. Срок обработки и хранения</h2>
            <p className="text-muted-foreground">
              Персональные данные обрабатываются с момента регистрации до момента отзыва согласия
              или удаления учётной записи Пользователем. Резервные копии хранятся не более 30 дней.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">6. Права Пользователя</h2>
            <p className="text-muted-foreground">
              Пользователь имеет право в любой момент:
            </p>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1 mt-2">
              <li>Получить информацию о своих данных, обрабатываемых в Сервисе</li>
              <li>Потребовать уточнения, блокирования или уничтожения своих данных</li>
              <li>Отозвать согласие на обработку, направив запрос на hello@muzaai.ru</li>
              <li>
                Требовать удаления своих данных — оператор удалит их в срок не более
                10 рабочих дней с момента получения отзыва согласия (при отсутствии
                иных законных оснований для обработки)
              </li>
              <li>Обратиться в Роскомнадзор при нарушении прав</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">7. Безопасность</h2>
            <p className="text-muted-foreground">
              Все соединения с Сервисом шифруются по TLS 1.2+. Пароли хранятся в виде хеша (bcrypt).
              Доступ к серверной базе ограничен. Резервные копии шифруются. Платёжная информация
              передаётся через сертифицированную систему Robokassa.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">8. Передача третьим лицам</h2>
            <p className="text-muted-foreground">
              Персональные данные не передаются третьим лицам, за исключением случаев, когда:
            </p>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1 mt-2">
              <li>Обработка необходима для исполнения договора (платёжная система Robokassa)</li>
              <li>Передача требуется по закону РФ</li>
              <li>Используются обезличенные агрегированные данные для аналитики</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">
              8.1. Трансграничная передача данных
            </h2>
            {transborder.enabled ? (
              <p className="text-muted-foreground">
                Для работы функций интеллектуального помощника «Музa» отдельные
                данные могут передаваться на территорию иностранных государств:{" "}
                <span className="text-white">{transborderCountries}</span> (в
                частности, провайдеру Anthropic, Claude API). Передача
                осуществляется в объёме, необходимом для оказания услуги, с учётом
                требований ч. 3 ст. 12 ФЗ № 152-ФЗ. Подробнее — в{" "}
                <Link href="/consent" className="text-purple-300 underline">
                  Согласии на обработку персональных данных
                </Link>
                .
              </p>
            ) : (
              <p className="text-muted-foreground">
                Трансграничная передача персональных данных не осуществляется.
              </p>
            )}
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">9. Cookies и аналитика</h2>
            <p className="text-muted-foreground">
              Сервис использует cookies для сохранения сессии, настроек пользователя
              (тема, плейлист). Также может использоваться Яндекс.Метрика, VK Pixel для
              сбора обезличенной статистики посещаемости. Пользователь может отключить
              cookies в настройках браузера.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">10. Контакты</h2>
            <p className="text-muted-foreground">
              По всем вопросам обработки персональных данных:
              <br />
              Email: <a href="mailto:hello@muzaai.ru" className="text-purple-300 underline">hello@muzaai.ru</a>
              <br />
              Сайт: <a href="https://muzaai.ru" className="text-purple-300 underline">muzaai.ru</a>
            </p>
            <p className="text-muted-foreground mt-2">
              Отдельный документ —{" "}
              <Link href="/consent" className="text-purple-300 underline">
                Согласие на обработку персональных данных
              </Link>
              .
            </p>
          </section>

          <section className="pt-5 border-t border-white/10">
            <p className="text-xs text-muted-foreground">
              Регистрируясь в Сервисе, Пользователь подтверждает, что ознакомлен с настоящей
              Политикой и даёт согласие на обработку своих персональных данных в соответствии с её положениями.
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
