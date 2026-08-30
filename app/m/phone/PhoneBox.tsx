"use client";

// 휴대폰 보관함 크로스체크 — 오늘 입실했는데 휴대폰을 안 낸 학생을 찾는 화면.
// 순찰/카운터에서 제출한 좌석 번호를 툭툭 눌러 담고 누가 안 냈는지 즉시 본다.
// DB 에 아무것도 저장하지 않는 단발성 계산기(새로고침하면 초기화).
import { useMemo, useState } from "react";
import MobileNav from "../_shared/MobileNav";

export type PhoneSeat = {
  seatId: string;
  number: number | null;
  roomId: string | null;
  roomName: string | null;
  studentId: string;
  studentName: string;
  attendance: "in" | "out" | "none";
};

const ICON = {
  backspace: (
    <svg className="ic" viewBox="0 0 24 24">
      <path d="M9 6h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-6-6 6-6Z" />
      <path d="M13 10l4 4M17 10l-4 4" />
    </svg>
  ),
  check: (
    <svg className="ic" viewBox="0 0 24 24">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  reset: (
    <svg className="ic" viewBox="0 0 24 24">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  ),
};

function Keypad({ value, error, onDigit, onBackspace, onConfirm }: {
  value: string; error: boolean;
  onDigit: (d: string) => void; onBackspace: () => void; onConfirm: () => void;
}) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "ok"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        className={error ? "phonebox-shake" : undefined}
        style={{
          height: 64, borderRadius: 14, border: `1.5px solid ${error ? "var(--danger)" : "var(--line)"}`,
          background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 40, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: error ? "var(--danger)" : "var(--ink)",
        }}
      >
        {error ? "이 번호의 좌석 없음" : value.length > 0 ? value : <span style={{ color: "var(--faint)" }}>좌석 번호</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {keys.map((k) => {
          if (k === "back") {
            return (
              <button key={k} onClick={onBackspace} className="btn touchable" style={{ height: 56, fontSize: 16 }} aria-label="지우기">
                {ICON.backspace}
              </button>
            );
          }
          if (k === "ok") {
            return (
              <button key={k} onClick={onConfirm} className="btn btn-accent touchable" style={{ height: 56, fontSize: 16 }} aria-label="확인">
                {ICON.check}
              </button>
            );
          }
          return (
            <button
              key={k}
              onClick={() => onDigit(k)}
              className="btn touchable"
              style={{ height: 56, fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
            >
              {k}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RoomGrid({ seats, onTap, muted }: { seats: PhoneSeat[]; onTap: (seat: PhoneSeat) => void; muted?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
      {seats.map((s) => (
        <button
          key={s.seatId}
          onClick={() => onTap(s)}
          className="touchable"
          style={{
            display: "grid", gridTemplateColumns: "44px 1fr", alignItems: "center", gap: 8,
            minHeight: 48, padding: "0 8px", borderRadius: 10, border: "1px solid var(--line)",
            background: "var(--card)", textAlign: "left", cursor: "pointer",
            opacity: muted ? 0.7 : 1,
          }}
        >
          <span style={{ textAlign: "right", fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: muted ? "var(--faint)" : "var(--sub)" }}>
            {s.number ?? "-"}
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: muted ? "var(--faint)" : "var(--ink)" }}>
            {s.studentName}
          </span>
        </button>
      ))}
    </div>
  );
}

function GroupedList({ groups, onTap, emptyLabel, muted }: {
  groups: { roomName: string; seats: PhoneSeat[] }[];
  onTap: (seat: PhoneSeat) => void;
  emptyLabel: string;
  muted?: boolean;
}) {
  if (groups.length === 0) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--faint)", fontSize: 13 }}>{emptyLabel}</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {groups.map((g) => (
        <div key={g.roomName}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--faint)", marginBottom: 6, padding: "0 2px" }}>
            {g.roomName} · {g.seats.length}
          </div>
          <RoomGrid seats={g.seats} onTap={onTap} muted={muted} />
        </div>
      ))}
    </div>
  );
}

function groupByRoom(list: PhoneSeat[]) {
  const m = new Map<string, PhoneSeat[]>();
  for (const s of list) {
    const key = s.roomName ?? "방 미지정";
    const arr = m.get(key);
    if (arr) arr.push(s);
    else m.set(key, [s]);
  }
  return Array.from(m.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "ko"))
    .map(([roomName, roomSeats]) => ({
      roomName,
      seats: roomSeats.slice().sort((a, b) => (a.number ?? 0) - (b.number ?? 0)),
    }));
}

