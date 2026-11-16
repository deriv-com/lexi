import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TEST SUPPORT ONLY — imported by specs, never by runtime code.
 *
 * A fake Prisma client that knows exactly the columns `schema.prisma`
 * declares, and nothing else. Writing a field the schema lacks throws, as the
 * real client does; a column a store forgets to write reads back as its
 * schema default (usually null), as the real database does. That makes it the
 * double for the bug class the in-memory stores cannot see: they keep every
 * field they are handed, so a Prisma store that silently drops one passes
 * every engine spec.
 */

const SCHEMA_PATH = resolve(__dirname, "../../../database/prisma/schema.prisma");

export interface SchemaField {
  name: string;
  type: string;
  optional: boolean;
  list: boolean;
  /** Raw `@default(...)` argument, when declared. */
  defaultValue?: string;
  updatedAt: boolean;
}

export interface SchemaModel {
  name: string;
  fields: Map<string, SchemaField>;
  /** `@id` / `@unique` single fields, and `@@unique([a, b])` compounds. */
  uniques: string[][];
}

let parsed: Map<string, SchemaModel> | null = null;

export function schemaModels(): Map<string, SchemaModel> {
  if (parsed) return parsed;
  const text = readFileSync(SCHEMA_PATH, "utf8");
  const models = new Map<string, SchemaModel>();
  for (const match of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const model: SchemaModel = { name: match[1]!, fields: new Map(), uniques: [] };
    for (const rawLine of match[2]!.split("\n")) {
      const line = rawLine.replace(/\/\/.*$/, "").trim();
      if (!line) continue;
      const compound = /^@@(?:unique|id)\(\[([^\]]+)\]/.exec(line);
      if (compound) {
        model.uniques.push(compound[1]!.split(",").map((part) => part.trim()));
        continue;
      }
      if (line.startsWith("@@")) continue;
      const field = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
      if (!field) continue;
      const attrs = field[5] ?? "";
      const def = /@default\(((?:[^()]|\([^()]*\))*)\)/.exec(attrs);
      model.fields.set(field[1]!, {
        name: field[1]!,
        type: field[2]!,
        list: Boolean(field[3]),
        optional: Boolean(field[4]),
        ...(def ? { defaultValue: def[1]! } : {}),
        updatedAt: attrs.includes("@updatedAt"),
      });
      if (/@id\b|@unique\b/.test(attrs)) model.uniques.push([field[1]!]);
    }
    models.set(model.name, model);
  }
  parsed = models;
  return models;
}

/** The column names of one model, e.g. `schemaFieldNames("QuickFixAttempt")`. */
export function schemaFieldNames(modelName: string): Set<string> {
  const model = schemaModels().get(modelName);
  if (!model) throw new Error(`schema.prisma has no model ${modelName}`);
  return new Set(model.fields.keys());
}

