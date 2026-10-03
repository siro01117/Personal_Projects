import type { Metadata } from "next";
import { LogView } from "../../../_ui/planner/LogView";

export const metadata: Metadata = { title: "기록 · EZ.WORK" };

export default function Page() {
  return <LogView />;
}
