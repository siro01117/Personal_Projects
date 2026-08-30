"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// 구 데모 경로 — 새 아키텍처(app/m/*)로 이전됨. 들어오는 링크 보호용 리다이렉트만 남겨둠.
export default function StudycubeDemoRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/m/seat");
  }, [router]);
  return null;
}
