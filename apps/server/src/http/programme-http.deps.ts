import type {
  ApiContractDocument,
  ApiReferenceDocument,
  BuildTaskBrief,
  DesignContextDocument,
  RunEvidenceReceipt,
} from "@lexi/contracts";
import type { RunEvidenceIngestOptions } from "@lexi/programme";

/**
 * Everything the programme HTTP surface needs, as one injectable object.
 *
 * Kept out of `tokens.ts` on purpose: the composition root binds this token
 * when it wires the programme, and until then nothing registers the
 * controller, so the routes do not exist.
 */
export const PROGRAMME_HTTP_DEPS_TOKEN = Symbol("PROGRAMME_HTTP_DEPS_TOKEN");

export interface ProgrammeHttpDeps {
  /** `PROGRAMME_ENABLED`. Off → every brief route refuses. */
  programmeEnabled: boolean;
  /** `PROGRAMME_BRIEF_TOKEN`. Empty → every brief route refuses (fail closed). */
  briefToken: string;
  /** `EVIDENCE_INGEST_ENABLED`. Off → evidence ingest refuses. */
  evidenceEnabled: boolean;
  /** `EVIDENCE_WEBHOOK_TOKEN`. Empty → evidence ingest refuses (fail closed). */
  evidenceToken: string;
  /** `ProgrammeBuildService` satisfies it. Null → brief routes answer 501. */
  build: {
    briefForAttempt(attemptId: string): Promise<BuildTaskBrief | null>;
    apiReferenceDocument(index: number, sha: string): Promise<ApiReferenceDocument | null>;
  } | null;
  /** `PrismaProgrammeStore` satisfies it. Null → document routes answer 501. */
  store: {
    getDesignContext(id: string): Promise<DesignContextDocument | null>;
    getApiContract(id: string): Promise<ApiContractDocument | null>;
  } | null;
  /** `PrismaRunEvidenceStore` satisfies it. Null → evidence ingest answers 501. */
  evidence: {
    ingest(input: unknown, options: RunEvidenceIngestOptions): Promise<RunEvidenceReceipt>;
  } | null;
  /**
   * Whether an attempt id names a real attempt row (build task or sweep).
   * Unknown ids are refused so evidence never accumulates attached to nothing.
   */
  isKnownAttempt(attemptId: string): Promise<boolean>;
  /**
   * The repository (`owner/name`) an attempt was dispatched to, or null when
   * it records none. Evidence must name the same repository, so a runner in
   * one repository cannot write evidence against another's attempt. The
   * evidence token is shared, so this is a binding check, not authentication.
   */
  repositoryOfAttempt(attemptId: string): Promise<string | null>;
  /** Logs shapes, never contents or tokens. */
  logger?: { log(message: string, context?: string): void; warn(message: string, context?: string): void };
}
