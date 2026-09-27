import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ResourceRequirement } from "./actionContracts.js";

type ActiveResource = {
  readers: Set<string>;
  writer?: string;
};

type PendingRequest = {
  ticket: string;
  action: string;
  resources: ResourceRequirement[];
  enqueuedAt: number;
  resolve: (lease: ResourceLease) => void;
};

export type ResourceLease = {
  ticket: string;
  action: string;
  resources: ResourceRequirement[];
  waitMs: number;
  release: () => void;
};

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resourceKeysConflict(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.startsWith("workspace:") && right.startsWith("workspace:")) {
    const leftPath = left.slice("workspace:".length);
    const rightPath = right.slice("workspace:".length);
    return pathContains(leftPath, rightPath) || pathContains(rightPath, leftPath);
  }
  return false;
}

function normalizeResources(resources: ResourceRequirement[]): ResourceRequirement[] {
  const byKey = new Map<string, ResourceRequirement>();
  for (const item of resources) {
    const key = item.key.trim();
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || item.mode === "exclusive") {
      byKey.set(key, { key, mode: item.mode });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

class ResourceArbiter {
  private readonly active = new Map<string, ActiveResource>();
  private readonly pending: PendingRequest[] = [];
  private readonly heldByTicket = new Map<string, ResourceRequirement[]>();

  private canGrant(resources: ResourceRequirement[]): boolean {
    for (const requirement of resources) {
      for (const [activeKey, state] of this.active.entries()) {
        if (!resourceKeysConflict(requirement.key, activeKey)) continue;

        if (requirement.mode === "shared") {
          if (state.writer) return false;
        } else if (state.writer || state.readers.size > 0) {
          return false;
        }
      }
    }
    return true;
  }

  private markGranted(ticket: string, resources: ResourceRequirement[]): void {
    for (const requirement of resources) {
      const state = this.active.get(requirement.key) ?? {
        readers: new Set<string>(),
      };

      if (requirement.mode === "shared") {
        state.readers.add(ticket);
      } else {
        state.writer = ticket;
      }

      this.active.set(requirement.key, state);
    }
    this.heldByTicket.set(ticket, resources);
  }

  private releaseTicket(ticket: string): void {
    const resources = this.heldByTicket.get(ticket);
    if (!resources) return;

    for (const requirement of resources) {
      const state = this.active.get(requirement.key);
      if (!state) continue;

      state.readers.delete(ticket);
      if (state.writer === ticket) state.writer = undefined;

      if (state.readers.size === 0 && !state.writer) {
        this.active.delete(requirement.key);
      }
    }

    this.heldByTicket.delete(ticket);
    this.drain();
  }

  private drain(): void {
    let index = 0;
    while (index < this.pending.length) {
      const request = this.pending[index]!;
      if (!this.canGrant(request.resources)) {
        index += 1;
        continue;
      }

      this.pending.splice(index, 1);
      this.markGranted(request.ticket, request.resources);
      let released = false;
      request.resolve({
        ticket: request.ticket,
        action: request.action,
        resources: request.resources,
        waitMs: Date.now() - request.enqueuedAt,
        release: () => {
          if (released) return;
          released = true;
          this.releaseTicket(request.ticket);
        },
      });
    }
  }

  async acquire(action: string, resources: ResourceRequirement[]): Promise<ResourceLease> {
    const normalized = normalizeResources(resources);
    const ticket = randomUUID();

    if (normalized.length === 0) {
      return {
        ticket,
        action,
        resources: [],
        waitMs: 0,
        release: () => undefined,
      };
    }

    return await new Promise<ResourceLease>((resolve) => {
      this.pending.push({
        ticket,
        action,
        resources: normalized,
        enqueuedAt: Date.now(),
        resolve,
      });
      this.drain();
    });
  }

  async withResources<T>(
    action: string,
    resources: ResourceRequirement[],
    operation: () => Promise<T>,
  ): Promise<{ result: T; lease: Omit<ResourceLease, "release"> }> {
    const lease = await this.acquire(action, resources);
    try {
      const result = await operation();
      return {
        result,
        lease: {
          ticket: lease.ticket,
          action: lease.action,
          resources: lease.resources,
          waitMs: lease.waitMs,
        },
      };
    } finally {
      lease.release();
    }
  }

  status() {
    return {
      active: [...this.active.entries()].map(([key, state]) => ({
        key,
        readers: state.readers.size,
        writer: state.writer ?? null,
      })),
      pending: this.pending.map((request) => ({
        ticket: request.ticket,
        action: request.action,
        resources: request.resources,
        waitingMs: Date.now() - request.enqueuedAt,
      })),
      heldTickets: this.heldByTicket.size,
    };
  }
}

export const resourceArbiter = new ResourceArbiter();
