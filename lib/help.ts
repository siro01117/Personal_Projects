// 모듈별 도움말 (docs/에이전트-연결.md 4장). 내용은 여기 한 곳 — 화면(app/_ui/Help.tsx)은 그리기만 한다.
// 모듈마다: 이 화면의 조작 4~6줄 · 에이전트에게 할 수 있는 말 3~5개 · 그 말에 쓰이는 도구 이름.
// 실제로 있는 기능만 적는다. 도구 이름은 mcp/tools.ts 의 것과 맞는지 시험(lib/help.test.ts)이 본다.

export type HelpKey = "drawer" | "report" | "schedule" | "planner" | "bench" | "meet" | "members" | "settings";

/** 조작 한 줄. { pc } 는 키보드 · 마우스로만 되는 것 — 폰(아래 시트)에서는 뺀다 */
export type HelpOp = string | { pc: string };

export type HelpTopic = {
  /** 팝업 맨 위 이름 */
  title: string;
  /** 이 화면 — 조작 줄 */
  ops: HelpOp[];
  /** 에이전트에게 — 누르면 복사되는 말 */
  asks: string[];
  /** 그 말에 쓰이는 도구 (mcp/tools.ts 의 이름) */
  tools: string[];
  /** 복사할 때 지금 보고 있는 주소를 뒤에 붙인다 ("이 보고서" 가 무엇인지 에이전트가 알게) */
  withLink?: true;
};

export const HELP: Record<HelpKey, HelpTopic> = {
  drawer: {
    title: "보고서 서랍",
    ops: [
      "두 번 누르면 열기 (터치는 한 번)",
      { pc: "끌어서 폴더로 옮기기" },
      "우클릭(길게 누르기) = 이름 바꾸기 · 복사 · 옮기기 · 공유 · 삭제",
      { pc: "Ctrl+C · X · V 복사 · 잘라내기 · 붙여넣기, Ctrl+Z 되돌리기" },
      { pc: "F2 이름 바꾸기 · Delete 휴지통으로 · Backspace 위 폴더" },
      "돋보기 = 제목 · 본문에서 찾기",
    ],
    asks: [
      "서랍 맨 위에 뭐가 있는지 보여 줘",
      "서랍에서 '요금제' 가 들어간 보고서 찾아 줘",
      "'조사' 폴더를 만들고 방금 찾은 내용을 보고서로 넣어 줘",
      "'지난 회의' 보고서를 '보관' 폴더로 옮겨 줘",
    ],
    tools: ["drawer_list", "drawer_mkdir", "drawer_update", "report_create"],
  },
  report: {
    title: "보고서",
    ops: [
      "연필 = 고치기. 글자를 눌러 바로 고친다",
      "고치는 동안: 블록을 골라 옆 도구 줄로 지우기 · 위아래 옮기기",
      { pc: "고치는 동안 키: Delete 지우기 · Alt+↑↓ 옮기기 · Ctrl+Z 되돌리기 · Ctrl+A 전부 고르기" },
      "우클릭(길게 누르기) = 댓글 · Markdown 으로 복사",
      "공유 링크를 켜면 로그인 없이 읽는다 — 읽은 사람 · 방명록 · 댓글이 모인다",
      { pc: "블록이 8개를 넘으면 오른쪽 차례로 건너뛴다" },
    ],
    asks: [
      "이 보고서 읽고 세 줄로 요약해 줘",
      "이 보고서 3번 블록 표에 행 하나 추가해 줘",
      "이 보고서에 달린 댓글을 읽고 고칠 곳을 정리해 줘",
      "이 보고서 출처에 방금 찾은 링크를 추가해 줘",
    ],
    tools: ["report_get", "report_edit"],
    withLink: true,
  },
  schedule: {
    title: "일정",
    ops: [
      { pc: "← → 주 옮기기 · T 오늘 · N 새 일정. 빈 칸을 두 번 눌러도 새 일정" },
      "누르면 보기, 고치기는 '수정' 을 한 번 더",
      { pc: "수정 중인 블록은 끌어 옮기고, 아래 끝을 끌어 늘린다" },
      "우클릭(길게 누르기) = 보기 · 수정 · 이번만 바꾸기 · 지우기",
      { pc: "오른쪽의 할 일을 격자로 끌면 그 시간에 일정이 생긴다" },
      "톱니 = 지점 · 이동시간 · 준비 시간",
    ],
    asks: [
      "이번 주 일정 알려 줘",
      "내일 2시간 넘게 비는 때를 찾아 줘",
      "금요일 15시에 치과 1시간 넣어 줘",
      "매주 화요일 19시 스터디를 반복 일정으로 넣어 줘",
      "수요일 회의를 목요일 같은 시간으로 옮겨 줘",
    ],
    tools: ["schedule_get", "schedule_save", "schedule_delete", "schedule_sync"],
  },
  planner: {
    title: "플래너",
    ops: [
      { pc: "N = 새 할 일" },
      "줄을 누르면 보기, 체크는 바로 끝냄",
      "우클릭(길게 누르기) = 끝냄 · 작업대 · 시간 정하기 · 반복으로 만들기 · 지우기",
      "정렬 칩으로 순서, 역할 칩으로 거르기",
      { pc: "'직접' 정렬에서는 끌어서 순서를 바꾼다" },
    ],
    asks: [
      "내일까지 할 일 중 대학 것만 알려 줘",
      "'보고서 초안 쓰기' 를 할 일로 넣어 줘. 금요일 마감, 90분",
      "'장보기' 를 끝냄으로 바꿔 줘",
      "매주 월요일마다 '주간 계획' 할 일이 생기게 해 줘",
      "'발표 준비' 를 내일 14시에 하도록 일정에 넣어 줘",
    ],
    tools: ["todo_list", "todo_save", "schedule_save"],
  },
  bench: {
    title: "작업대",
    ops: [
      "카드를 누르면 집중 화면",
      "'시작' 을 눌러야 시간이 간다 — 한 번에 하나만",
      { pc: "카드 · 단계는 끌어서 순서를 바꾼다" },
      { pc: "단계: Space 체크 · Enter 다음 줄 · Tab 들이기 · ↑↓ 옮겨 가기" },
      "가져올 만한 것을 누르면 작업대에 올라간다",
      "기록 = 주마다 잰 시간",
    ],
    asks: [
      "작업대에 뭐가 올라가 있는지 알려 줘",
      "'발표 준비' 를 작업대에 올리고 단계를 다섯 개로 쪼개 줘",
      "'발표 준비' 시간 재기 시작해 줘",
      "이번 주에 어디에 시간을 썼는지 역할별로 알려 줘",
    ],
    tools: ["todo_list", "todo_save", "work_log"],
  },
  meet: {
    title: "모임",
    ops: [
      "줄을 누르면 모임 화면, 고치기는 '수정'",
      "시간 맞추기: 후보 날짜를 고르고 공개 링크를 켜서 보낸다 — 받은 사람이 직접 칠한다",
      "추천 시간을 누르고 '이 시간으로' 를 한 번 더 누르면 정해진다 (일정에도 들어간다)",
      "정한 뒤에는 사람마다 온다 · 못 온다",
      "우클릭(길게 누르기) = 열기 · 수정 · 다음 모임 · 링크 복사 · 지우기",
    ],
    asks: [
      "다가오는 모임 알려 줘",
      "'팀 회의' 를 다음 주 월~수 후보로 열고 공개 링크를 켜 줘",
      "'팀 회의' 에서 다 같이 되는 시간을 추천해 줘",
      "'팀 회의' 를 목요일 19시로 정해 줘",
      "'팀 회의' 에서 나온 할 일 '회의록 정리' 를 넣어 줘",
    ],
    tools: ["meet_get", "meet_save", "todo_save"],
  },
  members: {
    title: "회원",
    ops: [
      "회원 추가 → 아이디 · 비밀번호를 한 번 보여 준다 (복사해서 전한다)",
      "켬 · 끔과 허용 모듈 칩은 누르면 바로 저장",
      "줄을 누르면 이름 · 비밀번호 · 토큰 폐기 · 지우기",
      "우클릭(길게 누르기) = 이름 고치기 · 비밀번호 다시 정하기 · 켬/끔 · 지우기",
      "추가 모듈: 이름과 https 주소를 넣고, 회원마다 칩으로 열어 준다",
    ],
    asks: [],
    tools: [],
  },
  settings: {
    title: "에이전트 연결",
    ops: [
      "이름을 적고 '토큰 만들기' — 명령 한 줄이 한 번만 보인다",
      "그 줄을 터미널에 붙여 넣으면 그 PC 의 Claude Code 가 EZ.WORK 도구를 쓴다",
      "읽기만 = 볼 수만 있고 고치지 못하는 토큰",
      "안 쓰는 PC 의 토큰은 폐기 — 바로 끊긴다",
      "토큰은 10개까지",
    ],
    asks: ["EZ.WORK 에 연결됐는지 서랍 목록으로 확인해 줘", "EZ.WORK 에서 오늘 일정 알려 줘", "EZ.WORK 에 남은 할 일을 알려 줘"],
    tools: ["drawer_list", "schedule_get", "todo_list"],
  },
};

