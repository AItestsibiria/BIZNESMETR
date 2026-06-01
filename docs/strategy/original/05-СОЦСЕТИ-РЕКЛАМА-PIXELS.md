# 05. СОЦСЕТИ + РЕКЛАМА + PIXEL TRACKING  
  
## §0. ИДЕЯ  
  
Реклама работает на 100% только когда платформа **отдаёт обратно правильные события** — иначе алгоритм обучается на неполных данных, CPM растёт, ROI падает.  
  
В этом файле:  
1. **Pixel-стек** (VK Pixel, Yandex Метрика, MyTarget, Meta — на будущее).  
2. **UTM-стандарт** проекта.  
3. **Каталог событий** (5 базовых + 12 продвинутых).  
4. **Server-side tracking** через Conversions API.  
5. **Аудитории и lookalike**.  
6. **Автопостинг** (VK / Telegram-канал) — ContentAgent публикует трек дня.  
  
---  
  
## §1. ПИКСЕЛИ — КОТОРЫЕ ОБЯЗАТЕЛЬНО, КОТОРЫЕ ПОТОМ  
  
### §1.1 База (ставим в Спринт 1)  
  
| Пиксель | Зачем | Источник трафика |  
|---|---|---|  
| **Yandex Метрика** + Цели | веб-аналитика, отчёты, цели | организика, директ, всё |  
| **VK Pixel** + конверсии | оптимизация рекламы в VK | таргет VK Ads |  
  
### §1.2 По мере роста  
  
| Пиксель | Когда подключить |  
|---|---|  
| **Top.Mail.Ru / MyTarget** | если запускаем рекламу через MyTarget |  
| **Meta Pixel + Conversions API** | если ставим VPN-аудиторию (фб/инстаграм) |  
| **Google Tag Manager + GA4** | если выходим за пределы РФ |  
| **AppMetrica** | если делаем мобильное приложение |  
  
### §1.3 Хранение настроек  
  
```sql  
CREATE TABLE pixel_configs (  
  slug TEXT PRIMARY KEY,  -- 'vk', 'yandex', 'mailru', 'meta'  
  enabled INTEGER DEFAULT 1,  
  config TEXT NOT NULL,  -- JSON: { pixel_id, access_token, ... }  
  notes TEXT,  
  updated_at TEXT  
);  
```  
  
Меняем настройки **из админки**, без релиза. Если пиксель скомпрометирован — выключаем за секунду.  
  
---  
  
## §2. UTM-СТАНДАРТ MUZIAI  
  
### §2.1 Формат  
  
```  
?utm_source=<канал>  
\&utm_medium=<тип>  
\&utm_campaign=<кампания>  
\&utm_content=<креатив>  
\&utm_term=<ключ>      (опц.)  
```  
  
### §2.2 Словарь значений  
  
**utm_source** (где увидел):  
- `vk` `tg` `yandex` `google` `instagram` `email` `referral` `partner` `direct`  
  
**utm_medium** (как платим / тип):  
- `paid` `organic` `social` `cpc` `email` `cpa` `direct`  
  
**utm_campaign** (про что):  
- `wedding_2026q2` `birthday_2026q2` `corporate_anthem` `gift_mom` `apology` `funnel_top`  
  
**utm_content** (какой креатив):  
- `video_15s_v1` `static_blue` `text_only` `carousel_3` `tiktok_remix`  
  
**Пример:**  
```  
https://podaripesnu.ru/?utm_source=vk\&utm_medium=paid\&utm_campaign=wedding_2026q2  
\&utm_content=carousel_3  
```  
  
### §2.3 Обработка на сайте  
  
Скрипт сразу сохраняет UTM в `localStorage` + cookie на 30 дней.  
  
При регистрации → копируется в `tracking_attribution`:  
  
