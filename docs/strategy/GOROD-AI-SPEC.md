# 🏙 Город Ай — Embeddable Playlist Widget MuzaAi (ТЗ от Босса 2026-05-20)

> **Кодовое имя проекта:** «Город Ай» (City AI) — embed-widget MuzaAi для сторонних платформ
> **Статус:** Future sprint (V2, 6-8 недель)
> **Цель:** виджет плейлиста MuzaAi для встраивания на сторонние платформы (B2B/B2C-кабинеты, новостные порталы)
> **Источник:** Босс прислал ТЗ в чате 2026-05-20

## 1. Контекст

Платформы (клиенты MuzaAi) встраивают наш виджет плейлиста на свои страницы. Юзер видит свёрнутый плейлист, раскрывает, выбирает трек, воспроизводит. Фоновое музыкальное сопровождение без ухода с платформы.

## 2. Функциональные требования

### 2.1 Базовое поведение
- Два состояния: **collapsed** (280×60 px) и **expanded** (≈320×480 px)
- Collapsed: компактная кнопка раскрытия + опционально обложка текущего трека
- Expanded: полноценный плеер (track list, обложки, артист/название, play/pause, next/prev, seek, volume, прогресс)
- Toggle: повторный клик или крестик в шапке

### 2.2 Воспроизведение
- Click трек → немедленное play (без redirect/reload)
- Continue play при сворачивании виджета
- Continue play при навигации между страницами платформы (host-app shell)
- Stop при закрытии вкладки
- **MediaSession API** — управление с system media keys, lock screen на mobile

### 2.3 Плейлисты
- Параметр инициализации: `playlist_id` или URL
- **Один активный плеер на странице** — multiple не поддерживаем
- Переключение через API `setPlaylist(id)`
- Типы: **public**, **private с токеном**, **personal по auth юзера в Музе**

### 2.4 Авторизация (3 scenario параллельно)
- **A. Anonymous** — только public плейлисты, без рекомендаций
- **B. Привязанный аккаунт Музы** через OAuth 2.0 с PKCE → личные плейлисты, лайки, рекомендации. Токены хранит виджет (не платформа)
- **C. SSO через JWT платформы** (V2 опционально) — Муза принимает signed user_id, создаёт/находит аккаунт

### 2.5 Cross-page playback
- При navigation между страницами **playback не прерывается**
- Виджет в layout-обёртке host-app shell
- Persisted state: track, position, volume, playlist

### 2.6 UX
- **First load ≤ 1.5 сек** (стандартный internet)
- **Bundle ≤ 150 KB gzipped**
- Async/defer load — не блокирует рендеринг host
- No cookies/localStorage без consent

## 3. Контент

Подготовить:
1. Список public плейлистов с `playlist_id` + метаданные
2. Возможность создать **кастомные** плейлисты (Фокус, Утро в офисе, Творчество, Новости)
3. API/CMS для управления плейлистами
4. Лицензионная чистота треков (для embed)
5. Подтверждение прав на использование на сторонних платформах

## 4. Техническая реализация

### 4.1 Формат (выбор Музы)
1. **Web Component** (предпочтительно) — `<muza-playlist-player>` с Shadow DOM, один script tag, framework-agnostic
2. **iframe** — `https://muza.ru/embed/playlist/<id>` + postMessage API
3. **JS SDK / React npm package** — `@muza/web-player`

### 4.2 Размещение
- Host: в App Shell / layout-обёртке (cross-page playback)

### 4.3 Адаптивность
- Desktop / tablet / mobile
- Collapsed: fixed-position в углу (bottom-left/right конфигурируется)
- Mobile: notch/status bar safe-area
- Touch gestures (swipe)

### 4.4 Темизация
- `theme="light|dark|auto"` (auto — `prefers-color-scheme`)
- `accent-color="#hex"`
- Кастомные radius

### 4.5 Accessibility (WCAG 2.1 AA)
- ARIA для play/pause/next/prev
- Keyboard (Space, стрелки)
- Контраст
- Screen reader озвучивает track title

## 5. API виджета