export default function PhoneBox({ seats, layout = "narrow" }: { seats: PhoneSeat[]; layout?: "narrow" | "wide" }) {
  const [submitted, setSubmitted] = useState<Set<string>>(() => new Set());
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);
  const [errKey, setErrKey] = useState(0);
  const [showNotTarget, setShowNotTarget] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const byNumber = useMemo(() => {
    const m = new Map<number, PhoneSeat[]>();
    for (const s of seats) {
      if (s.number == null) continue;
      const arr = m.get(s.number);
      if (arr) arr.push(s);
      else m.set(s.number, [s]);
    }
    return m;
  }, [seats]);

  // 3구간 분류: 제출 체크가 최우선, 그 다음 오늘 입실(in) 여부.
  const unsubmittedSeats = useMemo(
    () => seats.filter((s) => s.attendance === "in" && !submitted.has(s.seatId)),
    [seats, submitted],
  );
  const submittedSeats = useMemo(
    () => seats.filter((s) => submitted.has(s.seatId)),
    [seats, submitted],
  );
  const notTargetSeats = useMemo(
    () => seats.filter((s) => s.attendance !== "in" && !submitted.has(s.seatId)),
    [seats, submitted],
  );

  const unsubmittedGroups = useMemo(() => groupByRoom(unsubmittedSeats), [unsubmittedSeats]);
  const submittedGroups = useMemo(() => groupByRoom(submittedSeats), [submittedSeats]);
  const notTargetGroups = useMemo(() => groupByRoom(notTargetSeats), [notTargetSeats]);

  const unsubmittedCount = unsubmittedSeats.length;
  const submittedCount = submittedSeats.length;
  const notTargetCount = notTargetSeats.length;

  const flashError = () => {
    setError(true);
    setErrKey((k) => k + 1);
    window.setTimeout(() => setError(false), 900);
  };

  const digit = (d: string) => {
    if (error) setError(false);
    setInput((v) => (v.length >= 4 ? v : v + d));
  };
  const backspace = () => {
    if (error) setError(false);
    setInput((v) => v.slice(0, -1));
  };
  const toggle = (seat: PhoneSeat) => {
    setSubmitted((prev) => {
      const next = new Set(prev);
      if (next.has(seat.seatId)) next.delete(seat.seatId);
      else next.add(seat.seatId);
      return next;
    });
  };
  const confirm = () => {
    if (input.length === 0) return;
    const n = Number.parseInt(input, 10);
    const hits = byNumber.get(n);
    if (!hits || hits.length === 0) {
      flashError();
      return;
    }
    setSubmitted((prev) => {
      const next = new Set(prev);
      for (const s of hits) next.add(s.seatId);
      return next;
    });
    setInput("");
  };
  const doReset = () => {
    setSubmitted(new Set());
    setInput("");
    setConfirmReset(false);
  };

  const wide = layout === "wide";

  const summaryBar = (
    <div style={{ flex: "none", padding: "12px 14px", background: "var(--card)", borderBottom: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 13, color: "var(--danger)", fontWeight: 800 }}>미제출</span>
          <span style={{ fontSize: 30, fontWeight: 900, fontVariantNumeric: "tabular-nums", color: "var(--danger)" }}>{unsubmittedCount}</span>
        </div>
        <span style={{ fontSize: 13, color: "var(--faint)" }}>·</span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <span style={{ fontSize: 12, color: "var(--faint)", fontWeight: 700 }}>제출</span>
          <span style={{ fontSize: 16, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: "var(--ok)" }}>{submittedCount}</span>
        </div>
        <span style={{ fontSize: 13, color: "var(--faint)" }}>·</span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <span style={{ fontSize: 12, color: "var(--faint)", fontWeight: 700 }}>대상 아님</span>
          <span style={{ fontSize: 16, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: "var(--faint)" }}>{notTargetCount}</span>
        </div>
        {confirmReset ? (
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button onClick={doReset} className="chip touchable" style={{ color: "var(--danger)", borderColor: "var(--danger)", fontWeight: 700 }}>초기화 확인</button>
            <button onClick={() => setConfirmReset(false)} className="chip touchable">취소</button>
          </div>
        ) : (
          <button onClick={() => setConfirmReset(true)} className="chip touchable" aria-label="초기화" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4 }}>
            {ICON.reset}초기화
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--faint)", lineHeight: 1.4 }}>
        입실 기록이 있는 학생 중 휴대폰을 내지 않은 명단입니다.
      </div>
    </div>
  );

  const list = (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 14px calc(14px + env(safe-area-inset-bottom))", display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 800, color: "var(--danger)", marginBottom: 10 }}>
          미제출 {unsubmittedCount}
        </div>
        <GroupedList groups={unsubmittedGroups} onTap={toggle} emptyLabel="전원 제출 완료" />
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ok)", marginBottom: 10 }}>
          제출 {submittedCount}
        </div>
        <GroupedList groups={submittedGroups} onTap={toggle} emptyLabel="아직 제출된 좌석이 없음" />
      </div>

      <div>
        <button
          onClick={() => setShowNotTarget((v) => !v)}
          className="touchable"
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            minHeight: 44, padding: "0 2px", background: "transparent", border: "none", cursor: "pointer",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--faint)" }}>대상 아님 {notTargetCount}</span>
          <span style={{ fontSize: 12, color: "var(--faint)" }}>{showNotTarget ? "접기 ▲" : "펼치기 ▼"}</span>
        </button>
        {showNotTarget && (
          <div style={{ marginTop: 10 }}>
            <GroupedList groups={notTargetGroups} onTap={toggle} emptyLabel="없음" muted />
          </div>
        )}
      </div>
    </div>
  );

  const keypad = (
    <div style={{ flex: "none", padding: wide ? 14 : "12px 14px calc(10px + env(safe-area-inset-bottom))" }}>
      <Keypad key={errKey} value={input} error={error} onDigit={digit} onBackspace={backspace} onConfirm={confirm} />
    </div>
  );

  if (wide) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {summaryBar}
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div style={{ width: 280, flex: "none", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column" }}>
            {keypad}
          </div>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {list}
          </div>
        </div>
      </div>
    );
  }

  return (
    <main style={{ height: "100dvh", overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--card)", borderBottom: "1px solid var(--line)" }}>
        <MobileNav current="/phone" />
        <span style={{ fontSize: 16, fontWeight: 800 }}>휴대폰 보관함</span>
      </div>
      {summaryBar}
      {keypad}
      {list}
    </main>
  );
}
