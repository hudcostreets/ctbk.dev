import { useAction } from 'use-kbd'
import { useNavigate } from 'react-router-dom'
import { type DateRange, isDurationBased } from '../date-range'
import type { Gender, Region, RideableType, StackBy, UserType, YAxis } from '../data'

// Example preset URLs
const PRESETS = {
  default: '/',
  jcHoboken: '/?r=jh',
  jcHobokenStacked: '/?r=jh&s=r',
  genderMinutes: '/?y=m&s=g&pct=&g=mf&d=1406-2102',
  memberCustomer: '/?s=u&pct=',
  bikeTypes: '/?y=m&s=b&rt=ce&d=2002-',
  bikeTypesStacked: '/?y=m&s=b&rt=ce&d=2002-&pct',
} as const

interface UseKeyboardShortcutsProps {
  dateRange: DateRange
  setDateRange: (range: DateRange) => void
  setStackBy: (stackBy: StackBy) => void
  setYAxis: (yAxis: YAxis) => void
  setRollingAvgs: (avgs: number[]) => void
  rollingAvgs: number[]
  setStackRelative: (relative: boolean) => void
  stackRelative: boolean
  setShowLegend: (show: boolean | null) => void
  showLegendValue: boolean
  setControlsOpen: (open: boolean) => void
  controlsOpen: boolean
  toggleTheme: () => void
  // Checkbox toggles
  setRegions: (regions: Region[]) => void
  regions: Region[]
  setUserTypes: (userTypes: UserType[]) => void
  userTypes: UserType[]
  setGenders: (genders: Gender[]) => void
  genders: Gender[]
  setRideableTypes: (rideableTypes: RideableType[]) => void
  rideableTypes: RideableType[]
}

// Helper to toggle an item in an array (at least one must remain)
function toggleItem<T>(arr: T[], item: T): T[] {
  if (arr.includes(item)) {
    // Don't remove if it's the only one
    if (arr.length > 1) {
      return arr.filter(x => x !== item)
    }
    return arr
  }
  return [...arr, item]
}

