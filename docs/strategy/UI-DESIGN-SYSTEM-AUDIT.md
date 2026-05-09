# UI DESIGN-SYSTEM AUDIT — 2026-05-09

**Контекст:** Eugene в течение 9 мая накопил 5 UX-запросов про /music и общий стиль. Этот документ собирает: что есть → что хочется → что трогаем → как проверяем. Реализация — отдельными commit'ами после approval.

---

## TL;DR — что хочет Eugene

| # | Задача (буквальный текст) | Тип |
|---|---|---|
| A | Окно генерации в стиле DJ hi-tech пульта + тонкие нотки фантастики и магии звука | Visual redesign /music |
| B | Пересмотри меню генераций логику и воплощение Аудио / Текст·Простой / Текст·Расширенный — кнопки | UX-аудит + правки |
| C | Человек из любого места должен скользить по генерации; взаимосвязи аккуратно решить | Навигация по окнам генерации |
| D | Все ✕-крестики в квадрате (отмена) — заменить на красивые космические кнопки | Глобальная замена компонента |
| E | Всё в одном дизайнерском стиле и шрифте | Глобальная унификация |

D и E — пересекаются (один компонент покрывает оба). A это специфика /music. B и C — про эту же страницу. Все 5 — связаны. Реализуем общим pass'ом.

---

## 1. Текущие токены — что есть

### 1.1 Цвета (CSS переменные, `index.css:6-127`)

