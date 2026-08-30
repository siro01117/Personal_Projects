import { createContext, useCallback, useContext, useRef, useState, ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, AlertTriangle, Info, CheckCircle2 } from 'lucide-react'
import { spring } from './Motion'

// ─── Types ────────────────────────────────────────────────────────────────────
type ToastType = 'info' | 'success' | 'error'
interface Toast { id: number; type: ToastType; message: string }
interface ConfirmOptions { title: string; message: string; confirmLabel?: string; danger?: boolean }

interface DialogCtx {
  toast: (msg: string, type?: ToastType) => void
  confirm: (opts: ConfirmOptions) => Promise<boolean>
}

const Ctx = createContext<DialogCtx | null>(null)
export const useDialog = () => useContext(Ctx)!

// ─── Provider ─────────────────────────────────────────────────────────────────
export function DialogProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const nextId = useRef(1)

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = nextId.current++
    setToasts((t) => [...t, { id, type, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmState({ ...opts, resolve })
    })
  }, [])

  const resolve = (val: boolean) => {
    confirmState?.resolve(val)
    setConfirmState(null)
  }

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}

      {/* Toast stack */}
      <div className="fixed bottom-5 right-5 z-[200] flex flex-col gap-2 pointer-events-none">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }}
              transition={spring}
              className="pointer-events-auto flex items-center gap-3 bg-ink-900 text-white rounded-2xl px-4 py-3 shadow-pop text-[13px] font-medium min-w-[220px] max-w-[340px]"
            >
              {t.type === 'success' && <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />}
              {t.type === 'error' && <AlertTriangle size={16} className="text-red-400 shrink-0" />}
              {t.type === 'info' && <Info size={16} className="text-ink-400 shrink-0" />}
              <span>{t.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Confirm modal */}
      <AnimatePresence>
        {confirmState && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 z-[190] bg-black/25"
              onClick={() => resolve(false)}
            />
            <div className="fixed inset-0 z-[195] flex items-center justify-center p-6 pointer-events-none">
              <motion.div
                initial={{ opacity: 0, y: 16, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.97 }}
                transition={spring}
                className="pointer-events-auto w-full max-w-sm bg-white rounded-2xl shadow-pop border border-ink-100 p-6"
              >
                <div className="flex items-start justify-between gap-3 mb-4">
                  {confirmState.danger && <AlertTriangle size={20} className="text-red-500 shrink-0 mt-0.5" />}
                  <div className="flex-1">
                    <h3 className="font-semibold text-[16px]">{confirmState.title}</h3>
                    {confirmState.message && (
                      <p className="text-ink-600 text-[13px] mt-1">{confirmState.message}</p>
                    )}
                  </div>
                  <button onClick={() => resolve(false)} className="w-7 h-7 rounded-full hover:bg-surface flex items-center justify-center shrink-0">
                    <X size={15} />
                  </button>
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => resolve(false)}
                    className="h-9 px-4 rounded-full text-[13px] font-medium bg-surface hover:bg-ink-100 transition-colors border border-ink-200"
                  >취소</button>
                  <motion.button
                    whileTap={{ scale: 0.96 }} transition={spring}
                    onClick={() => resolve(true)}
                    className={`h-9 px-4 rounded-full text-[13px] font-medium text-white transition-colors ${confirmState.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-ink-900 hover:bg-ink-800'}`}
                  >{confirmState.confirmLabel || '확인'}</motion.button>
                </div>
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Ctx.Provider>
  )
}
