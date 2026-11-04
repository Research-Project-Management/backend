export interface CpmInputRelation {
  id?: string;
  targetWorkItemId?: string;
  targetId?: string;
  type: string;
}

export interface CpmInputItem {
  id: string;
  title: string;
  startDate?: Date | string | null;
  dueDate?: Date | string | null;
  completed?: boolean;
  relations?: CpmInputRelation[];
}

export interface CpmNodeDto {
  id: string;
  title: string;
  durationDays: number;
  es: number;
  ef: number;
  ls: number;
  lf: number;
  totalFloat: number;
  freeFloat: number;
  isCritical: boolean;
  predecessors: string[];
  successors: string[];
  hasActualDates: boolean;
}

export interface CpmAnalysisResponseDto {
  nodes: Record<string, CpmNodeDto>;
  criticalPathItemIds: string[];
  criticalEdges: string[];
  violatedEdges: string[];
  hasCycle: boolean;
  cycleNodeIds: string[];
  projectDurationDays: number;
  topologicalOrder: string[];
}

const MS_PER_DAY = 86_400_000;

function parseDate(raw?: Date | string | null): Date | null {
  if (!raw) return null;
  const d = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function computeDurationDays(item: CpmInputItem): number {
  const start = parseDate(item.startDate);
  const due = parseDate(item.dueDate);
  if (start && due) {
    const diffDays = Math.round((due.getTime() - start.getTime()) / MS_PER_DAY);
    return Math.max(1, diffDays + 1);
  }
  return 1;
}

interface DirectedEdge {
  fromId: string;
  toId: string;
  relationType: string;
}

function buildDependencyEdges(items: CpmInputItem[]): DirectedEdge[] {
  const itemIds = new Set(items.map((i) => i.id));
  const edgeMap = new Map<string, DirectedEdge>();

  const addEdge = (fromId: string, toId: string, relationType: string) => {
    if (!itemIds.has(fromId) || !itemIds.has(toId) || fromId === toId) return;
    const key = `${fromId}->${toId}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { fromId, toId, relationType });
    }
  };

  for (const item of items) {
    if (!Array.isArray(item.relations)) continue;
    for (const rel of item.relations) {
      const targetId = rel.targetWorkItemId || rel.targetId;
      if (!targetId) continue;
      const rType = String(rel.type || '').toLowerCase();

      switch (rType) {
        case 'blocks':
        case 'finish_to_start':
        case 'starts_before':
        case 'finishes_before':
        case 'start_to_start':
        case 'finish_to_finish':
        case 'start_to_finish':
          addEdge(item.id, targetId, rType);
          break;
        case 'blocked_by':
          addEdge(targetId, item.id, 'finish_to_start');
          break;
        case 'starts_after':
          addEdge(targetId, item.id, 'starts_before');
          break;
        case 'finishes_after':
          addEdge(targetId, item.id, 'finishes_before');
          break;
        default:
          break;
      }
    }
  }

  return Array.from(edgeMap.values());
}

function detectCyclesAndBreakEdges(
  nodeIds: string[],
  edges: DirectedEdge[],
): {
  acyclicEdges: DirectedEdge[];
  hasCycle: boolean;
  cycleNodeIds: Set<string>;
} {
  const adj = new Map<string, DirectedEdge[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) adj.get(e.fromId)?.push(e);

  const color = new Map<string, 0 | 1 | 2>();
  for (const id of nodeIds) color.set(id, 0);

  const backEdgeKeys = new Set<string>();
  const cycleNodeIds = new Set<string>();
  const stack: string[] = [];

  const dfs = (u: string) => {
    color.set(u, 1);
    stack.push(u);

    const outEdges = adj.get(u) || [];
    for (const edge of outEdges) {
      const v = edge.toId;
      const vColor = color.get(v) ?? 0;
      if (vColor === 0) {
        dfs(v);
      } else if (vColor === 1) {
        backEdgeKeys.add(`${edge.fromId}->${edge.toId}`);
        cycleNodeIds.add(u);
        cycleNodeIds.add(v);
        for (let i = stack.length - 1; i >= 0; i--) {
          cycleNodeIds.add(stack[i]);
          if (stack[i] === v) break;
        }
      }
    }

    stack.pop();
    color.set(u, 2);
  };

  for (const id of nodeIds) {
    if ((color.get(id) ?? 0) === 0) {
      dfs(id);
    }
  }

  const acyclicEdges = edges.filter(
    (e) => !backEdgeKeys.has(`${e.fromId}->${e.toId}`),
  );

  return {
    acyclicEdges,
    hasCycle: backEdgeKeys.size > 0,
    cycleNodeIds,
  };
}

function kahnTopologicalSort(
  nodeIds: string[],
  edges: DirectedEdge[],
): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const e of edges) {
    adj.get(e.fromId)?.push(e.toId);
    inDegree.set(e.toId, (inDegree.get(e.toId) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    order.push(u);
    for (const v of adj.get(u) || []) {
      const nextDeg = (inDegree.get(v) ?? 1) - 1;
      inDegree.set(v, nextDeg);
      if (nextDeg === 0) queue.push(v);
    }
  }

  if (order.length < nodeIds.length) {
    const seen = new Set(order);
    for (const id of nodeIds) {
      if (!seen.has(id)) order.push(id);
    }
  }

  return order;
}

export function analyzeProjectCriticalPath(
  items: CpmInputItem[],
): CpmAnalysisResponseDto {
  const nodeIds = items.map((i) => i.id);
  const itemById = new Map(items.map((i) => [i.id, i]));

  const rawEdges = buildDependencyEdges(items);
  const { acyclicEdges, hasCycle, cycleNodeIds } = detectCyclesAndBreakEdges(
    nodeIds,
    rawEdges,
  );
  const topologicalOrder = kahnTopologicalSort(nodeIds, acyclicEdges);

  const predecessorsMap = new Map<string, DirectedEdge[]>();
  const successorsMap = new Map<string, DirectedEdge[]>();
  for (const id of nodeIds) {
    predecessorsMap.set(id, []);
    successorsMap.set(id, []);
  }
  for (const e of acyclicEdges) {
    predecessorsMap.get(e.toId)?.push(e);
    successorsMap.get(e.fromId)?.push(e);
  }

  const durationMap = new Map<string, number>();
  for (const item of items) {
    durationMap.set(item.id, computeDurationDays(item));
  }

  const esMap = new Map<string, number>();
  const efMap = new Map<string, number>();

  for (const u of topologicalOrder) {
    const dur = durationMap.get(u) ?? 1;
    const preds = predecessorsMap.get(u) || [];
    let es = 0;

    for (const edge of preds) {
      const predES = esMap.get(edge.fromId) ?? 0;
      const predEF = efMap.get(edge.fromId) ?? 1;

      switch (edge.relationType) {
        case 'start_to_start':
        case 'starts_before':
          es = Math.max(es, predES);
          break;
        case 'finish_to_finish':
        case 'finishes_before':
          es = Math.max(es, predEF - dur);
          break;
        case 'start_to_finish':
          es = Math.max(es, predES - dur);
          break;
        case 'blocks':
        case 'finish_to_start':
        default:
          es = Math.max(es, predEF);
          break;
      }
    }

    esMap.set(u, es);
    efMap.set(u, es + dur);
  }

  let projectDurationDays = 0;
  for (const ef of efMap.values()) {
    if (ef > projectDurationDays) projectDurationDays = ef;
  }

  const lsMap = new Map<string, number>();
  const lfMap = new Map<string, number>();

  for (let i = topologicalOrder.length - 1; i >= 0; i--) {
    const u = topologicalOrder[i];
    const dur = durationMap.get(u) ?? 1;
    const succs = successorsMap.get(u) || [];

    let lf = projectDurationDays;
    if (succs.length > 0) {
      for (const edge of succs) {
        const succLS = lsMap.get(edge.toId) ?? projectDurationDays;
        const succLF = lfMap.get(edge.toId) ?? projectDurationDays;

        switch (edge.relationType) {
          case 'start_to_start':
          case 'starts_before':
            lf = Math.min(lf, succLS + dur);
            break;
          case 'finish_to_finish':
          case 'finishes_before':
            lf = Math.min(lf, succLF);
            break;
          case 'start_to_finish':
            lf = Math.min(lf, succLF + dur);
            break;
          case 'blocks':
          case 'finish_to_start':
          default:
            lf = Math.min(lf, succLS);
            break;
        }
      }
    }

    lfMap.set(u, lf);
    lsMap.set(u, lf - dur);
  }

  const nodes: Record<string, CpmNodeDto> = {};
  const criticalPathItemIds = new Set<string>();
  const hasAnyEdges = acyclicEdges.length > 0;

  for (const item of items) {
    const id = item.id;
    const dur = durationMap.get(id) ?? 1;
    const es = esMap.get(id) ?? 0;
    const ef = efMap.get(id) ?? dur;
    const ls = lsMap.get(id) ?? 0;
    const lf = lfMap.get(id) ?? dur;
    const totalFloat = Math.max(0, ls - es);

    const succs = successorsMap.get(id) || [];
    let freeFloat = totalFloat;
    if (succs.length > 0) {
      let minSuccES = Infinity;
      for (const edge of succs) {
        const sES = esMap.get(edge.toId) ?? 0;
        if (sES < minSuccES) minSuccES = sES;
      }
      if (Number.isFinite(minSuccES)) {
        freeFloat = Math.max(0, minSuccES - ef);
      }
    }

    const isConnected =
      (predecessorsMap.get(id)?.length ?? 0) > 0 || succs.length > 0;
    const isCritical = hasAnyEdges && isConnected && totalFloat === 0;
    if (isCritical) {
      criticalPathItemIds.add(id);
    }

    nodes[id] = {
      id,
      title: item.title,
      durationDays: dur,
      es,
      ef,
      ls,
      lf,
      totalFloat,
      freeFloat,
      isCritical,
      predecessors: (predecessorsMap.get(id) || []).map((e) => e.fromId),
      successors: succs.map((e) => e.toId),
      hasActualDates: Boolean(item.startDate || item.dueDate),
    };
  }

  const criticalEdges = new Set<string>();
  const violatedEdges = new Set<string>();

  for (const edge of acyclicEdges) {
    const key = `${edge.fromId}->${edge.toId}`;
    const fromNode = nodes[edge.fromId];
    const toNode = nodes[edge.toId];

    if (fromNode?.isCritical && toNode?.isCritical) {
      const tight =
        edge.relationType === 'start_to_start' ||
        edge.relationType === 'starts_before'
          ? toNode.es === fromNode.es
          : edge.relationType === 'finish_to_finish' ||
              edge.relationType === 'finishes_before'
            ? toNode.ef === fromNode.ef
            : toNode.es === fromNode.ef;
      if (tight) {
        criticalEdges.add(key);
      }
    }

    const fromItem = itemById.get(edge.fromId);
    const toItem = itemById.get(edge.toId);
    if (fromItem && toItem && !fromItem.completed && !toItem.completed) {
      const fromStart = parseDate(fromItem.startDate || fromItem.dueDate);
      const fromEnd = parseDate(fromItem.dueDate || fromItem.startDate);
      const toStart = parseDate(toItem.startDate || toItem.dueDate);
      const toEnd = parseDate(toItem.dueDate || toItem.startDate);

      let violated = false;
      switch (edge.relationType) {
        case 'blocks':
        case 'finish_to_start':
          if (fromEnd && toStart && fromEnd.getTime() > toStart.getTime()) {
            violated = true;
          }
          break;
        case 'start_to_start':
        case 'starts_before':
          if (fromStart && toStart && fromStart.getTime() > toStart.getTime()) {
            violated = true;
          }
          break;
        case 'finish_to_finish':
        case 'finishes_before':
          if (fromEnd && toEnd && fromEnd.getTime() > toEnd.getTime()) {
            violated = true;
          }
          break;
        case 'start_to_finish':
          if (fromStart && toEnd && fromStart.getTime() > toEnd.getTime()) {
            violated = true;
          }
          break;
      }

      if (violated) {
        violatedEdges.add(key);
      }
    }
  }

  return {
    nodes,
    criticalPathItemIds: Array.from(criticalPathItemIds),
    criticalEdges: Array.from(criticalEdges),
    violatedEdges: Array.from(violatedEdges),
    hasCycle,
    cycleNodeIds: Array.from(cycleNodeIds),
    projectDurationDays,
    topologicalOrder,
  };
}

export type RelationConstraintEvaluator = (
  sourceStart: Date | null,
  sourceDue: Date | null,
  targetStart: Date | null,
  targetDue: Date | null,
) => { isViolated: boolean; reason: string };

const evalFinishToStart: RelationConstraintEvaluator = (
  _sourceStart,
  sourceDue,
  targetStart,
) => {
  if (
    sourceDue &&
    targetStart &&
    sourceDue.getTime() > targetStart.getTime()
  ) {
    return {
      isViolated: true,
      reason: `Due date (${sourceDue.toDateString()}) overlaps target start (${targetStart.toDateString()})`,
    };
  }
  return { isViolated: false, reason: '' };
};

export const RELATION_CONSTRAINT_STRATEGIES: Readonly<
  Record<string, RelationConstraintEvaluator>
> = {
  blocks: evalFinishToStart,
  finish_to_start: evalFinishToStart,
  blocked_by: (sourceStart, sourceDue, targetStart, targetDue) => {
    if (
      sourceStart &&
      targetDue &&
      targetDue.getTime() > sourceStart.getTime()
    ) {
      return {
        isViolated: true,
        reason: `Blocker due date (${targetDue.toDateString()}) overlaps start (${sourceStart.toDateString()})`,
      };
    }
    if (
      !sourceStart &&
      sourceDue &&
      targetStart &&
      sourceDue.getTime() > targetStart.getTime()
    ) {
      return {
        isViolated: true,
        reason: `Due date (${sourceDue.toDateString()}) overlaps target start (${targetStart.toDateString()})`,
      };
    }
    return { isViolated: false, reason: '' };
  },
  start_to_start: (sourceStart, _sourceDue, targetStart) => {
    if (
      sourceStart &&
      targetStart &&
      sourceStart.getTime() > targetStart.getTime()
    ) {
      return {
        isViolated: true,
        reason: `Predecessor start (${sourceStart.toDateString()}) exceeds successor start (${targetStart.toDateString()})`,
      };
    }
    return { isViolated: false, reason: '' };
  },
  starts_before: (sourceStart, _sourceDue, targetStart) => {
    if (
      sourceStart &&
      targetStart &&
      sourceStart.getTime() >= targetStart.getTime()
    ) {
      return {
        isViolated: true,
        reason: `Must start before target (${targetStart.toDateString()}) but starts on ${sourceStart.toDateString()}`,
      };
    }
    return { isViolated: false, reason: '' };
  },
  starts_after: (sourceStart, _sourceDue, targetStart, targetDue) => {
    if (
      sourceStart &&
      targetStart &&
      sourceStart.getTime() <= targetStart.getTime()
    ) {
      return {
        isViolated: true,
        reason: `Must start after target (${targetDue?.toDateString() || targetStart.toDateString()}) but starts on ${sourceStart.toDateString()}`,
      };
    }
    return { isViolated: false, reason: '' };
  },
  finish_to_finish: (_sourceStart, sourceDue, _targetStart, targetDue) => {
    if (
      sourceDue &&
      targetDue &&
      sourceDue.getTime() > targetDue.getTime()
    ) {
      return {
        isViolated: true,
        reason: `Predecessor due date (${sourceDue.toDateString()}) exceeds successor due date (${targetDue.toDateString()})`,
      };
    }
    return { isViolated: false, reason: '' };
  },
  finishes_before: (_sourceStart, sourceDue, _targetStart, targetDue) => {
    if (
      sourceDue &&
      targetDue &&
      sourceDue.getTime() >= targetDue.getTime()
    ) {
      return {
        isViolated: true,
        reason: `Must finish before target (${targetDue.toDateString()}) but finishes on ${sourceDue.toDateString()}`,
      };
    }
    return { isViolated: false, reason: '' };
  },
  finishes_after: (_sourceStart, sourceDue, _targetStart, targetDue) => {
    if (
      sourceDue &&
      targetDue &&
      sourceDue.getTime() <= targetDue.getTime()
    ) {
      return {
        isViolated: true,
        reason: `Must finish after target (${targetDue.toDateString()}) but finishes on ${sourceDue.toDateString()}`,
      };
    }
    return { isViolated: false, reason: '' };
  },
  start_to_finish: (sourceStart, _sourceDue, _targetStart, targetDue) => {
    if (
      sourceStart &&
      targetDue &&
      sourceStart.getTime() > targetDue.getTime()
    ) {
      return {
        isViolated: true,
        reason: `Predecessor start (${sourceStart.toDateString()}) exceeds successor due date (${targetDue.toDateString()})`,
      };
    }
    return { isViolated: false, reason: '' };
  },
};

export function evaluateRelationConstraintViolation(
  relationType: string,
  sourceStart: Date | null,
  sourceDue: Date | null,
  targetStart: Date | null,
  targetDue: Date | null,
): { isViolated: boolean; reason: string } {
  const evaluator =
    RELATION_CONSTRAINT_STRATEGIES[String(relationType).toLowerCase()];
  if (!evaluator) return { isViolated: false, reason: '' };
  return evaluator(sourceStart, sourceDue, targetStart, targetDue);
}
