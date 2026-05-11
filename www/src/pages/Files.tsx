/** `/files/*` — `<FileTree>` from `@rdub/file-tree`.
 *
 *  PoC for the GBFS health page. Browses the production R2 bucket
 *  (`gbfs/`, `avail/` prefixes via the `R2Store` allow-list on the
 *  worker side). */
import { useMemo } from 'react'
import { FileTree } from '@rdub/file-tree/react'
import { HttpStore } from '@rdub/file-tree/stores/http'

const API_BASE = import.meta.env.DEV
  ? 'http://localhost:51896'
  : 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'

export default function Files() {
  const store = useMemo(() => HttpStore(`${API_BASE}/api/files`), [])
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
      />
    </div>
  )
}
