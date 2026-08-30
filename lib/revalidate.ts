// next/cache의 revalidatePath 심 — 서버 캐시가 없는 브라우저 데모에서는
// 대신 커스텀 이벤트를 쏴서, 그 경로를 보고 있는 클라 래퍼가 데이터를 다시 읽게 만든다.
export function revalidatePath(path: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("sq-revalidate", { detail: path }));
}
