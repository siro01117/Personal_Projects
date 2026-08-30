// 데모용 데이터 어댑터 — 원본 도시락앱(src/main/db.ts, src/main/holidays.ts)의 로직을 그대로 옮기되
// fs 대신 localStorage(JSON persist)를 쓴다. src/preload/index.ts 의 window.api 11개 함수와
// 완전히 동일한 시그니처·반환 형태(Promise)로 구현해 installDemoApi() 에서 window.api 에 할당한다.
// 원본 렌더러 코드(App.tsx, pages/*, components/*)는 이 어댑터가 무엇으로 구현됐는지 전혀 모른다
// (window.api 만 호출) — 그래서 렌더러 쪽은 단 한 줄도 바꾸지 않고 그대로 이식할 수 있었다.

import type { Application, ClosureInfo, Meal, Month } from './types'

const STORAGE_KEY = 'sc:dosirak-demo'

// ─── 원본 src/main/db.ts 그대로 ─────────────────────────────────────────────
const DEFAULT_NOTICE = `1. 도시락은 완전 신청제로 운영되며 당일 신청은 불가합니다.
2. 결제는 선불입니다.
3. 신청한 도시락을 먹지 않았더라도 환불이 되지 않습니다.
4. 도시락 취소는 일주일 전 까지 가능합니다.
5. 결제는 카운터에 문의 해주세요.`

interface Store {
  months: Month[]
  closures: Record<number, Record<string, ClosureInfo>>
  applications: Application[]
  nextMonthId: number
  nextAppId: number
}

function emptyStore(): Store {
  return { months: [], closures: {}, applications: [], nextMonthId: 1, nextAppId: 1 }
}

let store: Store | null = null

function persist() {
  if (!store) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // localStorage 사용 불가(프라이빗 모드 등) — 데모니까 조용히 무시
  }
}

function ensureStore(): Store {
  if (store) return store
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      store = JSON.parse(raw)
      return store!
    }
  } catch {
    // 파싱 실패 — 새로 시딩
  }
  store = emptyStore()
  seedDemoData(store)
  persist()
  return store
}

// ─── 원본 src/main/db.ts 함수 그대로 (fs.writeFileSync → persist()) ─────────
function getOrCreateMonth(year: number, month: number): Month {
  const s = ensureStore()
  let m = s.months.find((x) => x.year === year && x.month === month)
  if (!m) {
    m = { id: s.nextMonthId++, year, month, lunch_label: '스피드런치', lunch_price: 7500, dinner_label: '한솥', dinner_price: 7000, notice: DEFAULT_NOTICE }
    s.months.push(m)
    persist()
  }
  return m
}

function updateMonth(id: number, fields: Partial<Month>) {
  const s = ensureStore()
  const m = s.months.find((x) => x.id === id)
  if (!m) return
  Object.assign(m, fields)
  persist()
}

function listClosures(monthId: number): Record<string, ClosureInfo> {
  const s = ensureStore()
  return s.closures[monthId] || {}
}

function setClosure(monthId: number, date: string, lunchClosed: boolean, dinnerClosed: boolean, label: string) {
  const s = ensureStore()
  if (!s.closures[monthId]) s.closures[monthId] = {}
  s.closures[monthId][date] = { lunch_closed: lunchClosed, dinner_closed: dinnerClosed, label }
  persist()
}

function listApplications(monthId: number): Application[] {
  const s = ensureStore()
  return s.applications
    .filter((a) => a.month_id === monthId)
    .slice()
    .sort((a, b) => {
      if ((a.floor || 0) !== (b.floor || 0)) return (a.floor || 0) - (b.floor || 0)
      return a.name.localeCompare(b.name)
    })
}

function getApplication(id: number): Application | null {
  const s = ensureStore()
  return s.applications.find((a) => a.id === id) || null
}

