// 웹이 서랍·일정·플래너·모임 데이터를 읽고 쓰는 창구. 구현 2개: Supabase(진짜, 로그인한 사람 세션 + RLS) / 메모리(개발 확인용).
// 실패는 DbError 모양({ code, message })으로 던지고, 화면은 lib/errors 의 toKorean 으로 한국어로 바꾼다.

import type { ReportKind } from "../../lib/blocks";
import type { Attend, Cells, Circle, Meet, MeetPerson, Poll, PublicMeet } from "../../lib/meet";
import type { Me, MemberPatch, MemberRow, ModuleRow, NewMember, NewModule } from "../../lib/members";
import type {
  CheckItem,
  DateStr,
  EventException,
  EventRow,
  ExceptionPatch,
  OriginKind,
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

/** ez_shared_doc 가 주는 것. version 은 글마다 붙은 버전과 비교하려고 (7-5장) */
export type SharedDoc = { name: string; report_kind: string | null; blocks: unknown[]; version: number; updated_at: string };

/** ez_views 한 줄 — 보고서 × 기기 (설계서 7-4장). 주인만 읽는다 */
export type ViewRow = {
  id: string;
  device: string;
  guest_no: number;
  name: string | null;
  first_at: string;
  last_at: string;
  hits: number;
  seconds: number;
  ua: string | null;
};

/** ez_view_open 이 돌려주는 것 — 공개 페이지가 자기 라벨("게스트 n" 또는 이름)을 안다 */
export type Viewer = { guest_no: number; name: string | null };

/**
 * ez_notes 한 줄 — 방명록(block 없음) · 댓글(block + anchor) (설계서 7-5장). 공개 페이지 · 주인 화면이 같은 모양으로 본다.
 * guest_no · label 은 쓴 사람(이름 또는 "게스트 n"). 주인 글은 둘 다 null + by_owner. 기기 줄이 지워진 글도 둘 다 null
 */
export type NoteRow = {
  id: string;
  guest_no: number | null;
  label: string | null;
  by_owner: boolean;
  body: string;
  /** 썼을 때 보고서 버전 */
  version: number;
  block: number | null;
  anchor: string | null;
  created_at: string;
  updated_at: string;
};

/** ez_visits 한 줄 — 한 기기의 방문 하나 (들어왔을 때 버전 · 시작 · 마지막 · 읽은 초). 주인만 읽는다 */
export type VisitRow = { id: string; version: number; started_at: string; last_at: string; seconds: number };

/** 라이브(presence)에 올리는 상태 — 라벨과 보고 있는 블록 번호뿐 */
export type Presence = { device: string; label: string; block: number | null };

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
  /**
   * ez_edit_text — path 는 blocks 기준([2,'body']) · ['title'](제목) · ['agent'](작성자, 보고서만). 새 version.
   * 블록 칸과 작성자는 빈 값('')으로 둘 수 있다(작성자는 null 이 된다). 제목만 비울 수 없다
   */
  editText(id: string, baseVersion: number, path: Path, value: string): Promise<number>;
  /**
   * ez_blocks_arrange — 블록 지우기 · 옮기기. order 는 새 순서로 늘어놓은 옛 블록 번호(0부터), 빠진 번호 = 지움. 새 version.
   * 비었거나 겹치거나 범위 밖이면 [EZ_VALUE]. 출처 블록이 안 남으면 근거의 출처 번호가 비워진다. 그대로면 version 도 그대로
   */
  arrangeBlocks(id: string, baseVersion: number, order: readonly number[]): Promise<number>;
  /** ez_share — 새 열쇠(이전 열쇠는 무효) */
  share(id: string): Promise<string>;
  unshare(id: string): Promise<void>;
  /** ez_shared_doc — 로그인 없이. 없거나 꺼졌으면 null. 사진의 local_path 는 빠져 온다 */
  shared(token: string): Promise<SharedDoc | null>;
  /** 읽은 사람 기록 (주인만, RLS). 최근 것부터 */
  views(itemId: string): Promise<ViewRow[]>;
  /** ez_view_open — 공개 페이지가 들어왔다. 없는 열쇠 · 꺼진 링크 · 주인 본인이면 null */
  viewOpen(token: string, device: string, ua: string): Promise<Viewer | null>;
  /** ez_view_ping — 살아 있음 + 그 사이 보인 초(60까지). keepalive 면 페이지를 떠나며 보내는 마지막 한 번 */
  viewPing(token: string, device: string, seenSec: number, keepalive?: boolean): Promise<void>;
  /** ez_view_name — 이름 적기 · 바꾸기 (null 이면 다시 게스트 n) */
  viewName(token: string, device: string, name: string | null): Promise<void>;
  /** 방문 기록 (주인만, RLS). 최근 것부터 */
  visits(viewId: string): Promise<VisitRow[]>;
  /** 방명록 · 댓글 (주인만, RLS — 지운 것은 뺀다). 오래된 것부터 */
  notes(itemId: string): Promise<NoteRow[]>;
  /** 주인의 답글 (by_owner). block 을 주면 그 블록의 댓글, 없으면 방명록 */
  noteReply(itemId: string, body: string, block?: number | null, anchor?: string | null): Promise<NoteRow>;
  /** 주인이 아무 글이나 지우기 (soft) */
  noteDelete(id: string): Promise<void>;
  /** ez_notes_list — 공개 페이지의 글 전부 (없는 열쇠 · 꺼진 링크 · 주인 본인이면 빈 목록) */
  sharedNotes(token: string): Promise<NoteRow[]>;
  /** ez_note_write — 그 기기 줄이 있어야 한다. 없으면 null. 10초에 하나([EZ_RATE]) · 1~1,000자([EZ_VALUE]) */
  noteWrite(token: string, device: string, body: string, block?: number | null, anchor?: string | null): Promise<NoteRow | null>;
  /** ez_note_edit — 같은 기기가 쓴 것만. body 가 null 이면 지우기 */
  noteEdit(token: string, device: string, id: string, body: string | null): Promise<void>;
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
  /** 어디서 넘어왔나 (넣을 때만). 모임에서 나온 할 일은 'meet' + 모임 id (docs/모임.md 2장) */
  origin_kind?: OriginKind | null;
  origin_id?: string | null;
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

// ---------------------------------------------------------------------------
// 모임 (docs/모임.md 2 · 4장, db/migrations/0011). 행 모양은 lib/meet/types.ts
// ---------------------------------------------------------------------------

/** 모임에 넣고 고치는 칸. 시간(meet_date · start_min · end_min)은 셋을 같이 — 적으면 일정이 생기거나 따라가고, 비우면 일정이 지워진다(DB 가 한다) */
export type MeetInput = {
  title: string;
  note?: string | null;
  circle_id?: string | null;
  place_id?: string | null;
  place_text?: string | null;
  meet_date?: DateStr | null;
  start_min?: number | null;
  end_min?: number | null;
  /** 시간 맞추기 설정. 켜면(없다가 생기면) 아직 안 칠한 내 줄이 자동 채움 상태가 된다 (DB 가 한다) */
  poll?: Poll | null;
};

/** 사람 줄에서 고치는 칸. cells · auto 는 내 칸 저장 — 손으로 칠하면 auto 를 끄고, '일정에 맞추기' 는 켠다 (auto 는 내 줄만) */
export type PersonPatch = { name?: string; attend?: Attend | null; cells?: Cells | null; auto?: boolean };

/** 사람 줄에 넣는 칸. id 를 주면 그 id 로 (뺀 사람 되돌리기) */
export type PersonInput = { id?: string; name: string; attend?: Attend | null; cells?: Cells | null };

/** 묶음에 넣는 칸 */
export type CircleInput = { name: string; role_id?: string | null; members?: string[] };

export interface MeetData {
  /** 살아 있는 묶음, 이름순 */
  circles(): Promise<Circle[]>;
  /** 살아 있는 모임 전부 + 사람들 (내 줄이 맨 앞) */
  meets(): Promise<Meet[]>;

  /** 내 줄은 DB 가 같이 만든다(설정의 내 이름). people 은 같이 넣을 다른 사람 이름들 */
  createMeet(input: MeetInput, people?: readonly string[]): Promise<Meet>;
  /** 버전이 다르면 [EZ_VERSION] */
  updateMeet(id: string, baseVersion: number, patch: Partial<MeetInput>): Promise<Meet>;
  /** 지우기 (deleted_at). 딸린 일정 · 할 일은 남는다. 되돌리기는 restoreMeet */
  deleteMeet(id: string, baseVersion: number): Promise<void>;
  restoreMeet(id: string): Promise<Meet>;
  /** ez_meet_decide — 시간 정하기 + 일정. 일정만 비어 있는 모임에 같은 시간으로 부르면 '일정에 넣기' */
  decide(id: string, baseVersion: number, date: DateStr, start: number, end: number): Promise<Meet>;
  /** ez_meet_reopen — 시간을 비우고 딸린 일정을 지운다 */
  reopen(id: string, baseVersion: number): Promise<Meet>;

  /** 50명을 넘으면 [EZ_LIMIT], 이름이 겹치면 23505 */
  addPerson(meetId: string, input: PersonInput): Promise<MeetPerson>;
  updatePerson(id: string, patch: PersonPatch): Promise<MeetPerson>;
  /** 그 줄(칠한 것 · 참석)이 지워진다. 되돌리기는 같은 값으로 addPerson */
  removePerson(id: string): Promise<void>;
  /** ez_meet_pin_clear — 그 사람의 핀을 지운다 (잊었을 때). 칠한 것 · 참석은 그대로 */
  clearPin(personId: string): Promise<void>;
  /** ez_meet_link — 공개 링크 켜기(열쇠) · 끄기(null). 이미 켜져 있으면 그 열쇠 그대로, 껐다 켜면 새 열쇠 */
  link(id: string, on: boolean): Promise<string | null>;

  /** 30개를 넘으면 [EZ_LIMIT], 이름이 겹치면 23505 */
  createCircle(input: CircleInput): Promise<Circle>;
  updateCircle(id: string, patch: Partial<CircleInput>): Promise<Circle>;
  /** 지우기 (deleted_at). 모임은 남고 묶음만 없는 것으로 읽힌다 */
  deleteCircle(id: string): Promise<void>;
  restoreCircle(id: string): Promise<Circle>;
}

/** 공개 페이지에 들어온 결과: 내 이름(적혀 있는 그대로) + 모임 */
export type Entered = { me: string; meet: PublicMeet };

/**
 * 공개 페이지(/m/열쇠)가 쓰는 것 — 로그인 없이(anon), 0012 의 함수 넷만 부른다.
 * 틀린 핀은 [EZ_PIN], 잠김은 [EZ_LOCKED], 없는 링크는 [EZ_NOT_FOUND] 로 던진다
 */
export interface MeetPublicData {
  /** ez_meet_public — 없거나 꺼졌거나 지웠으면 null */
  open(token: string): Promise<PublicMeet | null>;
  /** ez_meet_enter — 처음이면 핀을 정하고, 다시 오면 확인한다 */
  enter(token: string, name: string, pin: string): Promise<Entered>;
  /** ez_meet_answer — 되는 칸 저장 (지금 설정 안의 칸을 통째로) */
  answer(token: string, name: string, pin: string, cells: Cells): Promise<Entered>;
  /** ez_meet_rsvp — 정해진 모임에 온다 / 못 온다 / 비움 */
  rsvp(token: string, name: string, pin: string, attend: Attend | null): Promise<Entered>;
}

/** 공개 페이지가 채널에 들어가 있는 동안 */
export type LiveSession = {
  /** 상태가 바뀌면(라벨 · 블록) 다시 올린다 */
  track(state: Presence): void;
  /** 나간다 (untrack + 채널 닫기) */
  leave(): void;
};

/**
 * 라이브 — Realtime presence 채널 report:<열쇠> (설계서 7-4장). DB 를 거치지 않고 남지도 않는다.
 * 공개 페이지는 join 으로 자기 상태만 올리고 남의 상태는 읽지 않는다. 주인 화면은 watch 로 듣기만 한다
 */
export interface LiveData {
  join(token: string, state: Presence): LiveSession;
  /** 바뀔 때마다 지금 있는 사람들. 연결이 안 되거나 끊기면 null (화면은 기록의 70초 판정으로 물러난다). 해제 함수 */
  watch(token: string, onChange: (people: Presence[] | null) => void): () => void;
}

// ---------------------------------------------------------------------------
// 회원 · 추가 모듈 (docs/회원.md, db/migrations/0015). 행 모양은 lib/members.ts
// ---------------------------------------------------------------------------

/** 로그인한 사람 자신 */
export interface MeData {
  /** ez_me — 역할 · 이름 · 켬 · 허용 · 켠 것 · 보이는 모듈을 한 번에 (캐시를 낀다) */
  me(): Promise<Me>;
  /** ez_set_picked — 켠 추가 모듈을 통째로. 저장된 값을 돌려준다 */
  setPicked(keys: string[]): Promise<string[]>;
}

/** 관리 화면 (관리자만). 회원은 서버 라우트(/api/admin/members), 모듈은 RLS 로 직접 */
export interface AdminData {
  members(): Promise<MemberRow[]>;
  /** 아이디가 겹치면 [EZ_TAKEN] */
  createMember(input: NewMember): Promise<MemberRow>;
  updateMember(id: string, patch: MemberPatch): Promise<MemberRow>;
  /** Auth 사용자째 지운다. 그 회원의 데이터(ez_items 등)는 남는다 */
  deleteMember(id: string): Promise<void>;
  /** sort 순 */
  modules(): Promise<ModuleRow[]>;
  /** 키는 이름에서 자동, 맨 뒤에 */
  createModule(input: NewModule): Promise<ModuleRow>;
  deleteModule(key: string): Promise<void>;
}

/** cache = 마지막으로 읽은 것 (먼저 그리기용). data 는 이미 캐시를 낀 서랍 */
export type Source = {
  data: DrawerData;
  schedule: ScheduleData;
  planner: PlannerData;
  meet: MeetData;
  meetPublic: MeetPublicData;
  live: LiveData;
  auth: Auth;
  me: MeData;
  admin: AdminData;
  demo: boolean;
  cache: DataCache;
};
