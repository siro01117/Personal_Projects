"use client";

// 폰 폭이면 폰 전용 화면으로 보낸다. 데스크톱/패드는 그대로 데스크톱 화면 사용.
// (서버는 화면 크기를 모르므로 클라이언트에서 판별 — 640px 경계는 globals.css 와 동일.)
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function PhoneRedirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    if (window.matchMedia("(max-width: 640px)").matches) router.replace(to);
  }, [router, to]);
  return null;
}
