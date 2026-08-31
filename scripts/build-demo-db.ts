// 빌드 시점에 데모 DB를 미리 시드해 public/demo-db/studycube.tgz 로 저장한다.
//
// 왜: 브라우저 첫 방문 때 PGlite 위에서 스키마 DDL + 시드 INSERT를 수백 번 왕복시키면(순수
// bootstrap.ts만으로) 첫 렌더까지 18초 넘게 걸린다(실측). 여기서 미리 Node 안에서 같은 부팅
// 경로(bootstrap.ts의 ready())를 한 번 돌려 결과를 tar.gz로 굳혀두면, 브라우저는 그 파일을
// 내려받아 PGlite에 loadDataDir로 통째로 복원하기만 하면 된다(lib/db.ts).
//
// 핵심: bootstrap.ts/seed-demo.ts는 한 글자도 건드리지 않는다 — lib/db.ts의 __setPgInstance()로
// Node에서 만든 PGlite 인스턴스를 db.ts의 싱글턴 자리에 꽂아 넣으면, 두 파일이 그대로 이 인스턴스
// 위에서 실행된다(브라우저 코드와 완전히 동일한 경로 = 스키마·시드 드리프트 걱정 없음).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { __setPgInstance } from "../lib/db";
import { ready } from "../lib/bootstrap";

async function main() {
  console.log("[build-demo-db] Node PGlite(in-memory) 기동...");
  const pg = await PGlite.create();
  __setPgInstance(pg);

  console.log("[build-demo-db] bootstrap.ready() — 스키마·권한·모듈·마스터 계정·데모 시드 실행...");
  const t0 = Date.now();
  await ready();
  console.log(`[build-demo-db] 시드 완료 (${Date.now() - t0}ms)`);

  console.log("[build-demo-db] dumpDataDir(gzip)...");
  const dump = await pg.dumpDataDir("gzip");
  const buf = Buffer.from(await dump.arrayBuffer());

  const outDir = path.resolve(import.meta.dirname, "..", "public", "demo-db");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "studycube.tgz");
  await writeFile(outPath, buf);

  console.log(`[build-demo-db] 저장: ${outPath} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`);
  await pg.close();
}

main().catch((e) => {
  console.error("[build-demo-db] 실패:", e);
  // 덤프 생성이 실패해도 배포 자체를 막지는 않는다 — lib/db.ts가 덤프 fetch 실패를
  // 감지하면 예전처럼 브라우저에서 직접 시드하는 경로로 폴백하므로 데모는 계속 동작한다.
  // (다만 첫 방문 속도 개선은 이번 배포엔 반영되지 않는다 — 로그로 알 수 있게 exit 1은 유지.)
  process.exit(1);
});
