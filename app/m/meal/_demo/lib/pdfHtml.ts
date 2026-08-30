import type { Application, ClosureInfo, Month } from '../types'
import { monthGrid, isoDate, effectiveClosure } from './calendar'

interface Args {
  year: number; month: number; m: Month
  closures: Record<string, ClosureInfo>; holidays: Record<string, string>
  application: Application | null
}

export function buildMonthPdfHtml({ year, month, m, closures, holidays, application }: Args): string {
  const grid = monthGrid(year, month).filter((w) => w.some((d) => d !== null))
  const eaten = new Set<string>()
  if (application) {
    for (const meal of application.meals) eaten.add(`${meal.date}|${meal.meal_type}`)
  }

  // Number of weeks determines row heights to fill A4
  const weekCount = grid.length    // 4 or 5
  const dateRowH = 18   // pt — compact date row
  const mealRowH = weekCount <= 4 ? 38 : 30   // pt — tall meal rows

  const cell = (d: Date | null, mealType: 'lunch' | 'dinner') => {
    if (!d) return `<td class="closed-cell"><div class="diag"></div></td>`
    const eff = effectiveClosure(d, closures, holidays)
    const closed = mealType === 'lunch' ? (eff?.lunch_closed ?? false) : (eff?.dinner_closed ?? false)
    const iso = isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
    const on = eaten.has(`${iso}|${mealType}`)
    if (closed) return `<td class="closed-cell"><div class="diag"></div></td>`
    return `<td class="meal-cell">${on ? '<span class="dot">●</span>' : ''}</td>`
  }

  const weekRows = grid.map((week, wi) => {
    const days = week.slice(0, 6) // Mon–Sat

    const dateCells = days.map((d) => {
      if (!d) return `<td class="date-cell empty-date"></td>`
      const eff = effectiveClosure(d, closures, holidays)
      const fullyOpen = !eff || (!eff.lunch_closed && !eff.dinner_closed)
      const label = eff?.label || ''
      const isSat = d.getDay() === 6
      return `<td class="date-cell${isSat ? ' sat' : ''}">${d.getDate()}${label ? `<br><span class="hlabel">${label}</span>` : ''}</td>`
    }).join('')

    return `
      <tr>
        <td class="wk-cell" rowspan="3">${wi + 1}주차</td>
        <td class="type-cell">날짜</td>${dateCells}
      </tr>
      <tr>
        <td class="type-cell">중식</td>${days.map((d) => cell(d, 'lunch')).join('')}
      </tr>
      <tr class="week-last">
        <td class="type-cell">석식</td>${days.map((d) => cell(d, 'dinner')).join('')}
      </tr>
    `
  }).join('')

  const noticeHtml = (m.notice || '').split('\n').filter((l) => l.trim())
    .map((l) => `<li>${l}</li>`).join('')

  const name = application?.name ?? ''
  const seat = application?.seat ?? ''
  const floor = application?.floor ?? ''

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.min.css');
@page { size: A4; margin: 14mm 18mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family:'Pretendard','Malgun Gothic',sans-serif; color:#000; background:#fff; font-size:11pt; }

h1 { text-align:center; font-size:18pt; font-weight:800; margin-bottom:10pt; letter-spacing:-0.02em; }

/* main table */
table { width:100%; border-collapse:collapse; table-layout:fixed; }
colgroup col.col-wk  { width:28pt; }
colgroup col.col-typ { width:22pt; }
colgroup col.col-day { width:auto; }

th,td { border:1px solid #444; text-align:center; vertical-align:middle; padding:2pt 2pt; }

/* header */
thead th { background:#ddd; font-weight:800; font-size:10pt; height:18pt; }
thead th.sat { color:#1d4ed8; }

/* week label */
.wk-cell { font-weight:700; font-size:9pt; background:#eee; width:28pt; }

/* type */
.type-cell { font-size:8pt; font-weight:600; color:#444; background:#f5f5f5; width:22pt; }

/* date cells */
.date-cell { font-weight:800; font-size:12pt; background:#f9f9f9; height:${dateRowH}pt; }
.date-cell.sat { color:#1d4ed8; }
.date-cell.empty-date { background:#f0f0f0; }
.hlabel { font-size:7pt; font-weight:400; color:#666; display:block; }

/* meal cells */
.meal-cell { height:${mealRowH}pt; font-size:18pt; font-weight:900; }
.dot { display:inline-block; }

/* closed */
.closed-cell { background:#e8e8e8; position:relative; height:${mealRowH}pt; }
.diag { position:absolute; inset:0;
  background:linear-gradient(to bottom right,transparent calc(50% - 0.6px),#888 calc(50% - 0.6px),#888 calc(50% + 0.6px),transparent calc(50% + 0.6px)); }

/* week bottom border thicker */
.week-last td { border-bottom:2px solid #444; }

/* notice */
.notice { margin-top:8pt; border:1px solid #888; border-radius:4pt; padding:8pt 12pt; background:#fafafa; }
.notice h2 { font-size:10pt; font-weight:700; margin-bottom:5pt; }
.notice ol { margin:0; padding-left:16pt; }
.notice li { font-size:10pt; line-height:2; color:#111; }

/* bottom grid */
.bottom { margin-top:8pt; display:grid; grid-template-columns:1fr 1fr; gap:8pt; }
.price-box { border:1px solid #888; border-radius:4pt; overflow:hidden; }
.price-box table th { font-size:9pt; background:#ddd; height:18pt; }
.price-box table td { font-size:10pt; height:18pt; border-color:#bbb; }
.student-box { border:1px solid #888; border-radius:4pt; padding:8pt 12pt; }
.student-box table { width:100%; }
.student-box td { border:none; padding:4pt 0; font-size:10pt; }
.student-box .key { color:#666; font-size:9pt; text-align:left; width:50pt; }
.student-box .val { font-weight:800; font-size:11pt; text-align:right; }
.floor-opt { display:inline-flex; align-items:center; gap:3pt; margin-right:8pt; font-size:11pt; font-weight:800; }
.floor-circle { display:inline-block; width:9pt; height:9pt; border-radius:50%; border:1.5pt solid #333; vertical-align:middle; }
.floor-circle.filled { background:#333; }
</style></head>
<body>
<h1>${year}년 ${month}월 도시락 신청서</h1>

<table>
  <colgroup>
    <col class="col-wk">
    <col class="col-typ">
    <col class="col-day"><col class="col-day"><col class="col-day">
    <col class="col-day"><col class="col-day"><col class="col-day">
  </colgroup>
  <thead>
    <tr>
      <th>주차</th><th>구분</th>
      <th>월</th><th>화</th><th>수</th><th>목</th><th>금</th><th class="sat">토</th>
    </tr>
  </thead>
  <tbody>${weekRows}</tbody>
</table>

<div class="notice">
  <h2>주의사항</h2>
  <ol>${noticeHtml}</ol>
</div>

<div class="bottom">
  <div class="price-box">
    <table>
      <tr><th>구분</th><th>메뉴</th><th>가격</th></tr>
      <tr><td>중식</td><td>${m.lunch_label}</td><td>${m.lunch_price.toLocaleString()}원</td></tr>
      <tr><td>석식</td><td>${m.dinner_label}</td><td>${m.dinner_price.toLocaleString()}원</td></tr>
    </table>
  </div>
  <div class="student-box">
    <table>
      <tr><td class="key">이름</td><td class="val">${name || '________________'}</td></tr>
      <tr><td class="key">좌석 번호</td><td class="val">${seat || '________________'}</td></tr>
      <tr><td class="key">층</td><td class="val">
        <span class="floor-opt"><span class="floor-circle ${floor === 4 ? 'filled' : ''}"></span>4층</span>
        <span class="floor-opt"><span class="floor-circle ${floor === 5 ? 'filled' : ''}"></span>5층</span>
      </td></tr>
    </table>
  </div>
</div>
</body></html>`
}
