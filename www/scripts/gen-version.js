#!/usr/bin/env node
/**
 * Write `dist/version.json` ({sha}) at postbuild — the deployed site
 * self-reports what it's serving. `www.yml` reads the LIVE site's copy
 * just before deploying to compute the "commits since last deploy"
 * range for the Slack notify (deterministic, unlike GH API runs-list
 * archaeology, whose eventual-consistency picked an Aug-7 run as
 * "previous deploy" on 2026-08-15), and the post-deploy smoke check
 * asserts the fresh copy matches the deployed sha.
 */

import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Tolerate no-git contexts (the screenshot Docker build has no `.git`
// and no GITHUB_SHA; its dist/ is only rendered, never deployed).
let sha = process.env.GITHUB_SHA ?? null
if (!sha) {
  try {
    sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    sha = null
  }
}
const dest = join(__dirname, '..', 'dist', 'version.json')
writeFileSync(dest, JSON.stringify({ sha }) + '\n')
console.error(`version.json: ${sha}`)
