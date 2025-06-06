import { fetchJson } from "@rdub/base/json/fetch"
import { loadJsonSync } from "@rdub/base/json/load"
import { floatParam, LL, llParam, Param, stringParam } from "@rdub/next-params/params"
import { parseQueryParams } from "@rdub/next-params/query"
import 'leaflet/dist/leaflet.css'
import _, { max } from "lodash"
import dynamic from "next/dynamic"
import { useMemo, useState } from 'react'
import css from './stations.module.css'
import { loadDvcUrlsMap } from '../src/dvc'
import Head from "../src/head"
import { JSON_PATH } from "../src/paths"
import type { ID, Props as StationsProps, StationPairCounts, Stations } from "../src/stations"
import type { MapContainerProps } from "@rdub/next-leaflet/container"
import { Row } from "../src/data"

const Map = dynamic(() => import("../src/stations"), { ssr: false })

const DEFAULT_CENTER = { lat: 40.758, lng: -73.965, }
const DEFAULT_ZOOM = 12

const { entries, fromEntries, keys } = Object

type Idx = string

export type Defaults = {
  ym: string
  stations: Stations
}
export type Props = {
  defaults: Defaults
  stationsUrls: Record<string, string>
  stationsPairsUrl: Record<string, string>
}

export async function getStaticProps() {
  const ymrgtb = loadJsonSync<Row[]>(JSON_PATH)
  const ym = max(ymrgtb.map(({ Year, Month }) => `${Year}${Month.toString().padStart(2, '0')}`))!
  const stationsUrls = await loadDvcUrlsMap(`../s3/ctbk/aggregated/20*/stations.json.dvc`)
  const stationsPairsUrl = await loadDvcUrlsMap(`../s3/ctbk/aggregated/20*/se_c.json.dvc`)
  const stationsUrl = stationsUrls[ym]
  console.log(`Stations URL (${ym}): ${stationsUrl}`)
  const stations = await fetchJson<Stations>(stationsUrl)
  const defaults: Defaults = { ym, stations }
  return { props: { defaults, stationsUrls, stationsPairsUrl, } }
}

type Params = {
    ll: Param<LL>
    z: Param<number>
    ss: Param<string | undefined>
    ym: Param<string>
}

export function ymParam(init: string, push: boolean = true): Param<string> {
  const ymRegex = /^20(\d{4})$/
  const vRegex = /^\d{4}$/
  return {
    encode: ym => {
      if (ym == init) return undefined
      const match = ym.match(ymRegex)
      if (match) {
        return match[1]
      } else {
        console.warn(`Invalid ym param: ${ym}`)
        return undefined
      }
    },
    decode: v => {
      if (!v) return init
      const match = v.match(vRegex)
      if (match) {
        return `20${v}`
      } else {
        console.warn(`Invalid ym param value: ${v}`)
        return init
      }
    },
    push,
  }
}

export default function Home({ defaults, stationsUrls, stationsPairsUrl, }: Props) {
  const params: Params = {
    ll: llParam({ init: DEFAULT_CENTER, places: 3, }),
    z: floatParam(DEFAULT_ZOOM, false),
    ss: stringParam(false),
    ym: ymParam(defaults.ym),
  }
  const {
    ll: [ center, setCenter ],
    z: [ zoom, setZoom, ],
    ss: [ selectedStationId, setSelectedStationId ],
    ym: [ ym, ],
  } = parseQueryParams({ params })

  const [ stations, setStations ] = useState(defaults.stations)
  const [ stationPairCounts, setStationPairCounts ] = useState<StationPairCounts | null>(null)

  const { ymString } = useMemo(
    () => {
      const year = parseInt(ym.substring(0, 4))
      const month = parseInt(ym.substring(4))
      const ymString = new Date(year, month - 1).toLocaleDateString('default', { month: 'short', year: 'numeric' })
      const stationsUrl = stationsUrls[ym]
      const stationPairsUrl = stationsPairsUrl[ym]

      let stationsPromise: Promise<Stations>
      if (ym == defaults.ym) {
        setStations(defaults.stations)
        console.log("Setting stations to default")
        stationsPromise = Promise.resolve(defaults.stations)
      } else {
        console.log(`fetching ${stationsUrl}`)
        stationsPromise = fetch(stationsUrl)
          .then<Stations>(data => data.json())
          .then(stations => {
            console.log(`got ${entries(stations).length} stations`)
            setStations(stations)
            return stations
          })
      }
      console.log(`fetching ${stationPairsUrl}`)
      Promise.all([
        stationsPromise,
        fetch(stationPairsUrl).then<StationPairCounts>(data => data.json())
      ]).then(([ newStations, data]) => {
        const idx2id: { [idx: Idx]: ID } = fromEntries(keys(newStations).map((id, idx) => [ idx, id ]))
        const newStationPairCounts =
                    fromEntries(
                      entries(data)
                        .map(([k1, v1]) => [
                          idx2id[k1],
                          _.mapKeys(v1, (v2, k2) => idx2id[k2])
                        ])
                    )
        console.log(`got stationPairCounts (${entries(newStationPairCounts).length} stations)`)
        setStationPairCounts(newStationPairCounts)
      })
      return { ymString }
    },
    [ ym ]
  )

  const title = `Citi Bike rides by station, ${ymString}`

  const mapProps: MapContainerProps = {
    center, setCenter,
    zoom, setZoom,
    className: css.homeMap,
    onClick: e => {
      console.log(`clearing selected station ${selectedStationId}`, e)
      setSelectedStationId(undefined)
    },
  }
  const mapBodyProps: StationsProps = {
    stations,
    selectedStationId,
    setSelectedStationId,
    stationPairCounts,
  }

  return (
    <div className={css.container}>
      <Head
        title={title}
        description={"Map of Citi Bike stations, including ridership counts and frequent destinations"}
        path={`stations`}
        thumbnail={`ctbk-stations`}
      />
      <main className={css.main}>
        <Map mapProps={mapProps} bodyProps={mapBodyProps} />
        {title && <div className={css.title}>{title}</div>}
      </main>
    </div>
  )
}
