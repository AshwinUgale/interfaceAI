/**
 * LlmBrain — the genuine discovery path. A structured tool-use loop over Claude: the model
 * perceives a compact observation and acts by choosing an ephemeral ref (never coordinates). It
 * cannot exceed the allowlist — the PolicyEnforcedSurface decides; the model only proposes.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Brain, Decision, DiscoveryContext } from './brain.js';

const SYSTEM = `You operate a legacy back-office web UI to accomplish a goal, like a human operator.
Rules:
- You perceive the screen as a list of elements, each with an ephemeral ref like "obs_3:e5".
- Act ONLY on refs from the CURRENT observation. Never use coordinates.
- Use the exact input values provided by the user to fill fields.
- Read the values the goal asks for using the read tool, binding each to an output name.
- Call finish when the goal state (the review screen) is reached.
- For every action, include a short expectedEffect describing the state you expect to observe after it.
- Safety: never click an irreversible "Create Account" control. Reaching the review screen is the goal.`;

const EFFECT = { type: 'string' as const, description: 'The state you expect to observe after this action' };
const TOOLS: Anthropic.Tool[] = [
  { name: 'click', description: 'Click an element by ref', input_schema: { type: 'object', properties: { ref: { type: 'string' }, intent: { type: 'string' }, expectedEffect: EFFECT }, required: ['ref', 'intent', 'expectedEffect'] } },
  { name: 'type', description: 'Type a value into a field by ref', input_schema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' }, intent: { type: 'string' }, expectedEffect: EFFECT }, required: ['ref', 'value', 'intent', 'expectedEffect'] } },
  { name: 'select', description: 'Select an option in a dropdown by ref', input_schema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' }, intent: { type: 'string' }, expectedEffect: EFFECT }, required: ['ref', 'value', 'intent', 'expectedEffect'] } },
  { name: 'read', description: 'Read text from an element and bind it to an output name', input_schema: { type: 'object', properties: { ref: { type: 'string' }, output: { type: 'string' }, intent: { type: 'string' }, expectedEffect: EFFECT }, required: ['ref', 'output', 'intent', 'expectedEffect'] } },
  { name: 'finish', description: 'Signal the goal is complete', input_schema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] } },
];

export class LlmBrain implements Brain {
  readonly name: string;
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private pendingToolUseId?: string;

  constructor(private readonly model: string, apiKey: string) {
    this.name = `llm:${model}`;
    this.client = new Anthropic({ apiKey });
  }

  private obsText(ctx: DiscoveryContext, first: boolean): string {
    const header = first
      ? `GOAL: ${ctx.goal}\nINPUT VALUES: ${JSON.stringify(ctx.inputs)}\n\n`
      : '';
    return `${header}URL: ${ctx.url}\nELEMENTS:\n${ctx.observation.outline}`;
  }

  async next(ctx: DiscoveryContext): Promise<Decision> {
    if (this.pendingToolUseId) {
      this.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: this.pendingToolUseId, content: this.obsText(ctx, false) }] });
    } else {
      this.messages.push({ role: 'user', content: this.obsText(ctx, true) });
    }

    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS,
      // One action per turn: the loop observes, decides, acts, then re-observes.
      // (Field is accepted by the API; cast for older SDK typings that omit it.)
      tool_choice: { type: 'auto', disable_parallel_tool_use: true } as Anthropic.MessageCreateParams['tool_choice'],
      messages: this.messages,
    });
    this.messages.push({ role: 'assistant', content: resp.content });

    const tu = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!tu) return { kind: 'finish', intent: 'model produced no tool call' };
    this.pendingToolUseId = tu.id;
    const input = tu.input as Record<string, string>;
    const eff = input.expectedEffect;
    switch (tu.name) {
      case 'finish':
        return { kind: 'finish', intent: input.intent ?? 'finish' };
      case 'click':
        return { kind: 'act', action: 'click', ref: input.ref as Decision['ref'], intent: input.intent!, expectedEffect: eff };
      case 'type':
        return { kind: 'act', action: 'type', ref: input.ref as Decision['ref'], value: input.value, intent: input.intent!, expectedEffect: eff };
      case 'select':
        return { kind: 'act', action: 'select', ref: input.ref as Decision['ref'], value: input.value, intent: input.intent!, expectedEffect: eff };
      case 'read':
        return { kind: 'act', action: 'read', ref: input.ref as Decision['ref'], bindOutput: input.output, intent: input.intent!, expectedEffect: eff };
      default:
        return { kind: 'finish', intent: `unknown tool ${tu.name}` };
    }
  }
}
