// Eugene 2026-05-25 Босс «оператор ПДн 152-ФЗ» — страница /consent с
// ОТДЕЛЬНЫМ согласием на обработку персональных данных. С 01.09.2025 такое
// согласие должно быть оформлено отдельным документом (не в составе оферты
// или Политики). Реквизиты оператора подтягиваются из /api/legal/pd-operator
// (server: lib/legalConfig.ts → getLegalConfig). Brand-стиль — как /privacy.

import { Link } from "wouter";
import { useEffect, useState } from "react";

interface PdOperator {
  operator: {
    entityName: string;
    entityFullName: string;
    inn: string;
    ogrn: string;
    address: string;
    email: string;
    phone: string;
  };
  pdRegistered: boolean;
  regNumber: string | null;
  policyUrl: string;
  consentUrl: string;
  transborder: { enabled: boolean; countries: string[] };
}

// Fallback на случай если endpoint недоступен — реквизиты ЗАО «Инфолайн»
// (совпадают с lib/legalConfig.ts LEGAL_DEFAULT). Закон требует чтобы они
// были опубликованы, поэтому дублирование допустимо.
const FALLBACK: PdOperator = {
  operator: {
    entityName: "ЗАО «Инфолайн»",
    entityFullName: "Закрытое акционерное общество «Инфолайн»",
    inn: "7017236261",
    ogrn: "1097017005601",
    address: "634050, г. Томск, пр. Ленина, д. 151/1, корпус 1",
    email: "hello@muzaai.ru",
    phone: "+7 (3822) 50-36-70",
  },
  pdRegistered: false,
  regNumber: null,
  policyUrl: "/privacy",
  consentUrl: "/consent",
  transborder: { enabled: true, countries: ["США"] },
};

