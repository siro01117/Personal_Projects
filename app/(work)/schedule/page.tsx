import type { Metadata } from "next";
import { ScheduleView } from "../../_ui/schedule/ScheduleView";

export const metadata: Metadata = { title: "일정 · EZ.WORK" };

export default function Page() {
  return <ScheduleView />;
}
