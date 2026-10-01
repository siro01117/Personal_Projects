// 웹이 서랍·일정·플래너 데이터를 읽고 쓰는 창구. 구현 2개: Supabase(진짜, 로그인한 사람 세션 + RLS) / 메모리(개발 확인용).
// 실패는 DbError 모양({ code, message })으로 던지고, 화면은 lib/errors 의 toKorean 으로 한국어로 바꾼다.

import type { ReportKind } from "../../lib/blocks";
import type {
  CheckItem,
  DateStr,
  EventException,
  EventRow,
  ExceptionPatch,
  Place,
  PlaceColor,
  PlaceRole,
  PlaceSymbol,
  Repeat,
  Role,
  Settings,
  TaskRow,
  TaskRule,
  Travel,
} from "../../lib/schedule";
import type { DataCache } from "./cache";

export type Kind = "folder" | "report";

/** 탐색기에 보이는 한 칸 */
export type Entry = {
  id: string;
  parent_id: string | null;
  kind: Kind;
  name: string;
  /** 보고서 종류 (폴더는 null) — 목록 보기 '종류' 열 */
  report_kind: ReportKind | null;
  agent_updated_at: string | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
  /** 공유 켜짐 (열쇠 값은 목록에 싣지 않는다) */
  shared: boolean;
};

export type Folder = { id: string; parent_id: string | null; name: string };

export type ReportDoc = Entry & {
  kind: "report";
  report_kind: ReportKind | null;
  blocks: unknown[];
  version: number;
  agent: string | null;
  share_token: string | null;
};

export type SharedDoc = { name: string; report_kind: string | null; blocks: unknown[]; updated_at: string };

/** ez_restore 한 줄 */
export type Restored = { id: string; name: string; to_root: boolean; renamed: boolean };

/** ez_copy 한 줄 — 맨 위 항목마다 */
export type Copied = { src: string; id: string; name: string };

/** ez_trash 한 줄 — 묶음의 맨 위 항목 하나. count 는 묶음 안 항목 수 */
export type TrashRow = { batch: string; deleted_at: string; id: string; kind: Kind; name: string; count: number };

/** ez_search 한 줄 */
export type SearchHit = {
  id: string;
  kind: Kind;
  name: string;
  parent_id: string | null;
  match: "name" | "body";
  snippet: string | null;
  updated_at: string;
};

export type Path = readonly (string | number)[];

export interface DrawerData {
  /** 폴더 안 (null = 맨 위). 순서는 화면이 정한다 */
  list(parentId: string | null): Promise<Entry[]>;
  /** 살아 있는 폴더 전부 — 위쪽 경로·옮길 곳 목록용 */
  folders(): Promise<Folder[]>;
  /** 없거나 지웠으면 null */
  report(id: string): Promise<ReportDoc | null>;
  /** 안 읽은 보고서 수 (홈 배지) */
  unreadCount(): Promise<number>;
  /** ez_unread_folders — 안(자손 어디든)에 안 읽은 보고서가 있는 폴더 id */
  unreadFolders(): Promise<string[]>;
  /** ez_search — 서랍 전체에서 이름·본문 찾기 */
  search(query: string): Promise<SearchHit[]>;
  /** ez_trash — 휴지통 묶음 목록 */
  trash(): Promise<TrashRow[]>;

  createFolder(parentId: string | null, name: string): Promise<Entry>;
  /** 이름 바꾸기. 겹치면 거절(23505) — 사람이 정한 이름이라 자동으로 바꾸지 않는다 */
  rename(id: string, name: string): Promise<void>;
  /** 옮기기. 옮길 곳에 같은 이름이 있으면 ' (2)' 류를 붙여 옮기고 최종 이름을 돌려준다 */
  move(id: string, parentId: string | null): Promise<{ name: string; renamed: boolean }>;
  /** ez_delete — 자손까지 한 묶음으로 휴지통에. 묶음 id */
  remove(id: string): Promise<string>;
  /** ez_delete_many — 여러 개를 한 묶음으로. 묶음 id */
  removeMany(ids: string[]): Promise<string>;
  /** ez_copy — 여러 개를 to(null = 맨 위) 아래로 복사. 폴더는 통째로, 전부 되거나 전부 안 된다 */
  copy(ids: string[], to: string | null): Promise<Copied[]>;
  /** ez_restore — 묶음째 복원 */
  restore(batch: string): Promise<Restored[]>;

  markRead(id: string): Promise<void>;
  /** ez_edit_text — path 는 blocks 기준([2,'body']) 또는 ['title']. 새 version */
  editText(id: string, baseVersion: number, path: Path, value: string): Promise<number>;
  /** ez_share — 새 열쇠(이전 열쇠는 무효) */
  share(id: string): Promise<string>;
  unshare(id: string): Promise<void>;
  /** ez_shared — 로그인 없이. 없거나 꺼졌으면 null. 사진의 local_path 는 빠져 온다 */
  shared(token: string): Promise<SharedDoc | null>;
  /**
   * 사진 파일의 잠깐(1시간) 유효한 주소. shared 면 로그인 없이(anon — 공유 켜진 보고서가 쓰는 사진만).
   * 못 받은 경로는 빠진다. 같은 페이지 안에서는 다시 받지 않는다
   */
  imageUrls(paths: readonly string[], shared?: boolean): Promise<Record<string, string>>;
}

