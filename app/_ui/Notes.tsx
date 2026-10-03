"use client";

// 방명록 · 댓글 (설계서 7-5장) — 공개 페이지와 주인 화면이 같이 쓰는 조각. 모양은 globals.css 의 .notes · .note-in · .cmt · .cmt-n.
//  - NoteInput: 적는 칸. Enter 저장 · Shift+Enter 줄바꿈 · 한글 조합 중 무시 · Esc 취소 (Blocks 의 Field 와 같은 규칙 — enterAction)
//  - NoteList: 글 목록 — 라벨 · 상대 시간 · 지금과 다른 버전이면 옅은 v12 · 글. 글은 텍스트로만 그린다. 고칠 수 있는 글은 고치기 · 지우기
//  - Thread: 블록 옆에 펼쳐지는 댓글 줄 = 목록 + 적는 칸. 누르기가 블록(접기)으로 번지지 않게 막는다

import { useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { toKorean } from "../../lib/errors";
import { charCount } from "../../lib/names";
import type { NoteRow } from "../_data/types";
import { NOTE_MAX, noteLabel, versionLabel } from "../_logic/notes";
import { seenAgo } from "../_logic/views";
import { enterAction } from "./Blocks";

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
