/**
 * WebSurfaceDriver — Playwright implementation of SurfaceDriver.
 *
 * Perception: injects a walker into every frame that tags interactive/text elements with an
 * ephemeral, generation-scoped `data-cua-ref`, and returns role/name/anchor/frame metadata.
 * Action (discovery): looks the element up by that ref (rejecting stale generations).
 * Action (replay): resolves a durable TargetDescriptor via an ordered candidate cascade with an
 * `exactlyOne` cardinality invariant, using Playwright's built-in role/label/text engines plus
 * xpath for the legacy label-less / table-cell cases.
 */
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from 'playwright';
import type { SurfaceDriver } from './driver.js';
import type {
  ActionRequest,
  ActionResult,
  ActionType,
  LocatorCandidate,
  Observation,
  Resolution,
  Role,
  SurfaceNode,
  TargetDescriptor,
} from './types.js';

type RawNode = Omit<SurfaceNode, 'framePath'> & { framePath?: string[] };

/*
 * Runs in the page. Tags elements and returns their metadata. Kept dependency-free AND free of
 * nested named functions/arrows: tsx/esbuild `keepNames` otherwise injects a module-scope `__name()`
 * wrapper that does not exist in the browser context, which would make frame.evaluate throw.
 */
function walker(arg: { generation: number; start: number }): RawNode[] {
  const { generation, start } = arg;
  const out: RawNode[] = [];
  let i = start;
  const sel = 'a,button,input,select,textarea,td,th,h1,h2,h3';
  const els = document.querySelectorAll(sel);
  for (let k = 0; k < els.length; k++) {
    const el = els[k] as HTMLInputElement;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const tag = el.tagName.toLowerCase();
    const typeAttr = (el.getAttribute('type') || '').toLowerCase();
    let role: Role = 'other';
    if (tag === 'a') role = 'link';
    else if (tag === 'button') role = 'button';
    else if (tag === 'select') role = 'combobox';
    else if (tag === 'textarea') role = 'textbox';
    else if (tag === 'input') role = typeAttr === 'submit' || typeAttr === 'button' ? 'button' : 'textbox';
    else if (tag === 'h1' || tag === 'h2' || tag === 'h3') role = 'heading';
    else if (tag === 'td' || tag === 'th') role = 'cell';
    const interactive = tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea';
    const aria = el.getAttribute('aria-label');
    let name = '';
    if (aria) name = aria.trim();
    else if (role === 'button') name = (tag === 'input' ? el.value || '' : el.textContent || '').trim();
    else if (role === 'link' || role === 'heading' || role === 'cell') name = (el.textContent || '').trim();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!interactive && !text) continue;
    const ref = `obs_${generation}:e${i++}`;
    el.setAttribute('data-cua-ref', ref);
    let anchorText: string | undefined;
    if (interactive) {
      const cell = el.closest('td');
      const prev = cell && cell.previousElementSibling;
      if (prev) anchorText = (prev.textContent || '').replace(/\s+/g, ' ').trim() || undefined;
    } else if (tag === 'td' || tag === 'th') {
      // For a value cell, the stable anchor is its label (the preceding cell in the row).
      const prev = el.previousElementSibling;
      if (prev) anchorText = (prev.textContent || '').replace(/\s+/g, ' ').trim() || undefined;
    }
    let rowText: string | undefined;
    const tr = el.closest('tr');
    if (tr) rowText = (tr.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined;
    const form = el.form;
    out.push({
      ref: ref as SurfaceNode['ref'],
      role,
      name: name || (interactive ? '' : text),
      value: el.value || undefined,
      tag,
      attrs: {
        name: el.getAttribute('name') || undefined,
        type: el.getAttribute('type') || undefined,
        href: el.getAttribute('href') || undefined,
        // Effective submission target (respects a button's formaction override and a missing action).
        formAction: role === 'button' && form ? el.formAction || undefined : undefined,
        formMethod: role === 'button' && form ? (el.formMethod || 'get').toUpperCase() : undefined,
      },
      anchorText,
      rowText,
    });
  }
  return out;
}

