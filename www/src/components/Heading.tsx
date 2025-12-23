import { ReactNode, createElement } from 'react'
import styles from './Heading.module.css'

interface HeadingProps {
  id: string
  level?: 1 | 2 | 3 | 4 | 5 | 6
  children: ReactNode
  offset?: number // pixels above the heading for the anchor target
}

export function Heading({ id, level = 2, children, offset = 80 }: HeadingProps) {
  const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

  return (
    <div className={styles.wrapper}>
      {/* Invisible anchor target positioned above the heading */}
      <span id={id} className={styles.anchor} style={{ top: -offset }} />
      {createElement(Tag, {},
        <a href={`#${id}`} className={styles.link}>
          {children}
        </a>
      )}
    </div>
  )
}

// Convenience components for MDX usage
export const H1 = (props: Omit<HeadingProps, 'level'>) => <Heading level={1} {...props} />
export const H2 = (props: Omit<HeadingProps, 'level'>) => <Heading level={2} {...props} />
export const H3 = (props: Omit<HeadingProps, 'level'>) => <Heading level={3} {...props} />
export const H4 = (props: Omit<HeadingProps, 'level'>) => <Heading level={4} {...props} />
