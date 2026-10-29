/** Variable-height rows, with O(log n) updates and viewport lookups. */
export class RowLayout {
  private readonly heights: Float64Array;
  private readonly tree: Float64Array;
  readonly length: number;

  constructor(heights: number[]) {
    this.length = heights.length;
    this.heights = Float64Array.from(heights);
    this.tree = new Float64Array(this.length + 1);
    for (let i = 1; i <= this.length; i++) {
      this.tree[i] += heights[i - 1];
      const parent = i + (i & -i);
      if (parent <= this.length) this.tree[parent] += this.tree[i];
    }
  }

  height(i: number): number { return this.heights[i]; }

  /** Position before row i; offset(length) is the total height. */
  offset(i: number): number {
    let sum = 0;
    for (; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  setHeight(i: number, height: number): boolean {
    if (i < 0 || i >= this.length || this.heights[i] === height) return false;
    const delta = height - this.heights[i];
    this.heights[i] = height;
    for (let j = i + 1; j <= this.length; j += j & -j) this.tree[j] += delta;
    return true;
  }

  /** Row containing y, clamped to the available rows. */
  at(y: number): number {
    let index = 0;
    let sum = 0;
    for (let step = 2 ** Math.floor(Math.log2(this.length || 1)); step > 0; step = Math.floor(step / 2)) {
      const next = index + step;
      if (next <= this.length && sum + this.tree[next] <= y) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.max(0, Math.min(index, this.length - 1));
  }
}
