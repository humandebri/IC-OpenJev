import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ModelChangedError, requestFor, validateReply, type Reply, type Status } from './model';

const status: Status = { model:Array(32).fill(7), warmed:true, max_tokens:52, budget:5_000_000_000n };
const valid = (): Reply => ({ ids:['low','normal','high'], selected:'normal', probabilities:[0.1,0.8,0.1], logits:[0,2,0], confidence:0.8, model:status.model, input_tokens:32, measured_instructions:3_000_000_000n });
describe('ticketing inference contract', () => {
  it('preserves Japanese input without translation or truncation', () => {
    const text = '全社員がログインできません';
    expect(requestFor('department',text).state).toBe(text);
    expect(requestFor('priority',text).state).toBe(text);
    expect(requestFor('department',text).options.map(o=>o.id)).toEqual(['it','hr','finance','admin']);
    expect(requestFor('priority',text).temperature).toBe(1);
  });
  it('accepts a valid response', () => {
    expect(validateReply(valid(),'priority',status).selected).toBe('normal');
  });
  it('distinguishes a model update from other invalid responses', () => {
    expect(() => validateReply({ ...valid(), model: Array(32).fill(8) }, 'priority', status)).toThrow(ModelChangedError);
    expect(() => validateReply({ ...valid(), model: Array(32).fill(8), input_tokens: 60 }, 'priority', status)).toThrow(ModelChangedError);
    try {
      validateReply({ ...valid(), probabilities: [0.1, NaN, 0.1] }, 'priority', status);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).not.toBeInstanceOf(ModelChangedError);
      expect(String(error)).toContain('Invalid model response');
    }
  });
  it.each([
    { selected:'unknown' }, { ids:['high','normal','low'] }, { probabilities:[0.1,Number.NaN,0.1] },
    { probabilities:[0.1,0.1,0.1] }, { selected:'low' }, { logits:[0,Infinity,0] },
    { model:Array(32).fill(8) }, { input_tokens:53 }, { input_tokens:0 },
    { measured_instructions:5_000_000_001n }, { confidence:0.99 },
  ])('rejects malformed or stale model responses', patch => {
    expect(()=>validateReply({...valid(),...patch},'priority',status)).toThrow('Invalid model response');
  });
  it('fixes independent development and balanced evaluation corpora', () => {
    const corpus = JSON.parse(readFileSync(new URL('../../../fixtures/ticketing-ja/cases.json',import.meta.url),'utf8'));
    expect(corpus.development).toHaveLength(12);
    expect(corpus.evaluation).toHaveLength(24);
    const texts = [...corpus.development,...corpus.evaluation].map(r=>r.text);
    expect(new Set(texts).size).toBe(36);
    for (const department of ['it','hr','finance','admin']) {
      for (const priority of ['low','normal','high']) {
        expect(corpus.evaluation.filter((r:{department:string;priority:string})=>r.department===department&&r.priority===priority)).toHaveLength(2);
      }
    }
  });
});
