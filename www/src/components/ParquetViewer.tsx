/** Parquet viewer for `/files/*` — plugged into `<FileTree parquetRenderer={ParquetViewer}>`
 *  so `.parquet`/`.pqt` paths render as a paginated table.
 *
 *  Uses `hyparquet` for footer/metadata + row-range reads, fed via
 *  `asyncBufferFromStore` so it works against any `Store` (R2 here, but the
 *  same component works for HTTP/S3/local). Adapted from the file-tree
 *  reference impl (`site/src/ParquetViewer.tsx`). */
import { useEffect, useState } from 'react'
import { parquetMetadataAsync, parquetRead, parquetSchema } from 'hyparquet'
import { asyncBufferFromStore, fmtSize } from '@rdub/file-tree/react'
import type { Store } from '@rdub/file-tree'

const ROWS_PER_PAGE = 200

interface SchemaCol { name: string; type?: string }

export function ParquetViewer({ store, path }: { store: Store; path: string }) {
  const [schema, setSchema] = useState<SchemaCol[] | null>(null)
  const [totalRows, setTotalRows] = useState<number | null>(null)
  const [byteSize, setByteSize] = useState<number | null>(null)
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSchema(null); setTotalRows(null); setByteSize(null); setPage(0); setRows(null); setError(null)
    ;(async () => {
      try {
        const file = await asyncBufferFromStore(store, path)
        const meta = await parquetMetadataAsync(file)
        if (cancelled) return
        const sch: SchemaCol[] = parquetSchema(meta).children.map((c: { element: { name: string; type?: unknown } }) => ({
          name: c.element.name,
          ...(c.element.type ? { type: String(c.element.type) } : {}),
        }))
        setSchema(sch)
        setTotalRows(Number(meta.num_rows))
        setByteSize(file.byteLength)
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    })()
    return () => { cancelled = true }
  }, [store, path])

  useEffect(() => {
    if (totalRows === null) return
    let cancelled = false
    const rowStart = page * ROWS_PER_PAGE
    const rowEnd = Math.min(totalRows, rowStart + ROWS_PER_PAGE)
    ;(async () => {
      try {
        const file = await asyncBufferFromStore(store, path)
        const out: Record<string, unknown>[] = []
        await parquetRead({
          file,
          rowStart, rowEnd,
          rowFormat: 'object',
          onComplete: (data: unknown) => {
            if (Array.isArray(data)) for (const r of data) out.push(r as Record<string, unknown>)
          },
        })
        if (!cancelled) setRows(out)
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    })()
    return () => { cancelled = true }
  }, [store, path, page, totalRows])

  if (error) return <div style={{ color: 'salmon' }}>error: {error}</div>
  if (!schema || totalRows === null) return <div style={{ opacity: 0.6 }}>reading parquet metadata…</div>

  const pages = Math.max(1, Math.ceil(totalRows / ROWS_PER_PAGE))
  const rowStart = page * ROWS_PER_PAGE
  const rowEnd = Math.min(totalRows, rowStart + ROWS_PER_PAGE)

  return (
    <>
      <p style={{ opacity: 0.7, fontSize: '0.95em' }}>
        <b>{totalRows.toLocaleString()}</b> rows · <b>{schema.length}</b> columns
        {byteSize ? <> · {fmtSize(byteSize)}</> : null}
      </p>

      <details style={{ marginBottom: '0.5em' }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.9em', opacity: 0.8 }}>schema</summary>
        <table style={{ borderCollapse: 'collapse', marginTop: '0.3em', fontSize: '0.85em' }}>
          <tbody>
            {schema.map(c => (
              <tr key={c.name}>
                <td style={{ padding: '0.1em 0.6em 0.1em 0', fontFamily: 'ui-monospace, monospace' }}>{c.name}</td>
                <td style={{ padding: '0.1em 0', opacity: 0.7 }}>{c.type ?? '?'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <Pager page={page} pages={pages} setPage={setPage} rowStart={rowStart} rowEnd={rowEnd} totalRows={totalRows} />

      <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto', border: '1px solid rgba(127,127,127,0.3)', borderRadius: 4 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.82em', fontFamily: 'ui-monospace, monospace' }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: 'rgba(127,127,127,0.15)' }}>
              {schema.map(c => (
                <th key={c.name} style={{ padding: '0.3em 0.6em', textAlign: 'left', borderBottom: '1px solid rgba(127,127,127,0.4)', fontWeight: 500 }}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr><td colSpan={schema.length} style={{ padding: '0.5em', opacity: 0.6 }}>loading rows…</td></tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid rgba(127,127,127,0.15)' }}>
                  {schema.map(c => (
                    <td key={c.name} style={{ padding: '0.2em 0.6em', whiteSpace: 'nowrap', maxWidth: '30em', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {fmtCell(r[c.name])}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Pager({ page, pages, setPage, rowStart, rowEnd, totalRows }: {
  page: number
  pages: number
  setPage: (p: number) => void
  rowStart: number
  rowEnd: number
  totalRows: number
}) {
  if (pages <= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em', margin: '0.4em 0', fontSize: '0.9em' }}>
      <button disabled={page === 0} onClick={() => setPage(0)}>«</button>
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
      <span style={{ opacity: 0.8 }}>
        page <b>{page + 1}</b> / {pages} · rows {rowStart.toLocaleString()}–{rowEnd.toLocaleString()} / {totalRows.toLocaleString()}
      </span>
      <button disabled={page === pages - 1} onClick={() => setPage(page + 1)}>›</button>
      <button disabled={page === pages - 1} onClick={() => setPage(pages - 1)}>»</button>
    </div>
  )
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
