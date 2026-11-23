/** 应用级状态：当前书册档案与逐叶记录。 */
import type { AnalysisConfig, BookArchive, LeafRecord } from '../core/types';
import { buildArchive } from '../core/archive';

const STORAGE_KEY = 'paperline-archive-v1';

export class AppStore {
  bookId = '未命名书册';
  config: AnalysisConfig;
  leaves: LeafRecord[] = [];
  private listeners = new Set<() => void>();

  constructor(config: AnalysisConfig) {
    this.config = config;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  addLeaf(record: LeafRecord): void {
    // 同 ID 覆盖（重算）
    const idx = this.leaves.findIndex((l) => l.leafId === record.leafId);
    if (idx >= 0) this.leaves[idx] = record;
    else this.leaves.push(record);
    this.emit();
  }

  removeLeaf(id: string): void {
    this.leaves = this.leaves.filter((l) => l.leafId !== id);
    this.emit();
  }

  clear(): void {
    this.leaves = [];
    this.emit();
  }

  buildArchive(): BookArchive {
    return buildArchive(this.bookId, this.leaves, this.config);
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.buildArchive()));
    } catch (e) {
      console.warn('档案保存失败', e);
    }
  }

  load(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const obj = JSON.parse(raw) as BookArchive;
      this.bookId = obj.bookId;
      this.leaves = obj.leaves;
      this.config = obj.config;
      this.emit();
      return true;
    } catch (e) {
      console.warn('档案读取失败', e);
      return false;
    }
  }
}
