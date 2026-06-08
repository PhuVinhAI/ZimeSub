/**
 * Tiny relative-time formatter for the Sidebar recents list.
 *
 * Returns a Vietnamese phrase that approximates the distance between
 * `iso` (an ISO 8601 timestamp from `recent_projects[].last_opened`) and
 * `now`. Designed to be cheap enough to call on every render — no
 * `Intl.RelativeTimeFormat` instance per call, no allocation beyond the
 * returned string.
 *
 * Buckets, with the lower-bound side inclusive:
 *  - <  1 phút  → "vừa mở"
 *  - <  1 giờ   → "N phút trước"
 *  - <  1 ngày  → "N giờ trước"
 *  - <  7 ngày  → "N ngày trước"
 *  - < 30 ngày  → "N tuần trước"
 *  - else       → "DD/MM/YYYY"
 *
 * `iso` parse failures fall back to the empty string so the row still
 * renders (the project name is the primary affordance).
 */
export function formatRelativeVi(iso: string, now: Date = new Date()): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return ''

  const deltaMs = now.getTime() - parsed
  if (deltaMs < 0) return 'vừa mở'

  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return 'vừa mở'
  if (minutes < 60) return `${minutes} phút trước`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} giờ trước`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} ngày trước`

  const weeks = Math.floor(days / 7)
  if (days < 30) return `${weeks} tuần trước`

  const date = new Date(parsed)
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = date.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}
