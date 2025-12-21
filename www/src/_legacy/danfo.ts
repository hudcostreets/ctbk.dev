import { isSorted } from "@rdub/base"
import { DataFrame, Series } from "danfojs"

const { fromEntries } = Object

export function pivot(df: DataFrame, index: string, columns: string): DataFrame {
  const rename: {[k:string]:string} = {}
  rename[`${index}_Group`] = index
  return (
    df
      .groupby([index])
      .apply(g => (
        g
          .drop({ columns: [index] })
          .setIndex({ column: columns })
          .transpose()
          .drop({ index: [columns] })
      ))
      .rename(rename)
      .setIndex({ column: index })
      .drop({ columns: [index] })
  )
}

export function rollingAvg(arr: number[], n: number): number[] {
  const [ rv, _ ] = arr.reduce(([rv, sum], v, i) => {
    const dropIdx = i - n
    if (!isNaN(arr[i])) {
      sum += arr[i]
    }
    if (dropIdx >= 0 && !isNaN(arr[dropIdx])) {
      sum -= arr[dropIdx]
      rv.push(sum / n)
    } else {
      rv.push(NaN)
    }
    return [ rv, sum ]
  }, [ [] as number[], 0 ])
  return rv
}

export function print(name: string, d?: DataFrame | Series | null) {
  console.log(`${name}: shape ${d?.shape}, isDF (${d instanceof DataFrame}, ${d?.$isSeries}), cols ${d?.columns}, sorted ${isSorted(d?.index || [])}`)
  if (d?.shape[0]) {
    d?.print()
  }
}

export function rollingAvgs(df: DataFrame, n: number): DataFrame
export function rollingAvgs(df: Series, n: number): Series
export function rollingAvgs(df: DataFrame | Series, n: number): DataFrame | Series {
  //print("danfo.rollingAvgs", df)
  if (!df.$isSeries) { //df instanceof DataFrame) {
    let obj = fromEntries(df.columns.map(k => [k, rollingAvg(df[k].values, n)]))
    return new DataFrame(obj, { index: df.index })
  } else {
    return new Series(rollingAvg(df.values as number[], n), { index: df.index })
  }
}

export type Bounds = { start?: any, end?: any }
export function clampIndex(df: DataFrame, { start, end }: Bounds): DataFrame
export function clampIndex(df: Series, { start, end }: Bounds): Series
export function clampIndex(df: DataFrame | Series, { start, end }: Bounds): DataFrame | Series {
  if (!df.$isSeries) {
    return (df as DataFrame).loc({ rows: df.index.map(v =>
      (start === undefined || start <= v) &&
                (end === undefined || v < end)
    ) })
  } else {
    return df.loc(df.index.map(v =>
      (start === undefined || start <= v) &&
            (end === undefined || v < end)
    ))
  }
}
