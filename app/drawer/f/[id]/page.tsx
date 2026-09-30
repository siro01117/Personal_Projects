import { Explorer } from "../../../_ui/Explorer";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Explorer folderId={id} />;
}
