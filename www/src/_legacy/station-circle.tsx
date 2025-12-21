import { Dispatch } from "react"
import { Circle, Tooltip } from "react-leaflet"
import { CountRow, Stations } from "./stations"
import css from "../pages/stations.module.css"
const { sqrt } = Math

export type Props = CountRow & {
    stations: Stations
    selectedStationId: string | undefined
    setSelectedStationId: Dispatch<string | undefined>
    selected?: boolean
}

export default function StationCircle(
  {
    id,
    count,
    selected,
    selectedStationId, setSelectedStationId,
    stations,
  }: Props
) {
  if (!(id in stations)) {
    console.log(`id ${id} not in stations`)
    return null
  }
  const { name, lat, lng } = stations[id]
  const radius = sqrt(count)
  if (isNaN(radius)) {
    return null
  }
  return (
    <Circle
      key={id}
      center={{ lat, lng }}
      color={selected ? "yellow" : "orange"}
      radius={sqrt(count)}
      bubblingMouseEvents={false}
      eventHandlers={{
        click: e => {
          if (id == selectedStationId) return
          console.log("click!", name, e)
          setSelectedStationId(id)
        },
        mouseover: e => {
          if (id == selectedStationId) return
          console.log("over!", name, e)
          setSelectedStationId(id)
        },
      }}
    >
      <Tooltip className={css.tooltip} sticky={true} permanent={id == selectedStationId} pane={"selected"}>
        <p>{name}: {count}</p>
      </Tooltip>
    </Circle>
  )
}