```sql  
CREATE TABLE tracking_attribution (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  user_id INTEGER,  
  lead_id INTEGER,  
  -- First-touch:  
  first_utm_source TEXT,  
  first_utm_medium TEXT,  
  first_utm_campaign TEXT,  
  first_utm_content TEXT,  
  first_referer TEXT,  
  first_landing_page TEXT,  
  first_seen_at TEXT,  
  -- Last-touch (перед conversion):  
  last_utm_source TEXT,  
  last_utm_medium TEXT,  
  last_utm_campaign TEXT,  
  last_utm_content TEXT,  
  last_seen_at TEXT,  
  -- Click IDs (для server-side):  
  yandex_yclid TEXT,  
  vk_clickid TEXT,  
  google_gclid TEXT,  
  meta_fbclid TEXT,  
  -- Гео и устройство:  
  country TEXT, city TEXT, ip TEXT,  
  device TEXT, browser TEXT, os TEXT  
);  
```  
  
---  
  
## §3. КАТАЛОГ СОБЫТИЙ  
  
### §3.1 Базовый набор (5 событий — Спринт 1)  
  
| Событие | Когда | VK название | Yandex название (Цель) |  
|---|---|---|---|  
| `page_view` | каждый просмотр | `pageView` | (автоматически) |  
| `lead` | оставил email/тг или дошёл до /pricing | `lead` | `cel_lead` |  
| `register` | создал аккаунт | `complete_registration` | `cel_register` |  
| `first_demo` | первая генерация | `add_to_cart` | `cel_first_demo` |  
| `purchase` | первый платёж succeeded | `purchase` (с value) | `cel_purchase` (с цена) |  
  
### §3.2 Продвинутый набор (Спринт 4-5)  
  
| Событие | Когда |  
|---|---|  
| `view_pricing` | открыл /pricing |  
| `view_track` | открыл публичный трек в ленте |  
| `play_track` | нажал play (после 5 сек) |  
| `share_track` | нажал «Поделиться» |  
| `paywall_shown` | увидел paywall |  
| `paywall_abandoned` | закрыл без оплаты |  
| `payment_initiated` | перешёл в Robokassa |  
| `repeat_purchase` | 2-я и далее покупка |  
| `subscribe_telegram` | подписался на Telegram-бота |  
| `chat_started` | начал диалог в боте |  
| `b2b_inquiry` | юрлицо запросило счёт |  
| `referral_invite` | поделился реферальной ссылкой |  
  
### §3.3 Реализация — единый клиентский tracker  
  
```typescript  
// client/src/lib/tracker.ts  
type EventName = 'lead' | 'register' | 'first_demo' | 'purchase' | ...;  
  
class Tracker {  
  track(name: EventName, params: Record<string, any> = {}) {  
    // 1. Yandex Метрика  
    if (window.ym) {  
      window.ym(env.YM_COUNTER_ID, 'reachGoal', `cel_${name}`, params);  
    }  
    // 2. VK Pixel  
    if (window.VK?.Retargeting) {  
      window.VK.Retargeting.Event(this.mapToVK(name), params);  
    }  
    // 3. Серверная копия (для Conversions API)  
    fetch('/api/tracking/event', {  
      method: 'POST',  
      headers: { 'Content-Type': 'application/json' },  
      body: JSON.stringify({ name, params, ts: Date.now() }),  
      keepalive: true,  
    });  
  }  
}  
  
export const tracker = new Tracker();  
```  
  
---  
  
## §4. SERVER-SIDE TRACKING (Conversions API)  
  
### §4.1 Зачем  
  
Браузерные пиксели режутся:  
- Adblocker'ами (\~30% юзеров).  
- Safari ITP / Firefox ETP (теряются cookies > 7 дней).  
- Apple Mail Privacy (открытие email).  
  
**Решение:** дублировать события **с сервера** через официальные Conversions API:  
- VK Conversions API (новое, есть для рекламы).  
- Yandex Метрика server-side `/api/v1/visit` (есть, но мало кто использует).  
- Meta Conversions API (для FB, если делаем).  
  
### §4.2 Архитектура  
  
```  
[Клиент] ──→ pixel/ym (browser)  
   │  
   ▼  
[/api/tracking/event] (наш backend)  
   │  
   ├──→ pixel_events (БД, для агентов)  
   ├──→ events bus (для CRM)  
   └──→ async worker → VK Conversions API + YM /visit  
```  
  