function upsertApplication(payload: {
  id?: number | null; monthId: number; name: string; seat: string; floor: number
  paid: boolean; paidAmount: number; paidDate: string; memo: string
  meals: Meal[]
}): number {
  const s = ensureStore()
  const meals = payload.meals.map((m) => ({ date: m.date, meal_type: m.meal_type as 'lunch' | 'dinner' }))
  let id = payload.id
  if (id) {
    const a = s.applications.find((x) => x.id === id)
    if (!a) throw new Error('not found')
    a.name = payload.name; a.seat = payload.seat; a.floor = payload.floor
    a.paid = payload.paid ? 1 : 0; a.paid_amount = payload.paidAmount
    a.paid_date = payload.paidDate; a.memo = payload.memo; a.meals = meals
  } else {
    id = s.nextAppId++
    s.applications.push({ id, month_id: payload.monthId, name: payload.name, seat: payload.seat, floor: payload.floor, paid: payload.paid ? 1 : 0, paid_amount: payload.paidAmount, paid_date: payload.paidDate, memo: payload.memo, meals })
  }
  persist()
  return id!
}

function deleteApplication(id: number) {
  const s = ensureStore()
  s.applications = s.applications.filter((a) => a.id !== id)
  persist()
}

function todayOrders() {
  const s = ensureStore()
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const byFloor: Record<string, { lunch: number; dinner: number }> = {}
  let lunchTotal = 0, dinnerTotal = 0
  for (const a of s.applications) {
    for (const m of a.meals) {
      if (m.date !== iso) continue
      const f = String(a.floor ?? 0)
      if (!byFloor[f]) byFloor[f] = { lunch: 0, dinner: 0 }
      if (m.meal_type === 'lunch') { byFloor[f].lunch++; lunchTotal++ }
      else { byFloor[f].dinner++; dinnerTotal++ }
    }
  }
  return { today: iso, byFloor, lunchTotal, dinnerTotal }
}

// ─── 원본 src/main/holidays.ts 그대로 ───────────────────────────────────────
const HOLIDAYS: Record<string, string> = {
  // 2024
  '2024-01-01': '신정', '2024-02-09': '설날 연휴', '2024-02-10': '설날',
  '2024-02-11': '설날 연휴', '2024-02-12': '대체공휴일', '2024-03-01': '삼일절',
  '2024-04-10': '국회의원선거', '2024-05-05': '어린이날', '2024-05-06': '대체공휴일',
  '2024-05-15': '부처님오신날', '2024-06-06': '현충일', '2024-08-15': '광복절',
  '2024-09-16': '추석 연휴', '2024-09-17': '추석', '2024-09-18': '추석 연휴',
  '2024-10-03': '개천절', '2024-10-09': '한글날', '2024-12-25': '성탄절',
  // 2025
  '2025-01-01': '신정', '2025-01-28': '설날 연휴', '2025-01-29': '설날',
  '2025-01-30': '설날 연휴', '2025-03-01': '삼일절', '2025-03-03': '대체공휴일',
  '2025-05-05': '어린이날 / 부처님오신날', '2025-05-06': '대체공휴일',
  '2025-06-06': '현충일', '2025-08-15': '광복절', '2025-10-03': '개천절',
  '2025-10-05': '추석 연휴', '2025-10-06': '추석', '2025-10-07': '추석 연휴',
  '2025-10-08': '대체공휴일', '2025-10-09': '한글날', '2025-12-25': '성탄절',
  // 2026
  '2026-01-01': '신정', '2026-02-16': '설날 연휴', '2026-02-17': '설날',
  '2026-02-18': '설날 연휴', '2026-03-01': '삼일절', '2026-03-02': '대체공휴일',
  '2026-05-05': '어린이날', '2026-05-24': '부처님오신날', '2026-05-25': '대체공휴일',
  '2026-06-06': '현충일', '2026-08-15': '광복절', '2026-08-17': '대체공휴일',
  '2026-09-24': '추석 연휴', '2026-09-25': '추석', '2026-09-26': '추석 연휴',
  '2026-10-03': '개천절', '2026-10-05': '대체공휴일', '2026-10-09': '한글날',
  '2026-12-25': '성탄절',
  // 2027
  '2027-01-01': '신정', '2027-02-06': '설날 연휴', '2027-02-07': '설날',
  '2027-02-08': '설날 연휴', '2027-02-09': '대체공휴일', '2027-03-01': '삼일절',
  '2027-05-05': '어린이날', '2027-05-13': '부처님오신날', '2027-06-06': '현충일',
  '2027-06-07': '대체공휴일', '2027-08-15': '광복절', '2027-08-16': '대체공휴일',
  '2027-09-14': '추석 연휴', '2027-09-15': '추석', '2027-09-16': '추석 연휴',
  '2027-10-03': '개천절', '2027-10-04': '대체공휴일', '2027-10-09': '한글날',
  '2027-10-11': '대체공휴일', '2027-12-25': '성탄절'
}

