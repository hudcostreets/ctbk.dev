// Data types for Citi Bike dashboard

export type Region = 'NYC' | 'JC' | 'HOB'
export const Regions: Region[] = ['JC', 'HOB', 'NYC']

export type UserType = 'Annual' | 'Daily'
export const UserTypes: UserType[] = ['Annual', 'Daily']

export type Gender = 'Men' | 'Women' | 'Unknown'
export const Genders: Gender[] = ['Men', 'Women', 'Unknown']
export const Int2Gender: { [k: number]: Gender } = { 0: 'Unknown', 1: 'Men', 2: 'Women' }

export type RideableType = 'Classic' | 'Electric' | 'Unknown'
export const RideableTypes: RideableType[] = ['Classic', 'Electric', 'Unknown']
export const NormalizeRideableType: { [k: string]: RideableType } = {
  'docked_bike': 'Classic',
  'classic_bike': 'Classic',
  'electric_bike': 'Electric',
  'unknown': 'Unknown',
  'motivate_dockless_bike': 'Unknown',
}

export type StackBy = 'None' | 'Region' | 'User Type' | 'Gender' | 'Rideable Type'
export const StackBys: StackBy[] = ['None', 'Region', 'User Type', 'Gender', 'Rideable Type']

export type YAxis = 'Rides' | 'Ride minutes'
export const YAxes: YAxis[] = ['Rides', 'Ride minutes']

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

export const DEFAULT_COLORS = ['#636EFA', '#EF553B', '#00CC96', '#AB63FA', '#FFA15A', '#19D3F3', '#FF6692', '#B6E880', '#FF97FF', '#FECB52']

export const RegionColors: Record<Region, string> = { 'NYC': '#636efa', 'HOB': '#63aefa', 'JC': '#632bfa' }
export const UserTypeColors: Record<UserType, string> = { 'Daily': '#FF6692', 'Annual': '#FF97ff' }
export const GenderColors: Record<Gender, string> = { 'Unknown': '#AB63FA', 'Men': '#19D3F3', 'Women': '#FFA15A' }
export const RideableTypeColors: Record<RideableType, string> = { 'Unknown': '#636EFA', 'Electric': '#AB63FA', 'Classic': '#00CC96' }

export const Colors: Record<StackBy, Record<string, string>> = {
  None: { '': DEFAULT_COLORS[0], Total: 'black' },
  Region: RegionColors,
  Gender: GenderColors,
  'User Type': UserTypeColors,
  'Rideable Type': RideableTypeColors,
}

export const stackKeyDict: Record<StackBy, string[]> = {
  'None': [''],
  'User Type': ['Daily', 'Annual'],
  'Gender': ['Unknown', 'Women', 'Men'],
  'Rideable Type': ['Electric', 'Classic', 'Unknown'],
  'Region': ['JC', 'HOB', 'NYC'],
}

export const yAxisLabelDict: Record<YAxis, { title: string; hoverLabel: string }> = {
  'Rides': { title: 'Citi Bike Rides per Month', hoverLabel: 'Rides' },
  'Ride minutes': { title: 'Citi Bike Ride Minutes per Month', hoverLabel: 'Minutes' },
}

export const toYM = (d: Date) => `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`
