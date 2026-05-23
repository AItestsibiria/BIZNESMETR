# Chat window debate audit — 2026-05-24 (utrennii brief Bossu)

> Format: Критик (perfectionist) vs Арнольд (pragmatist). Each question — debate, then consensus + actionable items for morning coding.
>
> Scope: `apps/neurohub/client/src/components/floating-consultant.tsx` (3348 строк) + `apps/neurohub/server/lib/consultantPersona.ts` (1218 строк) + связанные правила CLAUDE.md и git history последних 48h.
>
> Git context: 25+ commits за 48h по consultant/musa/chat — Босс активно даёт feedback, fix-cycle быстрый. Анти-pattern «pre-push critical review» проявляется здесь сильно.
>
> **Honest TL;DR**: UI чата перегружен из-за инкрементальных правок без cleanup. По 3-4 правилам конкретные нарушения (Pricing-single-source невидим в чате; A−/A+ overlap с тремя другими header buttons на mobile). Logical/data race risks средние. Критик скорее прав по UX overload, Арнольд скорее прав по shipping urgency (запуск «через пару дней» per persona prompt).

---

## Вопрос 1: Размещение Музы FAB — top-right always (правильно?)

**Контекст**: `floating-consultant.tsx:558-570`. Default позиция = top-right (76px от top на mobile / 92px tablet / 108px desktop). Историчность:
- Был `bottom-right` → коммит `a7ab4f8` (2026-05-21) «fix(musa): по умолчанию в правом нижнем углу» вернул bottom-right.
- Коммит `87515ef` (2026-05-23) «Музa всегда top-right адаптивно от размера окна» — flipped в top-right.
- Sessionstorage `consultant-fab-position` сохраняет user position.

**Критик**:
> Это **5-я итерация позиционирования за неделю**. Top-right — конфликт с типичной conventional placement (chat widgets живут в bottom-right: Intercom, Drift, HubSpot). User mental model «помощь — внизу справа» нарушена. Plus безопасный safeTop=76px на mobile перекрывается с iOS notch + потенциальным top-bar / status bar. На iPhone 15 (notch) Музa в первые 76px = в зоне `env(safe-area-inset-top)` = плохо.
> Доказательство: top-right занимает место **где обычно живут close/settings buttons** на mobile UX. Юзер inadvertently тапает Музу, думая что закрывает что-то.

**Арнольд**:
> Conventions ≠ закон. Бренд имеет право на свой паттерн. Top-right положение оправдано тем что **landing.tsx плеер живёт в bottom-area**, и FAB в bottom-right перекрывал бы playback controls. Smart trade-off. iOS safe-area не критична: 76px > 44pt notch height, перекрытия нет.
> Plus session-persist даёт юзеру власть переставить — ничего необратимого.

**Критик в ответ**:
> Session-persist через `sessionStorage` означает что при F5 / новой вкладке position reset. Юзер каждый раз заново тащит. Не «власть», а раздражение. Если drag — значит надо `localStorage` с TTL.

**Арнольд итог**:
> Логика верна, но spec Босса явно: «при F5 возвращается на default». Тут уже design intent, не bug.

**Консенсус (для morning coding)**:
- Top-right остаётся (Босс явно зафиксировал, не trogaem).
- **Action**: проверить iOS notch overlap на iPhone 15/16 Pro (Dynamic Island ~50pt + status bar). Если safeTop=76 недостаточен в landscape — увеличить до `env(safe-area-inset-top, 0px) + 8px`. file:line `floating-consultant.tsx:566`.
- **Action**: добавить `localStorage` fallback для users которые **активно перетаскивают** Музу (если 3+ перетаскиваний в сессии — persist). file `floating-consultant.tsx:551-572`.

---

## Вопрос 2: Window controls (— ⛶ ×) vs только ×

**Контекст**: `floating-consultant.tsx:2632-2651`. В header 3 кнопки close-like: minimize `−` (line 2638-2644), maximize `⛶` (line 2554-2559), close `×` (line 2645-2651). Plus `👋 Ухожу скоро вернусь` footer button (line 3330-3335) — это **4-я** функция закрытия с тем же действием `setChatOpen(false)`.

**Критик**:
> **4 кнопки с одинаковым выходом — это deepest UX sin**. minimize/close/footer-goodbye — все три просто `setChatOpen(false)`. Разница только в tooltip. Юзер видит 3 икоnки в header и не знает в чём разница. Это **ровно anti-pattern Босс'a из CLAUDE.md No-duplicates rule** — функции дублируются.
> Доказательство: code at 2638 и 2645 идентичен (`onClick={() => { setChatOpen(false); setShareMenuOpen(false); }}`), отличаются только aria-label, hover-color, icon.

**Арнольд**:
> 4 кнопки не делают одинаковое — это **разные семантические сигналы**:
> - `−` minimize: «я вернусь через секунду» (хочу временно скрыть)
> - `×` close: «закончил разговор»
> - `👋` footer: «вежливо прощаюсь» — для эмоционального юзера
> - `⛶` maximize: совершенно другая функция (fullscreen toggle, line 2554)
> Семантика важна, особенно для emo-AI продукта где «уход Музы» = эмоциональный момент.

**Критик в ответ**:
> Согласен про `⛶` — это другая функция. Но `−`, `×`, и `👋` ВСЕ закрывают окно одинаково. Если разница только семантическая — то надо хотя бы **разные actions**: `−` should save state как «свернуть в badge», `×` должен truly close + clear session, `👋` должен show goodbye-animation. Сейчас все три = noop разница.

**Арнольд итог**:
> Окей, я уступаю. Это **технически идентичные actions с разными labels**. Это user-confusing. Минимум — нужно либо удалить дубли, либо разнести по semantics.

**Консенсус**:
- **P0**: удалить **либо** `−` minimize button (это и есть minimize по smell), **либо** `👋` footer. Один из них достаточен. Recommend: оставить `👋` (более человечно, brand-aligned для Музы), убрать `−` в header. file:line `floating-consultant.tsx:2638-2644`.
- **Action**: дифференцировать `×` close vs `👋` minimize:
  - `×` — set chatInitialized=false + clear chatMsgs (true close, юзер начнёт новый разговор при следующем open)
  - `👋` — оставить как есть (просто `setChatOpen(false)`, session жива)
  - file:line `floating-consultant.tsx:2647`, `3332`.
- **Action**: `⛶` оставить как есть — это **legitimately другая функция** (fullscreen toggle).

---

## Вопрос 3: «👋 Ухожу скоро вернусь» — нужен ли?

**Контекст**: `floating-consultant.tsx:3330-3335`. Footer-wide button под input form. Action идентичен minimize `−` в header.

**Критик**:
> Дублирует minimize в header. Зачем footer-кнопка если есть header-кнопка? Плюс она **занимает 36px вертикального real-estate** в каждом render чата — это много на mobile где у Музы и так max-h `min(60vh, calc(100vh - 96px - env(safe-area-inset-bottom)))`. То есть `60vh - 36px` для message scroll.
> Юзер на iPhone 14 (852px height) теряет 36px из ~500px чата = **7% screen real-estate** на дублирующую кнопку.

**Арнольд**:
> Это **emotional brand touchpoint**. Музa — character, не tool. «Ухожу скоро вернусь» = роль character'a, не UI affordance. Header `×` — холодный technical control, footer `👋` — это сама Музa говорит «пока». Снять = убить часть brand voice.
> Plus Босс **явно вернул эту кнопку** в commit `1358589` (буквально вчера). Если он явно положил — значит хочет.

**Критик в ответ**:
> Если Босс хочет emotional close-button — он должен быть **единственным close**. Сейчас 4 кнопки, все противоречат друг другу. Семантика goodbye-animation + character voice могла бы быть встроена в `×` (показывать toast «Музa: до скорого 💜» при click на ×).