/** Throws when `data` names a column the model does not have. */
export function assertKnownColumns(modelName: string, data: Record<string, unknown>): void {
  const known = schemaFieldNames(modelName);
  const unknown = Object.keys(data).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s) ${unknown.map((k) => `\`${k}\``).join(", ")} for model ${modelName}`);
  }
}

function defaultFor(field: SchemaField): unknown {
  if (field.updatedAt) return new Date();
  const raw = field.defaultValue;
  if (raw === undefined) return field.list ? [] : null;
  if (raw === "uuid()" || raw === "cuid()") return randomUUID();
  if (raw === "now()") return new Date();
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === "[]") return [];
  if (raw.startsWith('"')) {
    const inner = JSON.parse(raw) as string;
    // A Json column's default is JSON text; a String column's is the text itself.
    return field.type === "Json" ? JSON.parse(inner) : inner;
  }
  return null;
}

const clone = <T>(value: T): T => structuredClone(value);

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
      const c = condition as Record<string, unknown>;
      if (Array.isArray(c.in)) return c.in.includes(row[key]);
      // Compound unique selector: `a_b: { a, b }`.
      return matches(row, c);
    }
    return row[key] === condition;
  });
}

function sortRows(rows: Record<string, unknown>[], orderBy: unknown): Record<string, unknown>[] {
  if (!orderBy || typeof orderBy !== "object") return rows;
  const [key, direction] = Object.entries(orderBy as Record<string, string>)[0] ?? [];
  if (!key) return rows;
  const sign = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = a[key] instanceof Date ? (a[key] as Date).getTime() : (a[key] as number | string);
    const right = b[key] instanceof Date ? (b[key] as Date).getTime() : (b[key] as number | string);
    return left < right ? -sign : left > right ? sign : 0;
  });
}

export class SchemaFakeDelegate {
  readonly rows: Record<string, unknown>[] = [];
  private sequence = 0;

  constructor(readonly model: SchemaModel) {}

  private complete(data: Record<string, unknown>): Record<string, unknown> {
    assertKnownColumns(this.model.name, data);
    const row: Record<string, unknown> = {};
    for (const field of this.model.fields.values()) {
      if (data[field.name] !== undefined) {
        row[field.name] = clone(data[field.name]);
        continue;
      }
      const value = defaultFor(field);
      if (value === null && !field.optional && !field.list) {
        throw new Error(`Argument \`${field.name}\` is missing for model ${this.model.name}`);
      }
      row[field.name] = value;
    }
    // A stable insertion order for `orderBy: { createdAt }` within one tick.
    if (row.createdAt instanceof Date) row.createdAt = new Date(row.createdAt.getTime() + this.sequence++);
    return row;
  }

  private assertUnique(row: Record<string, unknown>, except?: Record<string, unknown>): void {
    for (const keys of this.model.uniques) {
      const clash = this.rows.find((r) => r !== except && keys.every((k) => r[k] === row[k]));
      if (clash) throw new Error(`Unique constraint failed on the fields: (${keys.join(", ")})`);
    }
  }

  private findOne(where: Record<string, unknown>): Record<string, unknown> | undefined {
    return this.rows.find((row) => matches(row, where));
  }

  async create({ data }: { data: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const row = this.complete(data);
    this.assertUnique(row);
    this.rows.push(row);
    return clone(row);
  }

  async upsert(args: {
    where: Record<string, unknown>;
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const existing = this.findOne(args.where);
    if (!existing) return this.create({ data: args.create });
    assertKnownColumns(this.model.name, args.update);
    Object.assign(existing, clone(args.update));
    return clone(existing);
  }

  async update({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<Record<string, unknown>> {
    assertKnownColumns(this.model.name, data);
    const existing = this.findOne(where);
    if (!existing) throw new Error(`Record to update not found in ${this.model.name}`);
    const next = { ...existing, ...clone(data) };
    this.assertUnique(next, existing);
    Object.assign(existing, next);
    return clone(existing);
  }

  async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> {
    assertKnownColumns(this.model.name, data);
    const hits = this.rows.filter((row) => matches(row, where));
    for (const row of hits) Object.assign(row, clone(data));
    return { count: hits.length };
  }

  async findUnique({ where }: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null> {
    const row = this.findOne(where);
    return row ? clone(row) : null;
  }

  async findFirst(args: { where?: Record<string, unknown>; orderBy?: unknown } = {}): Promise<Record<string, unknown> | null> {
    const row = sortRows(this.rows.filter((r) => matches(r, args.where)), args.orderBy)[0];
    return row ? clone(row) : null;
  }

  async findMany(args: { where?: Record<string, unknown>; orderBy?: unknown } = {}): Promise<Record<string, unknown>[]> {
    return sortRows(this.rows.filter((r) => matches(r, args.where)), args.orderBy).map(clone);
  }
}

/**
 * A client with one schema-faithful delegate per named model, keyed the way
 * Prisma keys them (`BuildTask` → `buildTask`).
 */
export function schemaFakeClient(...modelNames: string[]): Record<string, SchemaFakeDelegate> {
  const client: Record<string, SchemaFakeDelegate> = {};
  for (const name of modelNames) {
    const model = schemaModels().get(name);
    if (!model) throw new Error(`schema.prisma has no model ${name}`);
    client[name.charAt(0).toLowerCase() + name.slice(1)] = new SchemaFakeDelegate(model);
  }
  return client;
}
