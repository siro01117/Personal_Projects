"use client";

// 최초 부팅(getMe/ready) 동안 보여주는 진행 표시. 예전엔 "불러오는 중…" 한 줄이라 18초 가까이
// 화면이 멈춘 것처럼 보였다 — lib/db.ts의 실제 부팅 단계(onBootStage)에 연동해 지금 뭘 하고
// 있는지 보여준다(가짜 애니메이션 아님). 첫 방문(덤프 복원 필요)과 재방문(그냥 열기만)은
// 문구를 다르게 보여준다. 스타일은 인디고 톤 고정 — 이 컴포넌트는 sq.css가 로드되지 않는
// 화면(app/home)에서도 쓰이므로 CSS 변수에 기대지 않고 인라인으로 앱 톤을 그대로 박아둔다.
// 이모지 없음 — 라인 SVG 아이콘만.
import { useEffect, useState } from "react";
import { onBootStage, type BootStage } from "@/lib/db";

const STEPS: { key: BootStage; firstVisitLabel: string; returningLabel: string }[] = [
  { key: "checking", firstVisitLabel: "데모 환경 확인하는 중", returningLabel: "데모 환경 확인하는 중" },
  { key: "downloading", firstVisitLabel: "데이터베이스 내려받는 중", returningLabel: "데이터베이스 여는 중" },
  { key: "restoring", firstVisitLabel: "데이터 복원하는 중", returningLabel: "데이터 복원하는 중" },
  { key: "preparing", firstVisitLabel: "준비하는 중", returningLabel: "준비하는 중" },
  { key: "ready", firstVisitLabel: "화면 그리는 중", returningLabel: "화면 그리는 중" },
];

// 재방문 시에는 대부분 downloading/restoring 단계를 거치지 않으므로(이미 idb에 데이터가 있음)
// 표시에서 뺀다 — 있지도 않은 단계가 잠깐 보였다 사라지는 깜빡임을 막는다.
const RETURNING_STEP_KEYS = new Set<BootStage>(["checking", "preparing", "ready"]);

export default function BootProgress() {
  const [{ stage, firstVisit }, setState] = useState<{ stage: BootStage; firstVisit: boolean }>({
    stage: "checking",
    firstVisit: false,
  });

  useEffect(() => onBootStage((s, fv) => setState({ stage: s, firstVisit: fv })), []);

  const steps = firstVisit ? STEPS : STEPS.filter((s) => RETURNING_STEP_KEYS.has(s.key));
  const curIdx = Math.max(0, steps.findIndex((s) => s.key === stage));

  // 덤프(tgz) 파일 preload는 "이번이 복원이 필요한 최초 방문"일 때만 건다 — 무조건 걸면
  // 재방문(idb에 이미 데이터가 있어 덤프가 전혀 필요 없는 경우)에도 5MB를 매번 다시 받아버려
  // 오히려 재방문 속도를 깎아먹는다(실측으로 발견). lib/db.ts가 hasExisting 판정을 마치고
  // firstVisit=true 로 알려준 뒤에만 렌더한다 — db.ts의 fetch()보다 아주 살짝 먼저 걸리거나
  // 거의 동시에 걸려 JS 파싱과 병렬 다운로드가 되는 정도로 충분하다(중복 요청은 브라우저가
  // 같은 preload 캐시 엔트리를 재사용해 실제로 두 번 받지 않는다).
  return (
    <div style={S.wrap}>
      {firstVisit && <link rel="preload" href="/demo-db/studycube.tgz" as="fetch" crossOrigin="anonymous" />}
      <div style={S.spinner} aria-hidden>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2.2" strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-9-9" />
        </svg>
      </div>
      <div style={S.label}>{firstVisit ? steps[curIdx]?.firstVisitLabel : steps[curIdx]?.returningLabel}</div>
      <div style={S.dots}>
        {steps.map((s, i) => (
          <span key={s.key} style={{ ...S.dot, background: i <= curIdx ? "#4f46e5" : "#e4e6ee" }} />
        ))}
      </div>
      {firstVisit && <div style={S.hint}>처음 방문이라 데모 데이터를 내려받고 있어요. 다음부터는 바로 열립니다.</div>}
      <style>{`@keyframes sq-boot-spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    minHeight: "100dvh",
    width: "100%",
    padding: 24,
    fontFamily: "'Pretendard','Malgun Gothic',system-ui,-apple-system,sans-serif",
  },
  spinner: {
    width: 40,
    height: 40,
    display: "grid",
    placeItems: "center",
    animation: "sq-boot-spin 0.9s linear infinite",
  },
  label: { fontSize: 14, fontWeight: 600, color: "#171a22" },
  dots: { display: "flex", gap: 6, marginTop: 2 },
  dot: { width: 6, height: 6, borderRadius: "50%", transition: "background 0.25s ease" },
  hint: { fontSize: 12, color: "#98a2b3", marginTop: 4, textAlign: "center", maxWidth: 260 },
};