**Арнольд итог**:
> Принимаю критику. **Если выбирать одну** — это либо `×` либо `👋`. Голосую за `👋` (больше brand, больше душевно). Убираем `×` или превращаем в `〉` (свернуть боком, как in-app slack).

**Консенсус**:
- Связано с Вопросом 2. **P0**: единое решение по close-кнопкам — оставить **либо** `−`+`×` (window-controls семантика) **либо** `👋` (emotional brand). Не оба.
- **Recommend**: убрать `−` (line 2638-2644) — Босс явно вернул `👋`, значит он priority. Оставить `×` close + `👋` footer minimize. file:line `floating-consultant.tsx:2638-2644`.

---

## Вопрос 4: Welcome tiles 8 ситуаций — auto-show intrusive?

**Контекст**: `floating-consultant.tsx:230-239` + `:3153-3179`. 8 SITUATION_TILES (Маме на юбилей / Любимой / Папе на ДР / Ребёнку / Другу / Свадьба / Профессиональный / Другой повод) автоматически рендерятся при `chatMsgs.filter(m=>m.role==="user").length===0`. Каждый tile seeds длинный prompt `"Хочу подарить песню маме на юбилей. Накидай сразу 8-12 строк..."`.

**Критик**:
> Auto-show при пустой history — **навязывание выбора**. Юзер открывает чат может сразу написать «привет» / «помощь / «расскажи о ценах». Tiles занимают **~120px вертикального места** на mobile. Заставляют выбирать из 8 категорий ДО того как юзер хоть что-то сказал.
> Доказательство: типичный chat-flow онбординга — `inputbox > tap > type > send`. Tiles обрезают это до `tap tile > LLM выдаёт 8-12 строк`. Юзер потерял шанс **сказать своё**, моментально получил готовый seed prompt.
> Plus 4 grid × 2 rows на mobile — на iPhone SE (375px wide) tiles становятся ~80×80px = **слишком маленькие тачи** (Apple HIG min 44pt).

**Арнольд**:
> Это **product strategy decision Босса** — `commit 6987626` «Музa встречает 8 ситуационными tiles». Goal — снизить cold-start friction. На pустой chat-вкладке tiles дают immediate value: юзер видит «о, для мамы можно? давай!». **Conversion-oriented** дизайн.
> Plus tiles disabled когда `chatSending=true` (line 3163) — не triggerят race. И исчезают сразу после первого user message — non-intrusive после старта.

**Критик в ответ**:
> «Conversion-oriented» — оk, но конкретно ЭТИ 8 категорий покрывают только Б2С подарочные кейсы. Юзер с другим intent (хочу узнать цены / есть проблема с треком / хочу помощь по тексту своему) сразу теряется. Должен быть toggle/skip.
> Plus seed prompts ОЧЕНЬ длинные. `"Хочу подарить песню маме на юбилей. Накидай сразу 8-12 строк трогательного начала и спроси что подчеркнуть."` — это автоматически становится user message в истории. Looks weird: пользователь не говорил такое, не его words.

**Арнольд итог**:
> Принимаю про длинные seeds. Это действительно странно. Юзер кликает иконку → в чате появляется ОТ ЕГО ИМЕНИ длинный текст. Это **deception** — юзер не писал такое.

**Консенсус**:
- **P1**: укоротить seed prompts. Replace `"Хочу подарить песню маме на юбилей. Накидай сразу 8-12 строк..."` → `"Песня для мамы на юбилей"` (короткое intent statement). LLM сам подхватит и спросит детали. file:line `floating-consultant.tsx:230-239`.
- **P2**: оставить tiles auto-show, **но** добавить «✏️ Напишу сам» tile в 9-ю позицию ИЛИ кнопку «Скрыть tiles» (для users которые хотят сразу писать). file:line `floating-consultant.tsx:3158-3179`.
- **P2**: tile min-size 60×60px (текущее aspect-square при grid-cols-4 = ~80×80 на 375px, OK для туч, но в landscape mobile может уменьшиться). file:line `floating-consultant.tsx:3170`.

---

## Вопрос 5: Очередь сообщений pendingMessages — unexpected behavior?

**Контекст**: `floating-consultant.tsx:742, 1683-1697, 1699-1707`. Юзер шлёт msg во время `chatSending=true` → попадает в `pendingMessages` queue → useEffect (line 1699-1707) автоматически вытягивает next после ответа на предыдущий. Badge `pendingMessages.length` на send-button.

**Критик**:
> **Critical UX bug**: юзер может ждать LLM 45 сек, за это время натапать 5 сообщений в очередь, **передумать про первое** — но уже не отменить. Сообщения отправляются последовательно, нет cancel UI. Запрашивает баланс → пишет «расскажи про обложки» → пишет «нет, отмени» → … все 3 уйдут в LLM в порядке очереди, baланs будет показан, обложки будут описаны, «нет отмена» интерпретируется как новый topic.
> Plus race condition: если юзер кликает submit когда `chatSending=false` БУКВАЛЬНО в момент когда useEffect ещё не сработал на pending — может пропустить вызов. (line 1701-1706, deps `chatSending, pendingMessages, doSendMessage`).
> Plus `lastSentTextRef` anti-duplication (line 1406-1432) проверяет text == last + < 3 сек — но **очередь шлёт через doSendMessage, который ставит lastSentTextRef**. То есть второе и третье pending тоже могут быть отсеяны как duplicates если совпадают.

**Арнольд**:
> Очередь — **правильное решение** для проблемы которую Босс сам обозначил: «кнопка не реагирует, юзер думает что глюк». Без очереди — disabled submit на 45 сек = ещё хуже UX. Юзер думает что чат сломан.
> Race condition на useEffect deps minimal — React batches setState, useEffect fires только после reconciliation. Если submit clicked в момент когда queue не пуст, текст ставится в очередь, всё ОК.
> Cancel — fair point. Но добавить «отмена pending» можно incrementally, не блокер.

**Критик в ответ**:
> Ладно, базовая логика OK. Но недостаёт:
> 1. UI для preview очереди — юзер не видит ЧТО он накидал в pending (только badge с числом)
> 2. Cancel — кнопка «✕» возле pending counter
> 3. Anti-duplication внутри очереди — если pending имеет 2 одинаковых msg, deduplicate перед отправкой

**Арнольд итог**:
> Все 3 — valid improvements. Не блокеры, но quality-of-life.

**Консенсус**:
- **P1**: добавить tooltip на badge с числом — показывать первые 30 символов pending messages. file:line `floating-consultant.tsx:3318-3322`.
- **P2**: cancel-button на badge (click → `setPendingMessages([])`). file:line same.
- **P2**: dedup pending — перед `setPendingMessages(q=>[...q, text])` filter из q одинаковые. file:line `floating-consultant.tsx:1691`.
- **Открытый вопрос Боссу**: Если LLM (45s) долго — стоит ли auto-cancel оставшиеся pending? Или продолжать всех гнать?

---

## Вопрос 6: A−/A+ font size — diapazon 11-22, нужно ли так широко?

**Контекст**: `floating-consultant.tsx:715-724`, header buttons line 2526-2541. Font-size message bubbles через CSS var `--muza-msg-fs` (default 13px, range 11-22). Persist в localStorage.

**Критик**:
> 12 steps (11, 12, 13, ..., 22) — **overkill**. Standard accessibility paradigm: A−/A/A+ = 3 steps (small/medium/large) или max 5. 12 steps означает что юзер нажимает A+ десяток раз чтобы дойти до читаемого размера для glasses-wearing 60+ юзера.
> Plus A−/A+ занимают **~70px в header** — header уже забит: avatar+name+memo+A−A++opacity+fullscreen+reset+share+sound+minimize+close = **11+ интерактивных элементов на 380px ширины desktop**. Перегруз.
> Доказательство: на 92vw в mobile (iPhone SE = 345px) ~30px on each header button → 11 buttons × 30 = 330px = НЕ ВЛЕЗАЮТ. Buttons start truncating.

