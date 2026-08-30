import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, FileText, Pencil, Trash2, CheckCircle2, Circle, Search, X, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { PillButton, spring } from '../components/Motion'
import { useDialog } from '../components/Dialog'
import { ApplicationDialog } from './ApplicationDialog'
import type { Application, Month } from '../types'
import { buildMonthPdfHtml } from '../lib/pdfHtml'
import { monthGrid, isoDate } from '../lib/calendar'

type PayFilter = 'all' | 'unpaid' | 'paid'

export function Students({ year: initYear, month: initMonth, onChange }: { year: number; month: number; onChange: () => void }) {
  const { toast, confirm } = useDialog()
  const [year, setYear] = useState(initYear)
  const [month, setMonth] = useState(initMonth)
  const [m, setM] = useState<Month | null>(null)
  const [apps, setApps] = useState<Application[]>([])
  const [editId, setEditId] = useState<number | null | undefined>(undefined)
  const [filter, setFilter] = useState('')
  const [payFilter, setPayFilter] = useState<PayFilter>('all')
  const [payPopup, setPayPopup] = useState<{ id: number; anchor: DOMRect } | null>(null)
  const [showMonthPicker, setShowMonthPicker] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  // sync with sidebar changes
  useEffect(() => { setYear(initYear); setMonth(initMonth) }, [initYear, initMonth])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setShowMonthPicker(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const load = async () => {
    const monthRow = await window.api.getMonth(year, month)
    setM(monthRow)
    setApps(await window.api.listApps(monthRow.id))
  }
  useEffect(() => { load() }, [year, month])
  if (!m) return null

  const onSaved = async () => { setEditId(undefined); await load(); onChange() }

  const onDelete = async (id: number) => {
    const ok = await confirm({ title: '신청서 삭제', message: '정말로 삭제할까요? 이 작업은 되돌릴 수 없습니다.', confirmLabel: '삭제', danger: true })
    if (!ok) return
    await window.api.deleteApp(id); await load(); onChange()
    toast('삭제되었습니다.')
  }

  const exportApp = async (a: Application) => {
    const closures = await window.api.listClosures(m.id)
    const grid = monthGrid(year, month)
    const holidays: Record<string, string> = {}
    for (const row of grid) for (const d of row) {
      if (!d) continue
      const iso = isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
      const lbl = await window.api.holidayLabel(iso)
      if (lbl) holidays[iso] = lbl
    }
    await window.api.exportPdf(buildMonthPdfHtml({ year, month, m, closures, holidays, application: a }),
      `${year}년 ${month}월 ${a.name}.pdf`)
  }

  const getStats = (a: Application) => {
    const lunch = a.meals.filter((mm) => mm.meal_type === 'lunch').length
    const dinner = a.meals.filter((mm) => mm.meal_type === 'dinner').length
    const total = lunch * m.lunch_price + dinner * m.dinner_price
    const remaining = total - (a.paid_amount || 0)
    return { lunch, dinner, total, remaining }
  }

  const allFiltered = apps.filter((a) => {
    const s = getStats(a)
    const textMatch = !filter || a.name.toLowerCase().includes(filter.toLowerCase()) || (a.seat || '').toLowerCase().includes(filter.toLowerCase())
    const payMatch = payFilter === 'all' ? true : payFilter === 'unpaid' ? s.remaining > 0 : s.remaining <= 0
    return textMatch && payMatch
  })

  const unpaidCount = apps.filter((a) => getStats(a).remaining > 0).length

  return (
    <div className="h-full overflow-auto" onClick={() => setPayPopup(null)}>
      <div className="flex items-end justify-between mb-5">
        <div className="relative" ref={pickerRef}>
          <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-ink-400">Students</div>
          <button onClick={() => setShowMonthPicker(!showMonthPicker)} className="flex items-center gap-1.5 mt-0.5 group">
            <h1 className="text-[38px] leading-tight font-semibold tracking-tight group-hover:text-ink-600 transition-colors">
              {year}년 {month}월
            </h1>
            <ChevronDown size={20} className="text-ink-400 mb-0.5 transition-transform" style={{ transform: showMonthPicker ? 'rotate(180deg)' : '' }} />
          </button>
          <p className="text-ink-500 text-[13px] mt-1">{apps.length}명 신청 · 미납 {unpaidCount}명</p>
          <AnimatePresence>
            {showMonthPicker && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={spring}
                className="absolute z-50 top-full left-0 mt-2 bg-white rounded-2xl shadow-pop border border-ink-200 p-4 flex gap-4"
                onClick={(e) => e.stopPropagation()}>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink-400 mb-2">연도</div>
                  <div className="flex flex-col gap-1">
                    {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 1 + i).map((y) => (
                      <button key={y} onClick={() => { setYear(y); setShowMonthPicker(false) }}
                        className={clsx('w-16 h-8 rounded-full text-[13px] font-medium transition-colors',
                          y === year ? 'bg-ink-900 text-white' : 'hover:bg-surface text-ink-700')}>{y}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink-400 mb-2">월</div>
                  <div className="grid grid-cols-3 gap-1">
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => (
                      <button key={mo} onClick={() => { setMonth(mo); setShowMonthPicker(false) }}
                        className={clsx('w-10 h-8 rounded-full text-[13px] font-medium transition-colors',
                          mo === month ? 'bg-ink-900 text-white' : 'hover:bg-surface text-ink-700')}>{mo}월</button>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex gap-2 items-center">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
            <input placeholder="이름 / 좌석" value={filter} onChange={(e) => setFilter(e.target.value)}
              className="bg-white rounded-full h-9 pl-8 pr-3 w-44 text-[13px] border border-ink-200 outline-none" />
          </div>

          {/* Pay filter */}
          <div className="flex rounded-full border border-ink-200 bg-white overflow-hidden">
            {(['all', 'unpaid', 'paid'] as PayFilter[]).map((f) => (
              <button key={f}
                onClick={() => setPayFilter(f)}
                className={clsx('h-9 px-3.5 text-[12px] font-medium transition-colors',
                  payFilter === f ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-surface')}>
                {f === 'all' ? '전체' : f === 'unpaid' ? `미납 (${unpaidCount})` : '완납'}
              </button>
            ))}
          </div>

          <PillButton variant="primary" icon={<Plus size={15} />} onClick={() => setEditId(null)}>신청서 추가</PillButton>
        </div>
      </div>

      <div className="card p-3">
        <div className="grid grid-cols-[1.6fr_56px_70px_56px_56px_1.2fr_110px_90px] gap-3 px-3 py-2 text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-400">
          <span>이름</span><span className="text-center">층</span><span className="text-center">좌석</span>
          <span className="text-center">중식</span><span className="text-center">석식</span>
          <span className="text-right">총액 / 잔액</span><span>납입 상태</span><span className="text-right">관리</span>
        </div>

        <div className="flex flex-col gap-1.5 mt-1">
          <AnimatePresence initial={false}>
            {allFiltered.length === 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center py-14 text-ink-400 text-[13px]">
                {payFilter === 'unpaid' ? '미납자가 없습니다. 👍' : '신청서를 추가해주세요.'}
              </motion.div>
            )}
            {allFiltered.map((a, i) => {
              const s = getStats(a)
              const fullPaid = s.remaining <= 0 && s.total > 0
              const partial = (a.paid_amount || 0) > 0 && !fullPaid
              return (
                <motion.div key={a.id} layout
                  initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ ...spring, delay: 0.015 * i }}
                  className="grid grid-cols-[1.6fr_56px_70px_56px_56px_1.2fr_110px_90px] gap-3 px-3 py-3 rounded-xl bg-surface items-center hover:bg-ink-50 transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-ink-900 text-white flex items-center justify-center text-[12px] font-bold shrink-0">
                      {a.name.slice(0, 1)}
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-[13px] truncate">{a.name}</div>
                      {a.memo && <div className="text-[11px] text-ink-400 truncate">{a.memo}</div>}
                    </div>
                  </div>
                  <span className="text-center text-[13px]">{a.floor ? `${a.floor}층` : '-'}</span>
                  <span className="text-center text-[13px]">{a.seat || '-'}</span>
                  <span className="text-center tabular-nums font-semibold">{s.lunch}</span>
                  <span className="text-center tabular-nums font-semibold">{s.dinner}</span>
                  <div className="text-right">
                    <div className="tabular-nums font-semibold text-[13px]">{s.total.toLocaleString()}원</div>
                    <div className={clsx('text-[11px] tabular-nums', s.remaining > 0 ? 'text-red-500' : 'text-ink-400')}>
                      잔액 {s.remaining.toLocaleString()}원
                    </div>
                  </div>
                  <div>
                    <motion.button whileTap={{ scale: 0.94 }} transition={spring}
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setPayPopup(payPopup?.id === a.id ? null : { id: a.id, anchor: rect })
                      }}
                      className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer transition-colors',
                        fullPaid ? 'bg-ink-900 text-white hover:bg-ink-700' : partial ? 'bg-ink-200 text-ink-900 hover:bg-ink-300' : 'border border-red-300 text-red-600 bg-red-50 hover:bg-red-100')}
                    >
                      {fullPaid ? <CheckCircle2 size={11} /> : <Circle size={11} />}
                      {fullPaid ? '완납' : partial ? `${(a.paid_amount || 0).toLocaleString()}원` : '미납'}
                    </motion.button>
                    {a.paid_date && <div className="text-[10px] text-ink-400 mt-0.5">{a.paid_date}</div>}
                  </div>
                  <div className="flex justify-end gap-1">
                    <IBtn onClick={() => exportApp(a)} title="PDF"><FileText size={13} /></IBtn>
                    <IBtn onClick={() => setEditId(a.id)} title="수정"><Pencil size={13} /></IBtn>
                    <IBtn onClick={() => onDelete(a.id)} title="삭제" danger><Trash2 size={13} /></IBtn>
                  </div>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      </div>

      {payPopup && (
        <PayPopup
          key={payPopup.id}
          app={apps.find((a) => a.id === payPopup.id)!}
          anchor={payPopup.anchor}
          monthRow={m}
          onClose={() => setPayPopup(null)}
          onSaved={async () => { setPayPopup(null); await load(); onChange(); toast('납입 정보가 저장되었습니다.', 'success') }}
        />
      )}

      <ApplicationDialog
        open={editId !== undefined}
        appId={editId === null ? null : (editId as number | null)}
        year={year} month={month} monthRow={m}
        onClose={() => setEditId(undefined)}
        onSaved={async () => { setEditId(undefined); await load(); onChange(); toast('신청서가 저장되었습니다.', 'success') }}
      />
    </div>
  )
}

function PayPopup({ app, anchor, monthRow, onClose, onSaved }: {
  app: Application; anchor: DOMRect; monthRow: Month; onClose: () => void; onSaved: () => void
}) {
  const [amount, setAmount] = useState(app.paid_amount || 0)
  const [paidDate, setPaidDate] = useState(app.paid_date || new Date().toISOString().slice(0, 10))
  const [memo, setMemo] = useState(app.memo || '')

  const lunch = app.meals.filter((m) => m.meal_type === 'lunch').length
  const dinner = app.meals.filter((m) => m.meal_type === 'dinner').length
  const total = lunch * monthRow.lunch_price + dinner * monthRow.dinner_price
  const remaining = total - amount

  const save = async () => {
    await window.api.upsertApp({
      id: app.id, monthId: app.month_id, name: app.name, seat: app.seat || '',
      floor: app.floor || 0, paid: amount >= total, paidAmount: amount, paidDate, memo, meals: app.meals
    })
    onSaved()
  }

  const top = anchor.bottom + window.scrollY + 6
  const left = Math.min(anchor.left, window.innerWidth - 284 - 12)

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring} style={{ top, left }}
        className="fixed z-50 w-68 bg-white rounded-xl shadow-pop border border-ink-200 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold text-[14px]">{app.name} 납입</div>
          <button onClick={onClose} className="w-6 h-6 rounded-full hover:bg-surface flex items-center justify-center">
            <X size={13} />
          </button>
        </div>
        <div className="bg-surface rounded-lg p-2.5 mb-3 text-[12px] space-y-1 border border-ink-100">
          <div className="flex justify-between">
            <span className="text-ink-500">중식 {lunch} + 석식 {dinner}개</span>
            <span className="font-semibold">{total.toLocaleString()}원</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-500">잔액</span>
            <span className={clsx('font-semibold', remaining > 0 ? 'text-red-500' : 'text-ink-900')}>{remaining.toLocaleString()}원</span>
          </div>
        </div>
        <div className="space-y-2.5">
          <Fld label="납입 금액">
            <div className="relative">
              <input type="number" value={amount} onChange={(e) => setAmount(parseInt(e.target.value || '0'))}
                className="w-full bg-surface rounded-lg h-8 px-3 pr-7 text-[13px] border border-ink-200 outline-none tabular-nums" step={500} />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 text-[11px]">원</span>
            </div>
          </Fld>
          <Fld label="납입 날짜">
            <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)}
              className="w-full bg-surface rounded-lg h-8 px-3 text-[13px] border border-ink-200 outline-none" />
          </Fld>
          <Fld label="메모">
            <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="(선택)"
              className="w-full bg-surface rounded-lg h-8 px-3 text-[13px] border border-ink-200 outline-none" />
          </Fld>
        </div>
        <div className="flex gap-2 mt-3">
          <button onClick={onClose} className="flex-1 h-8 rounded-full text-[12px] font-medium bg-surface border border-ink-200 hover:bg-ink-100 transition-colors">취소</button>
          <motion.button whileTap={{ scale: 0.96 }} transition={spring} onClick={save}
            className="flex-1 h-8 rounded-full bg-ink-900 text-white text-[12px] font-medium hover:bg-ink-800 transition-colors">저장</motion.button>
        </div>
      </motion.div>
    </>
  )
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-ink-400 mb-1">{label}</div>
      {children}
    </div>
  )
}

function IBtn({ children, onClick, title, danger }: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.9 }} transition={spring} title={title} onClick={onClick}
      className={clsx('w-7 h-7 rounded-full flex items-center justify-center transition-colors',
        danger ? 'hover:bg-red-50 text-ink-400 hover:text-red-500' : 'hover:bg-ink-100 text-ink-500')}>
      {children}
    </motion.button>
  )
}
