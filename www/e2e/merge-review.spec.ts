import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

/**
 * `/merge-review` (rides-rekey P5): the clusters view (search, flag filter,
 * a cluster's detail) and the decisions view (a reviewed decision, an id
 * repair). Expectations derive from the committed asset, so a regen of
 * `station-merges.json` doesn't break them; `/api/rides/cells` is mocked
 * (one row per requested cell per month) so the series checks are
 * deterministic and offline.
 */

interface Asset {
  clusters: Record<string, { members: { id: string, spans: [string, string, string | null][] }[] }>
  decisions: { key: string, ids: string[], verdict: string, rationale: string }[]
  repairs: { n: string, n0: string, names: Record<string, string[]> }[]
}
const asset: Asset = JSON.parse(readFileSync(new URL('../public/assets/station-merges.json', import.meta.url), 'utf8'))
const nMembers = (canon: string) => asset.clusters[canon]?.members.length ?? 0

const MONTHS = [Date.UTC(2019, 0, 1), Date.UTC(2019, 1, 1), Date.UTC(2019, 2, 1)]

/** Mock rides: each `s:` leaf carries 100 rides/month; a `c:<canon>` row
 *  carries 100 × its member count, i.e. exactly Σ members. */
async function mockRides(page: Page) {
  await page.route('**/api/rides/cells?**', async (route) => {
    const cells = new URL(route.request().url()).searchParams.get('cells')!.split(',')
    const records = cells.flatMap((cell) => MONTHS.map((dt) => ({
      cell, dt, gender: 'unknown', user_type: 'Subscriber', bike_type: 'classic_bike',
      count: cell.startsWith('c:') ? 100 * nMembers(cell.slice(2)) : 100, duration: 0,
    })))
    await route.fulfill({ json: { records, reducer: 'sum', anchor: 'start', plan: null } })
  })
}

const listCount = (page: Page) => page.locator('[class*=listCount]')
const detailTitle = (page: Page) => page.locator('main h2')

test.beforeEach(async ({ page }) => { await mockRides(page) })

test('loads the clusters view', async ({ page }) => {
  const n = Object.keys(asset.clusters).length
  await page.goto('/merge-review')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Station merge review')
  await expect(listCount(page)).toHaveText(`${n.toLocaleString('en-US')} of ${n.toLocaleString('en-US')} · ranked by flags`)
  await expect(detailTitle(page)).toBeVisible()
})

test('search and flag filter narrow the list, in the URL', async ({ page }) => {
  const n = Object.keys(asset.clusters).length
  const q = 'pillar'
  const matching = Object.entries(asset.clusters).filter(([canon, c]) =>
    canon.toLowerCase().includes(q) || c.members.some((m) => m.id.toLowerCase().includes(q) || m.spans.some(([name]) => name.toLowerCase().includes(q))),
  ).length
  await page.goto('/merge-review')
  await page.locator('#merge-review-search').fill(q)
  await expect(listCount(page)).toHaveText(`${matching} of ${n.toLocaleString('en-US')} · ranked by flags`)
  await expect(page).toHaveURL(/[?&]q=pillar\b/)

  await page.getByRole('button', { name: 'borderline', exact: true }).click()
  await expect(page).toHaveURL(/[?&]f=borderline\b/)
  const filtered = Number((await listCount(page).textContent())!.split(' of ')[0])
  expect(filtered).toBeLessThan(matching)
})

test('a cluster: members, eras, and c: = Σ members', async ({ page }) => {
  const canon = '4452.01'
  const ids = asset.clusters[canon].members.map((m) => `s:${m.id}`)
  await page.goto(`/merge-review?c=${canon}`)
  await expect(page.locator('main table code')).toHaveText(ids)
  const summary = page.locator('[class*=seriesSummary]')
  await expect(summary).toContainText('c: = Σ members ✓')  // secondary to the exact id list above
  await page.getByRole('radio', { name: 'Ends' }).click()
  await expect(page).toHaveURL(/[?&]a=end\b/)
  await expect(page.locator('main h3').filter({ hasText: 'Monthly' })).toHaveText('Monthly ends')
})

test('a reviewed split decision shows both ids with their own series', async ({ page }) => {
  const d = asset.decisions.find((x) => x.verdict === 'split' && x.ids.includes('233'))!
  await page.goto(`/merge-review?v=decisions&d=${encodeURIComponent(d.key)}`)
  await expect(page.getByRole('tab', { name: 'Decisions' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('main [class*=detailSub] [class*=chip]')).toHaveText('split')
  await expect(page.locator('main [class*=rationale]')).toHaveText(d.rationale)
  await expect(page.locator('main table code[style]')).toHaveText(d.ids.map((i) => `s:${i}`))
  // Split ids aren't one cluster: no `c:` row, so no Σ check.
  await expect(page.locator('[class*=seriesSummary]')).not.toContainText('c:')
})

test('an id repair shows before/after attribution', async ({ page }) => {
  const r = asset.repairs.find((x) => x.n === '364')!
  await page.goto(`/merge-review?v=decisions&d=${r.n}%2B${r.n0}`)
  await expect(detailTitle(page)).toHaveText(`s:${r.n} folded into s:${r.n0}`)
  const cells = page.locator('main table tbody tr td:nth-child(-n+2)')
  await expect(cells).toHaveText([`s:${r.n}`, r.names[r.n].join(' · '), `s:${r.n0}`, r.names[r.n0].join(' · ')])
})