**Арнольд**:
> Range 11-22 даёт **smooth control**. Юзер может выставить 17px или 19px (что 3-step не позволит). Step +1px = `+0.5` Apple system standard text scaling. Это actually accessibility-friendly.
> На mobile (`sm:w-6 sm:h-6 → w-7 h-7`) — buttons смышляются (line 2532). Layout managed через `shrink-0`. Tested.

**Критик в ответ**:
> Tested — где proof? Я смотрю на CSS: `w-7 h-7 sm:w-6 sm:h-6` (line 2532). На mobile w-7 = 28px, gap-0.5 = 2px. Group A−/A+ = 28+28+2 = 58px. Plus avatar 36, paired badge (~80 если есть), opacity 36, fullscreen 36, reset 36, share 36 (только если ≥2 msgs), sound 36, minimize 36, close 36. = `36+80+58+36+36+36+(36)+36+36+36 = 426px` MIN width. iPhone SE 345px = overflow.
> ROOT CAUSE: paired badge `ml-1.5 text-[10px] px-1.5 py-0.5` (line 2515) ставится прямо в title flex — он не shrink-able когда есть. Когда chat pair'нут (через TG) — header гарантированно overflow on small phones.

**Арнольд итог**:
> Критик прав. Layout горизонтально perfecdo overflow на small mobile.

**Консенсус**:
- **P0**: collapse A−/A+ кнопки в single dropdown / settings drawer / second-row controls. Header перегружен. file:line `floating-consultant.tsx:2509-2651`.
- **P1**: reduce range to 11-18 (8 steps) — 22px = excessive even для accessibility. file:line `floating-consultant.tsx:2528, 2536`.
- **P1**: paired badge `shrink-0` и `truncate` — сейчас он толкает остальное за viewport. file:line `floating-consultant.tsx:2514-2518`.

---

## Вопрос 7: Прозрачность ▓▒░ 3 режима — нужна ли?

**Контекст**: `floating-consultant.tsx:727-736`, button line 2545-2551. Toggle между 0.95 / 0.6 / 0.28 background alpha (HSL).

**Критик**:
> **Кому это нужно**? Прозрачность чата = читаемость text vs visibility страницы под чатом trade-off. Real юзер: «хочу прочесть Музу» → ставит «плотно» → больше никогда не trogaet. Tt в 95% случаев unused.
> Plus 3 режима без preview = непонятно что меняется до клика. Юзер не понимает что такое «полупрозрачно» vs «стекло».
> Plus 28% alpha (default!) на background-color может сделать text НЕЧИТАЕМЫМ если landing background scrolling под чатом яркий (например emerald-cyan rocket counter).

**Арнольд**:
> Default = «стекло» (0.28) — это сознательный design choice Босса. **glassmorphism** = brand. Юзер видит landing под чатом — это feature, не bug.
> 3 режима = power-user control. Не для всех, но для тех кому надо — есть.

**Критик в ответ**:
> Glassmorphism OK как default. **3 режима** — overkill. 2 достаточно (transparent / opaque). А лучше — **auto-detect**: если landing scrolling — auto-плотнее.
> Plus icon `▓▒░` непонятна. Юзер не знает что значит. Используют один раз и забывают.

**Арнольд итог**:
> Согласен сократить до 2. Но не auto-detect — слишком complex для 1 фичи.

**Консенсус**:
- **P2**: 3 → 2 режима (плотно / стекло). file:line `floating-consultant.tsx:727-736, 2543-2551`.
- **P3**: заменить `▓▒░` на ясный icon (например 🌫 / 🌑).

---

## Вопрос 8: ⛶ fullscreen toggle + pinch-to-resize — конфликт?

**Контекст**: 
- `floating-consultant.tsx:746-752`: chatFullscreen state.
- Line 2552-2559: header button `⛶ / ⊟`.
- Line 2389-2417: pinch-to-resize двумя пальцами на drawer.
- Line 2399 при pinch-start: `if (chatFullscreen) setChatFullscreen(false)` — auto-exit fullscreen если юзер начал pinch.

**Критик**:
> 2 системы resize конфликтуют. Pinch меняет `chatSize`, fullscreen игнорирует `chatSize` (line 2437-2440 — `chatFullscreen ? {width: '92vw', height: '86vh'} : chatSize ? {...chatSize} : default`).
> Юзер: открывает fullscreen → pinch in → exits fullscreen + размер устанавливается из start point. Может прыжок размера.
> Plus **3-я resize система** — top-left drag handle (line 2451-2467) для desktop. Этот тоже ставит `chatSize`. 3 систем resize, все на одной переменной.

**Арнольд**:
> 3 системы — для **3 разных input modalities**:
> - `⛶` для tap one-click (mouse / touch)
> - top-left drag для precise desktop resize
> - pinch для tablet/mobile two-finger
> Каждый интуитивен в своей modality. Конфликт устранён через auto-exit fullscreen at pinch-start (line 2399).

**Критик в ответ**:
> Конфликт **subtle**: top-left drag handle (line 2451) **только on desktop** (`!isMobile`). На iPad может быть `isMobile === false` (если matchMedia `(max-width: 640px)` false) — иногда. Но pinch handler работает always. Юзер на iPad может попасть в state где DRAG resize начался + PINCH resize начался одновременно (2 пальца + 1 пинч).

**Арнольд итог**:
> Edge case, but valid. На iPad portrait (768px wide) — оба активны. Pointer events могут гонять.

**Консенсус**:
- **P2**: при pinch-start — abort active drag-resize (set `resizeStartRef.current = null` + `setIsResizing(false)`). file:line `floating-consultant.tsx:2389-2401`.
- **P3**: добавить subtle visual hint при resize («чат: 50% × 60%») — юзер не теряется в текущем размере. file:line `floating-consultant.tsx:2378-2381` (snap badge есть, but only during desktop drag).

---

## Вопрос 9: Re:Текст кнопка — правильный moment появления?

**Контекст**: `floating-consultant.tsx:2818-2833`. Кнопка появляется на последнем bot-message если `hasLyricsDraft(text)` returns true (line 193-210: detects [Куплет]/[Припев] markers OR 3+ poetic-pattern lines). Click → `doSendMessage("Re:Текст — прочитай этот текст ещё раз... Сначала спроси какие 3-5 ключевых слов...")`.

**Критик**:
> Detection через `LYRICS_SECTION_RE` (line 189) — это regex с side-effect `lastIndex`. Если функция вызвана 2 раза подряд без reset, второй возврат может быть `false` несмотря на наличие markers. Поищем call site: line 2800 — `LYRICS_SECTION_RE.test(m.text); LYRICS_SECTION_RE.lastIndex = 0;` — OK reset. line 194: тоже reset. **OK на surface**, но это subtle bug-prone pattern (см. Apple-best-practices rule про global regex stateful).
> Plus кнопка показывается на ЛЮБОМ последнем bot-msg где есть «3+ poetic lines» — это включает многие normal Музa replies. False positive.

**Арнольд**:
> Detection is conservative — требует:
> - 4+ lines (line 200)
> - Каждая 15-80 chars
> - Без точки в конце
> - Без bullet/numerated
> - 3+ строки соответствуют — return true
> Это **only** для lyrics-drafts. Не для random reply.

**Критик в ответ**:
> «15-80 chars + no terminal punctuation» — это могло бы поймать список вопросов от Музы («Какой повод? Для кого? Когда юбилей?»). 3 строки без точек = поэзия по детектору.

**Арнольд итог**:
> Хм, ты прав. False positive likely. Но не critical — кнопка показывается без вреда (юзер может игнорировать).

**Консенсус**:
- **P2**: усилить detection: добавить требование «3+ строки выглядят как ритм» (например — длина строк отличается на ≤30%, или есть rhyming pattern detection). file:line `floating-consultant.tsx:193-210`.
- **P3**: ALSO show Re:Текст если bot-message contains explicit `[Куплет 1]` / `[Припев]` — это сильный сигнал. Already covered by LYRICS_SECTION_RE check, но make sure prio over heuristic.

