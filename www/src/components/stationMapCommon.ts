/**
 * Station-map types + tile styles shared by the Leaflet `StationMap` and the
 * GL maps, kept out of `StationMap.tsx` so importing them doesn't pull in
 * leaflet.
 */

export type StationValue = {
  name: string
  lat: number
  lng: number
  ends: number
}
export type Stations = Record<string, StationValue>
export type StationPairCounts = Record<string, Record<string, number>>

export type TileStyle = {
  name: string
  url: string
  attribution: string
}

export const TILE_STYLES: Record<string, TileStyle> = {
  dark: {
    name: 'Dark',
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  },
  light: {
    name: 'Light',
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  },
  osm: {
    name: 'OSM',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
}

export type TileColors = { circle: string; selected: string; line: string; title: string }
export const TILE_COLORS: Record<string, TileColors> = {
  dark: { circle: 'orange', selected: 'yellow', line: 'red', title: 'white' },
  light: { circle: '#d35400', selected: '#c0392b', line: '#8e44ad', title: '#222' },
  osm: { circle: '#d35400', selected: '#c0392b', line: '#8e44ad', title: '#222' },
}

/** Resolve tile code (a/d/l/o or full names) to a style name, handling 'auto' mode. */
export function resolveTileStyle(tileCode: string | undefined, actualTheme: 'light' | 'dark'): string {
  const code = tileCode || 'a'
  if (code === 'a' || code === 'auto') return actualTheme === 'dark' ? 'dark' : 'light'
  if (code === 'd' || code === 'dark') return 'dark'
  if (code === 'l' || code === 'light') return 'light'
  if (code === 'o' || code === 'osm') return 'osm'
  return actualTheme === 'dark' ? 'dark' : 'light'
}
