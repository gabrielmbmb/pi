import { ROOT_AGENT_NAME } from "../constants.ts";
import { TERMINAL_STATUSES, subtreeOf, type SubagentNode, type SubagentRegistry } from "../manager.ts";
import { plainText } from "../activity.ts";

export type TreeFilter = "all" | "active" | "failed";
export interface TreeRow {
  name: string;
  node?: SubagentNode;
  prefix: string;
  hasChildren: boolean;
  collapsed: boolean;
  descendants: number;
  activeDescendants: number;
  failedDescendants: number;
}

export function isActive(node: SubagentNode): boolean {
  return !TERMINAL_STATUSES.includes(node.status);
}

/** Filtering retains ancestors, including collected/expired parents. */
export function treeRows(
  registry: SubagentRegistry,
  collapsed: ReadonlySet<string>,
  query = "",
  filter: TreeFilter = "all",
): TreeRow[] {
  const children = new Map<string, SubagentNode[]>();
  for (const node of [...registry.nodes.values()].sort((a, b) => a.spawnIndex - b.spawnIndex)) {
    const parent = registry.nodes.has(node.parentName) ? node.parentName : ROOT_AGENT_NAME;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  const included = new Set<string>();
  const needle = query.trim().replace(/\s+/g, " ").toLowerCase();
  for (const node of registry.nodes.values()) {
    if (filter === "active" && !isActive(node)) continue;
    if (filter === "failed" && node.status !== "error" && node.status !== "partial") continue;
    if (!plainText(`${node.name} ${node.prompt ?? node.promptSnippet ?? ""} ${node.status}`).replace(/\s+/g, " ").toLowerCase().includes(needle)) continue;
    let current: SubagentNode | undefined = node;
    const seen = new Set<string>();
    while (current && !seen.has(current.name)) {
      seen.add(current.name);
      included.add(current.name);
      current = registry.nodes.get(current.parentName);
    }
  }
  if (included.size === 0) return [];
  const filtering = Boolean(query) || filter !== "all";
  const rows: TreeRow[] = [{
    name: ROOT_AGENT_NAME, prefix: "", hasChildren: true,
    collapsed: !filtering && collapsed.has(ROOT_AGENT_NAME),
    descendants: registry.nodes.size,
    activeDescendants: [...registry.nodes.values()].filter(isActive).length,
    failedDescendants: [...registry.nodes.values()].filter((node) => node.status === "error").length,
  }];
  const visited = new Set<string>();
  const visit = (parent: string, prefix: string) => {
    const nodes = (children.get(parent) ?? []).filter((node) => included.has(node.name));
    nodes.forEach((node, i) => {
      if (visited.has(node.name)) return;
      visited.add(node.name);
      const last = i === nodes.length - 1;
      const folded = !filtering && collapsed.has(node.name);
      const descendants = subtreeOf(registry.nodes, node.name);
      rows.push({
        name: node.name, node, prefix: `${prefix}${last ? "└─ " : "├─ "}`,
        hasChildren: (children.get(node.name)?.length ?? 0) > 0,
        collapsed: folded, descendants: descendants.length,
        activeDescendants: descendants.filter(isActive).length,
        failedDescendants: descendants.filter((child) => child.status === "error").length,
      });
      if (!folded) visit(node.name, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  if (!rows[0]!.collapsed) visit(ROOT_AGENT_NAME, "");
  return rows;
}

export function breadcrumb(registry: SubagentRegistry, name: string): string {
  const parts: string[] = [];
  let node = registry.nodes.get(name);
  const seen = new Set<string>();
  while (node && !seen.has(node.name)) {
    seen.add(node.name);
    parts.unshift(node.name);
    node = registry.nodes.get(node.parentName);
  }
  return ["main", ...parts].join(" › ");
}

export function cancelTargets(registry: SubagentRegistry, name: string): SubagentNode[] {
  const nodes = name === ROOT_AGENT_NAME
    ? [...registry.nodes.values()]
    : [registry.nodes.get(name), ...subtreeOf(registry.nodes, name)];
  return nodes.filter((node): node is SubagentNode => node !== undefined && isActive(node));
}

export function deliveryLabel(node: SubagentNode): string {
  if (node.delivery) {
    const parent = node.delivery.parent === ROOT_AGENT_NAME ? "main" : node.delivery.parent;
    return node.delivery.kind === "merged" ? `Merged into ${parent}` : `Collected by ${parent}`;
  }
  return "Result retained for inspection";
}

export function currentActivity(registry: SubagentRegistry, node: SubagentNode, now: number): string {
  if (node.status === "queued") return `Queued #${registry.queuePosition(node.name) + 1}`;
  if (node.status === "merging") {
    const children = [...registry.nodes.values()].filter((child) => child.parentName === node.name && isActive(child));
    return `Waiting on children${children.length ? `: ${children.map((child) => child.name).join(", ")}` : "; assembling results"}`;
  }
  if (!isActive(node)) return node.status === "error" ? `Failed: ${node.result?.error ?? "unknown error"}` : node.status;
  const tools = node.activity?.entries.filter((entry) => entry.state === "running") ?? [];
  if (tools.length) return tools.map((entry) => `${entry.title} (${Math.max(0, Math.floor((now - entry.at) / 1000))}s)`).join(" · ");
  return node.phase ?? "Starting session";
}
