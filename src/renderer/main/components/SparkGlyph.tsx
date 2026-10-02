/**
 * Monochrome Bluely mark (speech bubble + sparks) in currentColor, for use on the blue
 * gradient Start button where the full-colour LogoMark would disappear.
 */
export function SparkGlyph({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M32 7c13.25 0 24 10.33 24 23.5S45.25 54 32 54c-3.05 0-5.97-.53-8.68-1.53L13.2 56.6c-1.55.62-3.05-.9-2.38-2.44l3.55-8.12A22.98 22.98 0 0 1 8 30.5C8 17.33 18.75 7 32 7Z"
        fill="currentColor"
        fillOpacity=".2"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinejoin="round"
      />
      <path
        d="M37.5 16.5c.95 5.05 3.45 7.55 8.5 8.5-5.05.95-7.55 3.45-8.5 8.5-.95-5.05-3.45-7.55-8.5-8.5 5.05-.95 7.55-3.45 8.5-8.5Z"
        fill="currentColor"
      />
      <path
        d="M25 31.5c.5 2.65 1.85 4 4.5 4.5-2.65.5-4 1.85-4.5 4.5-.5-2.65-1.85-4-4.5-4.5 2.65-.5 4-1.85 4.5-4.5Z"
        fill="currentColor"
        fillOpacity=".85"
      />
    </svg>
  )
}
