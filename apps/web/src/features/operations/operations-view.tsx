import React, { useEffect, useState } from "react";
import type { Health, GlobalBrakeState, LapList } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Activity, ShieldAlert, Cpu, RefreshCw } from "lucide-react";

export function OperationsView() {
  const [health, setHealth] = useState<Health | null>(null);
  const [brakes, setBrakes] = useState<GlobalBrakeState | null>(null);
  const [laps, setLaps] = useState<LapList>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [_error, setError] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [h, b, l] = await Promise.all([
        client.health().catch(() => null),
        client.brakes().catch(() => null),
        client.laps().catch(() => []),
      ]);
      setHealth(h);
      setBrakes(b);
      setLaps(l);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  return (
    <div className="space-y-6" data-testid="operations-view">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">
            Animus System Operations
          </h2>
          <p className="text-xs text-[var(--muted-foreground)]">
            Status of host bridge, execution brakes, and native workflow history
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={loadData}
          disabled={loading}
          aria-label="Refresh operations status"
        >
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          <span>Refresh</span>
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Health Panel */}
        <div className="p-4 rounded-lg border border-[var(--border)] bg-[var(--container)] space-y-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-[var(--accent)]" />
            <h3 className="text-sm font-semibold text-[var(--foreground)]">Runtime Health</h3>
          </div>
          {health ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between py-1 border-b border-[var(--border)]">
                <span className="text-[var(--muted-foreground)]">Status</span>
                <Badge variant={health.status === "healthy" ? "active" : "destructive"}>
                  {health.status}
                </Badge>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-[var(--border)]">
                <span className="text-[var(--muted-foreground)]">Build Candidate</span>
                <span className="font-mono text-[var(--foreground)]">
                  {health.buildId?.slice(0, 12) || "unknown"}
                </span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-[var(--muted-foreground)]">Engine Host Link</span>
                <span className="font-mono text-emerald-400">
                  {health.host?.status ?? "connected"}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-[var(--muted-foreground)]">
              {loading ? "Checking backend connectivity..." : "Backend health unreachable"}
            </p>
          )}
        </div>

        {/* Brakes Panel */}
        <div className="p-4 rounded-lg border border-[var(--border)] bg-[var(--container)] space-y-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-[var(--accent)]" />
            <h3 className="text-sm font-semibold text-[var(--foreground)]">Global Launch Brakes</h3>
          </div>
          {brakes ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between py-1 border-b border-[var(--border)]">
                <span className="text-[var(--muted-foreground)]">Emergency STOP Brake</span>
                <Badge variant={brakes.global_launch_brake ? "destructive" : "active"}>
                  {brakes.global_launch_brake ? "STOPPED" : "Clear"}
                </Badge>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-[var(--muted-foreground)]">Scheduler PAUSE Marker</span>
                <Badge variant={brakes.schedule_pause ? "held" : "active"}>
                  {brakes.schedule_pause ? "PAUSED" : "Running"}
                </Badge>
              </div>
            </div>
          ) : (
            <p className="text-xs text-[var(--muted-foreground)]">
              {loading ? "Reading brake states..." : "Brake status unavailable"}
            </p>
          )}
        </div>
      </div>

      {/* Laps List */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-[var(--accent)]" />
          <h3 className="text-sm font-semibold text-[var(--foreground)]">
            Execution Lap Projections
          </h3>
        </div>

        {laps.length === 0 ? (
          <div className="p-8 text-center rounded-lg border border-[var(--border)] bg-[var(--container)]">
            <p className="text-xs text-[var(--muted-foreground)]">
              No recent loop runs or lap records found.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lap ID</TableHead>
                <TableHead>Workflow</TableHead>
                <TableHead>Product Status</TableHead>
                <TableHead>Candidate Head</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {laps.map((lap) => (
                <TableRow key={lap.id}>
                  <TableCell className="font-mono text-xs">{lap.id}</TableCell>
                  <TableCell className="text-xs">{lap.workflow_name}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        lap.product_status === "waiting_approval"
                          ? "accent"
                          : lap.product_status === "completed"
                            ? "active"
                            : "default"
                      }
                    >
                      {lap.product_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-[var(--muted-foreground)]">
                    {lap.candidate_head ? lap.candidate_head.slice(0, 10) : "n/a"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
