import { motion } from 'framer-motion'
import logo from '../assets/logo.png'

const sp = { type: 'spring', stiffness: 260, damping: 20, mass: 0.8 } as const

export function Splash({ onDone }: { onDone: () => void }) {
  return (
    <motion.div
      className="fixed inset-0 z-[999] flex items-center justify-center bg-white"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.03 }}
      transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
    >
      <motion.div
        className="flex flex-col items-center gap-5"
        initial={{ opacity: 0, scale: 0.8, rotate: -5, y: 16 }}
        animate={{ opacity: 1, scale: 1, rotate: 0, y: 0 }}
        transition={sp}
        onAnimationComplete={() => setTimeout(onDone, 1000)}
      >
        <motion.div initial={{ skewX: -10, skewY: -3 }} animate={{ skewX: 0, skewY: 0 }} transition={{ ...sp, delay: 0.05 }}>
          <img src={logo.src} alt="logo" className="w-32 h-32 object-contain" style={{ filter: 'drop-shadow(0 4px 16px rgba(0,0,0,0.14))' }} />
        </motion.div>
        <motion.div
          className="text-center"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...sp, delay: 0.28 }}
        >
          <div className="text-[12px] font-semibold tracking-[0.22em] uppercase text-ink-500">도시락 신청 관리</div>
          <motion.div
            className="mt-2 h-[2px] bg-ink-900 rounded-full"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1], delay: 0.48 }}
            style={{ originX: 0 }}
          />
        </motion.div>
      </motion.div>
    </motion.div>
  )
}
