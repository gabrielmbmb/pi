/** Format a future reset timestamp as a compact duration (e.g. "2h 15m"). */
export function formatResetDuration(resetsAt: number): string | undefined {
  const minutes = Math.max(0, Math.round((resetsAt - Date.now()) / 60_000));
  if (minutes <= 0) return undefined;

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
