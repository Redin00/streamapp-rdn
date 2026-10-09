import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Check, Clock, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "@/lib/i18n-hook";

import { historyQuery, libraryQuery } from "@/lib/auth/queries";
import {
  addToLibrary,
  removeFromLibrary,
  removeWatchMarker,
  formatWatchPosition,
} from "@/lib/library.functions";
import { ScrollableRow } from "@/components/ScrollableRow";
import { getTitle } from "@/lib/streaming.functions";

const titleQuery = (id: string) =>
  queryOptions({
    queryKey: ["title", id],
    queryFn: () => getTitle({ data: { id } }),
  });

export const Route = createFileRoute("/_auth/title/$id")({
  loader: async ({ context, params }) => {
    const [title] = await Promise.all([
      context.queryClient.ensureQueryData(titleQuery(params.id)),
      context.queryClient.ensureQueryData(libraryQuery),
      context.queryClient.ensureQueryData(historyQuery),
    ]);
    if (!title) throw notFound();
    return { name: title.name, plot: title.plot };
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {
        meta: [
          { title: "Title unavailable - StreamApp - Rdn" },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    const t = `${loaderData.name} - StreamApp - Rdn`;
    return {
      meta: [
        { title: t },
        { name: "description", content: loaderData.plot.slice(0, 155) },
        { property: "og:title", content: t },
        { property: "og:description", content: loaderData.plot.slice(0, 155) },
      ],
    };
  },
  component: TitlePage,
});

function TitlePage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(titleQuery(id));
  const { data: library } = useSuspenseQuery(libraryQuery);
  const { data: history } = useSuspenseQuery(historyQuery);
  const { t } = useTranslation();
  const [season, setSeason] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;

  const title = data;
  const saved = library?.some((item) => item.slug === title.slug) ?? false;

  // Entries in the watch history for this title (any season/episode).
  const myHistory = history?.filter((h) => h.slug === title.slug && h.marker > 0) ?? [];

  async function toggleSave() {
    setBusy(true);
    setError(null);
    try {
      const result = saved
        ? await removeFromLibrary({ data: { slug: title.slug } })
        : await addToLibrary({ data: { slug: title.slug, title } });
      setBusy(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: libraryQuery.queryKey });
    } catch (e) {
      setBusy(false);
      setError(String(e));
    }
  }

  async function removeProgress(season: number, episode: number) {
    setBusy(true);
    setError(null);
    try {
      const result = await removeWatchMarker({
        data: { slug: title.slug, season, episode },
      });
      setBusy(false);
      if (!result.ok) {
        setError("Could not clear playback progress");
        return;
      }
      queryClient.setQueryData<typeof history>(
        historyQuery.queryKey,
        (current) =>
          current?.map((entry) =>
            entry.slug === title.slug && entry.season === season && entry.episode === episode
              ? { ...entry, marker: 0 }
              : entry,
          ) ?? null,
      );
      void queryClient.invalidateQueries({ queryKey: historyQuery.queryKey });
    } catch (e) {
      setBusy(false);
      setError(String(e));
    }
  }

  const current = data.seasons.find((s) => s.number === season);

  return (
    <div className="space-y-10">
      <section className="relative overflow-hidden rounded-2xl border border-border">
        <img
          src={data.backdropUrl}
          alt={`${data.name} artwork`}
          className="h-[300px] w-full object-cover md:h-[400px]"
        />
        <div className="absolute inset-0 bg-hero-fade" />
        <div className="absolute bottom-0 flex flex-wrap items-end gap-6 p-6 md:p-10">
          <img
            src={data.posterUrl}
            alt={`${data.name} poster`}
            className="hidden w-32 rounded-lg border border-border shadow-xl md:block"
          />
          <div className="space-y-2">
            <h1 className="font-display text-4xl font-semibold text-foreground">{data.name}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-1 text-primary">
                <span className="size-4 fill-current" />
                {data.score.toFixed(1)}
              </span>
              <span>{data.year}</span>
              <span className="flex items-center gap-1">
                <Clock className="size-4" />
                {data.runtime} min
              </span>
              <span className="rounded border border-border px-2 py-0.5 text-xs">
                {data.quality}
              </span>
              <span>{data.status}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Link
                to="/watch/$id"
                params={{ id }}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Play className="size-4 fill-current" />
                {data.type === "tv" ? t("watch_nowPlaying") : t("title_episode")}
              </Link>
              <button
                type="button"
                onClick={() => void toggleSave()}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background/70 px-4 py-2 text-sm font-medium text-foreground backdrop-blur transition-colors hover:border-primary/60 disabled:opacity-60"
              >
                {saved ? <Check className="size-4" /> : <Plus className="size-4" />}
                {saved ? t("title_inLibrary") : t("title_addToLibrary")}
              </button>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </div>
      </section>

      {/* Resume markers for this title */}
      {myHistory.length > 0 ? (
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 font-display text-base font-semibold text-foreground">
            {t("watch_resumeTitle")}
          </h2>
          <ul className="space-y-2">
            {myHistory.map((entry) => (
              <li
                key={`${entry.slug}:${entry.season}:${entry.episode}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-card-foreground">
                    {entry.season > 0 || entry.episode > 0
                      ? `S${entry.season} E${entry.episode}`
                      : entry.title.name}
                  </p>
                  {entry.marker > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {formatWatchPosition(entry.marker)} watched — {t("watch_resumeSub")}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Link
                    to="/watch/$id"
                    params={{ id }}
                    search={
                      entry.season > 0 || entry.episode > 0
                        ? { s: entry.season, e: entry.episode }
                        : {}
                    }
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    <Play className="size-3 fill-current" />
                    {t("watch_resume")}
                  </Link>
                  <button
                    type="button"
                    onClick={() => void removeProgress(entry.season, entry.episode)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive disabled:opacity-60"
                    title={t("watch_removeProgress")}
                  >
                    <Trash2 className="size-3.5" />
                    {t("watch_removeProgress")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="grid gap-8 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <h2 className="font-display text-lg font-semibold text-foreground">Synopsis</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{data.plot}</p>
        </div>
        <div className="space-y-4">
          <h2 className="font-display text-lg font-semibold text-foreground">Details</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between border-b border-border pb-2">
              <dt className="text-muted-foreground">{t("titleCard_addedToLibrary")}</dt>
              <dd>{data.type === "tv" ? t("dashboard_series") : t("dashboard_films")}</dd>
            </div>
            <div className="flex justify-between border-b border-border pb-2">
              <dt className="text-muted-foreground">{t("title_genres")}</dt>
              <dd>{data.genres.join(", ")}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t("title_cast")}</dt>
              <dd className="text-right">
                {data.cast.length > 0 ? data.cast.join(", ") : t("title_castUnavailable")}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {data.seasons.length > 0 ? (
        <section className="space-y-4">
          <ScrollableRow>
            {data.seasons.map((s) => (
              <button
                key={s.number}
                onClick={() => setSeason(s.number)}
                className={`shrink-0 rounded-full border px-4 py-1.5 text-xs font-medium transition-colors ${
                  season === s.number
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-primary/50"
                }`}
              >
                {s.name}
              </button>
            ))}
          </ScrollableRow>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {(current?.episodes ?? []).map((ep) => (
              <li key={ep.id}>
                <Link
                  to="/watch/$id"
                  params={{ id }}
                  search={{ s: season, e: ep.number }}
                  className="group flex gap-4 p-4 hover:bg-muted/50"
                >
                  <span className="w-8 shrink-0 font-display text-lg text-muted-foreground">
                    {ep.number}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-card-foreground">{ep.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {ep.plot} - {ep.duration} min
                    </p>
                  </div>
                  <Play className="size-4 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