export interface Auth {
  /** 로그인해 있으면 true */
  signedIn(): Promise<boolean>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** 로그인 풀림 알림. 구독 해제 함수를 돌려준다 */
  onSignedOut(cb: () => void): () => void;
}

// ---------------------------------------------------------------------------
// 일정 (docs/일정.md 2장, db/migrations/0006). 행 모양은 lib/schedule/types.ts
// ---------------------------------------------------------------------------

/** 바깥 일정 출처 (ez_sources) */
export type SourceInfo = { source: string; label: string | null; synced_at: string | null };

/** 내가 넣고 고치는 일정 칸. source · external_id · origin 은 화면에서 쓰지 않는다 */
export type EventInput = {
  title: string;
  date: DateStr;
  start_min: number | null;
  end_min: number | null;
  place_id: string | null;
  where_text: string | null;
  travel_min: number | null;
  note: string | null;
  repeat: Repeat;
  task_id: string | null;
};

/** '이후 모두' 고치기(ez_event_split)의 patch — 예외 칸 + repeat */
export type SplitPatch = ExceptionPatch & { repeat?: Repeat };

/** 한 주(또는 기간)를 그리는 데 필요한 일정 줄 + 예외 */
export type EventRows = { events: EventRow[]; exceptions: EventException[] };

/**
 * 일정을 지울 때 같이 끊기는 것 (0007 ez_events_after): 마감을 딸려 둔 할 일 · 딸린 반복 규칙.
 * 지우기 전에 읽어 두었다가 되돌릴 때(restoreEvent) 다시 잇는다
 */
export type EventDeps = { tasks: string[]; rules: string[] };

export type PlaceInput = { name: string; role: PlaceRole | null; symbol?: PlaceSymbol; color?: PlaceColor; sort?: number };

export interface ScheduleData {
  /** 지운 지점도 온다(deleted) — 지운 지점이 붙은 일정도 이름은 보여야 한다 */
  places(): Promise<Place[]>;
  travel(): Promise<Travel[]>;
  /** 줄이 없으면 기본값 */
  settings(): Promise<Settings>;
  sources(): Promise<SourceInfo[]>;
  /**
   * from~to 를 그리는 데 필요한 살아 있는 일정과 그 예외. 반복 일정은 전부, 반복 아닌 일정은 from 이틀 전부터
   * (전날 자정 넘김 · 동선 이어받기). 펼치기는 lib/schedule 의 planRange 가 한다
   */
  events(from: DateStr, to: DateStr): Promise<EventRows>;

  createEvent(input: EventInput): Promise<EventRow>;
  /** 버전이 다르면 [EZ_VERSION], 바깥 일정이면 [EZ_EXTERNAL] */
  updateEvent(id: string, baseVersion: number, patch: Partial<EventInput>): Promise<EventRow>;
  /** 이 일정을 지우면 끊길 것 (지우기 전에 읽어 둔다) */
  dependents(id: string): Promise<EventDeps>;
  /** 지우기 (deleted_at). 딸린 마감은 연결만 끊기고 딸린 규칙은 멈춘다. 되돌리기는 restoreEvent */
  deleteEvent(id: string, baseVersion: number): Promise<void>;
  /** deps 를 주면 끊긴 마감 연결과 멈춘 규칙도 되살린다 */
  restoreEvent(id: string, deps?: EventDeps): Promise<EventRow>;
  /** 반복의 '이번만' — 건너뛰기(patch null) 또는 그 회차만 바꾼 칸. 이미 있으면 갈아끼운다 */
  setException(eventId: string, onDate: DateStr, patch: ExceptionPatch | null): Promise<void>;
  clearException(eventId: string, onDate: DateStr): Promise<void>;
  /**
   * ez_event_split — on_date 회차부터 patch 를 얹어 새 일정으로. 첫 회차면 원래 일정을 고친다.
   * 새 일정이 생기면 원래 일정에 딸린 반복 규칙(끝나면 할 일)을 새 일정으로 옮긴다
   */
  split(id: string, baseVersion: number, onDate: DateStr, patch: SplitPatch): Promise<EventRow>;
  /** ez_event_cut — on_date 회차부터 지우기. 첫 회차면 일정을 지운다 */
  cut(id: string, baseVersion: number, onDate: DateStr): Promise<EventRow>;

  createPlace(input: PlaceInput): Promise<Place>;
  updatePlace(id: string, patch: Partial<PlaceInput>): Promise<Place>;
  /** 지우기 (deleted_at). 그 지점이 낀 이동시간도 지워진다 */
  deletePlace(id: string): Promise<void>;
  /** 두 지점 사이 이동시간. null 이면 지운다(모름) */
  setTravel(a: string, b: string, minutes: number | null): Promise<void>;
  saveSettings(patch: Partial<Omit<Settings, "tz">>): Promise<Settings>;
}