---

## Вопрос 10: Текст песни столбиком — persona prompt + frontend formatter

**Контекст**:
- Persona prompt `consultantPersona.ts:447-470` инструктирует LLM выдавать строки на отдельных линиях, не через `/` или `|`.
- Frontend `normalizeLyricsBlocks` (line 212-228 floating-consultant.tsx) — safety net: replaces `/`, `|` separators с `\n`.

**Критик**:
> Defense-in-depth — это хорошо. Но frontend regex `LYRICS_SECTION_RE` всё ещё stateful (см. Q9). Плюс normalize только если detected. Юзер может получить lyrics в singleline FROM LLM (если LLM проигнорировал persona) И detection пропустит (no `[Куплет]` markers).
> Plus frontend split по `/` и `|` (line 223-224) — может ломать legitimate URLs или text content (например юзер прислал ссылку и Музa цитировала её — `https://muzaai.ru/track/123` теперь sphlitnut on `/`).

**Арнольд**:
> Условие split: `\s+\/\s+` (with spaces around `/`). URL не имеет spaces. Safe.
> Plus split только в normalizeLyricsBlocks которая вызывается **только** если `LYRICS_SECTION_RE.test()`. Если в text нет `[Куплет]`/`[Припев]` — normalize не вызывается. URLs не страдают.

**Критик в ответ**:
> OK на URLs. Но если LLM выдаёт строки lyrics через `;` или `—` (em-dash)? Не покрыто. Edge case.

**Арнольд итог**:
> Yes, edge. But minor — persona prompt strong, LLM compliance high.

**Консенсус**:
- **P3**: расширить normalize: also split на `\s+;\s+` (semicolon) и `\s+—\s+` (em-dash) если есть section markers. file:line `floating-consultant.tsx:223-224`.
- **P3**: добавить test fixture с примерами LLM output (single-line lyrics в random format) и assert normalizeLyricsBlocks работает.

---

## Вопрос 11: Bubble max-w-[min(85%,38ch)] — типографически правильно?

**Контекст**: `floating-consultant.tsx:2791`. CSS class `max-w-[min(85%,38ch)]` на bubble div.

**Критик**:
> `38ch` = 38 character widths. Для русского текста — character widths variable. На font 13px: ~14px per ch in monospace, но font is `font-sans` (Inter) → average ~7-8px per character → 38ch ≈ 270-300px. OK для readability (50-75 chars per line ideal по типографии).
> НО: `min(85%, 38ch)` означает что на широком чате (380px+) — bubble ≤ 38ch (~290px), на узком (320px) — 85% × 320 = 272px. **разрыв ~20px при разных widths** — bubbles прыгают визуально при resize.

**Арнольд**:
> Это **good responsive design**. На широком экране bubbles не растягиваются (readability stays), на узком — занимают почти всю ширину. `min()` дает natural cap. Type best practice — line length 45-75 chars.

**Критик в ответ**:
> 38ch < 45-75ch optimal range. Узковато для chat где bubbles длиннее обычно (Музa пишет 100-300 chars per message). Юзер видит много многострочных bubbles даже для коротких ответов.

**Арнольд итог**:
> Fair. Можно расширить до 50ch без вреда.

**Консенсус**:
- **P2**: max-w-[min(85%,50ch)] — больше room на широких screens. file:line `floating-consultant.tsx:2791`.

---

## Вопрос 12: Музa goodbye animation — есть ли?

**Контекст**: Анализ всего `floating-consultant.tsx`. Поиск transition при `setChatOpen(false)`.

**Критик**:
> Никакой goodbye animation. `setChatOpen(false)` → drawer instantly disappears (только CSS `animate-in fade-in duration-300` на open, нет fade-out на close, нет outro). Музa-FAB в top-right остается, но без acknowledge закрытия чата.
> На emotional brand product (Музa — character) это **lost опportunity**. Slack делает «hi 👋» при close. Discord — slide-out. У нас — nothing.

**Арнольд**:
> Animation минимальна по дизайну — Босс много раз говорил «не переборщи с анимациями» (см. User-anim-preference rule). Юзер уходит = чисто, без UI debt.

**Критик в ответ**:
> User-anim-preference rule — про PlaysCounter pulse/orbits. Не про single-shot transition на close. Goodbye toast `«Музa: до встречи 💜»` на 800ms — minimal, no perf cost.

**Арнольд итог**:
> Принимаю. Single-shot toast OK.

**Консенсус**:
- **P2**: при close через `×` или `👋` — sonner toast «Музa: до встречи 💜» на 1.5 сек. file:line `floating-consultant.tsx:2640, 2647, 3332`.
- **P3**: при close — drawer slides out (180ms transform translateX(100%)) перед unmount. file:line same.

---

## Вопрос 13: Cross-channel pair-code — надёжность

**Контекст**: `floating-consultant.tsx:1010-1094` — initChatSession reads pair-code from URL hash (`#/pair/CODE`) или query (`?pair=`). Backend `webChatPair.ts` (122 lines) generates + matches codes.

**Критик**:
> Pair-code livens 24 часа (по design, see `webChatPair.ts`). Edge case: юзер пишет в TG в понедельник, переходит по link в среду — code expired, fresh session создаётся, **история теряется**. Юзер думает «Музa меня забыла».
> Plus pair-code visible в URL — может быть shared. Если юзер копирует link с code и шлёт другу — другой человек попадает в session первого. **Session hijack via shared link**.
> Доказательство: line 1112-1118 — `useEffect` auto-opens chat при detection pair, без verify «это тот же device».

**Арнольд**:
> 24h TTL — reasonable. Если юзер долго не приходит — нормально начать с нуля.
> Hijack risk: low — link редко shared (юзер не parses URL для share). Plus code single-use (consumed at first redeem).

**Критик в ответ**:
> Single-use? Check `webChatPair.ts:116` — `Проверяем что строка похожа на pair-code` (validation only). Не вижу `consumed` field. Если code reusable until TTL — hijack window 24h.

**Арнольд итог**:
> Надо проверить. Если reusable — это implementation gap.

**Консенсус**:
- **P1**: verify pair-code single-use semantics в `webChatPair.ts`. Если reusable — сделать `consumed_at` field + mark consumed at first redeem. file `apps/neurohub/server/lib/webChatPair.ts`.
- **P2**: добавить device fingerprint check (compare browser UA + screen size при redeem vs originatorMeta).
- **P3**: показать в chat header при pair-redeem «Подтянула наш разговор из Telegram (XX мин назад)» — юзер видит continuity.

---

## Вопрос 14: User-memory — Privacy implications

**Контекст**: CLAUDE.md User-memory-context rule. `user_memory` table — summary/facts_json/preferences. Музa использует при authedUserId.

**Критик**:
> Privacy concerns:
> 1. **Plain-text summary** в `data.db` (SQLite local). Если БД stolen — все юзер'ские истории leak. CLAUDE.md mentions «admin SSH-only access» но это is **just access control**, не encryption.
> 2. **Когда юзер удаляет аккаунт** — нет cascading DELETE на `user_memory`. Чек: посмотреть schema. Если нет ON DELETE CASCADE — memory остаётся forever.
> 3. **Admin может edit memory** (CLAUDE.md says) — это **violates** privacy expectation. Юзер думает «Музa меня знает», на деле админ может править facts_json что угодно. Если юзер увидит — breach of trust.

**Арнольд**:
> 1. SQLite на admin VPS = OK для now. Encryption — future, не блокер.
> 2. Cascade — easy fix.
> 3. Admin edit нужен для debugging / abuse cases (юзер вводит garbage в Музу, нужен sanitize).

**Критик в ответ**:
> Admin edit OK для debug, но юзер должен иметь visibility «admin redacted memory» в кабинете. Transparency.

