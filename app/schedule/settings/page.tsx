import type { Metadata } from "next";
import { ScheduleSettings } from "../../_ui/schedule/ScheduleSettings";

export const metadata: Metadata = { title: "일정 설정 · EZ.WORK" };

export default function Page() {
  return <ScheduleSettings />;
}
