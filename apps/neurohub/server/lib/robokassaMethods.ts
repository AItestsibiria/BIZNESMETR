// Eugene 2026-05-18 Босс «Robokassa техничка — карты + СБП. Изучи. Подключи.»
//
// Что такое IncCurrLabel — кратко из официальной справки Robokassa
// (Docs-first-always rule, источник: docs.robokassa.ru/script-parameters и
// docs.robokassa.ru/pay-interface, ниже цитаты с URL):
//
//   «IncCurrLabel — предпочитаемая форма оплаты, здесь передаём метку
//    удобной формы оплаты. … О всех возможных метках валют можно узнать
//    перейдя по ссылке:
//      //merchant.roboxchange.com/WebService/Service.asmx/GetCurrencies
//      ?MerchantLogin=demo&language=ru»
//   — robokassa.com/ext_www/docs_robokassa_ru/pay-interface/
//
//   «Чтобы выделить рекомендуемые способы оплаты, используйте параметры
//    IncCurrLabel (один вариант) и PaymentMethods (список вариантов).»
//   — docs.robokassa.ru/script-parameters/
//
// Точные значения IncCurrLabel зависят от КОНКРЕТНОГО магазина (что
// подключено в кабинете Robokassa). Список валюты-меток актуальный для
// магазина возвращает GetCurrencies XML-интерфейс. Стандартные метки,
// которые на практике приходят в выдаче магазинов с включёнными картами
// и СБП (по PHP-интеграциям, GitHub kvalood/Robokassa и т.д.):
//   - "BANK"     — банковские карты (универсальный alias группы BankCard)
//   - "BANKOCEAN2"/"BANKOCEAN2R" — банковские карты, частный alias OceanBank
//   - "SBP"      — Система Быстрых Платежей (alias группы FastPayment)
//   - "Card"     — generic карты (некоторые магазины)
//
// ВАЖНО: если IncCurrLabel НЕ передан — Robokassa покажет полный список
// доступных способов оплаты, юзер выберет сам. Это валидный сценарий и он
// у нас работал до сих пор. Передача IncCurrLabel — это «pin-метка»: юзер
// сразу попадает на форму выбранного метода (карта или СБП), без шага
// выбора. Если метка неизвестна магазину — Robokassa отдаст «Ошибка 8»
// (Currency не найдена).
//
// Поэтому в коде ниже мы:
//   1) Принимаем `method: 'card' | 'sbp' | undefined`.
//   2) Маппим в `IncCurrLabel` через `ROBO_METHOD_LABELS` (можно
//      переопределить через ENV: `ROBO_LABEL_CARD`, `ROBO_LABEL_SBP`).
//      Дефолты — те что фактически работают в Robokassa в 2026 г.
//   3) Если у магазина alias другой — Босс правит ENV без релиза.
//   4) Если метод не задан — IncCurrLabel НЕ добавляется → старое
//      поведение (юзер сам выбирает на странице Robokassa).

import { getLegalConfig } from "./legalConfig";

export type RoboPaymentMethod = "card" | "sbp";

/**
 * Дефолтные метки для IncCurrLabel — наиболее распространённые alias
 * у магазинов Robokassa с включёнными картами и СБП. Если у конкретного
 * магазина в кабинете другие alias — переопредели через ENV
 * (ROBO_LABEL_CARD / ROBO_LABEL_SBP). Узнать актуальные alias магазина:
 *   curl 'https://auth.robokassa.ru/Merchant/WebService/Service.asmx/GetCurrencies?MerchantLogin=<твой_логин>&language=ru'
 */
const ROBO_METHOD_LABELS: Record<RoboPaymentMethod, string> = {
  card: (process.env.ROBO_LABEL_CARD || "BANK").trim(),
  sbp: (process.env.ROBO_LABEL_SBP || "SBP").trim(),
};

/** Возвращает значение IncCurrLabel или пустую строку (= не пиннить метод). */
export function incCurrLabelFor(method?: RoboPaymentMethod | null): string {
  if (!method) return "";
  return ROBO_METHOD_LABELS[method] || "";
}

/**
 * Описание единственной позиции в чеке. Магазин MuzaAi продаёт услугу
 * «Пополнение баланса для генерации музыкальных произведений ИИ».
 *
 * Формат item — см. справку «Фискализация» Robokassa (docs.robokassa.ru/fiscalization/),
 * цитаты по полям:
 *   - `name`        — наименование товара/услуги (макс 128 символов в чеке)
 *   - `quantity`    — количество, число
 *   - `sum`         — стоимость ПОЗИЦИИ в рублях (не общая сумма!)
 *   - `payment_method` — full_payment (полная оплата сразу) | full_prepayment | advance | ...
 *   - `payment_object` — service (услуга) | commodity (товар) | payment | ...
 *   - `tax`         — none | vat0 | vat10 | vat20 | vat110 | vat120
 *
 * Согласно ст. 4.7 ФЗ-54 для услуг по предоплате полное наименование услуги
 * обязательно (иначе ФНС штрафует). Используем константу-описание из
 * legalConfig + brand, чтобы при ребрендинге не было расхождений.
 */
export interface ReceiptItem {
  name: string;
  quantity: number;
  sum: number; // в рублях, не копейках
  payment_method: "full_payment" | "full_prepayment" | "prepayment" | "advance";
  payment_object: "service" | "commodity" | "payment" | "intellectual_activity";
  tax: "none" | "vat0" | "vat10" | "vat20" | "vat110" | "vat120";
  cost?: number; // опционально — общая стоимость позиции, по умолчанию = sum*quantity
}

export interface RoboReceipt {
  sno?: string | null; // система налогообложения, если у магазина их несколько
  items: ReceiptItem[];
}

/**
 * Строит Receipt-объект для платежа на сумму `sumRubles` рублей.
 *
 * По справке Robokassa «Фискализация»:
 *   «Параметр Receipt передаётся в формате JSON. Значение должно быть
 *    URL-encoded перед использованием в строке для подсчёта подписи и
 *    перед отправкой в форме.»
 *
 * Поэтому helper возвращает СЫРОЙ объект (для JSON.stringify), а
 * url-encoding и подпись делает caller — там же где остальные параметры
 * запроса. См. использование в routes.ts:/api/payment/create.
 */
export function buildReceipt(sumRubles: number, descriptionOverride?: string): RoboReceipt {
  const legal = getLegalConfig();
  const name = (descriptionOverride
    || `Пополнение баланса ${legal.brand} (создание музыкальных произведений ИИ)`
  ).slice(0, 128);
  return {
    // sno передаём ТОЛЬКО если задано в legalConfig — для магазинов с
    // единственной СНО в кабинете поле не нужно (избегаем «Ошибка 32»).
    ...(legal.sno ? { sno: legal.sno } : {}),
    items: [
      {
        name,
        quantity: 1,
        sum: Number(sumRubles.toFixed(2)),
        payment_method: "full_prepayment",
        payment_object: "service",
        tax: legal.defaultTax,
      },
    ],
  };
}

/**
 * Сериализация Receipt в строку для передачи в Robokassa.
 *
 * Двойной шаг:
 *   1. JSON.stringify (получаем «{"items":[...]}»)
 *   2. encodeURIComponent (по требованию Robokassa в справке «Фискализация»)
 *
 * Полученная строка идёт В ПОДПИСЬ (между паролем и Shp_*) И в URL/form.
 * Никаких пробелов внутри (Robokassa строго требует одинаковый текст).
 */
export function receiptToParam(r: RoboReceipt): string {
  // JSON.stringify уже даёт компактную форму без пробелов.
  const json = JSON.stringify(r);
  return encodeURIComponent(json);
}
