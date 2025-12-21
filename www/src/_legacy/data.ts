import { entries, fromEntries } from "@rdub/base/objs"
import type { DownloadFmt as DownloadFmt0 } from "@rdub/next-plotly/plot-wrapper"

export type Region = 'NYC' | 'JC' | 'HOB'
export const Regions: Region[] = [ 'JC', 'HOB', 'NYC', ]
export const RegionQueryStrings: [Region, string][] = [ ['HOB','h'], ['NYC','n'], ['JC','j'], ]

export type UserType = 'Annual' | 'Daily'
export const UserTypes: UserType[] = ['Annual', 'Daily']
export const UserTypeQueryStrings: [UserType, string][] = [ ['Annual', 'a'], ['Daily','d'], ]

export type Gender = 'Men' | 'Women' | 'Unknown'
export const Genders: Gender[] = [ 'Men', 'Women', 'Unknown']
export const GenderQueryStrings: [ Gender, string ][] = [ ['Men', 'm'], ['Women', 'f'], ['Unknown', 'u'], ]
export const Int2Gender: { [k: number]: Gender } = { 0: 'Unknown', 1: 'Men', 2: 'Women' }
// Gender data became 100% "Unknown" from February 2021; don't bother with per-entry
// rolling averages from that point onward
export const GenderRollingAvgCutoff = '2021-02'

export type RideableType = 'Classic' | 'Electric' | 'Unknown'
export const RideableTypes: RideableType[] = ['Classic', 'Electric', 'Unknown']
export const RideableTypeChars: [ RideableType, string ][] = [['Classic', 'c'], ['Electric','e'], ['Unknown','u']]
export const NormalizeRideableType: { [k: string]: RideableType } = {
  'docked_bike': 'Classic',
  'classic_bike': 'Classic',
  'electric_bike': 'Electric',
  'unknown': 'Unknown',
  'motivate_dockless_bike': 'Unknown',
}
export const UnknownRideableCutoff = '2021-02'

export type StackBy = 'None' | 'Region' | 'User Type' | 'Gender' | 'Rideable Type'
export const StackBys: [StackBy, string][] = [
  ['None', 'n'],
  ['Region', 'r'],
  ['Gender','g'],
  ['User Type','u'],
  ['Rideable Type','b'],
]

export type DownloadFmt = 'none' | '' | DownloadFmt0
export const DownloadFmts: DownloadFmt[] = [ 'none', '', 'png', 'jpg', 'jpeg', 'webp', 'svg' ]

export const DEFAULT_COLORS = ['#636EFA', '#EF553B', '#00CC96', '#AB63FA', '#FFA15A', '#19D3F3', '#FF6692', '#B6E880', '#FF97FF', '#FECB52']
export const RideableTypeColors: { [r in RideableType]: string } = {
  'Unknown': '#636EFA',
  // 'Docked': '#EF553B',
  'Electric': '#AB63FA',
  'Classic': '#00CC96',
}
export const GenderColors: { [g in Gender]: string } = {
  'Unknown': '#AB63FA',
  'Men': '#19D3F3',
  'Women': '#FFA15A',
}
export const UserTypeColors: { [u in UserType]: string } = { 'Daily': '#FF6692', 'Annual': '#FF97ff', }
export const RegionColors: { [r in Region]: string } = { 'NYC': '#636efa', 'HOB': '#63aefa', 'JC': '#632bfa', }
export const Colors = {
  None: { '': DEFAULT_COLORS[0], Total: 'black', },
  Region: RegionColors,
  Gender: GenderColors,
  'User Type': UserTypeColors,
  'Rideable Type': RideableTypeColors,
}

export type YAxis = 'Rides' | 'Ride minutes'
export const YAxes: [YAxis, string][] = [ ['Rides', 'r'], ['Ride minutes', 'm'], ]
export const yAxisLabelDict: { [k in YAxis]: { yAxis: string, title: string, hoverLabel: string } } = {
  'Rides': { yAxis: 'Total Rides', title: 'Citi Bike Rides per Month', hoverLabel: 'Rides' },
  'Ride minutes': { yAxis: 'Total Ride Minutes', title: 'Citi Bike Ride Minutes per Month', hoverLabel: 'Minutes', },
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
}

export const stackKeyDict = {
  'None': [''],
  'User Type': ['Daily', 'Annual'],
  'Gender': ['Unknown', 'Women', 'Men'],
  'Rideable Type': ['Electric', 'Classic', 'Unknown'],
  'Region': [ 'JC', 'HOB', 'NYC', ],
}

export type NumS<K extends string = string> = { [k in K]: number }
export function rollingAvg<K extends string = string>(vs: NumS<K>, n: number, ): NumS<K> {
  let avgs: [ K, number, ][] = []
  let sum: number = 0
  let elems: number[] = []
  entries(vs).forEach(([ k, v ], i) => {
    sum += v
    elems.push(v)
    if (i >= n) {
      const evicted: number = elems.shift() || NaN
      sum -= evicted
      const avg = sum / n
      avgs.push([ k, avg, ])
    } else {
      avgs.push([ k, NaN, ])
    }
  })
  return fromEntries(avgs) as NumS<K>
}

export const toYM = (d: Date) => `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`
