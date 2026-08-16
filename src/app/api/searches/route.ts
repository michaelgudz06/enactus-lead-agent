import { route } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_session, req: Request) => {
  const mode = new URL(req.url).searchParams.get("mode");
  const sql = db();
  const searches =
    mode === "sponsor" || mode === "sales"
      ? await sql`select * from enactus_searches where mode = ${mode}
                  order by created_at desc limit 20`
      : await sql`select * from enactus_searches
                  order by created_at desc limit 20`;
  return Response.json({ searches });
}, { searches: [] });
