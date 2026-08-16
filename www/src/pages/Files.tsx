/** `/files/*` — `<FileTree>` from `@rdub/file-tree`.
 *
 *  PoC for the GBFS health page. Browses the production R2 bucket
 *  (`gbfs/`, `avail/` prefixes via the `R2Store` allow-list on the
 *  worker side). */
import { useCallback, useMemo } from 'react'
import { FileTree } from '@rdub/file-tree/react'
import { HttpStore } from '@rdub/file-tree/stores/http'
import { makeParquetViewer } from '@rdub/file-tree/renderers/parquet'
import { useUrlState } from 'use-prms'
import type { Param } from 'use-prms'
import { cellProps, headerProps, RawColsProvider, renderCell, renderHeader } from '../components/parquetCells'

// Module scope, not inside render: a new component identity each render
// would remount the viewer (and drop its row-group cache) on every
// state change. Per-render state reaches the renderers through
// `RawColsProvider` instead of through this options bag.
const ParquetViewer = makeParquetViewer({ renderCell, renderHeader, cellProps, headerProps })

/** `?raw=`: columns pinned to their literal values, comma-joined. Worth
 *  putting in the URL rather than component state — "here's the file,
 *  with `dt` unformatted" is exactly the kind of thing you paste to
 *  someone. */
const rawColsParam: Param<Set<string>> = {
  encode: (v) => (v.size ? [...v].sort().join(',') : undefined),
  decode: (s) => new Set(s ? s.split(',').filter(Boolean) : []),
}

// Default to prod worker so `pnpm dev` works without a local api.
// Override at build/dev time with `VITE_API_BASE=http://localhost:51896 pnpm dev`.
const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'

export default function Files() {
  // `presign: true` → download icon resolves via `/api/files/presign`,
  // so the browser streams bytes directly from R2 (no worker proxy).
  const store = useMemo(() => HttpStore(`${API_BASE}/api/files`, { presign: true }), [])
  const [rawCols, setRawCols] = useUrlState('raw', rawColsParam)
  const toggle = useCallback((col: string) => {
    const next = new Set(rawCols)
    if (!next.delete(col)) next.add(col)
    setRawCols(next)
  }, [rawCols, setRawCols])
  const rawColsValue = useMemo(() => ({ raw: rawCols, toggle }), [rawCols, toggle])
  return (
    <div style={{
      maxWidth: 1200,
      margin: '0 auto',
      padding: '1em 1.5em',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <RawColsProvider value={rawColsValue}>
        <FileTree
          store={store}
          routeBase="/files"
          title="Files (PoC: @rdub/file-tree)"
          parquetRenderer={ParquetViewer}
        />
      </RawColsProvider>
    </div>
  )
}