function holidayLabel(iso: string): string | null {
  return HOLIDAYS[iso] ?? null
}

// ─── PDF export — Electron(printToPDF+dialog) 대신 브라우저 새 창 print() ───
function exportPdfBrowser(html: string, defaultName: string): string | null {
  const win = window.open('', '_blank')
  if (!win) return null
  win.document.open()
  win.document.write(html)
  win.document.close()
  win.document.title = defaultName
  const doPrint = () => { try { win.focus(); win.print() } catch { /* noop */ } }
  if (win.document.readyState === 'complete') setTimeout(doPrint, 250)
  else win.addEventListener('load', () => setTimeout(doPrint, 250))
  return defaultName
}

// ─── 더미 시드 ──────────────────────────────────────────────────────────────
function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** 월 안에서 지정한 day 근처의 평일(월~금)로 보정한다 (주말이면 다음 평일로 민다). */
function nearestWeekday(year: number, month: number, day: number): Date {
  const dim = new Date(year, month, 0).getDate()
  let d = Math.min(Math.max(day, 1), dim)
  let date = new Date(year, month - 1, d)
  while (date.getDay() === 0 || date.getDay() === 6) {
    d = d + 1 > dim ? d - 1 : d + 1
    date = new Date(year, month - 1, d)
  }
  return date
}

