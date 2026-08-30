export interface Month {
  id: number
  year: number
  month: number
  lunch_label: string
  lunch_price: number
  dinner_label: string
  dinner_price: number
  notice: string  // newline-separated lines
}

export interface Meal { date: string; meal_type: 'lunch' | 'dinner' }

export interface Application {
  id: number
  month_id: number
  name: string
  seat: string | null
  floor: number | null
  paid: number
  paid_amount: number
  paid_date: string | null
  memo: string
  meals: Meal[]
}

// Per-meal closure: null means fully open (default)
export interface ClosureInfo {
  lunch_closed: boolean
  dinner_closed: boolean
  label: string
}

declare global {
  interface Window {
    api: {
      getMonth: (y: number, m: number) => Promise<Month>
      updateMonth: (id: number, fields: Partial<Month>) => Promise<void>
      listClosures: (monthId: number) => Promise<Record<string, ClosureInfo>>
      setClosure: (monthId: number, date: string, lunchClosed: boolean, dinnerClosed: boolean, label: string) => Promise<void>
      holidayLabel: (iso: string) => Promise<string | null>

      listApps: (monthId: number) => Promise<Application[]>
      getApp: (id: number) => Promise<Application | null>
      upsertApp: (payload: any) => Promise<number>
      deleteApp: (id: number) => Promise<void>

      todayOrders: () => Promise<{
        today: string
        byFloor: Record<string, { lunch: number; dinner: number }>
        lunchTotal: number
        dinnerTotal: number
      }>
      exportPdf: (html: string, defaultName: string) => Promise<string | null>
    }
  }
}
