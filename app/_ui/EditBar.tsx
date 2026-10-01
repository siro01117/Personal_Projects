"use client";

// 고치기 도구 줄 (설계서 3장 "고치기 도구 줄"). 고치기 모드에서만 화면 아래 가운데에 떠 있다 — 모양은 globals.css .edit-bar.
// 아이콘만. 하는 일은 전부 ReportView 가 준다(onAct). 블록 영역(.doc-body) 밖에 그려서, 눌러도 고르기가 풀리지 않는다.

import { Icon, type IconName } from "./Icon";

export type EditAct = "undo" | "all" | "up" | "down" | "trash" | "done";

export type EditBarProps = {
  canUndo: boolean;
  allSelected: boolean;
  canUp: boolean;
  canDown: boolean;
  hasSelection: boolean;
  onAct: (act: EditAct) => void;
};

export function EditBar({ canUndo, allSelected, canUp, canDown, hasSelection, onAct, ...rest }: EditBarProps) {
  const items: { act: EditAct; icon: IconName; name: string; off?: boolean }[] = [
    { act: "undo", icon: "undo", name: "되돌리기", off: !canUndo },
    { act: "all", icon: "select", name: allSelected ? "고르기 풀기" : "전부 고르기" },
    { act: "up", icon: "asc", name: "위로", off: !canUp },
    { act: "down", icon: "desc", name: "아래로", off: !canDown },
    { act: "trash", icon: "trash", name: "고른 블록 지우기", off: !hasSelection },
    { act: "done", icon: "check", name: "완료" },
  ];
  return (
    // rest: 사라질 때 Presence 가 붙이는 data-leaving · inert
    <div className="edit-bar" role="toolbar" aria-label="고치기 도구" {...rest}>
      {items.map((it) => (
        <button
          key={it.act}
          type="button"
          className={it.act === "done" ? "done" : undefined}
          aria-label={it.name}
          title={it.name}
          aria-pressed={it.act === "all" ? allSelected : undefined}
          disabled={it.off}
          onClick={() => onAct(it.act)}
        >
          <Icon name={it.icon} />
        </button>
      ))}
    </div>
  );
}
