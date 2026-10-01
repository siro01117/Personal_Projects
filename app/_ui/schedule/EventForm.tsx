"use client";

// 수정 칸 (목업 수정 시트): 제목 · 날짜 · 시작–끝(종일) · 지점 칩 · 반복(안 함/매일/매주+요일, 끝나는 날) · 메모,
// '더보기' 아래 상세 장소 · 이동시간 · (반복 일정이면) 끝나면 할 일. 데스크톱 패널과 폰 시트가 같이 쓴다.
// 한글 조합 중 Enter 는 무시.

import { useState } from "react";
import { TASK_TITLE_MAX, weekday, type Place, type Repeat } from "../../../lib/schedule";
import { hm, WEEKDAYS, type Draft, type Scope } from "../../_logic/schedule";
import { Icon } from "../Icon";
import { PlaceSymbol } from "./PlaceSymbol";

/** 끝나면 할 일 (docs/플래너.md 7-2): 회차가 끝날 때마다 생길 할 일의 제목(비우면 없음)과 마감까지 며칠 */
export type AfterDraft = { title: string; dueAfter: string };
export const NO_AFTER: AfterDraft = { title: "", dueAfter: "" };

/** "HH:MM" → 분 (못 읽으면 null) */
function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
}

export function EventForm({
  draft,
  onChange,
  places,
  scopes,
  isNew,
  after,
  onAfter,
  onSave,
  onCancel,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  /** 고를 수 있는 지점 (지운 지점은 이미 붙어 있을 때만) */
  places: Place[];
  /** 반복 회차면 저장 범위. 빈 목록이면 그냥 저장 */
  scopes: Scope[];
  isNew: boolean;
  /** 끝나면 할 일. 안 주면 칸을 그리지 않는다 (플래너의 '일정으로') */
  after?: AfterDraft;
  onAfter?: (a: AfterDraft) => void;
  onSave: (scope: Scope | null) => void;
  onCancel: () => void;
}) {
  const [more, setMore] = useState(draft.where_text !== "" || draft.travel !== "" || (after?.title ?? "") !== "");
  const set = (p: Partial<Draft>) => onChange({ ...draft, ...p });
  const shown = places.filter((p) => !p.deleted || p.id === draft.place_id);

  function setStart(s: string) {
    const m = parseHm(s);
    if (m === null) return;
    const len = draft.end - draft.start;
    set({ start: m, end: m + len });
  }
  function setEnd(s: string) {
    const m = parseHm(s);
    if (m === null) return;
    set({ end: m <= draft.start ? m + 1440 : m });
  }
  function setRepeat(kind: "none" | "daily" | "weekly") {
    const until = draft.repeat?.until ?? null;
    let r: Repeat = null;
    if (kind === "daily") r = { freq: "daily", until };
    if (kind === "weekly") r = { freq: "weekly", days: draft.repeat?.freq === "weekly" ? draft.repeat.days : [weekday(draft.date)], until };
    set({ repeat: r });
  }
  function toggleDay(d: number) {
    if (draft.repeat?.freq !== "weekly") return;
    const days = draft.repeat.days.includes(d) ? draft.repeat.days.filter((x) => x !== d) : [...draft.repeat.days, d].sort((a, b) => a - b);
    set({ repeat: { ...draft.repeat, days } });
  }
  const kind = draft.repeat === null ? "none" : draft.repeat.freq;

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (scopes.length === 0) onSave(null);
      }}
      aria-label={isNew ? "새 일정" : "일정 수정"}
    >
      <input
        className="ttl"
        value={draft.title}
        placeholder="제목"
        aria-label="제목"
        maxLength={100}
        autoFocus={isNew}
        onChange={(e) => set({ title: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
        }}
      />
      <div className="f">
        <Icon name="clock" />
        <div className="v">
          <div className="line">
            <input
              type="date"
              className="pill num"
              value={draft.date}
              aria-label="날짜"
              required
              onChange={(e) => e.target.value && set({ date: e.target.value })}
            />
            <span className="grow" />
            <button type="button" className="sw" role="switch" aria-checked={draft.allDay} onClick={() => set({ allDay: !draft.allDay })}>
              종일
              <i />
            </button>
          </div>
          {!draft.allDay && (
            <div className="line">
              <input type="time" className="pill num" value={hm(draft.start)} aria-label="시작" required onChange={(e) => setStart(e.target.value)} />
              <span className="dash">–</span>
              {draft.end > 1440 && <span className="nextday">다음 날</span>}
              <input type="time" className="pill num" value={hm(draft.end)} aria-label="끝" required onChange={(e) => setEnd(e.target.value)} />
            </div>
          )}
        </div>
      </div>
      <div className="f">
        <Icon name="pin" />
        <div className="chips" role="group" aria-label="지점">
          {shown.map((p) => (
            <button
              type="button"
              key={p.id}
              className={`chip pc-${p.color}`}
              aria-pressed={draft.place_id === p.id}
              onClick={() => set({ place_id: p.id })}
            >
              <PlaceSymbol symbol={p.symbol} />
              {p.name}
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={draft.place_id === null} onClick={() => set({ place_id: null })}>
            없음
          </button>
        </div>
      </div>
      <div className="f">
        <Icon name="repeat" />
        <div className="v">
          <div className="chips" role="group" aria-label="반복">
            <button type="button" className="chip" aria-pressed={kind === "none"} onClick={() => setRepeat("none")}>
              안 함
            </button>
            <button type="button" className="chip" aria-pressed={kind === "daily"} onClick={() => setRepeat("daily")}>
              매일
            </button>
            <button type="button" className="chip" aria-pressed={kind === "weekly"} onClick={() => setRepeat("weekly")}>
              매주
            </button>
          </div>
          {draft.repeat?.freq === "weekly" && (
            <div className="chips days" role="group" aria-label="요일">
              {WEEKDAYS.map((w, i) => (
                <button type="button" key={w} className="chip" aria-pressed={draft.repeat?.freq === "weekly" && draft.repeat.days.includes(i + 1)} onClick={() => toggleDay(i + 1)}>
                  {w}
                </button>
              ))}
            </div>
          )}
          {draft.repeat && (
            <div className="line">
              <span className="unit">끝나는 날</span>
              <input
                type="date"
                className="pill num"
                value={draft.repeat.until ?? ""}
                min={draft.date}
                aria-label="끝나는 날"
                onChange={(e) => draft.repeat && set({ repeat: { ...draft.repeat, until: e.target.value || null } })}
              />
            </div>
          )}
        </div>
      </div>
      <div className="f">
        <Icon name="memo" />
        <textarea className="memo" placeholder="메모" aria-label="메모" maxLength={2000} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
      {more ? (
        <>
        <div className="f">
          <Icon name="route" />
          <div className="v">
            <input
              className="txt-in"
              placeholder="상세 장소"
              aria-label="상세 장소"
              maxLength={100}
              value={draft.where_text}
              onChange={(e) => set({ where_text: e.target.value })}
            />
            <label className="unit">
              이동
              <input
                className="txt-in"
                inputMode="numeric"
                aria-label="이동시간(분)"
                value={draft.travel}
                onChange={(e) => set({ travel: e.target.value.replace(/[^0-9]/g, "").slice(0, 3) })}
              />
              분
            </label>
          </div>
        </div>
        {after && onAfter && draft.repeat !== null && (
          <div className="f">
            <Icon name="plan" />
            <div className="v">
              <input
                className="txt-in"
                placeholder="끝나면 할 일"
                aria-label="끝나면 할 일"
                maxLength={TASK_TITLE_MAX}
                value={after.title}
                onChange={(e) => onAfter({ ...after, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
                }}
              />
              {after.title.trim() !== "" && (
                <label className="unit">
                  마감까지
                  <input
                    className="txt-in"
                    inputMode="numeric"
                    aria-label="마감까지 며칠 (0~60, 빈칸이면 마감 없음)"
                    value={after.dueAfter}
                    onChange={(e) => onAfter({ ...after, dueAfter: e.target.value.replace(/[^0-9]/g, "").slice(0, 2) })}
                  />
                  일
                </label>
              )}
            </div>
          </div>
        )}
        </>
      ) : (
        <button type="button" className="more" onClick={() => setMore(true)}>
          <Icon name="down" />
          더보기
        </button>
      )}
      <div className="form-acts">
        {scopes.length === 0 ? (
          <button type="submit" className="btn save">
            저장
          </button>
        ) : (
          <div className={scopes.length === 1 ? "scope one" : "scope"} role="group" aria-label="저장 범위">
            {scopes.includes("once") && (
              <button type="button" onClick={() => onSave("once")}>
                이번만
              </button>
            )}
            <button type="button" onClick={() => onSave("following")}>
              이후 모두
            </button>
          </div>
        )}
        <button type="button" className="ghost" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
