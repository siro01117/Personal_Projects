"use client";

// 방명록 · 댓글 (설계서 7-5장) — 공개 페이지와 주인 화면이 같이 쓰는 조각. 모양은 globals.css 의 .notes · .note-in · .cmt · .cmt-n.
//  - NoteInput: 적는 칸. Enter 저장 · Shift+Enter 줄바꿈 · 한글 조합 중 무시 · Esc 취소 (Blocks 의 Field 와 같은 규칙 — enterAction)
//  - NoteList: 글 목록 — 라벨 · 상대 시간 · 지금과 다른 버전이면 옅은 v12 · 글. 글은 텍스트로만 그린다. 고칠 수 있는 글은 고치기 · 지우기
//  - Thread: 블록 옆에 펼쳐지는 댓글 줄 = 목록 + 적는 칸. 누르기가 블록(접기)으로 번지지 않게 막는다
//  - useSideNotes · SidePanel (설계서 7-6장): 종이 폭 760 이상이면 댓글 줄을 블록 아래가 아니라 블록 옆 패널에.
//    종이는 왼쪽으로 밀리고(transform) 패널은 블록 높이에(transform). Esc · 빈 곳 누르기로 닫는다. 자리 계산은 _logic/notes 의 sidePlace

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { toKorean } from "../../lib/errors";
import { charCount } from "../../lib/names";
import type { NoteRow } from "../_data/types";
import { NOTE_MAX, noteLabel, SIDE, sidePlace, versionLabel, type SidePlace } from "../_logic/notes";
import { seenAgo } from "../_logic/views";
import { enterAction } from "./Blocks";
import { Presence } from "./motion/Presence";

export type NoteInputProps = {
  placeholder: string;
  /** 고치기 — 있으면 그 글로 시작하고 저장 뒤 비우지 않는다 */
  initial?: string;
  autoFocus?: boolean;
  ariaLabel: string;
  /** 저장. 실패하면 던진다 — 칸 아래에 한국어로 보인다 */
  onSave: (body: string) => Promise<void>;
  onCancel?: () => void;
  /** 단추 옆에 두는 것 ("이름 적기") */
  aside?: ReactNode;
};

export function NoteInput({ placeholder, initial, autoFocus, ariaLabel, onSave, onCancel, aside }: NoteInputProps) {
  const [text, setText] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editing = initial !== undefined;

  async function save() {
    const body = text.trim();
    if (body === "" || busy) return;
    if (charCount(body) > NOTE_MAX) return setErr(`글은 ${NOTE_MAX}자까지입니다`);
    setBusy(true);
    setErr(null);
    try {
      await onSave(body);
      if (!editing) setText("");
    } catch (e) {
      setErr(toKorean(e).message);
    } finally {
      setBusy(false);
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Enter") return;
    const act = enterAction({ shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, composing: e.nativeEvent.isComposing || e.keyCode === 229 }, false);
    if (act === "ignore" || act === "break") return; // 줄바꿈은 textarea 가 한다
    e.preventDefault();
    void save();
  };

  return (
    <form
      className="note-in"
      aria-label={ariaLabel}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <textarea
        className="note-ta"
        rows={1}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        value={text}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setErr(null);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="note-acts">
        <button type="submit" className="btn" disabled={busy || text.trim() === ""}>
          {editing ? "저장" : "남기기"}
        </button>
        {onCancel && (
          <button type="button" className="lnk" onClick={onCancel}>
            취소
          </button>
        )}
        {aside}
      </div>
      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}
    </form>
  );
}