export function useKeyboardShortcuts({
  dateRange,
  setDateRange,
  setStackBy,
  setYAxis,
  setRollingAvgs,
  rollingAvgs,
  setStackRelative,
  stackRelative,
  setShowLegend,
  showLegendValue,
  setControlsOpen,
  controlsOpen,
  toggleTheme,
  setRegions,
  regions,
  setUserTypes,
  userTypes,
  setGenders,
  genders,
  setRideableTypes,
  rideableTypes,
}: UseKeyboardShortcutsProps) {
  // Preserve end date when changing duration (unless currently "All")
  // Works for both duration-based and explicit ranges
  const currentEnd = dateRange === "All" ? undefined
    : isDurationBased(dateRange) ? dateRange.end
    : dateRange.end  // explicit range

  // Date ranges
  useAction('date:1y', { label: '1 year', group: 'Date Range', defaultBindings: ['1'], handler: () => setDateRange({ duration: '1y', end: currentEnd }) })
  useAction('date:2y', { label: '2 years', group: 'Date Range', defaultBindings: ['2'], handler: () => setDateRange({ duration: '2y', end: currentEnd }) })
  useAction('date:3y', { label: '3 years', group: 'Date Range', defaultBindings: ['3'], handler: () => setDateRange({ duration: '3y', end: currentEnd }) })
  useAction('date:4y', { label: '4 years', group: 'Date Range', defaultBindings: ['4'], handler: () => setDateRange({ duration: '4y', end: currentEnd }) })
  useAction('date:5y', { label: '5 years', group: 'Date Range', defaultBindings: ['5'], handler: () => setDateRange({ duration: '5y', end: currentEnd }) })
  useAction('date:all', { label: 'All time', group: 'Date Range', defaultBindings: ['x'], handler: () => setDateRange('All') })

  // Stack by (s prefix for sequences)
  useAction('stack:none', { label: 'Stack: none', group: 'Stack By', defaultBindings: ['s -', 's n'], handler: () => setStackBy('None') })
  useAction('stack:region', { label: 'Stack by region', group: 'Stack By', defaultBindings: ['s r'], handler: () => setStackBy('Region') })
  useAction('stack:usertype', { label: 'Stack by user type', group: 'Stack By', defaultBindings: ['s u'], handler: () => setStackBy('User Type') })
  useAction('stack:gender', { label: 'Stack by gender', group: 'Stack By', defaultBindings: ['s g'], handler: () => setStackBy('Gender') })
  useAction('stack:biketype', { label: 'Stack by bike type', group: 'Stack By', defaultBindings: ['s b'], handler: () => setStackBy('Rideable Type') })

  // Y-axis
  useAction('yaxis:rides', { label: 'Y-axis: ride count', group: 'Y-Axis', defaultBindings: ['shift+r'], handler: () => setYAxis('Rides') })
  useAction('yaxis:minutes', { label: 'Y-axis: ride minutes', group: 'Y-Axis', defaultBindings: ['shift+m'], handler: () => setYAxis('Ride minutes') })

  // Toggles (shift+ prefix)
  useAction('toggle:legend', { label: 'Toggle legend', group: 'Toggles', defaultBindings: ['shift+l'], handler: () => setShowLegend(!showLegendValue) })
  useAction('toggle:avg', { label: 'Toggle 12mo rolling average', group: 'Toggles', defaultBindings: ['shift+a'], handler: () => setRollingAvgs(rollingAvgs.includes(12) ? [] : [12]) })
  useAction('toggle:percent', { label: 'Toggle stack % (relative)', group: 'Toggles', defaultBindings: ['shift+p'], handler: () => setStackRelative(!stackRelative) })

  // Other (shift+ prefix)
  useAction('other:settings', { label: 'Toggle controls panel', group: 'Other', defaultBindings: ['shift+c'], handler: () => setControlsOpen(!controlsOpen) })
  useAction('other:theme', { label: 'Cycle theme (system/light/dark)', group: 'Other', defaultBindings: ['shift+t'], handler: toggleTheme })

  // Region toggles
  useAction('region:jc', { label: 'Toggle region: Jersey City', group: 'Region', defaultBindings: ['j'], handler: () => setRegions(toggleItem(regions, 'JC')) })
  useAction('region:hob', { label: 'Toggle region: Hoboken', group: 'Region', defaultBindings: ['h'], handler: () => setRegions(toggleItem(regions, 'HOB')) })
  useAction('region:nyc', { label: 'Toggle region: NYC', group: 'Region', defaultBindings: ['n'], handler: () => setRegions(toggleItem(regions, 'NYC')) })

  // User type toggles
  useAction('user:annual', { label: 'Toggle user: member (annual)', group: 'User Type', defaultBindings: ['a'], handler: () => setUserTypes(toggleItem(userTypes, 'Annual')) })
  useAction('user:daily', { label: 'Toggle user: customer (daily)', group: 'User Type', defaultBindings: ['d'], handler: () => setUserTypes(toggleItem(userTypes, 'Daily')) })

  // Gender toggles
  useAction('gender:men', { label: 'Toggle gender: men', group: 'Gender', defaultBindings: ['m'], handler: () => setGenders(toggleItem(genders, 'Men')) })
  useAction('gender:women', { label: 'Toggle gender: women', group: 'Gender', defaultBindings: ['w'], handler: () => setGenders(toggleItem(genders, 'Women')) })
  useAction('gender:unknown', { label: 'Toggle gender: unknown', group: 'Gender', defaultBindings: ['u'], handler: () => setGenders(toggleItem(genders, 'Unknown')) })

  // Bike type toggles
  useAction('bike:classic', { label: 'Toggle bike: classic', group: 'Bike Type', defaultBindings: ['c'], handler: () => setRideableTypes(toggleItem(rideableTypes, 'Classic')) })
  useAction('bike:electric', { label: 'Toggle bike: electric (e-bike)', group: 'Bike Type', defaultBindings: ['e'], handler: () => setRideableTypes(toggleItem(rideableTypes, 'Electric')) })
  useAction('bike:unknown', { label: 'Toggle bike: unknown', group: 'Bike Type', defaultBindings: ['o'], handler: () => setRideableTypes(toggleItem(rideableTypes, 'Unknown')) })

  // Example presets (no default bindings - omnibar only)
  const navigate = useNavigate()
  useAction('preset:default', { label: 'Preset: default view (all rides)', group: 'Presets', defaultBindings: [], handler: () => navigate(PRESETS.default) })
  useAction('preset:jc-hoboken', { label: 'Preset: JC + Hoboken', group: 'Presets', defaultBindings: [], handler: () => navigate(PRESETS.jcHoboken) })
  useAction('preset:jc-hoboken-stacked', { label: 'Preset: JC + Hoboken (stacked by region)', group: 'Presets', defaultBindings: [], handler: () => navigate(PRESETS.jcHobokenStacked) })
  useAction('preset:gender-minutes', { label: 'Preset: ride minutes, men vs women', group: 'Presets', defaultBindings: [], handler: () => navigate(PRESETS.genderMinutes) })
  useAction('preset:member-customer', { label: 'Preset: member vs customer %', group: 'Presets', defaultBindings: [], handler: () => navigate(PRESETS.memberCustomer) })
  useAction('preset:bike-types', { label: 'Preset: classic vs e-bike minutes', group: 'Presets', defaultBindings: [], handler: () => navigate(PRESETS.bikeTypes) })
  useAction('preset:bike-types-stacked', { label: 'Preset: classic vs e-bike (stacked %)', group: 'Presets', defaultBindings: [], handler: () => navigate(PRESETS.bikeTypesStacked) })
}
