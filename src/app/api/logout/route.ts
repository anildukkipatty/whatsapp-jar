import { signOut } from "../../session";

export async function POST() {
  await signOut();
  return Response.json({ ok: true });
}