**Арнольд итог**:
> Fair. Audit-log entry уже есть per CLAUDE.md, but не surfaced юзеру.

**Консенсус**:
- **P1**: verify schema.sql имеет `ON DELETE CASCADE` на `user_memory.user_id`. Если нет — добавить migration.
- **P2**: при admin edit `user_memory` — push notification юзеру «Музa обновила воспоминания (changes: …)».
- **P3**: encryption at-rest for SQLite (SQLCipher) — future задача, large scope.

---

## Вопрос 15: Female-voice rule — applied везде? Tests?

**Контекст**: `consultantPersona.ts:250-267` — strict female-voice instruction. `muzaTools.ts` — tools have hardcoded ответы typedef'ные ('Не нашла', 'Не нашла треки'). chatGenerationTools.ts checked.

**Критик**:
> Persona prompt good. НО: hardcoded ответы в tools.ts — Musa-female-voice rule audit:
> - `muzaTools.ts:1391` «Не нашла трек» — OK female
> - `chatGenerationTools.ts:338` «Текст готов» — нейтрально
> - `chatGenerationTools.ts:647` «Запустила генерацию» — OK female
> - **Но**: `muzaTools.ts:1275` «Создала запись...» — OK female. Good.
> 
> Грузя checked все hardcoded strings. **OK, female везде**. Single risk: persona prompt не доходит до DeepSeek calls (Anthropic chain works, DeepSeek может выдавать nyпил/male).
> Plus **no automated tests**. CLAUDE.md audit-rule говорит «grep should be empty» — но **regularly checked? Нет CI/CD test**.

**Арнольд**:
> Grep manual check — fine для текущего scale. Когда добавим больше channels (VK / WhatsApp) — auto-test.

**Критик в ответ**:
> Сейчас уже 3 канала (web/TG/Max). Adding test уместно сейчас.

**Арнольд итог**:
> Add test 5 min job — OK.

**Консенсус**:
- **P1**: add Vitest test `apps/neurohub/server/__tests__/musa-female-voice.test.ts`: grep through tools+persona+fallback strings, assert no `подобрал[^а]|сделал[^а]|нашёл|готов[^а]|рад[^а]|увидел[^а]|услышал[^а]` matches.
- **P2**: при первом LLM-call response — server-side post-process: regex-detect male-form о Музе, log warning + auto-rewrite to female. file: `routes.ts /api/muza/chat`.

---

## Вопрос 16: Premium voice messages — feature flag? отделение free vs paid?

**Контекст**: CLAUDE.md Premium voice-messages rule. Backend схема готова (`audio_premium_only`, `premium_subscriptions`). **Frontend gate**: проверил `floating-consultant.tsx` — НЕТ кода который реализует gate UI. Audio messages не показываются вообще в текущем UI.

**Критик**:
> Backend wired (routes.ts:12731 confirms tariff mapping), но **frontend completely missing**. Юзер с paid `voice_messages` tier не увидит audio messages, потому что UI их не рендерит. ChatMessage type не имеет `audioUrl` field (line 139-158 floating-consultant.tsx).
> Это **dead feature** — backend ждёт frontend.

**Арнольд**:
> Может быть planned для следующего sprint. Backend готов = good. Frontend follows.

**Критик в ответ**:
> Если backend готов 3+ дня, frontend не пишут — это **technical debt accumulating**. Premium-subscriptions table уже migrated в prod? Если да — юзеры могут купить tier который не работает (нет UI).
> Plus Pricing-single-source rule: цена «премиум voice» должна быть везде согласована. Проверил `consultantPersona.ts` — упоминания premium есть, но конкретной цены не вижу.

**Арнольд итог**:
> Yes — это либо «закатать в next sprint» либо «отключить tariff_key=premium_voice_msg в /issue_invoice» пока UI нет.

**Консенсус**:
- **P0**: либо disable `premium_voice_msg` tariff в `muzaTools.ts TARIFFS` (если UI not ready), либо implement minimal UI gate. Verify не списываются деньги за фичу которой нет. file `apps/neurohub/server/lib/muzaTools.ts` (search TARIFFS).
- **P1**: add `audioUrl` + `audioPremiumOnly` to ChatMessage type + render audio player when present. file `floating-consultant.tsx:139-158, 2761-2895`.

---

## Вопрос 17: Yars из мессенджеров — Защита от impersonation

**Контекст**: CLAUDE.md Yars-messenger-no-autoapply rule. Поток: msg from TG bot → `is_yars_command=1` → high-risk goes pending → review в Claude chat → apply.

**Критик**:
> Impersonation risk: если admin TG account compromised (SIM swap) — attacker может писать «Ярс: DROP TABLE users» в TG-bot. Detection set's `is_yars_command=1`. Если category=`code_change` (high-risk) — goes pending → ждёт review here. SAFE.
> Но если category=`news_post` (whitelisted) — auto-applied через `yarsExecutor`. **Attacker может post fake news on landing**.
> Doc says low-risk categories (news_post, kb_update, ui_text) auto-apply. Если impersonator gets admin TG → можно вандализм контента.

**Арнольд**:
> SIM swap rare. Plus `ADMIN_TRUSTED_IPS` env separately gates apply (per Admin-Muza-message base rule). Multi-layer: TG sender = admin + IP whitelisted + category whitelisted = apply.
> Если TG-bot хостится отдельно (через webhook), IP не легко spoof'ить.

**Критик в ответ**:
> ADMIN_TRUSTED_IPS gates `/api/muza/chat` Web входы, не TG webhooks. TG webhooks приходят с IPs Telegram (149.154.160.0/20). Не наши trusted IPs. То есть **TG-каналы вообще не gate'ятся по IP**.

**Арнольд итог**:
> Ah — yes. TG-Yars не имеет IP gate. SIM swap → news post = possible.

**Консенсус**:
- **P0**: для TG-bot Yars — дополнительный check `recent successful login from same Telegram_user_id ≤ 7 days from web admin panel` (means user actively использует both web и TG). file: `apps/neurohub/server/plugins/telegram-bot/module.ts` (yars handler).
- **P1**: даже whitelisted categories из TG — require Claude review ALWAYS (не auto-apply). Trade-off slow vs safe. Recommend safe.
- **P2**: 2FA для Ярс commands из TG — sms-OTP confirm before apply.

---

## Вопрос 18: Multi-persona TG (Аня/Татьяна/Мария/Ольга) — confusion?

**Контекст**: `consultantPersona.ts:38-104` — 14 personas. Hash-stable выбор по userId. CLAUDE.md Single-persona-across-channels rule.

**Критик**:
> Юзер на TG получает «Аня». Тот же юзер на web — `consultantPersona.ts:358-368` форсит имя «Музa» (всегда). То есть **persona name НЕ единая через channels** — на TG Аня, на web Музa.
> Plus юзер с persona='Аня' на TG если потом залогинится с другого account — может получить «Татьяна» (новый userId → новый hash). Persona unstable across accounts.

**Арнольд**:
> Web force «Музa» — это per Босс decision (commit `чате только аватар Музы`). Внутренний характер остаётся (Аня/Татьяна влияют на tone), но имя одно.
> Different accounts = different users = naturally different personas. **Not unstable, by design**.

**Критик в ответ**:
> Single-persona-across-channels rule cites: «На сайте сегодня показывается персона X — в Telegram-боте этому же юзеру тоже отвечает X». Это implies same name. Currently TG=имя по hash, web=всегда Музa. **Violation of rule**.

**Арнольд итог**:
> Текст rule говорит «one persona», но Босс позже refined: «в чате только аватар Музы». Sometimes rules layer evolve. Latest Босс statement wins.

**Консенсус**:
- **P2**: clarify rule in CLAUDE.md — «web always shows 'Музa', TG shows persona name (internal mood), но styleGuide одинаково across channels». Update Single-persona-across-channels rule wording. file `CLAUDE.md` (search rule).
- **P3**: consider showing «Музa (настроение: Аня)» в TG bot greeting — гибрид. Юзер видит «Музa» как brand, «Аня» как mood-marker.

