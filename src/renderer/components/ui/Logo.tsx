import { cn } from './cn'

/** Bluely mark: a rounded blue speech bubble with a spark. Original artwork (see src/renderer/assets/logo.svg). */
export function LogoMark({
  size = 24,
  className,
  title = 'Bluely',
}: {
  size?: number
  className?: string
  title?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-label={title}
      className={className}
    >
      <defs>
        <linearGradient
          id="bluely-mark-g"
          x1="12"
          y1="6"
          x2="52"
          y2="60"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#60A5FA" />
          <stop offset="1" stopColor="#2563EB" />
        </linearGradient>
      </defs>
      <path
        d="M32 5c14.36 0 26 11.2 26 25.5S46.36 56 32 56c-3.3 0-6.47-.58-9.4-1.66L11.6 58.8c-1.68.68-3.3-.98-2.58-2.64l3.84-8.8A24.9 24.9 0 0 1 6 30.5C6 16.2 17.64 5 32 5Z"
        fill="url(#bluely-mark-g)"
      />
      <path
        d="M37.5 15.5c.95 5.05 3.45 7.55 8.5 8.5-5.05.95-7.55 3.45-8.5 8.5-.95-5.05-3.45-7.55-8.5-8.5 5.05-.95 7.55-3.45 8.5-8.5Z"
        fill="#fff"
      />
      <path
        d="M24.5 31c.5 2.65 1.85 4 4.5 4.5-2.65.5-4 1.85-4.5 4.5-.5-2.65-1.85-4-4.5-4.5 2.65-.5 4-1.85 4.5-4.5Z"
        fill="#fff"
        fillOpacity=".85"
      />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('font-semibold tracking-[-0.02em] text-fg', className)}>Bluely</span>
}

export function Logo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark size={size} />
      <Wordmark className="text-[17px]" />
    </span>
  )
}
