// 모듈 카탈로그 — 홈 Dock 카드가 될 기능 목록. 지점마다 켜고 끔(branch_module).
// mvp=true 인 것만 본점에서 처음부터 켜둠. 나머지는 앱에서 나중에 켬.
export type ModuleDef = {
  key: string;
  label: string;
  requires: string[]; // 이 모듈을 보려면 필요한 권한
  ord: number;
  mvp?: boolean;
};

// 실제 화면이 구현된 모듈의 경로. 모듈 이식할 때마다 여기 추가 → 홈 포털에서 클릭 진입.
// 여기 없는 모듈은 홈에서 '준비중'으로 뜸.
export const MODULE_ROUTES: Record<string, string> = {
  student: "/m/student",
  seat: "/m/seat",
  patrol: "/m/patrol",
  penalty: "/m/penalty",
  schedule: "/m/schedule",
  lunch: "/m/meal", // 구 미완성 화면(/m/lunch)은 폐기 대상 — 새 관리 화면은 /m/meal
};

export const MODULES: ModuleDef[] = [
  { key: "student", label: "학생 관리", requires: ["student.view"], ord: 20, mvp: true },
  { key: "seat", label: "좌석 배치도", requires: ["seat.view"], ord: 30, mvp: true },
  { key: "attendance", label: "출결", requires: ["attendance.view"], ord: 40, mvp: true },
  { key: "patrol", label: "순찰", requires: ["patrol.view"], ord: 45, mvp: true },
  { key: "penalty", label: "벌점", requires: ["penalty.view"], ord: 50, mvp: true },
  { key: "schedule", label: "학생 스케쥴러", requires: ["schedule.view"], ord: 60, mvp: true },
  { key: "payment", label: "결제·재무", requires: ["billing.view"], ord: 70, mvp: true },
  { key: "lunch", label: "도시락", requires: ["lunch.view"], ord: 80, mvp: true },
  { key: "grade", label: "성적 관리", requires: ["grade.view"], ord: 90 },
  { key: "planner", label: "학습 플래너", requires: ["planner.view"], ord: 95 },
  { key: "counsel", label: "주간 상담일지", requires: ["counsel.view"], ord: 100 },
  { key: "mentor", label: "멘토 배정", requires: ["mentoring.view"], ord: 110 },
  { key: "activity", label: "활동 로그", requires: ["activity.view"], ord: 120 },
];