---

## Вопрос 19: Chat history pagination — visibleCount = 5, кнопка «показать ещё»

**Контекст**: `floating-consultant.tsx:771` visibleCount=4 default. Line 2738-2746 «Показать ещё» button. Кнопка `setVisibleCount(c => c + 5)`.

**Критик**:
> visibleCount=4 как default — **слишком мало для long conversation**. После 20 сообщений юзер должен 4 раза нажать «показать ещё». UX friction.
> Plus button **сверху скролла** — но history scroll is from top to bottom (latest at bottom). Button shown «Показать ещё ↑ … всего N» — at top. Юзер кликает → старые догружаются → scroll position **может прыгнуть** (нет manual anchor).

**Арнольд**:
> Lazy-loading паттерн стандартный для chat UI. 4 = compact для mobile (60vh chat = ~5 msgs visible). Click expand — paginate up.
> Scroll prыжок — Slack and Discord имеют same issue. Юзер привык.

**Критик в ответ**:
> default 4 → mobile показывает 1-2 msg + header + tiles + input = жмётся. Should be 8-10. Plus expandable controls already exist (⛶ fullscreen). При fullscreen visibleCount must scale up.

**Арнольд итог**:
> Yes. Sensible.

**Консенсус**:
- **P1**: default visibleCount=8 (instead of 4). file:line `floating-consultant.tsx:771`.
- **P2**: visibleCount scales with chatFullscreen: при `chatFullscreen=true` set visibleCount=40. file:line `floating-consultant.tsx:750-752` (useEffect on fullscreen).
- **P3**: при «показать ещё» — preserve scroll position через `scrollTop` anchor (measure top msg ID before, restore after).

---

## Вопрос 20: Mini-player в чате — singleton attached + race conditions

**Контекст**: `floating-consultant.tsx:295-498` `ChatMiniPlayer`. Polling `getPersistentPlayerAudio` каждые 1000ms (line 323). dispatchAction для prev/next с fetch fallback (line 356-399).

**Критик**:
> Race conditions analysed by author already (comments lines 362-398): 250ms wait → fetch → re-check src. Reasonable. BUT:
> - Polling 1000ms — wasted cycles when chat not open. ChatMiniPlayer renders only when `chatOpen=true`, so OK.
> - **Memory leak risk**: subscribe в useEffect line 327-346, cleanup OK.
> - **Bigger problem**: `window.__muziaiTrack` global — это глобальный state singleton. Любой код может править. landing.tsx pisha при `playTrack`. Если другой страница (dashboard) updates differently — race.
> Plus `ChatMiniPlayer.dispatchAction` falls back to `/api/playlist?status=main` always — но если юзер слушает «my tracks» panel (dashboard), the next/prev должны идти по dashboard'ской пагинации, не по public playlist. **Wrong list source**.

**Арнольд**:
> Public playlist fallback — OK для chat context. Chat в большинстве кейсов общается о public tracks (find_public_track), не personal tracks.
> If user listening personal tracks → prev/next в чате могут switch to public — это minor UX glitch, не critical.

**Критик в ответ**:
> Юзер на /dashboard playing personal track «Маме на 70-летие» → открыл чат → нажал next-кнопку → попал на random public track. **Confusion**. Юзер думает «что? я слушал свой трек!».

**Арнольд итог**:
> Yes, possible. Edge case but real.

