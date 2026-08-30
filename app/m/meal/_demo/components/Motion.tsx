import { motion, MotionProps } from 'framer-motion'
import clsx from 'clsx'
import { ButtonHTMLAttributes, forwardRef, ReactNode } from 'react'

export const spring = { type: 'spring', stiffness: 320, damping: 26, mass: 0.7 } as const

interface PillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  icon?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}

export const PillButton = forwardRef<HTMLButtonElement, PillButtonProps>(
  ({ children, variant = 'secondary', icon, size = 'md', className, ...rest }, ref) => {
    const sizeCls = { sm: 'h-8 px-3 text-[12px]', md: 'h-10 px-4 text-[13px]', lg: 'h-11 px-6 text-[14px]' }[size]
    const styleCls = {
      primary: 'bg-ink-900 text-white hover:bg-ink-800 border border-ink-900',
      secondary: 'bg-white text-ink-900 hover:bg-surface border border-ink-200 shadow-sm2',
      ghost: 'bg-transparent text-ink-600 hover:bg-surface hover:text-ink-900 border border-transparent',
      danger: 'bg-white text-red-600 hover:bg-red-50 border border-red-200'
    }[variant]
    return (
      <motion.button
        ref={ref}
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.96 }}
        transition={spring}
        className={clsx('inline-flex items-center gap-2 rounded-full font-medium select-none transition-colors focus:outline-none', sizeCls, styleCls, className)}
        {...(rest as any)}
      >
        {icon && <span className="-ml-0.5">{icon}</span>}
        {children}
      </motion.button>
    )
  }
)
PillButton.displayName = 'PillButton'

interface CardProps extends MotionProps { className?: string; children?: ReactNode }
export function Card({ className, children, ...rest }: CardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, stiffness: 240 }}
      className={clsx('card p-5', className)}
      {...rest}
    >{children}</motion.div>
  )
}