### §4.3 Таблица  
  
```sql  
CREATE TABLE pixel_events (  
  id INTEGER PRIMARY KEY AUTOINCREMENT,  
  user_id INTEGER,  
  lead_id INTEGER,  
  event_name TEXT NOT NULL,  
  params TEXT,  -- JSON  
  -- Дедуп:  
  client_event_id TEXT UNIQUE,  -- генерируется на клиенте, чтобы не дублировать с server side  
  -- Доставка к провайдерам:  
  vk_status TEXT CHECK(vk_status IN ('queued', 'sent', 'failed', 'skipped')) DEFAULT 'queued',  
  ym_status TEXT CHECK(ym_status IN ('queued', 'sent', 'failed', 'skipped')) DEFAULT 'queued',  
  vk_error TEXT, ym_error TEXT,  
  -- Атрибуция:  
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,  
  yclid TEXT, vk_clickid TEXT, fbclid TEXT,  
  -- Контекст:  
  ip TEXT, ua TEXT, page_url TEXT,  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  
);  
CREATE INDEX pe_status_idx ON pixel_events(vk_status, ym_status, created_at);  
```  
  
### §4.4 Worker  
  
```typescript  
// plugins/pixels/worker.ts  
async function flushQueue() {  
  const queued = db.select().from(pixel_events)  
    .where(or(eq(vk_status, 'queued'), eq(ym_status, 'queued')))  
    .limit(100).all();  
  
  for (const ev of queued) {  
    if (ev.vk_status === 'queued') await sendToVK(ev);  
    if (ev.ym_status === 'queued') await sendToYM(ev);  
  }  
}  
  
setInterval(flushQueue, 30_000); // каждые 30 сек  
```  
  
Дедуп между browser и server pixel — через `client_event_id` (UUID, генерируется на клиенте, передаётся в обе стороны).  
  
---  
  
## §5. АУДИТОРИИ И LOOKALIKE  
  
### §5.1 Что выгружаем в рекламные кабинеты  
  
| Аудитория | Кому показываем |  
|---|---|  
| **Все купившие** | exclude (не тратим деньги) — кроме retention-кампаний |  
| **Все попробовавшие демо без покупки** (за 30 дней) | retargeting со скидкой |  
| **Champions (RFM)** | upsell premium SKU |  
| **At Risk (RFM)** | реактивация |  
| **Hot leads (lead_score >70)** | агрессивный retargeting |  
| **Все registered за 30 дней** | basis для lookalike |  
  
### §5.2 Технически  
  
В VK Ads / MyTarget — загрузить аудиторию через email или phone (хешированные SHA-256).  
  
```typescript  
// plugins/pixels/audiences.ts  
export async function exportAudience(segment: string): Promise<string[]> {  
  const users = await db.select({ email: users.email })  
    .from(users)  
    .where(/* по сегменту */);  
  return users.map(u => sha256(u.email.toLowerCase().trim()));  
}  
  
// Cron: раз в неделю обновляет аудитории через VK API  
async function syncAudiences() {  
  const segments = ['triedNoPaid', 'champions', 'atRisk', 'hot_leads'];  
  for (const seg of segments) {  
    const hashes = await exportAudience(seg);  
    await uploadVKAudience(seg, hashes);  
  }  
}  
```  
  
### §5.3 Lookalike  
  
В VK Ads — на основе выгруженной аудитории «все купившие». Платформа сама находит похожих по интересам/поведению.  
  
---  
  
## §6. АВТОПОСТИНГ (распределённое продвижение)  
  
### §6.1 Идея  
  
ContentAgent (см. файл 03 §2.9) публикует **трек дня** в социальные каналы.  
  
| Канал | Что постим | Частота |  
|---|---|---|  
| Telegram-канал @MuziAI | трек + текст + ссылка на сайт | 1-3 в день |  
| Сообщество VK | трек + обложка + кнопка «Создать свой» | 1-2 в день |  
| Reels / Shorts (вручную) | 15-сек обрезка + автогенерируемое видео обложки | 1 в неделю |  
  
