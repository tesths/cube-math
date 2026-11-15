/**
 * 三视图的画法。学生端右侧面板与教师端"放大演示"共用同一套代码，
 * 保证两边看到的方格图完全一致。
 *
 * 三个视图刻意共用同一个格子尺寸 —— 这样"从正面看"和"从上面看"的宽度是对齐的，
 * 学生能直接把两张图对着比，而不是各自缩放到自己的框里。
 */
import { computeViews } from '../shared/model.js';

export const VIEW_DEFS = [
  { id: 'front', title: '从前面看' },
  { id: 'right', title: '从右面看' },
  { id: 'top', title: '从上面看' },
];

const COLOR = {
  filled: '#f7efac',        // 和木块同款浅黄
  filledLine: '#1f1f1f',    // 细黑边
  empty: '#fffdf7',
  emptyLine: '#dccba8',
  dim: '#7d664e',
  text: '#3a2c1e',
};

const PAD = { left: 30, right: 14, top: 12, bottom: 34 };
const GAP = 10;

/** 一组视图卡片：负责建 DOM、排版、绘制。不关心"显示/隐藏"由谁控制。 */
export class ViewCards {
  constructor(container, { maxCell = 44, minCell = 12, showSize = true } = {}) {
    this.container = container;
    this.maxCell = maxCell;
    this.minCell = minCell;
    this.showSize = showSize;
    this.cubes = [];
    this.items = new Map();
    this._build();

    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(this.container);
  }

  _build() {
    this.container.replaceChildren();
    for (const def of VIEW_DEFS) {
      const item = document.createElement('article');
      item.className = 'view-item';
      item.dataset.view = def.id;

      const head = document.createElement('h3');
      head.className = 'view-item-title';
      head.textContent = def.title;

      const wrap = document.createElement('div');
      wrap.className = 'view-item-canvas';
      const canvas = document.createElement('canvas');
      const empty = document.createElement('span');
      empty.className = 'view-item-empty';
      empty.textContent = '还没有方块';
      wrap.append(canvas, empty);

      const size = document.createElement('p');
      size.className = 'view-item-size';
      size.hidden = !this.showSize;

      item.append(head, wrap, size);
      this.container.append(item);
      this.items.set(def.id, { item, wrap, canvas, empty, size, def });
    }
  }

  setCubes(cubes) {
    this.cubes = cubes;
    this.render();
  }

  render() {
    const views = computeViews(this.cubes);
    const entries = VIEW_DEFS.map((def) => this.items.get(def.id));
    const gridHeight = this.container.clientHeight || 0;
    const perItem = (gridHeight - VIEW_DEFS.length * GAP) / VIEW_DEFS.length;

    // 每个视图能用的高度：减去标题 / 尺寸行 / 内边距这些不是画布的部分
    // 下限 104：5 行时格子 clamp 到 12px 也还画得下；再大会让 720p/768 高度的屏把第三张裁掉
    const wrapHeight = Math.max(86, Math.min(300, perItem - (this.showSize ? 66 : 46)));
    for (const entry of entries) entry.wrap.style.height = `${wrapHeight}px`;

    // 三个视图共用同一个格子尺寸：取最紧的那个约束
    let cell = this.maxCell;
    for (const def of VIEW_DEFS) {
      const view = views[def.id];
      if (!view) continue;
      const width = entries[0].wrap.clientWidth || 0;
      cell = Math.min(
        cell,
        (width - PAD.left - PAD.right) / view.cols,
        (wrapHeight - PAD.top - PAD.bottom) / view.rows,
      );
    }
    cell = Math.max(this.minCell, cell);

    for (const entry of entries) {
      const view = views[entry.def.id];
      const blank = !view;

      entry.canvas.hidden = blank;
      entry.empty.hidden = !blank;
      if (blank) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
        entry.size.textContent = '—';
        continue;
      }

      drawView(entry.canvas, view, entry.def, cell);
      entry.size.textContent = `${view.cols} 格宽 × ${view.rows} 格高`;
    }
  }

  dispose() {
    this._ro?.disconnect();
  }
}

/** 学生端右侧：「看三视图」按钮 + 折叠占位。 */
export class ViewPanel {
  constructor({ btn, gridEl, placeholderEl, footEl }) {
    this.btn = btn;
    this.placeholderEl = placeholderEl;
    this.footEl = footEl;
    this.visible = false;
    this.cards = new ViewCards(gridEl, { maxCell: 44, minCell: 12 });

    this.btn.addEventListener('click', () => this.toggle());
  }

  toggle(force) {
    this.visible = force ?? !this.visible;
    this.btn.setAttribute('aria-pressed', String(this.visible));
    this.btn.textContent = this.visible ? '收起三视图' : '看三视图';
    this.placeholderEl.hidden = this.visible;
    this.cards.container.hidden = !this.visible;
    if (this.footEl) this.footEl.hidden = !this.visible;
    if (this.visible) {
      this.cards.render();
      this._reveal();
    }
  }

  /** 展开后如果图形不在视野里（平板竖屏常见），把它带进来 */
  _reveal() {
    const box = this.cards.container.getBoundingClientRect();
    if (box.top >= 0 && box.top < window.innerHeight - 40) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.cards.container.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }

  setCubes(cubes) {
    this.cards.setCubes(cubes);
  }

  dispose() {
    this.cards.dispose();
  }
}

/** 把一个视图画到 canvas 上（方格 = 一个小正方体，空位也描出格子，方便看出"洞"） */
export function drawView(canvas, view, def, cell) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.round(PAD.left + view.cols * cell + PAD.right);
  const cssH = Math.round(PAD.top + view.rows * cell + PAD.bottom);

  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute(
    'aria-label',
    `${def.title}的方格图：${view.rows} 行 ${view.cols} 列，其中 ${view.filled} 格有方块`,
  );

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  for (let row = 0; row < view.rows; row++) {
    for (let col = 0; col < view.cols; col++) {
      const x = PAD.left + col * cell;
      const y = PAD.top + row * cell;
      const on = view.cells[row][col];

      ctx.beginPath();
      ctx.rect(x + 0.5, y + 0.5, cell - 1, cell - 1);
      ctx.fillStyle = on ? COLOR.filled : COLOR.empty;
      ctx.fill();
      ctx.lineWidth = on ? 1.4 : 1;
      ctx.strokeStyle = on ? COLOR.filledLine : COLOR.emptyLine;
      ctx.stroke();
    }
  }

  // 尺寸线：宽 N 格（真数据，不是装饰）
  const dimY = PAD.top + view.rows * cell + 16;
  const x0 = PAD.left;
  const x1 = PAD.left + view.cols * cell;
  ctx.strokeStyle = COLOR.dim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, dimY);
  ctx.lineTo(x1, dimY);
  ctx.moveTo(x0, dimY - 4);
  ctx.lineTo(x0, dimY + 4);
  ctx.moveTo(x1, dimY - 4);
  ctx.lineTo(x1, dimY + 4);
  ctx.stroke();

  const label = `宽 ${view.cols} 格`;
  ctx.font = '600 14px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const cx = (x0 + x1) / 2;
  const textW = ctx.measureText(label).width;
  ctx.fillStyle = COLOR.empty;
  ctx.fillRect(cx - textW / 2 - 4, dimY + 2, textW + 8, 14);
  ctx.fillStyle = COLOR.text;
  ctx.fillText(label, cx, dimY + 2);

  return { cssW, cssH };
}
