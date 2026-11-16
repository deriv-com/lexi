export {
  scoreDataset,
  runGoldenDataset,
  type GoldenCase,
  type CaseResult,
  type DatasetScore,
  type DisagreementCategory,
  type CaseExecutor,
  type IntakeDisposition,
  type ExpectedClassification,
  type ExpectedPolicyAction,
} from "./golden-dataset";

export {
  compareRuns,
  type PolicyVersion,
  type RegressionDiff,
  type RegressionReport,
} from "./policy-regression";

export {
  ShadowModeService,
  type ShadowDecision,
  type ShadowModeConfig,
  type ShadowModePersistence,
} from "./shadow-mode";

export {
  computeCalibration,
  type CalibrationBucket,
  type CalibrationReport,
  type CalibrationSample,
} from "./calibration";

export {
  buildExitDashboard,
  formatExitDashboard,
  DEFAULT_EXIT_THRESHOLDS,
  type ExitDashboard,
  type ExitMetric,
  type CertificationScope,
} from "./exit-dashboard";
