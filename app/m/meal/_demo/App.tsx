"use client"

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Home, FileText, Users } from 'lucide-react'
import clsx from 'clsx'
import { Dashboard } from './pages/Dashboard'
import { MonthSettings } from './pages/MonthSettings'
import { Students } from './pages/Students'
import { Splash } from './components/Splash'
import { DialogProvider } from './components/Dialog'
import { spring } from './components/Motion'

type Tab = 'dashboard' | 'month' | 'students'
const TABS: { id: Tab; label: string; icon: any }[] = [
  { id: 'dashboard', label: '오늘 발주', icon: Home },
  { id: 'month', label: '신청서 제작', icon: FileText },
  { id: 'students', label: '신청서 목록', icon: Users }
]

export default function App() {
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)
  const [tab, setTab] = useState<Tab>('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const [showSplash, setShowSplash] = useState(true)

  return (
    <DialogProvider>
      <AnimatePresence>{showSplash && <Splash onDone={() => setShowSplash(false)} />}</AnimatePresence>

      <div className="h-full flex flex-col bg-surface text-ink-900">
        <div className="h-9 titlebar-drag flex items-center px-5 text-[11px] text-ink-500 select-none">도시락 신청 관리</div>

        <div className="flex-1 min-h-0 px-4 pb-4 flex gap-4">
          {/* Sidebar */}
          <motion.aside
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...spring, delay: 0.04 }}
            className="w-[210px] shrink-0 flex flex-col gap-3"
          >
            <div className="card p-3 flex flex-col gap-1">
              <div className="px-3 pt-2 pb-2.5 border-b border-ink-100 mb-1">
                <div className="text-[10px] uppercase tracking-[0.2em] text-ink-400 font-semibold">Menu</div>
              </div>
              {TABS.map((t) => {
                const Icon = t.icon; const active = tab === t.id
                return (
                  <motion.button
                    key={t.id}
                    whileTap={{ scale: 0.96 }} whileHover={{ x: active ? 0 : 2 }} transition={spring}
                    onClick={() => setTab(t.id)}
                    className={clsx('titlebar-nodrag relative h-10 px-4 rounded-xl text-left text-[13px] font-medium flex items-center gap-3 transition-colors',
                      active ? 'text-ink-900' : 'text-ink-500 hover:text-ink-900 hover:bg-surface')}
                  >
                    {active && (
                      <motion.div layoutId="tab-bg" className="absolute inset-0 bg-ink-900 rounded-xl"
                        transition={{ type: 'spring', stiffness: 500, damping: 40 }} />
                    )}
                    <Icon size={16} className={clsx('relative z-10', active && 'text-white')} />
                    <span className={clsx('relative z-10', active && 'text-white')}>{t.label}</span>
                  </motion.button>
                )
              })}
            </div>

            <div className="card p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-ink-400 font-semibold mb-2.5">기준 월</div>
              <div className="flex gap-1.5">
                <select value={year} onChange={(e) => setYear(parseInt(e.target.value))}
                  className="bg-surface rounded-full h-9 px-3 text-[13px] border border-ink-200 outline-none flex-1 min-w-0">
                  {Array.from({ length: 6 }, (_, i) => today.getFullYear() - 1 + i).map((y) => (
                    <option key={y} value={y}>{y}년</option>
                  ))}
                </select>
                <select value={month} onChange={(e) => setMonth(parseInt(e.target.value))}
                  className="bg-surface rounded-full h-9 px-3 text-[13px] border border-ink-200 outline-none w-[70px]">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>{m}월</option>
                  ))}
                </select>
              </div>
            </div>
          </motion.aside>

          {/* Main */}
          <main className="flex-1 min-w-0 overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={tab + year + month + refreshKey}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: [0.2, 0.7, 0.2, 1] }}
                className="h-full"
              >
                {tab === 'dashboard' && <Dashboard onChange={() => setRefreshKey((k) => k + 1)} />}
                {tab === 'month' && <MonthSettings year={year} month={month}
                  onYearMonthChange={(y, m) => { setYear(y); setMonth(m) }}
                  onChange={() => setRefreshKey((k) => k + 1)} />}
                {tab === 'students' && <Students year={year} month={month} onChange={() => setRefreshKey((k) => k + 1)} />}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </DialogProvider>
  )
}
