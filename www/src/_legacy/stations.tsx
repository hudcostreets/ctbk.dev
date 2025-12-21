import { entries, keys } from "@rdub/base/objs"
import MapContainer from "@rdub/next-leaflet/container"
import { getMetersPerPixel } from "@rdub/next-leaflet/map/mPerPx"
import { Dispatch, useMemo } from "react"
import { Pane, Polyline, Tooltip, useMap } from "react-leaflet"
import StationCircle from "./station-circle"
import css from "../pages/stations.module.css"
import type { MapContainerProps } from "@rdub/next-leaflet/container"

const { sqrt } = Math

export type ID = string
export type StationValue = {
  name: string
  lat: number
  lng: number
  // starts: number
  ends: number
}
export type Stations = Record<ID, StationValue>

export type StationPairCounts = {
    [k1: string]: { [k2: string]: number }
}

export type Props = {
    stations: Stations
    selectedStationId: string | undefined
    setSelectedStationId: Dispatch<string | undefined>
    stationPairCounts: StationPairCounts | null
    className?: string
}

export type CountRow = {
    id: string
    count: number
}

export function MapBody(
  {
    stations,
    selectedStationId, setSelectedStationId,
    stationPairCounts,
  }: Props
) {
  const map = useMap()
  const zoom = map.getZoom()
  const mPerPx = useMemo(() => getMetersPerPixel(map), [ map, zoom, ])

  const selectedStation = useMemo(
    () => selectedStationId ? stations[selectedStationId] : undefined,
    [ stations, selectedStationId ]
  )

  const lines = useMemo(
    () => {
      if (!selectedStation || !selectedStationId || !stationPairCounts) return null
      if (!(selectedStationId in stationPairCounts)) {
        console.log(`${selectedStationId} not found among ${keys(stationPairCounts).length} stations`)
        return null
      }
      const selectedPairCounts = stationPairCounts[selectedStationId]
      // console.log("selectedPairCounts:", selectedPairCounts)
      const selectedPairValues = Array.from(Object.values(selectedPairCounts))
      // console.log("selectedPairValues:", selectedPairValues)
      const maxDst = Math.max(...selectedPairValues)
      const src = selectedStation
      return <Pane name={"lines"} className={css.lines}>{
        entries(selectedPairCounts).map(([ id, count ]) => {
          // if (Count != maxDst) return
          if (!(id in stations)) {
            console.log(`id ${id} not in stations:`, stations)
            return
          }
          const { name, lat, lng } = stations[id]
          return <Polyline key={`${selectedStationId}-${id}-${zoom}`} color={"red"}
            positions={[[src.lat, src.lng], [lat, lng],]}
            weight={Math.max(0.7, count / maxDst * sqrt(src.ends) / mPerPx)} opacity={0.7}>
            <Tooltip sticky={true}>
              {src.name} → {name}: {count}
            </Tooltip>
          </Polyline>
        })
      }
      </Pane>
    },
    [ stationPairCounts, selectedStationId, mPerPx ]
  )

  const stationCircleProps = { stations, selectedStationId, setSelectedStationId }
  return <>
    <Pane name={"selected"} className={css.selected}>{
      selectedStationId && selectedStation &&
            <StationCircle
              key={selectedStationId}
              id={selectedStationId}
              count={selectedStation.ends}
              selected={true}
              {...stationCircleProps}
            />
    }</Pane>
    {lines}
    <Pane name={"circles"} className={css.circles}>{
      entries(stations)
        .map(([ id, station ]) =>
          <StationCircle
            key={id}
            id={id}
            count={station.ends}
            {...stationCircleProps}
          />
        )
    }</Pane>
  </>
}

export default function Map({ mapProps, bodyProps }: { mapProps: MapContainerProps, bodyProps: Props }) {
  return (
    <MapContainer {...mapProps}>
      <MapBody {...bodyProps} />
    </MapContainer>
  )
}
