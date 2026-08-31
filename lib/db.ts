// DB 어댑터 (브라우저 데모판) — 앱은 db.query(sql, params)->{rows} 와 db.exec(sql) 만 사용.
// 원본(src/lib/db.ts)의 {query, exec} 인터페이스를 그대로 유지하되, 구현만 브라우저용으로 교체.
//  · PGlite를 idb://studycube-demo 로 열어 IndexedDB에 영속시킨다 (새로고침해도 데이터 유지).
//  · 서버 컴포넌트가 없으므로 전부 클라이언트에서 lazy하게 인스턴스 하나만 만들어 재사용한다.
//  · 최초 방문(이 브라우저에 idb 데이터가 아직 없을 때)에는 빌드 시점에 미리 시드해둔 덤프
//    (/demo-db/studycube.tgz)를 내려받아 복원한다 — 브라우저 안에서 스키마 DDL·시드 INSERT를
//    수백 번 왕복할 필요가 없어져 첫 방문 체감 속도가 크게 줄어든다. 덤프가 없거나 복원이
//    실패하면(네트워크 오류, 포맷 불일치 등) 예전처럼 빈 DB로 열어 bootstrap.ts가 직접 시드하는
//    경로로 폴백한다 — 데모가 절대 죽지 않아야 한다.
type Row = Record<string, unknown>;
export interface DB {
  query<T = Row>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<void>;
}

// PGlite 생성자에 넘기는 논리적 이름. 실제 IndexedDB 데이터베이스 이름은 PGlite가 여기에
// "/pglite/" 접두사를 붙여서 만든다(실기기 확인: indexedDB.databases() → "/pglite/studycube-demo") —
// 데모 초기화 버튼은 SQ_IDB_NAME이 아니라 SQ_IDB_FULL_NAME으로 지워야 한다.
const SQ_IDB_LOGICAL_NAME = "studycube-demo";
export const SQ_IDB_NAME = `/pglite/${SQ_IDB_LOGICAL_NAME}`;

const DUMP_URL = "/demo-db/studycube.tgz";

// ── 부팅 단계 알림(로딩 화면용) ────────────────────────────────────────────
// "확인 중" → (최초 방문일 때만) "다운로드 중" → "복원 중" → "준비 중" → "완료".
// UI는 lib/db.ts를 몰라도 되게 별도 pub/sub — app/m/_shared/BootProgress.tsx 가 구독한다.
export type BootStage = "checking" | "downloading" | "restoring" | "preparing" | "ready";
let stage: BootStage = "checking";
let firstVisit = false; // 이번 로드가 "복원이 필요했던" 최초 방문인지 — UI 문구 분기용
const stageListeners = new Set<(s: BootStage, firstVisit: boolean) => void>();
function setStage(s: BootStage) {
  stage = s;
  stageListeners.forEach((l) => l(s, firstVisit));
}
export function onBootStage(cb: (s: BootStage, firstVisit: boolean) => void): () => void {
  cb(stage, firstVisit);
  stageListeners.add(cb);
  return () => stageListeners.delete(cb);
}
export function getBootStage(): { stage: BootStage; firstVisit: boolean } {
  return { stage, firstVisit };
}

// ── Node(빌드 스크립트) 주입 지점 ──────────────────────────────────────────
// scripts/build-demo-db.ts 가 Node에서 직접 만든 PGlite 인스턴스를 여기 꽂아 넣으면,
// bootstrap.ts의 ready()/boot() 를 브라우저용 코드 한 줄도 안 바꾸고 그대로 재사용해
// 스키마·시드를 채운 뒤 pg.dumpDataDir()로 덤프를 뽑을 수 있다. {query,exec} 인터페이스는
// 그대로 유지한다 — 앱 로직 입장에서는 브라우저에서 도는지 Node에서 도는지 구분이 없다.
type PGliteLike = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (text: string) => Promise<unknown>;
};
let injectedPg: PGliteLike | null = null;
export function __setPgInstance(pg: PGliteLike | null): void {
  injectedPg = pg;
  g.__sqDbInst = undefined;
  g.__sqDbPromise = undefined;
}

function wrap(pg: PGliteLike): DB {
  return {
    async query<T = Row>(text: string, params: unknown[] = []) {
      const r = await pg.query(text, params);
      return { rows: r.rows as unknown as T[] };
    },
    async exec(text: string) {
      await pg.exec(text);
    },
  };
}

const g = globalThis as unknown as { __sqDbInst?: DB; __sqDbPromise?: Promise<DB> };

/** 이 브라우저에 이미 idb 데이터베이스가 있는지 — 있으면 덤프 복원을 시도할 필요가 없다
 *  (그냥 열면 됨). 없으면 최초 방문으로 간주해 덤프를 내려받는다.
 *  indexedDB.databases() 가 없는 구형 브라우저에서는 판정 불가 → false 반환(덤프 시도 안 함,
 *  기존처럼 빈 DB로 열어 bootstrap.ts가 직접 시드하는 안전한 경로로 감). */
