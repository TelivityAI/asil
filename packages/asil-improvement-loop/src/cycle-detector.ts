export interface CycleEvent {
  taskId: string;
  category: string;
  filePath: string;
  timestamp: Date;
}

export interface CycleCheck {
  isCycle: boolean;
  reason?: string;
  affectedFiles?: string[];
}

export class CycleDetector {
  private history: CycleEvent[] = [];
  private readonly windowMs: number;
  private readonly maxOccurrences: number;

  constructor(windowMs = 3_600_000, maxOccurrences = 3) {
    this.windowMs = windowMs;
    this.maxOccurrences = maxOccurrences;
  }

  record(taskId: string, category: string, filePaths: string[]): void {
    const now = new Date();
    for (const filePath of filePaths) {
      this.history.push({ taskId, category, filePath, timestamp: now });
    }
    this.pruneOld();
  }

  wouldCycle(category: string, filePaths: string[]): CycleCheck {
    this.pruneOld();
    const now = Date.now();
    const cycleFiles: string[] = [];

    for (const filePath of filePaths) {
      const recent = this.history.filter(
        (e) =>
          e.filePath === filePath &&
          e.category === category &&
          now - e.timestamp.getTime() < this.windowMs,
      );
      if (recent.length >= this.maxOccurrences) cycleFiles.push(filePath);
    }

    if (cycleFiles.length > 0) {
      return {
        isCycle: true,
        reason: `${category} has been applied to ${cycleFiles.join(', ')} ${this.maxOccurrences}+ times in the last ${Math.round(
          this.windowMs / 60_000,
        )} minutes`,
        affectedFiles: cycleFiles,
      };
    }
    return { isCycle: false };
  }

  private pruneOld(): void {
    const cutoff = Date.now() - this.windowMs;
    this.history = this.history.filter((e) => e.timestamp.getTime() > cutoff);
  }
}
