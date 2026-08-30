import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileText, Save, Plus, X, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { PillButton, spring } from '../components/Motion'
import { useDialog } from '../components/Dialog'
import { monthGrid, isoDate, effectiveClosure } from '../lib/calendar'
import type { ClosureInfo, Month } from '../types'
import { buildMonthPdfHtml } from '../lib/pdfHtml'

const DAYS_KR = ['월', '화', '수', '목', '금', '토', '일']

export function MonthSettings({ year, month, onYearMonthChange, onChange }: {
  year: number; month: number; onYearMonthChange: (y: number, m: number) => void; onChange: () => void
}) {
  const { toast } = useDialog()
  const [m, setM] = useState<Month | null>(null)
  const [closures, setClosures] = useState<Record<string, ClosureInfo>>({})
  const [holidays, setHolidays] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  const [noticeLines, setNoticeLines] = useState<string[]>([])
  const [showPicker, setShowPicker] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setShowPicker(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  useEffect(() => {
    ;(async () => {
      const monthRow = await window.api.getMonth(year, month)
      const cls = await window.api.listClosures(monthRow.id)
      const grid = monthGrid(year, month)
      const hh: Record<string, string> = {}
      for (const row of grid) for (const d of row) {
        if (!d) continue
        const iso = isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
        const lbl = await window.api.holidayLabel(iso)
        if (lbl) hh[iso] = lbl
      }
      setHolidays(hh); setClosures(cls); setM(monthRow)
      const lines = (monthRow.notice || '').split('\n').filter((l) => l.trim())
      setNoticeLines(lines.length ? lines : [''])
      setDirty(false)
    })()
  }, [year, month])

  if (!m) return null

  const update = <K extends keyof Month>(k: K, v: Month[K]) => { setM({ ...m, [k]: v }); setDirty(true) }

  const save = async () => {
    const notice = noticeLines.filter((l) => l.trim()).join('\n')
    await window.api.updateMonth(m.id, { lunch_label: m.lunch_label, lunch_price: m.lunch_price, dinner_label: m.dinner_label, dinner_price: m.dinner_price, notice } as any)
    setDirty(false); toast('설정이 저장되었습니다.', 'success'); onChange()
  }

  const toggleMeal = async (d: Date, type: 'lunch' | 'dinner') => {
    const iso = isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
    const eff = effectiveClosure(d, closures, holidays)
    const lc = eff?.lunch_closed ?? false; const dc = eff?.dinner_closed ?? false
    const newLc = type === 'lunch' ? !lc : lc
    const newDc = type === 'dinner' ? !dc : dc
    await window.api.setClosure(m.id, iso, newLc, newDc, eff?.label ?? '')
    setClosures({ ...closures, [iso]: { lunch_closed: newLc, dinner_closed: newDc, label: eff?.label ?? '' } })
  }

  const exportPdf = async () => {
    if (dirty) await save()
    const notice = noticeLines.filter((l) => l.trim()).join('\n')
    await window.api.exportPdf(buildMonthPdfHtml({ year, month, m: { ...m, notice }, closures, holidays, application: null }),
      `${year}년 ${month}월 도시락 신청서.pdf`)
  }

  const grid = monthGrid(year, month)

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-end justify-between mb-5">
        <div className="relative" ref={pickerRef}>
          <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-ink-400">신청서 제작</div>
          <button onClick={() => setShowPicker(!showPicker)} className="flex items-center gap-1.5 mt-0.5 group">
            <h1 className="text-[38px] leading-tight font-semibold tracking-tight group-hover:text-ink-600 transition-colors">
              {year}년 {month}월
            </h1>
            <ChevronDown size={20} className="text-ink-400 mb-0.5 transition-transform" style={{ transform: showPicker ? 'rotate(180deg)' : '' }} />
          </button>
          <AnimatePresence>
            {showPicker && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={spring}
                className="absolute z-50 top-full left-0 mt-2 bg-white rounded-2xl shadow-pop border border-ink-200 p-4 flex gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink-400 mb-2">연도</div>
                  <div className="flex flex-col gap-1">
                    {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 1 + i).map((y) => (
                      <button key={y} onClick={() => { onYearMonthChange(y, month); setShowPicker(false) }}
                        className={clsx('w-16 h-8 rounded-full text-[13px] font-medium transition-colors',
                          y === year ? 'bg-ink-900 text-white' : 'hover:bg-surface text-ink-700')}>{y}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink-400 mb-2">월</div>
                  <div className="grid grid-cols-3 gap-1">
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => (
                      <button key={mo} onClick={() => { onYearMonthChange(year, mo); setShowPicker(false) }}
                        className={clsx('w-10 h-8 rounded-full text-[13px] font-medium transition-colors',
                          mo === month ? 'bg-ink-900 text-white' : 'hover:bg-surface text-ink-700')}>{mo}월</button>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex gap-2">
          <PillButton variant={dirty ? 'primary' : 'secondary'} icon={<Save size={15} />} onClick={save}>
            {dirty ? '변경사항 저장' : '저장'}
          </PillButton>
          <PillButton variant="primary" icon={<FileText size={15} />} onClick={exportPdf}>빈 신청서 PDF</PillButton>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_330px] gap-4">
        {/* Calendar */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[15px] font-semibold">휴무일 설정</h2>
            <div className="flex gap-3 text-[11px] text-ink-500">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-white border border-ink-300 inline-block" />영업</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-ink-400 inline-block" />일부휴무</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-ink-900 inline-block" />전체휴무</span>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1.5 mb-1.5">
            {DAYS_KR.map((d, i) => (
              <div key={d} className={clsx('text-center text-[11px] font-semibold py-1',
                i === 6 ? 'text-red-400' : i === 5 ? 'text-blue-500' : 'text-ink-500')}>{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {grid.flat().map((d, i) => {
              if (!d) return <div key={i} style={{ height: 80 }} />
              const eff = effectiveClosure(d, closures, holidays)
              const lc = eff?.lunch_closed ?? false; const dc = eff?.dinner_closed ?? false
              const both = lc && dc; const partial = lc || dc
              const label = eff?.label ?? ''
              const dow = d.getDay(); const isSun = dow === 0

              return (
                <div key={i} style={{ height: 80 }} className={clsx('rounded-xl border relative overflow-hidden flex flex-col',
                  both ? 'bg-ink-900 border-ink-900' : partial ? 'bg-ink-200 border-ink-300' : 'bg-white border-ink-200')}>
                  {both && <div className="absolute inset-0 pointer-events-none"
                    style={{ background: 'linear-gradient(to bottom right,transparent calc(50% - 0.5px),rgba(255,255,255,0.18) calc(50% - 0.5px),rgba(255,255,255,0.18) calc(50% + 0.5px),transparent calc(50% + 0.5px))' }} />}

                  {/* date area — compact */}
                  <button onClick={() => {
                    const iso = isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
                    const newBoth = !(lc && dc)
                    window.api.setClosure(m.id, iso, newBoth, newBoth, label)
                      .then(() => setClosures((c) => ({ ...c, [iso]: { lunch_closed: newBoth, dinner_closed: newBoth, label } })))
                  }} className="px-1.5 pt-1.5 pb-0.5 text-left flex-shrink-0">
                    <span className={clsx('text-[13px] font-bold leading-none block',
                      both ? 'text-white/80' : isSun ? 'text-red-400' : dow === 6 ? 'text-blue-400' : 'text-ink-900')}>
                      {d.getDate()}
                    </span>
                    {label && <span className={clsx('text-[8px] leading-tight block truncate mt-0.5',
                      both ? 'text-white/50' : 'text-ink-500')}>{label}</span>}
                  </button>

                  {/* meal buttons — take remaining space */}
                  {!isSun ? (
                    <div className="flex flex-col flex-1 border-t border-black/8 min-h-0">
                      <button onClick={() => toggleMeal(d, 'lunch')}
                        className={clsx('flex-1 text-[10px] font-bold transition-colors flex items-center justify-center',
                          lc ? 'bg-ink-700 text-white' : 'text-ink-400 hover:bg-ink-50')}>중</button>
                      <button onClick={() => toggleMeal(d, 'dinner')}
                        className={clsx('flex-1 text-[10px] font-bold transition-colors flex items-center justify-center border-t border-black/8',
                          dc ? 'bg-ink-900 text-white' : 'text-ink-400 hover:bg-ink-50')}>석</button>
                    </div>
                  ) : (
                    <div className="flex-1" />
                  )}
                </div>
              )
            })}
          </div>
        </motion.div>

        {/* Right */}
        <div className="flex flex-col gap-3">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.04 }} className="card p-4">
            <h3 className="text-[14px] font-semibold mb-3">가격</h3>
            <MealRow emoji="🍱" label="중식" name={m.lunch_label} price={m.lunch_price}
              onName={(v) => update('lunch_label', v)} onPrice={(v) => update('lunch_price', v)} />
            <div className="border-t border-ink-100 my-3" />
            <MealRow emoji="🌙" label="석식" name={m.dinner_label} price={m.dinner_price}
              onName={(v) => update('dinner_label', v)} onPrice={(v) => update('dinner_price', v)} />
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.07 }} className="card p-4 flex-1">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[14px] font-semibold">주의사항</h3>
              <button onClick={() => { setNoticeLines([...noticeLines, '']); setDirty(true) }}
                className="w-6 h-6 rounded-full bg-ink-900 text-white flex items-center justify-center hover:bg-ink-700 transition-colors">
                <Plus size={12} />
              </button>
            </div>
            <AnimatePresence initial={false}>
              {noticeLines.map((line, idx) => (
                <motion.div key={idx} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.14 }} className="flex items-center gap-2 mb-2">
                  <span className="text-ink-400 text-[11px] font-semibold w-4 text-right shrink-0">{idx + 1}.</span>
                  <input
                    className="flex-1 bg-surface rounded-lg h-8 px-3 text-[12px] border border-ink-200 outline-none focus:border-ink-500"
                    value={line}
                    onChange={(e) => { const n = [...noticeLines]; n[idx] = e.target.value; setNoticeLines(n); setDirty(true) }}
                    placeholder={`항목 ${idx + 1}`}
                  />
                  {noticeLines.length > 1 && (
                    <button onClick={() => { setNoticeLines(noticeLines.filter((_, i) => i !== idx)); setDirty(true) }}
                      className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-red-50 text-ink-400 hover:text-red-500 shrink-0">
                      <X size={12} />
                    </button>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
    </div>
  )
}

function MealRow({ emoji, label, name, price, onName, onPrice }: {
  emoji: string; label: string; name: string; price: number; onName: (v: string) => void; onPrice: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-lg shrink-0">{emoji}</span>
      <span className="text-[12px] font-semibold w-7 text-ink-600 shrink-0">{label}</span>
      <input className="flex-1 min-w-0 bg-surface rounded-full h-8 px-3 text-[12px] border border-ink-200 outline-none"
        value={name} onChange={(e) => onName(e.target.value)} placeholder="메뉴명" />
      <div className="relative shrink-0 w-[84px]">
        <input type="number" className="w-full bg-surface rounded-full h-8 pl-3 pr-6 text-[12px] border border-ink-200 outline-none tabular-nums"
          value={price} onChange={(e) => onPrice(parseInt(e.target.value || '0'))} step={500} />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 text-[11px]">원</span>
      </div>
    </div>
  )
}
