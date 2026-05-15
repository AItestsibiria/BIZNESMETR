// Eugene 2026-05-15 Босс «согласие 152-ФЗ при регистрации» — страница
// /privacy с политикой обработки персональных данных. Минимальный текст
// для соответствия 152-ФЗ. Доработать с юристом — ниже placeholder
// с правильной структурой.

import { Link } from "wouter";

export default function PrivacyPage() {
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
            <h2 className="text-lg font-semibold text-white mb-2">1. Общие положения</h2>
            <p className="text-muted-foreground">
              Настоящая Политика определяет порядок обработки персональных данных Пользователей
              сервиса MuzaAi (muzaai.ru, далее — «Сервис»). Обработка ведётся в соответствии с
              Федеральным законом № 152-ФЗ «О персональных данных» от 27 июля 2006 г.
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
              <li>Отозвать согласие на обработку, направив запрос на hello@muziai.ru</li>
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
              Email: <a href="mailto:hello@muziai.ru" className="text-purple-300 underline">hello@muziai.ru</a>
              <br />
              Сайт: <a href="https://muzaai.ru" className="text-purple-300 underline">muzaai.ru</a>
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
