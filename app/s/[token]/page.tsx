import type { Metadata } from "next";
import { SharedView } from "../../_ui/SharedView";

// 공유 페이지는 검색엔진에 올리지 않는다
export const metadata: Metadata = {
  title: "EZ.WORK",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedView token={token} />;
}
