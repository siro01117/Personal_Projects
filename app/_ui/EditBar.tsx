"use client";

// 고치기 도구 줄 (설계서 3장 "고치기 도구 줄"). 고치기 모드에서만 종이 왼쪽에 세로로 서서 따라온다(좁으면 오른쪽 아래) — 모양은 globals.css .edit-bar.
// 아이콘만: 휴지통 · 위로 · 아래로 · 완료. 하는 일은 전부 ReportView 가 준다(onAct). 눌러도 고르기가 풀리지 않는다(useArrange 가 .edit-bar 를 뺀다).

import { Icon, type IconName } from "./Icon";

export type EditAct = "up" | "down" | "trash" | "done";

export type EditBarProps = {
  canUp: boolean;
  canDown: boolean;
  hasSelection: boolean;
  onAct: (act: EditAct) => void;
};

export function EditBar({ canUp, canDown, hasSelection, onAct, ...rest }: EditBarProps) {
  const items: { act: EditAct; icon: IconName; name: string; off?: boolean }[] = [
    { act: "trash", icon: "trash", name: "고른 블록 지우기", off: !hasSelection },
    { act: "up", icon: "asc", name: "위로", off: !canUp },
    { act: "down", icon: "desc", name: "아래로", off: !canDown },
    { act: "done", icon: "check", name: "완료" },
  ];
  return (
    <div className="edit-bar" role="toolbar" aria-orientation="vertical" aria-label="고치기 도구" {...rest}>
      {items.map((it) => (
        <button
          key={it.act}
          type="button"
          className={it.act === "done" ? "done" : undefined}
          aria-label={it.name}
          title={it.name}
          disabled={it.off}
          onClick={() => onAct(it.act)}
        >
          <Icon name={it.icon} />
        </button>
      ))}
    </div>
  );
}
