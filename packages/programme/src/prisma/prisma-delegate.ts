/**
 * Structural access to Prisma model delegates.
 *
 * The stores in this folder never import `@lexi/database`: they take the
 * Prisma client as a plain object and look each delegate up by name. A client
 * generated before the programme migration simply lacks the property, and
 * every call then throws a NAMED error instead of `undefined is not a
 * function`. The same seam is what lets the specs hand in a schema-faithful
 * fake client without a database.
 */
export interface PrismaDelegate {
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  upsert(args: {
    where: Record<string, unknown>;
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  updateMany?(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  findUnique(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  findFirst(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  findMany(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

/** Any object whose properties are Prisma delegates — a `PrismaClient` qualifies. */
export type PrismaDelegateHost = object;

export function prismaDelegate(prisma: PrismaDelegateHost, name: string): PrismaDelegate {
  const delegate = (prisma as Record<string, PrismaDelegate | undefined>)[name];
  if (!delegate) {
    throw new Error(
      `Prisma client has no ${name} delegate: apply the programme migrations and regenerate the client before enabling programme features.`,
    );
  }
  return delegate;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function isoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

/**
 * Keeps only the keys whose value is not `undefined`. A patch built from a
 * `Partial<>` must not send `undefined` for a field the caller did not name —
 * Prisma treats that as "leave alone", but a hand-written update that spreads
 * a patch should say exactly what it changes.
 */
export function definedOnly(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
