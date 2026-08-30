"use client";

// 도시락 관리 화면 — 원본 Electron 앱("도시락앱") 렌더러를 글자 그대로 이식한 데모.
// _demo/** 는 원본 렌더러 코드(복제) + localStorage 기반 데이터 어댑터(api.ts)다.
// App(_demo/App.tsx)이 렌더 중 new Date() 를 직접 쓰기 때문에(하이드레이션 깨짐 방지) SSR을
// 완전히 끄고(next/dynamic ssr:false) 클라이언트에서만 마운트한다.
import dynamic from "next/dynamic";

const DosirakApp = dynamic(() => import("./_demo/Client"), { ssr: false });

export default function MealDemo() {
  return (
    <div className="dsk" style={{ height: "100dvh" }}>
      <DosirakApp />
    </div>
  );
}
