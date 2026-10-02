import type { TextPart } from '../lib/snippet'

/** Renders highlighted text runs as React nodes (never as HTML). */
export function HighlightedText({ parts }: { parts: TextPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.mark ? (
          <mark key={i} className="text-fg">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}
