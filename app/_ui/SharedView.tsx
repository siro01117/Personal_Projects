"use client";

// 공유 페이지 — 로그인 없이 ez_shared 로 읽기만. 없거나 꺼졌거나 지웠으면 한 줄 (있었는지 드러내지 않는다).

import { useEffect, useState } from "react";
import { toKorean } from "../../lib/errors";
import { useSource } from "../_data/source";
import type { SharedDoc } from "../_data/types";
import { formatDay } from "../_logic/drawer";
import { Blocks } from "./Blocks";
import { Rail, RAIL_MIN } from "./ReportView";

export function SharedView({ token }: { token: string }) {
  const src = useSource();
  const [doc, setDoc] = useState<SharedDoc | null | "gone">(null);
  const [netError, setNetError] = useState<string | null>(null);

  useEffect(() => {
    if (!src) return;
    let alive = true;
    src.data.shared(token).then(
      (d) => alive && setDoc(d ?? "gone"),
      (e) => {
        if (!alive) return;
        // 연결 실패만 따로 알린다. 그 밖의 실패는 없는 링크와 똑같이 (있었는지 드러내지 않는다)
        const k = toKorean(e);
        if (k.code === "NETWORK") setNetError(k.message);
        setDoc("gone");
      },
    );
    return () => {
      alive = false;
    };
  }, [src, token]);

  if (doc === null) return null;
  if (doc === "gone") {
    return (
      <div className="app">
        <div className="gone">{netError ?? "없는 링크입니다"}</div>
      </div>
    );
  }
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  const rail = blocks.length >= RAIL_MIN;
  return (
    <div className="app shared">
      <div className={rail ? "doc-body view" : "doc-body no-rail view"}>
        <article className="page">
          <div className="blk b-head">
            <h1>{doc.name}</h1>
            <div className="by">{formatDay(doc.updated_at)}</div>
          </div>
          <Blocks blocks={blocks} />
        </article>
        {rail && <Rail blocks={blocks} />}
      </div>
    </div>
  );
}
