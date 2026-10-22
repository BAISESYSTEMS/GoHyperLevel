import {
  DEFAULT_TZ,
  FormatError,
  addToDate,
  dateOp,
  diffDates,
  formatDate,
  formatNumber,
  numberOp,
  parseDate,
  parseNumber,
  regexInput,
  roundTo,
  safeRegex,
  slugify,
  str as toStr,
  textOp,
  titleCase,
} from './formatters.js';
import { ymdInTz } from '../core/time.js';

/**
 * A small, safe expression language for the workflow step "Code" and for `if` conditions – instead of running
 * JavaScript. It is a hand-written tokenizer, parser and interpreter: there is no `eval`, no `new Function`,
 * no access to globals, `process`, `require`, prototypes or constructors. The program only sees the data it is given
 * (contact, event, var, location – deep copies) and a fixed list of functions.
 *
 *   Values      numbers, strings ('…' "…" `…${expr}…`), true, false, null, [lists], {objects}
 *   Operators   + - * / % **   == != === !==   < <= > >= in   && || ??   !  - +   a ? b : c   x?.y   x[i]
 *   Statements  let x = …;  x = …;  x += …;  if (…) { … } else { … }  for (let i of list) { … }  while (…) { … }
 *               break;  continue;  return …;      (a single expression is a program too)
 *   Lambdas     x => x * 2, (a, b) => a + b   (only as values, e.g. map(list, x => x.name))
 *   Writing     `var.score = var.score + 1` changes the workflow variable; everything else is local to the run of the code.
 *
 * Limits (see DEFAULT_LIMITS): 8 000 characters of source, 4 000 syntax nodes, nesting 60, 20 000 evaluation steps
 * (so `while (true) {}` ends with an error), 150 ms, call depth 40, strings 100 000 characters, lists 10 000 items.
 * Errors are ExprError with a German message; nothing here throws anything else.
 */

export class ExprError extends Error {
  constructor(
    message: string,
    public pos?: number,
  ) {
    super(message);
  }
}

export interface ExprLimits {
  maxSource: number;
  maxNodes: number;
  maxNesting: number;
  maxSteps: number;
  maxMs: number;
  maxCallDepth: number;
  maxString: number;
  maxArray: number;
  maxOutput: number;
}

export const DEFAULT_LIMITS: ExprLimits = { maxSource: 8_000, maxNodes: 4_000, maxNesting: 60, maxSteps: 20_000, maxMs: 150, maxCallDepth: 40, maxString: 100_000, maxArray: 10_000, maxOutput: 200_000 };

// --- tokenizer ------------------------------------------------------------------------------------

type Tok = { t: 'num' | 'str' | 'tpl' | 'id' | 'op' | 'eof'; v: any; pos: number };

const OPS = ['===', '!==', '**=', '...', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '**', '+=', '-=', '*=', '/=', '%=', '=>', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '=', '(', ')', '[', ']', '{', '}', ',', '.', ';'];
const KEYWORDS = new Set(['let', 'const', 'if', 'else', 'for', 'of', 'while', 'return', 'break', 'continue', 'true', 'false', 'null', 'undefined', 'in']);
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

interface Budget {
  nodes: number;
  limits: ExprLimits;
}

