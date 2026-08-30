import type { ClosureInfo } from '../types'

export function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

/** Returns 6-column (Mon-Sat) grid rows; Sunday column is omitted. */
export function monthGrid(y: number, m: number): (Date | null)[][] {
  const firstDow = new Date(y, m - 1, 1).getDay() // 0=Sun..6=Sat
  const monIndex = (firstDow + 6) % 7             // 0=Mon..5=Sat, 6=Sun
  const dim = daysInMonth(y, m)
  const cells: (Date | null)[] = []
  // fill leading empty cells (Mon-based, 7 cols including Sun)
  for (let i = 0; i < monIndex; i++) cells.push(null)
  for (let d = 1; d <= dim; d++) cells.push(new Date(y, m - 1, d))
  while (cells.length % 7 !== 0) cells.push(null)
  const rows: (Date | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}

/** Default closure for a day (no DB overrides).
 *  Sunday → both closed
 *  Saturday → dinner only closed
 *  Public holiday → both closed
 */
export function getDefaultClosure(d: Date, holidayLabels: Record<string, string>): ClosureInfo | null {
  const dow = d.getDay()
  const iso = isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
  const hLabel = holidayLabels[iso] || null

  if (dow === 0) {
    return { lunch_closed: true, dinner_closed: true, label: '' }
  }
  if (hLabel) {
    return { lunch_closed: true, dinner_closed: true, label: hLabel }
  }
  if (dow === 6) {
    return { lunch_closed: false, dinner_closed: true, label: '' }
  }
  return null // fully open
}

/** Merged closure: DB override takes priority over default. */
export function effectiveClosure(
  d: Date,
  overrides: Record<string, ClosureInfo>,
  holidayLabels: Record<string, string>
): ClosureInfo | null {
  const iso = isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
  if (iso in overrides) {
    const ov = overrides[iso]
    const def = getDefaultClosure(d, holidayLabels)
    // inherit label from holiday if override doesn't set one
    return { ...ov, label: ov.label || (def?.label ?? '') }
  }
  return getDefaultClosure(d, holidayLabels)
}

export function isFullyClosed(c: ClosureInfo | null): boolean {
  return !!c && c.lunch_closed && c.dinner_closed
}
