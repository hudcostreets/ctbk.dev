import Head0 from "@rdub/next-base/head"
import React from "react"
import { DOMAIN, SCREENSHOTS } from "./paths"

export default function Head({ title, description, path, thumbnail }: { title: string, description: string, path?: string, thumbnail: string }) {
  return (
    <Head0
      title={title}
      description={description}
      url={`${DOMAIN}/${path || ""}`}
      thumbnail={`${SCREENSHOTS}/${thumbnail}.png`}
    >
      <meta name="twitter:card" content="summary" key="twcard" />
      <meta name="twitter:creator" content={"RunsAsCoded"} key="twhandle" />
      <meta property="og:site_name" content="ctbk.dev" key="ogsitename" />
    </Head0>
  )
}
