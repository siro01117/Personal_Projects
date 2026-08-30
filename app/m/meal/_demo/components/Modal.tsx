import { motion, AnimatePresence } from 'framer-motion'
import { ReactNode } from 'react'
import { X } from 'lucide-react'
import { PillButton, spring } from './Motion'

interface Props {
  open: boolean; onClose: () => void; title: string
  children: ReactNode; footer?: ReactNode; width?: string
}

export function Modal({ open, onClose, title, children, footer, width = 'max-w-4xl' }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }} onClick={onClose}
            className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]"
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none p-6">
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={spring}
              className={`pointer-events-auto w-full ${width} max-h-[90vh] flex flex-col bg-white rounded-2xl shadow-pop border border-ink-200`}
            >
              <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-ink-100">
                <h2 className="text-[18px] font-semibold">{title}</h2>
                <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-surface flex items-center justify-center transition-colors">
                  <X size={16} />
                </button>
              </div>
              <div className="flex-1 overflow-auto px-6 py-4">{children}</div>
              {footer && (
                <div className="px-6 py-4 border-t border-ink-100 flex justify-end gap-2">
                  {footer}
                </div>
              )}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  )
}

export { PillButton }
