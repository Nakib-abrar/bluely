/**
 * Knowledge files for one Mode: drop zone + "Upload files" + live list with parse status.
 * Used by Settings › Modes and onboarding step 3.
 */
import { CircleCheck, CircleX, FileUp, Trash2, Upload } from 'lucide-react'
import { useEffect, useState, type DragEvent } from 'react'
import { KNOWLEDGE_LIMITS } from '@shared/constants'
import { t } from '@shared/i18n'
import type { KnowledgeFile } from '@shared/types'
import { Button, cn, IconButton, Spinner } from '../../components/ui'
import { useIpcEvent } from '../../hooks/useIpcEvent'
import { invoke } from '../../lib/ipc'
import { describeError, isNotImplemented } from '../lib/errors'
import { formatBytes } from '../lib/models'
import { StatusLine } from './bits'

const EXT_TONE: Record<string, string> = {
  pdf: 'bg-danger-soft text-danger',
  docx: 'bg-accent-soft text-accent-text',
  md: 'bg-success-soft text-success',
  txt: 'bg-panel-4 text-muted',
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function FileBadge({ name }: { name: string }) {
  const ext = extensionOf(name)
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[9.5px] font-bold tracking-wide uppercase',
        EXT_TONE[ext] ?? 'bg-panel-4 text-muted',
      )}
    >
      {ext.slice(0, 4) || '?'}
    </span>
  )
}

function FileStatus({ file }: { file: KnowledgeFile }) {
  if (file.status === 'pending' || file.status === 'parsing') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
        <Spinner size={12} />
        {file.status === 'parsing'
          ? t('settings.knowledge.parsing')
          : t('settings.knowledge.pending')}
      </span>
    )
  }
  if (file.status === 'parsed') {
    return (
      <span className="tabular inline-flex items-center gap-1.5 text-[12px] text-muted">
        <CircleCheck size={13} className="text-success" />
        {file.chunkCount === 1
          ? t('settings.knowledge.chunk')
          : t('settings.knowledge.chunks', { n: file.chunkCount })}
      </span>
    )
  }
  return (
    <span
      className="inline-flex max-w-[220px] items-center gap-1.5 text-[12px] text-danger"
      title={file.error ?? undefined}
    >
      <CircleX size={13} className="shrink-0" />
      <span className="truncate">{file.error ?? t('settings.knowledge.failed')}</span>
    </span>
  )
}

function mergeFiles(current: KnowledgeFile[], incoming: KnowledgeFile[]): KnowledgeFile[] {
  const byId = new Map(current.map((f) => [f.id, f]))
  for (const f of incoming) byId.set(f.id, f)
  return [...byId.values()].sort((a, b) => b.addedAt - a.addedAt)
}

/** Render with `key={modeId}` so switching Modes starts from a clean state. */
export function KnowledgeFiles({ modeId, compact }: { modeId: string; compact?: boolean }) {
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    invoke('knowledge:list', { modeId })
      .then((list) => {
        if (!alive) return
        setFiles((cur) => mergeFiles(cur, list))
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setLoaded(true)
        if (!isNotImplemented(err)) setError(describeError(err))
      })
    return () => {
      alive = false
    }
  }, [modeId])

  useIpcEvent('knowledge:changed', (payload) => {
    if (payload.modeId === modeId) setFiles(mergeFiles([], payload.files))
  })

  const add = async (run: () => Promise<KnowledgeFile[]>) => {
    setBusy(true)
    setError(null)
    try {
      const added = await run()
      setFiles((cur) => mergeFiles(cur, added))
    } catch (err) {
      setError(t('settings.knowledge.addFailed', { error: describeError(err) }))
    } finally {
      setBusy(false)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((file) => window.bluely.getPathForFile(file))
      .filter((p) => p.length > 0)
      .slice(0, KNOWLEDGE_LIMITS.maxFilesPerMode)
    if (paths.length) void add(() => invoke('knowledge:addPaths', { modeId, paths }))
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dragging) setDragging(true)
  }

  const remove = async (file: KnowledgeFile) => {
    setFiles((cur) => cur.filter((f) => f.id !== file.id))
    try {
      await invoke('knowledge:delete', { fileId: file.id })
    } catch (err) {
      setFiles((cur) => mergeFiles(cur, [file]))
      setError(describeError(err))
    }
  }

  return (
    <div>
      <div
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={onDrop}
        data-testid="knowledge-dropzone"
        className={cn(
          'flex items-center gap-3 rounded-xl border border-dashed px-4 transition-colors duration-150',
          compact ? 'py-3' : 'py-4',
          dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-panel-2/60',
        )}
      >
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
            dragging ? 'bg-accent text-white' : 'bg-panel-3 text-muted',
          )}
        >
          <FileUp size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">
            {dragging ? t('settings.knowledge.dropActive') : t('settings.knowledge.drop')}
          </div>
          <div className="mt-0.5 text-[12px] text-subtle">{t('settings.knowledge.limits')}</div>
        </div>
        <Button
          size="sm"
          icon={<Upload size={13} />}
          loading={busy}
          onClick={() => void add(() => invoke('knowledge:pickAndAdd', { modeId }))}
        >
          {t('settings.knowledge.upload')}
        </Button>
      </div>

      {error ? (
        <StatusLine tone="error" className="mt-2">
          {error}
        </StatusLine>
      ) : null}

      {files.length > 0 ? (
        <ul
          className="mt-2.5 divide-y divide-line rounded-xl border border-line"
          data-testid="knowledge-list"
        >
          {files.map((file) => (
            <li key={file.id} className="flex items-center gap-3 px-3 py-2">
              <FileBadge name={file.filename} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-fg" title={file.filename}>
                  {file.filename}
                </div>
                <div className="tabular text-[11.5px] text-subtle">{formatBytes(file.size)}</div>
              </div>
              <FileStatus file={file} />
              <IconButton
                size="sm"
                label={t('settings.knowledge.deleteFile', { name: file.filename })}
                icon={<Trash2 size={14} />}
                onClick={() => void remove(file)}
                className="hover:text-danger"
              />
            </li>
          ))}
        </ul>
      ) : loaded && !compact ? (
        <p className="mt-2.5 px-1 text-[12.5px] text-subtle">{t('settings.knowledge.empty')}</p>
      ) : null}
    </div>
  )
}
