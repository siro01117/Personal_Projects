"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { monthGrid, effectiveClosure, monthLabel, won, noticeLines, type LunchMonth, type Closure, type MealType } from "@/lib/lunch";
import { updateMonth, setClosure, setOrderPayment } from "./actions";

export type FloorCount = { floor: number; meal_type: MealType; cnt: number };
export type OrderRow = {
  id: string; student_name: string; seat_number: number | null; floor: number | null;
  paid: boolean; paid_amount: number; paid_date: string | null; memo: string | null;
  lunch_cnt: number; dinner_cnt: number;
};

type Tab = "board" | "orders" | "settings";
const COLS = "44px 32px repeat(6, minmax(0, 1fr))";
const HEAD = ["월", "화", "수", "목", "금", "토"];

export default function LunchAdmin({ month, closures, todayByFloor, orders, today, canManage }: {
  month: LunchMonth; closures: Closure[]; todayByFloor: FloorCount[]; orders: OrderRow[]; today: string; canManage: boolean;
}) {
  const [tab, setTab] = useState<Tab>("board");

  const prev = month.month === 1 ? { y: month.year - 1, m: 12 } : { y: month.year, m: month.month - 1 };
  const next = month.month === 12 ? { y: month.year + 1, m: 1 } : { y: month.year, m: month.month + 1 };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 0", flex: "none", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link href={`/m/lunch?y=${prev.y}&m=${prev.m}`} className="chip" style={{ textDecoration: "none" }}>‹</Link>
          <span style={{ fontSize: 17, fontWeight: 800 }}>{monthLabel(month.year, month.month)}</span>
          <Link href={`/m/lunch?y=${next.y}&m=${next.m}`} className="chip" style={{ textDecoration: "none" }}>›</Link>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {([["board", "오늘 발주"], ["orders", `신청 ${orders.length}`], ["settings", "신청서 제작"]] as [Tab, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className="chip" style={{ background: tab === k ? "var(--accent)" : "var(--panel2)", color: tab === k ? "#fff" : "var(--sub)", fontWeight: tab === k ? 800 : 500 }}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px 28px" }}>
        {tab === "board" && <Board todayByFloor={todayByFloor} month={month} today={today} />}
        {tab === "orders" && <Orders orders={orders} month={month} canManage={canManage} today={today} />}
        {tab === "settings" && <Settings key={month.id} month={month} closures={closures} canManage={canManage} />}
      </div>
    </div>
  );
}

// ── 오늘 층별 발주 수량(주방 주문용) ──
function Board({ todayByFloor, month, today }: { todayByFloor: FloorCount[]; month: LunchMonth; today: string }) {
  const floors = useMemo(() => {
    const map = new Map<number, { lunch: number; dinner: number }>();
    for (const r of todayByFloor) {
      const f = map.get(r.floor) ?? { lunch: 0, dinner: 0 };
      if (r.meal_type === "lunch") f.lunch += r.cnt; else f.dinner += r.cnt;
      map.set(r.floor, f);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [todayByFloor]);
  const totL = floors.reduce((s, [, v]) => s + v.lunch, 0);
  const totD = floors.reduce((s, [, v]) => s + v.dinner, 0);

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--dim)", marginBottom: 12 }}>{today} 오늘 발주 수량</div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Big label={month.lunch_label} n={totL} />
        <Big label={month.dinner_label} n={totD} />
      </div>
      {floors.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--faint)" }}>오늘 신청된 도시락이 없습니다.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", fontSize: 11.5, color: "var(--faint)", fontWeight: 700, padding: "0 12px" }}>
            <span>층</span><span style={{ textAlign: "right" }}>{month.lunch_label}</span><span style={{ textAlign: "right" }}>{month.dinner_label}</span>
          </div>
          {floors.map(([f, v]) => (
            <div key={f} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", alignItems: "center", padding: "12px", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12 }}>
              <span style={{ fontWeight: 700 }}>{f === 0 ? "미배정" : `${f}층`}</span>
              <span style={{ textAlign: "right", fontSize: 18, fontWeight: 800, color: v.lunch ? "var(--ink)" : "var(--faint)" }}>{v.lunch}</span>
              <span style={{ textAlign: "right", fontSize: 18, fontWeight: 800, color: v.dinner ? "var(--ink)" : "var(--faint)" }}>{v.dinner}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function Big({ label, n }: { label: string; n: number }) {
  return (
    <div style={{ flex: 1, minWidth: 130, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14, padding: "14px 16px" }}>
      <div style={{ fontSize: 12.5, color: "var(--dim)", fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 900, lineHeight: 1.1, marginTop: 2 }}>{n}<span style={{ fontSize: 14, fontWeight: 700, color: "var(--faint)" }}> 개</span></div>
    </div>
  );
}

// ── 신청 목록 + 선불 결제 기록 ──
function Orders({ orders, month, canManage, today }: { orders: OrderRow[]; month: LunchMonth; canManage: boolean; today: string }) {
  if (orders.length === 0) return <div style={{ fontSize: 13, color: "var(--faint)" }}>이 달 신청 내역이 없습니다.</div>;
  const paidCount = orders.filter((o) => o.paid).length;
  const owed = orders.reduce((s, o) => s + (o.paid ? 0 : o.lunch_cnt * month.lunch_price + o.dinner_cnt * month.dinner_price), 0);
  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--dim)", marginBottom: 12 }}>결제 {paidCount}/{orders.length} · 미수금 {won(owed)}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {orders.map((o) => <OrderCard key={o.id} o={o} month={month} canManage={canManage} today={today} />)}
      </div>
    </div>
  );
}

function OrderCard({ o, month, canManage, today }: { o: OrderRow; month: LunchMonth; canManage: boolean; today: string }) {
  const [open, setOpen] = useState(false);
  const due = o.lunch_cnt * month.lunch_price + o.dinner_cnt * month.dinner_price;
  const loc = o.floor ? `${o.floor}층${o.seat_number ? ` ${o.seat_number}` : ""}` : "미배정";
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
      <button onClick={() => canManage && setOpen((v) => !v)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: "transparent", border: "none", cursor: canManage ? "pointer" : "default", textAlign: "left" }}>
        <span style={{ width: 62, fontSize: 12, color: "var(--faint)", fontWeight: 700 }}>{loc}</span>
        <span style={{ fontWeight: 700, flex: 1 }}>{o.student_name}</span>
        <span style={{ fontSize: 12.5, color: "var(--dim)" }}>{month.lunch_label[0]}{o.lunch_cnt} · {month.dinner_label[0]}{o.dinner_cnt}</span>
        <span style={{ fontSize: 12, fontWeight: 800, padding: "3px 9px", borderRadius: 20, background: o.paid ? "var(--ok-soft)" : "var(--warn-soft)", color: o.paid ? "var(--ok)" : "var(--warn)" }}>{o.paid ? "결제완료" : won(due)}</span>
      </button>
      {open && canManage && (
        <form action={setOrderPayment} style={{ borderTop: "1px solid var(--line)", padding: 14, display: "flex", flexDirection: "column", gap: 10, background: "var(--panel2)" }}>
          <input type="hidden" name="orderId" value={o.id} />
          <div style={{ display: "flex", gap: 10 }}>
            <label style={{ flex: 1, fontSize: 12 }}>결제액<input className="input" name="paid_amount" type="number" defaultValue={o.paid_amount || due} style={{ height: 38, marginTop: 4 }} /></label>
            <label style={{ flex: 1, fontSize: 12 }}>결제일<input className="input" name="paid_date" type="date" defaultValue={o.paid_date || today} style={{ height: 38, marginTop: 4 }} /></label>
          </div>
          <label style={{ fontSize: 12 }}>메모<input className="input" name="memo" defaultValue={o.memo ?? ""} placeholder="현금/카드 등" style={{ height: 38, marginTop: 4 }} /></label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" name="paid" value="1" className="btn btn-accent" style={{ height: 40, flex: 1 }}>결제 완료로 저장</button>
            {o.paid && <button type="submit" name="paid" value="0" className="btn" style={{ height: 40, flex: "0 0 96px" }}>미결제로</button>}
          </div>
        </form>
      )}
    </div>
  );
}

// ── 신청서 제작: 신청서 그리드로 휴무 설정 + 가격 + 주의사항 ──
function Settings({ month, closures, canManage }: { month: LunchMonth; closures: Closure[]; canManage: boolean }) {
  const overrides = useMemo(() => new Map<string, Closure>(closures.map((c) => [c.date, c])), [closures]);
  const weeks = useMemo(
    () => monthGrid(month.year, month.month).filter((w) => w.slice(0, 6).some(Boolean)),
    [month],
  );
  const [lines, setLines] = useState<string[]>(() => { const l = noticeLines(month.notice); return l.length ? l : [""]; });

  if (!canManage) return <div style={{ fontSize: 13, color: "var(--faint)" }}>설정 권한이 없습니다.</div>;
  const box: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14, padding: 18, marginBottom: 16 };
  const lb: React.CSSProperties = { fontSize: 12, color: "var(--faint)", fontWeight: 700 };

  return (
    <div style={{ maxWidth: 680 }}>
      {/* 가격 + 주의사항 */}
      <form action={updateMonth} style={box}>
        <input type="hidden" name="monthId" value={month.id} />
        <input type="hidden" name="notice" value={lines.map((l) => l.trim()).filter(Boolean).join("\n")} />
        <div style={{ fontWeight: 800, marginBottom: 12 }}>가격</div>
        <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
          <label style={{ flex: 2 }}><div style={lb}>중식 메뉴</div><input className="input" name="lunch_label" defaultValue={month.lunch_label} style={{ height: 40, marginTop: 4 }} /></label>
          <label style={{ flex: 1 }}><div style={lb}>중식 가격</div><input className="input" name="lunch_price" type="number" defaultValue={month.lunch_price} style={{ height: 40, marginTop: 4 }} /></label>
        </div>
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <label style={{ flex: 2 }}><div style={lb}>석식 메뉴</div><input className="input" name="dinner_label" defaultValue={month.dinner_label} style={{ height: 40, marginTop: 4 }} /></label>
          <label style={{ flex: 1 }}><div style={lb}>석식 가격</div><input className="input" name="dinner_price" type="number" defaultValue={month.dinner_price} style={{ height: 40, marginTop: 4 }} /></label>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontWeight: 800 }}>주의사항</div>
          <button type="button" onClick={() => setLines((l) => [...l, ""])} className="chip" style={{ background: "var(--ink)", color: "#fff" }}>+ 항목</button>
        </div>
        {lines.map((line, idx) => (
          <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ width: 16, textAlign: "right", fontSize: 12, fontWeight: 700, color: "var(--faint)" }}>{idx + 1}.</span>
            <input className="input" value={line} onChange={(e) => setLines((l) => l.map((v, i) => (i === idx ? e.target.value : v)))} placeholder={`항목 ${idx + 1}`} style={{ height: 38, flex: 1 }} />
            {lines.length > 1 && <button type="button" onClick={() => setLines((l) => l.filter((_, i) => i !== idx))} className="chip" style={{ color: "var(--danger)" }}>✕</button>}
          </div>
        ))}
        <button type="submit" className="btn btn-accent" style={{ height: 42, marginTop: 12 }}>가격·주의사항 저장</button>
      </form>

      {/* 휴무 설정 — 신청서 그리드 */}
      <div style={box}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>휴무 설정</div>
        <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 12 }}>학생이 보는 신청서 그대로입니다. 중/석 칸을 눌러 휴무(빗금)를 켜고 끄세요. 주말·공휴일은 자동 휴무.</div>

        <div style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", fontSize: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: COLS, background: "var(--panel2)", borderBottom: "1px solid var(--line)" }}>
            <HeadCell>주차</HeadCell><HeadCell>구분</HeadCell>
            {HEAD.map((d, i) => <HeadCell key={d} blue={i === 5}>{d}</HeadCell>)}
          </div>
          {weeks.map((week, wi) => (
            <div key={wi} style={{ display: "grid", gridTemplateColumns: COLS, borderTop: wi ? "1px solid var(--line)" : "none" }}>
              <StackCol>
                <div style={dateHeadStyle}>{wi + 1}주</div>
                <SegBox muted>중</SegBox><SegBox muted last>석</SegBox>
              </StackCol>
              <StackCol>
                <div style={{ ...dateHeadStyle, background: "var(--panel2)" }} />
                <SegBox faint>중식</SegBox><SegBox faint last>석식</SegBox>
              </StackCol>
              {week.slice(0, 6).map((day, di) => {
                if (!day) return (
                  <StackCol key={di} last={di === 5}>
                    <div style={{ ...dateHeadStyle, background: "var(--panel2)" }} />
                    <SegBox blank /><SegBox blank last />
                  </StackCol>
                );
                const eff = effectiveClosure(day.iso, day.dow, overrides);
                const lc = eff?.lunch_closed ?? false;
                const dc = eff?.dinner_closed ?? false;
                const hol = eff?.label;
                return (
                  <StackCol key={di} last={di === 5}>
                    <div style={{ ...dateHeadStyle, color: day.isSat ? "#2563eb" : "var(--ink)" }}>
                      {day.day}
                      {hol && <span style={{ display: "block", fontSize: 7.5, fontWeight: 500, color: "var(--faint)", lineHeight: 1, marginTop: 1 }}>{hol}</span>}
                    </div>
                    <ClosureCell monthId={month.id} date={day.iso} lunchClosed={!lc ? "1" : "0"} dinnerClosed={dc ? "1" : "0"} closed={lc} ariaLabel={`${day.day}일 중식 휴무`} />
                    <ClosureCell monthId={month.id} date={day.iso} lunchClosed={lc ? "1" : "0"} dinnerClosed={!dc ? "1" : "0"} closed={dc} last ariaLabel={`${day.day}일 석식 휴무`} />
                  </StackCol>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 휴무 토글 셀 — 클릭 시 setClosure로 해당 끼니 휴무 상태를 뒤집는다.
function ClosureCell({ monthId, date, lunchClosed, dinnerClosed, closed, last, ariaLabel }: {
  monthId: string; date: string; lunchClosed: string; dinnerClosed: string; closed: boolean; last?: boolean; ariaLabel?: string;
}) {
  return (
    <form action={setClosure} style={{ flex: 1, display: "flex", borderBottom: last ? "none" : "1px solid var(--line)" }}>
      <input type="hidden" name="monthId" value={monthId} />
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="lunch_closed" value={lunchClosed} />
      <input type="hidden" name="dinner_closed" value={dinnerClosed} />
      <button type="submit" aria-label={ariaLabel} title={closed ? "휴무 해제" : "휴무로"} style={{ flex: 1, position: "relative", border: "none", background: closed ? "var(--panel2)" : "transparent", cursor: "pointer", minHeight: 26 }}>
        {closed && <Diag />}
      </button>
    </form>
  );
}

const dateHeadStyle: React.CSSProperties = { height: 24, background: "var(--panel2)", borderBottom: "1px solid var(--line)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12 };

function HeadCell({ children, blue }: { children?: React.ReactNode; blue?: boolean }) {
  return <div style={{ padding: "7px 2px", textAlign: "center", fontWeight: 700, fontSize: 11, color: blue ? "#2563eb" : "var(--sub)", borderRight: "1px solid var(--line)" }}>{children}</div>;
}
function StackCol({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return <div style={{ display: "flex", flexDirection: "column", minHeight: 70, borderRight: last ? "none" : "1px solid var(--line)" }}>{children}</div>;
}
function SegBox({ children, last, muted, faint, blank }: { children?: React.ReactNode; last?: boolean; muted?: boolean; faint?: boolean; blank?: boolean }) {
  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      borderBottom: last ? "none" : "1px solid var(--line)", minHeight: 26,
      fontSize: muted ? 10 : 9, fontWeight: muted ? 700 : 500,
      color: muted ? "var(--sub)" : "var(--faint)", background: blank ? "var(--panel2)" : "transparent",
    }}>{children}</div>
  );
}
function Diag() {
  return <span style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundImage: "repeating-linear-gradient(-45deg, transparent 0 8px, var(--line) 8px 9.5px)" }} />;
}
