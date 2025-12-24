import { useRegisteredHotkeys, type HotkeyMap } from '@rdub/use-hotkeys'
import { useMemo } from 'react'
import type { DateRange } from '../date-range'
import type { Gender, Region, RideableType, StackBy, UserType, YAxis } from '../data'

interface UseKeyboardShortcutsProps {
  setDateRange: (range: DateRange) => void
  setStackBy: (stackBy: StackBy) => void
  setYAxis: (yAxis: YAxis) => void
  setRollingAvgs: (avgs: number[]) => void
  rollingAvgs: number[]
  setStackRelative: (relative: boolean) => void
  stackRelative: boolean
  setShowLegend: (show: boolean | null) => void
  showLegendValue: boolean
  openShortcutsModal: () => void
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

// Default hotkey map: key combination -> action name
export const DEFAULT_HOTKEY_MAP: HotkeyMap = {
  // Date ranges
  '1': 'date:1y',
  '2': 'date:2y',
  '3': 'date:3y',
  '4': 'date:4y',
  '5': 'date:5y',
  'x': 'date:all',
  // Stack by
  '-': 'stack:none',
  'r': 'stack:region',
  'u': 'stack:usertype',
  'g': 'stack:gender',
  'b': 'stack:biketype',
  // Y-axis
  'shift+r': 'yaxis:rides',
  'shift+m': 'yaxis:minutes',
  // Toggles
  'l': 'toggle:legend',
  'A': 'toggle:avg',
  'p': 'toggle:percent',
  // Other
  's': 'other:settings',
  't': 'other:theme',
  // Region toggles (lowercase)
  'j': 'region:jc',
  'h': 'region:hob',
  'n': 'region:nyc',
  // User type toggles (lowercase)
  'a': 'user:annual',
  'd': 'user:daily',
  // Gender toggles
  'm': 'gender:men',
  'w': 'gender:women',
  'shift+g': 'gender:unknown',
  // Bike type toggles
  'c': 'bike:classic',
  'e': 'bike:electric',
  'o': 'bike:unknown',
  // Modal
  '?': 'modal:shortcuts',
  'meta+/': 'modal:shortcuts',
} as const

// Descriptions for keyboard shortcuts modal
export const HOTKEY_DESCRIPTIONS: Record<string, string> = {
  // Date ranges
  'date:1y': '1 year',
  'date:2y': '2 years',
  'date:3y': '3 years',
  'date:4y': '4 years',
  'date:5y': '5 years',
  'date:all': 'All time',
  // Stack by
  'stack:none': 'No stacking',
  'stack:region': 'By region',
  'stack:usertype': 'By user type',
  'stack:gender': 'By gender',
  'stack:biketype': 'By bike type',
  // Y-axis
  'yaxis:rides': 'Rides',
  'yaxis:minutes': 'Minutes',
  // Toggles
  'toggle:legend': 'Legend',
  'toggle:avg': '12mo average',
  'toggle:percent': 'Stack %',
  // Other
  'other:settings': 'Open/Close controls',
  'other:theme': 'Theme (system/light/dark)',
  // Region toggles
  'region:jc': 'Toggle JC',
  'region:hob': 'Toggle HOB',
  'region:nyc': 'Toggle NYC',
  // User type toggles
  'user:annual': 'Toggle Annual',
  'user:daily': 'Toggle Daily',
  // Gender toggles
  'gender:men': 'Toggle Men',
  'gender:women': 'Toggle Women',
  'gender:unknown': 'Toggle Unknown',
  // Bike type toggles
  'bike:classic': 'Toggle Classic',
  'bike:electric': 'Toggle Electric',
  'bike:unknown': 'Toggle Unknown',
  // Modal
  'modal:shortcuts': 'This dialog',
}

// Group names for shortcuts modal
export const HOTKEY_GROUPS: Record<string, string> = {
  'date': 'Date Range',
  'stack': 'Stack By',
  'yaxis': 'Y-Axis',
  'toggle': 'Toggles',
  'region': 'Region',
  'user': 'User Type',
  'gender': 'Gender',
  'bike': 'Bike Type',
  'modal': 'Other',
  'other': 'Other',
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
  setDateRange,
  setStackBy,
  setYAxis,
  setRollingAvgs,
  rollingAvgs,
  setStackRelative,
  stackRelative,
  setShowLegend,
  showLegendValue,
  openShortcutsModal,
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
  const handlers = useMemo(() => ({
    // Date ranges
    'date:1y': () => setDateRange('1y'),
    'date:2y': () => setDateRange('2y'),
    'date:3y': () => setDateRange('3y'),
    'date:4y': () => setDateRange('4y'),
    'date:5y': () => setDateRange('5y'),
    'date:all': () => setDateRange('All'),
    // Stack by
    'stack:none': () => setStackBy('None'),
    'stack:region': () => setStackBy('Region'),
    'stack:usertype': () => setStackBy('User Type'),
    'stack:gender': () => setStackBy('Gender'),
    'stack:biketype': () => setStackBy('Rideable Type'),
    // Y-axis
    'yaxis:rides': () => setYAxis('Rides'),
    'yaxis:minutes': () => setYAxis('Ride minutes'),
    // Toggles
    'toggle:legend': () => setShowLegend(!showLegendValue),
    'toggle:avg': () => setRollingAvgs(rollingAvgs.includes(12) ? [] : [12]),
    'toggle:percent': () => setStackRelative(!stackRelative),
    'other:settings': () => setControlsOpen(!controlsOpen),
    'other:theme': toggleTheme,
    // Region toggles
    'region:jc': () => setRegions(toggleItem(regions, 'JC')),
    'region:hob': () => setRegions(toggleItem(regions, 'HOB')),
    'region:nyc': () => setRegions(toggleItem(regions, 'NYC')),
    // User type toggles
    'user:annual': () => setUserTypes(toggleItem(userTypes, 'Annual')),
    'user:daily': () => setUserTypes(toggleItem(userTypes, 'Daily')),
    // Gender toggles
    'gender:men': () => setGenders(toggleItem(genders, 'Men')),
    'gender:women': () => setGenders(toggleItem(genders, 'Women')),
    'gender:unknown': () => setGenders(toggleItem(genders, 'Unknown')),
    // Bike type toggles
    'bike:classic': () => setRideableTypes(toggleItem(rideableTypes, 'Classic')),
    'bike:electric': () => setRideableTypes(toggleItem(rideableTypes, 'Electric')),
    'bike:unknown': () => setRideableTypes(toggleItem(rideableTypes, 'Unknown')),
    // Modal
    'modal:shortcuts': openShortcutsModal,
  }), [setDateRange, setStackBy, setYAxis, setRollingAvgs, rollingAvgs, setStackRelative, stackRelative, setShowLegend, showLegendValue, openShortcutsModal, setControlsOpen, controlsOpen, toggleTheme, setRegions, regions, setUserTypes, userTypes, setGenders, genders, setRideableTypes, rideableTypes])

  return useRegisteredHotkeys(handlers, { sequenceTimeout: 1000 })
}
