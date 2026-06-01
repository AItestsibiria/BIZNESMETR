// Босс 2026-05-30 (Brand-name-uniform rule, fe45dfd):
// Единый компонент для отображения «MuzaAi» в JSX с брендовым градиентом.
// НЕ для title/alt/JSON/URL/console/email — там plain text.
//
// CLAUDE.md:
// - Brand-name-uniform rule — единый <BrandName /> везде в JSX
// - Brand-style consistency rule — font-display + brand gradient (purple→fuchsia→cyan)
// - Reuse-working-solutions rule — один источник правды для бренд-имени
// - No-duplicates rule — не дублировать inline стили
import type { CSSProperties } from "react";

export function BrandName({
  className = "",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`font-display font-bold bg-gradient-to-r from-purple-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent ${className}`}
      style={style}
    >
      MuzaAi
    </span>
  );
}

export default BrandName;