export const opText = (op: HelpOp): string => (typeof op === "string" ? op : op.pc);

/** 그 화면에서 보일 조작 줄 — 폰이면 키보드 · 마우스로만 되는 것을 뺀다 */
export function opsFor(topic: HelpTopic, phone: boolean): string[] {
  return topic.ops.filter((o) => !phone || typeof o === "string").map(opText);
}

const under = (pathname: string, path: string) => pathname === path || pathname.startsWith(`${path}/`);

/** 주소 → 어느 모듈의 도움말인지. 모듈 화면이 아니면 null (단추를 그리지 않는다) */
export function helpKeyOf(pathname: string): HelpKey | null {
  if (under(pathname, "/drawer/r")) return "report";
  if (under(pathname, "/drawer")) return "drawer";
  if (under(pathname, "/schedule")) return "schedule";
  if (pathname === "/planner") return "planner";
  if (under(pathname, "/planner")) return "bench";
  if (under(pathname, "/meet")) return "meet";
  if (under(pathname, "/admin")) return "members";
  if (under(pathname, "/settings")) return "settings";
  return null;
}

/** 복사할 글: withLink 면 지금 주소(확인 모드 표시는 뺀다)를 붙인다 */
export function askText(topic: HelpTopic, ask: string, href: string | null): string {
  if (!topic.withLink || !href) return ask;
  try {
    const u = new URL(href);
    u.searchParams.delete("demo");
    u.hash = "";
    return `${ask} — ${u.origin}${u.pathname}`;
  } catch {
    return ask;
  }
}