export class WebSurfaceDriver implements SurfaceDriver {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private generation = 0;
  private lastNodes = new Map<string, SurfaceNode>();

  constructor(private readonly opts: { headless?: boolean } = {}) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.opts.headless ?? true });
    // A persistent single context/page shared across the run (and, later, with a human).
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
  }

  async stop(): Promise<void> {
    await this.browser?.close();
  }

  /** Exposed for the escalation manager (raw driver only). */
  getContext(): BrowserContext {
    if (!this.context) throw new Error('driver not started');
    return this.context;
  }
  getPage(): Page {
    if (!this.page) throw new Error('driver not started');
    return this.page;
  }

  currentUrl(): string {
    return this.page?.url() ?? 'about:blank';
  }

  /** Wait for the page and its frames to settle (framesets load child frames asynchronously). */
  private async settle(): Promise<void> {
    await this.getPage()
      .waitForLoadState('networkidle', { timeout: 5000 })
      .catch(() => {});
    await Promise.all(
      this.getPage()
        .frames()
        .map((f) => f.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}))
    );
  }

  private frameUrl(framePath: string[]): string {
    const f = this.frameFor(framePath);
    return f && 'url' in f ? f.url() : this.getPage().url();
  }

  /** Click, then wait for the acted frame to navigate (form submits target a subframe). */
  private async clickAndSettle(loc: Locator, framePath: string[]): Promise<void> {
    const before = this.frameUrl(framePath);
    await loc.click();
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (this.frameUrl(framePath) !== before) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await this.settle();
  }

  async navigate(url: string): Promise<ActionResult> {
    try {
      await this.getPage().goto(url, { waitUntil: 'load' });
      await this.settle();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `navigation failed/blocked: ${(e as Error).message}` };
    }
  }

  private framePathOf(frame: Frame): string[] {
    const names: string[] = [];
    let f: Frame | null = frame;
    while (f && f.parentFrame()) {
      names.unshift(f.name());
      f = f.parentFrame();
    }
    return names;
  }

  async observe(): Promise<Observation> {
    const page = this.getPage();
    await this.settle();
    this.generation += 1;
    const nodes: SurfaceNode[] = [];
    let idx = 0;
    for (const frame of page.frames()) {
      let raw: RawNode[] = [];
      try {
        raw = (await frame.evaluate(walker, { generation: this.generation, start: idx })) as RawNode[];
      } catch {
        continue; // detached/cross-origin frame — skip
      }
      const framePath = this.framePathOf(frame);
      for (const n of raw) nodes.push({ ...n, framePath } as SurfaceNode);
      idx += raw.length;
    }
    this.lastNodes = new Map(nodes.map((n) => [n.ref, n]));
    const outline = nodes
      .map((n) => {
        const loc = n.framePath.length ? ` frame=${n.framePath.join('/')}` : '';
        const anchor = n.anchorText ? ` anchor="${n.anchorText}"` : '';
        const nm = n.name ? ` name="${n.name}"` : '';
        return `[${n.ref}] ${n.role}${nm}${loc}${anchor}`;
      })
      .join('\n');
    return { generation: this.generation, url: page.url(), nodes, outline };
  }

  private async findByRef(ref: string): Promise<Locator | null> {
    for (const frame of this.getPage().frames()) {
      const loc = frame.locator(`[data-cua-ref="${ref}"]`);
      if (await loc.count()) return loc.first();
    }
    return null;
  }

  /** Derive durable locator candidates for a node acted on during discovery. */
  static deriveCandidates(node: SurfaceNode, action: ActionType): LocatorCandidate[] {
    const c: LocatorCandidate[] = [];
    if (node.name && (node.role === 'button' || node.role === 'link' || node.role === 'heading')) {
      c.push({ strategy: 'roleName', role: node.role, name: node.name });
      c.push({ strategy: 'text', text: node.name });
    }
    if ((node.role === 'textbox' || node.role === 'combobox') && node.anchorText) {
      const control = node.role === 'combobox' ? 'select' : node.tag === 'textarea' ? 'textarea' : 'input';
      c.push({ strategy: 'anchorCell', anchorText: node.anchorText, control });
    }
    if (node.name && (node.role === 'textbox' || node.role === 'combobox')) {
      c.push({ strategy: 'labelledField', label: node.name });
    }
    if (action === 'read' && (node.anchorText || node.rowText)) {
      // Anchor on the stable LABEL (preceding cell), never the member-specific value/row text.
      const label = node.anchorText ?? node.rowText!.split(' ')[0]!;
      c.push({ strategy: 'tableCell', rowContainsText: label, column: 2 });
    }
    if (node.name && c.length === 0) c.push({ strategy: 'text', text: node.name });
    return c;
  }

  async act(req: ActionRequest): Promise<ActionResult> {
    if (req.type === 'navigate') return this.navigate(req.url!);
    const ref = req.ref!;
    const gen = Number(ref.split(':')[0]?.replace('obs_', ''));
    if (gen !== this.generation) return { ok: false, error: `stale ref (gen ${gen} != ${this.generation})` };
    const node = this.lastNodes.get(ref);
    const loc = await this.findByRef(ref);
    if (!loc || !node) return { ok: false, error: `ref not found: ${ref}` };
    const resolved = {
      role: node.role,
      name: node.name,
      framePath: node.framePath,
      anchorText: node.anchorText,
      rowText: node.rowText,
      candidates: WebSurfaceDriver.deriveCandidates(node, req.type),
    };
    try {
      if (req.type === 'click') await this.clickAndSettle(loc, node.framePath);
      else if (req.type === 'type') await loc.fill(req.value ?? '');
      else if (req.type === 'select') {
        await this.selectInto(loc, req.value ?? '');
        // Record the option's canonical value (not the label), so parameterization matches inputs.
        const canonicalValue = await loc.inputValue().catch(() => undefined);
        return { ok: true, resolved, canonicalValue };
      } else if (req.type === 'read') return { ok: true, readValue: await this.readFrom(loc, node.role), resolved };
      return { ok: true, resolved };
    } catch (e) {
      return { ok: false, error: (e as Error).message, resolved };
    }
  }

  private async selectInto(loc: Locator, value: string): Promise<void> {
    try {
      await loc.selectOption({ value });
    } catch {
      await loc.selectOption({ label: value });
    }
  }

  private async readFrom(loc: Locator, role: Role): Promise<string> {
    if (role === 'textbox' || role === 'combobox') return (await loc.inputValue()).trim();
    return (await loc.innerText()).trim();
  }

  // ---- Replay-side resolution ---------------------------------------------------------------

  private frameFor(path: string[]): Frame | Page | null {
    const page = this.getPage();
    if (path.length === 0) return page;
    for (const frame of page.frames()) {
      if (this.framePathOf(frame).join('/') === path.join('/')) return frame;
    }
    // Exact recorded frame context missing → fail closed (never guess a different frame or the top
    // page). The caller reports context_missing → TARGET_CONTEXT_NOT_FOUND.
    return null;
  }

  private buildLocator(scope: Frame | Page, cand: LocatorCandidate): Locator {
    switch (cand.strategy) {
      case 'roleName':
        return scope.getByRole(cand.role as never, { name: cand.name });
      case 'labelledField':
        return scope.getByLabel(cand.label);
      case 'text':
        return scope.getByText(cand.text, { exact: false });
      case 'anchorCell':
        return scope.locator(
          `xpath=//td[normalize-space(.)=${xpathLit(cand.anchorText)}]/following-sibling::td[1]//${cand.control}`
        );
      case 'tableCell':
        return scope.locator(
          `xpath=//tr[contains(normalize-space(.), ${xpathLit(cand.rowContainsText)})]/td[${cand.column}]`
        );
    }
  }

  private async resolveLocator(
    descriptor: TargetDescriptor
  ): Promise<{ resolution: Resolution; locator?: Locator }> {
    await this.settle();
    const scope = this.frameFor(descriptor.context.frames.map((f) => f.name));
    if (!scope) return { resolution: { status: 'context_missing', matchCount: 0, fallbackUsed: false } };
    for (let idx = 0; idx < descriptor.candidates.length; idx++) {
      const loc = this.buildLocator(scope, descriptor.candidates[idx]!);
      let count = 0;
      try {
        count = await loc.count();
      } catch {
        continue;
      }
      if (count === 0) continue;
      // Enforce visible/enabled, then the exactlyOne cardinality invariant.
      const usable: Locator[] = [];
      for (let k = 0; k < count; k++) {
        const nth = loc.nth(k);
        const vis = descriptor.invariants.mustBeVisible ? await nth.isVisible().catch(() => false) : true;
        const en = descriptor.invariants.mustBeEnabled ? await nth.isEnabled().catch(() => false) : true;
        if (vis && en) usable.push(nth);
      }
      if (usable.length === 0) continue;
      if (usable.length > 1) {
        return { resolution: { status: 'ambiguous', matchCount: usable.length, candidateIndex: idx, fallbackUsed: idx > 0 } };
      }
      return {
        resolution: { status: 'resolved', matchCount: 1, candidateIndex: idx, fallbackUsed: idx > 0 },
        locator: usable[0],
      };
    }
    return { resolution: { status: 'not_found', matchCount: 0, fallbackUsed: false } };
  }

  async resolveOnly(descriptor: TargetDescriptor): Promise<Resolution> {
    return (await this.resolveLocator(descriptor)).resolution;
  }

  async resolveInfo(descriptor: TargetDescriptor): Promise<import('./types.js').TargetInfo> {
    const { resolution, locator } = await this.resolveLocator(descriptor);
    if (resolution.status !== 'resolved' || !locator) return { resolution };
    try {
      const meta = (await locator.evaluate((el: Element) => {
        const c = el as HTMLButtonElement & HTMLInputElement;
        const isFormControl = (el.tagName === 'BUTTON' || el.tagName === 'INPUT') && !!c.form;
        return {
          // Effective submission target the browser would actually dispatch to.
          formAction: isFormControl ? c.formAction || undefined : undefined,
          formMethod: isFormControl ? (c.formMethod || 'get').toUpperCase() : undefined,
          href: el.getAttribute('href') || undefined,
        };
      })) as { formAction?: string; formMethod?: string; href?: string };
      return { resolution, ...meta };
    } catch {
      return { resolution };
    }
  }

  async resolveAndAct(
    descriptor: TargetDescriptor,
    action: ActionType,
    value?: string
  ): Promise<{ result: ActionResult; resolution: Resolution }> {
    const { resolution, locator } = await this.resolveLocator(descriptor);
    if (resolution.status !== 'resolved' || !locator) {
      return { result: { ok: false, error: `target ${resolution.status}` }, resolution };
    }
    const role = descriptor.invariants.expectedRole ?? 'other';
    try {
      if (action === 'click') await this.clickAndSettle(locator, descriptor.context.frames.map((f) => f.name));
      else if (action === 'type') await locator.fill(value ?? '');
      else if (action === 'select') await this.selectInto(locator, value ?? '');
      else if (action === 'read') return { result: { ok: true, readValue: await this.readFrom(locator, role) }, resolution };
      return { result: { ok: true }, resolution };
    } catch (e) {
      return { result: { ok: false, error: (e as Error).message }, resolution };
    }
  }

  async textPresent(text: string): Promise<boolean> {
    for (const frame of this.getPage().frames()) {
      try {
        const body = await frame.locator('body').innerText({ timeout: 500 });
        if (body.includes(text)) return true;
      } catch {
        /* skip */
      }
    }
    return false;
  }

  async screenshot(path: string): Promise<void> {
    await this.getPage().screenshot({ path });
  }
}

function xpathLit(s: string): string {
  // Safely quote a string for XPath (handles embedded quotes).
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.replace(/'/g, "',\"'\",'")}')`;
}
