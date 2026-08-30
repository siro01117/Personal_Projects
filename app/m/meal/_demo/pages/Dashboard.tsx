import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw, UtensilsCrossed, Moon, Building2 } from 'lucide-react'
import { PillButton, spring } from '../components/Motion'

const DAYS = ['일', '월', '화', '수', '목', '금', '토']

export function Dashboard({ onChange }: { onChange: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof window.api.todayOrders>> | null>(null)
  const load = async () => setData(await window.api.todayOrders())
  useEffect(() => { load() }, [])
  if (!data) return null

  const today = new Date()
  const dateLabel = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일 (${DAYS[today.getDay()]})`
  const floors = Object.entries(data.byFloor).sort(([a], [b]) => parseInt(a) - parseInt(b))

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-end justify-between mb-5">
        <div>
          <div className="text-ink-500 text-[11px] tracking-[0.16em] uppercase font-semibold">Today</div>
          <h1 className="text-[38px] leading-tight font-semibold tracking-tight mt-0.5">{dateLabel}</h1>
          <p className="text-ink-500 text-[13px] mt-1">오늘 들어가야 할 발주 수량</p>
        </div>
        <PillButton icon={<RefreshCw size={15} />} onClick={load}>새로 고침</PillButton>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {/* 중식 */}
        <motion.div whileHover={{ y: -2 }} transition={spring} className="card p-6">
          <div className="flex items-center gap-2 text-ink-500 mb-3">
            <UtensilsCrossed size={15} />
            <span className="text-[12px] font-semibold uppercase tracking-wider">중식 발주</span>
          </div>
          <div className="flex items-baseline gap-2">
            <motion.span key={data.lunchTotal} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              transition={spring} className="text-[72px] leading-none font-semibold tabular-nums">{data.lunchTotal}</motion.span>
            <span className="text-ink-400 text-lg">개</span>
          </div>
        </motion.div>

        {/* 석식 */}
        <motion.div whileHover={{ y: -2 }} transition={spring} className="rounded-[20px] border border-ink-900 bg-ink-900 p-6">
          <div className="flex items-center gap-2 mb-3" style={{ color: 'rgba(255,255,255,0.55)' }}>
            <Moon size={15} />
            <span className="text-[12px] font-semibold uppercase tracking-wider">석식 발주</span>
          </div>
          <div className="flex items-baseline gap-2">
            <motion.span key={data.dinnerTotal} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              transition={spring} className="text-[72px] leading-none font-semibold tabular-nums text-white">{data.dinnerTotal}</motion.span>
            <span className="text-lg" style={{ color: 'rgba(255,255,255,0.4)' }}>개</span>
          </div>
        </motion.div>
      </div>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.06 }} className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Building2 size={16} className="text-ink-500" />
          <h2 className="text-[16px] font-semibold">층별 분류</h2>
        </div>
        {floors.length === 0 ? (
          <div className="text-ink-400 text-[13px] py-10 text-center">오늘 신청된 도시락이 없습니다.</div>
        ) : (
          <div>
            <div className="grid grid-cols-3 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-ink-400 font-semibold">
              <span>층</span><span className="text-right">중식</span><span className="text-right">석식</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {floors.map(([f, v], i) => (
                <motion.div key={f}
                  initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ ...spring, delay: 0.04 * i }}
                  className="grid grid-cols-3 px-3 py-3 rounded-xl bg-surface items-center"
                >
                  <span className="font-medium text-[14px]">{f === '0' ? '미지정' : `${f}층`}</span>
                  <span className="text-right tabular-nums text-[18px] font-semibold">{v.lunch}</span>
                  <span className="text-right tabular-nums text-[18px] font-semibold text-ink-600">{v.dinner}</span>
                </motion.div>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  )
}
