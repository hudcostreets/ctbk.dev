// Data types for Citi Bike dashboard
// Re-export codeParam and codesParam from UUP for use in Home.tsx
export { codeParam, codesParam } from "use-prms"

export type Region = 'NYC' | 'JC' | 'HOB'
export const Regions: Region[] = ['JC', 'HOB', 'NYC']
export const RegionQueryStrings: [Region, string][] = [['HOB', 'h'], ['NYC', 'n'], ['JC', 'j']]

export type UserType = 'Annual' | 'Daily'
export const UserTypes: UserType[] = ['Annual', 'Daily']
export const UserTypeQueryStrings: [UserType, string][] = [['Annual', 'a'], ['Daily', 'd']]
// Display names: internal 'Annual'/'Daily' map to 'Member'/'Customer' for clarity
export const UserTypeDisplayNames: { [u in UserType]: string } = { 'Annual': 'Member', 'Daily': 'Customer' }

export type Gender = 'Men' | 'Women' | 'Unknown'
export const Genders: Gender[] = ['Men', 'Women', 'Unknown']
export const GenderQueryStrings: [Gender, string][] = [['Men', 'm'], ['Women', 'f'], ['Unknown', 'u']]
export const Int2Gender: { [k: number]: Gender } = { 0: 'Unknown', 1: 'Men', 2: 'Women' }
// Gender data became 100% "Unknown" from February 2021; don't bother with per-entry
// rolling averages from that point onward
export const GenderRollingAvgCutoff = '2021-02'

export type RideableType = 'Classic' | 'Electric' | 'Unknown'
export const RideableTypes: RideableType[] = ['Classic', 'Electric', 'Unknown']
export const RideableTypeChars: [RideableType, string][] = [['Classic', 'c'], ['Electric', 'e'], ['Unknown', 'u']]
export const NormalizeRideableType: { [k: string]: RideableType } = {
  'docked_bike': 'Classic',
  'classic_bike': 'Classic',
  'electric_bike': 'Electric',
  'unknown': 'Unknown',
  'motivate_dockless_bike': 'Unknown',
}
export const UnknownRideableCutoff = '2021-02'

export type StackBy = 'None' | 'Region' | 'User Type' | 'Gender' | 'Rideable Type' | 'Docking'
export const StackBys: StackBy[] = ['None', 'Region', 'User Type', 'Gender', 'Rideable Type', 'Docking']
export const StackByQueryStrings: [StackBy, string][] = [
  ['None', 'n'],
  ['Region', 'r'],
  ['Gender', 'g'],
  ['User Type', 'u'],
  ['Rideable Type', 'b'],
  ['Docking', 'd'],
]

export type Docking = 'start' | 'end'
export const Dockings: Docking[] = ['start', 'end']
export const DockingColors: { [d in Docking]: string } = { 'start': '#1976d2', 'end': '#ef6c00' }

/** Filter choice for station trips: which docking side(s) to include. */
export type DockingFilter = Docking | 'both'

export type YAxis = 'Rides' | 'Ride minutes'
export const YAxes: YAxis[] = ['Rides', 'Ride minutes']
export const YAxisQueryStrings: [YAxis, string][] = [['Rides', 'r'], ['Ride minutes', 'm']]

export const yAxisLabelDict: { [k in YAxis]: { yAxis: string; title: string; hoverLabel: string } } = {
  'Rides': { yAxis: 'Total Rides', title: 'Citi Bike Rides per Month', hoverLabel: 'Rides' },
  'Ride minutes': { yAxis: 'Total Ride Minutes', title: 'Citi Bike Ride Minutes per Month', hoverLabel: 'Minutes' },
}

export type Row = {
  Year: number
  Month: number
  Count: number
  Duration: number
  Region: Region
  'User Type': UserType
  Gender: number
  'Rideable Type': string
  Docking?: Docking  // optional: present only in per-station files
}

export const DEFAULT_COLORS = ['#636EFA', '#EF553B', '#00CC96', '#AB63FA', '#FFA15A', '#19D3F3', '#FF6692', '#B6E880', '#FF97FF', '#FECB52']

