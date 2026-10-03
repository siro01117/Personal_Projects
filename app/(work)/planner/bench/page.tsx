import type { Metadata } from "next";
import { BenchList } from "../../../_ui/planner/BenchList";

export const metadata: Metadata = { title: "작업대 · EZ.WORK" };

export default function Page() {
  return <BenchList />;
}
