import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import css from './StationSearch.module.css'

type StationValue = {
  name: string
  lat: number
  lng: number
  ends: number
}
type Stations = Record<string, StationValue>

interface StationSearchProps {
  isOpen: boolean
  onClose: () => void
  stations: Stations
  onSelect: (id: string) => void
}

export function StationSearch({ isOpen, onClose, stations, onSelect }: StationSearchProps) {
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter and sort stations by name match
  const filteredStations = useMemo(() => {
    if (!query.trim()) {
      // Sort by ride count when no query
      return Object.entries(stations)
        .sort((a, b) => b[1].ends - a[1].ends)
        .slice(0, 20)
    }

    const lowerQuery = query.toLowerCase()
    return Object.entries(stations)
      .filter(([, station]) => station.name.toLowerCase().includes(lowerQuery))
      .sort((a, b) => {
        const aName = a[1].name.toLowerCase()
        const bName = b[1].name.toLowerCase()
        // Prioritize starts-with matches
        const aStarts = aName.startsWith(lowerQuery)
        const bStarts = bName.startsWith(lowerQuery)
        if (aStarts && !bStarts) return -1
        if (!aStarts && bStarts) return 1
        // Then by ride count
        return b[1].ends - a[1].ends
      })
      .slice(0, 20)
  }, [stations, query])

  // Reset highlight when results change
  useEffect(() => {
    setHighlightedIndex(0)
  }, [filteredStations])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
      setQuery('')
      setHighlightedIndex(0)
    }
  }, [isOpen])

  // Scroll highlighted item into view
  useEffect(() => {
    if (listRef.current) {
      const highlighted = listRef.current.children[highlightedIndex] as HTMLElement
      if (highlighted) {
        highlighted.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [highlightedIndex])

  const handleSelect = useCallback((id: string) => {
    onSelect(id)
    onClose()
  }, [onSelect, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex(i => Math.min(i + 1, filteredStations.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (filteredStations[highlightedIndex]) {
          handleSelect(filteredStations[highlightedIndex][0])
        }
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }, [filteredStations, highlightedIndex, handleSelect, onClose])

  if (!isOpen) return null

  return (
    <div className={css.overlay} onClick={onClose}>
      <div className={css.modal} onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className={css.input}
          placeholder="Search stations..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div ref={listRef} className={css.list}>
          {filteredStations.map(([id, station], index) => (
            <div
              key={id}
              className={`${css.item} ${index === highlightedIndex ? css.highlighted : ''}`}
              onClick={() => handleSelect(id)}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              <span className={css.name}>{station.name}</span>
              <span className={css.count}>{station.ends.toLocaleString()}</span>
            </div>
          ))}
          {filteredStations.length === 0 && (
            <div className={css.empty}>No stations found</div>
          )}
        </div>
      </div>
    </div>
  )
}
