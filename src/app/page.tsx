import { redirect } from "next/navigation";
import { Chat } from "./Chat";
import { getSession } from "./session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  if (!session) redirect("/login");
  return <Chat userName={session.userName} tenantName={session.tenantName} />;
}
