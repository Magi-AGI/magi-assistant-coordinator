/** Monotonic sequence counter for snapshot ordering. */
export class SeqCounter {
  private value = 0;

  next(): number {
    return ++this.value;
  }

  current(): number {
    return this.value;
  }
}
