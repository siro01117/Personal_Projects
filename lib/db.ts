// DB 어댑터 (브라우저 데모판) — 앱은 db.query(sql, params)->{rows} 와 db.exec(sql) 만 사용.
// 원본(src/lib/db.ts)의 {query, exec} 인터페이스를 그대로 유지하되, 구현만 브라우저용으로 교체.
//  · PGlite를 idb://studycube-demo 로 열어 IndexedDB에 영속시킨다 (새로고침해도 데이터 유지).
//  · 서버 컴포넌트가 없으므로 전부 클라이언트에서 lazy하게 인스턴스 하나만 만들어 재사용한다.
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

const g = globalThis as unknown as { __sqDbInst?: DB; __sqDbPromise?: Promise<DB> };

async function real(): Promise<DB> {
  if (g.__sqDbInst) return g.__sqDbInst;
  if (g.__sqDbPromise) return g.__sqDbPromise;
  g.__sqDbPromise = (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite(`idb://${SQ_IDB_LOGICAL_NAME}`);
    const inst: DB = {
      async query<T = Row>(text: string, params: unknown[] = []) {
        const r = await pg.query(text, params);
        return { rows: r.rows as unknown as T[] };
      },
      async exec(text: string) {
        await pg.exec(text);
      },
    };
    g.__sqDbInst = inst;
    return inst;
  })();
  return g.__sqDbPromise;
}

export const db: DB = {
  query: async (text, params) => (await real()).query(text, params),
  exec: async (text) => (await real()).exec(text),
};
