"use client";
// 스터디큐브 좌석 콕핏 라이브 데모 — 실제 운영 코드(FloorEditor)를 그대로 이식하고, 서버 액션/DB 자리를
// 클라이언트 인메모리 스토어(src/lib/store.ts)로 대체했다. 데이터는 전부 더미이며 새로고침하면 리셋된다.
import { useSyncExternalStore, useMemo } from "react";
import FloorEditor from "./src/app/m/seat/FloorEditor";
import { subscribe, getSnapshot } from "./src/lib/store";
import { minuteOfKST } from "./src/lib/date";

export default function StudyCubeDemoPage() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const serverNowMin = useMemo(() => minuteOfKST(new Date().toISOString()), []);

  return (
    <div className="sqdemo">
      <div className="sqdemo-banner">
        <span>실제 운영 중인 앱의 코드를 그대로 옮긴 데모입니다 — 데이터는 전부 더미이며 새로고침하면 초기화됩니다</span>
        <a href="/" className="sqdemo-back">← Ra_Kan</a>
      </div>
      <main style={{ height: "calc(100dvh - 40px)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)" }}>
          <div className="flex items-center justify-between px-5" style={{ height: 56 }}>
            <div className="flex items-center gap-3">
              <span style={{ fontWeight: 700 }}>좌석 배치도</span>
              <span className="chip">데모 지점</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="hide-mobile" style={{ fontSize: 12.5, color: "var(--dim)" }}>
                {snap.rooms.length}개 방 · 좌석 {snap.seats.length}
              </span>
            </div>
          </div>
        </header>

        <FloorEditor
          key={snap.initialRoomId ?? "none"}
          rooms={snap.rooms}
          seats={snap.seats}
          students={snap.students}
          canManage={true}
          canEditStudent={true}
          initialRoomId={snap.initialRoomId}
          occupancy={snap.occupancy}
          canAttend={true}
          canPatrol={true}
          lastPatrolAt={snap.lastPatrolAt}
          openSession={null}
          scheduleMap={snap.scheduleMap}
          periods={snap.periods}
          actual={snap.actual}
          serverNowMin={serverNowMin}
        />
      </main>
    </div>
  );
}
