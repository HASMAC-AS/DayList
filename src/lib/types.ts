export type TaskType = 'daily' | 'scheduled';

export interface TaskList {
  id: string;
  name: string;
  color: string;
  createdAt: number;
  order?: number | null;
  archivedAt?: number | null;
  meta?: Record<string, any>;
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  type: TaskType;
  createdAt: number;
  order?: number | null;
  dueAt: number | null;
  active: boolean;
  archivedAt: number | null;
  doneAt: number | null;
  templateKey: string | null;
  completions: Record<string, boolean>;
}

export interface TemplateStat {
  key: string;
  listId: string;
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
    order?: number | null;
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

export interface SnapshotKeys {
  room: string;
  enc: string;
  sig: string;
  turnKey: string;
  turnEnabled?: boolean;
}

export interface SnapshotV2 extends SnapshotV1 {
  v: 2;
  keys?: SnapshotKeys;
}

export interface SnapshotV3 {
  v: 3;
  exportedAt: number;
  keys?: SnapshotKeys;
  lists: Record<
    string,
    {
      name: string;
      color: string;
      createdAt: number;
      order?: number | null;
      archivedAt?: number | null;
      meta?: Record<string, any>;
    }
  >;
  tasks: Array<{
    id: string;
    listId: string;
    title: string;
    type: TaskType;
    createdAt: number;
    order?: number | null;
    dueAt: number | null;
    active: boolean;
    archivedAt: number | null;
    doneAt: number | null;
    templateKey: string | null;
    completions: Record<string, boolean>;
  }>;
  templates: Record<
    string,
    Record<
      string,
      {
        title: string;
        usageCount: number;
        firstUsedAt: number;
        lastUsedAt: number;
        meanMinutes: number;
        lastType: TaskType;
      }
    >
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
