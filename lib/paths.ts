// 서랍 경로: `/` 는 맨 위, `/EZ.WORK 준비/APPTIVE` 처럼 이름을 `/` 로 잇는다.

import { normalizeName, validateName } from "./names";

export class PathError extends Error {
  override name = "PathError";
}

/** '/a/b' → ['a', 'b']. '/' → []. 끝 슬래시 허용. 규칙에 어긋나면 PathError(한국어) */
export function parsePath(path: string): string[] {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new PathError("경로는 / 로 시작해야 합니다 (예: /폴더/보고서)");
  }
  if (path === "/") return [];
  const body = path.slice(1).replace(/\/$/, ""); // 끝 슬래시 하나는 허용
  return body.split("/").map((raw, i) => {
    const seg = normalizeName(raw);
    if (seg === "") throw new PathError(`경로 ${i + 1}번째 조각이 비어 있습니다 (// 는 쓸 수 없습니다)`);
    if (seg === "." || seg === "..") throw new PathError(`경로에 ${seg} 는 쓸 수 없습니다`);
    const err = validateName(seg);
    if (err) throw new PathError(`경로 ${i + 1}번째 조각: ${err}`);
    return seg;
  });
}

/** ['a', 'b'] → '/a/b', [] → '/' */
export function formatPath(segments: readonly string[]): string {
  return "/" + segments.join("/");
}
