// 권한(capability) 카탈로그 — 고정 키 목록. 어떤 역할이 뭘 갖는지는 앱에서 데이터로 정함.
export type Perm = { key: string; label: string; category: string };

export const PERMISSIONS: Perm[] = [
  // 계정·조직
  { key: "hq.cross_branch", label: "전 지점 열람", category: "계정·조직" },
  { key: "branch.create", label: "지점 생성", category: "계정·조직" },
  { key: "module.assign", label: "모듈 할당", category: "계정·조직" },
  { key: "branch.settings", label: "지점 설정·통계", category: "계정·조직" },
  { key: "account.provision", label: "계정 발급", category: "계정·조직" },
  { key: "role.assign", label: "역할 부여", category: "계정·조직" },
  // 학생·운영
  { key: "student.view", label: "학생 조회", category: "학생·운영" },
  { key: "student.edit", label: "학생 수정", category: "학생·운영" },
  { key: "student.assign_mentor", label: "멘토 배정", category: "학생·운영" },
  { key: "seat.view", label: "좌석 조회", category: "학생·운영" },
  { key: "seat.manage", label: "좌석 관리", category: "학생·운영" },
  { key: "attendance.view", label: "출결 조회", category: "학생·운영" },
  { key: "attendance.edit", label: "출결 관리", category: "학생·운영" },
  // 생활
  { key: "penalty.view", label: "벌점 조회", category: "생활" },
  { key: "penalty.manage", label: "벌점 관리", category: "생활" },
  { key: "patrol.view", label: "순찰 조회", category: "생활" },
  { key: "patrol.manage", label: "순찰 관리", category: "생활" },
  // 결제
  { key: "billing.view", label: "결제 조회", category: "결제" },
  { key: "billing.manage", label: "결제 관리", category: "결제" },
  // 일정·부가
  { key: "schedule.view", label: "스케쥴 조회", category: "일정·부가" },
  { key: "schedule.manage", label: "스케쥴 관리", category: "일정·부가" },
  { key: "lunch.view", label: "도시락 조회", category: "일정·부가" },
  { key: "lunch.manage", label: "도시락 관리", category: "일정·부가" },
  { key: "activity.view", label: "활동로그 조회", category: "일정·부가" },
  { key: "activity.view.all", label: "전체 활동로그", category: "일정·부가" },
  // 상담·멘토·학습
  { key: "counsel.view", label: "상담 조회", category: "상담·학습" },
  { key: "mentoring.view", label: "멘토링 조회", category: "상담·학습" },
  { key: "mentoring.manage", label: "멘토링 관리", category: "상담·학습" },
  { key: "mentoring.log", label: "멘토링 기록", category: "상담·학습" },
  { key: "grade.view", label: "성적 조회", category: "상담·학습" },
  { key: "grade.manage", label: "성적 관리", category: "상담·학습" },
  { key: "planner.view", label: "플래너 조회", category: "상담·학습" },
  { key: "planner.manage", label: "플래너 관리", category: "상담·학습" },
  // 수업
  { key: "class.manage", label: "수업 관리", category: "수업" },
  { key: "content.author", label: "콘텐츠 작성", category: "수업" },
  // 본인
  { key: "self.use", label: "본인 이용", category: "본인" },
];
