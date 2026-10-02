"use client";

// 모임 만들기 · 고치기 칸 (docs/모임.md 4장): 제목 · 묶음 칩 · 시간(안다 / 맞춰야 한다 / 아직 모른다) · 지점 칩 + 장소 글 · 메모.
// 맞춰야 한다 = 후보 날짜(달력에서 눌러 고른다) · 하루 범위 · 모임 길이 → 저장하면 맞추기가 켜지고 모임 화면에 격자가 생긴다.
// 새 모임이면 사람들도 — 묶음을 고르면 채워지고, 한 칸에 이름을 적어 Enter 로 더한다(쉼표로 여럿).
// 설정에 내 이름이 없으면 처음 한 번 묻는다(7장). 일정 · 할 일 수정 칸(.form)과 같은 생김새.
// 시간을 적으면 저장할 때 일정에 들어간다.
// 한글 조합 중 Enter 는 무시. Esc 는 취소(화면 쪽에서).

import { useState, type KeyboardEvent } from "react";
import { MEET_NOTE_MAX, MEET_TITLE_MAX, PERSON_NAME_MAX, PLACE_TEXT_MAX, POLL_DURATION_MAX, POLL_DURATION_MIN, SLOT_MIN, type Circle } from "../../../lib/meet";
import type { DateStr, Place } from "../../../lib/schedule";
import {
  addNames,
  draftWithCircle,
  durationLabel,
  halfHours,
  hmEnd,
  monthGrid,
  monthTitle,
  parseNames,
  shiftMonth,
  timeMode,
  toggleDate,
  withTimeMode,
  type MeetDraft,
  type TimeMode,
} from "../../_logic/meet";
import { hm, WEEKDAYS } from "../../_logic/schedule";
import { Icon } from "../Icon";
import { PlaceDot } from "../schedule/PlaceSymbol";
import { useToast } from "../Toast";

const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

/** "HH:MM" → 분 (못 읽으면 null) */
function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
}

const MODES: [TimeMode, string][] = [
  ["known", "안다"],
  ["poll", "맞춰야 한다"],
  ["none", "아직 모른다"],
];

/** 후보 날짜 고르기: 한 달 달력에서 눌러 켜고 끈다. 지난 날짜는 못 고른다(이미 골라 둔 것은 끌 수 있다) */
function DatePick({ dates, today, onChange }: { dates: DateStr[]; today: DateStr; onChange: (dates: DateStr[]) => void }) {
  const [month, setMonth] = useState<DateStr>(() => dates[0] ?? today);
  const picked = new Set(dates);
  return (
    <div className="dpick">
      <div className="dpick-h">
        <button type="button" className="iconbtn" aria-label="이전 달" title="이전 달" onClick={() => setMonth(shiftMonth(month, -1))}>
          <Icon name="left" />
        </button>
        <span className="num">{monthTitle(month)}</span>
        <button type="button" className="iconbtn" aria-label="다음 달" title="다음 달" onClick={() => setMonth(shiftMonth(month, 1))}>
          <Icon name="right" />
        </button>
      </div>
      <div className="dpick-g" role="group" aria-label="후보 날짜">
        {WEEKDAYS.map((w) => (
          <span className="w" key={w}>
            {w}
          </span>
        ))}
        {monthGrid(month)
          .flat()
          .map((d, i) =>
            d === null ? (
              <span key={`x${i}`} />
            ) : (
              <button
                type="button"
                key={d}
                className={d === today ? "d num today" : "d num"}
                aria-pressed={picked.has(d)}
                aria-label={d}
                disabled={d < today && !picked.has(d)}
                onClick={() => onChange(toggleDate(dates, d))}
              >
                {Number(d.slice(8, 10))}
              </button>
            ),
          )}
      </div>
    </div>
  );
}

