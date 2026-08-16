import { route } from "@/lib/auth";
import { db } from "@/lib/db";
import { Territory } from "@/lib/geocode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const territories = (await db()`
    select * from enactus_territories order by name asc`) as unknown as Territory[];
  return Response.json({ territories });
}, { territories: [] });