export const RegionColors: { [r in Region]: string } = { 'NYC': '#636efa', 'HOB': '#63aefa', 'JC': '#632bfa' }
export const UserTypeColors: { [u in UserType]: string } = { 'Daily': '#FF6692', 'Annual': '#FF97ff' }
export const GenderColors: { [g in Gender]: string } = { 'Unknown': '#AB63FA', 'Men': '#19D3F3', 'Women': '#FFA15A' }
export const RideableTypeColors: { [r in RideableType]: string } = { 'Unknown': '#636EFA', 'Electric': '#AB63FA', 'Classic': '#00CC96' }

export const Colors: { [k in StackBy]: { [key: string]: string } } = {
  None: { '': DEFAULT_COLORS[0], Total: 'black' },
  Region: RegionColors,
  Gender: GenderColors,
  'User Type': UserTypeColors,
  'Rideable Type': RideableTypeColors,
  Docking: DockingColors,
}

export const stackKeyDict: { [k in StackBy]: string[] } = {
  'None': [''],
  'User Type': ['Daily', 'Annual'],
  'Gender': ['Unknown', 'Women', 'Men'],
  'Rideable Type': ['Electric', 'Classic', 'Unknown'],
  'Region': ['JC', 'HOB', 'NYC'],
  'Docking': ['end', 'start'],
}

export const toYM = (d: Date) => `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`

// Rolling average calculation for arrays
export function rollingAvg(arr: (number | null)[], n: number): (number | null)[] {
  const result: (number | null)[] = []
  let sum = 0
  let validCount = 0

  for (let i = 0; i < arr.length; i++) {
    const val = arr[i]
    if (val !== null && !isNaN(val)) {
      sum += val
      validCount++
    }

    const dropIdx = i - n
    if (dropIdx >= 0) {
      const dropVal = arr[dropIdx]
      if (dropVal !== null && !isNaN(dropVal)) {
        sum -= dropVal
        validCount--
      }
      result.push(validCount === n ? sum / n : null)
    } else {
      result.push(null)
    }
  }
  return result
}

// Annualized percent calculation types
export type MonthVal = { m: string; v: number }
export type AnnualizedPercent = {
  numYrs: number
  numMos: number
  first: MonthVal
  last: MonthVal
  ratio: number
  percent: number
}

export function annualizedPercents(
  months: string[],
  values: (number | null)[]
): AnnualizedPercent[] {
  // Filter to non-null values
  const filtered: { m: string; v: number }[] = []
  for (let i = 0; i < months.length; i++) {
    const v = values[i]
    if (v !== null && !isNaN(v)) {
      filtered.push({ m: months[i], v })
    }
  }

  if (filtered.length === 0) return []

  const maxRange = filtered.length - 1
  let delta = 12
  const percents: AnnualizedPercent[] = []

  while (true) {
    if (delta > maxRange) delta = maxRange
    const first = filtered[maxRange - delta]
    const last = filtered[maxRange]
    const ratio = last.v / first.v
    const numYrs = delta / 12
    const rate = Math.pow(ratio, 1 / numYrs) - 1
    const percent = rate * 100
    percents.push({ numYrs, numMos: delta, first, last, ratio, percent })
    if (delta === maxRange) break
    delta += 12
  }
  return percents
}

export function annualPercentStr({ numYrs, numMos, first, last, ratio, percent }: AnnualizedPercent): string {
  function ymStr(m: string): string {
    return `${parseInt(m.substring(5))}/${m.substring(2, 4)}`
  }
  const datesStr = `${ymStr(first.m)}-${ymStr(last.m)}`
  const yrsMsg =
    numMos % 12 === 0
      ? `${numYrs.toFixed(0)} year${numMos === 12 ? '' : 's'} (${datesStr})`
      : `${numYrs.toFixed(1)} years (${numMos} mos, ${datesStr})`
  const [percentStr, typeStr] = percent >= 0 ? [percent.toFixed(1), 'increase'] : [(-percent).toFixed(1), 'decrease']
  return `${yrsMsg}: ${first.v.toFixed(0)} → ${last.v.toFixed(0)} (${ratio.toFixed(1)}x), ${percentStr}% avg annual ${typeStr}`
}