async function idbAlreadyHasData(): Promise<boolean> {
  try {
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return false;
    const dbs = await indexedDB.databases();
    return dbs.some((d) => d.name === SQ_IDB_NAME);
  } catch {
    return false;
  }
}

async function fetchDump(): Promise<Blob | null> {
  try {
    const res = await fetch(DUMP_URL);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null; // 오프라인·404 등 — 폴백 경로로
  }
}

// 복원이 끝나기 전에 탭을 닫으면 반쯤 쓰인 datadir 이 idb 에 남는다. 그 상태로 다음에 열면
// PGlite.create 가 에러도 없이 영영 안 끝나 로딩 화면에 갇힌다(실제로 재현됨). 그래서 기존 DB 를
// 열 때는 제한 시간을 두고, 넘기면 "다음 로드에서 지우고 다시 복원" 표시만 남기고 새로고침한다 —
// 이미 열려 있는 연결 때문에 그 자리에서 지우면 deleteDatabase 가 blocked 로 멈추기 때문이다.
const RESET_FLAG = "sq_demo_force_reset";
const OPEN_TIMEOUT_MS = 15000;

async function deleteIdb(): Promise<void> {
  await new Promise<void>((res) => {
    try {
      const r = indexedDB.deleteDatabase(SQ_IDB_NAME);
      r.onsuccess = () => res();
      r.onerror = () => res();
      r.onblocked = () => res();
    } catch {
      res();
    }
    setTimeout(res, 3000);
  });
}

/** 열기 + 첫 질의까지 제한 시간 안에 끝나야 정상. 멈추거나 실패하면 null. */
async function openGuarded(open: () => Promise<unknown>): Promise<unknown | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      open(),
      new Promise<null>((res) => {
        timer = setTimeout(() => res(null), OPEN_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    console.error("[db] 기존 데모 DB 를 여는 데 실패했습니다.", e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function real(): Promise<DB> {
  if (g.__sqDbInst) return g.__sqDbInst;
  if (g.__sqDbPromise) return g.__sqDbPromise;
  g.__sqDbPromise = (async () => {
    if (injectedPg) {
      // Node 빌드 스크립트 경로 — 복원 로직 없이 그대로 위임.
      const inst = wrap(injectedPg);
      g.__sqDbInst = inst;
      return inst;
    }

    // 직전 로드가 "못 여는 DB" 를 만났으면, 아직 아무도 열기 전인 지금 지운다.
    let forceReset = false;
    try {
      forceReset = localStorage.getItem(RESET_FLAG) === "1";
      if (forceReset) localStorage.removeItem(RESET_FLAG);
    } catch {
      forceReset = false;
    }
    if (forceReset) await deleteIdb();

    const [{ PGlite }, existed] = await Promise.all([
      import("@electric-sql/pglite"),
      idbAlreadyHasData(),
    ]);
    const hasExisting = forceReset ? false : existed;

    let pg: InstanceType<typeof PGlite> | null = null;

    if (hasExisting) {
      pg = (await openGuarded(async () => {
        const p = await PGlite.create(`idb://${SQ_IDB_LOGICAL_NAME}`);
        await p.query("select 1"); // 반쯤 쓰인 datadir 걸러내기
        return p;
      })) as InstanceType<typeof PGlite> | null;

      if (!pg) {
        // 되살릴 방법이 없다 — 표시를 남기고 새로고침하면 위에서 지우고 덤프로 다시 복원한다.
        try {
          localStorage.setItem(RESET_FLAG, "1");
        } catch {
          /* 저장이 막힌 브라우저면 그냥 새로고침만 — 최소한 갇히지는 않는다 */
        }
        location.reload();
        await new Promise(() => {}); // 새로고침될 때까지 이 경로는 더 진행하지 않는다
      }
    }

    if (!pg) {
      firstVisit = true;
      setStage("downloading");
      // 덤프(tgz)와 PGlite 자체 자산(wasm+data) 다운로드가 동시에 진행되도록, PGlite
      // 동적 import 직후·인스턴스 생성 전에 fetch 를 걸어둔다(위의 Promise.all 과 병렬).
      const dump = await fetchDump();
      if (dump) {
        setStage("restoring");
        try {
          pg = await PGlite.create(`idb://${SQ_IDB_LOGICAL_NAME}`, { loadDataDir: dump });
        } catch (e) {
          console.error("[db] 데모 덤프 복원 실패 — 빈 DB로 폴백해 직접 시드합니다.", e);
          pg = null;
        }
      }
    }

    if (!pg) {
      pg = await PGlite.create(`idb://${SQ_IDB_LOGICAL_NAME}`);
    }

    setStage("preparing");
    const inst = wrap(pg);
    g.__sqDbInst = inst;
    return inst;
  })();
  return g.__sqDbPromise;
}

export const db: DB = {
  query: async (text, params) => (await real()).query(text, params),
  exec: async (text) => (await real()).exec(text),
};

/** bootstrap.ts의 ready() 가 boot() 완료 직후 호출 — 로딩 화면을 "완료"로 넘긴다. */
export function markBootReady(): void {
  setStage("ready");
}
