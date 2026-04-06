export function Skeleton({ className }: { className?: string }) {
    return <div className={`animate-pulse rounded bg-secondary ${className ?? 'h-4 w-full'}`} />;
}

export function SkeletonCard() {
    return (
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
        </div>
    );
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
    return (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border">
                <Skeleton className="h-4 w-32" />
            </div>
            {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="flex gap-4 px-5 py-3 border-b border-border/50 last:border-0">
                    {Array.from({ length: cols }).map((_, j) => (
                        <Skeleton key={j} className="h-4 flex-1" />
                    ))}
                </div>
            ))}
        </div>
    );
}
