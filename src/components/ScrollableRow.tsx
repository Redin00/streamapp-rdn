import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScrollableRowProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
}

export function ScrollableRow({
  children,
  className,
  innerClassName,
  ...props
}: ScrollableRowProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);

  const checkScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hasOverflow = el.scrollWidth > el.clientWidth + 2;
    setCanScrollLeft(el.scrollLeft > 6);
    setCanScrollRight(hasOverflow && el.scrollLeft < el.scrollWidth - el.clientWidth - 6);
  }, []);

  React.useEffect(() => {
    checkScroll();
    const el = scrollRef.current;
    if (!el) return;

    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    window.addEventListener("resize", checkScroll);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", checkScroll);
    };
  }, [checkScroll, children]);

  const handleScroll = (direction: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = Math.max(el.clientWidth * 0.65, 200);
    el.scrollBy({
      left: direction === "left" ? -distance : distance,
      behavior: "smooth",
    });
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    if (e.deltaY !== 0 && el.scrollWidth > el.clientWidth) {
      el.scrollLeft += e.deltaY;
      checkScroll();
    }
  };

  return (
    <div className={cn("relative group/scroll flex items-center w-full", className)} {...props}>
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => handleScroll("left")}
          aria-label="Scorri a sinistra"
          className="absolute -left-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card/90 text-foreground shadow-lg backdrop-blur-sm transition-all hover:bg-accent hover:scale-110 active:scale-95"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={checkScroll}
        onWheel={handleWheel}
        className={cn(
          "flex w-full items-center gap-2 overflow-x-auto whitespace-nowrap scroll-smooth py-1.5 px-1 scrollbar-thin",
          innerClassName,
        )}
      >
        {children}
      </div>

      {canScrollRight && (
        <button
          type="button"
          onClick={() => handleScroll("right")}
          aria-label="Scorri a destra"
          className="absolute -right-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card/90 text-foreground shadow-lg backdrop-blur-sm transition-all hover:bg-accent hover:scale-110 active:scale-95"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
