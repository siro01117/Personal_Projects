import type { Metadata } from "next";
import { MeetListView } from "../../_ui/meet/MeetListView";

export const metadata: Metadata = { title: "모임 · EZ.WORK" };

export default function Page() {
  return <MeetListView />;
}
