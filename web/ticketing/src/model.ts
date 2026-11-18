import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';

export const CANISTER = 'qojfj-6qaaa-aaaam-qjkaq-cai';
export const HOST = 'https://icp-api.io';
export const tasks = {
  department: { question: 'Which department?', options: [
    { id: 'it', text: 'IT support' }, { id: 'hr', text: 'Human resources' },
    { id: 'finance', text: 'Finance' }, { id: 'admin', text: 'General affairs' },
  ] },
  priority: { question: 'How urgent?', options: [
    { id: 'low', text: 'Future planning' }, { id: 'normal', text: 'Routine request' },
    { id: 'high', text: 'Urgent disruption' },
  ] },
} as const;
export type Task = keyof typeof tasks;
export type Reply = {
  ids: string[]; selected: string; probabilities: number[]; logits: number[];
  confidence: number; model: Uint8Array | number[]; input_tokens: number;
  measured_instructions: bigint;
};
export type Status = { model: Uint8Array | number[]; warmed: boolean; max_tokens: number; budget: bigint };
export class ModelChangedError extends Error {
  constructor() {
    super('Invalid model response: model changed; reconnect required');
    this.name = 'ModelChangedError';
  }
}
const errorNames = ['Unauthorized','Storage','Capacity','Numeric','TooLong','Transition','BindingMismatch','NonceGap','IdConflict','Expired','NotFound','Uncalibrated','Busy','NonceConsumed','OperationUsed','Budget','Stale','ReportOnly','LiveDisabled','OutcomeUnknown'];
const errorType = IDL.Variant({ ...Object.fromEntries(errorNames.map(k => [k, IDL.Null])), Invalid: IDL.Text, ModelUnavailable: IDL.Text, Denied: IDL.Text });
const idl = () => IDL.Service({
  info: IDL.Func([], [IDL.Record({ model: IDL.Vec(IDL.Nat8), warmed: IDL.Bool })], ['query']),
  query_limits: IDL.Func([], [IDL.Record({ max_tokens: IDL.Nat32, budget: IDL.Nat64 })], ['query']),
  decide_query: IDL.Func([IDL.Record({ state: IDL.Text, question: IDL.Text,
    options: IDL.Vec(IDL.Record({ id: IDL.Text, text: IDL.Text })), abstention: IDL.Bool, temperature: IDL.Float64 })],
  [IDL.Variant({ Ok: IDL.Record({ ids: IDL.Vec(IDL.Text), selected: IDL.Text, probabilities: IDL.Vec(IDL.Float32), logits: IDL.Vec(IDL.Float32), confidence: IDL.Float32, model: IDL.Vec(IDL.Nat8), input_tokens: IDL.Nat32, measured_instructions: IDL.Nat64 }), Err: errorType })], ['query']),
});
export function requestFor(task: Task, text: string) {
  return { state: text, question: tasks[task].question, options: tasks[task].options.map(o => ({ ...o })), abstention: false, temperature: 1.0 };
}
export function validateReply(reply: Reply, task: Task, status: Status) {
  const expected = tasks[task].options.map(o => o.id as string);
  const selected = expected.indexOf(reply.selected);
  if (selected < 0 || reply.ids.length !== expected.length || reply.ids.some((id, i) => id !== expected[i])
    || reply.probabilities.length !== expected.length || reply.probabilities.some(x => !Number.isFinite(x) || x < 0 || x > 1)
    || Math.abs(reply.probabilities.reduce((a,b) => a+b, 0) - 1) > 0.001
    || reply.probabilities.some((x, i) => x > reply.probabilities[selected] || (x === reply.probabilities[selected] && i < selected))
    || reply.logits.length !== expected.length || reply.logits.some(x => !Number.isFinite(x))
    || reply.model.length !== 32 || status.model.length !== 32
    || !Number.isInteger(reply.input_tokens) || reply.input_tokens < 1
    || typeof reply.measured_instructions !== 'bigint' || reply.measured_instructions < 0n
    || !Number.isFinite(reply.confidence) || Math.abs(reply.confidence - reply.probabilities[selected]) > 0.001) {
    throw new Error('Invalid model response');
  }
  if (Array.from(reply.model).some((x,i) => x !== status.model[i])) throw new ModelChangedError();
  if (reply.input_tokens > status.max_tokens || reply.measured_instructions > status.budget) throw new Error('Invalid model response');
  return reply;
}
export async function connect() {
  const agent = await HttpAgent.create({ host: HOST });
  const actor = Actor.createActor(idl, { agent, canisterId: CANISTER });
  const [info, limits] = await Promise.all([actor.info(), actor.query_limits()]) as [Pick<Status,'model'|'warmed'>, Pick<Status,'max_tokens'|'budget'>];
  const status: Status = { ...info, ...limits };
  if (!status.warmed || status.max_tokens < 1 || status.model.length !== 32) throw new Error('Model unavailable');
  return { status, async decide(task: Task, text: string) {
    const result = await actor.decide_query(requestFor(task, text)) as { Ok: Reply } | { Err: unknown };
    if ('Err' in result) throw new Error(`Model query failed: ${JSON.stringify(result.Err)}`);
    return validateReply(result.Ok, task, status);
  } };
}
