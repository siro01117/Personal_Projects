"use client";

// 위쪽 경로. 길면 가운데를 … 로 접는다(누르면 접힌 폴더 목록). 끌어 놓을 자리이기도 하다.

import { useCallback, useState, type DragEvent } from "react";
import { collapseTrail } from "../_logic/drawer";
import { Icon } from "./Icon";
import { Menu, type MenuEntry } from "./Menu";

export type Crumb = { id: string | null; name: string; current?: boolean };

export type CrumbDrop = {
  /** 이 자리에 놓을 수 있는지 (끌고 있는 게 없으면 false) */
  can: (id: string | null) => boolean;
  drop: (id: string | null) => void;
};

export function Crumbs({ trail, onGo, dnd }: { trail: Crumb[]; onGo: (id: string | null) => void; dnd?: CrumbDrop }) {
  const [over, setOver] = useState<string | null | undefined>(undefined);
  const [more, setMore] = useState<{ x: number; y: number; hidden: Crumb[] } | null>(null);
  const closeMore = useCallback(() => setMore(null), []);

  const parts = collapseTrail(trail, 4);
  const dropProps = (c: Crumb) =>
    !dnd || c.current
      ? {}
      : {
          onDragOver: (e: DragEvent) => {
            if (!dnd.can(c.id)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOver(c.id);
          },
          onDragLeave: () => setOver(undefined),
          onDrop: (e: DragEvent) => {
            setOver(undefined);
            if (!dnd.can(c.id)) return;
            e.preventDefault();
            dnd.drop(c.id);
          },
        };

  const menuEntries: MenuEntry[] =
    more?.hidden.map((c) => ({ kind: "item", icon: "folder", label: c.name, run: () => onGo(c.id) })) ?? [];

  return (
    <>
    <nav className="crumbs" aria-label="위치">
      {parts.map((p, i) => {
        const sep = i > 0 && (
          <span className="sep" aria-hidden="true">
            <Icon name="right" />
          </span>
        );
        if (p.kind === "more") {
          return (
            <span key={`more-${i}`} style={{ display: "contents" }}>
              {sep}
              <button
                type="button"
                className="more"
                aria-label="가운데 경로"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMore({ x: r.left, y: r.bottom + 4, hidden: p.hidden });
                }}
              >
                …
              </button>
            </span>
          );
        }
        const c = p.item;
        return (
          <span key={`${c.id ?? "root"}-${i}`} style={{ display: "contents" }}>
            {sep}
            <button
              type="button"
              className={over !== undefined && over === c.id && !c.current ? "drop-over" : undefined}
              aria-current={c.current ? "page" : undefined}
              title={c.name}
              onClick={() => !c.current && onGo(c.id)}
              {...dropProps(c)}
            >
              {c.name}
            </button>
          </span>
        );
      })}
    </nav>
    {more && <Menu x={more.x} y={more.y} entries={menuEntries} onClose={closeMore} />}
    </>
  );
}