export function MeetForm({
  draft,
  onChange,
  circles,
  places,
  isNew,
  askName,
  today,
  onSave,
  onCancel,
}: {
  draft: MeetDraft;
  onChange: (d: MeetDraft) => void;
  circles: Circle[];
  /** 고를 수 있는 지점 (지운 지점은 이미 붙어 있을 때만) */
  places: Place[];
  isNew: boolean;
  /** 설정에 내 이름이 없다 — 새 모임을 만들 때 묻는다 */
  askName: boolean;
  /** 오늘 (후보 날짜 달력) */
  today: DateStr;
  onSave: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const set = (p: Partial<MeetDraft>) => onChange({ ...draft, ...p });
  const shown = places.filter((p) => !p.deleted || p.id === draft.place_id);
  const mode = timeMode(draft);

  /** 하루 범위: 시작이 끝을 넘지 않게, 길이가 범위를 넘지 않게 맞춘다 */
  function setRange(from: number, to: number) {
    const dayTo = Math.max(to, from + SLOT_MIN);
    set({ dayFrom: from, dayTo, duration: Math.min(draft.duration, dayTo - from) });
  }

  function setStart(s: string) {
    const m = parseHm(s);
    if (m === null) return;
    // 길이를 지킨다 (자정을 넘기지 않게)
    const len = draft.end - draft.start;
    set({ start: m, end: Math.min(1440, m + Math.max(len, 5)) });
  }
  function setEnd(s: string) {
    const m = parseHm(s);
    if (m !== null) set({ end: m });
  }
  function addPeople() {
    const r = addNames(draft.people, parseNames(draft.personText));
    if (r.issue) {
      toast(r.issue);
      return;
    }
    set({ people: r.names, personText: "" });
  }

  return (
    <form
      className="form"
      aria-label={isNew ? "새 모임" : "모임 수정"}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <input
        className="ttl"
        value={draft.title}
        placeholder="제목"
        aria-label="제목"
        maxLength={MEET_TITLE_MAX}
        autoFocus
        onChange={(e) => set({ title: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && composing(e)) e.preventDefault();
        }}
      />
      {(circles.length > 0 || draft.circle_id !== null) && (
        <div className="f">
          <Icon name="meet" />
          <div className="chips" role="group" aria-label="묶음">
            {circles.map((c) => (
              <button type="button" key={c.id} className="chip" aria-pressed={draft.circle_id === c.id} onClick={() => onChange(draftWithCircle(draft, c, circles, isNew))}>
                {c.name}
              </button>
            ))}
            <button type="button" className="chip" aria-pressed={draft.circle_id === null} onClick={() => onChange(draftWithCircle(draft, null, circles, isNew))}>
              없음
            </button>
          </div>
        </div>
      )}
      <div className="f">
        <Icon name="clock" />
        <div className="v">
          <div className="line">
            <div className="seg" role="group" aria-label="시간">
              {MODES.map(([k, label]) => (
                <button type="button" key={k} aria-pressed={mode === k} onClick={() => onChange(withTimeMode(draft, k))}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {mode === "poll" && <DatePick dates={draft.dates} today={today} onChange={(dates) => set({ dates })} />}
          {mode === "poll" && (
            <div className="line">
              <select className="pill num" aria-label="하루 범위 시작" value={draft.dayFrom} onChange={(e) => setRange(Number(e.target.value), draft.dayTo)}>
                {halfHours(0, 1440 - SLOT_MIN).map((m) => (
                  <option key={m} value={m}>
                    {hm(m)}
                  </option>
                ))}
              </select>
              <span className="dash">–</span>
              <select className="pill num" aria-label="하루 범위 끝" value={draft.dayTo} onChange={(e) => setRange(Math.min(draft.dayFrom, Number(e.target.value) - SLOT_MIN), Number(e.target.value))}>
                {halfHours(SLOT_MIN, 1440).map((m) => (
                  <option key={m} value={m}>
                    {hmEnd(m)}
                  </option>
                ))}
              </select>
              <select className="pill" aria-label="모임 길이" value={draft.duration} onChange={(e) => set({ duration: Number(e.target.value) })}>
                {halfHours(POLL_DURATION_MIN, Math.min(POLL_DURATION_MAX, draft.dayTo - draft.dayFrom)).map((m) => (
                  <option key={m} value={m}>
                    {durationLabel(m)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {draft.known && (
            <div className="line">
              <input type="date" className="pill num" value={draft.date} aria-label="날짜" required onChange={(e) => e.target.value && set({ date: e.target.value })} />
            </div>
          )}
          {draft.known && (
            <div className="line">
              <input type="time" className="pill num" value={hm(draft.start)} aria-label="시작" required onChange={(e) => setStart(e.target.value)} />
              <span className="dash">–</span>
              <input type="time" className="pill num" value={draft.end >= 1440 ? "23:59" : hm(draft.end)} aria-label="끝" required onChange={(e) => setEnd(e.target.value)} />
            </div>
          )}
        </div>
      </div>
      <div className="f">
        <Icon name="pin" />
        <div className="v">
          {shown.length > 0 && (
            <div className="chips" role="group" aria-label="지점">
              {shown.map((p) => (
                <button type="button" key={p.id} className={`chip pc-${p.color}`} aria-pressed={draft.place_id === p.id} onClick={() => set({ place_id: p.id })}>
                  <PlaceDot />
                  {p.name}
                </button>
              ))}
              <button type="button" className="chip" aria-pressed={draft.place_id === null} onClick={() => set({ place_id: null })}>
                없음
              </button>
            </div>
          )}
          <input
            className="txt-in"
            placeholder="장소"
            aria-label="장소"
            maxLength={PLACE_TEXT_MAX}
            value={draft.place_text}
            onChange={(e) => set({ place_text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && composing(e)) e.preventDefault();
            }}
          />
        </div>
      </div>
      {isNew && (
        <div className="f">
          <Icon name="user" />
          <div className="v">
            {askName && (
              <input
                className="txt-in"
                placeholder="내 이름"
                aria-label="내 이름"
                maxLength={PERSON_NAME_MAX}
                value={draft.myName}
                onChange={(e) => set({ myName: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && composing(e)) e.preventDefault();
                }}
              />
            )}
            {draft.people.length > 0 && (
              <div className="chips" aria-label="사람들">
                {draft.people.map((n) => (
                  <span className="chip who" key={n}>
                    {n}
                    <button type="button" aria-label={`${n} 빼기`} title="빼기" onClick={() => set({ people: draft.people.filter((x) => x !== n) })}>
                      <Icon name="x" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              className="txt-in"
              placeholder="사람"
              aria-label="사람 더하기"
              enterKeyHint="done"
              value={draft.personText}
              onChange={(e) => set({ personText: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (!composing(e)) addPeople();
              }}
              onBlur={() => draft.personText.trim() !== "" && addPeople()}
            />
          </div>
        </div>
      )}
      <div className="f">
        <Icon name="memo" />
        <textarea className="memo" placeholder="메모" aria-label="메모" maxLength={MEET_NOTE_MAX} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
      <div className="form-acts">
        <button type="submit" className="btn save">
          저장
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