function tokenize(src: string, budget: Budget, depth: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new ExprError('Kommentar nicht geschlossen', i);
      i = end + 2;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d[\d_]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
      if (!m) throw new ExprError('Ungültige Zahl', i);
      toks.push({ t: 'num', v: Number(m[0].replace(/_/g, '')), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          const e = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`', $: '$' };
          if (e === 'u') {
            const hex = src.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ExprError('Ungültige \\u-Folge', j);
            out += String.fromCharCode(parseInt(hex, 16));
            j += 6;
            continue;
          }
          out += map[e] ?? e ?? '';
          j += 2;
          continue;
        }
        out += src[j++];
        if (out.length > budget.limits.maxString) throw new ExprError('Text zu lang', i);
      }
      if (j >= n) throw new ExprError('Text nicht geschlossen', i);
      toks.push({ t: 'str', v: out, pos: i });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const parts: (string | Node)[] = [];
      let j = i + 1;
      let cur = '';
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          cur += ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[e] ?? e ?? '';
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          if (cur) parts.push(cur);
          cur = '';
          let d = 1;
          let k = j + 2;
          let q = '';
          while (k < n && d > 0) {
            const ch = src[k];
            if (q) {
              if (ch === '\\') k++;
              else if (ch === q) q = '';
            } else if (ch === '"' || ch === "'" || ch === '`') q = ch;
            else if (ch === '{') d++;
            else if (ch === '}') d--;
            k++;
          }
          if (d > 0) throw new ExprError('${ nicht geschlossen', j);
          parts.push(parseExpression(src.slice(j + 2, k - 1), budget, depth + 1));
          j = k;
          continue;
        }
        cur += src[j++];
        if (cur.length > budget.limits.maxString) throw new ExprError('Text zu lang', i);
      }
      if (j >= n) throw new ExprError('Text nicht geschlossen', i);
      if (cur) parts.push(cur);
      toks.push({ t: 'tpl', v: parts, pos: i });
      i = j + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Unerwartetes Zeichen „${c}“`, i);
    // "a ?.5 : 1" is a ternary, not optional chaining
    if (op === '?.' && /[0-9]/.test(src[i + 2] ?? '')) {
      toks.push({ t: 'op', v: '?', pos: i });
      i += 1;
      continue;
    }
    toks.push({ t: 'op', v: op, pos: i });
    i += op.length;
    if (toks.length > budget.limits.maxNodes * 3) throw new ExprError('Programm zu groß', i);
  }
  toks.push({ t: 'eof', v: '', pos: n });
  return toks;
}

// --- parser ---------------------------------------------------------------------------------------

type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'tpl'; parts: (string | Node)[] }
  | { k: 'id'; n: string; pos: number }
  | { k: 'arr'; items: Node[] }
  | { k: 'obj'; props: [string, Node][] }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node; pos: number }
  | { k: 'logic'; op: string; a: Node; b: Node }
  | { k: 'cond'; c: Node; a: Node; b: Node }
  | { k: 'mem'; o: Node; p: Node; opt: boolean; pos: number }
  | { k: 'call'; f: Node; args: Node[]; opt: boolean; pos: number }
  | { k: 'fn'; params: string[]; body: Node }
  | { k: 'asg'; op: string; target: Node; v: Node; pos: number }
  | { k: 'let'; n: string; v: Node | null }
  | { k: 'if'; c: Node; a: Node[]; b: Node[] | null }
  | { k: 'for'; n: string; it: Node; body: Node[] }
  | { k: 'while'; c: Node; body: Node[] }
  | { k: 'ret'; v: Node | null }
  | { k: 'brk' }
  | { k: 'cont' }
  | { k: 'expr'; e: Node };

class Parser {
  private i = 0;
  private depth = 0;
  constructor(
    private toks: Tok[],
    private budget: Budget,
    private base: number,
  ) {}

  private get cur() {
    return this.toks[this.i];
  }
  private node<T extends Node>(n: T): T {
    if (++this.budget.nodes > this.budget.limits.maxNodes) throw new ExprError('Programm zu groß (mehr als 4000 Bausteine)', this.cur.pos);
    return n;
  }
  private enter() {
    if (++this.depth + this.base > this.budget.limits.maxNesting) throw new ExprError('Zu tief verschachtelt', this.cur.pos);
  }
  private leave() {
    this.depth--;
  }
  private atEof() {
    return this.cur.t === 'eof';
  }
  private isOp(v: string) {
    return this.cur.t === 'op' && this.cur.v === v;
  }
  private isKw(v: string) {
    return this.cur.t === 'id' && this.cur.v === v;
  }
  private eat(v: string) {
    if (this.isOp(v)) return this.toks[this.i++];
    return null;
  }
  private expect(v: string) {
    if (!this.eat(v)) throw new ExprError(`„${v}“ erwartet, gefunden: ${this.describe()}`, this.cur.pos);
  }
  private describe() {
    return this.cur.t === 'eof' ? 'Ende' : `„${this.cur.t === 'tpl' ? '`…`' : String(this.cur.v)}“`;
  }

  /** The whole input must have been read. */
  finish() {
    if (this.cur.t !== 'eof') throw new ExprError(`Unerwartet: ${this.describe()}`, this.cur.pos);
  }

  program(): Node[] {
    const out: Node[] = [];
    while (this.cur.t !== 'eof') {
      out.push(this.statement());
      while (this.eat(';'));
    }
    return out;
  }

  private block(): Node[] {
    if (this.eat('{')) {
      this.enter();
      const out: Node[] = [];
      while (!this.isOp('}')) {
        if (this.cur.t === 'eof') throw new ExprError('„}“ fehlt', this.cur.pos);
        out.push(this.statement());
        while (this.eat(';'));
      }
      this.expect('}');
      this.leave();
      return out;
    }
    return [this.statement()];
  }

  private statement(): Node {
    this.enter();
    try {
      if (this.cur.t === 'id') {
        const kw = this.cur.v;
        if (kw === 'let' || kw === 'const') {
          this.i++;
          if (this.cur.t !== 'id' || KEYWORDS.has(this.cur.v)) throw new ExprError('Name der Variable erwartet', this.cur.pos);
          const n = this.toks[this.i++].v as string;
          let v: Node | null = null;
          if (this.eat('=')) v = this.expression();
          return this.node({ k: 'let', n, v });
        }
        if (kw === 'if') {
          this.i++;
          this.expect('(');
          const c = this.expression();
          this.expect(')');
          const a = this.block();
          let b: Node[] | null = null;
          if (this.isKw('else')) {
            this.i++;
            b = this.isKw('if') ? [this.statement()] : this.block();
          }
          return this.node({ k: 'if', c, a, b });
        }
        if (kw === 'for') {
          this.i++;
          this.expect('(');
          if (this.isKw('let') || this.isKw('const')) this.i++;
          if (this.cur.t !== 'id' || KEYWORDS.has(this.cur.v)) throw new ExprError('Name der Schleifenvariable erwartet', this.cur.pos);
          const n = this.toks[this.i++].v as string;
          if (!this.isKw('of')) throw new ExprError('„of“ erwartet: for (let x of liste) { … }', this.cur.pos);
          this.i++;
          const it = this.expression();
          this.expect(')');
          return this.node({ k: 'for', n, it, body: this.block() });
        }
        if (kw === 'while') {
          this.i++;
          this.expect('(');
          const c = this.expression();
          this.expect(')');
          return this.node({ k: 'while', c, body: this.block() });
        }
        if (kw === 'return') {
          this.i++;
          const v = this.isOp(';') || this.isOp('}') || this.atEof() ? null : this.expression();
          return this.node({ k: 'ret', v });
        }
        if (kw === 'break') return this.i++, this.node({ k: 'brk' });
        if (kw === 'continue') return this.i++, this.node({ k: 'cont' });
      }
      if (this.isOp('{')) {
        // a block statement: run its statements (flattened into an always-true if)
        const body = this.block();
        return this.node({ k: 'if', c: { k: 'lit', v: true }, a: body, b: null });
      }
      return this.node({ k: 'expr', e: this.expression() });
    } finally {
      this.leave();
    }
  }

  expression(): Node {
    this.enter();
    try {
      return this.assignment();
    } finally {
      this.leave();
    }
  }

  private assignment(): Node {
    // x => …  and  (a, b) => …
    if (this.cur.t === 'id' && !KEYWORDS.has(this.cur.v) && this.toks[this.i + 1]?.t === 'op' && this.toks[this.i + 1].v === '=>') {
      const p = this.toks[this.i].v as string;
      this.i += 2;
      return this.node({ k: 'fn', params: [p], body: this.assignment() });
    }
    if (this.isOp('(')) {
      let j = this.i + 1;
      const params: string[] = [];
      while (this.toks[j]?.t === 'id' && !KEYWORDS.has(this.toks[j].v)) {
        params.push(this.toks[j].v);
        j++;
        if (this.toks[j]?.t === 'op' && this.toks[j].v === ',') j++;
        else break;
      }
      if (this.toks[j]?.t === 'op' && this.toks[j].v === ')' && this.toks[j + 1]?.t === 'op' && this.toks[j + 1].v === '=>') {
        this.i = j + 2;
        return this.node({ k: 'fn', params, body: this.assignment() });
      }
    }
    const left = this.ternary();
    if (this.cur.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '**='].includes(this.cur.v)) {
      const op = this.toks[this.i++];
      if (left.k !== 'id' && left.k !== 'mem') throw new ExprError('Zuweisung nur an eine Variable oder ein Feld', op.pos);
      return this.node({ k: 'asg', op: op.v, target: left, v: this.assignment(), pos: op.pos });
    }
    return left;
  }

  private ternary(): Node {
    const c = this.nullish();
    if (this.eat('?')) {
      const a = this.assignment();
      this.expect(':');
      const b = this.assignment();
      return this.node({ k: 'cond', c, a, b });
    }
    return c;
  }
  private nullish(): Node {
    let a = this.or();
    while (this.isOp('??')) {
      this.i++;
      a = this.node({ k: 'logic', op: '??', a, b: this.or() });
    }
    return a;
  }
  private or(): Node {
    let a = this.and();
    while (this.isOp('||')) {
      this.i++;
      a = this.node({ k: 'logic', op: '||', a, b: this.and() });
    }
    return a;
  }
  private and(): Node {
    let a = this.equality();
    while (this.isOp('&&')) {
      this.i++;
      a = this.node({ k: 'logic', op: '&&', a, b: this.equality() });
    }
    return a;
  }
  private binary(next: () => Node, ops: string[]): Node {
    let a = next();
    while (this.cur.t === 'op' && ops.includes(this.cur.v)) {
      const t = this.toks[this.i++];
      a = this.node({ k: 'bin', op: t.v, a, b: next(), pos: t.pos });
    }
    return a;
  }
  private equality(): Node {
    return this.binary(() => this.relational(), ['==', '!=', '===', '!==']);
  }
  private relational(): Node {
    let a = this.additive();
    while ((this.cur.t === 'op' && ['<', '<=', '>', '>='].includes(this.cur.v)) || this.isKw('in')) {
      const t = this.toks[this.i++];
      a = this.node({ k: 'bin', op: t.v, a, b: this.additive(), pos: t.pos });
    }
    return a;
  }
  private additive(): Node {
    return this.binary(() => this.multiplicative(), ['+', '-']);
  }
  private multiplicative(): Node {
    return this.binary(() => this.power(), ['*', '/', '%']);
  }
  private power(): Node {
    const a = this.unary();
    if (this.isOp('**')) {
      const t = this.toks[this.i++];
      return this.node({ k: 'bin', op: '**', a, b: this.power(), pos: t.pos });
    }
    return a;
  }
  private unary(): Node {
    if (this.cur.t === 'op' && ['!', '-', '+'].includes(this.cur.v)) {
      this.enter();
      const op = this.toks[this.i++].v;
      const a = this.unary();
      this.leave();
      return this.node({ k: 'un', op, a });
    }
    return this.postfix();
  }
  private postfix(): Node {
    let e = this.primary();
    for (;;) {
      if (this.isOp('.') || this.isOp('?.')) {
        const opt = this.toks[this.i++].v === '?.';
        if (opt && this.isOp('(')) {
          e = this.callArgs(e, true);
          continue;
        }
        if (opt && this.isOp('[')) {
          this.i++;
          const p = this.expression();
          this.expect(']');
          e = this.node({ k: 'mem', o: e, p, opt: true, pos: this.cur.pos });
          continue;
        }
        if (this.cur.t !== 'id') throw new ExprError('Feldname erwartet nach „.“', this.cur.pos);
        const t = this.toks[this.i++];
        e = this.node({ k: 'mem', o: e, p: { k: 'lit', v: t.v }, opt, pos: t.pos });
      } else if (this.isOp('[')) {
        const t = this.toks[this.i++];
        const p = this.expression();
        this.expect(']');
        e = this.node({ k: 'mem', o: e, p, opt: false, pos: t.pos });
      } else if (this.isOp('(')) {
        e = this.callArgs(e, false);
      } else return e;
    }
  }
  private callArgs(f: Node, opt: boolean): Node {
    const t = this.toks[this.i++];
    const args: Node[] = [];
    while (!this.isOp(')')) {
      args.push(this.expression());
      if (!this.eat(',')) break;
    }
    this.expect(')');
    if (args.length > 20) throw new ExprError('Zu viele Argumente', t.pos);
    return this.node({ k: 'call', f, args, opt, pos: t.pos });
  }
  private primary(): Node {
    const t = this.cur;
    if (t.t === 'num') return this.i++, this.node({ k: 'lit', v: t.v });
    if (t.t === 'str') return this.i++, this.node({ k: 'lit', v: t.v });
    if (t.t === 'tpl') return this.i++, this.node({ k: 'tpl', parts: t.v });
    if (t.t === 'id') {
      this.i++;
      if (t.v === 'true') return this.node({ k: 'lit', v: true });
      if (t.v === 'false') return this.node({ k: 'lit', v: false });
      if (t.v === 'null') return this.node({ k: 'lit', v: null });
      if (t.v === 'undefined') return this.node({ k: 'lit', v: undefined });
      if (KEYWORDS.has(t.v)) throw new ExprError(`„${t.v}“ steht hier nicht richtig`, t.pos);
      return this.node({ k: 'id', n: t.v, pos: t.pos });
    }
    if (this.eat('(')) {
      const e = this.expression();
      this.expect(')');
      return e;
    }
    if (this.eat('[')) {
      const items: Node[] = [];
      while (!this.isOp(']')) {
        items.push(this.expression());
        if (!this.eat(',')) break;
      }
      this.expect(']');
      return this.node({ k: 'arr', items });
    }
    if (this.eat('{')) {
      const props: [string, Node][] = [];
      while (!this.isOp('}')) {
        const kt = this.cur;
        let key: string;
        if (kt.t === 'id' || kt.t === 'str') key = String(kt.v);
        else if (kt.t === 'num') key = String(kt.v);
        else throw new ExprError('Feldname erwartet', kt.pos);
        this.i++;
        if (BANNED_KEYS.has(key)) throw new ExprError(`Feldname „${key}“ ist nicht erlaubt`, kt.pos);
        if (this.eat(':')) props.push([key, this.expression()]);
        else if (kt.t === 'id') props.push([key, this.node({ k: 'id', n: key, pos: kt.pos })]);
        else throw new ExprError('„:“ erwartet', this.cur.pos);
        if (!this.eat(',')) break;
      }
      this.expect('}');
      return this.node({ k: 'obj', props });
    }
    throw new ExprError(`Unerwartet: ${this.describe()}`, t.pos);
  }
}

function parseExpression(src: string, budget: Budget, base: number): Node {
  if (base > budget.limits.maxNesting) throw new ExprError('Zu tief verschachtelt');
  const p = new Parser(tokenize(src, budget, base), budget, base);
  const e = p.expression();
  p.finish();
  return e;
}

export function parseProgram(source: string, limits: Partial<ExprLimits> = {}): Node[] {
  const l = { ...DEFAULT_LIMITS, ...limits };
  if (typeof source !== 'string') throw new ExprError('Kein Text');
  if (source.length > l.maxSource) throw new ExprError(`Code zu lang (höchstens ${l.maxSource} Zeichen)`);
  const budget: Budget = { nodes: 0, limits: l };
  return new Parser(tokenize(source, budget, 0), budget, 0).program();
}

/** Syntax check only: null when the program parses, else the German error text (with position). */
export function checkSyntax(source: string, limits: Partial<ExprLimits> = {}): string | null {
  try {
    parseProgram(source, limits);
    return null;
  } catch (e) {
    if (e instanceof ExprError) return e.pos === undefined ? e.message : `${e.message} (Position ${e.pos})`;
    return (e as Error).message;
  }
}

// --- runtime values -------------------------------------------------------------------------------

class Lambda {
  constructor(
    public params: string[],
    public body: Node,
    public env: Env,
  ) {}
}
class Builtin {
  constructor(
    public name: string,
    public fn: (args: any[], rt: Runtime) => unknown,
  ) {}
}

class Env {
  vars = new Map<string, unknown>();
  constructor(public parent?: Env) {}
  has(n: string): boolean {
    return this.vars.has(n) || !!this.parent?.has(n);
  }
  get(n: string): unknown {
    if (this.vars.has(n)) return this.vars.get(n);
    return this.parent?.get(n);
  }
  /** Assigns to the nearest scope that has the variable; returns false when there is none. */
  set(n: string, v: unknown): boolean {
    if (this.vars.has(n)) {
      this.vars.set(n, v);
      return true;
    }
    return this.parent?.set(n, v) ?? false;
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Lambda) && !(v instanceof Builtin) && !(v instanceof Date);

/** Data goes in as a deep copy made from JSON: no prototypes, functions, symbols, getters or cycles. */
function cloneData(v: unknown, depth = 0): unknown {
  if (depth > 20) return null;
  if (v === null || v === undefined) return v;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Array.isArray(v)) return v.slice(0, 10_000).map((x) => cloneData(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const k of Object.keys(v as object)) {
      if (BANNED_KEYS.has(k)) continue;
      if (++n > 2000) break;
      out[k] = cloneData((v as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return null;
}

class Signal {
  constructor(public kind: 'break' | 'continue' | 'return', public value?: unknown) {}
}

export interface EvalResult {
  value: unknown;
  /** Top-level keys of `var` the program changed (null = deleted). */
  vars: Record<string, unknown>;
  steps: number;
}

export interface EvalOptions {
  limits?: Partial<ExprLimits>;
  /** Time zone for date functions (the sub-account's). */
  tz?: string;
  /** Replaces "now" (tests). */
  now?: Date;
}

class Runtime {
  /** Set right after construction (the interpreter needs the runtime and the builtins need the interpreter). */
  interp!: Interpreter;
  steps = 0;
  start = Date.now();
  calls = 0;
  tz: string;
  now: Date;
  constructor(
    public limits: ExprLimits,
    opts: EvalOptions,
  ) {
    this.tz = opts.tz || DEFAULT_TZ;
    this.now = opts.now ?? new Date();
  }
  tick(pos?: number) {
    if (++this.steps > this.limits.maxSteps) throw new ExprError(`Schritt-Grenze erreicht (${this.limits.maxSteps}) – Endlosschleife?`, pos);
    if ((this.steps & 127) === 0 && Date.now() - this.start > this.limits.maxMs) throw new ExprError(`Zeitgrenze erreicht (${this.limits.maxMs} ms)`, pos);
  }
  checkStr(s: string): string {
    if (s.length > this.limits.maxString) throw new ExprError('Text zu lang (höchstens 100 000 Zeichen)');
    return s;
  }
  checkArr<T>(a: T[]): T[] {
    if (a.length > this.limits.maxArray) throw new ExprError('Liste zu lang (höchstens 10 000 Einträge)');
    return a;
  }
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'string' ? (Number.isNaN(Number(v)) ? parseNumber(v) : Number(v)) : NaN;
};
const truthy = (v: unknown): boolean => !(v === false || v === null || v === undefined || v === 0 || v === '' || (typeof v === 'number' && Number.isNaN(v)));
const looseEq = (a: unknown, b: unknown): boolean => {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a === typeof b) return typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b;
  if ((typeof a === 'number' && typeof b === 'string') || (typeof a === 'string' && typeof b === 'number')) {
    const x = num(a);
    const y = num(b);
    return !Number.isNaN(x) && x === y;
  }
  return false;
};
const strictEq = (a: unknown, b: unknown): boolean => (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null ? JSON.stringify(a) === JSON.stringify(b) : a === b);
const compare = (a: unknown, b: unknown): number => {
  if (typeof a === 'string' && typeof b === 'string' && !(/^-?\d/.test(a) && /^-?\d/.test(b))) return a < b ? -1 : a > b ? 1 : 0;
  const x = num(a);
  const y = num(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  return x < y ? -1 : x > y ? 1 : 0;
};

function member(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj === 'string') {
    if (key === 'length') return [...obj].length;
    if (typeof key === 'number' && Number.isInteger(key)) return obj[key < 0 ? obj.length + key : key];
    return undefined;
  }
  if (Array.isArray(obj)) {
    if (key === 'length') return obj.length;
    if (typeof key === 'number' && Number.isInteger(key)) return obj[key < 0 ? obj.length + key : key];
    if (typeof key === 'string' && /^-?\d+$/.test(key)) return obj[Number(key) < 0 ? obj.length + Number(key) : Number(key)];
    return undefined;
  }
  if (isPlain(obj)) {
    const k = typeof key === 'number' ? String(key) : key;
    if (typeof k !== 'string' || BANNED_KEYS.has(k)) return undefined;
    return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined;
  }
  return undefined;
}

function plus(a: unknown, b: unknown, rt: Runtime): unknown {
  if (typeof a === 'string' || typeof b === 'string' || Array.isArray(a) || isPlain(a) || isPlain(b)) {
    if (Array.isArray(a) && Array.isArray(b)) return rt.checkArr([...a, ...b]);
    return rt.checkStr(toStr(a) + toStr(b));
  }
  return num(a) + num(b);
}

// --- builtin functions ----------------------------------------------------------------------------

type Fn = (args: any[], rt: Runtime) => unknown;
const FUNCTIONS: Record<string, { sig: string; doc: string; fn: Fn }> = Object.create(null);
const def = (name: string, sig: string, doc: string, fn: Fn) => {
  FUNCTIONS[name] = { sig, doc, fn };
};

class Interpreter {
  constructor(public rt: Runtime) {}

  callValue(f: unknown, args: unknown[]): unknown {
    const rt = this.rt;
    rt.tick();
    if (f instanceof Builtin) return f.fn(args, rt);
    if (f instanceof Lambda) {
      if (++rt.calls > rt.limits.maxCallDepth) throw new ExprError('Zu viele verschachtelte Funktionsaufrufe');
      try {
        const env = new Env(f.env);
        f.params.forEach((p, i) => env.vars.set(p, args[i]));
        return this.eval(f.body, env);
      } finally {
        rt.calls--;
      }
    }
    throw new ExprError('Das ist keine Funktion');
  }

  lookup(name: string, env: Env, pos: number): unknown {
    if (env.has(name)) return env.get(name);
    const b = FUNCTIONS[name];
    if (b) return new Builtin(name, b.fn);
    throw new ExprError(`„${name}“ ist nicht bekannt`, pos);
  }

  execBlock(body: Node[], env: Env): Signal | undefined {
    for (const s of body) {
      const r = this.exec(s, env);
      if (r) return r;
    }
    return undefined;
  }

  /** Runs one statement; returns a Signal for break/continue/return. The value of the last expression is kept in `last`. */
  last: unknown = undefined;

  exec(s: Node, env: Env): Signal | undefined {
    const rt = this.rt;
    rt.tick();
    switch (s.k) {
      case 'let':
        env.vars.set(s.n, s.v ? this.eval(s.v, env) : undefined);
        return undefined;
      case 'if': {
        const branch = truthy(this.eval(s.c, env)) ? s.a : s.b;
        return branch ? this.execBlock(branch, new Env(env)) : undefined;
      }
      case 'for': {
        const it = this.eval(s.it, env);
        const list = Array.isArray(it) ? it : typeof it === 'string' ? [...it] : isPlain(it) ? Object.keys(it) : [];
        for (const item of list) {
          const inner = new Env(env);
          inner.vars.set(s.n, item);
          const r = this.execBlock(s.body, inner);
          if (r?.kind === 'break') break;
          if (r?.kind === 'return') return r;
        }
        return undefined;
      }
      case 'while':
        while (truthy(this.eval(s.c, env))) {
          rt.tick();
          const r = this.execBlock(s.body, new Env(env));
          if (r?.kind === 'break') break;
          if (r?.kind === 'return') return r;
        }
        return undefined;
      case 'ret':
        return new Signal('return', s.v ? this.eval(s.v, env) : undefined);
      case 'brk':
        return new Signal('break');
      case 'cont':
        return new Signal('continue');
      case 'expr':
        this.last = this.eval(s.e, env);
        return undefined;
      default:
        throw new ExprError('Unbekannte Anweisung');
    }
  }

  assign(target: Node, op: string, value: unknown, env: Env, pos: number): unknown {
    const rt = this.rt;
    const combine = (cur: unknown): unknown => {
      switch (op) {
        case '=':
          return value;
        case '+=':
          return plus(cur, value, rt);
        case '-=':
          return num(cur) - num(value);
        case '*=':
          return num(cur) * num(value);
        case '/=':
          if (num(value) === 0) throw new ExprError('Division durch 0', pos);
          return num(cur) / num(value);
        case '%=':
          return num(cur) % num(value);
        default:
          return num(cur) ** num(value);
      }
    };
    if (target.k === 'id') {
      if (!env.has(target.n)) throw new ExprError(`„${target.n}“ ist nicht deklariert – mit let anlegen`, target.pos);
      const v = combine(env.get(target.n));
      env.set(target.n, v);
      return v;
    }
    if (target.k === 'mem') {
      const obj = this.eval(target.o, env);
      const key = this.eval(target.p, env);
      if (Array.isArray(obj)) {
        const i = typeof key === 'number' ? key : Number(key);
        if (!Number.isInteger(i) || i < 0 || i > rt.limits.maxArray) throw new ExprError('Ungültiger Listenindex', pos);
        const v = combine(obj[i]);
        obj[i] = v;
        rt.checkArr(obj);
        return v;
      }
      if (isPlain(obj)) {
        const k = typeof key === 'number' ? String(key) : key;
        if (typeof k !== 'string' || BANNED_KEYS.has(k)) throw new ExprError('Dieses Feld darf nicht beschrieben werden', pos);
        const v = combine(Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);
        obj[k] = v;
        return v;
      }
      throw new ExprError('Hier kann nichts zugewiesen werden', pos);
    }
    throw new ExprError('Ungültige Zuweisung', pos);
  }

  eval(n: Node, env: Env): unknown {
    const rt = this.rt;
    rt.tick();
    switch (n.k) {
      case 'lit':
        return n.v;
      case 'tpl': {
        let out = '';
        for (const p of n.parts) {
          out += typeof p === 'string' ? p : toStr(this.eval(p, env));
          rt.checkStr(out);
        }
        return out;
      }
      case 'id':
        return this.lookup(n.n, env, n.pos);
      case 'arr':
        return rt.checkArr(n.items.map((x) => this.eval(x, env)));
      case 'obj': {
        const o: Record<string, unknown> = {};
        for (const [k, v] of n.props) o[k] = this.eval(v, env);
        return o;
      }
      case 'fn':
        return new Lambda(n.params, n.body, env);
      case 'un': {
        const v = this.eval(n.a, env);
        if (n.op === '!') return !truthy(v);
        return n.op === '-' ? -num(v) : num(v);
      }
      case 'logic': {
        const a = this.eval(n.a, env);
        if (n.op === '&&') return truthy(a) ? this.eval(n.b, env) : a;
        if (n.op === '||') return truthy(a) ? a : this.eval(n.b, env);
        return a === null || a === undefined ? this.eval(n.b, env) : a;
      }
      case 'cond':
        return truthy(this.eval(n.c, env)) ? this.eval(n.a, env) : this.eval(n.b, env);
      case 'bin': {
        const a = this.eval(n.a, env);
        const b = this.eval(n.b, env);
        switch (n.op) {
          case '+':
            return plus(a, b, rt);
          case '-':
            return num(a) - num(b);
          case '*':
            return num(a) * num(b);
          case '/':
            if (num(b) === 0) throw new ExprError('Division durch 0', n.pos);
            return num(a) / num(b);
          case '%':
            if (num(b) === 0) throw new ExprError('Division durch 0', n.pos);
            return num(a) % num(b);
          case '**': {
            const r = num(a) ** num(b);
            return Number.isFinite(r) ? r : null;
          }
          case '==':
            return looseEq(a, b);
          case '!=':
            return !looseEq(a, b);
          case '===':
            return strictEq(a, b);
          case '!==':
            return !strictEq(a, b);
          case '<':
            return compare(a, b) < 0;
          case '<=':
            return compare(a, b) <= 0;
          case '>':
            return compare(a, b) > 0;
          case '>=':
            return compare(a, b) >= 0;
          case 'in':
            if (Array.isArray(b)) return b.some((x) => looseEq(x, a));
            if (typeof b === 'string') return b.includes(toStr(a));
            if (isPlain(b)) return typeof a === 'string' && Object.prototype.hasOwnProperty.call(b, a) && !BANNED_KEYS.has(a);
            return false;
          default:
            throw new ExprError(`Unbekannter Operator ${n.op}`, n.pos);
        }
      }
      case 'mem': {
        const o = this.eval(n.o, env);
        if ((o === null || o === undefined) && !n.opt) return undefined;
        return member(o, this.eval(n.p, env));
      }
      case 'call':
        return this.call(n, env);
      case 'asg':
        return this.assign(n.target, n.op, this.eval(n.v, env), env, n.pos);
      default:
        throw new ExprError('Hier ist eine Anweisung nicht erlaubt');
    }
  }

  call(n: Extract<Node, { k: 'call' }>, env: Env): unknown {
    const rt = this.rt;
    // Method style: text.upper(), list.map(fn), obj.fn(…) for a lambda stored in an object
    if (n.f.k === 'mem') {
      const obj = this.eval(n.f.o, env);
      if ((obj === null || obj === undefined) && (n.opt || n.f.opt)) return undefined;
      const key = this.eval(n.f.p, env);
      const args = n.args.map((a) => this.eval(a, env));
      if (typeof key === 'string' && !BANNED_KEYS.has(key)) {
        const m = METHODS[key];
        if (m && (m.on === 'any' || (m.on === 'string' && typeof obj === 'string') || (m.on === 'array' && Array.isArray(obj)) || (m.on === 'number' && typeof obj === 'number'))) return m.fn(obj, args, rt);
        if (isPlain(obj) && Object.prototype.hasOwnProperty.call(obj, key) && (obj[key] instanceof Lambda || obj[key] instanceof Builtin)) return this.callValue(obj[key], args);
      }
      throw new ExprError(`„${toStr(key)}“ gibt es hier nicht als Funktion`, n.pos);
    }
    const f = this.eval(n.f, env);
    if ((f === null || f === undefined) && n.opt) return undefined;
    return this.callValue(
      f,
      n.args.map((a) => this.eval(a, env)),
    );
  }
}

type Method = { on: 'string' | 'array' | 'number' | 'any'; fn: (self: any, args: any[], rt: Runtime) => unknown };
const METHODS: Record<string, Method> = Object.create(null);
const method = (name: string, on: Method['on'], fn: Method['fn']) => {
  METHODS[name] = { on, fn };
};

// text
def('upper', 'upper(text)', 'GROSSBUCHSTABEN', ([s]) => toStr(s).toUpperCase());
def('lower', 'lower(text)', 'kleinbuchstaben', ([s]) => toStr(s).toLowerCase());
def('trim', 'trim(text)', 'Leerzeichen am Rand entfernen', ([s]) => toStr(s).trim());
def('capitalize', 'capitalize(text)', 'Ersten Buchstaben groß', ([s]) => textOp('capitalize', s));
def('title_case', 'title_case(text)', 'Jedes Wort groß', ([s]) => titleCase(toStr(s)));
def('slug', 'slug(text)', 'URL-Kürzel', ([s]) => slugify(toStr(s)));
def('len', 'len(text|liste)', 'Länge', ([v]) => (Array.isArray(v) ? v.length : isPlain(v) ? Object.keys(v).length : [...toStr(v)].length));
def('replace', 'replace(text, suche, ersatz)', 'Ersetzt alle Treffer (ohne regulären Ausdruck)', ([s, a, b], rt) => rt.checkStr(textOp('replace', s, a, b) as string));
def('substr', 'substr(text, start, länge?)', 'Teilstück', ([s, a, b]) => textOp('substring', s, a, b));
def('split', 'split(text, trenner)', 'Text in Liste teilen', ([s, sep], rt) => rt.checkArr(textOp('split', s, sep) as string[]));
def('join', 'join(liste, trenner)', 'Liste zu Text', ([l, sep], rt) => rt.checkStr((Array.isArray(l) ? l : []).map(toStr).join(sep === undefined ? ', ' : toStr(sep))));
def('contains', 'contains(text|liste, wert)', 'Enthält?', ([h, n]) => (Array.isArray(h) ? h.some((x) => looseEq(x, n)) : toStr(h).includes(toStr(n))));
def('starts_with', 'starts_with(text, anfang)', 'Beginnt mit?', ([s, a]) => toStr(s).startsWith(toStr(a)));
def('ends_with', 'ends_with(text, ende)', 'Endet mit?', ([s, a]) => toStr(s).endsWith(toStr(a)));
def('pad_left', 'pad_left(text, länge, füllzeichen?)', 'Links auffüllen', ([s, n, f]) => textOp('pad_left', s, n, f));
def('pad_right', 'pad_right(text, länge, füllzeichen?)', 'Rechts auffüllen', ([s, n, f]) => textOp('pad_right', s, n, f));
def('repeat', 'repeat(text, n)', 'Wiederholen (max. 100 000 Zeichen)', ([s, n]) => textOp('repeat', s, n));
def('regex_test', 'regex_test(text, muster, optionen?)', 'Passt der reguläre Ausdruck? (gefährliche Muster werden abgelehnt)', ([s, p, f]) => safeRegex(toStr(p), toStr(f).replace(/g/g, '')).test(regexInput(toStr(s))));
def('regex_match', 'regex_match(text, muster, gruppe?)', 'Erster Treffer (oder Gruppe)', ([s, p, g]) => textOp('extract', s, p, g));
def('regex_replace', 'regex_replace(text, muster, ersatz)', 'Ersetzt alle Treffer', ([s, p, r], rt) => rt.checkStr(textOp('regex_replace', s, p, r) as string));
def('strip_html', 'strip_html(text)', 'HTML entfernen', ([s]) => textOp('strip_html', s));
def('phone', 'phone(text, vorwahl?)', 'Telefonnummer vereinheitlichen', ([s, cc]) => textOp('phone', s, cc));
// numbers
def('number', 'number(wert)', 'Text in Zahl (auch 1.234,56)', ([v]) => {
  const n = parseNumber(v);
  return Number.isNaN(n) ? null : n;
});
def('int', 'int(wert)', 'Ganzzahl (schneidet ab)', ([v]) => {
  const n = parseNumber(v);
  return Number.isNaN(n) ? null : Math.trunc(n);
});
def('abs', 'abs(zahl)', 'Betrag', ([v]) => Math.abs(num(v)));
def('floor', 'floor(zahl)', 'Abrunden', ([v]) => Math.floor(num(v)));
def('ceil', 'ceil(zahl)', 'Aufrunden', ([v]) => Math.ceil(num(v)));
def('round', 'round(zahl, stellen?)', 'Runden (kaufmännisch)', ([v, d]) => roundTo(num(v), d === undefined ? 0 : num(d)));
def('min', 'min(a, b, …)', 'Kleinster Wert (auch aus einer Liste)', (args) => {
  const l = (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(num).filter((x) => !Number.isNaN(x));
  return l.length ? Math.min(...l) : null;
});
def('max', 'max(a, b, …)', 'Größter Wert (auch aus einer Liste)', (args) => {
  const l = (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(num).filter((x) => !Number.isNaN(x));
  return l.length ? Math.max(...l) : null;
});
def('sum', 'sum(liste)', 'Summe', ([l]) => (Array.isArray(l) ? l.map(num).reduce((a, b) => a + b, 0) : 0));
def('avg', 'avg(liste)', 'Durchschnitt', ([l]) => (Array.isArray(l) && l.length ? l.map(num).reduce((a, b) => a + b, 0) / l.length : null));
def('pow', 'pow(basis, exponent)', 'Potenz', ([a, b]) => {
  const r = num(a) ** num(b);
  return Number.isFinite(r) ? r : null;
});
def('sqrt', 'sqrt(zahl)', 'Quadratwurzel', ([v]) => (num(v) < 0 ? null : Math.sqrt(num(v))));
def('clamp', 'clamp(zahl, min, max)', 'Auf Bereich begrenzen', ([v, lo, hi]) => Math.min(num(hi), Math.max(num(lo), num(v))));
def('random', 'random()', 'Zufallszahl von 0 bis unter 1', () => Math.random());
def('random_int', 'random_int(von, bis)', 'Zufällige ganze Zahl (inklusive)', ([a, b]) => {
  const lo = Math.ceil(num(a));
  const hi = Math.floor(num(b));
  return hi < lo ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));
});
def('format_number', 'format_number(zahl, stellen?, sprache?)', 'Zahl als Text, z. B. 1.234,50', ([v, d, loc]) => formatNumber(num(v), d === undefined ? undefined : num(d), loc ? toStr(loc) : 'de-DE', { min: 0 }));
def('format_currency', 'format_currency(zahl, währung?)', 'Als Währung, z. B. 1.234,50 €', ([v, c]) => numberOp('currency', v, { currency: c ? toStr(c) : 'EUR' }));
// types
def('string', 'string(wert)', 'In Text umwandeln', ([v]) => toStr(v));
def('bool', 'bool(wert)', 'In ja/nein umwandeln', ([v]) => truthy(typeof v === 'string' && /^(false|nein|no|0)$/i.test(v.trim()) ? false : v));
def('is_empty', 'is_empty(wert)', 'Leer? (null, "", [], {})', ([v]) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (isPlain(v) && !Object.keys(v).length));
def('is_number', 'is_number(wert)', 'Ist eine Zahl?', ([v]) => !Number.isNaN(parseNumber(v)));
def('coalesce', 'coalesce(a, b, …)', 'Erster Wert, der nicht leer ist', (args) => args.find((v) => v !== null && v !== undefined && v !== '') ?? null);
def('iif', 'iif(bedingung, dann, sonst)', 'Wie a ? b : c', ([c, a, b]) => (truthy(c) ? a : b));
def('json_parse', 'json_parse(text)', 'JSON-Text in Wert (null bei Fehler)', ([s]) => {
  try {
    return cloneData(JSON.parse(toStr(s).slice(0, 200_000)));
  } catch {
    return null;
  }
});
def('json_stringify', 'json_stringify(wert)', 'Wert als JSON-Text', ([v], rt) => rt.checkStr(JSON.stringify(cloneData(v)) ?? 'null'));
// lists & objects
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
def('map', 'map(liste, x => …)', 'Jedes Element umwandeln', ([l, f], rt) => rt.checkArr(arr(l).map((x, i) => rt.interp.callValue(f, [x, i]))));
def('filter', 'filter(liste, x => …)', 'Elemente behalten, für die die Bedingung gilt', ([l, f], rt) => arr(l).filter((x, i) => truthy(rt.interp.callValue(f, [x, i]))));
def('find', 'find(liste, x => …)', 'Erstes passendes Element', ([l, f], rt) => arr(l).find((x, i) => truthy(rt.interp.callValue(f, [x, i]))));
def('some', 'some(liste, x => …)', 'Trifft für mindestens eines zu?', ([l, f], rt) => arr(l).some((x, i) => truthy(rt.interp.callValue(f, [x, i]))));
def('every', 'every(liste, x => …)', 'Trifft für alle zu?', ([l, f], rt) => arr(l).every((x, i) => truthy(rt.interp.callValue(f, [x, i]))));
def('reduce', 'reduce(liste, (summe, x) => …, start)', 'Liste auf einen Wert verdichten', ([l, f, init], rt) => arr(l).reduce((acc, x, i) => rt.interp.callValue(f, [acc, x, i]), init));
def('sort', 'sort(liste, (a, b) => …?)', 'Sortierte Kopie', ([l, f], rt) => {
  const copy = [...arr(l)];
  if (f === undefined) return copy.sort((a, b) => (compare(a, b) || 0));
  return copy.sort((a, b) => num(rt.interp.callValue(f, [a, b])) || 0);
});
def('sort_by', 'sort_by(liste, x => schlüssel)', 'Nach Schlüssel sortieren', ([l, f], rt) => {
  const keyed = arr(l).map((x) => [rt.interp.callValue(f, [x]), x] as const);
  return keyed.sort((a, b) => compare(a[0], b[0]) || 0).map((p) => p[1]);
});
def('unique', 'unique(liste)', 'Doppelte entfernen', ([l]) => {
  const seen = new Set<string>();
  return arr(l).filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
});
def('first', 'first(liste)', 'Erstes Element', ([l]) => arr(l)[0]);
def('last', 'last(liste)', 'Letztes Element', ([l]) => arr(l)[arr(l).length - 1]);
def('slice', 'slice(liste|text, von, bis?)', 'Ausschnitt', ([l, a, b]) => (typeof l === 'string' ? l.slice(num(a), b === undefined ? undefined : num(b)) : arr(l).slice(num(a), b === undefined ? undefined : num(b))));
def('concat', 'concat(a, b, …)', 'Listen oder Texte verbinden', (args, rt) => (args.every(Array.isArray) ? rt.checkArr(args.flat()) : rt.checkStr(args.map(toStr).join(''))));
def('reverse', 'reverse(liste)', 'Umgekehrte Kopie', ([l]) => [...arr(l)].reverse());
def('flatten', 'flatten(liste)', 'Verschachtelte Listen auflösen (eine Ebene)', ([l], rt) => rt.checkArr(arr(l).flat()));
def('range', 'range(von, bis, schritt?)', 'Zahlenfolge (bis exklusive, höchstens 10 000)', ([a, b, s], rt) => {
  const step = s === undefined ? 1 : num(s);
  const from = b === undefined ? 0 : num(a);
  const to = b === undefined ? num(a) : num(b);
  if (!step) throw new ExprError('Schritt darf nicht 0 sein');
  if (Math.abs((to - from) / step) > rt.limits.maxArray) throw new ExprError('Zahlenfolge zu lang (höchstens 10 000)');
  const out: number[] = [];
  for (let x = from; step > 0 ? x < to : x > to; x += step) out.push(x);
  return out;
});
def('keys', 'keys(objekt)', 'Feldnamen', ([o]) => (isPlain(o) ? Object.keys(o) : []));
def('values', 'values(objekt)', 'Werte', ([o]) => (isPlain(o) ? Object.values(o) : []));
def('get', 'get(objekt, "pfad.zum.feld", ersatz?)', 'Wert über einen Pfad lesen', ([o, path, d]) => {
  let cur: unknown = o;
  for (const k of toStr(path).split('.')) {
    if (cur === null || cur === undefined) return d ?? null;
    cur = member(cur, /^-?\d+$/.test(k) && Array.isArray(cur) ? Number(k) : k);
  }
  return cur === undefined || cur === null ? (d ?? null) : cur;
});
def('count_if', 'count_if(liste, x => …)', 'Zählt Treffer', ([l, f], rt) => arr(l).filter((x, i) => truthy(rt.interp.callValue(f, [x, i]))).length);
def('group_count', 'group_count(liste, x => schlüssel)', 'Zählt je Schlüssel → Objekt', ([l, f], rt) => {
  const out: Record<string, number> = {};
  for (const x of arr(l)) {
    const k = toStr(rt.interp.callValue(f, [x]));
    if (!BANNED_KEYS.has(k)) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
});
// dates
const dt = (v: unknown, rt: Runtime): Date => {
  const d = parseDate(v === undefined || v === '' ? 'now' : v, rt.tz, rt.now);
  if (!d) throw new ExprError(`„${toStr(v).slice(0, 40)}“ ist kein Datum`);
  return d;
};
def('now', 'now()', 'Jetzt (ISO, UTC)', (_a, rt) => rt.now.toISOString());
def('today', 'today()', 'Heute als YYYY-MM-DD in der Zeitzone des Sub-Accounts', (_a, rt) => ymdInTz(rt.now, rt.tz));
def('date', 'date(wert)', 'Datum lesen (ISO, TT.MM.JJJJ …) → ISO (UTC)', ([v], rt) => dt(v, rt).toISOString());
def('add_days', 'add_days(datum, n)', 'Kalendertage addieren (Uhrzeit bleibt, auch bei Zeitumstellung)', ([d, n], rt) => addToDate(dt(d, rt), num(n), 'days', rt.tz).toISOString());
def('add_hours', 'add_hours(datum, n)', 'Stunden addieren (verstrichene Zeit)', ([d, n], rt) => addToDate(dt(d, rt), num(n), 'hours', rt.tz).toISOString());
def('add_months', 'add_months(datum, n)', 'Monate addieren (31. Jan + 1 Monat = 28./29. Feb)', ([d, n], rt) => addToDate(dt(d, rt), num(n), 'months', rt.tz).toISOString());
def('add_business_days', 'add_business_days(datum, n)', 'Werktage (Mo–Fr) addieren', ([d, n], rt) => addToDate(dt(d, rt), num(n), 'business_days', rt.tz).toISOString());
def('diff_days', 'diff_days(von, bis)', 'Ganze Kalendertage zwischen zwei Daten', ([a, b], rt) => diffDates(dt(a, rt), dt(b, rt), 'days', rt.tz));
def('diff', 'diff(von, bis, einheit)', 'Differenz in minutes|hours|days|weeks|months|years', ([a, b, u], rt) => diffDates(dt(a, rt), dt(b, rt), toStr(u || 'days'), rt.tz));
def('format_date', 'format_date(datum, muster?, zeitzone?)', 'Formatiert, z. B. "DD.MM.YYYY HH:mm", "date", "long"', ([d, p, tz], rt) => formatDate(dt(d, rt), toStr(p || 'datetime'), tz ? toStr(tz) : rt.tz));
def('weekday', 'weekday(datum)', 'Wochentag (Montag …)', ([d], rt) => dateOp('weekday', dt(d, rt).toISOString(), { tz: rt.tz }));
def('is_weekend', 'is_weekend(datum)', 'Samstag/Sonntag?', ([d], rt) => dateOp('is_business_day', dt(d, rt).toISOString(), { tz: rt.tz }) === 'nein');
def('add_business', 'add_business(datum, n)', 'Wie add_business_days', ([d, n], rt) => addToDate(dt(d, rt), num(n), 'business_days', rt.tz).toISOString());

// methods (text.upper(), list.map(fn) …)
const M = (name: string, on: Method['on'], fn: Method['fn']) => method(name, on, fn);
M('toUpperCase', 'string', (s) => s.toUpperCase());
M('toLowerCase', 'string', (s) => s.toLowerCase());
M('trim', 'string', (s) => s.trim());
M('includes', 'any', (s, [x]) => (Array.isArray(s) ? s.some((y) => looseEq(y, x)) : typeof s === 'string' ? s.includes(toStr(x)) : false));
M('startsWith', 'string', (s, [x]) => s.startsWith(toStr(x)));
M('endsWith', 'string', (s, [x]) => s.endsWith(toStr(x)));
M('split', 'string', (s, [x], rt) => rt.checkArr(textOp('split', s, x) as string[]));
M('replace', 'string', (s, [a, b], rt) => rt.checkStr(textOp('replace', s, a, b) as string));
M('slice', 'any', (s, [a, b]) => (typeof s === 'string' || Array.isArray(s) ? s.slice(num(a), b === undefined ? undefined : num(b)) : undefined));
M('indexOf', 'any', (s, [x]) => (Array.isArray(s) ? s.findIndex((y) => looseEq(y, x)) : typeof s === 'string' ? s.indexOf(toStr(x)) : -1));
M('padStart', 'string', (s, [n, f]) => textOp('pad_left', s, n, f));
M('padEnd', 'string', (s, [n, f]) => textOp('pad_right', s, n, f));
M('join', 'array', (a, [sep], rt) => rt.checkStr(a.map(toStr).join(sep === undefined ? ',' : toStr(sep))));
M('map', 'array', (a, [f], rt) => rt.checkArr(a.map((x: unknown, i: number) => rt.interp.callValue(f, [x, i]))));
M('filter', 'array', (a, [f], rt) => a.filter((x: unknown, i: number) => truthy(rt.interp.callValue(f, [x, i]))));
M('find', 'array', (a, [f], rt) => a.find((x: unknown, i: number) => truthy(rt.interp.callValue(f, [x, i]))));
M('some', 'array', (a, [f], rt) => a.some((x: unknown, i: number) => truthy(rt.interp.callValue(f, [x, i]))));
M('every', 'array', (a, [f], rt) => a.every((x: unknown, i: number) => truthy(rt.interp.callValue(f, [x, i]))));
M('reduce', 'array', (a, [f, init], rt) => a.reduce((acc: unknown, x: unknown, i: number) => rt.interp.callValue(f, [acc, x, i]), init));
M('push', 'array', (a, args, rt) => (a.push(...args), rt.checkArr(a).length));
M('pop', 'array', (a) => a.pop());
M('toFixed', 'number', (n, [d]) => numberOp('fixed', n, { digits: d === undefined ? 0 : num(d) }));
M('toString', 'any', (v) => toStr(v));
/** The functions of the language, for the editor's help and the docs. */
export function functionDocs(): { name: string; sig: string; doc: string }[] {
  return Object.entries(FUNCTIONS)
    .map(([name, f]) => ({ name, sig: f.sig, doc: f.doc }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Runs a program. `data` is copied (JSON-like deep copy) – the program cannot reach or change anything else.
 * The result is the value of `return …` or of the last expression statement; `vars` lists changes made to `var`.
 */
export function evaluate(source: string, data: Record<string, unknown> = {}, opts: EvalOptions = {}): EvalResult {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  let program: Node[];
  try {
    program = parseProgram(source, limits);
  } catch (e) {
    if (e instanceof ExprError) throw new ExprError(e.pos === undefined ? e.message : `${e.message} (Position ${e.pos})`, e.pos);
    throw new ExprError('Syntaxfehler');
  }
  const rt = new Runtime(limits, opts);
  const interp = new Interpreter(rt);
  rt.interp = interp;
  const env = new Env();
  const before: Record<string, string> = {};
  const copy = cloneData(data) as Record<string, unknown>;
  for (const [k, v] of Object.entries(copy)) if (!BANNED_KEYS.has(k)) env.vars.set(k, v);
  const vars = isPlain(env.vars.get('var')) ? (env.vars.get('var') as Record<string, unknown>) : {};
  env.vars.set('var', vars);
  for (const [k, v] of Object.entries(vars)) before[k] = JSON.stringify(v) ?? 'undefined';
  let value: unknown;
  try {
    const sig = interp.execBlock(program, new Env(env));
    value = sig?.kind === 'return' ? sig.value : interp.last;
  } catch (e) {
    if (e instanceof ExprError) throw e;
    if (e instanceof FormatError) throw new ExprError(e.message);
    if (e instanceof RangeError) throw new ExprError('Zu tief verschachtelt oder zu groß');
    throw new ExprError('Fehler bei der Berechnung');
  }
  const changed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) if ((JSON.stringify(v) ?? 'undefined') !== before[k]) changed[k] = v === undefined ? null : v;
  for (const k of Object.keys(before)) if (!(k in vars)) changed[k] = null;
  return { value: output(value, limits), vars: output(changed, limits) as Record<string, unknown>, steps: rt.steps };
}

/** Result values leave the sandbox as plain JSON data (functions and cycles become errors/null). */
function output(v: unknown, limits: ExprLimits): unknown {
  const seen = new Set<unknown>();
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 30) throw new ExprError('Ergebnis zu tief verschachtelt');
    if (x === undefined || x === null) return null;
    if (x instanceof Lambda || x instanceof Builtin) throw new ExprError('Das Ergebnis ist eine Funktion – bitte aufrufen');
    if (typeof x === 'number') return Number.isFinite(x) ? x : null;
    if (typeof x === 'string' || typeof x === 'boolean') return x;
    if (typeof x === 'object') {
      if (seen.has(x)) throw new ExprError('Das Ergebnis verweist auf sich selbst');
      seen.add(x);
      const r = Array.isArray(x) ? x.map((y) => walk(y, depth + 1)) : Object.fromEntries(Object.entries(x as object).filter(([k]) => !BANNED_KEYS.has(k)).map(([k, y]) => [k, walk(y, depth + 1)]));
      seen.delete(x);
      return r;
    }
    return null;
  };
  const out = walk(v, 0);
  if ((JSON.stringify(out) ?? '').length > limits.maxOutput) throw new ExprError('Ergebnis zu groß');
  return out;
}

/** Truthiness of a condition expression for `if` steps (errors count as false and are reported to the caller). */
export function evaluateCondition(source: string, data: Record<string, unknown>, opts: EvalOptions = {}): boolean {
  return truthy(evaluate(source, data, opts).value);
}
