import type { Metadata } from "next";
import { LoginView } from "../_ui/LoginView";

export const metadata: Metadata = { title: "로그인 · EZ.WORK" };

export default function Page() {
  return <LoginView />;
}
