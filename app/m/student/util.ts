// 학생 표시용 순수 헬퍼·타입 ('use client' 아님 → 서버/클라 공용, 서버가 호출해도 안전)
export type Student = {
  id: string;
  name: string;
  level: string | null;
  grade: string | null;
  school: string | null;
  is_repeat: boolean | null;
  status: string;
  guardian_phone: string | null;
  student_phone: string | null;
  birthdate: string | null;
  enrolled_at: string | null;
  seat_number: number | null;
  seat_id: string | null;
  access_code: string | null; // 공개 폼 로그인 코드
};

export const STU_STATUS: Record<string, string> = { enrolled: "재원", leave: "휴원" };

export function levelLabel(s: { level: string | null; grade: string | null; is_repeat: boolean | null }): string {
  if (s.level === "adult") return s.is_repeat ? "성인·N수생" : "성인";
  const lv = s.level === "middle" ? "중" : s.level === "high" ? "고" : "";
  return lv && s.grade ? `${lv}${s.grade}` : lv || s.grade || "";
}
