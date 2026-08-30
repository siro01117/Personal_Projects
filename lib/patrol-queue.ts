// 모바일 순찰 오프라인 큐 — 층 이동 중 와이파이가 끊겨도 마킹을 잃지 않는다.
// 클라 전용(브라우저 localStorage). 서버액션은 밖에서 주입받아 재사용 — 스키마·서버 변경 없음.
//
// 원칙:
//  · 마킹은 항상 큐를 거친다(온라인이어도) → 온/오프라인 코드패스 단일화.
//  · 학생당 최신 마킹만 유지 — recordPatrol 이 세션 내 delete→insert 라 최신 1건 전송 = 최종 상태.
//  · flush 순서: 세션 시작 → 마킹들 → 세션 종료. 건별 성공 시에만 큐에서 제거.

export type QueuedMark = { state: string | null; at: number }; // state null = 기록 지우기
export type QueueSession = {
  sessionId: string;
  startedAt: number;      // 클라 기준 ms (배너 경과시간용)
  startSent: boolean;
  endRequested: boolean;
};
// ids = 아직 전송 안 된 학생들(좌석에 '대기' 표시용). 렌더가 ref 를 들추지 않도록 상태로 흘려보낸다.
export type QueueStatus = { pending: number; sending: boolean; error: boolean; ids: string[] };

type Store = { session: QueueSession | null; marks: Record<string, QueuedMark> };
type ActionFn = (fd: FormData) => Promise<unknown>;

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

export class PatrolQueue {
  private key: string;
  private store: Store = { session: null, marks: {} };
  private sending = false;
  private error = false;
  private subs = new Set<(s: QueueStatus) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    branchKey: string,
    private actions: { start: ActionFn; end: ActionFn; recordBulk: ActionFn; clear: ActionFn },
  ) {
    this.key = `patrolq:${branchKey}`;
    this.load();
  }

  // ── 저장/복원 ──
  private load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) this.store = JSON.parse(raw);
    } catch { /* 손상 시 빈 큐로 시작 */ }
  }
  private save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.store)); } catch { /* 저장공간 부족 등 — 메모리로 계속 */ }
  }

  get session(): QueueSession | null { return this.store.session; }
  get queuedMarks(): Record<string, QueuedMark> { return this.store.marks; }

  status(): QueueStatus {
    const s = this.store;
    const ids = Object.keys(s.marks);
    let n = ids.length;
    if (s.session && !s.session.startSent) n++;
    if (s.session?.endRequested) n++;
    return { pending: n, sending: this.sending, error: this.error, ids };
  }

  subscribe(cb: (s: QueueStatus) => void): () => void {
    this.subs.add(cb);
    cb(this.status());
    return () => this.subs.delete(cb);
  }
  private emit() { const st = this.status(); this.subs.forEach((cb) => cb(st)); }

  /** 자동 flush 트리거 부착 (online·복귀·10초 인터벌). 컴포넌트 unmount 시 detach 호출. */
  attach() {
    window.addEventListener("online", this.flushBound);
    document.addEventListener("visibilitychange", this.visBound);
    this.timer = setInterval(this.flushBound, 10_000);
    void this.flush();
  }
  detach() {
    window.removeEventListener("online", this.flushBound);
    document.removeEventListener("visibilitychange", this.visBound);
    if (this.timer) clearInterval(this.timer);
  }
  private flushBound = () => { void this.flush(); };
  private visBound = () => { if (document.visibilityState === "visible") void this.flush(); };

  // ── 입력 ──
  startSession(sessionId: string) {
    this.store.session = { sessionId, startedAt: Date.now(), startSent: false, endRequested: false };
    this.store.marks = {};
    this.save(); this.emit();
    void this.flush();
  }
  endSession() {
    if (!this.store.session) return;
    this.store.session.endRequested = true;
    this.save(); this.emit();
    void this.flush();
  }
  mark(studentId: string, state: string | null) {
    this.store.marks[studentId] = { state, at: Date.now() };
    this.save(); this.emit();
    void this.flush();
  }

  // ── 전송 ──
  async flush() {
    if (this.sending) return;
    const s = this.store;
    if (!s.session && Object.keys(s.marks).length === 0) return;
    this.sending = true; this.emit();
    try {
      // 1) 세션 시작(미전송이면 먼저 — patrol_event.session_id 매칭 보장)
      if (s.session && !s.session.startSent) {
        await this.actions.start(fd({ sessionId: s.session.sessionId }));
        s.session.startSent = true;
        this.save(); this.emit();
      }
      // 2) 마킹 — 기록은 한 번에(일괄), 삭제는 건별. 전송 중 재탭으로 갱신된 건(at 비교)은 큐에 남긴다.
      const snapshot = Object.entries({ ...s.marks });
      const sid = s.session?.sessionId ?? "";
      const records = snapshot.filter(([, m]) => m.state !== null);
      if (records.length) {
        await this.actions.recordBulk(fd({
          sessionId: sid,
          items: JSON.stringify(records.map(([studentId, m]) => ({ studentId, state: m.state }))),
        }));
        for (const [studentId, m] of records) if (s.marks[studentId]?.at === m.at) delete s.marks[studentId];
        this.save(); this.emit();
      }
      for (const [studentId, m] of snapshot.filter(([, m]) => m.state === null)) {
        await this.actions.clear(fd({ sessionId: sid, studentId }));
        if (s.marks[studentId]?.at === m.at) delete s.marks[studentId];
        this.save(); this.emit();
      }
      // 3) 세션 종료(요청돼 있고 마킹이 다 나갔을 때)
      if (s.session?.endRequested && Object.keys(s.marks).length === 0) {
        await this.actions.end(fd({ sessionId: s.session.sessionId }));
        s.session = null;
        this.save(); this.emit();
      }
      this.error = false;
    } catch {
      this.error = true; // 오프라인/서버 불가 — 큐 유지, 다음 트리거에서 재시도
    } finally {
      this.sending = false; this.emit();
    }
  }
}