export default function ConsentPage() {
  const [cfg, setCfg] = useState<PdOperator>(FALLBACK);

  useEffect(() => {
    let alive = true;
    fetch("/api/legal/pd-operator")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && j.data && j.data.operator) setCfg(j.data as PdOperator);
      })
      .catch(() => {
        /* fallback используется */
      });
    return () => {
      alive = false;
    };
  }, []);

  const o = cfg.operator;
  const countries = cfg.transborder.countries.length
    ? cfg.transborder.countries.join(", ")
    : "иностранные государства";

  return (
    <div className="min-h-screen pt-20 px-4 pb-12 hero-gradient">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl sm:text-3xl font-bold gradient-text mb-6">
          Согласие на обработку персональных данных
        </h1>
        <p className="text-xs text-muted-foreground mb-8">
          Действует с 25 мая 2026 г. · MuzaAi (muzaai.ru)
        </p>

        <div className="prose prose-invert max-w-none text-sm leading-relaxed space-y-5">
          <section>
            <p className="text-muted-foreground">
              Регистрируясь в Сервисе MuzaAi (muzaai.ru) и/или отмечая
              соответствующий чек-бокс, я, как субъект персональных данных,
              свободно, своей волей и в своём интересе даю согласие на обработку
              моих персональных данных на условиях, изложенных ниже, в
              соответствии с Федеральным законом № 152-ФЗ «О персональных данных»
              от 27 июля 2006 г.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">1. Оператор персональных данных</h2>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1">
              <li>Наименование: {o.entityFullName}</li>
              <li>ИНН: {o.inn}</li>
              <li>ОГРН: {o.ogrn}</li>
              <li>Адрес: {o.address}</li>
              <li>
                Email:{" "}
                <a href={`mailto:${o.email}`} className="text-purple-300 underline">
                  {o.email}
                </a>
              </li>
              <li>Телефон: {o.phone}</li>
              {cfg.pdRegistered && cfg.regNumber ? (
                <li>Реестровый номер оператора в реестре Роскомнадзора: {cfg.regNumber}</li>
              ) : null}
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">2. Цели обработки</h2>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1">
              <li>Регистрация, идентификация и аутентификация в Сервисе</li>
              <li>Предоставление функционала (генерация музыки, обложек, текстов)</li>
              <li>Обработка платежей и возвратов</li>
              <li>Информирование о статусе генераций и работе Сервиса</li>
              <li>
                Направление новостей, специальных предложений и рекламных
                сообщений — только при наличии отдельного согласия на их получение
              </li>
              <li>Улучшение качества Сервиса, обезличенная аналитика</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">3. Категории обрабатываемых данных</h2>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1">
              <li>Имя (при указании)</li>
              <li>Адрес электронной почты</li>
              <li>Номер мобильного телефона</li>
              <li>Страна, язык, IP-адрес, тип устройства и браузера</li>
              <li>
                Данные о поведении в Сервисе (история генераций, прослушивания,
                действия в интерфейсе)
              </li>
              <li>
                Платёжные данные обрабатываются платёжной системой Robokassa;
                полные реквизиты банковских карт мы не храним
              </li>
            </ul>
            <p className="text-muted-foreground mt-2">
              Специальные категории персональных данных (раса, политические
              взгляды, состояние здоровья и т.п.) и биометрические данные не
              обрабатываются.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">4. Перечень действий с данными</h2>
            <p className="text-muted-foreground">
              Сбор, запись, систематизация, накопление, хранение, уточнение
              (обновление, изменение), извлечение, использование, передача
              (предоставление, доступ), обезличивание, блокирование, удаление,
              уничтожение. Обработка ведётся как с использованием средств
              автоматизации, так и без таковых.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">
              5. Трансграничная передача данных
            </h2>
            {cfg.transborder.enabled ? (
              <p className="text-muted-foreground">
                Я уведомлён(а) и согласен(на), что для работы функций
                интеллектуального помощника «Музa» отдельные данные могут
                передаваться на территорию следующих иностранных государств:{" "}
                <span className="text-white">{countries}</span> (в частности,
                провайдеру Anthropic, Claude API). Уровень защиты прав субъектов
                персональных данных в указанных государствах оператором учтён.
                Передача осуществляется в объёме, необходимом для оказания услуги.
              </p>
            ) : (
              <p className="text-muted-foreground">
                Трансграничная передача персональных данных не осуществляется.
              </p>
            )}
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">6. Передача третьим лицам</h2>
            <p className="text-muted-foreground">
              Персональные данные могут передаваться третьим лицам только для
              целей, указанных выше: платёжной системе Robokassa (для проведения
              платежей), провайдерам генерации и помощника. Иным лицам данные не
              передаются, кроме случаев, прямо предусмотренных законодательством РФ.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">7. Срок действия согласия</h2>
            <p className="text-muted-foreground">
              Согласие действует с момента его предоставления и до достижения
              целей обработки либо до его отзыва. После прекращения обработки
              данные уничтожаются в срок, не превышающий 30 дней, если иной срок
              не установлен законодательством РФ.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">8. Права субъекта и отзыв согласия</h2>
            <p className="text-muted-foreground">Я вправе в любой момент:</p>
            <ul className="text-muted-foreground list-disc pl-5 space-y-1 mt-2">
              <li>получить информацию об обработке моих персональных данных;</li>
              <li>требовать уточнения, блокирования или уничтожения данных;</li>
              <li>
                отозвать настоящее согласие, направив запрос на{" "}
                <a href={`mailto:${o.email}`} className="text-purple-300 underline">
                  {o.email}
                </a>{" "}
                или удалив учётную запись в личном кабинете;
              </li>
              <li>
                требовать удаления своих данных — оператор удалит их в срок не
                более 10 рабочих дней с момента получения отзыва согласия, если
                нет иных законных оснований для обработки;
              </li>
              <li>обратиться в Роскомнадзор или в суд при нарушении прав.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-2">9. Связанные документы</h2>
            <p className="text-muted-foreground">
              Подробный порядок обработки изложен в{" "}
              <Link href="/privacy" className="text-purple-300 underline">
                Политике обработки персональных данных
              </Link>
              . Условия оказания услуг — в{" "}
              <Link href="/oferta" className="text-purple-300 underline">
                Публичной оферте
              </Link>
              .
            </p>
          </section>

          <section className="pt-5 border-t border-white/10">
            <p className="text-xs text-muted-foreground">
              Отмечая чек-бокс согласия и/или продолжая использование Сервиса, я
              подтверждаю, что ознакомлен(а) с настоящим Согласием, понимаю его
              содержание и принимаю его условия.
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
