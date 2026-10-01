import type { Metadata } from "next";
import { PlannerView } from "../_ui/planner/PlannerView";

export const metadata: Metadata = { title: "플래너 · EZ.WORK" };

export default function Page() {
  return <PlannerView />;
}