| Слот | Light | Dark | Использование |
|---|---|---|---|
| `--primary` | `263 70% 50%` (purple #8B5CF6) | то же | btn-gradient, активные tab'ы |
| `--secondary` | `217 91% 60%` (cyan-blue) | dark gray | акцент, фокус |
| `--accent` | near-white | muted purple | нейтральный hover |
| `--destructive` | `0 63% 51%` (red) | то же | ошибки, "удалить" |
| `--muted-foreground` | gray-400 | gray-400 | подписи, плейсхолдеры |
| `--border` | white/8 | white/4 | hairlines |

Inline-палитра в Tailwind: `cyan-{300..500}`, `purple-{300..500}`, `violet-{300..500}`, `pink-{500}`, `amber-{500}`, `emerald-{500}` — все используются для разных подсистем (voice/genre/status).

**Проблема единства:** нет канонической палитры. Каждая секция /music выбирает свой акцент: Аудио = cyan, Текст·Простой = purple, Текст·Расширенный = violet, voice tiles = purple/blue/pink/amber. Это создаёт «зоопарк», а не единый язык.

### 1.2 Шрифт

- Inter из Google Fonts (`index.html:17`) — единственный sans-serif. Weight 100-900, italic.
- JetBrains Mono — `--font-mono`, используется только в admin-панелях.
- Body 400, headings 600-700, кнопки 500.
- **Никаких других шрифтов в коде нет.** Унификация шрифта в смысле «один шрифт» уже выполнена. Но если Eugene хочет акцентный display-шрифт (для DJ hi-tech — что-то типа `Orbitron`, `Space Grotesk`, `Audiowide`) — нужно добавить.

### 1.3 Анимации (`index.css`, keyframes)

| Имя | Эффект | Используется |
|---|---|---|
| `cosmicShimmer` | gradient-position 0→100→0% | btn-cosmic, card-cosmic, gradient-border |
| `cosmicDisclosureIn` | scaleY 0.85→1 + blur 6→0 | новый (cosmic disclosure transcript) |
| `cosmicDisclosureOut` | scale 1→0.92 + blur 0→10 + glow burst | то же |
| `equalizerBar` | height 20→80% loop | result-player эквалайзер (20 баров) |
| `eq-bar1/2/3` | inline в music.tsx, для микрофона на tab Аудио | tab-icon |
| `gradientPulse` | opacity pulse | loading-states |
| `fadeIn` | scale 0.8→1 + opacity 0→1 | базовый enter |
| `gradient-border-shift` | animated gradient frame | gradient-border card |

### 1.4 Утилитные классы (готовые «cosmic-кирпичи»)

| Класс | Что даёт |
|---|---|
| `.btn-cosmic` | 6-цвет gradient shimmer, glow shadow, активная forever-анимация |
| `.card-cosmic` | gradient-border 6s shimmer + radial glow |
| `.glass-card` | backdrop-blur(40px) saturate(180%) + white/8 border + purple hover-glow |
| `.gradient-border` | 4-цвет animated frame + radial glow ::after |
| `.btn-gradient` | purple→blue gradient, shadow glow, -1px hover-lift |
| `.gradient-text` | text gradient purple→blue→cyan |
| `.glow-purple` | 0 0 15px+45px purple shadow |
| `.input-glow` | focus 0 0 20px purple |
| `.equalizer-bar` | height-loop animation (20 баров) |
| `.audio-progress` | linear-gradient progress fill |
| `.cosmic-disclosure-enter / -exit` | новые анимации раскрытия |

**Вывод:** «cosmic-кирпичей» уже много. Не нужно изобретать с нуля — нужно:
1. Скомпоновать существующие в **единые компоненты** (CosmicButton, CosmicCloseButton, CosmicCard, CosmicTabs)
2. Добавить **2-3 недостающих** (LED indicator, VU meter, neon ring)
3. Применить эти компоненты вместо текущих point-by-point CSS-классов

---

## 2. Пять задач A-E — детально

### A. DJ hi-tech /music

**Что просит Eugene:** «окно генерации в стиле dj hi-tech пульта и тонкими нотками фантастики с элементами магии звука».

**Современные референсы DJ hi-tech UI:**
- Pioneer DDJ / Native Instruments Traktor — чёрные/тёмные плоскости с подсвеченными ручками (LED rings вокруг knob'ов)
- VU-метры (вертикальные шкалы со свечением)
- Сегментные дисплеи (LED-цифры тёмно-красным/оранжевым по чёрному)
- Кнопки с физической глубиной (inset shadow + тонкий top highlight)
- Нет ярких больших градиентов в фоне — фон тёмный, акценты на интерактиве

**Что меняем на /music:**
1. **Фон страницы** — добавить тонкий «scan-line» или «brushed metal» оверлей; existing background сохранить
2. **Mode-tabs** (Аудио / Текст·Простой / Текст·Расширенный) — стилизовать как **3 hardware-кнопки**:
   - неоновый ring вокруг иконки на active
   - inset shadow «вдавленности» при нажатии
   - LED-indicator (pulsing dot) рядом с лейблом текущего режима
3. **Voice picker (4 тайла)** — в стиле hardware-pad'ов:
   - inset gradient «глубины»
   - на active — top highlight + outer glow + scale[1.02]
   - hover — neon ring без scale
4. **Status-strip** (4 шага recording→upload→recognition→ready) — переделать в **VU-meter style**: вертикальные сегменты, заполняются по мере прогресса, current step pulse'ует
5. **Submit-кнопка** — оставить `.btn-cosmic` (она уже DJ-feeling), но добавить **«магический звон»**: subtle audio-ping click sound + shimmer
6. **Equalizer на player** — расширить с 20 баров до **«spectrum analyzer»** с цветовым градиентом по частоте (низ красный, средние жёлтый, верх голубой)
7. **Неоновые акценты** — везде где есть active/focus, добавить thin neon stroke (не более 1px)
8. **Нотка фантастики** — на пустых местах (между секциями) — едва заметные «звёздочки» (4-6 точек, slow blink, opacity 30-40%)

**Что НЕ трогаем:** layout/grid, ширины колонок, spacing — это работает.

### B. Пересмотр меню режимов

**Текущее устройство:**
- 3 главных таба: Аудио (cyan), Текст·Простой (purple), Текст·Расширенный (violet)
- Sub-tabs для Аудио: Простой / Расширенный (cyan/cyan)
- Default mode при первом заходе: ?
- HelpBuddy справа от tab'ов с описанием каждого режима
- На smartphone HelpBuddy уезжает вниз через flex-wrap

**Smell'ы:**
1. Цветовая логика рассыпана: Аудио — cyan, Простой — purple, Расширенный — violet. Это случайно или по смыслу? Если «Аудио = вход через звук = cyan», «Текст = вход через слово = purple» — то sub-tabs Аудио не должны быть cyan, они вторичные.
2. Sub-tabs «Простой/Расширенный» внутри Аудио — повторяют названия с главного меню. Юзер может запутаться: «Аудио → Простой» vs «Текст → Простой».
3. HelpBuddy на smartphone не optimal — занимает место под тaб'ами.
4. Нет визуального признака «что я выбрал в иерархии». Юзер не видит breadcrumb «Текст → Расширенный».

**Предложения (по убыванию надёжности):**
1. **[Самое надёжное]** Иерархическая визуализация: показать breadcrumb «🎤 Аудио · Расширенный» сверху текущего content'а. Цветовая логика: Аудио семейство = cyan-shades (300/400/500), Текст семейство = purple-shades. Sub-tab Простой/Расширенный — оттенок текущего семейства, не новый цвет.
2. **[Среднее]** Объединить главные tab'ы и sub-tabs в **5-кнопочное меню**: «🎤 Простой» «🎤 Расширенный» «📄 Простой» «⚙ Расширенный» (5 кнопок одного уровня). Менее иерархично, но проще навигация на смартфоне.
3. **[Быстрое]** Только цветовое выравнивание — оставить структуру 3+2 как сейчас, но привести cyan/purple к общему ядру.

**Acceptance:** юзер видит за 1 секунду «я в режиме Y семейства X».

### C. Навигация по окнам генерации

**Текущий flow после генерации:**
1. Юзер на /music → жмёт «Создать песню»
2. Появляется status pipeline → ждём → toast «Трек готов!»
3. Audio player появляется **на той же странице** (не редирект)
4. Юзер может: нажать «Открыть Dashboard» (опция) или продолжить slушать на месте
5. Других интерактивов нет

**Проблемы:**
- Нет «следующего трека» / playlist прямо на /music — для следующей генерации юзер делает scroll вверх и заполняет форму заново
- Нет «вернуться к этому треку» из других мест — если юзер ушёл на /dashboard, нужно искать трек в списке
- Ссылок на share/edit/regenerate сразу под player'ом нет (или они спрятаны)
- На smartphone audio player, форма, и status-strip конкурируют за место

**«Скольжение между зонами» — как реализовать:**
1. **Floating mini-player** в углу всех страниц после успешной генерации — track persists across navigation. Click на mini-player → раскрывается full player.
2. **Sticky CTA-бар** под player'ом: «🎲 Ещё один» / «✏ Изменить текст» / «📤 Поделиться» / «📊 Дашборд» — 4 кнопки одной строкой, всегда видны.
3. **Хлебные крошки** в navbar отображают текущий трек (если есть): `Главная / Музыка / 🎵 Мой трек` с возможностью кликнуть на трек.
4. **Swipe-навигация** на smartphone между tab'ами генерации (Аудио ↔ Текст·Простой ↔ Текст·Расширенный) — Eugene упомянул «скользить».

**Ограничение:** «скользить» интерпретируем как **быстрый, плавный, low-friction transition между зонами**, не как буквальное swipe-gesture (хотя swipe тоже даём).

**Acceptance:** юзер из любого экрана за ≤1 клик попадает в любой другой экран связанный с текущим треком.

### D. Cosmic close-кнопки вместо ✕-крестиков

**Где сейчас крестики (4 места):**

| # | Файл | Что закрывает |
|---|---|---|
| 1 | `components/ui/dialog.tsx:47-50` | Dialog (все модальные окна — топ-стат, geo-activity, etc.) |
| 2 | `components/ui/sheet.tsx:68-71` | Sheet (мобильное меню drawer) |
| 3 | `components/ui/toast.tsx:74-85` | Toast notifications |
| 4 | `components/navbar.tsx:262` | Mobile menu toggle (X / Menu иконка) |

Все используют `<X>` из lucide-react с `opacity-70 hover:opacity-100`.

**XCircle status icons** (payment-result.tsx:46, dashboard.tsx:40, 330) — это **не close**, а **error indicator**, не трогаем.

**Решение — единый компонент `CosmicCloseButton`:**

```tsx
// client/src/components/ui/cosmic-close.tsx
export function CosmicCloseButton({ onClick, ariaLabel = "Закрыть" }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="group absolute right-3 top-3 w-8 h-8 rounded-full
                 bg-gradient-to-br from-purple-500/20 to-cyan-500/15
                 border border-white/15 backdrop-blur-md
                 hover:from-purple-500/40 hover:to-cyan-500/30
                 hover:border-cyan-400/60 hover:shadow-[0_0_20px_rgba(34,211,238,0.4)]
                 active:scale-90 transition-all duration-200
                 flex items-center justify-center"
    >
      <X className="w-4 h-4 text-white/70 group-hover:text-white group-hover:rotate-90 transition-all duration-300" />
      {/* magic-pulse ring on hover */}
      <span className="absolute inset-0 rounded-full opacity-0 group-hover:opacity-100 ring-2 ring-cyan-400/30 animate-ping pointer-events-none" />
    </button>
  );
}
```

**Применение** — заменить во всех 4 точках (sheet, dialog, toast, navbar).

**Acceptance:** все ✕ выглядят одинаково, имеют hover-glow и rotate, click — animation feedback.

### E. Единый шрифт + дизайн-стиль

**Шрифт уже один (Inter).** Что Eugene имеет в виду под «один шрифт»:
1. Возможно — **акцентный display-шрифт** для DJ hi-tech (Orbitron / Audiowide / Space Grotesk) на крупных hero-заголовках
2. Возможно — **унификация font-weight** (сейчас 400/500/600/700 разбросаны без правил)
3. Возможно — **letter-spacing** на uppercase (для cosmic-feeling)

**Что предлагаю:**
1. Подключить **Space Grotesk** (или **Orbitron** для DJ-vibe) — *в дополнение* к Inter, **только для display** (h1, h2, hero-CTA, /music page-title «Музыка + Вокал»)
2. Закрепить **font-weight scale**: 400 body, 500 buttons/labels, 600 section-headings, 700 page-titles (уже почти так)
3. Добавить `tracking-wider` на uppercase / нагрузочные cosmic-кнопки
4. Все компоненты используют общую базу: `bg-background`, `border-white/10`, `rounded-xl`, `backdrop-blur-md` — стандартизировать через 1 базовый компонент `Surface`

**«Один дизайнерский стиль»** — это не про CSS-token (они уже на месте), а про **последовательность применения**. Audit показал: сейчас `bg-white/5`, `bg-white/[0.03]`, `bg-cyan-500/5`, `bg-purple-500/[0.07]` — каждый раз чуть-чуть разные. Решение — `Surface` компонент с 3 уровнями: `surface={"glass" | "card" | "panel"}`, и больше не пишем inline alpha.

---

## 3. План файлов / changes

### Фаза 1 — Базовые компоненты (D + E foundations)
- ✏ `client/src/components/ui/cosmic-close.tsx` (новый) — CosmicCloseButton
- ✏ `client/src/components/ui/dialog.tsx` — заменить `<X>` на CosmicCloseButton
- ✏ `client/src/components/ui/sheet.tsx` — то же
- ✏ `client/src/components/ui/toast.tsx` — то же (но меньше — toast hover-only)
- ✏ `client/src/components/navbar.tsx:262` — то же
- ✏ `client/index.html` — подключить display-шрифт (Space Grotesk или Orbitron)
- ✏ `client/src/index.css` — добавить `--font-display`, утилиту `.font-display`
- ✏ `client/src/components/ui/surface.tsx` (новый) — Surface componeнt с 3 вариантами

**Push 1:** ~6-8 файлов, чисто фронтэндовая фронт-инфраструктура. Тестируем на /music + /dashboard + любом dialog'е.

### Фаза 2 — DJ hi-tech /music (A)
- ✏ `client/src/index.css` — добавить keyframes/утилиты:
  - `@keyframes ledPulse` (LED dot blink)
  - `@keyframes vuMeterFill` (vertical fill для VU)
  - `.led-indicator`, `.hardware-button`, `.neon-ring`, `.vu-segment`
  - `.scan-lines` overlay (subtle)
- ✏ `client/src/pages/music.tsx`:
  - Mode-tabs → hardware-button styling
  - Voice tiles → hardware-pad styling с inset gradient
  - Status-strip → VU-meter (вертикальные сегменты)
  - Submit button — добавить subtle ping sound (через Web Audio API beep на click)
- ✏ `client/src/pages/music-result-player.tsx` (если есть отдельный) — spectrum-analyzer вместо плоских eq-bars

**Push 2:** ~3 файла, scope contained на /music.

### Фаза 3 — Меню режимов (B)
- ✏ `client/src/pages/music.tsx`:
  - Цветовое выравнивание: Аудио family = cyan-300/400/500, Текст family = purple-300/400/500
  - Breadcrumb сверху: `🎤 Аудио · Расширенный` (или `📄 Текст · Простой`)
  - Sub-tabs становятся одного семейства цвета
  - HelpBuddy на smartphone переезжает в отдельный full-width section ниже tab'ов

**Push 3:** 1 файл, ~80 строк.

### Фаза 4 — Навигация (C)
- ✏ `client/src/components/floating-player.tsx` (новый) — sticky mini-player в углу
- ✏ `client/src/App.tsx` — рендерить floating-player на всех страницах если есть current track
- ✏ `client/src/pages/music.tsx` — sticky CTA bar под audio player'ом (4 кнопки)
- ✏ `client/src/components/navbar.tsx` — breadcrumb с current track
- ✏ `client/src/pages/music.tsx` — swipe-handlers для mode-tabs на mobile

**Push 4:** ~4-5 файлов. Самая большая фаза.

### Фаза 5 — Финальная унификация (E follow-up)
- Заменить inline `bg-white/5` etc. на `<Surface variant=>`
- Привести font-weight scale на всех страницах (только 4 значения)
- `tracking-wider` на uppercase / btn-cosmic

**Push 5:** «полировка» — ~10 мелких правок.

---

## 4. Acceptance criteria (за этап)

| Этап | Критерий проверки | Ссылка |
|---|---|---|
| Phase 1 | Открой любой dialog → ✕ круглый, glow на hover, rotate. Все 4 места одинаковые | https://clone.muziai.ru/#/dashboard (любой dialog) |
| Phase 1 | Page-title «Музыка + Вокал» отрисован display-шрифтом (Space Grotesk / Orbitron) | https://clone.muziai.ru/#/music |
| Phase 2 | На /music: mode-tabs выглядят как hardware-кнопки с LED indicator у активной | https://clone.muziai.ru/#/music |
| Phase 2 | Voice tiles имеют inset shadow + neon ring на active | то же |
| Phase 2 | Status strip — VU-segments вертикально, заполняются по мере прогресса | записать голос → проверить |
| Phase 3 | Цветовая иерархия очевидна: Аудио → cyan, Текст → purple. Breadcrumb сверху | /music |
| Phase 3 | На smartphone HelpBuddy не уезжает за tab'ы, в отдельной полосе ниже | /music на телефоне |
| Phase 4 | После генерации — floating mini-player виден на /dashboard | сгенерировать → /dashboard |
| Phase 4 | Под audio-player'ом — 4 кнопки CTA: Ещё один / Изменить / Поделиться / Дашборд | /music после генерации |
| Phase 4 | Свайп влево-вправо на mobile mode-tabs переключает режимы | /music на телефоне |
| Phase 5 | На /music и /dashboard визуально одно «семейство»: одни и те же surface-цвета и шрифт-веса | оба URL |

---

## 5. Sequencing & время

```
Сегодня (~3-4 часа):
├─ Phase 1 (1.5-2 часа) — CosmicCloseButton + Surface + display-шрифт
└─ Phase 2 (1.5-2 часа) — DJ hi-tech /music

Завтра (~4-5 часов):
├─ Phase 3 (1 час)    — меню режимов
├─ Phase 4 (2-3 часа) — floating-player + CTA bar + breadcrumb + swipe
└─ Phase 5 (1 час)    — полировка
```

После каждой фазы — push на оба сервера (clone + muziai prod), проверка на смартфоне, обратная связь от Eugene → следующая фаза.

---

## 6. Что НЕ трогаем

- ❌ Backend/API — это чисто frontend pass
- ❌ Routing структура (паттерны URL остаются)
- ❌ State management (TanStack Query, hash-router)
- ❌ Существующие cosmic-классы (`btn-cosmic`, `glass-card`, etc.) — переиспользуем
- ❌ Inter-шрифт — он остаётся базовым; добавляется только display-шрифт сверху
- ❌ Backward compatibility — для frontend нет смысла, юзер всегда грузит свежий bundle

---

## 7. Открытые вопросы для Eugene

1. **Display-шрифт** — какой именно? Варианты:
   - **Space Grotesk** (геометрический, нейтрально-современный, хорошо читается на маленьких размерах)
   - **Orbitron** (явный sci-fi DJ vibe, Audiowide-like, но осторожнее с читаемостью)
   - **Audiowide** (буквальный «синтезаторный» — крупно красиво, мелко плохо)
   - **Major Mono Display** (моно + display, очень DJ)
2. **Скан-линии на фоне /music** — да/нет? Эффект subtle, но добавляет «hardware» feel.
3. **Click-sound на submit-кнопке** — реализовать (Web Audio beep) или отложить?
4. **Floating mini-player** — на всех страницах или только пока пользователь не закроет вкладку?
5. **Swipe gesture** на mode-tabs — приоритет (нужен) или nice-to-have?
6. **Breadcrumb с current track** — показывать только при активной генерации или когда юзер выбрал любой свой трек на /dashboard?

После ответов Eugene — стартую с Phase 1.

---

## 8. Реализация в этой сессии

После approval плана:
1. Сразу начну Phase 1 (CosmicCloseButton + Surface + display-шрифт) — push на clone + prod
2. После ✅ Phase 1 — Phase 2 (DJ hi-tech /music) — push
3. Дальше — по сессионному графику

Работаю **без переспрашивания подтверждения** на каждый push (per «режим бог»). Останавливаюсь только если:
- Возник конкретный choice (например 4 варианта display-шрифта)
- Что-то сломалось и надо разобрать
- Eugene прислал новую задачу

---

*Audit собран Claude через Explore-агент + ручной анализ. Цитаты actuual at commit `925689a`.*
