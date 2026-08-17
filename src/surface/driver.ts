/** The surface interface every layer above depends on (never a raw Playwright Page). */
import type {
  ActionRequest,
  ActionResult,
  ActionType,
  Observation,
  Resolution,
  TargetDescriptor,
} from './types.js';

export interface SurfaceDriver {
  start(): Promise<void>;
  stop(): Promise<void>;
  currentUrl(): string;

  navigate(url: string): Promise<ActionResult>;

  /** Discovery: perceive the surface. */
  observe(): Promise<Observation>;
  /** Discovery: act on an ephemeral observation ref. */
  act(req: ActionRequest): Promise<ActionResult>;

  /** Replay: resolve a durable descriptor and act on it (no LLM). */
  resolveAndAct(
    descriptor: TargetDescriptor,
    action: ActionType,
    value?: string
  ): Promise<{ result: ActionResult; resolution: Resolution }>;
  /** Replay/predicates: resolve without acting. */
  resolveOnly(descriptor: TargetDescriptor): Promise<Resolution>;

  /** Predicate primitive: is `text` present anywhere across frames? */
  textPresent(text: string): Promise<boolean>;

  screenshot(path: string): Promise<void>;
}
