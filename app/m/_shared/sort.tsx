"use client";

// 관리 화면 목록 공용 정렬 유틸 — 머리글 클릭(표) 또는 상단 선택기(카드 목록)로 속성별 정렬.
// 규칙: 문자열은 한글이 자연스럽게 정렬되도록 localeCompare(b,"ko"). 숫자·날짜(YYYY-MM-DD 문자열
// 포함)는 값 비교. null·빈 값은 방향과 무관하게 항상 뒤로. 같은 값이면 원래 순서 유지(안정 정렬).
// 정렬 상태는 화면별로 localStorage 에 저장해 새로고침해도 유지한다(렌더 중 접근 금지 — useEffect 에서만).
import { useEffect, useMemo, useState } from "react";

export type SortDir = "asc" | "desc";
export type SortValueType = "string" | "number";

export type SortColumn<T> = {
  key: string;
  label: string;
  /** 정렬 비교에 쓸 값. null/undefined/빈 문자열이면 항상 뒤로 보낸다. */
  sortValue: (row: T) => string | number | null | undefined;
  type?: SortValueType; // 기본 "string"
};

type SortState = { key: string; dir: SortDir };

const storageKeyOf = (screenKey: string) => `sc-sort:${screenKey}`;

function isEmpty(v: string | number | null | undefined): boolean {
  return v == null || v === "";
}

export function useSort<T>(
  rows: T[],
  columns: SortColumn<T>[],
  defaultKey: string,
  screenKey?: string,
  defaultDir: SortDir = "asc",
): {
  sorted: T[];
  sortKey: string;
  sortDir: SortDir;
  columns: SortColumn<T>[];
  requestSort: (key: string) => void;
} {
  const [state, setState] = useState<SortState>({ key: defaultKey, dir: defaultDir });

  // localStorage 는 렌더 중이 아니라 마운트 이후에만 읽는다(SSR/hydration 안전).
  useEffect(() => {
    if (!screenKey) return;
    try {
      const raw = window.localStorage.getItem(storageKeyOf(screenKey));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<SortState>;
      if (parsed && typeof parsed.key === "string" && (parsed.dir === "asc" || parsed.dir === "desc")) {
        setState({ key: parsed.key, dir: parsed.dir });
      }
    } catch {
      // 저장값이 깨졌으면 기본값을 그대로 쓴다.
    }
    // screenKey 는 화면당 상수라 사실상 마운트 1회.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenKey]);

  const requestSort = (key: string) => {
    setState((prev) => {
      const next: SortState = prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
      if (screenKey) {
        try {
          window.localStorage.setItem(storageKeyOf(screenKey), JSON.stringify(next));
        } catch {
          // 저장 실패(프라이빗 모드 등)는 무시 — 이번 세션 동안만 정렬이 유지된다.
        }
      }
      return next;
    });
  };

  const activeCol = columns.find((c) => c.key === state.key);

  const sorted = useMemo(() => {
    if (!activeCol) return rows;
    const type = activeCol.type ?? "string";
    const dirMul = state.dir === "asc" ? 1 : -1;
    return rows
      .map((row, i) => ({ row, i, v: activeCol.sortValue(row) }))
      .sort((a, b) => {
        const aEmpty = isEmpty(a.v);
        const bEmpty = isEmpty(b.v);
        if (aEmpty || bEmpty) {
          if (aEmpty && bEmpty) return a.i - b.i; // 안정 정렬
          return aEmpty ? 1 : -1; // null·빈 값은 항상 뒤로(방향 무관)
        }
        const cmp = type === "number" ? (a.v as number) - (b.v as number) : String(a.v).localeCompare(String(b.v), "ko");
        if (cmp !== 0) return cmp * dirMul;
        return a.i - b.i; // 값이 같으면 원래 순서 유지
      })
      .map((x) => x.row);
  }, [rows, activeCol, state.dir]);

  return { sorted, sortKey: state.key, sortDir: state.dir, columns, requestSort };
}

function SortArrow({ dir }: { dir: SortDir }) {
  return (
    <svg
      width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round"
      style={{ flex: "none", transform: dir === "desc" ? "rotate(180deg)" : "none" }}
      aria-hidden="true"
    >
      <path d="M5 8.5V1.5M5 1.5L2 4.5M5 1.5l3 3" />
    </svg>
  );
}

/** 표 머리글 셀 — 클릭하면 같은 키면 방향 토글, 다른 키면 그 키로 오름차순. 기존 th 스타일 위에
 *  cursor·select-none·aria-sort 만 얹는다(각 화면의 th 스타일 오브젝트를 thStyle 로 그대로 전달). */
export function SortHeader({
  label, sortKey, activeKey, dir, onSort, thStyle, align, title,
}: {
  label: React.ReactNode;
  sortKey: string;
  activeKey: string;
  dir: SortDir;
  onSort: (key: string) => void;
  thStyle?: React.CSSProperties;
  align?: "left" | "right" | "center";
  title?: string;
}) {
  const active = sortKey === activeKey;
  return (
    <th
      style={{ ...thStyle, cursor: "pointer", userSelect: "none", textAlign: align ?? thStyle?.textAlign ?? "left" }}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      title={title}
      onClick={() => onSort(sortKey)}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label}
        {active && <SortArrow dir={dir} />}
      </span>
    </th>
  );
}

/** 한 표 머리글 칸에 서로 다른 정렬 속성 여러 개를 나란히 보여줘야 할 때(예: "좌석·이름" 한 칸에
 *  좌석·이름 두 속성이 같이 표시되는 경우) 쓰는 클릭 가능한 인라인 라벨. SortHeader 와 달리 <th> 를
 *  직접 감싸지 않으므로, 감싸는 <th> 쪽에 aria-sort 를 별도로 붙여야 한다면 호출부에서 처리한다. */
export function SortLabel({
  label, sortKey, activeKey, dir, onSort,
}: {
  label: React.ReactNode;
  sortKey: string;
  activeKey: string;
  dir: SortDir;
  onSort: (key: string) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSort(sortKey); } }}
      style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer", userSelect: "none" }}
    >
      {label}
      {active && <SortArrow dir={dir} />}
    </span>
  );
}

/** 카드 나열형(표 아님) 화면 상단에 두는 작은 정렬 선택기 — "정렬: 이름 ▾". 드롭다운으로 기준 열을
 *  고르고, 화살표 버튼으로 방향을 뒤집는다(같은 키를 다시 넘기면 requestSort 가 알아서 토글한다). */
export function SortPicker({
  columns, activeKey, dir, onSort, ariaLabel,
}: {
  columns: { key: string; label: string }[];
  activeKey: string;
  dir: SortDir;
  onSort: (key: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--faint)", fontWeight: 600 }}>정렬</span>
      <select
        aria-label={ariaLabel ?? "정렬 기준"}
        className="input"
        value={activeKey}
        onChange={(e) => onSort(e.target.value)}
        style={{ height: 32, fontSize: 12.5, padding: "0 8px" }}
      >
        {columns.map((c) => (
          <option key={c.key} value={c.key}>{c.label}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onSort(activeKey)}
        aria-label={dir === "asc" ? "오름차순 정렬 중 — 눌러서 내림차순으로" : "내림차순 정렬 중 — 눌러서 오름차순으로"}
        style={{
          display: "inline-flex", width: 28, height: 28, alignItems: "center", justifyContent: "center",
          borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--sub)", cursor: "pointer",
        }}
      >
        <SortArrow dir={dir} />
      </button>
    </div>
  );
}
