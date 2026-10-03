import type { Metadata } from "next";
import { AgentSettings } from "../../../_ui/AgentSettings";

export const metadata: Metadata = { title: "에이전트 연결 · EZ.WORK" };

export default function Page() {
  return <AgentSettings />;
}