export type NoteListProps = {
  notes: readonly NoteRow[];
  /** 보고서의 지금 버전 — 다르면 v12 */
  current: number;
  /** 주인 글의 이름 (공개 페이지 "주인" · 주인 화면 "나") */
  ownerLabel: string;
  now: Date;
  canEdit?: (n: NoteRow) => boolean;
  canDelete?: (n: NoteRow) => boolean;
  onEdit?: (id: string, body: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  /** 글 위에 자리 글자 (주인 창의 댓글 칸: 블록 제목 · "원래 n번째 블록") */
  place?: (n: NoteRow) => ReactNode;
  small?: boolean;
};

export function NoteList({ notes, current, ownerLabel, now, canEdit, canDelete, onEdit, onDelete, place, small }: NoteListProps) {
  if (notes.length === 0) return null;
  return (
    <ul className={small ? "notes sm" : "notes"}>
      {notes.map((n) => (
        <NoteItem
          key={n.id}
          n={n}
          current={current}
          ownerLabel={ownerLabel}
          now={now}
          place={place?.(n)}
          onEdit={canEdit?.(n) ? onEdit : undefined}
          onDelete={canDelete?.(n) ? onDelete : undefined}
        />
      ))}
    </ul>
  );
}

function NoteItem({
  n,
  current,
  ownerLabel,
  now,
  place,
  onEdit,
  onDelete,
}: {
  n: NoteRow;
  current: number;
  ownerLabel: string;
  now: Date;
  place?: ReactNode;
  onEdit?: (id: string, body: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ver = versionLabel(n.version, current);
  return (
    <li className={n.by_owner ? "note owner" : "note"}>
      {place}
      <div className="nh">
        <span className="nm">{noteLabel(n, ownerLabel)}</span>
        <span className="at">{seenAgo(n.created_at, now)}</span>
        {ver && <span className="ver num">{ver}</span>}
        {onEdit && !editing && (
          <button type="button" className="lnk" onClick={() => setEditing(true)}>
            고치기
          </button>
        )}
        {onDelete && !editing && (
          <button
            type="button"
            className="lnk"
            onClick={() => {
              setErr(null);
              onDelete(n.id).catch((e) => setErr(toKorean(e).message));
            }}
          >
            지우기
          </button>
        )}
      </div>
      {editing && onEdit ? (
        <NoteInput
          initial={n.body}
          placeholder=""
          ariaLabel="글 고치기"
          autoFocus
          onSave={async (body) => {
            await onEdit(n.id, body);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <p className="nb">{n.body}</p>
      )}
      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}
    </li>
  );
}

export type ThreadProps = Omit<NoteListProps, "small" | "place"> & {
  /** 적기. 없으면 적는 칸이 없다 (주인 본인 · 꺼진 링크) */
  onWrite?: (body: string) => Promise<void>;
  aside?: ReactNode;
  ref?: Ref<HTMLDivElement>;
};

/** 블록 옆(아래)에 펼쳐지는 댓글 줄. 적는 칸에 바로 초점 */
export function Thread({ onWrite, aside, ref, ...list }: ThreadProps) {
  return (
    <div className="cmt" ref={ref} onClick={(e) => e.stopPropagation()}>
      <NoteList {...list} small />
      {onWrite && <NoteInput placeholder="댓글" ariaLabel="댓글" autoFocus onSave={onWrite} aside={aside} />}
    </div>
  );
}

// ------------------------------------------------------------ 블록 옆 패널 (설계서 7-6장)

const samePlace = (a: SidePlace | null, b: SidePlace | null) => a === b || (!!a && !!b && a.shift === b.shift && a.x === b.x && a.y === b.y && a.width === b.width);

/**
 * 종이(pageRef — doc-body 의 바로 아래 자식)를 재서 댓글을 옆 패널로 펼칠지 정한다.
 * wide: 종이가 넓다(펼친 블록이 없어도) — 이때 Blocks 는 블록 아래에 댓글 줄을 그리지 않는다.
 * place: 펼친 블록이 있으면 종이를 밀 거리와 패널 자리. 종이 · doc-body 의 크기가 바뀌면(사진이 들어옴 · 창 크기) 다시 잰다.
 * 펼친 동안 Esc(다른 데서 쓰지 않았으면) · 블록과 패널 바깥 누르기 = onClose
 */
export function useSideNotes(pageRef: RefObject<HTMLElement | null>, open: number | null, enabled: boolean, onClose: () => void): { wide: boolean; place: SidePlace | null } {
  const [wide, setWide] = useState(false);
  const [place, setPlace] = useState<SidePlace | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // 종이의 원래 폭 — 자리가 모자라 좁혔을 때 다시 재면 좁힌 값이 나와 계산이 흔들리므로, 좁히기 전 값을 기억한다
  const natural = useRef<number | null>(null);

  useLayoutEffect(() => {
    const page = pageRef.current;
    const body = page?.parentElement;
    if (!enabled || !page || !body) {
      setWide(false);
      setPlace(null);
      return;
    }
    const measure = () => {
      const narrowed = page.style.maxWidth !== "";
      const w = narrowed && natural.current !== null ? natural.current : page.offsetWidth;
      if (!narrowed) natural.current = w;
      setWide(w >= SIDE.minPage);
      const blk = open === null ? null : document.getElementById(`b${open}`);
      if (!blk) return setPlace(null);
      // offsetLeft 는 transform(밀린 거리)을 빼고 잰 값이다
      const left = page.offsetParent === body ? page.offsetLeft : page.offsetLeft - body.offsetLeft;
      const top = blk.getBoundingClientRect().top - page.getBoundingClientRect().top;
      const at = sidePlace({ body: body.clientWidth, left, page: w, top });
      // 패널(absolute)의 기준은 종이의 테두리 안쪽이다
      const next = at && { ...at, x: at.x - page.clientLeft, y: Math.max(0, at.y - page.clientTop) };
      setPlace((cur) => (samePlace(cur, next) ? cur : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(page);
    ro.observe(body);
    return () => ro.disconnect();
  }, [pageRef, open, enabled]);

  const shown = wide ? place : null;
  const on = shown !== null;
  useEffect(() => {
    if (!on) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // 초점은 그 블록의 댓글 수로 돌려 둔다 (패널은 사라진다)
      if (open !== null) document.querySelector<HTMLElement>(`#b${open} > .cmt-n`)?.focus({ preventScroll: true });
      close.current();
    };
    const down = (e: globalThis.PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      // 블록 누르기는 블록이 정한다(다른 블록으로 옮김 · 같은 블록이면 닫힘). 링크 미리보기 · 크게 보기 안도 아니다
      if (t?.closest(".cmt-side, [data-cmt], .cite-pop, .lightbox")) return;
      close.current();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", down);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", down);
    };
  }, [on, open]);

  return { wide, place: shown };
}

/**
 * 종이 안(맨 끝)에 두는 패널. 자리는 transform 하나 — 다른 블록으로 옮기면 세로로 미끄러진다.
 * 들어올 때 오른쪽 16px 에서 + 불투명도(globals.css .cmt-card), 나갈 때 거꾸로(Presence). 내용은 블록마다 새로(at)
 */
export function SidePanel({ place, at, children }: { place: SidePlace | null; at: number | null; children: ReactNode }) {
  return (
    <Presence>
      {place && (
        <aside className="cmt-side" aria-label="댓글" style={{ transform: `translate3d(${place.x}px,${place.y}px,0)` }}>
          <div className="cmt-card">
            <Fragment key={at ?? -1}>{children}</Fragment>
          </div>
        </aside>
      )}
    </Presence>
  );
}
