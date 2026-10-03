import type { Metadata } from "next";
import { BenchFocus } from "../../../../_ui/planner/BenchFocus";

export const metadata: Metadata = { title: "작업대 · EZ.WORK" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BenchFocus id={id} />;
}
