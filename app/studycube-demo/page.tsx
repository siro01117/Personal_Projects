"use client";
// 시드 데이터(src/lib/seed.ts)가 "지금 시각"을 기준으로 생성되므로 서버(SSR)와 클라이언트가 각각
// 다른 시각에 평가하면 하이드레이션 불일치가 난다 — ssr:false 로 완전히 클라이언트에서만 평가·렌더한다.
import dynamic from "next/dynamic";

const DemoClient = dynamic(() => import("./DemoClient"), { ssr: false });

export default function StudyCubeDemoPage() {
  return <DemoClient />;
}
