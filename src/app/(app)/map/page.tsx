"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Check, Crosshair, ExternalLink, MapPin, RefreshCw, TriangleAlert } from "lucide-react";
import type {
  CircleMarkerProps, MapContainerProps, PopupProps, TileLayerProps,
} from "react-leaflet";
import { Lead, STATUS_COLUMNS } from "@/lib/types";
// Type-only: geocode.ts also holds the Nominatim client, which has no business
// in the browser bundle.
import type { GeoPrecision, Territory } from "@/lib/geocode";
import { SFU_BURNABY } from "@/lib/places";
import "leaflet/dist/leaflet.css";

// Leaflet reads `window` at import time, so every one of these has to be pulled
// in after hydration -- a top-level `import { MapContainer } from
// "react-leaflet"` crashes the render with "window is not defined" before the
// page ever reaches the browser. ssr:false is only legal inside a Client
// Component, which is why this whole file is one.
const MapContainer = dynamic<MapContainerProps>(() => import("react-leaflet").then((m) => m.MapContainer), { ssr: false });
const TileLayer = dynamic<TileLayerProps>(() => import("react-leaflet").then((m) => m.TileLayer), { ssr: false });
const Popup = dynamic<PopupProps>(() => import("react-leaflet").then((m) => m.Popup), { ssr: false });
const CircleMarker = dynamic<CircleMarkerProps & { children?: ReactNode }>(
  () => import("react-leaflet").then((m) => m.CircleMarker), { ssr: false });

// Plain SVG circles instead of Leaflet's default pin. The default icon is a PNG
// resolved by a bundler-relative URL that breaks under Turbopack and needs its
// paths patched by hand; a CircleMarker has no image at all and takes its colour
// straight from the pipeline status, which is what the pins have to encode.
const STATUS_COLOR: Record<string, string> = Object.fromEntries(
  STATUS_COLUMNS.map((s) => [s.id, s.color])
);

// lat/lng/geo_precision come back from `select *` but are not on Lead yet.
// Known limit: fold into Lead once the geocoding migration lands.
type MapLead = Lead & {
  lat: number | null;
  lng: number | null;
  geo_precision: GeoPrecision | null;
};