// ---------------------------------------------------------------------------
// 플래너 (docs/플래너.md 2장) — 시간이 안 정해진 할 일
// ---------------------------------------------------------------------------

export type TaskInput = {
  title: string;
  note?: string | null;
  due?: DateStr | null;
  est_min?: number | null;
  place_id?: string | null;
  /** 마감을 딸려 둘 일정. 반복 아닌 일정이면 due 는 일정 날짜로 덮인다. 건 채로 due 만 바꿀 수 없다 — 바꾸거나 지울 땐 null 을 같이 */
  due_event_id?: string | null;
  checklist?: CheckItem[];
  rule_id?: string | null;
  rule_date?: DateStr | null;
  /** 역할 (docs/플래너.md 7-11). 지운 역할이면 [EZ_ROLE] */
  role_id?: string | null;
};

/** 할 일과 이어진 살아 있는 일정 (할 일 하나에 하나). end_min 은 지남 판정에 쓴다 */
export type TaskLink = { task_id: string; event_id: string; date: DateStr; start_min: number | null; end_min: number | null; repeating: boolean };

/** 반복 규칙에 넣는 칸 (ez_task_rules). cycle 은 repeat · start, event 는 event_id */
export type RuleInput = Omit<TaskRule, "id" | "version">;

/** 역할에 넣는 칸 (ez_roles). sort 를 안 주면 맨 뒤 */
export type RoleInput = { name: string; from_place?: PlaceRole | null; sort?: number };

/**
 * 역할을 지울 때 역할이 비는 것 (0008: 그 역할의 할 일 · 규칙의 role_id 가 null 이 된다).
 * 지우기 전에 읽어 두었다가 되돌릴 때(restoreRole) 다시 건다
 */
export type RoleDeps = { tasks: string[]; rules: string[] };

export interface PlannerData {
  /** 지우지 않은 할 일 전부 (끝낸 것 포함). 순서는 sort 오름차순 */
  tasks(): Promise<TaskRow[]>;
  /** 할 일과 이어진 일정들 */
  links(): Promise<TaskLink[]>;
  /** 살아 있는(안 멈춘) 반복 규칙 */
  rules(): Promise<TaskRule[]>;
  /** 일정 제목 (딸린 마감 · 딸린 규칙을 보여 줄 때). 지운 일정은 빠진다 */
  eventTitles(ids: readonly string[]): Promise<Record<string, string>>;
  /**
   * ez_tasks_roll — 규칙마다 가장 최근 회차 하나를 할 일로 만든다. 만든 개수.
   * today · nowMin 은 Asia/Seoul 의 오늘 날짜와 0시부터 센 분. 화면을 열 때와 창이 다시 보일 때 부른다
   */
  roll(today: DateStr, nowMin: number): Promise<number>;
  /** 맨 위에 넣는다 */
  createTask(input: TaskInput): Promise<TaskRow>;
  updateTask(id: string, baseVersion: number, patch: Partial<TaskInput>): Promise<TaskRow>;
  setDone(id: string, baseVersion: number, done: boolean): Promise<TaskRow>;
  /** 지우기 (deleted_at). 이어진 일정은 남고 연결만 끊긴다 */
  deleteTask(id: string, baseVersion: number): Promise<void>;
  restoreTask(id: string): Promise<TaskRow>;
  /** 손으로 정한 순서. 사이에 끼우려면 앞뒤 sort 의 가운데 값 */
  reorder(id: string, sort: number): Promise<TaskRow>;

  createRule(input: RuleInput): Promise<TaskRule>;
  updateRule(id: string, patch: Partial<RuleInput>): Promise<TaskRule>;
  /** 멈추기 (deleted_at). 이미 생긴 할 일은 남는다 */
  stopRule(id: string): Promise<void>;

  /** 살아 있는 역할. sort 순 */
  roles(): Promise<Role[]>;
  /** ez_roles_seed — 역할 행이 하나도 없을 때만(지운 것 포함) 기본 셋을 넣는다. 만든 개수. 화면을 열 때 roll 보다 먼저 부른다 */
  seedRoles(): Promise<number>;
  /** 12개를 넘으면 [EZ_LIMIT], 이름이 겹치면 23505 */
  createRole(input: RoleInput): Promise<Role>;
  updateRole(id: string, patch: Partial<RoleInput>): Promise<Role>;
  /** 지우기 (deleted_at). 그 역할의 할 일 · 규칙은 역할 없음이 된다. 비게 된 것들을 돌려준다(되돌리기용) */
  deleteRole(id: string): Promise<RoleDeps>;
  /** 역할을 되살리고 deps 의 할 일 · 규칙에 다시 건다. 그 사이 다른 역할을 고른 것은 건너뛴다 */
  restoreRole(id: string, deps?: RoleDeps): Promise<Role>;
}

/** cache = 마지막으로 읽은 것 (먼저 그리기용). data 는 이미 캐시를 낀 서랍 */
export type Source = { data: DrawerData; schedule: ScheduleData; planner: PlannerData; auth: Auth; demo: boolean; cache: DataCache };
