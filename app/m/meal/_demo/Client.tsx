"use client";

// _demo/App.tsx(원본 도시락앱 렌더러, verbatim 이식)를 마운트하기 전에 window.api 를
// installDemoApi() 로 채워 넣는다. 이 파일 자체는 원본 코드가 아니라 이식을 위한 접착 코드다.
// App은 렌더 중 new Date() 를 쓰므로(App.tsx L20) SSR 되면 하이드레이션이 깨진다 — 이 컴포넌트는
// 부모(../MealDemo.tsx)에서 next/dynamic(ssr:false)로만 로드되어 항상 클라이언트에서만 실행된다.
import { useEffect, useState } from "react";
import App from "./App";
import { installDemoApi } from "./api";

export default function Client() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    installDemoApi();
    setReady(true);
  }, []);

  if (!ready) return null;
  return <App />;
}
