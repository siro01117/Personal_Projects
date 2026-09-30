"use client";

// 휴지통 (설계서 7-1장). 지운 묶음 목록 → 묶음째 복원. 영구 삭제는 다음 단계.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TrashRow } from "../_data/types";
import { formatWhen, groupTrash, restoreNote, trashLabel } from "../_logic/drawer";
import { Crumbs } from "./Crumbs";
import { useDrawer } from "./DrawerContext";
import { Icon } from "./Icon";
import { HomeButton } from "./Shell";
import { useToast } from "./Toast";

export function TrashView() {
  const { data, tick, rev, fail, refreshFolders } = useDrawer();
  const toast = useToast();
  const [rows, setRows] = useState<TrashRow[] | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const r = await data.trash();
      if (seq === loadSeq.current) setRows(r);
    } catch (e) {
      if (seq === loadSeq.current) fail(e);
    }
  }, [data, fail]);

  useEffect(() => {
    void load();
  }, [load, tick, rev]);

  async function restore(batch: string) {
    const tops = (rows ?? []).filter((r) => r.batch === batch).map((r) => r.id);
    setRows((prev) => prev && prev.filter((r) => r.batch !== batch));
    try {
      const res = await data.restore(batch);
      const note = restoreNote(res, tops);
      if (note) toast(note);
      void refreshFolders();
    } catch (e) {
      fail(e);
    }
    await load();
  }

  const groups = rows ? groupTrash(rows) : [];

  return (
    <>
      <div className="bar-top">
        <HomeButton />
        <Crumbs trail={[{ id: null, name: "휴지통", current: true }]} onGo={() => {}} />
      </div>
      {rows === null ? null : groups.length === 0 ? (
        <div className="empty">휴지통이 비어 있습니다</div>
      ) : (
        <ul className="trash">
          {groups.map((g) => (
            <li key={g.batch}>
              <Icon name={g.first.kind === "folder" ? "folder" : "rep"} className="ico" />
              <span className="nm">{trashLabel(g.first.name, g.tops)}</span>
              <span className="when">{formatWhen(g.deleted_at)}</span>
              <button type="button" className="btn" onClick={() => void restore(g.batch)}>
                복원
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
