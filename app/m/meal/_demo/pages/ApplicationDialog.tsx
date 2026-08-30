import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Modal } from '../components/Modal'
import { PillButton, spring } from '../components/Motion'
import { motion } from 'framer-motion'
import type { ClosureInfo, Month } from '../types'
import { monthGrid, isoDate, effectiveClosure } from '../lib/calendar'

const DAYS = ['월', '화', '수', '목', '금', '토']

interface Props {
  open: boolean; appId: number | null; year: number; month: number
  monthRow: Month; onClose: () => void; onSaved: () => void
}

export function ApplicationDialog({ open, appId, year, month, monthRow, onClose, onSaved }: Props) {
  const [name, setName] = useState('')
  const [seat, setSeat] = useState('')
  const [floor, setFloor] = useState<4 | 5>(4)
  const [paidAmount, setPaidAmount] = useState(0)
  const [paidDate, setPaidDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [memo, setMemo] = useState('')
  const [closures, setClosures] = useState<Record<string, ClosureInfo>>({})
  const [holidays, setHolidays] = useState<Record<string, string>>({})
  const [meals, setMeals] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    ;(async () => {
      const cls = await window.api.listClosures(monthRow.id)
      setClosures(cls)
      const grid = monthGrid(year, month)
      const hh: Record<string, string> = {}
      for (const row of grid) for (const d of row) {
        if (!d) continue
        const iso = isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
        const lbl = await window.api.holidayLabel(iso)
        if (lbl) hh[iso] = lbl
      }
      setHolidays(hh)
      if (appId) {
        const a = await window.api.getApp(appId)
        if (a) {
          setName(a.name); setSeat(a.seat || '')
          setFloor((a.floor === 5 ? 5 : 4) as 4 | 5)
          setPaidAmount(a.paid_amount || 0)
          setPaidDate(a.paid_date || new Date().toISOString().slice(0, 10))
          setMemo(a.memo || '')
          setMeals(new Set(a.meals.map((m) => `${m.date}|${m.meal_type}`)))
        }
      } else {
        setName(''); setSeat(''); setFloor(4); setPaidAmount(0)
        setPaidDate(new Date().toISOString().slice(0, 10)); setMemo(''); setMeals(new Set())
      }
    })()
  }, [open, appId, year, month, monthRow.id])

  const toggle = (iso: string, type: 'lunch' | 'dinner') => {
    const key = `${iso}|${type}`
    const next = new Set(meals)
    if (next.has(key)) next.delete(key); else next.add(key)
    setMeals(next)
  }

  const { lunch, dinner, total, remaining } = (() => {
    let l = 0, d = 0
    for (const k of meals) { if (k.endsWith('|lunch')) l++; else d++ }
    const t = l * monthRow.lunch_price + d * monthRow.dinner_price
    return { lunch: l, dinner: d, total: t, remaining: t - paidAmount }
  })()

  const save = async () => {
    if (!name.trim()) { alert('이름을 입력해주세요.'); return }
    await window.api.upsertApp({
      id: appId ?? null, monthId: monthRow.id, name: name.trim(), seat: seat.trim(),
      floor, paid: paidAmount >= total, paidAmount, paidDate, memo,
      meals: Array.from(meals).map((k) => { const [date, meal_type] = k.split('|'); return { date, meal_type } })
    })
    onSaved()
  }

  const grid = monthGrid(year, month)

  return (
    <Modal open={open} onClose={onClose} title={appId ? '신청서 수정' : '신청서 추가'} width="max-w-5xl"
      footer={<>
        <PillButton variant="ghost" onClick={onClose}>취소</PillButton>
        <PillButton variant="primary" onClick={save}>저장</PillButton>
      </>}
    >
      <div className="grid grid-cols-[240px_1fr] gap-4 pb-1">
        {/* Left */}
        <div className="flex flex-col gap-3">
          <Sec title="학생 정보">
            <Fld label="이름"><input className={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="홍길동" /></Fld>
            <Fld label="좌석 번호"><input className={inp} value={seat} onChange={(e) => setSeat(e.target.value)} placeholder="A-12" /></Fld>
            <Fld label="층수">
              <div className="flex gap-2">
                {([4, 5] as const).map((f) => (
                  <motion.button key={f} whileTap={{ scale: 0.93 }} transition={spring} onClick={() => setFloor(f)}
                    className={clsx('flex-1 h-8 rounded-full text-[13px] font-semibold transition-colors',
                      floor === f ? 'bg-ink-900 text-white' : 'bg-surface text-ink-700 hover:bg-ink-100 border border-ink-200')}>{f}층</motion.button>
                ))}
              </div>
            </Fld>
          </Sec>

          <Sec title="납입">
            <Fld label="납입 금액">
              <div className="relative">
                <input type="number" value={paidAmount} onChange={(e) => setPaidAmount(parseInt(e.target.value || '0'))}
                  className={clsx(inp, 'pr-8')} step={500} />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-400 text-[11px]">원</span>
              </div>
            </Fld>
            <Fld label="납입 날짜">
              <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} className={inp} />
            </Fld>
            <Fld label="메모">
              <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="(선택)" className={inp} />
            </Fld>
          </Sec>

          {/* Totals */}
          <div className="rounded-xl border border-ink-200 p-3 text-[12px] space-y-1.5">
            <Row k="중식" v={`${lunch}개 × ${monthRow.lunch_price.toLocaleString()}원`} />
            <Row k="석식" v={`${dinner}개 × ${monthRow.dinner_price.toLocaleString()}원`} />
            <div className="border-t border-ink-100 pt-1.5">
              <Row k="총액" v={`${total.toLocaleString()}원`} bold />
              <Row k="잔액" v={`${remaining.toLocaleString()}원`} bold color={remaining > 0 ? 'text-red-500' : 'text-ink-500'} />
            </div>
          </div>
        </div>

        {/* Right: Excel-style meal grid */}
        <div className="border border-ink-300 rounded-xl overflow-hidden text-[12px] self-start">
          {/* header row */}
          <div className="grid grid-cols-[50px_36px_repeat(6,1fr)] bg-ink-50 border-b border-ink-300">
            <div className="px-2 py-2 font-semibold text-ink-600 border-r border-ink-300 text-center text-[11px]">주차</div>
            <div className="px-1 py-2 font-semibold text-ink-600 border-r border-ink-300 text-center text-[11px]">구분</div>
            {DAYS.map((d, i) => (
              <div key={d} className={clsx('px-1 py-2 text-center font-semibold border-r border-ink-300 last:border-0 text-[11px]',
                i === 5 ? 'text-blue-500' : 'text-ink-700')}>{d}</div>
            ))}
          </div>

          {/* weeks */}
          {grid.map((week, wi) => {
            if (week.every((d) => !d)) return null
            return (
              <div key={wi} className="grid grid-cols-[50px_36px_repeat(6,1fr)] border-t border-ink-200">
                {/* week label */}
                <div className="border-r border-ink-200 flex flex-col">
                  <div className="bg-ink-50 text-center text-[10px] font-bold text-ink-500 py-1 border-b border-ink-200">{wi + 1}주</div>
                  <div className="flex-1 flex items-center justify-center text-[10px] text-ink-500 border-b border-ink-100">중</div>
                  <div className="flex-1 flex items-center justify-center text-[10px] text-ink-500">석</div>
                </div>

                {/* 구분 */}
                <div className="border-r border-ink-200 flex flex-col">
                  <div className="bg-ink-50 py-1 border-b border-ink-200 h-[26px]" />
                  <div className="flex-1 flex items-center justify-center text-[9px] text-ink-400 border-b border-ink-100">중식</div>
                  <div className="flex-1 flex items-center justify-center text-[9px] text-ink-400">석식</div>
                </div>

                {week.slice(0, 6).map((d, di) => {
                  if (!d) return (
                    <div key={di} className="border-r border-ink-200 last:border-0 flex flex-col">
                      <div className="bg-ink-50 h-[26px] border-b border-ink-200" />
                      <div className="flex-1 bg-ink-50 border-b border-ink-100" />
                      <div className="flex-1 bg-ink-50" />
                    </div>
                  )
                  const eff = effectiveClosure(d, closures, holidays)
                  const lClosed = eff?.lunch_closed ?? false
                  const dClosed = eff?.dinner_closed ?? false
                  const iso = isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
                  const lOn = meals.has(`${iso}|lunch`)
                  const dOn = meals.has(`${iso}|dinner`)

                  return (
                    <div key={di} className="border-r border-ink-200 last:border-0 flex flex-col min-h-[88px]">
                      {/* date */}
                      <div className="bg-ink-50 text-center font-bold text-[12px] py-1 border-b border-ink-200 h-[26px] flex items-center justify-center">
                        {d.getDate()}
                      </div>
                      {/* lunch */}
                      <div
                        className={clsx('flex-1 flex items-center justify-center border-b border-ink-100 relative',
                          !lClosed && 'cursor-pointer hover:bg-ink-50')}
                        onClick={() => !lClosed && toggle(iso, 'lunch')}
                      >
                        {lClosed ? <Diag /> : lOn ? <span className="block w-4 h-4 rounded-full border-[2.5px] border-ink-900" /> : null}
                      </div>
                      {/* dinner */}
                      <div
                        className={clsx('flex-1 flex items-center justify-center relative',
                          !dClosed && 'cursor-pointer hover:bg-ink-50')}
                        onClick={() => !dClosed && toggle(iso, 'dinner')}
                      >
                        {dClosed ? <Diag /> : dOn ? <span className="block w-4 h-4 rounded-full border-[2.5px] border-ink-900" /> : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}

          {/* legend */}
          <div className="border-t border-ink-200 bg-ink-50 px-3 py-2 flex gap-4 text-[10px] text-ink-500">
            <span className="flex items-center gap-1.5"><span className="text-[12px] text-ink-900">●</span> 신청 (클릭 토글)</span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-3 inline-block relative border border-ink-300 rounded-sm overflow-hidden">
                <Diag />
              </span> 휴무
            </span>
          </div>
        </div>
      </div>
    </Modal>
  )
}

const inp = 'w-full bg-surface rounded-lg h-8 px-3 text-[13px] border border-ink-200 outline-none focus:border-ink-500'

function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card-sm p-3">
      <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-ink-400 mb-2.5">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] text-ink-500 mb-1">{label}</div>
      {children}
    </label>
  )
}

function Row({ k, v, bold, color }: { k: string; v: string; bold?: boolean; color?: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-ink-500">{k}</span>
      <span className={clsx(bold && 'font-semibold', color)}>{v}</span>
    </div>
  )
}

function Diag() {
  return (
    <div className="absolute inset-0 pointer-events-none"
      style={{
        backgroundImage: 'repeating-linear-gradient(-45deg, transparent 0px, transparent 9px, #bbb 9px, #bbb 10.5px)',
        backgroundAttachment: 'fixed',
      }} />
  )
}
