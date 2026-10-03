import type { Metadata } from "next";
import { AdminView } from "../../_ui/AdminView";

export const metadata: Metadata = { title: "회원 · EZ.WORK" };

export default function Page() {
  return <AdminView />;
}
