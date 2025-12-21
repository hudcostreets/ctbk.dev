import L from 'leaflet'
import { ReactElement } from 'react'
import * as ReactLeaflet from 'react-leaflet'
import { useMap } from "react-leaflet"
import { MapContainerProps } from "react-leaflet/lib/MapContainer"
import styles from './Map.module.css'

type MapProps = (Omit<MapContainerProps, "children"> & { children: (RL: typeof ReactLeaflet, map: L.Map) => ReactElement<{}> })

function MapConsumer(_ref: { children: (map: L.Map) => ReactElement<{}> }) {
  let { children } = _ref
  return children(useMap())
}

const Map = ({ children, className, ...rest }: MapProps) => {
  let mapClassName = styles.map

  if ( className ) {
    mapClassName = `${mapClassName} ${className}`
  }

  const MapContainer = ReactLeaflet.MapContainer
  return (
    <MapContainer className={mapClassName} {...rest}>
      <MapConsumer>{
        (map: L.Map) => children(ReactLeaflet, map)
      }</MapConsumer>
    </MapContainer>
  )
}

export default Map
