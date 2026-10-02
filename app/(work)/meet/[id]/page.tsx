import type { Metadata } from "next";
import { MeetView } from "../../../_ui/meet/MeetView";

export const metadata: Metadata = { title: "모임 · EZ.WORK" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MeetView id={id} />;
}
