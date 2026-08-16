// Seed the territory list the map sweeps, one row per Lower Mainland
// municipality the club can realistically reach.
//
// Coordinates are geocoded through the same helper the leads use rather than
// typed in here: a hand-copied centre is a number nobody can check, and if the
// geocoder is wrong about a place the pins are wrong in exactly the same way,
// which is the behaviour you want from a map.
//
// Idempotent -- run it again after adding a name and only the new ones cost a
// lookup.

import { neon } from "@neondatabase/serverless";
import { geocode } from "../src/lib/geocode.ts";

const AREAS = [
  "Vancouver", "Burnaby", "Surrey", "Richmond", "Coquitlam",
  "Port Coquitlam", "Port Moody", "New Westminster", "North Vancouver", "West Vancouver",
  "Delta", "Langley", "Maple Ridge", "Pitt Meadows", "White Rock",
  "Abbotsford", "Chilliwack", "Mission", "Squamish", "Anmore",
  "Bowen Island", "Lions Bay", "Belcarra", "Tsawwassen", "Ladner",
];

const sql = neon(process.env.DATABASE_URL!);

const have = new Set(
  ((await sql`select name from enactus_territories`) as { name: string }[]).map((r) => r.name)
);

let added = 0;
for (const name of AREAS) {
  if (have.has(name)) continue;
  const point = await geocode(`${name}, BC, Canada`);
  if (!point) {
    console.log(`  skip ${name} — geocoder found nothing`);
    continue;
  }
  await sql`
    insert into enactus_territories (name, lat, lng)
    values (${name}, ${point.lat}, ${point.lng})
    on conflict (name) do nothing`;
  added++;
}

const total = (await sql`select count(*)::int as n from enactus_territories`) as { n: number }[];
console.log(`territories: +${added} added, ${total[0].n} total`);