**Консенсус**:
- **P2**: ChatMiniPlayer должен read source list из `window.__muziaiPlaylistSource` (set'ится same as `__muziaiTrack` by landing/dashboard). Fall back на public playlist только если не задан. file:line `floating-consultant.tsx:376`.
- **P3**: при switch tracks из чата — Музa получает event что юзер прыгнул → может add context в next reply.

---

## Вопрос 21: chatMemo (extracted memory) — отражение в UI

**Контекст**: `floating-consultant.tsx:2692-2717`. Pills с extracted memo (Имя/Повод/Кому/Настр/Стиль/Голос/ДР). Backend extractMemoryFromHistory.

**Критик**:
> Pills useful, but **extracted data может быть wrong**. LLM может неверно extract (parse `«мама любит петь»` → recipient=мама, OK; parse `«мне нужна песня про маму на 70-летие»` → could be `Кому=я` или `Кому=мама`).
> Юзер видит wrong pill «Кому: я» когда хотел маме — это confusion. Нет edit/delete pill UX.

**Арнольд**:
> Pills informational. Backend tries best. Юзер может corrected via chat dialog if needed.

**Критик в ответ**:
> Better UX: click pill → input field → юзер правит → save. Tap-to-edit pattern.

**Арнольд итог**:
> Nice-to-have, not blocker.

**Консенсус**:
- **P3**: click pill → modal или inline edit + send `update_memo` tool to LLM. file:line `floating-consultant.tsx:2707-2713`.

---

## Вопрос 22: Sound toggle 🔔/🔕 — initial state false

**Контекст**: line 790-792. `soundEnabled` default false (`localStorage.getItem === "1"`).

**Критик**:
> Default OFF — user friendly (no surprise beeps), but ALSO юзер может не знать что есть sound. **Discovery problem**. Settings hidden behind 🔕 icon в crowded header.

**Арнольд**:
> Audio in web без user gesture is anti-pattern (W3C Autoplay Policy). Default off correct.

**Критик в ответ**:
> Default OFF — OK. But discovery is the issue. Show short hint «🔔 нажми чтобы Музa звякнула при ответе» on first user message?

**Арнольд итог**:
> Tooltip on first hover already there (line 2627). Enough.

**Консенсус**:
- **P3**: на first user message — flash toast «нажми 🔔 в header если хочешь звуковые уведомления». One-time, dismissable. file:line `floating-consultant.tsx:1441` (после `setChatMsgs(m => [...m, { role: 'user', text }])`).

---

## Вопрос 23: Welcome tiles vs CHAT_SUGGESTIONS toggle

**Контекст**: line 162-167 `CHAT_SUGGESTIONS` (4 text chips), line 3180-3203 — shown only if `showSuggestions=true` (toggle through 💡 button).

**Критик**:
> Two welcome UIs: tiles auto-show + suggestions toggle. **Redundant**. Tiles already show 8 options, suggestions add 4 more text-chips. Юзер видит 12 starter prompts.

**Арнольд**:
> Tiles = visual onboarding (8 situations). Suggestions = text-only alternative for users who don't like visual buttons. Coexist OK.

**Критик в ответ**:
> 8 tiles cover same range as 4 suggestions. Suggestions add no new value. Drop them.

**Арнольд итог**:
> Reasonable cut.

**Консенсус**:
- **P2**: remove CHAT_SUGGESTIONS toggle and `showSuggestions` state — they duplicate tiles. file:line `floating-consultant.tsx:162-167, 755-756, 3180-3204, 3228-3242`.

---

## Вопрос 24: drawerSnap (br/bl/tr/tl/center) + ⊕ snap-to-center button

**Контекст**: line 779-780, 2389-2492. Юзер drags левую полоску chat → snap to corner. ⊕ button line 2501-2507 для центрирования.

**Критик**:
> 5 snap positions + drag = много control points. Юзер случайно тащит handle → drawer прыгает в другой угол. Plus snap **на pointerUp** — мгновенный, нет preview.

**Арнольд**:
> Power-user feature. Mobile-первый user не trogaet handle.

**Критик в ответ**:
> Handle viz `w-3 h-12 left-0` — accidental tap probable on iPad portrait (scroll сверху-вниз попадает на handle).

**Арнольд итог**:
> Tap threshold 30px guard есть (line 2483). Не trigger при scroll.

**Консенсус**:
- **P2**: drag-handle width 3px → 6px on mobile (better grab) but only show при `!isMobile` && hover. file:line `floating-consultant.tsx:2494`.
- **P3**: добавить snap-preview ghost-drawer пока перетаскиваешь. (Visual feedback before commit).

---

## Вопрос 25: chatInput textarea — auto-resize до 6 lines (132px max)

**Контекст**: line 3247-3296. textarea с auto-resize при typing.

**Критик**:
> Max 132px на input area — после 6 lines внутренний scroll. Юзер не видит начало своего сообщения когда пишет long text. **Особенно проблема на mobile** где input уже dominate screen.
> Plus `min-h-[3.25rem] max-h-[8.25rem]` (line 3294) — фиксированные значения. `8.25rem` = 132px. Should be vh-based для responsive.

**Арнольд**:
> 132px = ~6 lines = достаточно для 95% messages. Long texts — юзер просто scrolls inside textarea.

**Критик в ответ**:
> На mobile с virtual keyboard up — chat height shrinks, input доминирует. Maybe responsive cap (50% chat height vs 132px hardcoded).

**Арнольд итог**:
> Edge case. Mobile keyboard handling and textarea scroll работают.

**Консенсус**:
- **P3**: max-height based on `chatSize.h ? chatSize.h * 0.4 : 132` — dynamic cap. file:line `floating-consultant.tsx:3262, 3294`.

---

## Вопрос 26: Voice-mode + audio recordings — missing UI?

**Контекст**: persona prompt mentions «аудио-вход» (voice STT mode for music gen). Chat не имеет mic button — нет голосового input.

**Критик**:
> Persona instructs Музу предлагать «надиктовать голосом» для music gen, но **в чате нет mic button** для actual voice input. Юзер должен открыть /music и use audio mode там. Lost opportunity для voice-первого UX.

**Арнольд**:
> Voice input — separate component (`musa-voice-fab.tsx`). Coexists с chat. Юзеры могут use voice независимо.

**Критик в ответ**:
> But voice-fab не integrated с chat. Voice → transcript → goes to /music form, не в chat. Chat и voice — два разрозненных потока.

**Арнольд итог**:
> Future integration scope. Не блокер.

**Консенсус**:
- **P3**: add 🎙 mic button в chat input area. Click → record → STT (Yandex SpeechKit) → text inserted в textarea (юзер может edit before send). file:line `floating-consultant.tsx:3243-3296`.

---

## Вопрос 27: chat-mini-player vs main player — duplicate audio control

**Контекст**: `ChatMiniPlayer` controls prev/next/play/pause through CustomEvent `muza-player-action`. landing.tsx listens.

**Критик**:
> Юзер на mobile открывает чат — chat-mini-player visible. Lower bar landing player ALSO visible (если есть). **2 plyaer UI одновременно**. Different controls (mini doesn't have seek, landing does).

**Арнольд**:
> Mini-player только если `window.__muziaiTrack !== null`. Если юзер не играет — mini hidden (line 419 `if (!track) return null`). When playing — mini visible inside chat = convenient, не дублирует, complements (landing player может быть offscreen if scrolled).

**Критик в ответ**:
> Когда chat closed — mini player **doesn't exist** (it's внутри chat). Когда chat open — mini visible AND landing player visible. Double UI for same state.

**Арнольд итог**:
> Trade-off. Convenience > minimalism here.

**Консенсус**:
- **P3**: при `chatOpen=true` — auto-hide landing's bottom player bar (event dispatch). Юзер видит только chat-mini. file:line `floating-consultant.tsx:696-708` (chatOpen useEffect dispatch).

---

## Вопрос 28: Pricing displayed in chat?

**Контекст**: persona mentions «399 ₽» multiple times. Поиск в `floating-consultant.tsx` — нет hardcoded prices в UI. Pricing-single-source rule says price comes from `lib/pricing.ts getCurrentPriceKopecks()`.

**Критик**:
> persona prompt hardcodes «399₽» (line 635: «у нас 399₽», line 642: «399₽», и далее). **Violates Pricing-single-source rule** — если price changes via tariff_history, persona prompt всё ещё говорит «399».
> Check `consultantPersona.ts` for ALL price mentions:

**Арнольд**:
> Persona prompt — static text. Dynamic injection требует template + DB lookup при каждом сборки prompt'a. Performance/complexity. Сейчас «399₽» = market price, не часто меняется.

**Критик в ответ**:
> Pricing-single-source rule explicitly mentions `consultantPersona.ts` as place to update on price change. If we don't auto-pull from getCurrentPriceKopecks, we'll forget и Музa будет lying юзерам про price.

**Арнольд итог**:
> Critical correctness issue. Pricing-single-source rule explicit, hardcoded prices in persona = nonexempt violation.

**Консенсус**:
- **P0**: replace hardcoded «399₽» в persona prompt с `${musicPrice}₽` interpolated at build time (require getCurrentPriceKopecks/100). file:line `consultantPersona.ts:635, 642` and grep остальные `399`. ~10 instances likely.
- **P1**: add CI/test grepping persona prompt for any number followed by ` ₽` — fail if not interpolated.

---

## Вопрос 29: chatPersona unused — dead code?

**Контекст**: line 760-762:
```ts
const [chatPersona, _setChatPersona] = useState<{ name: string; avatar: string } | null>(null);
void chatPersona;
const setChatPersona = _setChatPersona;
```

**Критик**:
> `chatPersona` state создан, never read in UI (`void chatPersona`). setChatPersona вызывается в `initChatSession` (line 1044) и `continueWithSession` (line 1175) — **writes only**. Dead state. `void` operator — marker to ESLint что мы know не используем. Это **code smell**.

**Арнольд**:
> Author comment line 757-760 объясняет: «state сохраняем для совместимости с историческими сессиями». Backend всё ещё может send persona, frontend silently consumes. If we ever bring persona back to UI, code ready.

**Критик в ответ**:
> «If we ever» — что не происходит with Single-persona-rule «всегда Музa». Better — RIP это полностью.

**Арнольд итог**:
> Cleanup OK.

**Консенсус**:
- **P3**: remove `chatPersona` state and setChatPersona writes (line 760-762, 1044, 1175). Если LLM не нуждается в persona в response — clean. file:line `floating-consultant.tsx:760-762, 1044, 1175`.

---

## Вопрос 30: Smart-bubble triggers — idle/form_abandon/no-play

**Контекст**: line 1855-1939. journey-event listener + 90sec landing tick.

**Критик**:
> 4 trigger types: idle_30s / form_abandon / 90sec-no-play / click-tracking. Once-per-session through `smartFiredRef`. **Risk**: юзер dismissed Музу (3 раза + MAX_DISMISS), but smart trigger ignores dismiss state and shows again через `setVisible(true)` line 1870. Bypasses user's «уйди» signal.

**Арнольд**:
> idle_30s = user actively struggling. Re-showing Музу OK (it's helping). Override of dismiss intentional.

**Критик в ответ**:
> Юзер 3-tap dismiss = strong signal «не сейчас». 1 час cooldown (REAPPEAR_MS_SECOND). Smart-trigger bypasses → юзер раздражён.

**Арнольд итог**:
> Should respect long-cooldown.

**Консенсус**:
- **P2**: smart trigger respect `dismissedRef.current >= 2` — если юзер dismissed 2+ times, не bypass cooldown. file:line `floating-consultant.tsx:1867-1872`.

---

# Morning action items

> P0 — must-do before pushing to prod. P1 — should-do. P2 — nice. Open Questions — нужен Босс call.
> Total estimated time: P0 + P1 = ~3-4 hours focused.

## P0 (must-do, before next deploy)

1. **Pricing-single-source violation in persona prompt** — replace hardcoded «399 ₽» / «99 ₽» с dynamic interpolation from `getCurrentPriceKopecks()`. file `apps/neurohub/server/lib/consultantPersona.ts` lines 635, 642 + grep остальные `399`/`99`/`₽`. ~15-30 min.

2. **Premium voice_messages dead feature** — verify в `apps/neurohub/server/lib/muzaTools.ts` `TARIFFS` объект. Если `premium_voice_msg` shipping в issue_invoice но UI не показывает audio messages — disable tariff temporarily OR ship minimal UI gate. Risk: юзер платит за фичу которой нет. ~10 min audit + decision.

3. **Window controls duplicate close (`−` `×` `👋`)** — выбрать паттерн: рекомендую удалить `−` minimize (line 2638-2644), оставить `×` close + `👋` footer minimize. Разнести их семантически (× clears session, 👋 keeps it). file `floating-consultant.tsx:2638-2651, 3330-3335`. ~15 min.

4. **Header overflow on small mobile** — A−/A+ + paired badge + 8 other buttons overflow на iPhone SE (345px). Collapse A−/A+ в settings drawer OR reduce range to 11-18. file `floating-consultant.tsx:2509-2651`. ~30 min.

5. **TG-bot Yars impersonation gap** — TG webhooks не gated through `ADMIN_TRUSTED_IPS`. SIM swap → fake news post auto-applies. Add check: recent web admin login from same telegram_user_id ≤ 7 days OR disable auto-apply для TG entirely. file `apps/neurohub/server/plugins/telegram-bot/module.ts` Yars handler. ~30 min.

## P1 (should-do)

1. **iOS notch overlap on top-right FAB** — safeTop=76px может быть недостаточен в landscape с Dynamic Island. Use `env(safe-area-inset-top, 0px) + 8px`. file `floating-consultant.tsx:566`. ~10 min.

2. **Pair-code single-use semantics** — verify `webChatPair.ts` consumes code at first redeem. Если reusable — add `consumed_at` field. file `apps/neurohub/server/lib/webChatPair.ts`. ~20 min.

3. **user_memory cascade delete** — verify schema. Если нет `ON DELETE CASCADE` — add migration. file `apps/neurohub/shared/schema.ts` или `storage.ts` migration. ~20 min.

4. **Female-voice automated test** — add Vitest test grepping tools/persona for male-form о Музе. file `apps/neurohub/server/__tests__/musa-female-voice.test.ts`. ~30 min.

5. **chatMemo paired badge `shrink-0` + `truncate`** — paired badge толкает header за viewport. file `floating-consultant.tsx:2514-2518`. ~5 min.

6. **Tooltip preview pending messages** — badge с числом → tooltip с первыми 30 chars каждого pending msg. file `floating-consultant.tsx:3318-3322`. ~15 min.

7. **Tile seeds укоротить** — `"Песня для мамы на юбилей"` instead of «Хочу подарить песню маме на юбилей. Накидай сразу 8-12 строк...». Не deceptive. file `floating-consultant.tsx:230-239`. ~10 min.

8. **default visibleCount=8** (not 4) + scale to 40 при `chatFullscreen=true`. file `floating-consultant.tsx:771, 750-752`. ~10 min.

## P2 (nice-to-have)

1. Add 9th tile «✏️ Напишу сам» в welcome tiles (для users who don't fit categories). file `floating-consultant.tsx:3158-3179`. ~10 min.

2. Cancel pending messages button (×) рядом с badge counter. file `floating-consultant.tsx:3318-3322`. ~15 min.

3. Dedup pending messages (filter duplicates перед push). file `floating-consultant.tsx:1691`. ~5 min.

4. Reduce opacity modes 3 → 2 (плотно / стекло). file `floating-consultant.tsx:727-736, 2543-2551`. ~10 min.

5. Bubble max-w 38ch → 50ch. file `floating-consultant.tsx:2791`. ~2 min.

6. Goodbye toast при close — sonner «Музa: до встречи 💜». file `floating-consultant.tsx:2640, 2647, 3332`. ~10 min.

7. ChatMiniPlayer source list from `window.__muziaiPlaylistSource` fallback. file `floating-consultant.tsx:376`. ~20 min.

8. Remove CHAT_SUGGESTIONS toggle (duplicate of tiles). file `floating-consultant.tsx:162-167, 755-756, 3180-3204, 3228-3242`. ~10 min.

9. Pinch-resize abort active drag-resize. file `floating-consultant.tsx:2389-2401`. ~5 min.

10. Smart-trigger respect dismiss cooldown (`dismissedRef.current >= 2` → no bypass). file `floating-consultant.tsx:1867-1872`. ~10 min.

11. Strengthen `hasLyricsDraft` heuristic (require length similarity или rhyme detection). file `floating-consultant.tsx:193-210`. ~30 min.

12. Admin `user_memory` edits trigger user notification. ~30 min, depends on schema.

## P3 (cosmetic, future)

- Click-pill-to-edit chatMemo
- Drawer slide-out transition при close
- Mic button в chat для voice input
- Auto-hide landing player bar при chatOpen
- chatInput textarea max-height responsive

## Open questions для Босса

1. **Vопрос 3: 👋 Ухожу скоро вернусь vs ×** — оставить ОБЕ кнопки (разная семантика) или унифицировать? Я предлагаю убрать `−` minimize, оставить `×` (truly close) и `👋` (soft minimize). Согласие?

2. **Вопрос 16: premium_voice_msg disable** — backend готов, frontend UI отсутствует. Disable tariff temporarily ИЛИ ship MVP audio rendering в чате? Если ship — какой timeline?

3. **Вопрос 18: Single-persona rule clarification** — текущий поведение: TG = имя по hash (Аня/Татьяна/...), web = всегда «Музa». CLAUDE.md rule говорит «один persona by name». Refine rule? Predпочту: web=Музa (final), TG=Музa тоже (drop hash naming).

4. **Вопрос 4: tiles auto-show — добавить «✏️ Напишу сам» 9th tile?** OR оставить 8 и положиться на input box?

5. **Вопрос 5: cancel pending когда LLM долго (45s)** — auto-cancel оставшиеся pending если LLM timeout, ИЛИ продолжать гнать всех по очереди?

6. **Вопрос 13: pair-code TTL** — 24h sometimes too short (юзер в TG в понедельник, переходит в среду). Extend to 7 days?

7. **Вопрос 28: persona-prompt pricing interpolation** — может Музa cite specific prices через tool `get_pricing` (LLM calls tool when needed) instead of hardcode? Это решит rule + добавит accuracy. Согласие на refactor?

---

## Honest assessment summary

| Aspect | Status | Owner sentiment |
|--------|--------|-----------------|
| UI overload в header | 🔴 Серьёзно | Критик прав |
| Welcome tiles | 🟡 Полезно но deceptive seeds | Both правы (split decision) |
| Очередь сообщений | 🟢 Логика OK, UX полирована | Арнольд прав |
| Female-voice rule | 🟢 Applied хорошо | Both правы, нужен test |
| Pair-code | 🟡 24h TTL норм, single-use надо verify | Mostly fine |
| Pricing in persona | 🔴 Hardcoded violation | Критик прав, ПОЧИНИТЬ |
| Premium voice msgs | 🔴 Dead feature backend ready, no UI | Критик прав |
| Yars from TG | 🔴 Impersonation gap | Критик прав |
| Memory privacy | 🟡 OK для now, cascade delete нужен | Both balanced |
| Window controls | 🔴 Redundant close-кнопки | Критик прав |
| FAB top-right | 🟢 Дизайн-decision Босса | Арнольд прав |
| Sound toggle | 🟢 Default OFF correct | Арнольд прав |
| chatMiniPlayer | 🟡 Wrong list source на dashboard | Edge case |
| chatPersona dead state | 🟢 Tiny dead code, cleanup OK | Both правы |
| Smart triggers bypass dismiss | 🟡 Игнорирует strong signal | Критик slightly прав |

**Overall verdict**: 5 P0 issues — Босс должен решить first thing morning. UX polish (P1-P2) — incremental. Architecture в целом разумна, проблемы локальны.

*Generated 2026-05-24 ~07:00 MSK by Claude (subagent: chat-window-debate-audit).*
