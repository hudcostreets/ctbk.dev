import { Link } from 'react-router-dom'
import { GitHubIcon, S3Icon, BlueskyIcon, PipelineIcon, HomeIcon } from "./icons"
import css from './Footer.module.css'

interface FooterProps {
  showPipeline?: boolean
  showHome?: boolean
}

export function Footer({ showPipeline = true, showHome = false }: FooterProps) {
  return (
    <div className={css.footer}>
      {showHome && (
        <>
          Home: <Link to="/"><HomeIcon className={css.icon} /></Link>
        </>
      )}
      Code: <a href="https://github.com/hudcostreets/ctbk.dev" target="_blank" rel="noopener noreferrer">
        <GitHubIcon className={css.icon} />
      </a>
      Data: <a href="https://s3.amazonaws.com/ctbk/index.html" target="_blank" rel="noopener noreferrer">
        <S3Icon className={css.icon} />
      </a>
      {showPipeline && (
        <>
          Pipeline: <Link to="/pipeline"><PipelineIcon className={css.icon} /></Link>
        </>
      )}
      Author: <a href="https://bsky.app/profile/runsascoded.com" target="_blank" rel="noopener noreferrer">
        <BlueskyIcon className={css.icon} />
      </a>
    </div>
  )
}
