import { createFileRoute, Link } from "@tanstack/react-router";
import { Film, Tv, Star, Library } from "lucide-react";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { useTranslation } from "@/lib/i18n-hook";
import { TitleCard } from "@/components/TitleCard";
import { AdBlockPrompt, useAdBlockPrompt } from "@/components/AdBlockPrompt";
import { useBrowserInfo } from "@/hooks/use-browser-info";
import { getLatest, getSourceStatus, getStats, getTrending } from "@/lib/streaming.functions";

const statsQuery = queryOptions({
  queryKey: ["stats"],
  queryFn: () => getStats(),
});
const trendingQuery = queryOptions({
  queryKey: ["trending"],
  queryFn: () => getTrending(),
});
const latestQuery = queryOptions({
  queryKey: ["latest"],
  queryFn: () => getLatest(),
});
const statusQuery = queryOptions({
  queryKey: ["source-status"],
  queryFn: () => getSourceStatus(),
});

export const Route = createFileRoute("/_auth/")({
  head: () => ({
    meta: [
      { title: "StreamApp - Rdn - Catalogue Overview" },
      {
        name: "description",
        content:
          "Browse trending films and series, track catalogue stats and search the full library from one dashboard.",
      },
      { property: "og:title", content: "StreamApp - Rdn - Catalogue Overview" },
      {
        property: "og:description",
        content: "Trending titles, catalogue stats and full library search in one place.",
      },
    ],
  }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(statsQuery),
      context.queryClient.ensureQueryData(trendingQuery),
      context.queryClient.ensureQueryData(latestQuery),
      context.queryClient.ensureQueryData(statusQuery),
    ]);
  },
  component: Dashboard,
});

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: typeof Film;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
        <Icon className="size-4 text-primary" />
      </div>
      <p className="mt-3 font-display text-3xl font-semibold text-card-foreground">{value}</p>
    </div>
  );
}

function Dashboard() {
  const { t } = useTranslation();
  const { browser, adblockActive } = useBrowserInfo();
  const adBlockPrompt = useAdBlockPrompt({ browser, adblockActive });

  const { data: stats } = useSuspenseQuery(statsQuery);
  const { data: trending } = useSuspenseQuery(trendingQuery);
  const { data: latest } = useSuspenseQuery(latestQuery);
  const { data: status } = useSuspenseQuery(statusQuery);
  const hero = trending[0];

  return (
    <div className="space-y-8 md:space-y-12">
      {adBlockPrompt.shouldShow ? <AdBlockPrompt browser={adBlockPrompt.info.browser} /> : null}

      {hero ? (
        <section className="relative overflow-hidden rounded-2xl border border-border">
          <img
            src={hero.backdropUrl}
            alt={`${hero.name} artwork`}
            className="h-[240px] w-full object-cover md:h-[340px]"
          />
          <div className="absolute inset-0 bg-hero-fade" />
          <div className="absolute bottom-0 space-y-3 p-4 md:p-6">
            <p className="text-xs uppercase tracking-[0.3em] text-primary">
              {t("dashboard_trending")}
            </p>
            <h1 className="max-w-xl font-display text-3xl font-semibold text-foreground md:text-4xl">
              {hero.name}
            </h1>
            <p className="max-w-lg text-sm text-muted-foreground">
              {[
                hero.year || null,
                ...hero.genres,
                hero.type === "tv" ? t("dashboard_series") : t("dashboard_films"),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <Link
              to="/title/$id"
              params={{ id: hero.slug }}
              className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t("dashboard_viewAll")}
            </Link>
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2">
        <StatCard label={t("dashboard_titles")} value={stats.totalTitles} icon={Library} />
        <StatCard label={t("dashboard_films")} value={stats.movies} icon={Film} />
        <StatCard label={t("dashboard_series")} value={stats.series} icon={Tv} />
        <StatCard label={t("dashboard_avgScore")} value={stats.averageScore} icon={Star} />
      </section>

      <section className="space-y-4">
        <h2 className="font-display text-xl font-semibold text-foreground">
          {t("dashboard_trending")}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {trending.slice(0, 5).map((t) => (
            <TitleCard key={t.id} title={t} />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="font-display text-xl font-semibold text-foreground">
          {t("dashboard_recentlyAdded")}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {latest.slice(0, 5).map((t) => (
            <TitleCard key={t.id} title={t} />
          ))}
        </div>
      </section>

      {!status.live ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
          {t("dashboard_sampleNotice")}
        </p>
      ) : null}
    </div>
  );
}