### 5.1 Инициализация
```html
<muza-playlist-player
  playlist-id="muz-pl-12345"
  mode="collapsed"
  theme="auto"
  accent-color="#FF5500"
  position="bottom-right"
  autoplay="false"
  show-cover="true"
  on-ready="window.muzaReadyHandler"
></muza-playlist-player>
```

### 5.2 Методы
| Метод | Параметры | Описание |
|---|---|---|
| `play()` | — | Запустить |
| `pause()` | — | Пауза |
| `next()` / `prev()` | — | Следующий/предыдущий |
| `seek(seconds)` | `number` | Перемотка |
| `setVolume(v)` | `0..1` | Громкость |
| `setPlaylist(id)` | `string` | Сменить плейлист |
| `expand()` / `collapse()` | — | Toggle |
| `getState()` | — | `{playing, paused, track, position}` |
| `authorize(payload)` | `object` | Auth data |

### 5.3 События
| Event | Когда | Payload |
|---|---|---|
| `ready` | Загружен | `{version}` |
| `playback.started` | Play | `{track_id, title, artist}` |
| `playback.paused` | Pause | `{track_id, position}` |
| `track.changed` | Сменился трек | `{track_id, title, artist, cover_url}` |
| `playlist.changed` | Сменился плейлист | `{playlist_id, title}` |
| `expanded` / `collapsed` | Toggle | — |
| `auth.required` | Нужна авторизация | `{reason}` |
| `auth.success` | Auth прошла | `{user_id_in_muza}` |
| `error` | Ошибка | `{code, message}` |

### 5.4 CSP-совместимость
- Сообщить домены для `script-src`, `media-src`, `img-src`, `connect-src`, `frame-src`
- Без inline-scripts/eval
- Стили в Shadow DOM, без `unsafe-inline`

## 6. OAuth 2.0
- Endpoint с PKCE
- Scopes: `playlists.read`, `playback.control`, `library.read`
- Redirect URL согласуется
- Виджет инициирует auth по event `auth.required`
- Токены на стороне виджета, не платформа

## 7. Метрики
- **Side Музы**: воспроизведения по domain, popular tracks, listening time, conversion
- **Side платформы**: показы, клики раскрытия, начало play, контентная аналитика

## 8. Legal
- 152-ФЗ — обработка ПД на стороне Музы, consent при auth
- Cookies/localStorage только с consent (`consent_given=true/false` параметр)
- Лицензии треков — Музa
- 438-ФЗ маркировка рекламы (если есть) — Музa

## 9. Commercial model
TBD:
- Платно/бесплатно
- Лимиты free tier
- In-widget реклама — разрешена?
- Affiliate / revenue share

## 10. Этапы (6-8 недель)
1. Согласование формата (1 нед)
2. Согласование плейлистов и доступов (1 нед параллельно)
3. Подготовка widget dev-версии (3-4 нед)
4. Тестовая интеграция на dev (1 нед)
5. QA + accessibility audit (1 нед)
6. Prod release

## 11. Критерии приёмки
1. Встроен на 3 ключевые страницы клиентских платформ
2. Cross-page playback works
3. First load ≤ 1.5s (Lighthouse)
4. Bundle ≤ 150 KB gzipped
5. Chrome / Firefox / Safari (актуальные −2), iOS Safari, Android Chrome
6. Все events эмитятся
7. WCAG 2.1 AA pass
8. OAuth works
9. CSP-совместимость
10. No third-party trackers без consent

## 12. Next steps для команды Музы (для старта)
1. Подтвердить выбор формата (Web Component / iframe / SDK)
2. Tech lead от Музы
3. Согласие с ТЗ или правки
4. Срок dev-версии
5. Коммерческая модель
6. OAuth docs

---

**Сохранено для будущего sprint. До начала работы — Босс должен:**
- Подтвердить формат (Web Component recommended)
- Утвердить коммерческую модель
- Назначить tech lead
- Утвердить scope MVP

**Зависимости (что должно быть готово в основном продукте до начала widget'a):**
- OAuth 2.0 server (V2 plan)
- Public playlist API (`GET /api/embed/playlists`, `GET /api/embed/playlist/:id`)
- Track streaming endpoint с CORS+CSP для embeds
- Analytics endpoint для widget events
