import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { TitleCard } from "@/components/TitleCard";
import { ScrollableRow } from "@/components/ScrollableRow";
import { getLatest } from "@/lib/streaming.functions";
import { useTranslation } from "@/lib/i18n-hook";

const catalogueQuery = queryOptions({
  queryKey: ["catalogue"],
  queryFn: () => getLatest(),
});

export const Route = createFileRoute("/_auth/browse")({
  head: () => ({
    meta: [
      { title: "Browse Catalogue — StreamApp - Rdn" },
      {
        name: "description",
        content:
          "Filter the whole catalogue by films, series and genre with posters, ratings and release years.",
      },
      { property: "og:title", content: "Browse Catalogue — StreamApp - Rdn" },
      {
        property: "og:description",
        content: "Filter every film and series in the catalogue by type and genre.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(catalogueQuery),
  component: Browse,
});

type Filter = "all" | "movie" | "tv";

function Browse() {
  const { t } = useTranslation();
  const { data: titles } = useSuspenseQuery(catalogueQuery);
  const [filter, setFilter] = useState<Filter>("all");
  const [genre, setGenre] = useState<string>("all");

  const genres = ["all", ...new Set(titles.flatMap((t) => t.genres))];
  const hasGenres = genres.length > 1;
  const visible = titles.filter(
    (t) => (filter === "all" || t.type === filter) && (genre === "all" || t.genres.includes(genre)),
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-semibold text-foreground">{t("browse_title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {visible.length} titles in the catalogue
        </p>
      </div>

      <ScrollableRow>
        {(["all", "movie", "tv"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`shrink-0 rounded-full border px-4 py-1.5 text-xs font-medium transition-colors ${
              filter === f
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:border-primary/50"
            }`}
          >
            {f === "all"
              ? t("browse_all")
              : f === "movie"
                ? t("dashboard_films")
                : t("dashboard_series")}
          </button>
        ))}
        {hasGenres ? (
          <>
            <span className="mx-1 h-5 w-px shrink-0 bg-border" />
            {genres.map((g) => (
              <button
                key={g}
                onClick={() => setGenre(g)}
                className={`shrink-0 rounded-full border px-4 py-1.5 text-xs font-medium transition-colors ${
                  genre === g
                    ? "border-primary bg-primary/10 text-primary font-semibold"
                    : "border-border text-muted-foreground hover:border-primary/50"
                }`}
              >
                {g === "all" ? t("browse_all") : g}
              </button>
            ))}
          </>
        ) : null}
      </ScrollableRow>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {visible.map((t) => (
          <TitleCard key={t.id} title={t} />
        ))}
      </div>
    </div>
  );
}
