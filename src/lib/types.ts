export type TaskType = 'daily' | 'scheduled';

export interface Task {
  id: string;
  title: string;
  type: TaskType;
  createdAt: number;
  dueAt: number | null;
  active: boolean;
  archivedAt: number | null;
  doneAt: number | null;
  templateKey: string | null;
  completions: Record<string, boolean>;
}

export interface TemplateStat {
  key: string;
  title: string;
  usageCount: number;
  firstUsedAt: number;
  lastUsedAt: number;
  meanMinutes: number;
  lastType: TaskType;
}

export interface SnapshotV1 {
  v: 1;
  exportedAt: number;
  tasks: Array<{
    id: string;
    title: string;
    type: TaskType;
    createdAt: number;
    dueAt: number | null;
    active: boolean;
    archivedAt: number | null;
    doneAt: number | null;
    templateKey: string | null;
    completions: Record<string, boolean>;
  }>;
  templates: Record<
    string,
    {
      title: string;
      usageCount: number;
      firstUsedAt: number;
      lastUsedAt: number;
      meanMinutes: number;
      lastType: TaskType;
    }
  >;
  history: Record<string, Record<string, number>>;
}

export interface HistoryDayEntry {
  taskId: string;
  completedAt: number;
  title: string;
}

export interface HistoryDay {
  dayKey: string;
  entries: HistoryDayEntry[];
}
