import fs from "fs"
import { basename, dirname } from "path"
import { fromEntries, solo } from "@rdub/base"
import { glob } from "glob"
import YAML from "yaml"

export type DvcSpec = { outs: { md5: string }[] }

export function loadMd5(dvcPath: string): string {
  const file = fs.readFileSync(dvcPath, 'utf8')
  const dvcSpec = YAML.parse(file) as DvcSpec
  const { md5 } = solo(dvcSpec.outs)
  return md5
}

export function dvcUrl(md5: string): string {
  return `https://ctbk.s3.amazonaws.com/.dvc/files/md5/${md5.substring(0, 2)}/${md5.substring(2)}`
}

export async function loadDvcUrlsMap(pattern: string): Promise<Record<string, string>> {
  const dvcPaths = await glob(pattern)
  return fromEntries(
    dvcPaths.map(dvcPath => [
      basename(dirname(dvcPath)),
      dvcUrl(loadMd5(dvcPath)),
    ])
  )
}