### §6.2 Что считается «треком дня»  
  
- `is_public = 1` AND `created_at > daysAgo(2)`  
- разрешение автора (флаг `users.allow_repost = true` или индивидуально через UI после генерации: «Можно ли разместить ваш трек?»)  
- score (см. файл 03 §7) > порога  
  
### §6.3 VK API  
  
```typescript  
// plugins/social-publish/vk.ts  
async function postToVK(track: Generation) {  
  const audio = await uploadAudioToVK(track.audioUrl);  
  const cover = await uploadPhotoToVK(track.imageUrl);  
   
await fetch('https://api.vk.com/method/wall.post', {  
    method: 'POST',  
    body: new URLSearchParams({  
      owner_id: `-${env.VK_GROUP_ID}`,  
      from_group: '1',  
      message: buildPostText(track),  
      attachments: `${audio.id},${cover.id}`,  
      access_token: env.VK_ACCESS_TOKEN,  
      v: '5.199',  
    }),  
  });  
}  
  
function buildPostText(t: Generation): string {  
  return `ðµ «${t.displayTitle}»\\n\\nТрек создан в MuziAI за 2 минуты по короткому описанию. Хочешь свою песню?\\n\\nð podaripesnu.ru/?utm_source=vk\&utm_medium=organic\&utm_campaign=track_of_day`;  
}  
```  
  
### §6.4 Telegram-канал  
  
