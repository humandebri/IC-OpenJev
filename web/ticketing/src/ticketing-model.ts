import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';
import { CANISTER, HOST, ModelChangedError, tasks, type Status, type Task } from './model';
import type { DemoReply } from './demo/session';

type Classification = { labels: string[]; selected: string; probabilities: number[] };
export type TicketReply = {
  model: Uint8Array | number[]; input_tokens: number; measured_instructions: bigint;
  department: Classification; priority: Classification;
};
export type TicketingActor = {
  ticketing_info(): Promise<{ model: Uint8Array | number[]; ready: boolean }>;
  ticketing_query_limits(): Promise<{ calibrated: boolean; max_tokens: number; target_instructions: bigint }>;
  classify_ticket(text: string): Promise<{ Ok: TicketReply } | { Err: unknown }>;
};

const classification = IDL.Record({ labels: IDL.Vec(IDL.Text), selected: IDL.Text, probabilities: IDL.Vec(IDL.Float32) });
const errorType = IDL.Variant({
  ...Object.fromEntries(['Budget', 'OutcomeUnknown', 'Storage', 'Stale', 'TooLong', 'Busy', 'NonceConsumed',
    'IdConflict', 'Transition', 'NotFound', 'ReportOnly', 'Numeric', 'BindingMismatch', 'LiveDisabled',
    'Unauthorized', 'OperationUsed', 'Capacity', 'NonceGap', 'Uncalibrated', 'Expired'].map(key => [key, IDL.Null])),
  Invalid: IDL.Text, Denied: IDL.Text, ModelUnavailable: IDL.Text,
});
const idl = () => IDL.Service({
  ticketing_info: IDL.Func([], [IDL.Record({ model: IDL.Vec(IDL.Nat8), ready: IDL.Bool })], ['query']),
  ticketing_query_limits: IDL.Func([], [IDL.Record({ calibrated: IDL.Bool, max_tokens: IDL.Nat32, target_instructions: IDL.Nat64 })], ['query']),
  classify_ticket: IDL.Func([IDL.Text], [IDL.Variant({ Ok: IDL.Record({
    model: IDL.Vec(IDL.Nat8), input_tokens: IDL.Nat32, measured_instructions: IDL.Nat64,
    department: classification, priority: classification,
  }), Err: errorType })], ['query']),
});

export function validateTicket(reply: TicketReply, status: Status): TicketReply {
  if (reply.model.length !== 32 || !Number.isInteger(reply.input_tokens) || reply.input_tokens < 1
    || typeof reply.measured_instructions !== 'bigint' || reply.measured_instructions < 0n) {
    throw new Error('Invalid model response');
  }
  for (const task of ['department', 'priority'] as const) {
    const value = reply[task], expected = tasks[task].options.map(option => option.id as string);
    const index = expected.indexOf(value.selected);
    if (index < 0 || value.labels.length !== expected.length || value.labels.some((id, i) => id !== expected[i])
      || value.probabilities.length !== expected.length || value.probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1)
      || Math.abs(value.probabilities.reduce((a, b) => a + b, 0) - 1) > 0.001
      || value.probabilities.some((p, i) => p > value.probabilities[index] || (p === value.probabilities[index] && i < index))) {
      throw new Error('Invalid model response');
    }
  }
  if (Array.from(reply.model).some((byte, i) => byte !== status.model[i])) throw new ModelChangedError();
  if (reply.input_tokens > status.max_tokens || reply.measured_instructions > status.budget) throw new Error('Invalid model response');
  return reply;
}

/** Both visible tasks share one query; a later submission always makes a fresh call. */
export async function createTicketingClient(actor: TicketingActor) {
  const [info, limits] = await Promise.all([actor.ticketing_info(), actor.ticketing_query_limits()]);
  if (!info.ready || info.model.length !== 32 || !limits.calibrated || limits.max_tokens < 1 || limits.target_instructions <= 0n) {
    throw new Error('Model unavailable');
  }
  const status: Status = { model: info.model, warmed: info.ready, max_tokens: limits.max_tokens, budget: limits.target_instructions };
  let pending: { text: string; promise: Promise<TicketReply> } | undefined;
  return { status, async decide(task: Task, text: string): Promise<DemoReply> {
    if (!pending || pending.text !== text) {
      const promise = actor.classify_ticket(text).then(result => {
        if ('Err' in result) throw new Error(`Model query failed: ${JSON.stringify(result.Err)}`);
        return validateTicket(result.Ok, status);
      });
      const current = { text, promise };
      pending = current;
      // Clear failures as well as successes so retries never reuse a failed request.
      void promise.then(() => { if (pending === current) pending = undefined; }, () => { if (pending === current) pending = undefined; });
    }
    const reply = await pending.promise, value = reply[task];
    return { ids: value.labels, selected: value.selected, probabilities: value.probabilities,
      confidence: value.probabilities[value.labels.indexOf(value.selected)], model: reply.model,
      input_tokens: reply.input_tokens, measured_instructions: reply.measured_instructions };
  } };
}

export async function connectTicketing() {
  const agent = await HttpAgent.create({ host: HOST });
  return createTicketingClient(Actor.createActor<TicketingActor>(idl, { agent, canisterId: CANISTER }));
}
