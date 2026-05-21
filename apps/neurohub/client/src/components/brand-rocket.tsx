// Eugene 2026-05-21 Босс «ракету сделай классическую emoji» — 🚀 вместо SVG.
// Sizing через fontSize, drop-shadow violet+fuchsia glow для brand-feel.
//
// Старый кастомный SVG Trophy-rocket убран — emoji проще + универсальнее.

interface BrandRocketProps {
  size?: number;
  className?: string;
}

export function BrandRocket({ size = 48, className = "" }: BrandRocketProps) {
  return (
    <span
      className={className}
      style={{
        display: "inline-block",
        fontSize: `${size}px`,
        lineHeight: 1,
        filter: "drop-shadow(0 0 8px rgba(217,70,239,0.55)) drop-shadow(0 0 16px rgba(124,58,237,0.4))",
      }}
      aria-hidden="true"
    >
      🚀
    </span>
  );
}
