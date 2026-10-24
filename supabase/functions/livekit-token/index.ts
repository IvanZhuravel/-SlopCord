// Issues a short-lived LiveKit token for one voice room, only to members of
// that room's server. LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are
// Supabase function secrets, so the LiveKit key never ships inside the app and
// switching from LiveKit Cloud to a self-hosted server only changes them.
import { createClient } from "npm:@supabase/supabase-js@2";
import { AccessToken, RoomServiceClient, TrackSource } from "npm:livekit-server-sdk@2";

const MAX_IN_ROOM = 10;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method" });

  const livekitUrl = Deno.env.get("LIVEKIT_URL");
  const apiKey = Deno.env.get("LIVEKIT_API_KEY");
  const apiSecret = Deno.env.get("LIVEKIT_API_SECRET");
  if (!livekitUrl || !apiKey || !apiSecret) return reply(500, { error: "not_configured" });

  // Acts as the caller, so Row Level Security decides what they can see.
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return reply(401, { error: "not_signed_in" });

  let roomId: unknown;
  try {
    roomId = (await req.json()).room_id;
  } catch {
    return reply(400, { error: "bad_request" });
  }
  if (typeof roomId !== "string") return reply(400, { error: "bad_request" });

  // Not a member: the row is invisible and this comes back empty.
  const { data: room } = await supabase.from("rooms").select("id").eq("id", roomId).maybeSingle();
  if (!room) return reply(403, { error: "no_access" });
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, avatar_path")
    .eq("id", auth.user.id)
    .single();

  const httpUrl = livekitUrl.replace(/^ws/, "http");
  try {
    const people = await new RoomServiceClient(httpUrl, apiKey, apiSecret).listParticipants(room.id);
    if (people.length >= MAX_IN_ROOM && !people.some((p) => p.identity === auth.user.id)) {
      return reply(409, { error: "room_full" });
    }
  } catch {
    // The LiveKit room does not exist until someone joins: it is empty.
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: auth.user.id,
    name: profile?.display_name ?? "?",
    metadata: JSON.stringify({ avatar_path: profile?.avatar_path ?? null }),
    ttl: "10m",
  });
  token.addGrant({
    room: room.id,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    // Screen sharing is added in stage 2.
    canPublishSources: [TrackSource.MICROPHONE],
  });

  return reply(200, { serverUrl: livekitUrl, participantToken: await token.toJwt() });
});
