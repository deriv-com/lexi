import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * Nest-injectable wrapper around the generated Prisma client. Handles
 * connection lifecycle (connect on module init, disconnect on module
 * destroy) so it can be provided once and shared across every package via
 * dependency injection.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(datasourceUrl?: string) {
    super(
      datasourceUrl
        ? { datasources: { db: { url: datasourceUrl } } }
        : undefined,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log("Prisma client connected");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log("Prisma client disconnected");
  }
}
