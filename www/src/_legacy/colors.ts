// Hex-color utilities
export function pad(num: number, size: number){
  return ('0' + num.toString(16)).substr(-size)
}

export function darken(c: string, f = 0.5): string {
  return '#' + [
    c.substring(1, 3),
    c.substring(3, 5),
    c.substring(5, 7)
  ]
    .map((s) =>
      pad(
        Math.round(
          parseInt(s, 16) * f
        ),
        2
      )
    )
    .join('')
}