function seedDemoData(s: Store) {
  const today = new Date()
  const year = today.getFullYear()
  const month = today.getMonth() + 1

  // 월 설정 (getOrCreateMonth 로직 그대로 — 스피드런치 7500 / 한솥 7000 / 기본 안내문)
  const monthRow: Month = {
    id: s.nextMonthId++, year, month,
    lunch_label: '스피드런치', lunch_price: 7500,
    dinner_label: '한솥', dinner_price: 7000,
    notice: DEFAULT_NOTICE
  }
  s.months.push(monthRow)

  // 휴무 2건: 하루 전체휴무("학원 행사"), 하루 석식휴무
  const closeBothDate = nearestWeekday(year, month, 10)
  const closeDinnerDate = nearestWeekday(year, month, 20)
  const closeBothIso = isoOf(closeBothDate.getFullYear(), closeBothDate.getMonth() + 1, closeBothDate.getDate())
  const closeDinnerIso = isoOf(closeDinnerDate.getFullYear(), closeDinnerDate.getMonth() + 1, closeDinnerDate.getDate())
  s.closures[monthRow.id] = {
    [closeBothIso]: { lunch_closed: true, dinner_closed: true, label: '학원 행사' },
    [closeDinnerIso]: { lunch_closed: false, dinner_closed: true, label: '' }
  }

  // 평일(월~금) 날짜 목록
  const dim = new Date(year, month, 0).getDate()
  const weekdays: Date[] = []
  for (let d = 1; d <= dim; d++) {
    const date = new Date(year, month - 1, d)
    if (date.getDay() !== 0 && date.getDay() !== 6) weekdays.push(date)
  }

  const isClosed = (iso: string, type: 'lunch' | 'dinner'): boolean => {
    if (iso === closeBothIso) return true
    if (iso === closeDinnerIso && type === 'dinner') return true
    return false
  }

  // 학생 8명 — 이름 / 좌석 / 층(2~4 섞음) / 납입 상태 / 메모
  const students: { name: string; seat: string; floor: number; mealCount: number; paid: 'full' | 'none'; memo?: string }[] = [
    { name: '김민준', seat: 'A-01', floor: 4, mealCount: 22, paid: 'full' },
    { name: '이서연', seat: 'A-02', floor: 4, mealCount: 18, paid: 'full' },
    { name: '박도윤', seat: 'B-05', floor: 3, mealCount: 25, paid: 'none' },
    { name: '최지우', seat: 'B-06', floor: 3, mealCount: 15, paid: 'full', memo: '알레르기(새우) 있음' },
    { name: '정하은', seat: 'C-11', floor: 2, mealCount: 20, paid: 'none' },
    { name: '강시우', seat: 'C-12', floor: 2, mealCount: 12, paid: 'full' },
    { name: '조수아', seat: 'A-08', floor: 4, mealCount: 10, paid: 'none', memo: '환불 예정' },
    { name: '윤예준', seat: 'B-09', floor: 3, mealCount: 24, paid: 'full' }
  ]

  // 시드마다 결과가 달라지지 않도록 간단한 LCG로 의사난수 생성
  let seed = 42
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed % 10000) / 10000
  }
  const shuffled = <T,>(arr: T[]): T[] => {
    const a = arr.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }

  for (const st of students) {
    const pool = shuffled(weekdays)
    const meals: Meal[] = []
    for (const date of pool) {
      if (meals.length >= st.mealCount) break
      const iso = isoOf(date.getFullYear(), date.getMonth() + 1, date.getDate())
      const wantBoth = rand() < 0.45
      const lunchOk = !isClosed(iso, 'lunch')
      const dinnerOk = !isClosed(iso, 'dinner')
      if (wantBoth && lunchOk && dinnerOk) {
        meals.push({ date: iso, meal_type: 'lunch' })
        meals.push({ date: iso, meal_type: 'dinner' })
      } else if (lunchOk && (rand() < 0.5 || !dinnerOk)) {
        meals.push({ date: iso, meal_type: 'lunch' })
      } else if (dinnerOk) {
        meals.push({ date: iso, meal_type: 'dinner' })
      }
    }
    meals.length = Math.min(meals.length, st.mealCount)

    const lunchCnt = meals.filter((m) => m.meal_type === 'lunch').length
    const dinnerCnt = meals.filter((m) => m.meal_type === 'dinner').length
    const total = lunchCnt * monthRow.lunch_price + dinnerCnt * monthRow.dinner_price
    const paidAmount = st.paid === 'full' ? total : 0
    const paidDate = st.paid === 'full' ? isoOf(year, month, Math.max(1, Math.min(dim, 5))) : ''

    s.applications.push({
      id: s.nextAppId++,
      month_id: monthRow.id,
      name: st.name,
      seat: st.seat,
      floor: st.floor,
      paid: st.paid === 'full' && total > 0 ? 1 : 0,
      paid_amount: paidAmount,
      paid_date: paidDate || null,
      memo: st.memo ?? '',
      meals
    })
  }
}

// ─── window.api 설치 ────────────────────────────────────────────────────────
export function installDemoApi() {
  ensureStore()

  window.api = {
    getMonth: async (y: number, m: number) => getOrCreateMonth(y, m),
    updateMonth: async (id: number, fields: Partial<Month>) => { updateMonth(id, fields) },
    listClosures: async (monthId: number) => listClosures(monthId),
    setClosure: async (monthId: number, date: string, lunchClosed: boolean, dinnerClosed: boolean, label: string) => {
      setClosure(monthId, date, lunchClosed, dinnerClosed, label)
    },
    holidayLabel: async (iso: string) => holidayLabel(iso),

    listApps: async (monthId: number) => listApplications(monthId),
    getApp: async (id: number) => getApplication(id),
    upsertApp: async (payload: any) => upsertApplication(payload),
    deleteApp: async (id: number) => { deleteApplication(id) },

    todayOrders: async () => todayOrders(),
    exportPdf: async (html: string, defaultName: string) => exportPdfBrowser(html, defaultName)
  }
}
