"use client";

// 읽은 사람 — 주인 화면의 조각들 (설계서 7-4장). 모양은 globals.css 의 .av · .avrow · .views-pop · .peers 를 같이 본다.
//  - Avatar: 동그란 아바타 (라벨 첫 글자, 키위 농담은 기기마다 다르게)
//  - ViewersButton: 위쪽 도구 줄 — 지금 보는 사람이 있으면 아바타 줄(4명 넘으면 +n), 없으면 눈 아이콘만
//  - ViewsPop: 작은 창 — 지금 보는 중(라벨 · 보고 있는 절) / 본 사람(라벨 · 마지막 · 읽은 시간 · 횟수, 20줄 넘으면 더 보기)
//  - PeerMarks: 블록 왼쪽 여백의 작은 아바타 — 그 사람이 보는 블록 자리로 transform 으로 옮겨 간다 (docs/모션.md)

import { useLayoutEffect, useState, type CSSProperties, type Ref, type RefObject } from "react";
import type { ViewRow } from "../_data/types";
import { avatarRow, avatarText, avatarTone, byBlock, HISTORY_FIRST, readTime, sectionTitle, seenAgo, viewerLabel, type LivePerson } from "../_logic/views";
import { Icon } from "./Icon";

export function Avatar({ person, small = false }: { person: LivePerson; small?: boolean }) {
  return (
    <span className={`av t${avatarTone(person.device)}${small ? " sm" : ""}`} title={person.label} aria-label={person.label} role="img">
      {avatarText(person.label)}
    </span>
  );
}

export type ViewersButtonProps = {
  live: readonly LivePerson[];
  open: boolean;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
};

export function ViewersButton({ live, open, onClick, ref }: ViewersButtonProps) {
  if (live.length === 0) {
    return (
      <button type="button" ref={ref} className="iconbtn" aria-expanded={open} aria-pressed={open} aria-label="읽은 사람" title="읽은 사람" onClick={onClick}>
        <Icon name="eye" />
      </button>
    );
  }
  const { shown, more } = avatarRow(live);
  const label = `지금 보는 중 ${live.length}명`;
  return (
    <button type="button" ref={ref} className="avrow" aria-expanded={open} aria-pressed={open} aria-label={label} title={label} onClick={onClick}>
      {shown.map((p) => (
        <Avatar key={p.device} person={p} />
      ))}
      {more > 0 && <span className="av more num">+{more}</span>}
    </button>
  );
}

export type ViewsPopProps = {
  live: readonly LivePerson[];
  rows: readonly ViewRow[];
  /** 차례 (블록 번호 → 절 제목) */
  toc: readonly [number, string][];
  now: Date;
  expanded: boolean;
  onMore: () => void;
  ref?: Ref<HTMLDivElement>;
};

export function ViewsPop({ live, rows, toc, now, expanded, onMore, ref }: ViewsPopProps) {
  const shown = expanded ? rows : rows.slice(0, HISTORY_FIRST);
  return (
    <div className="share-pop views-pop" ref={ref} role="dialog" aria-label="읽은 사람">
      {live.length === 0 && rows.length === 0 ? (
        <p className="none">아직 아무도 안 봤습니다</p>
      ) : (
        <>
          {live.length > 0 && (
            <ul className="vp-live">
              {live.map((p) => (
                <li key={p.device}>
                  <Avatar person={p} small />
                  <span className="nm">{p.label}</span>
                  {p.block !== null && <span className="at">{sectionTitle(toc, p.block)}</span>}
                </li>
              ))}
            </ul>
          )}
          {live.length > 0 && rows.length > 0 && <hr />}
          {rows.length > 0 && (
            <ul className="vp-hist">
              {shown.map((r) => (
                <li key={r.id}>
                  <span className="nm">{viewerLabel(r)}</span>
                  <span className="at">{seenAgo(r.last_at, now)}</span>
                  <span className="at">{readTime(r.seconds)}</span>
                  <span className="n num">{r.hits}회</span>
                </li>
              ))}
            </ul>
          )}
          {rows.length > HISTORY_FIRST && !expanded && (
            <button type="button" className="more" onClick={onMore}>
              더 보기
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** 사람마다 (블록 번호 → 종이 안 세로 위치) 를 재서 아바타를 그 자리로 옮긴다 (--y · 같은 블록 안 순서 --k, 자리는 CSS 가 transform 으로). 블록이 없는 사람(위치 모름)은 안 그린다 */
export function PeerMarks({ live, page, blockCount }: { live: readonly LivePerson[]; page: RefObject<HTMLElement | null>; blockCount: number }) {
  const [tops, setTops] = useState<Record<number, number>>({});
  const groups = byBlock(live.filter((p) => p.block !== null && p.block < blockCount));
  const wanted = [...groups.keys()].sort((a, b) => a - b).join(",");

  useLayoutEffect(() => {
    const el = page.current;
    if (!el || wanted === "") return;
    const measure = () => {
      const base = el.getBoundingClientRect().top;
      const next: Record<number, number> = {};
      for (const i of wanted.split(",").map(Number)) {
        const b = document.getElementById(`b${i}`);
        if (b) next[i] = Math.round(b.getBoundingClientRect().top - base);
      }
      setTops((cur) => (Object.keys(next).every((k) => cur[Number(k)] === next[Number(k)]) && Object.keys(cur).length === Object.keys(next).length ? cur : next));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [page, wanted, blockCount]);

  if (groups.size === 0) return null;
  return (
    <div className="peers" aria-hidden="true">
      {[...groups].flatMap(([block, people]) =>
        people.map((p, k) =>
          tops[block] === undefined ? null : (
            <span key={p.device} className="peer" style={{ "--k": k, "--y": `${tops[block]}px` } as CSSProperties}>
              <Avatar person={p} small />
            </span>
          ),
        ),
      )}
    </div>
  );
}
