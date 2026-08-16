/** `/files/*` — `<FileTree>` from `@rdub/file-tree`.
 *
 *  PoC for the GBFS health page. Browses the production R2 bucket
 *  (`gbfs/`, `avail/` prefixes via the `R2Store` allow-list on the
 *  worker side). */
import { useMemo } from 'react'
import { FileTree } from '@rdub/file-tree/react'
import { HttpStore } from '@rdub/file-tree/stores/http'
import { makeParquetViewer } from '@rdub/file-tree/renderers/parquet'
import { renderCell } from '../components/parquetCells'

// Module scope, not inside render: a new component identity each render
// would remount the viewer (and drop its row-group cache) on every
// state change.
const ParquetViewer = makeParquetViewer({ renderCell })

// Default to prod worker so `pnpm dev` works without a local api.
// Override at build/dev time with `VITE_API_BASE=http://localhost:51896 pnpm dev`.
const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'

export default function Files() {
  // `presign: true` → download icon resolves via `/api/files/presign`,
  // so the browser streams bytes directly from R2 (no worker proxy).
  const store = useMemo(() => HttpStore(`${API_BASE}/api/files`, { presign: true }), [])
  return (
    <div style={{
      maxWidth: 1200,
      margin: '0 auto',
      padding: '1em 1.5em',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <FileTree
        store={store}
        routeBase="/files"
        title="Files (PoC: @rdub/file-tree)"
        parquetRenderer={ParquetViewer}
      />
    </div>
  )
}
