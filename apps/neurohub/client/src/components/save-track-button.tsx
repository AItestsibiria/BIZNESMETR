// Eugene 2026-05-30 — кнопка «Сохранить» с tooltip-вариантами под платформу.
//
// Поведение:
//   • Capacitor app / PWA standalone → сохраняем в offline (Filesystem или
//     IndexedDB через lib/offlineStorage). Иконка меняется на ✓ при saved,
//     повторный клик предлагает удалить.
//   • Обычный браузер → классический `<a download>` (тот же flow что был).
//
// Tooltip (hover на desktop, long-press на mobile через Radix Tooltip):
//   • can-save + not-saved: «Сохранить в приложении (offline)»
//   • can-save + saved:    «✓ Сохранено · нажмите ещё раз для удаления»
//   • browser:             «Скачать через обзор файлов»
//
// Long-press на mobile (touch-only) — Radix Tooltip умеет показывать
// контент на focus / touch-start. Дополнительно вешаем onContextMenu prevent
// чтобы long-press не вызывал системное меню.
//
// Layout-fit-no-overlap rule: tooltip позиционируется через Radix `side`
// (по умолчанию top), collision-detection встроен — за край viewport не
// уходит. Применяется brand-стиль через popover-токены.

import React, { useEffect, useState } from "react";
import { Download, CheckCheck, Loader2, Trash2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { canSaveToDevice, getSaveTarget } from "@/lib/platform";
import {
  saveTrackOffline,
  deleteOfflineTrack,
  isOfflineCached,
  markOfflineCached,
  unmarkOfflineCached,
  primeOfflineCache,
  subscribeOfflineCache,
} from "@/lib/offlineStorage";

export interface SaveTrackButtonProps {
  trackId: number;
  audioUrl?: string | null; // если null — кнопка disabled
  displayTitle?: string;
  authorName?: string;
  imageUrl?: string;
  duration?: number;
  /** Доп. класс на саму кнопку (для подгонки в существующий ряд actions). */
  className?: string;
  /** Размер иконки (по умолчанию w-3.5 h-3.5). */
  iconClassName?: string;
  /** data-testid для e2e */
  testId?: string;
}

type State = "idle" | "saving" | "saved" | "error";

export function SaveTrackButton(props: SaveTrackButtonProps) {
  const {
    trackId,
    audioUrl,
    displayTitle,
    authorName,
    imageUrl,
    duration,
    className = "",
    iconClassName = "w-3.5 h-3.5",
    testId,
  } = props;

  const canOffline = canSaveToDevice();
  const target = getSaveTarget();

  const [state, setState] = useState<State>("idle");
  const [cached, setCached] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>("");

  // primeCache при первом mount + подписка на изменения (повлияет на все кнопки сразу)
  useEffect(() => {
    let cancelled = false;
    primeOfflineCache().then(() => {
      if (!cancelled) setCached(isOfflineCached(trackId));
    });
    const unsub = subscribeOfflineCache(() => {
      if (!cancelled) setCached(isOfflineCached(trackId));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [trackId]);

  // Browser fallback (не Capacitor / не PWA) — обычный download через <a>
  const triggerBrowserDownload = () => {
    if (!audioUrl) return;
    const a = document.createElement("a");
    a.href = audioUrl;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!audioUrl) return;

    // Browser fallback — никакого offline-хранилища
    if (!canOffline) {
      triggerBrowserDownload();
      return;
    }

    // Уже сохранён → удаляем
    if (cached) {
      setState("saving");
      try {
        await deleteOfflineTrack(trackId);
        unmarkOfflineCached(trackId);
        setCached(false);
        setState("idle");
      } catch (err: any) {
        setErrorMsg(err?.message || "Не удалось удалить");
        setState("error");
        setTimeout(() => setState("idle"), 2500);
      }
      return;
    }

    // Сохраняем
    setState("saving");
    setErrorMsg("");
    const result = await saveTrackOffline({
      id: trackId,
      audioUrl,
      displayTitle: displayTitle || `Трек ${trackId}`,
      authorName,
      imageUrl,
      duration,
    });
    if (result.ok) {
      markOfflineCached(trackId);
      setCached(true);
      setState("saved");
      setTimeout(() => setState("idle"), 1600);
    } else {
      setErrorMsg(result.error || "Не удалось сохранить");
      setState("error");
      // На крайний случай предложим обычный download как fallback
      setTimeout(() => setState("idle"), 2500);
    }
  };

  const Icon =
    state === "saving"
      ? Loader2
      : state === "saved" || (cached && canOffline)
      ? CheckCheck
      : Download;

  // Tooltip-текст под платформу
  const tooltipText = (() => {
    if (state === "error") return errorMsg || "Не удалось — попробуйте ещё раз";
    if (state === "saving") return "Сохраняю…";
    if (!canOffline) {
      return "Скачать через обзор файлов";
    }
    if (cached) {
      return "✓ Сохранено в приложении · нажмите для удаления";
    }
    if (target === "filesystem") {
      return "Сохранить в приложении (доступ offline)";
    }
    return "Сохранить в приложении (offline через браузер)";
  })();

  const colorClass =
    state === "error"
      ? "text-red-400"
      : cached && canOffline
      ? "text-emerald-300"
      : "text-muted-foreground";

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={`rounded-md flex items-center justify-center hover:bg-white/10 transition-colors ${className}`}
            onClick={handleClick}
            onContextMenu={(e) => {
              // Long-press на мобильных вызывает системное меню — гасим,
              // чтобы Radix Tooltip остался единственным источником подсказки.
              if (canOffline) e.preventDefault();
            }}
            disabled={!audioUrl || state === "saving"}
            data-testid={testId || `save-track-${trackId}`}
            aria-label={tooltipText}
            title={tooltipText /* нативная подсказка для устройств без Radix-hover */}
          >
            {state === "saving" ? (
              <Loader2 className={`${iconClassName} ${colorClass} animate-spin`} />
            ) : cached && canOffline ? (
              // Saved-состояние — показываем галочку с дополнительной иконкой удаления при hover
              <span className="relative inline-flex">
                <CheckCheck className={`${iconClassName} ${colorClass}`} />
              </span>
            ) : (
              <Icon className={`${iconClassName} ${colorClass}`} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={6}
          className="max-w-[240px] text-xs leading-tight border-purple-500/30 bg-[#1a0f2e]/95 text-white/90 backdrop-blur-sm"
        >
          {tooltipText}
          {cached && canOffline && (
            <span className="block text-[10px] text-emerald-300/80 mt-0.5">
              <Trash2 className="inline w-2.5 h-2.5 mr-0.5" />
              Файл удалится с устройства
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default SaveTrackButton;