export default function MapPage() {
  const router = useRouter();
  const [leads, setLeads] = useState<MapLead[]>([]);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [geoRunning, setGeoRunning] = useState(false);
  const [geoNote, setGeoNote] = useState("");

  const load = useCallback(async () => {
    try {
      const [leadRes, terrRes] = await Promise.all([
        fetch("/api/leads?mode=sponsor"),
        fetch("/api/territories"),
      ]);
      const leadData = await leadRes.json();
      const terrData = await terrRes.json();
      if (leadData.error || terrData.error) setError(leadData.error ?? terrData.error);
      setLeads(leadData.leads ?? []);
      setTerritories(terrData.territories ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // load() is async, so every setState inside it lands after the fetch resolves
  // rather than during this render. The rule cannot see through the await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const placed = useMemo(() => leads.filter((l) => l.lat != null && l.lng != null), [leads]);
  // Never geocoded yet -- these are work the button below can still do.
  const pending = useMemo(() => leads.filter((l) => l.location && l.geo_precision == null), [leads]);
  // Asked and answered "nowhere specific enough to pin". Shown, never guessed at:
  // dropping "Global (Swiss HQ)" on a Lower Mainland centroid would make the map lie.
  const unplaceable = useMemo(
    () => leads.filter((l) => l.geo_precision != null && (l.lat == null || l.lng == null)),
    [leads]
  );

  // `force` clears every stamp first, which is the only way back from a
  // Nominatim outage: a lookup that failed on a network error is recorded as
  // "asked and answered", identically to a genuinely unplaceable one, and would
  // otherwise sit in the unplaceable list forever.
  async function runGeocode(force: boolean) {
    setGeoRunning(true);
    setError("");
    try {
      let guard = 20; // one batch is 40 leads; 20 rounds is far past the whole table
      let placedSoFar = 0;
      for (let round = 0; ; round++) {
        const res = await fetch("/api/geocode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Only the first round resets, or the queue is wiped every lap and
          // the loop never ends.
          body: JSON.stringify({ force: force && round === 0 }),
        });
        // A 401 or a gateway timeout is not JSON; without this the parse error
        // is what the panel shows instead of the actual status.
        const d = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
        if (d.error) { setError(d.error); break; }
        placedSoFar += d.placed ?? 0;
        setGeoNote(`${placedSoFar} placed · ${d.remaining} left`);
        // d.done === 0 would mean the batch made no progress, so stop rather
        // than spin: the guard is only there for a response we did not expect.
        if (!d.remaining || !d.done || --guard <= 0) break;
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGeoRunning(false);
    }
  }

  async function markSwept(t: Territory, swept: boolean) {
    const res = await fetch(`/api/territories/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ swept }),
    });
    const d = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
    if (d.error) return setError(d.error);
    setTerritories((ts) => ts.map((x) => (x.id === t.id ? d.territory : x)));
  }

  // The agent page owns its composer state and does not read a search param,
  // so the prompt travels by clipboard.
  async function sweepArea(t: Territory) {
    const prompt = `find sponsors in ${t.name}`;
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      // Navigating on a failed copy lands on an empty composer with no hint of
      // why, so the prompt is shown here instead of lost.
      setError(`Clipboard blocked — ask the agent for "${prompt}"`);
      return;
    }
    router.push("/agent");
  }

  return (
    <div className="h-full flex">
      <style>{`
        /* OSM tiles are built for light UIs and glare inside this theme. The
           filter hits only the tile pane, so popups and controls keep their
           real colours. */
        .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(.92) contrast(.9); }
        .leaflet-container { background: var(--bg); font-family: inherit; }
        .leaflet-popup-content-wrapper, .leaflet-popup-tip {
          background: var(--surface2); color: var(--text);
          border: 1px solid var(--border); box-shadow: 0 8px 24px rgba(0,0,0,.45);
        }
        .leaflet-popup-content { margin: 10px 12px; }
        .leaflet-control-zoom a { background: var(--surface2); color: var(--text); border-color: var(--border); }
      `}</style>

      <div className="flex-1 min-w-0 relative">
        <MapContainer
          center={[SFU_BURNABY.latitude, SFU_BURNABY.longitude]}
          zoom={10}
          scrollWheelZoom
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />

          {/* The gold territory radii used to draw here. Each one is a whole
              municipality wide, so at this zoom they covered the pins they were
              meant to give context to. The territories themselves are untouched
              -- they still drive the Areas list in the sidebar -- so bringing
              the overlay back is re-adding a <Circle> over `territories`. */}

          {placed.map((l) => {
            const c = STATUS_COLOR[l.status] ?? "#9aa1ac";
            return (
              <CircleMarker
                key={l.id}
                center={[l.lat as number, l.lng as number]}
                radius={l.geo_precision === "address" ? 7 : 5}
                pathOptions={{ color: c, fillColor: c, fillOpacity: 0.85, weight: 2 }}
              >
                <Popup>
                  <div className="text-xs" style={{ minWidth: 170 }}>
                    <div className="font-semibold text-sm">{l.company}</div>
                    {l.industry && <div style={{ color: "var(--muted)" }}>{l.industry}</div>}
                    {l.location && <div style={{ color: "var(--faint)" }}>{l.location}</div>}
                    {l.why_fit && (
                      <p className="mt-1.5 leading-relaxed">
                        <span style={{ color: "var(--gold)" }}>Why: </span>{l.why_fit}
                      </p>
                    )}
                    {l.website && (
                      <a
                        href={l.website.startsWith("http") ? l.website : `https://${l.website}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1.5 inline-flex items-center gap-1"
                        style={{ color: "var(--blue)" }}
                      >
                        <ExternalLink size={11} /> Website
                      </a>
                    )}
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>

      <aside
        className="w-80 shrink-0 border-l overflow-y-auto reason-scroll"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="p-4 border-b" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <MapPin size={15} style={{ color: "var(--gold)" }} /> Territory sweep
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {loading ? "Loading…" : `${placed.length} of ${leads.length} leads on the map`}
          </p>

          <button
            onClick={() => runGeocode(pending.length === 0)}
            disabled={geoRunning || leads.length === 0}
            className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50"
            style={{ background: "var(--accent)", color: "#fff" }}
          >
            <RefreshCw size={13} className={geoRunning ? "animate-spin" : ""} />
            {geoRunning
              ? "Geocoding…"
              : pending.length
                ? `Geocode remaining (${pending.length})`
                : "Re-geocode all"}
          </button>
          {geoNote && <p className="mt-1.5 text-[11px]" style={{ color: "var(--faint)" }}>{geoNote}</p>}
          {error && (
            <p className="mt-2 text-[11px] flex items-start gap-1.5" style={{ color: "var(--accent)" }}>
              <TriangleAlert size={12} className="shrink-0 mt-0.5" /> {error}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
            {STATUS_COLUMNS.map((s) => (
              <span key={s.id} className="flex items-center gap-1 text-[10px]" style={{ color: "var(--muted)" }}>
                <span className="w-2 h-2 rounded-full" style={{ background: s.color }} /> {s.label}
              </span>
            ))}
          </div>
        </div>

        <div className="p-4 border-b" style={{ borderColor: "var(--border)" }}>
          <div className="text-xs font-semibold mb-2" style={{ color: "var(--muted)" }}>
            Areas ({territories.filter((t) => t.swept_at).length}/{territories.length} swept)
          </div>
          {territories.length === 0 && !loading && (
            <p className="text-[11px]" style={{ color: "var(--faint)" }}>No territories seeded yet.</p>
          )}
          <div className="space-y-1.5">
            {territories.map((t) => {
              const swept = Boolean(t.swept_at);
              return (
                <div
                  key={t.id}
                  className="rounded-lg border p-2.5"
                  style={{ background: "var(--surface2)", borderColor: "var(--border)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium truncate">{t.name}</span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                      style={{ background: "var(--surface3)", color: swept ? "var(--green)" : "var(--faint)" }}
                    >
                      {swept ? `${t.lead_count} leads` : "unswept"}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      onClick={() => sweepArea(t)}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium"
                      style={{ background: "var(--surface3)", color: "var(--text)" }}
                      title="Copy a prompt for this area and open the agent"
                    >
                      <Crosshair size={11} /> Sweep this area
                    </button>
                    <button
                      onClick={() => markSwept(t, !swept)}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[11px]"
                      style={{ background: "transparent", color: swept ? "var(--green)" : "var(--faint)" }}
                      title={swept ? "Mark as not swept" : "Mark this area swept"}
                    >
                      <Check size={11} /> {swept ? "Swept" : "Mark swept"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="p-4">
          <div className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
            Not placeable ({unplaceable.length})
          </div>
          <p className="mt-1 text-[11px] leading-relaxed" style={{ color: "var(--faint)" }}>
            Mostly regions and countries, not places — left off the map rather than dropped
            on a centroid they do not belong to. The rest are rows the geocoder itself
            could not resolve.
          </p>
          <div className="mt-2 space-y-1">
            {unplaceable.map((l) => {
              // A 'city'/'address' row in here was pinnable and simply came back
              // empty. Filing it under "that is a region" would be this panel
              // making the same kind of claim the map refuses to make.
              const missed = l.geo_precision === "city" || l.geo_precision === "address";
              return (
                <div key={l.id} className="text-[11px] leading-snug">
                  <span style={{ color: "var(--text)" }}>{l.company}</span>
                  <span style={{ color: "var(--faint)" }}> — {l.location ?? "no location"}</span>
                  {missed && (
                    <span style={{ color: "var(--accent)" }}> · geocoder found nothing</span>
                  )}
                </div>
              );
            })}
          </div>
          {pending.length > 0 && (
            <p className="mt-3 text-[11px]" style={{ color: "var(--faint)" }}>
              {pending.length} lead{pending.length === 1 ? "" : "s"} not geocoded yet.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
