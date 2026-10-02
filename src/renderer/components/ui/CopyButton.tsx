import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { invoke } from '../../lib/ipc'
import { IconButton } from './IconButton'

export function CopyButton({
  text,
  label,
  size = 'sm',
  className,
}: {
  text: string
  label?: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <IconButton
      size={size}
      className={className}
      label={copied ? t('common.copied') : (label ?? t('common.copy'))}
      icon={copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      onClick={() => {
        void invoke('clipboard:writeText', { text }).then(() => setCopied(true))
      }}
    />
  )
}
