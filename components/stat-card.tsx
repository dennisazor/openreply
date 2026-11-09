/**
 * Stat Card
 *
 * Labelled metric: label, large value, and an optional note or trend.
 */

interface StatCardProps {
  label: string;
  value: string | number;
  note?: string;
  trend?: string;
  trendUp?: boolean;
}

export default function StatCard({ label, value, note, trend, trendUp }: StatCardProps) {
  return (
    <div className="panel flex flex-col gap-1.5 px-5 py-5">
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className="text-[34px] leading-[1.1] font-semibold tracking-[-0.022em] tabular-nums text-foreground">
        {value}
      </p>
      {note && <p className="text-[13px] text-muted">{note}</p>}
      {trend && (
        <p className={`text-xs ${trendUp ? "text-success" : "text-error"}`}>
          {trendUp ? "Up" : "Down"} {trend}
        </p>
      )}
    </div>
  );
}
