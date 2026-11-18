import type { Change, Command, CommandContext } from './command';

/**
 * Linear undo/redo history.
 *
 * Memory is bounded by a byte budget measured from outside (`measureBytes`):
 * after each new step, the oldest steps are dropped until the history fits.
 */
export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  constructor(
    private readonly ctx: CommandContext,
    public budgetBytes: number,
    private readonly measureBytes: () => number,
  ) {}

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Label of the step that undo would revert. */
  get nextUndoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  /** Apply a new command and record it. Clears the redo stack. */
  execute(command: Command): Change {
    const change = command.apply(this.ctx);
    for (const c of this.redoStack) c.dispose(this.ctx, false);
    this.redoStack = [];

    const top = this.undoStack[this.undoStack.length - 1];
    if (top?.mergeWith?.(command)) {
      command.dispose(this.ctx, true);
    } else {
      this.undoStack.push(command);
    }
    this.trimToBudget();
    return change;
  }

  undo(): Change | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    this.redoStack.push(command);
    return command.revert(this.ctx);
  }

  redo(): Change | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    this.undoStack.push(command);
    return command.apply(this.ctx);
  }

  /** Drop the oldest undo step. Returns false if there was none. */
  dropOldest(): boolean {
    const oldest = this.undoStack.shift();
    if (!oldest) return false;
    oldest.dispose(this.ctx, true);
    return true;
  }

  trimToBudget(): void {
    while (this.measureBytes() > this.budgetBytes && this.dropOldest()) {
      // keep dropping
    }
  }

  forEachCommand(fn: (command: Command) => void): void {
    this.undoStack.forEach(fn);
    this.redoStack.forEach(fn);
  }

  clear(): void {
    for (const c of this.undoStack) c.dispose(this.ctx, true);
    for (const c of this.redoStack) c.dispose(this.ctx, false);
    this.undoStack = [];
    this.redoStack = [];
  }
}
