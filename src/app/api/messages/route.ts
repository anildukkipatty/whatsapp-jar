import { getOrCreateThread, InvalidMessageError, isAgentTyping, listMessages, receiveMessage } from "@/core/messages";
import { z } from "zod";
import { getSession } from "../../session";

const Query = z.object({
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const Body = z.object({
  text: z.string(),
  clientId: z.string().min(1).max(64),
  replyToId: z.number().int().nullish(),
});

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Not signed in" }, { status: 401 });

  const params = Object.fromEntries(new URL(request.url).searchParams);
  const query = Query.safeParse(params);
  if (!query.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  const ref = await getOrCreateThread(session.tenantId, session.userId);
  const [messages, typing] = await Promise.all([
    listMessages(ref, { beforeId: query.data.before, afterId: query.data.after, limit: query.data.limit }),
    isAgentTyping(ref),
  ]);
  return Response.json({ messages, typing });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Not signed in" }, { status: 401 });

  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  const ref = await getOrCreateThread(session.tenantId, session.userId);
  try {
    const message = await receiveMessage(ref, {
      text: body.data.text,
      dedupeKey: body.data.clientId,
      replyToId: body.data.replyToId,
    });
    return Response.json({ message });
  } catch (error) {
    if (error instanceof InvalidMessageError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