```typescript  
async function postToTelegramChannel(track: Generation) {  
  // Скачиваем трек локально, шлём как audio  
  const audioBuffer = await downloadAudio(track.audioUrl);  
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendAudio`, {  
    method: 'POST',  
    body: buildFormData({  
      chat_id: env.TG_CHANNEL_ID,  
      audio: audioBuffer,  
      title: track.displayTitle,  
      caption: 'ðµ ...',  
      // inline keyboard:  
      reply_markup: JSON.stringify({  
        inline_keyboard: [[  
          { text: 'ð¶ Создать свою', url: 'https://podaripesnu.ru/?utm_source=tg\&utm_campaign=track_of_day' }  
        ]]  
      }),  
    }),  
  });  
}  
```  
  
### §6.5 Расписание и человеческий контроль  
  
ContentAgent НЕ публикует автоматически без ревью. Workflow:  
  
1. ContentAgent выбирает кандидатов → создаёт `pending_post(track_id, channel, scheduled_for, status='pending_review')`.  
2. Админ в дашборде видит карточки → может одобрить / отклонить / отредактировать текст.  
3. После approve → status='approved', cron публикует в `scheduled_for`.  
4. После публикации — `status='published'` + ссылка на пост.  
  
**Опциональный auto-publish** для треков от Champion-юзеров с >5 апвоутами в ленте (доверенный контент).  
  
---  
  
## §7. ИЗМЕРЕНИЕ ROI РЕКЛАМЫ  
  
### §7.1 Метрика  
  
```  
ROI = (Доход от канала - Затраты на канал) / Затраты на канал × 100%  
```  
  
Считается на любой период по `tracking_attribution` (first-touch + last-touch).  
  
### §7.2 Виджет в дашборде (см. файл 03 §8)  
  
| Канал | Затраты | Лиды | Регистрации | Покупки | Выручка | ROI |  
|---|---|---|---|---|---|---|  
| VK paid wedding | 12 000 ₽ | 480 | 142 | 28 | 18 700 ₽ | +56% |  
| Yandex Direct b-day | 8 500 ₽ | 290 | 91 | 15 | 6 200 ₽ | -27% |  
| Telegram organic | 0 ₽ | 320 | 110 | 22 | 9 800 ₽ | ∞ |  
| Direct/SEO | 0 ₽ | 510 | 180 | 38 | 21 200 ₽ | ∞ |  
  
Затраты по каналам — заводятся в админке (поле `marketing_spend(channel, date, amount)`).  
  
### §7.3 Ежедневный alerting  
  
Если ROI канала упал ниже X% — alert в Telegram админу (плагин notifications). Можно временно паузить кампанию через VK API.  
  
---  
  
## §8. КОНКРЕТНЫЙ ПЛАН ЗАПУСКА РЕКЛАМЫ  
  
### §8.1 VK Ads — кампания «Свадебная песня»  
  
**Сегмент:** женщины 22-35, в браке/в отношениях, интересы «свадьба», «торжества», гео РФ + СНГ.  
  
**Креативы:**  
- Карусель 3 слайда: «Сделайте песню жениху», «За 5 минут», «От 299 ₽»  
- Видео 15 сек с реальным треком из ленты + обложка  
- Текст: «Песня вместо открытки. Прислал — растрогал»  
  
**Целевое действие:** регистрация → демо.  
  
**Лимит:** 500 ₽/день первые 3 дня, потом — на основе CPL.  
  
### §8.2 Telegram — посевы в свадебных каналах  
  
Ручные посевы у админов каналов «Свадьба 2026», «Невеста». Текст: «попробуй сделать песню жениху по этой ссылке, первый трек бесплатно».  
  
UTM `?utm_source=tg\&utm_medium=cpa\&utm_campaign=wedding_seed\&utm_content=channel_NAME`.  
  
### §8.3 Яндекс.Директ  
  
Поисковая кампания по ключам:  
- `песня в подарок маме на 60`  
- `песня на свадьбу друзьям`  
- `песня в подарок мужу`  
- `корпоративный гимн на заказ`  
  
CPC ставка → начинаем с 15 ₽, оптимизация по conversion.  
  
### §8.4 Email-партнёрки  
  
Договариваемся со свадебными агентствами / event-площадками о реферальной ссылке. Они получают 10% с первой покупки приведённого клиента.  
  
UTM `?utm_source=referral\&utm_medium=cpa\&utm_campaign=partner_NAME`.  
  
---  
  
## §9. PIXEL CONSENT (закон)  
  
В РФ — 152-ФЗ о персональных данных. Для пикселей нужно:  
  
1. **Cookie-баннер** на сайте: «Используем cookies для работы и аналитики. Согласны?»  
2. **Соглашение на обработку** при регистрации: явный чекбокс.  
3. **Политика конфиденциальности** доступна по footer-ссылке.  
4. **Настройки приватности**: пользователь может отключить marketing-cookies в настройках.  
  
Реализация:  
- Cookie-баннер — компонент `<ConsentBanner />` в frontend, до согласия пиксели не инициализируются.  
- Поле `users.marketing_opt_in` (default 0).  
- Pixel-вызовы делаются только если `marketing_opt_in = 1` ИЛИ для transactional события.  
  
---  
  
## §10. ИНТЕГРАЦИЯ С АГЕНТАМИ  
  
| Агент | Что использует из этого файла |  
|---|---|  
| **LeadHunter** | UTM при первом визите, события `lead` |  
| **ScoutAgent** | парсит UTM, fbclid, yclid |  
| **WelcomeAgent** | сегментирует welcome-письма по first_utm_campaign |  
| **ConversionAgent** | server-side покупка → `purchase` событие в VK Conversions |  
| **RetentionAgent** | использует аудитории для retargeting |  
| **ContentAgent** | автопостинг через VK/Telegram API |  
  
---  
  
## §11. СПРИНТЫ  
  
| Спринт | Что |  
|---|---|  
| 1 | Yandex Метрика + VK Pixel базовые. UTM-стандарт. 5 базовых событий. |  
| 2 | `tracking_attribution` таблица + frontend tracker. |  
| 3 | Server-side tracking, `pixel_events`, worker. |  
| 4 | VK Conversions API (server-side покупки). |  
| 5 | Расширенный набор событий (12 шт). |  
| 6 | Аудитории + cron sync to VK. |  
| 7 | ROI dashboard. |  
| 8 | Lookalike + кампания «Свадебная песня» VK Ads. |  
| 9 | Автопостинг VK + Telegram канал. ContentAgent. |  
| 10 | MyTarget / Meta (если выходим за РФ). |  
  
---  
  
## СЛЕДУЮЩИЙ ФАЙЛ → `06-PLUGIN-АРХИТЕКТУРА-Х